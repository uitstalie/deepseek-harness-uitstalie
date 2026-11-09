/** Durable dispatch store: domain round-trip, migration, projection, and reload recovery. */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { type Timestamp } from '@deepseek-ai/dsh-jira-core'
import {
  DISPATCH_DOMAIN_NAME,
  DispatchStore,
  dispatchDomainSpec,
  recordFromTask,
  taskFromRecord,
} from './dispatch-store.ts'
import {
  pendingTask,
  recordDispatch,
  type DispatchLedgerTask,
} from './dispatch-ledger.ts'

const AT = '2026-11-07T00:00:00.000Z' as Timestamp

const roots: string[] = []
const contexts: Context[] = []
const stores: DispatchStore[] = []
const backends: JsonStorageBackend[] = []

after(async () => {
  for (const store of stores.splice(0)) await store.close()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const backend of backends.splice(0)) await backend.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const scratch = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-dispatch-store-'))
  roots.push(root)
  return root
}

/** Mount only the storage stack a domain needs; the dispatch store must not require the product. */
const withStorage = async (existingRoot?: string): Promise<{ storageCtx: Context; facility: DomainFacility; storageRoot: string }> => {
  const storageRoot = existingRoot ?? await scratch()
  const storageCtx = new Context()
  contexts.push(storageCtx)
  await storageCtx.plugin(Storage)
  const backend = new JsonStorageBackend(storageRoot)
  backends.push(backend)
  storageCtx.storage.backend.register('json', backend)
  const facility = new DomainFacility(storageCtx, { backend: 'json' })
  storageCtx.provide('storageDomain', facility)
  return { storageCtx, facility, storageRoot }
}

const taskFor = (id: string, overrides: Partial<DispatchLedgerTask> = {}): DispatchLedgerTask => pendingTask({
  id,
  workspaceId: 'w1',
  workspaceTitle: 'workspace',
  workspacePath: '/workspace',
  task: 'finish the task',
  dispatchedAt: AT,
  sessionId: 'child-1',
  ...overrides,
})

