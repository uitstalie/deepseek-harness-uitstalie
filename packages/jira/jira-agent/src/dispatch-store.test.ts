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
import { createSessionRecorder } from './sessionRecord.ts'
import { handleTaskTurnEnd } from './superagent.ts'

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
const turnLog = (id: string, turns: readonly { requestId: string; text: string }[]) => {
  const events: { type: string; seq: number; data: unknown }[] = []
  const ends: { type: string; seq: number; data: unknown }[] = []
  let seq = 0
  for (const [index, turn] of turns.entries()) {
    const number = index + 1
    events.push({ type: 'turn/start', seq: ++seq, data: { turn: number } })
    events.push({
      type: 'user/message',
      seq: ++seq,
      data: { role: 'user', content: [], source: { kind: 'user', rpcId: turn.requestId } },
    })
    events.push({ type: 'assistant/message', seq: ++seq, data: { message: { content: [{ type: 'text', text: turn.text }] } } })
    const end = { type: 'turn/end', seq: ++seq, data: { turn: number, reason: { kind: 'completed' } } }
    events.push(end)
    ends.push(end)
  }
  const agent = { id, session: { snapshotEvents: () => events } }
  return {
    agent,
    session: agent.session,
    input: (index: number) => ({
      agent,
      session: agent.session,
      turn: index + 1,
      event: ends[index],
      signal: new AbortController().signal,
    }),
  }
}

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
    })
    assert.equal(resolved?.task.status, 'returned')
    assert.deepEqual(resolved?.task.artifacts, ['one.md', 'two.md'])
    assert.deepEqual(resolved?.task.decisions, ['ship it'])
    const listed = await store.list({ status: 'returned' })
    assert.deepEqual(listed?.[0]?.decisions, ['ship it'])

    const projection = await readFile(join(root, '.superagent/ledger/w1.md'), 'utf8')
    assert.match(projection, /task-round-trip · pending/u)
    assert.match(projection, /task-round-trip · returned/u)

    // A repeated resolve is a no-op and does not append a second returned section.
    const again = await store.resolve(task.id, {
      status: 'returned',
      updatedAt: '2026-11-07T00:02:00.000Z' as Timestamp,
      outcome: 'duplicate',
    })
    assert.equal(again?.task.outcome, 'done')
    const afterAgain = await readFile(join(root, '.superagent/ledger/w1.md'), 'utf8')
    assert.equal((afterAgain.match(/task-round-trip · returned/gu) ?? []).length, 1)
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

    // The migrated pending entry is still found by the durable session lookup, even though its
    // Markdown record has no superSession field.
    const prompted: string[] = []
    const controller = {
      async create() { return { sessionId: 'unused' } },
      async list() { return { items: [{ sessionId: 'super-1', running: false, cwd: root, updatedAt: 1 }] } },
      async prompt(request: { sessionId: unknown }) { prompted.push(String(request.sessionId)); return { accepted: true } },
    }
    const host = {
      ctx: {
        get: (key: string) => key === 'sessionController' ? controller : undefined,
        logger: { warn: () => {}, info: () => {} },
      },
      env: {},
      clock: () => Date.parse(AT),
      recorder: createSessionRecorder(),
    }
    const child = { id: 'child-old', session: { snapshotEvents: () => [] } }
    assert.equal(await handleTaskTurnEnd(host as never, {
      agent: child,
      session: child.session,
      turn: 1,
      event: { data: { reason: { kind: 'completed' } } },
      signal: new AbortController().signal,
    } as never, new Map(), [], root, second), true)
    assert.deepEqual(prompted, ['super-1'])
    assert.equal((await second.list({ status: 'returned' }))?.[0]?.id, old.task.id)
  })

  it('finds a pending binding after the store is closed and reopened', async () => {
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

    const prompted: string[] = []
    const controller = {
      async create() { return { sessionId: 'unused' } },
      async list() { return { items: [] } },
      async prompt(request: { sessionId: unknown }) { prompted.push(String(request.sessionId)); return { accepted: true } },
    }
    const host = {
      ctx: {
        get: (key: string) => key === 'sessionController' ? controller : undefined,
        logger: { warn: () => {}, info: () => {} },
      },
      env: {},
      clock: () => Date.parse(AT),
      recorder: createSessionRecorder(),
    }
    const child = { id: 'child-reload', session: { snapshotEvents: () => [] } }
    const handled = await handleTaskTurnEnd(host as never, {
      agent: child,
      session: child.session,
      turn: 1,
      event: { data: { reason: { kind: 'completed' } } },
      signal: new AbortController().signal,
    } as never, new Map(), [], root, second)

    assert.equal(handled, true)
    assert.deepEqual(prompted, ['super-reload'])
    const rows = await second.list({ status: 'returned' })
    assert.equal(rows?.[0]?.id, 'task-reload')
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

  it('routes two pending records back to their own super Sessions from the domain', async () => {
    const root = await scratch()
    const { storageCtx } = await withStorage()
    const store = new DispatchStore(storageCtx, root)
    stores.push(store)
    assert.equal(await store.available(), true)
    await store.record(taskFor('task-a', { sessionId: 'child-a' }), 'super-a')
    await store.record(taskFor('task-b', { sessionId: 'child-b' }), 'super-b')

    const prompted: { sessionId: string; text: string }[] = []
    const controller = {
      async create() { return { sessionId: 'unused' } },
      async list() { return { items: [] } },
      async prompt(request: { sessionId: unknown; content: readonly { text: string }[] }) {
        prompted.push({ sessionId: String(request.sessionId), text: request.content[0]?.text ?? '' })
        return { accepted: true }
      },
    }
    const host = {
      ctx: {
        get: (key: string) => key === 'sessionController' ? controller : undefined,
        logger: { warn: () => {}, info: () => {} },
      },
      env: {},
      clock: () => Date.parse(AT),
      recorder: createSessionRecorder(),
    }
    const child = (id: string) => ({ id, session: { snapshotEvents: () => [] } })
    const input = (id: string) => ({
      agent: child(id),
      session: child(id).session,
      turn: 1,
      event: { data: { reason: { kind: 'completed' } } },
      signal: new AbortController().signal,
    })

    assert.equal(await handleTaskTurnEnd(host as never, input('child-a') as never, new Map(), [], root, store), true)
    assert.equal(await handleTaskTurnEnd(host as never, input('child-b') as never, new Map(), [], root, store), true)
    assert.deepEqual(prompted.map(row => row.sessionId), ['super-a', 'super-b'])
    assert.match(prompted[0]?.text ?? '', /task-a/u)
    assert.match(prompted[1]?.text ?? '', /task-b/u)
  })

  it('reports two queued dispatches to their own turns from the durable store', async () => {
    const root = await scratch()
    const { storageCtx } = await withStorage()
    const store = new DispatchStore(storageCtx, root)
    stores.push(store)
    assert.equal(await store.available(), true)
    await store.record(taskFor('task-sync', {
      sessionId: 'child-queued',
      requestId: 'req-sync',
      dispatchedAt: '2026-11-07T00:00:00.000Z' as Timestamp,
    }), 'super-1')
    await store.record(taskFor('task-fserror', {
      sessionId: 'child-queued',
      requestId: 'req-fserror',
      dispatchedAt: '2026-11-07T00:01:00.000Z' as Timestamp,
    }), 'super-1')
    const child = turnLog('child-queued', [
      { requestId: 'req-sync', text: 'sync done' },
      { requestId: 'req-fserror', text: 'FsError done' },
    ])

    const prompted: string[] = []
    const controller = {
      async create() { return { sessionId: 'unused' } },
      async list() { return { items: [] } },
      async prompt(request: { sessionId: unknown; content: readonly { text: string }[] }) {
        prompted.push(request.content[0]?.text ?? '')
        return { accepted: true }
      },
    }
    const host = {
      ctx: {
        get: (key: string) => key === 'sessionController' ? controller : undefined,
        logger: { warn: () => {}, info: () => {} },
      },
      env: {},
      clock: () => Date.parse(AT),
      recorder: createSessionRecorder(),
    }

    assert.equal(await handleTaskTurnEnd(host as never, child.input(0) as never, new Map(), [], root, store), true)
    assert.equal(await handleTaskTurnEnd(host as never, child.input(1) as never, new Map(), [], root, store), true)
    assert.equal(prompted.length, 2)
    assert.match(prompted[0] ?? '', /task-sync/u)
    assert.match(prompted[0] ?? '', /sync done/u)
    assert.doesNotMatch(prompted[0] ?? '', /task-fserror/u)
    assert.match(prompted[1] ?? '', /task-fserror/u)
    assert.match(prompted[1] ?? '', /FsError done/u)

    const rows = await store.list({ limit: 100 })
    assert.equal(rows?.find(row => row.id === 'task-sync')?.outcome, 'sync done')
    assert.equal(rows?.find(row => row.id === 'task-fserror')?.outcome, 'FsError done')
  })

  it('corrects a misattributed returned outcome when the real turn arrives', async () => {
    const root = await scratch()
    const { storageCtx } = await withStorage()
    const store = new DispatchStore(storageCtx, root)
    stores.push(store)
    assert.equal(await store.available(), true)
    await store.record(taskFor('task-fserror', {
      sessionId: 'child-returned',
      requestId: 'req-fserror',
      dispatchedAt: AT,
    }), 'super-1')
    await store.resolve('task-fserror', {
      status: 'returned',
      updatedAt: AT,
      outcome: 'the earlier sync result',
    })
    const child = turnLog('child-returned', [{ requestId: 'req-fserror', text: 'the real FsError outcome' }])

    const prompted: string[] = []
    const controller = {
      async create() { return { sessionId: 'unused' } },
      async list() { return { items: [] } },
      async prompt(request: { sessionId: unknown; content: readonly { text: string }[] }) {
        prompted.push(request.content[0]?.text ?? '')
        return { accepted: true }
      },
    }
    const host = {
      ctx: {
        get: (key: string) => key === 'sessionController' ? controller : undefined,
        logger: { warn: () => {}, info: () => {} },
      },
      env: {},
      clock: () => Date.parse(AT),
      recorder: createSessionRecorder(),
    }

    assert.equal(await handleTaskTurnEnd(host as never, child.input(0) as never, new Map(), [], root, store), true)
    assert.equal(prompted.length, 1)
    assert.match(prompted[0] ?? '', /the real FsError outcome/u)
    const rows = await store.list({ limit: 100 })
    assert.equal(rows?.find(row => row.id === 'task-fserror')?.status, 'returned')
    assert.equal(rows?.find(row => row.id === 'task-fserror')?.outcome, 'the real FsError outcome')
  })

  it('does not report an unrelated turn over a pending dispatch', async () => {
    const root = await scratch()
    const { storageCtx } = await withStorage()
    const store = new DispatchStore(storageCtx, root)
    stores.push(store)
    assert.equal(await store.available(), true)
    await store.record(taskFor('task-queued', {
      sessionId: 'child-mixed',
      requestId: 'req-queued',
      dispatchedAt: AT,
    }), 'super-1')
    const child = turnLog('child-mixed', [{ requestId: 'req-someone-else', text: 'unrelated' }])

    const controller = {
      async create() { return { sessionId: 'unused' } },
      async list() { return { items: [] } },
      async prompt() { throw new Error('an unrelated turn must not produce a report') },
    }
    const host = {
      ctx: {
        get: (key: string) => key === 'sessionController' ? controller : undefined,
        logger: { warn: () => {}, info: () => {} },
      },
      env: {},
      clock: () => Date.parse(AT),
      recorder: createSessionRecorder(),
    }

    assert.equal(await handleTaskTurnEnd(host as never, child.input(0) as never, new Map(), [], root, store), false)
    assert.equal((await store.list({ status: 'pending' }))?.find(row => row.id === 'task-queued')?.status, 'pending')
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

    const controller = {
      async create() { return { sessionId: 'unused' } },
      async list() { return { items: [] } },
      async prompt() { throw new Error('an orphaned pending record must not report') },
    }
    const host = {
      ctx: {
        get: (key: string) => key === 'sessionController' ? controller : undefined,
        logger: { warn: () => {}, info: () => {} },
      },
      env: {},
      clock: () => Date.parse(AT),
      recorder: createSessionRecorder(),
    }
    const child = { id: 'child-orphan', session: { snapshotEvents: () => [] } }
    assert.equal(await handleTaskTurnEnd(host as never, {
      agent: child,
      session: child.session,
      turn: 1,
      event: { data: { reason: { kind: 'completed' } } },
      signal: new AbortController().signal,
    } as never, new Map(), [], root, store), true)
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
