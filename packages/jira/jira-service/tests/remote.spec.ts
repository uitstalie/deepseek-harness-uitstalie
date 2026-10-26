/**
 * `remote.jira`: the read-only wire face the browser addresses.
 *
 * The spec boots the real `jira-service` plugin over a temporary ledger and calls the Remote
 * methods the way the Gateway would — directly on the mounted service — so the assertions cover
 * what actually crosses to a client: plain JSON values, `jira/<code>` failures for the ledger's
 * own errors, and no write method at all.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import JiraService from '@deepseek-ai/dsh-jira-service'
import { asIdentity, utcTimestamp } from '@deepseek-ai/dsh-jira-core/entity.ts'
import { writeTextAtomic } from '@deepseek-ai/dsh-jira-core/io.ts'
import { createKnowledge, originFromIdentity } from '@deepseek-ai/dsh-jira-core/kbstore.ts'
import { createInStore, createStore, storePaths } from '@deepseek-ai/dsh-jira-core/store.ts'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
// Load the `ctx.jiraRemote` declaration merge even when the package entry resolves through a
// built declaration file rather than this source tree.
import type {} from '../src/remote.ts'

const MACHINE = 'a1b2c3d4'

const IDENTITY = (() => {
  const identity = asIdentity('human:remote-fixture')
  if (identity === undefined) throw new Error('unreachable')
  return identity
})()

/** The vocabulary fixture `jira-core` ships; the ledger is only meaningful with one. */
const configFixture = async (): Promise<string> =>
  readFile(new URL('../../jira-core/fixtures/config.md', import.meta.url), 'utf8')

/** A ledger with one issue and one knowledge entry behind their commits. */
const createLedger = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jira-remote-'))
  await writeTextAtomic(storePaths.config(root), await configFixture())
  const store = createStore({ root, machineId: MACHINE })
  const actor = { by: IDENTITY, at: utcTimestamp(new Date('2026-10-15T12:00:00Z')) }
  const created = await createInStore(store, 'DH', actor, {
    issueType: 'task',
    summary: 'wire proof',
    body: 'The body a detail view renders.',
  })
  if (!created.ok) throw new Error(JSON.stringify(created.error))
  const knowledge = await createKnowledge(store, actor, originFromIdentity(IDENTITY, MACHINE), {
    domain: 'notes',
    kbType: 'concept',
    title: 'Ledger boot notes',
    body: 'The ledger opens when the host boots.',
    issues: [created.value.key],
  })
  if (!knowledge.ok) throw new Error(JSON.stringify(knowledge.error))
  return root
}

/** The mounted Remote face, once its fiber has activated. */
const remoteOf = async (ctx: Context) => {
  await vi.waitFor(() => { expect(ctx.get('jiraRemote')).toBeDefined() })
  return ctx.jiraRemote
}

let context: Context | undefined
let ledger: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (ledger !== undefined) await rm(ledger, { recursive: true, force: true })
  ledger = undefined
})

/** Boot the ledger service over a fresh temporary store. */
const boot = async (): Promise<{ ctx: Context; remote: Awaited<ReturnType<typeof remoteOf>> }> => {
  ledger = await createLedger()
  const ctx = context = new Context()
  await ctx.plugin(JiraService, {
    root: ledger,
    machine_id: MACHINE,
    push: { enabled: false },
  }).await()
  return { ctx, remote: await remoteOf(ctx) }
}