/** One Session log whose turns each carry the prompt identity of their queued dispatch. */
describe('superagent: durable dispatch store', () => {
  it('round-trips records, arrays and statuses through the storage domain and Markdown projection', async () => {
    const root = await scratch()
    const { storageCtx } = await withStorage()
    const store = new DispatchStore(storageCtx, root)
    stores.push(store)
    assert.equal(await store.available(), true)

    const task = taskFor('task-round-trip')
    const recorded = await store.record(task, 'super-1')
    assert.equal(recorded?.task.id, task.id)
    const rows = await store.list({ status: 'pending' })
    assert.equal(rows?.length, 1)
    assert.deepEqual(rows?.[0]?.artifacts, [])
    assert.equal(rows?.[0]?.file, join(root, '.superagent/ledger/w1.md'))

    const raw = (await (async () => {
      const facility = (storageCtx as unknown as { get(key: string): { get(name: string): { table(name: string): { get(key: string): unknown } } | undefined } }).get('storageDomain')
      return facility.get(DISPATCH_DOMAIN_NAME)?.table('dispatches').get(task.id)
    })()) as ReturnType<typeof recordFromTask> | undefined
    assert.equal(raw?.superSession, 'super-1')
    assert.deepEqual(raw?.artifacts, [])
    assert.deepEqual(raw?.decisions, [])

    const resolved = await store.resolve(task.id, {
      status: 'returned',
      updatedAt: '2026-11-07T00:01:00.000Z' as Timestamp,
      outcome: 'done',
      artifacts: ['one.md', 'two.md'],
      decisions: ['ship it'],
      sessionId: 'child-returned',
      issue: 'DH-123',
    })
    assert.equal(resolved?.task.status, 'returned')
    assert.equal(resolved?.task.outcome, 'done')
    assert.equal(resolved?.task.sessionId, 'child-returned')
    assert.equal(resolved?.task.issue, 'DH-123')
    assert.deepEqual(resolved?.task.artifacts, ['one.md', 'two.md'])
    assert.deepEqual(resolved?.task.decisions, ['ship it'])
    const listed = await store.list({ status: 'returned' })
    assert.deepEqual(listed?.[0]?.decisions, ['ship it'])

    // A human can supplement a returned result without replacing its other fields.
    const supplemented = await store.resolve(task.id, {
      status: 'returned',
      updatedAt: '2026-11-07T00:02:00.000Z' as Timestamp,
      artifacts: ['one.md', 'two.md', 'three.md'],
      decisions: ['ship it', 'document it'],
    })
    assert.equal(supplemented?.task.outcome, 'done')
    assert.equal(supplemented?.task.sessionId, 'child-returned')
    assert.equal(supplemented?.task.issue, 'DH-123')
    assert.deepEqual(supplemented?.task.artifacts, ['one.md', 'two.md', 'three.md'])
    assert.deepEqual(supplemented?.task.decisions, ['ship it', 'document it'])

    const projection = await readFile(join(root, '.superagent/ledger/w1.md'), 'utf8')
    assert.match(projection, /task-round-trip · pending/u)
    assert.match(projection, /task-round-trip · returned/u)
    assert.match(projection, /- outcome: done/u)
    assert.match(projection, /- session: child-returned/u)
    assert.match(projection, /- issue: DH-123/u)
    assert.match(projection, /- artifacts: one\.md; two\.md; three\.md/u)
    assert.match(projection, /- decisions: ship it; document it/u)
    assert.equal((projection.match(/task-round-trip · returned/gu) ?? []).length, 2)

    // A timestamp alone is not a correction: repeat the same fields without appending or writing.
    const again = await store.resolve(task.id, {
      status: 'returned',
      updatedAt: '2026-11-07T00:03:00.000Z' as Timestamp,
      artifacts: ['one.md', 'two.md', 'three.md'],
      decisions: ['ship it', 'document it'],
    })
    assert.equal(again?.task.outcome, 'done')
    assert.equal(again?.task.updatedAt, supplemented?.task.updatedAt)
    const afterAgain = await readFile(join(root, '.superagent/ledger/w1.md'), 'utf8')
    assert.equal(afterAgain, projection)
  })

  it('allows a human to correct a failed task to returned and projects the result', async () => {
    const root = await scratch()
    const { storageCtx } = await withStorage()
    const store = new DispatchStore(storageCtx, root)
    stores.push(store)
    await store.record(taskFor('task-failed-to-returned'), 'super-1')

    const failed = await store.resolve('task-failed-to-returned', {
      status: 'failed',
      updatedAt: '2026-11-07T00:01:00.000Z' as Timestamp,
      outcome: 'worker failed',
      issue: 'DH-100',
    })
    assert.equal(failed?.task.status, 'failed')
    const corrected = await store.resolve('task-failed-to-returned', {
      status: 'returned',
      updatedAt: '2026-11-07T00:02:00.000Z' as Timestamp,
      outcome: 'manually recovered',
      artifacts: ['recovery.md'],
      decisions: ['accept the manual result'],
    })
    assert.equal(corrected?.task.status, 'returned')
    assert.equal(corrected?.task.outcome, 'manually recovered')
    assert.deepEqual(corrected?.task.artifacts, ['recovery.md'])
    assert.deepEqual(corrected?.task.decisions, ['accept the manual result'])

    const projection = await readFile(join(root, '.superagent/ledger/w1.md'), 'utf8')
    assert.match(projection, /## task-failed-to-returned · failed\n[\s\S]*?- outcome: worker failed/u)
    assert.match(projection, /## task-failed-to-returned · returned\n[\s\S]*?- outcome: manually recovered/u)
    assert.equal((await store.list({ status: 'returned' }))?.[0]?.outcome, 'manually recovered')
  })

  it('returns a bounded DispatchLedgerList from query', async () => {
    const { storageCtx } = await withStorage()
    const store = new DispatchStore(storageCtx, 'unused-root')
    stores.push(store)
    await store.record(taskFor('task-query-1'), 'super-1')
    await store.record(taskFor('task-query-2'), 'super-1')

    const result = await store.query({ status: 'pending', limit: 1 })
    assert.deepEqual(result?.counts, { matched: 2, returned: 1, remaining: 1 })
    assert.equal(result?.entries.length, 1)
    assert.equal(result?.truncated, true)
    assert.equal(result?.limit, 1)
  })

  it('updates only the domain when projection is disabled', async () => {
    const root = await scratch()
    const { storageCtx } = await withStorage()
    const store = new DispatchStore(storageCtx, root)
    stores.push(store)
    await store.record(taskFor('task-domain-only'), 'super-1')
    const file = join(root, '.superagent/ledger/w1.md')
    const before = await readFile(file, 'utf8')

    const resolved = await store.resolve('task-domain-only', {
      status: 'returned',
      updatedAt: '2026-11-07T00:01:00.000Z' as Timestamp,
      outcome: 'domain only',
      artifacts: ['domain.md'],
    }, { project: false })
    assert.equal(resolved?.task.status, 'returned')
    assert.equal(resolved?.task.outcome, 'domain only')
    assert.deepEqual(resolved?.task.artifacts, ['domain.md'])
    assert.equal(await readFile(file, 'utf8'), before, 'project:false must not append Markdown')
    assert.equal((await store.find('task-domain-only'))?.task.outcome, 'domain only')

    await store.project('task-domain-only')
    assert.match(await readFile(file, 'utf8'), /task-domain-only · returned/u)
    const projected = await readFile(file, 'utf8')
    await store.project('task-domain-only')
    assert.equal(await readFile(file, 'utf8'), projected, 'an already current projection is not appended twice')
  })

  it('records a domain result when its Markdown task projection is missing', async () => {
    const root = await scratch()
    const { storageCtx } = await withStorage()
    const store = new DispatchStore(storageCtx, root)
    stores.push(store)
    await store.record(taskFor('task-missing-projection'), 'super-1')
    await rm(join(root, '.superagent/ledger/w1.md'))

    const resolved = await store.resolve('task-missing-projection', {
      status: 'returned', updatedAt: AT, outcome: 'domain survives',
    }, { project: false })
    assert.equal(resolved?.task.outcome, 'domain survives')
    assert.equal((await store.find('task-missing-projection'))?.task.status, 'returned')
  })

  it('imports Markdown once, preserving task ids and timestamps, and reopens idempotently', async () => {
    const root = await scratch()
    const old = await recordDispatch(root, { id: 'w1', title: 'workspace', path: '/workspace' }, {
      task: 'old pending', dispatchedAt: AT, sessionId: 'child-old',
    })
    const firstStorage = await withStorage()
    const first = new DispatchStore(firstStorage.storageCtx, root)
    stores.push(first)
    assert.equal(await first.available(), true)
    const imported = await first.list({ status: 'pending' })
    assert.equal(imported?.length, 1)
    assert.equal(imported?.[0]?.id, old.task.id)
    assert.equal(imported?.[0]?.dispatchedAt, AT)
    assert.equal(imported?.[0]?.sessionId, 'child-old')
    await first.close()
    stores.splice(stores.indexOf(first), 1)

    const secondStorage = await withStorage(firstStorage.storageRoot)
    const second = new DispatchStore(secondStorage.storageCtx, root)
    stores.push(second)
    assert.equal(await second.available(), true)
    const rows = await second.list({ limit: 100 })
    assert.equal(rows?.length, 1)
    assert.equal(rows?.[0]?.id, old.task.id)

  })

  it('keeps durable records after the store is closed and reopened', async () => {
    const root = await scratch()
    const firstStorage = await withStorage()
    const first = new DispatchStore(firstStorage.storageCtx, root)
    stores.push(first)
    assert.equal(await first.available(), true)
    await first.record(taskFor('task-reload', { sessionId: 'child-reload' }), 'super-reload')
    await first.close()
    stores.splice(stores.indexOf(first), 1)

    const secondStorage = await withStorage(firstStorage.storageRoot)
    const second = new DispatchStore(secondStorage.storageCtx, root)
    stores.push(second)
    assert.equal(await second.available(), true)
    const rows = await second.list({ limit: 100 })
    assert.equal(rows?.find(row => row.id === 'task-reload')?.status, 'pending')
    assert.equal(rows?.find(row => row.id === 'task-reload')?.sessionId, 'child-reload')
  })

  it('falls back to the Markdown path when no storage domain is composed', async () => {
    const root = await scratch()
    const plainCtx = new Context()
    contexts.push(plainCtx)
    const store = new DispatchStore(plainCtx, root)
    stores.push(store)
    assert.equal(await store.available(), false)
    assert.equal(await store.list(), undefined)
    assert.equal(await store.record(taskFor('task-no-storage')), undefined)
    assert.equal(await store.resolve('task-no-storage', {
      status: 'returned', updatedAt: AT,
    }), undefined)
  })

  it('marks a pending record orphaned when its Session is archived', async () => {
    const root = await scratch()
    const { storageCtx } = await withStorage()
    const store = new DispatchStore(storageCtx, root)
    stores.push(store)
    assert.equal(await store.available(), true)
    await store.record(taskFor('task-orphan', { sessionId: 'child-orphan' }), 'super-1')
    await store.markArchivedSessions(['child-orphan'], AT)
    const lookup = await store.lookupSession('child-orphan')
    assert.equal(lookup.record?.orphanedAt, AT)
    assert.equal(lookup.record?.status, 'pending')

  })

  it('keeps schema conversion symmetrical for a legacy task', () => {
    const task = Object.freeze({ ...taskFor('task-convert'), artifacts: ['a'], decisions: ['d'], outcome: 'ok' })
    const record = recordFromTask(task, 'super-1')
    const back = taskFromRecord(record, task.id)
    assert.equal(back.id, task.id)
    assert.equal(back.workspaceTitle, task.workspaceTitle)
    assert.deepEqual(back.artifacts, ['a'])
    assert.deepEqual(back.decisions, ['d'])
  })

  it('exports a per-record domain declaration with the expected name and table', () => {
    assert.equal(dispatchDomainSpec.name, DISPATCH_DOMAIN_NAME)
    assert.equal(dispatchDomainSpec.layout, 'per-record')
    assert.deepEqual(Object.keys(dispatchDomainSpec.tables), ['dispatches'])
  })
})