describe('remote.jira', () => {
  it('mounts the read-only face with the service row and exposes no write method', async () => {
    const { remote } = await boot()
    expect(typeof remote.status).toBe('function')
    expect(typeof remote.board).toBe('function')
    expect(typeof remote.list).toBe('function')
    expect(typeof remote.get).toBe('function')
    expect(typeof remote.kbSearch).toBe('function')
    for (const write of ['create', 'transact', 'kbCreate', 'kbUpdate', 'sync', 'settle']) {
      expect(write in remote).toBe(false)
    }
  })

  it('answers status() with the resolved root, identity and push state as plain JSON', async () => {
    const { remote, ctx } = await boot()
    // The identity is resolved when the service first opens the ledger, so the board read that
    // every board page makes also brings the status up to date.
    await remote.board()
    const status = remote.status()
    expect(status.root.replaceAll('\\', '/')).toBe((ledger ?? '').replaceAll('\\', '/'))
    expect(status.machineId).toBe(MACHINE)
    expect(status.pushEnabled).toBe(false)
    expect(status.pending).toBe(false)
    expect(status.lastSync).toBeNull()
    expect(JSON.parse(JSON.stringify(status))).toEqual(status)
    // The service reports the same facts the row resolved; the Remote adds no second truth.
    expect(status.root).toBe(ctx.jira.status().root)
  })

  it('answers board() with the issue grouped under its status and JSON-safe counts', async () => {
    const { remote } = await boot()
    const board = await remote.board()
    expect(board.items.map(item => item.key)).toEqual(['DH-1'])
    expect(board.groups).toHaveLength(1)
    expect(board.groups[0]).toMatchObject({ kind: 'status', project: 'DH', status: 'todo' })
    expect(board.groups[0]?.items.map(item => item.summary)).toEqual(['wire proof'])
    expect(board.counts).toEqual({ matched: 1, returned: 1, remaining: 0, byStatus: { todo: 1 }, blocked: 0 })
    expect(board.truncated).toBe(false)
    expect(board.limit).toBe(20)
    expect(JSON.parse(JSON.stringify(board))).toEqual(board)
  })

  it('narrows list() with the browser filter and reports what the limit hid', async () => {
    const { remote } = await boot()
    const truncated = await remote.list({ limit: 1 })
    expect(truncated.items.map(item => item.key)).toEqual(['DH-1'])
    expect(truncated.counts).toMatchObject({ matched: 1, returned: 1, remaining: 0 })
    const filtered = await remote.list({ project: 'DH', status: 'todo' })
    expect(filtered.items.map(item => item.key)).toEqual(['DH-1'])
    const none = await remote.list({ project: 'DH', status: 'closed' })
    expect(none.items).toEqual([])
    expect(none.counts.matched).toBe(0)
  })

  it('answers get() with the issue frontmatter and body', async () => {
    const { remote } = await boot()
    const issue = await remote.get('DH-1')
    expect(issue).toMatchObject({
      key: 'DH-1',
      project: 'DH',
      issueType: 'task',
      status: 'todo',
      priority: 'S3',
      summary: 'wire proof',
      tags: [],
      links: [],
      kbRefs: ['KB-1'],
      conflicted: false,
      body: 'The body a detail view renders.\n',
    })
    expect(issue.reporter).toBe('human:remote-fixture')
    expect(JSON.parse(JSON.stringify(issue))).toEqual(issue)
  })

  it('maps a missing issue to jira/not-found and a malformed key to jira/invalid-input', async () => {
    const { remote } = await boot()
    const missing = await remote.get('DH-404').then(() => undefined, (error: unknown) => error)
    expect(missing).toBeInstanceOf(RemoteError)
    expect(missing).toMatchObject({ code: 'jira/not-found', details: { jiraCode: 'NOT_FOUND' } })
    const malformed = await remote.get('not-a-key').then(() => undefined, (error: unknown) => error)
    expect(malformed).toMatchObject({ code: 'jira/invalid-input', details: { jiraCode: 'INVALID_INPUT' } })
  })

  it('answers kbSearch() with a cited hit and an empty search without matches', async () => {
    const { remote } = await boot()
    const found = await remote.kbSearch('ledger')
    expect(found.hits).toHaveLength(1)
    expect(found.hits[0]).toMatchObject({
      key: 'KB-1',
      title: 'Ledger boot notes',
      domain: 'notes',
      kbType: 'concept',
      file: 'knowledge/notes/KB-1.md',
      titleMatch: true,
    })
    expect(found.hits[0]?.line).toBeGreaterThan(0)
    expect(found).toMatchObject({ matched: 1, truncated: false, topK: 10 })
    const none = await remote.kbSearch('nothing-matches-this')
    expect(none.hits).toEqual([])
    expect(none.matched).toBe(0)
    expect(JSON.parse(JSON.stringify(found))).toEqual(found)
  })
})
