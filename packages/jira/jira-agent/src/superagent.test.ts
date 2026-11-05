/**
 * Tests for the claim loop (DH-513).
 *
 * The pure half covers the two predicates the loop is made of: whether an issue can be taken, and
 * whether this session still holds the proposal that would let it. The composed half runs the loop
 * it was built for — scan, propose, claim, and an executor delivering — through the shipped tool
 * registry and a real store, because the gate is a fact about files and comments, not about the
 * session.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { after, describe, it } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import { type Comment, type Identity, type Issue, type Timestamp, removeTree } from '@deepseek-ai/dsh-jira-core'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  CLAIM_APPROVED_MARKER,
  CLAIM_TOOL_NAME,
  DAEMON_SESSION_ID,
  DISPATCH_MARKER,
  DISPATCH_TOOL_NAME,
  PROPOSAL_MARKER,
  SCAN_TOOL_NAME,
  LEDGER_TOOL_NAME,
  MODELS_TOOL_NAME,
  SESSION_TOOL_NAME,
  SOURCE_TOOL_NAME,
  STATUS_TOOL_NAME,
  SUPERAGENT_SECTION_NAME,
  TOOL_NAME,
  WORKSPACE_TOOL_NAME,
  WORK_TOOL_NAME,
  DELIVER_TOOL_NAME,
  claimability,
  createJiraContribution,
  createSessionRecorder,
  createSuperagentContribution,
  daemonIdentityOf,
  deliverTaskReport,
  enforceSuperAgentPermission,
  ensureSuperWorkspace,
  isBlocked,
  isSuperAgentSession,
  jiraWorkerTools,
  openProposal,
  pinWorkspaceFirst,
  runDaemonPass,
  runDeliverTool,
  superAgentFsRoots,
  resolveReportedTask,
  runLedgerTool,
  runModelsTool,
  runSessionTool,
  runSourceTool,
  runSuperagentPass,
  runWorkspaceTool,
  superagentHomeProblem,
} from './index.ts'
import * as jiraAgent from './index.ts'
import { type DispatchLedgerTask } from './dispatch-ledger.ts'
import { callerOf, identityOf } from './tools.ts'
import { type JiraHarness, createLedgerFixture, dispatchTool, mountJira, testAgent, waitFor } from './testing/host.ts'

/** An agent handle the harness built. */
type AgentHandle = ReturnType<typeof testAgent>

/** Ledgers created by this file, removed once the run settles. */
const throwaway: string[] = []

after(async () => {
  for (const dir of throwaway.splice(0)) await removeTree(dir)
  for (const dir of workspaceDirs.splice(0)) await removeTree(dir)
})

/** A fresh ledger per test: every case claims and writes. */
const fixture = async (): Promise<string> => {
  const dir = await createLedgerFixture()
  throwaway.push(dir)
  return dir
}

/** Let activation and dispatch continuations run. */
const settle = async (): Promise<void> => {
  await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
}

/**
 * Mount a composition with the claim loop enabled and a root agent wired to it.
 *
 * The executor's tool is registered directly instead of through `agent/created`: every agent in
 * this harness shares the root context, so wiring a second one would contend for the same tool
 * names. The per-agent split itself is asserted separately, against the contribution.
 * @param options - the mount options to vary.
 * @returns the harness and the two handles.
 */
const mount = async (
  options: Parameters<typeof mountJira>[1] = {},
  workerPreset?: string,
  maxWorkers?: number,
): Promise<{
  harness: JiraHarness
  main: AgentHandle
  worker: AgentHandle
}> => {
  const harness = await mountJira(await fixture(), { superagent: true, ...options })
  await harness.ctx.plugin(jiraAgent, {
    ...(workerPreset === undefined ? {} : { superagent_worker_preset: workerPreset }),
    ...(maxWorkers === undefined ? {} : { superagent_max_workers: maxWorkers }),
  })
  await settle()
  for (const tool of jiraWorkerTools(harness.host)) harness.ctx.tools.register(tool)
  const main = testAgent(harness.ctx, 'main-1')
  await harness.ctx.serial('agent/created', { agent: main, source: 'startup' })
  const worker = testAgent(harness.ctx, 'worker-1', {
    origin: 'subagent',
    delegationDepth: 1,
    parentSession: SessionId('main-1'),
  })
  return { harness, main, worker }
}

/** Dispatch one call and return its envelope. */
const call = async (
  harness: JiraHarness,
  agent: AgentHandle,
  name: string,
  args: unknown,
): Promise<Record<string, unknown>> => {
  const result = await dispatchTool(harness, agent, name, args, `${name}-${String(Math.random()).slice(2)}`)
  const value = result.value
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value), `expected an envelope for ${name}`)
  return value as Record<string, unknown>
}

/** The issue an envelope returned. */
const issueOf = (envelope: Record<string, unknown>): Record<string, unknown> => {
  const issue = envelope.issue
  assert.ok(typeof issue === 'object' && issue !== null, 'envelope must carry the issue')
  return issue as Record<string, unknown>
}

/** The candidate rows an envelope returned. */
const itemsOf = (envelope: Record<string, unknown>): Record<string, unknown>[] =>
  Array.isArray(envelope.items) ? envelope.items as Record<string, unknown>[] : []

/** The comment bodies an envelope returned, oldest first. */
const bodiesOf = (envelope: Record<string, unknown>): string[] => {
  const comments = envelope.comments
  if (!Array.isArray(comments)) return []
  return comments.map((comment) => {
    const body = (comment as { body?: unknown }).body
    return typeof body === 'string' ? body : ''
  })
}

const AT = '2026-10-15T12:00:00Z' as Timestamp
const MAIN = 'agent:deepseek-flash|dsh|a1b2c3d4|main-1' as Identity

/** A person's confirmation: the human-authored credential a claim consumes. */
const approve = async (harness: JiraHarness, key = 'DH-12'): Promise<void> => {
  const written = await harness.ctx.jira.mutateIssue(key as Issue['key'], {
    action: 'comment',
    body: `${CLAIM_APPROVED_MARKER} go ahead`,
  }, { by: 'human:daiqc' as Identity, at: AT }, {})
  assert.equal(written.ok, true, written.ok ? '' : JSON.stringify(written.error))
}

/** Bind an executor Session the way a dispatch does: the record precedes any executor write. */
const bindExecutor = async (harness: JiraHarness, key: string, sessionId: string): Promise<AgentHandle> => {
  const written = await harness.ctx.jira.mutateIssue(key as Issue['key'], {
    action: 'comment',
    body: `${DISPATCH_MARKER} ${sessionId} started`,
  }, { by: 'human:daiqc' as Identity, at: AT }, {})
  assert.equal(written.ok, true, written.ok ? '' : JSON.stringify(written.error))
  return testAgent(harness.ctx, sessionId)
}

/** A `todo` issue with no links, no claim and a body. */
const issue = (overrides: Partial<Issue> = {}): Issue => ({
  key: 'DH-12' as Issue['key'],
  project: 'DH',
  issueType: 'task',
  status: 'todo',
  summary: 'first',
  priority: 'S3',
  tags: [],
  links: [],
  revision: 1,
  createdAt: AT,
  updatedAt: AT,
  reporter: 'human:daiqc' as Identity,
  kbRefs: [],
  conflicted: false,
  body: '',
  ...overrides,
})

/** A comment authored by the given identity. */
const comment = (author: Identity, body: string): Comment => ({
  id: 'c-a1b2-1',
  author,
  revision: 1,
  createdAt: AT,
  body,
})

describe('superagent: what can be taken', () => {
  it('takes a todo issue with no blocker and no claim', () => {
    assert.deepEqual(claimability(issue(), false, AT), { ready: true })
  })

  it('refuses a blocked, started or held issue, and names which', () => {
    assert.match(String(claimability(issue(), true, AT).reason), /is_blocked_by/u)
    assert.match(String(claimability(issue({ status: 'in_progress' }), false, AT).reason), /in_progress/u)
    const held = issue({ assignee: MAIN, leaseExpiresAt: '2026-10-15T14:00:00Z' as Timestamp })
    assert.match(String(claimability(held, false, AT).reason), /claimed by/u)
  })

  it('lets an expired lease be taken again', () => {
    const expired = issue({ assignee: MAIN, leaseExpiresAt: '2026-10-15T11:00:00Z' as Timestamp })
    assert.deepEqual(claimability(expired, false, AT), { ready: true })
  })

  it('treats an open or missing blocker as blocking, and a closed one as clear', () => {
    const closedBlocker = issue({ key: 'DH-13' as Issue['key'], status: 'closed' })
    const linked = issue({ links: [{ type: 'is_blocked_by', target: 'DH-13' as Issue['key'] }] })
    const byKey = new Map<string, Issue>([['DH-13', closedBlocker]])
    assert.equal(isBlocked(linked, new Map(), ['closed', 'cancelled']), true, 'a missing target stays blocking')
    assert.equal(isBlocked(linked, byKey, ['closed', 'cancelled']), false, 'a closed target clears the block')
    assert.equal(isBlocked(linked, byKey, []), true, 'an open target blocks')
    assert.equal(isBlocked(issue(), byKey, ['closed']), false, 'no links, no block')
  })
})

describe('superagent: is the proposal still fresh', () => {
  it('accepts only a session proposal a person confirmed with a human comment', () => {
    const proposal = comment(MAIN, `${PROPOSAL_MARKER} because`)
    const approval = comment('human:daiqc' as Identity, `${CLAIM_APPROVED_MARKER} go`)
    assert.match(String(openProposal([], MAIN).reason), /propose first/u)
    assert.match(String(openProposal([comment(MAIN, 'hello')], MAIN).reason), /propose first/u)
    assert.match(String(openProposal([proposal], MAIN).reason), /ask a person/u)
    assert.match(String(openProposal([proposal, comment(MAIN, 'still here')], MAIN).reason), /ask a person/u)
    assert.match(String(openProposal([proposal, comment('agent:other' as Identity, `${CLAIM_APPROVED_MARKER} x`)], MAIN).reason), /not a person/u)
    assert.match(String(openProposal([proposal, comment('human:daiqc' as Identity, 'yes')], MAIN).reason), /claim-approved/u)
    assert.deepEqual(openProposal([proposal, approval], MAIN), { ready: true })
  })

  it('spends the confirmation once a later comment follows it', () => {
    const spent = [
      comment(MAIN, `${PROPOSAL_MARKER} because`),
      comment('human:daiqc' as Identity, `${CLAIM_APPROVED_MARKER} go`),
      comment(MAIN, 'thanks, noted'),
    ]
    assert.match(String(openProposal(spent, MAIN).reason), /ask a person/u)
  })
})

/** A throwaway directory the workspace tests own, removed with the ledgers. */
const workspaceDirs: string[] = []

/** One row of the stand-in registry below. */
interface FakeWorkspace {
  id: string
  path: string
  title: string
  sessionIds: unknown[]
  status(): Promise<string>
  setTitle(title: string): Promise<void>
}

/**
 * A stand-in for the host's workspace registry.
 *
 * The real one needs `storageDomain` and `sessionPersistence`; the claim loop only reads the
 * registry through `ctx.get` and calls `list`/`create`/`insertBefore`, so a plain class with
 * exactly those methods is what proves the duck typing works.
 */
class FakeWorkspaceRegistry {
  readonly rows: FakeWorkspace[] = []
  readonly deleted: string[] = []

  list(): readonly FakeWorkspace[] {
    return this.rows
  }

  async delete(id: string): Promise<boolean> {
    const index = this.rows.findIndex(row => row.id === id)
    if (index < 0) return false
    this.rows.splice(index, 1)
    this.deleted.push(id)
    return true
  }

  async create(path: string, title?: string): Promise<FakeWorkspace> {
    const found = this.rows.find(row => row.path === path)
    if (found !== undefined) return found
    const created: FakeWorkspace = {
      id: `w-${String(this.rows.length + 1)}`,
      path,
      title: title ?? path,
      sessionIds: [],
      status: async () => 'ok',
      async setTitle(next: string) { this.title = next },
    }
    this.rows.push(created)
    return created
  }

  async insertBefore(id: string, beforeId?: string): Promise<readonly string[]> {
    const index = this.rows.findIndex(row => row.id === id)
    if (index < 0) throw new Error(`unknown workspace ${id}`)
    const [moved] = this.rows.splice(index, 1)
    if (moved === undefined) throw new Error(`unknown workspace ${id}`)
    const at = beforeId === undefined ? this.rows.length : this.rows.findIndex(row => row.id === beforeId)
    this.rows.splice(at < 0 ? this.rows.length : at, 0, moved)
    return this.rows.map(row => row.id)
  }
}

/**
 * Register the stand-in on the composition under the service's own name.
 * @param harness - the mounted composition to extend.
 * @returns the registry the tools will find.
 */
const provideRegistry = async (harness: JiraHarness): Promise<FakeWorkspaceRegistry> => {
  const registry = new FakeWorkspaceRegistry()
  await harness.ctx.plugin({
    name: 'fake-workspace-registry',
    apply(pluginCtx: Context) {
      pluginCtx.reflect.provide('workspaceRegistry', registry)
    },
  })
  return registry
}

/** A directory that exists but is not registered yet. */
const scratchDirectory = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-superagent-ws-'))
  workspaceDirs.push(dir)
  return dir
}

describe('superagent: the workspace roster', () => {
  it('says so plainly when the deployment has no workspace registry', async () => {
    const { harness, main } = await mount()
    try {
      const refused = await call(harness, main, WORKSPACE_TOOL_NAME, { action: 'roster' })
      assert.equal(refused.ok, false)
      assert.match(JSON.stringify(refused.error), /no workspace registry/u)
    } finally {
      await harness.dispose()
    }
  })

  it('registers a directory that does not exist, and lists it', async () => {
    const { harness, main } = await mount()
    try {
      const registry = await provideRegistry(harness)
      const dir = await scratchDirectory()
      const target = join(dir, 'checkout')

      const registered = await call(harness, main, WORKSPACE_TOOL_NAME, { action: 'ensure', path: target, title: 'the work' })
      assert.equal(registered.ok, true, JSON.stringify(registered.error))
      const workspace = registered.workspace as Record<string, unknown>
      assert.equal(workspace.path, target)
      assert.equal(workspace.status, 'ok')

      const again = await call(harness, main, WORKSPACE_TOOL_NAME, { action: 'ensure', path: target })
      assert.equal(again.ok, true, JSON.stringify(again.error))
      assert.equal(registry.rows.length, 1, 'ensure is idempotent')

      const roster = await call(harness, main, WORKSPACE_TOOL_NAME, { action: 'roster' })
      const rows = roster.workspaces as Record<string, unknown>[]
      assert.equal(rows.length, 1)
      assert.equal(rows[0]?.title, 'the work')
    } finally {
      await harness.dispose()
    }
  })
})

describe('superagent: workspace management', () => {
  it('removes a registration through the live registry, renames, and lists orphans', async () => {
    const { harness, main } = await mount()
    try {
      const registry = await provideRegistry(harness)
      const dir = await scratchDirectory()
      const qec = join(dir, 'qec')
      const work = join(dir, 'work')
      await call(harness, main, WORKSPACE_TOOL_NAME, { action: 'ensure', path: qec, title: 'qec' })
      await call(harness, main, WORKSPACE_TOOL_NAME, { action: 'ensure', path: work, title: 'the work' })
      const qecRow = registry.rows.find(row => row.title === 'qec')
      assert.ok(qecRow !== undefined)

      const refused = await call(harness, main, WORKSPACE_TOOL_NAME, { action: 'remove', workspace: 'qec', confirm: 'wrong' })
      assert.equal(refused.ok, false)
      assert.match(JSON.stringify(refused.error), /confirm/u)
      assert.equal(registry.rows.length, 2, 'a refused removal changes nothing')

      const renamed = await call(harness, main, WORKSPACE_TOOL_NAME, { action: 'rename', workspace: 'the work', title: 'renamed' })
      assert.equal(renamed.ok, true, JSON.stringify(renamed.error))
      assert.equal(registry.rows.find(row => row.path === work)?.title, 'renamed')

      const removed = await call(harness, main, WORKSPACE_TOOL_NAME, { action: 'remove', workspace: 'qec', confirm: 'qec' })
      assert.equal(removed.ok, true, JSON.stringify(removed.error))
      assert.equal(removed.removed, true)
      assert.equal(removed.directory_kept, true)
      assert.equal(removed.sessions_kept, true)
      assert.deepEqual(registry.deleted, [qecRow?.id])
      assert.equal(registry.rows.some(row => row.path === qec), false)
      assert.equal((await stat(qec)).isDirectory(), true, 'the directory survives the unregistration')

      const orphan = registry.rows.find(row => row.path === work)
      assert.ok(orphan !== undefined)
      orphan.status = async () => 'missing-dir'
      const orphans = await call(harness, main, WORKSPACE_TOOL_NAME, { action: 'orphans' })
      const rows = orphans.workspaces as Record<string, unknown>[]
      assert.deepEqual(rows.map(row => row.path), [work])
      assert.equal(rows[0]?.status, 'missing-dir')

      const self = await call(harness, main, WORKSPACE_TOOL_NAME, { action: 'remove', workspace: 'qec', confirm: 'qec' })
      assert.equal(self.ok, false, 'the removed workspace is no longer found')
    } finally {
      await harness.dispose()
    }
  })

  it('refuses the super workspace and the workspace this Session runs in', async () => {
    const { harness } = await mount()
    try {
      const registry = await provideRegistry(harness)
      const dir = await scratchDirectory()
      const home = join(dir, 'super')
      const workspace = await registry.create(home, 'Super agent')
      const options = {
        jira: {} as never,
        caller: { writable: true, cwd: home } as never,
        at: '2026-10-15T12:00:00Z' as never,
      }
      const refused = await runWorkspaceTool(
        { action: 'remove', workspace: workspace.id, confirm: workspace.id },
        options, {}, harness.ctx as never,
      )
      assert.equal(refused.ok, false)
      assert.match(JSON.stringify(refused.error), /runs in|super workspace/u)
      assert.equal(registry.rows.some(row => row.id === workspace.id), true)
    } finally {
      await harness.dispose()
    }
  })
})

/** Shared model-selection fake for the Session action tests. */
class ModelSelectingController {
  selections: { sessionId: string; provider: string; model: string; reasoningEffort?: string }[] = []

  async selectModel(request: { sessionId: string; provider: string; model: string; reasoningEffort?: string }) {
    this.selections.push(request)
    return {
      selected: {
        provider: request.provider,
        model: request.model,
        ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
      },
    }
  }
}

describe('superagent: workspace Sessions', () => {
  it('runs a workspace Session and routes its report back (DH-719)', async () => {
    const workspacePath = join(tmpdir(), 'task-workspace')
    class TaskController extends ModelSelectingController {
      created: { workspaceId?: string; agentPreset?: string }[] = []
      prompted: { sessionId: string; text: string }[] = []
      forked: { sessionId: string; atSeq?: number }[] = []
      items = [
        { sessionId: 'w-session', running: false, cwd: workspacePath, blank: false, updatedAt: 100 },
        { sessionId: 'other-session', running: true, cwd: join(tmpdir(), 'elsewhere'), blank: false, updatedAt: 300 },
        { sessionId: 'child', running: false, cwd: workspacePath, parentSessionId: 'w-session', origin: 'subagent', updatedAt: 200 },
      ]
      async create(request: { workspaceId?: string; agentPreset?: string }) {
        this.created.push(request)
        return { sessionId: 'w-session-2' }
      }
      async prompt(request: { sessionId: string; content: readonly { text: string }[] }) {
        this.prompted.push({ sessionId: String(request.sessionId), text: request.content[0]?.text ?? '' })
        return { accepted: true }
      }
      async list() { return { items: this.items } }
      async fork(request: { sessionId: string; atSeq?: number }) {
        this.forked.push(request)
        return { sessionId: 'w-session-fork' }
      }
    }
    class TaskRegistry {
      rows = [{ id: 'w1', path: workspacePath, title: 'hello', sessionIds: [], status: async () => 'ok' }]
      archived: string[] = []
      list() { return this.rows }
      async create(path: string, title?: string) {
        return { id: 'w2', path, title: title ?? path, sessionIds: [], status: async () => 'ok' }
      }
      async archiveSession(sessionId: string) { this.archived.push(sessionId) }
    }
    const controller = new TaskController()
    const registry = new TaskRegistry()
    const ctx = {
      get: (key: string) => key === 'sessionController' ? controller : key === 'workspaceRegistry' ? registry : undefined,
    }
    const tasks = new Map<string, { superSession: string; workspace: string }>()
    const options = {
      jira: {} as never,
      caller: { writable: true, sessionId: 'super-1' } as never,
      at: '2026-10-15T12:00:00Z' as never,
    }
    const me = { session: 'super-1', identity: 'agent:test|dsh|m|super-1' }

    const started = await runSessionTool(
      { action: 'start', workspace: 'hello', task: 'write the README' },
      options, me, ctx, { agentPreset: 'cordis', tasks },
    )
    assert.equal(started.ok, true, JSON.stringify(started.error))
    assert.deepEqual(controller.created, [{ workspaceId: 'w1', agentPreset: 'cordis' }])
    assert.equal(controller.prompted[0]?.text, 'write the README')
    assert.equal(controller.prompted[0]?.sessionId, 'w-session-2')
    assert.deepEqual(tasks.get('w-session-2'), { superSession: 'super-1', workspace: workspacePath })

    const followed = await runSessionTool(
      { action: 'prompt', session: 'w-session-2', text: 'add a section' },
      options, me, ctx, { tasks },
    )
    assert.equal(followed.ok, true, JSON.stringify(followed.error))
    assert.equal(controller.prompted[1]?.text, 'add a section')
    assert.equal(tasks.get('w-session-2')?.superSession, 'super-1')

    const listed = await runSessionTool({ action: 'list', workspace: 'hello' }, options, me, ctx, { tasks })
    assert.equal(listed.ok, true, JSON.stringify(listed.error))
    const rows = listed.sessions as { id: string }[]
    assert.deepEqual(rows.map(row => row.id), ['w-session'], 'only the workspace Sessions, no children')

    // Follow-up work continues the workspace's most recent Session instead of opening another.
    controller.items = [
      ...controller.items,
      { sessionId: 'w-newer', running: false, cwd: workspacePath, blank: false, updatedAt: 999 },
    ]
    const appended = await runSessionTool(
      { action: 'append', workspace: 'hello', text: 'one more section' },
      options, me, ctx, { tasks },
    )
    assert.equal(appended.ok, true, JSON.stringify(appended.error))
    assert.equal(controller.prompted.at(-1)?.sessionId, 'w-newer')
    assert.equal(tasks.get('w-newer')?.superSession, 'super-1')

    controller.items = []
    const noTarget = await runSessionTool(
      { action: 'append', workspace: 'hello', text: 'nothing to continue' },
      options, me, ctx, { tasks },
    )
    assert.equal(noTarget.ok, false, 'append refuses when the workspace has no Session yet')

    const archived = await runSessionTool({ action: 'archive', session: 'w-session-2' }, options, me, ctx, { tasks })
    assert.equal(archived.ok, true, JSON.stringify(archived.error))
    assert.deepEqual(registry.archived, ['w-session-2'])
    assert.equal(tasks.has('w-session-2'), false)

    const selfDelete = await runSessionTool(
      { action: 'delete', session: 'super-1', confirm: 'super-1' },
      options, me, ctx, { tasks },
    )
    assert.equal(selfDelete.ok, false, 'the calling Session cannot delete itself')

    const noDeleteApi = await runSessionTool(
      { action: 'delete', session: 'w-session', confirm: 'w-session' },
      options, me, ctx, { tasks },
    )
    assert.equal(noDeleteApi.ok, false)
    assert.match(JSON.stringify(noDeleteApi.error), /no Session delete API/u)
    assert.deepEqual(registry.archived, ['w-session-2'], 'delete never silently falls back to archive')

    const deletingController = new TaskController() as TaskController & { deleted: string[]; delete(sessionId: string): Promise<void> }
    deletingController.deleted = []
    deletingController.delete = async function (sessionId: string) { this.deleted.push(sessionId) }
    const deletingCtx = { get: (key: string) => key === 'sessionController' ? deletingController : key === 'workspaceRegistry' ? registry : undefined }
    const deleted = await runSessionTool(
      { action: 'delete', session: 'w-session', confirm: 'w-session' },
      options, me, deletingCtx, { tasks },
    )
    assert.equal(deleted.ok, true, JSON.stringify(deleted.error))
    assert.deepEqual(deletingController.deleted, ['w-session'])
    assert.equal(tasks.has('w-session'), false)

    const forked = await runSessionTool({ action: 'fork', session: 'w-session', atSeq: 7 }, options, me, ctx, { tasks })
    assert.equal(forked.ok, true, JSON.stringify(forked.error))
    assert.deepEqual(controller.forked, [{ sessionId: 'w-session', atSeq: 7 }])
    assert.equal(tasks.get('w-session-fork')?.superSession, 'super-1')

    // The report is an ordinary queued message in the super Session, not a held turn.
    const host = {
      ctx: { ...ctx, logger: { warn: () => {} } } as never,
      env: {},
      clock: () => Date.parse(AT),
      recorder: createSessionRecorder(),
    }
    const worker = {
      id: 'w-session',
      session: {
        snapshotEvents: () => [{
          type: 'assistant/message',
          data: { message: { content: [{ type: 'text', text: 'README written and verified' }] } },
        }],
      },
    }
    const delivered = await deliverTaskReport(
      host as never, { superSession: 'super-1', workspace: workspacePath }, worker, new AbortController().signal,
    )
    assert.equal(delivered, true)
    const report = controller.prompted.at(-1)
    assert.equal(report?.sessionId, 'super-1')
    assert.match(report?.text ?? '', /\[task-report\] w-session/u)
    assert.match(report?.text ?? '', /README written and verified/u)
  })
})

describe('superagent: the dispatch ledger', () => {
  it('records a pending dispatch automatically, then resolves and lists it', async () => {
    const root = await scratchDirectory()
    const { harness } = await mount()
    try {
      const registry = await provideRegistry(harness)
      const workspace = await registry.create(root, 'rimworld')
      const controller = {
        created: [] as unknown[],
        async create(request: unknown) { this.created.push(request); return { sessionId: 'child-1' } },
        async prompt() { return { accepted: true } },
        async list() { return { items: [] } },
      }
      const ctx = {
        get: (key: string) => key === 'workspaceRegistry' ? registry : key === 'sessionController' ? controller : undefined,
      }
      const options = {
        jira: {} as never,
        caller: { writable: true, sessionId: 'super-1', cwd: root } as never,
        at: '2026-11-05T00:00:00Z' as never,
      }
      const me = { session: 'super-1', identity: 'agent:test|dsh|m|super-1' }
      const started = await runSessionTool(
        { action: 'start', workspace: 'rimworld', task: 'build the colony' },
        options, me, ctx, { agentPreset: 'worker', tasks: new Map() },
      )
      assert.equal(started.ok, true, JSON.stringify(started.error))
      const file = join(root, '.superagent/ledger', `${workspace.id}.md`)
      const pending = await readFile(file, 'utf8')
      assert.match(pending, /## task-.* · pending/u)
      assert.match(pending, /build the colony/u)

      const listing = await runLedgerTool({ action: 'list', workspace: 'rimworld' }, options, me, ctx as never)
      assert.equal(listing.ok, true, JSON.stringify(listing.error))
      const rows = listing.entries as { id: string; status: string; task: string }[]
      assert.equal(rows.length, 1)
      assert.equal(rows[0]?.status, 'pending')
      const id = rows[0]?.id ?? ''

      // The turn-end report path resolves the same entry without the model's help.
      await resolveReportedTask({
        superSession: 'super-1',
        workspace: root,
        ledger: { root, task: rows[0] as unknown as DispatchLedgerTask },
      }, 'colony survived automatically', AT as never)
      const auto = await runLedgerTool({ action: 'list', workspace: 'rimworld', status: 'returned' }, options, me, ctx as never)
      assert.equal((auto.entries as unknown[]).length, 1)

      const resolved = await runLedgerTool({
        action: 'resolve', id, status: 'returned', outcome: 'colony survived',
        decisions: ['choose a new stove'], artifacts: ['out/colony.png'],
      }, options, me, ctx as never)
      assert.equal(resolved.ok, true, JSON.stringify(resolved.error))
      const task = resolved.task as { status: string; outcome: string; decisions: readonly string[] }
      assert.equal(task.status, 'returned')
      assert.equal(task.outcome, 'colony survived')
      assert.deepEqual(task.decisions, ['choose a new stove'])
      assert.deepEqual((resolved.memory as { kind: string }).kind, 'decision')

      const updated = await runLedgerTool({ action: 'list', workspace: 'rimworld', status: 'returned' }, options, me, ctx as never)
      const updatedRows = updated.entries as { status: string; outcome: string }[]
      assert.equal(updatedRows.length, 1)
      assert.equal(updatedRows[0]?.outcome, 'colony survived')
    } finally {
      await harness.dispose()
    }
  })
})

describe('superagent: model selection and discovery', () => {
  it('selects a model for start and for a later follow-up, and reports the accepted route', async () => {
    const workspacePath = join(tmpdir(), 'model-workspace')
    class Controller extends ModelSelectingController {
      prompted: string[] = []
      async create() { return { sessionId: 'model-child' } }
      async prompt(request: { sessionId: string }) { this.prompted.push(String(request.sessionId)); return { accepted: true } }
      async list() { return { items: [{ sessionId: 'model-child', running: false, cwd: workspacePath, blank: false }] } }
    }
    class Registry {
      rows = [{ id: 'w1', path: workspacePath, title: 'model work', sessionIds: [], status: async () => 'ok' }]
      list() { return this.rows }
      async create(path: string, title?: string) { return { id: 'w2', path, title: title ?? path, sessionIds: [], status: async () => 'ok' } }
    }
    const controller = new Controller()
    const registry = new Registry()
    const ctx = { get: (key: string) => key === 'sessionController' ? controller : key === 'workspaceRegistry' ? registry : undefined }
    const options = {
      jira: {} as never,
      caller: { writable: true, sessionId: 'super-1', cwd: await scratchDirectory() } as never,
      at: '2026-11-05T00:00:00Z' as never,
    }
    const me = { session: 'super-1' }

    const started = await runSessionTool(
      { action: 'start', workspace: 'model work', task: 'plan', provider: 'p', model: 'm', reasoning_effort: 'high' },
      options, me, ctx, { tasks: new Map() },
    )
    assert.equal(started.ok, true, JSON.stringify(started.error))
    assert.deepEqual(controller.selections[0], { sessionId: 'model-child', provider: 'p', model: 'm', reasoningEffort: 'high' })
    assert.deepEqual(started.model, { provider: 'p', model: 'm', reasoningEffort: 'high' })

    controller.list = async () => ({ items: [{ sessionId: 'model-child', running: false, cwd: workspacePath, blank: false }] })
    const followed = await runSessionTool(
      { action: 'append', workspace: 'model work', text: 'continue', provider: 'p2', model: 'm2' },
      options, me, ctx, { tasks: new Map() },
    )
    assert.equal(followed.ok, true, JSON.stringify(followed.error))
    assert.deepEqual(controller.selections[1], { sessionId: 'model-child', provider: 'p2', model: 'm2' })
    assert.deepEqual(followed.model, { provider: 'p2', model: 'm2' })
  })

  it('refuses a model on a host without selectModel, and rejects provider-only fields', async () => {
    const workspacePath = join(tmpdir(), 'model-refusal')
    class NoSelect {
      async create() { return { sessionId: 'x' } }
      async prompt() { return { accepted: true } }
      async list() { return { items: [{ sessionId: 'x', running: false, cwd: workspacePath, blank: false }] } }
    }
    class Registry {
      rows = [{ id: 'w1', path: workspacePath, title: 'r', sessionIds: [], status: async () => 'ok' }]
      list() { return this.rows }
      async create(path: string, title?: string) { return { id: 'w2', path, title: title ?? path, sessionIds: [], status: async () => 'ok' } }
    }
    const controller = new NoSelect()
    const ctx = { get: (key: string) => key === 'sessionController' ? controller : key === 'workspaceRegistry' ? new Registry() : undefined }
    const options = { jira: {} as never, caller: { writable: true, sessionId: 's', cwd: await scratchDirectory() } as never, at: '2026-11-05T00:00:00Z' as never }
    const me = { session: 's' }
    const noApi = await runSessionTool({ action: 'start', workspace: 'r', task: 'x', provider: 'p', model: 'm' }, options, me, ctx, { tasks: new Map() })
    assert.equal(noApi.ok, false)
    assert.match(JSON.stringify(noApi.error), /no Session model-selection API/u)
    const providerOnly = await runSessionTool({ action: 'prompt', session: 'x', text: 'x', provider: 'p' }, options, me, ctx, { tasks: new Map() })
    assert.equal(providerOnly.ok, false)
    assert.match(JSON.stringify(providerOnly.error), /provider.*model/u)
  })

  it('lists providers, models and reasoning efforts from the same LLM registry', async () => {
    const llm = {
      listProviders: () => [{ id: 'p', name: 'Provider' }],
      async listModels() { return [{ id: 'm', name: 'Model', reasoning: { efforts: [{ id: 'high', name: 'High' }] } }] },
      async resolveModelInfo() { return { id: 'm', name: 'Model', reasoning: { defaultEffort: 'high', efforts: [{ id: 'high', name: 'High' }] } } },
    }
    const ctx = { get: (key: string) => key === 'llm' ? llm : undefined }
    const options = { jira: {} as never, caller: { writable: true }, at: '2026-11-05T00:00:00Z' as never }
    const me = { session: 's' }
    const providers = await runModelsTool({}, options, me, ctx as never)
    assert.deepEqual(providers.providers, [{ id: 'p', name: 'Provider' }])
    const models = await runModelsTool({ provider: 'p' }, options, me, ctx as never)
    assert.deepEqual((models.models as { id: string }[])[0]?.id, 'm')
    const detail = await runModelsTool({ provider: 'p', model: 'm' }, options, me, ctx as never)
    assert.equal((detail.models as { efforts: { default?: boolean }[] }[])[0]?.efforts[0]?.default, true)
    const missing = await runModelsTool({ provider: 'nope' }, options, me, ctx as never)
    assert.equal(missing.ok, false)
    assert.match(JSON.stringify(missing.error), /not registered/u)
  })
})

describe('superagent: file delivery', () => {
  it('grants the registered workspaces to a super-agent session only', async () => {
    const dir = await scratchDirectory()
    const home = join(dir, 'super-home')
    const live = join(dir, 'live-workspace')
    const missing = join(dir, 'missing-workspace')
    await mkdir(live, { recursive: true })
    const registry = new FakeWorkspaceRegistry()
    await registry.create(home, 'Super agent')
    await registry.create(live, 'live')
    await registry.create(missing, 'missing')
    const ctx = { get: (key: string) => key === 'workspaceRegistry' ? registry : undefined }
    assert.deepEqual(superAgentFsRoots(ctx, { header: { cwd: home } }, home), [realpathSync.native(live)])
    assert.equal(superAgentFsRoots(ctx, { header: { cwd: dir } }, home), undefined)
    assert.equal(superAgentFsRoots(ctx, { header: { cwd: home } }, undefined), undefined)
  })

  it('delivers a file into a registered workspace and refuses escapes and missing dirs', async () => {
    const dir = await scratchDirectory()
    const ws = join(dir, 'ws')
    await mkdir(ws)
    const registry = new FakeWorkspaceRegistry()
    await registry.create(ws, 'ws')
    await registry.create(join(dir, 'gone'), 'gone')
    const ctx = { get: (key: string) => key === 'workspaceRegistry' ? registry : undefined }
    const options = {
      jira: {} as never,
      caller: { writable: true, sessionId: 'session-super' } as never,
      at: '2026-10-15T12:00:00Z' as never,
    }
    const src = join(dir, 'report.csv')
    await writeFile(src, 'a,b\n1,2\n', 'utf8')

    const ok = await runDeliverTool({ source: src, workspace: 'ws', destination: 'inbox/report.csv' }, options, { session: 's' }, ctx)
    assert.equal(ok.ok, true, JSON.stringify(ok.error))
    assert.equal(await readFile(join(ws, 'inbox', 'report.csv'), 'utf8'), 'a,b\n1,2\n')

    const escape = await runDeliverTool({ source: src, workspace: 'ws', destination: '../escape.csv' }, options, { session: 's' }, ctx)
    assert.equal(escape.ok, false)
    assert.equal(existsSync(join(dir, 'escape.csv')), false)

    const gone = await runDeliverTool({ source: src, workspace: 'gone' }, options, { session: 's' }, ctx)
    assert.equal(gone.ok, false, 'a removed workspace directory is reported, not a crash')

    const unregistered = await runDeliverTool({ source: src, workspace: 'nope' }, options, { session: 's' }, ctx)
    assert.equal(unregistered.ok, false)

    const second = await runDeliverTool({ source: src, workspace: 'ws', destination: 'inbox/report.csv' }, options, { session: 's' }, ctx)
    assert.equal(second.ok, false, 'an existing destination is kept unless overwrite is true')
    const replaced = await runDeliverTool({ source: src, workspace: 'ws', destination: 'inbox/report.csv', overwrite: true }, options, { session: 's' }, ctx)
    assert.equal(replaced.ok, true, JSON.stringify(replaced.error))
  })

  it('registers the fs-roots provider with the sandbox policy and removes it on dispose', async () => {
    const dir = await scratchDirectory()
    const home = join(dir, 'super-home')
    const live = join(dir, 'live')
    await mkdir(live)
    const providers: ((session: unknown) => readonly string[] | undefined)[] = []
    let disposed = false
    const policy = {
      registerFsWritableRoots: (provider: (session: unknown) => readonly string[] | undefined) => {
        providers.push(provider)
        return () => { disposed = true }
      },
    }
    const registry = new FakeWorkspaceRegistry()
    await registry.create(home)
    await registry.create(live)
    const fakeCtx = {
      get: (key: string) => key === 'sandboxPolicy' ? policy : key === 'workspaceRegistry' ? registry : undefined,
    }
    const contribution = createSuperagentContribution(
      { ctx: fakeCtx as never, env: {}, clock: () => Date.parse(AT), recorder: createSessionRecorder() },
      undefined, 2, undefined, undefined, home,
    )
    assert.equal(providers.length, 1)
    assert.deepEqual(providers[0]?.({ header: { cwd: home } }), [realpathSync.native(live)])
    assert.equal(providers[0]?.({ header: { cwd: dir } }), undefined)
    contribution.dispose?.()
    assert.equal(disposed, true)
  })
})

describe('superagent: the super workspace', () => {
  it('registers the super home once, and a session there is the dispatcher', async () => {
    const dir = await scratchDirectory()
    const home = join(dir, 'super-agent')
    const harness = await mountJira(await fixture(), { superagent: true })
    try {
      await harness.ctx.plugin(jiraAgent, { superagent_home: home })
      const registry = await provideRegistry(harness)
      await waitFor(() => (registry.rows.length > 0 ? registry.rows : undefined))
      assert.equal(registry.rows.length, 1, 'one row for the super home')
      assert.equal(registry.rows[0]?.path, home)
      assert.equal(registry.rows[0]?.title, 'Super agent')

      // The directory is created by the registration, and a second ensure is the registry's own
      // idempotency rather than a second row.
      const again = await ensureSuperWorkspace(registry, home, join(dir, 'home'))
      assert.equal(again.path, home)
      assert.equal(registry.rows.length, 1, 'ensure is idempotent')

      const host = {
        ctx: harness.ctx,
        env: {},
        clock: () => Date.parse(AT),
        recorder: createSessionRecorder(),
      }
      const contribution = createSuperagentContribution(host, 'jira-worker', 2, undefined, undefined, home)
      const superAgent = testAgent(harness.ctx, 'super-1', { cwd: home })
      assert.equal(isSuperAgentSession(superAgent, home), true)
      assert.deepEqual(
        contribution.tools?.(superAgent).map(tool => tool.name),
        [WORKSPACE_TOOL_NAME, SESSION_TOOL_NAME, LEDGER_TOOL_NAME, MODELS_TOOL_NAME, DELIVER_TOOL_NAME],
        'the super agent keeps the workspace roster and the Session verbs, and loses the ledger-bound ones',
      )
      assert.deepEqual(
        contribution.promptSections?.(superAgent).map(section => section.name),
        [SUPERAGENT_SECTION_NAME],
      )

      // Any other checkout keeps the full dispatcher surface and no section.
      const other = testAgent(harness.ctx, 'main-2', { cwd: dir })
      assert.equal(isSuperAgentSession(other, home), false)
      assert.equal(contribution.tools?.(other).length, 6)
      assert.deepEqual(contribution.promptSections?.(other), [])

      // A subagent dispatched from the super agent runs in the target checkout, so it is not one.
      const child = testAgent(harness.ctx, 'child-1', {
        cwd: dir,
        origin: 'subagent',
        delegationDepth: 1,
        parentSession: SessionId('super-1'),
      })
      assert.equal(isSuperAgentSession(child, home), false)
    } finally {
      await harness.dispose()
    }
  })

  it('refuses a super home under the harness home, relative paths and filesystem roots', () => {
    const dshHome = join(tmpdir(), 'dsh-home')
    assert.match(superagentHomeProblem('', dshHome) ?? '', /absolute/u)
    assert.match(superagentHomeProblem('superagent', dshHome) ?? '', /absolute/u)
    assert.match(superagentHomeProblem(join(dshHome, 'superagent'), dshHome) ?? '', /harness home/u)
    assert.match(superagentHomeProblem(parse(dshHome).root, dshHome) ?? '', /root/u)
    assert.equal(superagentHomeProblem(join(tmpdir(), 'superagent'), dshHome), undefined)
  })

  it('seeds a standing definition file once and preserves later edits', async () => {
    const dir = await scratchDirectory()
    const home = join(dir, 'super-agent')
    const harness = await mountJira(await fixture(), { superagent: true })
    try {
      const registry = await provideRegistry(harness)
      await ensureSuperWorkspace(registry, home, join(dir, 'home'))
      const definition = await readFile(join(home, 'AGENTS.md'), 'utf8')
      assert.match(definition, /single conversation/u)
      assert.match(definition, /superagent_ledger/u)
      await writeFile(join(home, 'AGENTS.md'), '# my edit\n', 'utf8')
      await ensureSuperWorkspace(registry, home, join(dir, 'home'))
      assert.equal(await readFile(join(home, 'AGENTS.md'), 'utf8'), '# my edit\n', 'an existing definition is not overwritten')
    } finally {
      await harness.dispose()
    }
  })

  it('pins the super workspace first and leaves the other rows in order', async () => {
    const dir = await scratchDirectory()
    const registry = new FakeWorkspaceRegistry()
    await registry.create(join(dir, 'project-a'), 'project-a')
    await registry.create(join(dir, 'project-b'), 'project-b')
    const home = join(dir, 'super-agent')
    const registered = await ensureSuperWorkspace(registry, home, join(dir, 'home'))
    assert.equal(registry.rows[0]?.id, registered.id, 'the super workspace is pinned first')
    assert.deepEqual(registry.rows.slice(1).map(row => row.title), ['project-a', 'project-b'])
    // A second pin is a no-op.
    await pinWorkspaceFirst(registry, registered)
    assert.equal(registry.rows[0]?.id, registered.id)
  })

  it('pins the super agent to the configured permission preset and leaves others alone', async () => {
    const dir = await scratchDirectory()
    const home = join(dir, 'super-agent')
    const agentCtx = new Context()
    const calls: { session: unknown; preset: string }[] = []
    const permissionCtx = {
      get: (key: string) => key === 'permissionPresets'
        ? { set: (session: unknown, preset: string) => { calls.push({ session, preset }) } }
        : undefined,
    }
    const superAgent = testAgent(agentCtx, 'super-perm', { cwd: home })
    assert.equal(enforceSuperAgentPermission(permissionCtx, superAgent, home, 'workspace-write'), true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.preset, 'workspace-write')
    assert.equal(enforceSuperAgentPermission(permissionCtx, superAgent, home, undefined), false)
    const other = testAgent(agentCtx, 'main-perm', { cwd: dir })
    assert.equal(enforceSuperAgentPermission(permissionCtx, other, home, 'workspace-write'), false)
    assert.equal(calls.length, 1)
    // A deployment without the service keeps its own defaults.
    assert.equal(enforceSuperAgentPermission({}, superAgent, home, 'workspace-write'), false)
  })
})

describe('superagent: the dispatcher\'s surface', () => {
  it('gives a child the ledger reads plus issue_work, and a root the three jira tools', async () => {
    const { harness, main, worker } = await mount()
    try {
      const contribution = createJiraContribution({
        ctx: harness.ctx,
        env: {},
        clock: () => Date.parse(AT),
        recorder: createSessionRecorder(),
      })
      const rootNames = contribution.tools?.(main).map(tool => tool.name).sort() ?? []
      const childNames = contribution.tools?.(worker).map(tool => tool.name).sort() ?? []
      assert.deepEqual(rootNames, ['jira_issue', 'jira_kb', 'jira_list'])
      assert.deepEqual(childNames, ['issue_work', 'jira_issue', 'jira_kb', 'jira_list'])
      // The standing instructions are the child's persona: paid once, cached, and the reason a
      // dispatch instruction only names the issue.
      assert.deepEqual(contribution.promptSections?.(main).map(section => section.name), ['jira:store'])
      assert.deepEqual(contribution.promptSections?.(worker).map(section => section.name), ['jira:executor'])
    } finally {
      await harness.dispose()
    }
  })

  it('gives an executor Session the reads plus issue_work, and no dispatcher verbs', async () => {
    const { harness } = await mount()
    try {
      const host = {
        ctx: harness.ctx,
        env: {},
        clock: () => Date.parse(AT),
        recorder: createSessionRecorder(),
      }
      const executor = testAgent(harness.ctx, 'exec-1', { agentPreset: 'jira-worker' })
      const jira = createJiraContribution(host, 'jira-worker')
      assert.deepEqual(
        jira.tools?.(executor).map(tool => tool.name).sort(),
        ['issue_work', 'jira_issue', 'jira_kb', 'jira_list'],
      )
      assert.deepEqual(jira.promptSections?.(executor).map(section => section.name), ['jira:executor'])

      const dispatcher = createSuperagentContribution(host, 'jira-worker')
      assert.deepEqual(dispatcher.tools?.(executor) ?? null, [], 'an executor cannot dispatch or claim')
      // A root that did not join the preset keeps the dispatcher's surface.
      const other = testAgent(harness.ctx, 'main-9', { agentPreset: 'standard' })
      assert.equal(dispatcher.tools?.(other).length, 6)
    } finally {
      await harness.dispose()
    }
  })

  it('runs the loop into a named workspace: ensure, claim with its path, deliver', async () => {
    const { harness, main } = await mount()
    try {
      await provideRegistry(harness)
      const target = join(await scratchDirectory(), 'checkout')
      const registered = await call(harness, main, WORKSPACE_TOOL_NAME, { action: 'ensure', path: target, title: 'checkout' })
      const workspace = registered.workspace as Record<string, unknown>

      await call(harness, main, CLAIM_TOOL_NAME, { action: 'propose', key: 'DH-12', why: 'ready and small' })
      await approve(harness)
      const claimed = await call(harness, main, CLAIM_TOOL_NAME, {
        action: 'claim',
        key: 'DH-12',
        cwd: String(workspace.path),
      })
      assert.equal(claimed.ok, true, JSON.stringify(claimed.error))
      const dispatch = claimed.dispatch as Record<string, unknown>
      assert.equal(dispatch.cwd, workspace.path, 'the dispatch names the workspace\'s canonical path')

      const executor = await bindExecutor(harness, 'DH-12', 'session-1')
      const delivered = await call(harness, executor, WORK_TOOL_NAME, {
        action: 'deliver',
        key: 'DH-12',
        body: 'done: changed in the named checkout',
      })
      assert.equal(delivered.ok, true, JSON.stringify(delivered.error))
      assert.equal(issueOf(delivered).status, 'in_review')
    } finally {
      await harness.dispose()
    }
  })
})

/** What the stand-in session controller recorded. */
interface FakeSession {
  readonly request: { readonly cwd?: string; readonly agentPreset?: string }
  readonly sessionId: string
}

/**
 * A stand-in for the host's session controller.
 *
 * The real one brings the whole agent loop; the dispatch tool only calls `create` and `prompt`, so
 * a controller with exactly those two methods proves the duck typing and the ordering. It keeps the
 * real `prompt` contract on purpose: the host's controller calls `signal.throwIfAborted()` first, so
 * a dispatch that forgets the signal must fail here rather than only in a GUI.
 */
class FakeSessionController {
  readonly sessions: FakeSession[] = []
  readonly prompts: { readonly sessionId: string; readonly text: string }[] = []
  /** Sessions the stand-in reports as still running. */
  readonly running = new Set<string>()

  async create(request: { readonly cwd?: string; readonly agentPreset?: string }): Promise<{ sessionId: string }> {
    const sessionId = `session-${String(this.sessions.length + 1)}`
    this.sessions.push({ request, sessionId })
    return { sessionId }
  }

  async list(): Promise<{ items: { sessionId: string; running: boolean }[] }> {
    return { items: this.sessions.map(session => ({ sessionId: session.sessionId, running: this.running.has(session.sessionId) })) }
  }

  async prompt(request: {
    readonly sessionId: unknown
    readonly content: readonly { readonly type: string; readonly text?: string }[]
  }, signal: AbortSignal): Promise<{ accepted: true }> {
    signal.throwIfAborted()
    this.prompts.push({
      sessionId: String(request.sessionId),
      text: request.content.map(part => part.text ?? '').join(''),
    })
    return { accepted: true }
  }
}

/**
 * Register the stand-in controller on the composition.
 * @param harness - the mounted composition to extend.
 * @returns the controller the tool will find.
 */
const provideController = async (harness: JiraHarness): Promise<FakeSessionController> => {
  const controller = new FakeSessionController()
  await harness.ctx.plugin({
    name: 'fake-session-controller',
    apply(pluginCtx: Context) {
      pluginCtx.reflect.provide('sessionController', controller)
    },
  })
  return controller
}

describe('superagent: dispatching into a real Session', () => {
  it('refuses to dispatch while the deployment configures no worker preset', async () => {
    const { harness, main } = await mount()
    try {
      const refused = await call(harness, main, DISPATCH_TOOL_NAME, { key: 'DH-12' })
      assert.equal(refused.ok, false)
      assert.match(JSON.stringify(refused.error), /worker preset/u)
    } finally {
      await harness.dispose()
    }
  })

  it('refuses when the deployment has no session controller', async () => {
    const { harness, main } = await mount({}, 'jira-worker')
    try {
      await call(harness, main, CLAIM_TOOL_NAME, { action: 'propose', key: 'DH-12', why: 'ready' })
      await approve(harness)
      await call(harness, main, CLAIM_TOOL_NAME, { action: 'claim', key: 'DH-12' })
      const refused = await call(harness, main, DISPATCH_TOOL_NAME, { key: 'DH-12' })
      assert.equal(refused.ok, false)
      assert.match(JSON.stringify(refused.error), /no session controller/u)
    } finally {
      await harness.dispose()
    }
  })

  it('refuses an issue that is not in progress, and one somebody else claimed', async () => {
    const { harness, main } = await mount({}, 'jira-worker')
    try {
      await provideController(harness)
      const unstarted = await call(harness, main, DISPATCH_TOOL_NAME, { key: 'DH-12' })
      assert.equal(unstarted.ok, false)
      assert.match(JSON.stringify(unstarted.error), /claim it before dispatching/u)

      await call(harness, main, CLAIM_TOOL_NAME, { action: 'propose', key: 'DH-12', why: 'ready' })
      await approve(harness)
      await call(harness, main, CLAIM_TOOL_NAME, { action: 'claim', key: 'DH-12' })
      // A second dispatcher is writable but did not claim it.
      const other = testAgent(harness.ctx, 'main-2')
      const stolen = await call(harness, other, DISPATCH_TOOL_NAME, { key: 'DH-12' })
      assert.equal(stolen.ok, false)
      assert.match(JSON.stringify(stolen.error), /not assigned to this session/u)
    } finally {
      await harness.dispose()
    }
  })

  it('refuses to claim past the configured slots', async () => {
    const { harness, main } = await mount({}, 'jira-worker', 1)
    try {
      await call(harness, main, CLAIM_TOOL_NAME, { action: 'propose', key: 'DH-12', why: 'ready' })
      await approve(harness)
      const first = await call(harness, main, CLAIM_TOOL_NAME, { action: 'claim', key: 'DH-12' })
      assert.equal(first.ok, true, JSON.stringify(first.error))

      const created = await call(harness, main, TOOL_NAME, { action: 'create', project: 'DH', data: { summary: 'second' } })
      const second = String(issueOf(created).key)
      await call(harness, main, CLAIM_TOOL_NAME, { action: 'propose', key: second, why: 'also ready' })
      await approve(harness, second)
      const refused = await call(harness, main, CLAIM_TOOL_NAME, { action: 'claim', key: second })
      assert.equal(refused.ok, false)
      assert.match(JSON.stringify(refused.error), /configured limit/u)
    } finally {
      await harness.dispose()
    }
  })

  it('refuses a second dispatch while the recorded executor still runs', async () => {
    const { harness, main } = await mount({}, 'jira-worker')
    try {
      const controller = await provideController(harness)
      await call(harness, main, CLAIM_TOOL_NAME, { action: 'propose', key: 'DH-12', why: 'ready' })
      await approve(harness)
      await call(harness, main, CLAIM_TOOL_NAME, { action: 'claim', key: 'DH-12' })
      const first = await call(harness, main, DISPATCH_TOOL_NAME, { key: 'DH-12' })
      assert.equal(first.ok, true, JSON.stringify(first.error))

      controller.running.add('session-1')
      const refused = await call(harness, main, DISPATCH_TOOL_NAME, { key: 'DH-12' })
      assert.equal(refused.ok, false)
      assert.match(JSON.stringify(refused.error), /already has a running executor/u)
    } finally {
      await harness.dispose()
    }
  })

  it('dispatches again once the executor is gone, and keeps both records', async () => {
    const { harness, main } = await mount({}, 'jira-worker')
    try {
      const controller = await provideController(harness)
      await call(harness, main, CLAIM_TOOL_NAME, { action: 'propose', key: 'DH-12', why: 'ready' })
      await approve(harness)
      await call(harness, main, CLAIM_TOOL_NAME, { action: 'claim', key: 'DH-12' })
      await call(harness, main, DISPATCH_TOOL_NAME, { key: 'DH-12' })

      const again = await call(harness, main, DISPATCH_TOOL_NAME, { key: 'DH-12' })
      assert.equal(again.ok, true, JSON.stringify(again.error))
      assert.equal((again.dispatch as Record<string, unknown>).session, 'session-2')

      const read = await call(harness, main, TOOL_NAME, { action: 'get', key: 'DH-12' })
      const records = bodiesOf(read).filter(body => body.startsWith('[dispatch:session]'))
      assert.equal(records.filter(body => body.includes('session-1')).length, 2, JSON.stringify(bodiesOf(read)))
      assert.equal(records.filter(body => body.includes('session-2')).length, 2)
      assert.equal(controller.sessions.length, 2)
    } finally {
      await harness.dispose()
    }
  })

  it('recovers the executors a restart lost, and names what it left alone', async () => {
    const { harness, main } = await mount({}, 'jira-worker')
    try {
      const controller = await provideController(harness)
      await call(harness, main, CLAIM_TOOL_NAME, { action: 'propose', key: 'DH-12', why: 'ready' })
      await approve(harness)
      await call(harness, main, CLAIM_TOOL_NAME, { action: 'claim', key: 'DH-12' })
      await call(harness, main, DISPATCH_TOOL_NAME, { key: 'DH-12' })

      // The restart: the Session is gone, the claim is not.
      const recovered = await call(harness, main, DISPATCH_TOOL_NAME, { action: 'recover' })
      assert.equal(recovered.ok, true, JSON.stringify(recovered.error))
      const restarted = recovered.recovered as { key: string; previous: string; session: string }[]
      assert.equal(restarted.length, 1)
      assert.equal(restarted[0]?.key, 'DH-12')
      assert.equal(restarted[0]?.previous, 'session-1')
      assert.equal(restarted[0]?.session, 'session-2')
      assert.equal(controller.sessions.length, 2)
    } finally {
      await harness.dispose()
    }
  })

  it('leaves a running executor alone during recovery', async () => {
    const { harness, main } = await mount({}, 'jira-worker')
    try {
      const controller = await provideController(harness)
      await call(harness, main, CLAIM_TOOL_NAME, { action: 'propose', key: 'DH-12', why: 'ready' })
      await approve(harness)
      await call(harness, main, CLAIM_TOOL_NAME, { action: 'claim', key: 'DH-12' })
      await call(harness, main, DISPATCH_TOOL_NAME, { key: 'DH-12' })
      controller.running.add('session-1')

      const recovered = await call(harness, main, DISPATCH_TOOL_NAME, { action: 'recover' })
      assert.equal(recovered.ok, true, JSON.stringify(recovered.error))
      assert.deepEqual(recovered.recovered, [])
      const left = recovered.left as { key: string; reason: string }[]
      assert.match(String(left[0]?.reason), /still runs/u)
      assert.equal(controller.sessions.length, 1)
    } finally {
      await harness.dispose()
    }
  })

  it('revives a lost executor from the turn-end pass, instead of proposing', async () => {
    const { harness, main } = await mount({}, 'jira-worker')
    try {
      const controller = await provideController(harness)
      await call(harness, main, CLAIM_TOOL_NAME, { action: 'propose', key: 'DH-12', why: 'ready' })
      await approve(harness)
      await call(harness, main, CLAIM_TOOL_NAME, { action: 'claim', key: 'DH-12' })
      await call(harness, main, DISPATCH_TOOL_NAME, { key: 'DH-12' })

      await runSuperagentPass(harness.host, main, undefined, 'jira-worker')
      assert.equal(controller.sessions.length, 2, 'the pass restarted the executor')
      assert.match(controller.prompts[1]?.text ?? '', /DH-12/u)
    } finally {
      await harness.dispose()
    }
  })

  it('starts the executor Session with the configured preset and hands it the issue', async () => {
    const { harness, main } = await mount({}, 'jira-worker')
    try {
      const controller = await provideController(harness)
      await call(harness, main, CLAIM_TOOL_NAME, { action: 'propose', key: 'DH-12', why: 'ready and small' })
      await approve(harness)
      await call(harness, main, CLAIM_TOOL_NAME, { action: 'claim', key: 'DH-12' })

      const dispatched = await call(harness, main, DISPATCH_TOOL_NAME, { key: 'DH-12', cwd: '/tmp/work' })
      assert.equal(dispatched.ok, true, JSON.stringify(dispatched.error))
      const dispatch = dispatched.dispatch as Record<string, unknown>
      assert.equal(dispatch.session, 'session-1')
      assert.deepEqual(controller.sessions[0]?.request, { cwd: '/tmp/work', agentPreset: 'jira-worker' })
      assert.match(controller.prompts[0]?.text ?? '', /DH-12/u)
      assert.match(controller.prompts[0]?.text ?? '', /issue_work/u)
    } finally {
      await harness.dispose()
    }
  })
})

describe('superagent: the GitHub source', () => {
  /** The projected options one direct runner call needs. */
  const runOptions = (harness: JiraHarness, agent: AgentHandle) => ({
    jira: harness.ctx.jira,
    caller: callerOf(harness.host, agent),
    at: '2026-10-15T12:00:00Z' as Timestamp,
  })

  it('refuses to poll while no repository is configured', async () => {
    const { harness, main } = await mount()
    try {
      const refused = await call(harness, main, SOURCE_TOOL_NAME, { action: 'poll' })
      assert.equal(refused.ok, false)
      assert.match(JSON.stringify(refused.error), /superagent_github_repo/u)
    } finally {
      await harness.dispose()
    }
  })

  it('imports unseen issues once, and skips the ones the ledger already has', async () => {
    const { harness, main } = await mount()
    try {
      const options = runOptions(harness, main)
      const me = identityOf(harness.host, main)
      const payload = JSON.stringify([
        { number: 7, title: 'crash on start', url: 'https://github.com/o/r/issues/7', author: { login: 'daiqc' } },
        { number: 8, title: 'slow query', url: 'https://github.com/o/r/issues/8', author: { login: 'daiqc' } },
      ])
      const runner = async (): Promise<string> => payload

      const first = await runSourceTool({ action: 'poll', project: 'DH' }, options, me, 'o/r', runner)
      assert.equal(first.ok, true, JSON.stringify(first.error))
      const created = first.created as { key: string; url: string }[]
      assert.equal(created.length, 2, JSON.stringify(first.skipped))
      assert.ok(created.some(row => row.url.endsWith('/issues/7')))

      const second = await runSourceTool({ action: 'poll', project: 'DH' }, options, me, 'o/r', runner)
      assert.equal(second.ok, true, JSON.stringify(second.error))
      assert.deepEqual(second.created, [])
      assert.equal((second.skipped as unknown[]).length, 2)
    } finally {
      await harness.dispose()
    }
  })

  it('reports a failed GitHub read instead of throwing', async () => {
    const { harness, main } = await mount()
    try {
      const options = runOptions(harness, main)
      const me = identityOf(harness.host, main)
      const runner = async (): Promise<string> => { throw new Error('gh: not logged in') }
      const failed = await runSourceTool({ action: 'poll' }, options, me, 'o/r', runner)
      assert.equal(failed.ok, false)
      assert.match(JSON.stringify(failed.error), /GitHub could not be read/u)
    } finally {
      await harness.dispose()
    }
  })
})

describe('superagent: the loop through the real composition', () => {
  it('scans the ledger and names the ready issue', async () => {
    const { harness, main } = await mount()
    try {
      const scanned = await call(harness, main, SCAN_TOOL_NAME, {})
      assert.equal(scanned.ok, true, JSON.stringify(scanned.error))
      const items = itemsOf(scanned)
      const candidate = items.find(item => item.key === 'DH-12')
      assert.ok(candidate !== undefined, JSON.stringify(items))
      assert.equal(candidate.ready, true)
      assert.equal(candidate.priority, 'S3')
    } finally {
      await harness.dispose()
    }
  })

  it('refuses to claim without a proposal', async () => {
    const { harness, main } = await mount()
    try {
      const refused = await call(harness, main, CLAIM_TOOL_NAME, { action: 'claim', key: 'DH-12' })
      assert.equal(refused.ok, false)
      assert.match(JSON.stringify(refused.error), /propose first/u)
    } finally {
      await harness.dispose()
    }
  })

  it('proposes without changing the state, then claims it', async () => {
    const { harness, main } = await mount()
    try {
      const proposed = await call(harness, main, CLAIM_TOOL_NAME, {
        action: 'propose',
        key: 'DH-12',
        why: 'it is the only ready issue and it is mine to take',
      })
      assert.equal(proposed.ok, true, JSON.stringify(proposed.error))
      assert.equal(issueOf(proposed).status, 'todo', 'a proposal changes no state')
      assert.ok(bodiesOf(proposed).some(body => body.startsWith(PROPOSAL_MARKER)))

      await approve(harness)
      const claimed = await call(harness, main, CLAIM_TOOL_NAME, { action: 'claim', key: 'DH-12' })
      assert.equal(claimed.ok, true, JSON.stringify(claimed.error))
      const claimedIssue = issueOf(claimed)
      assert.equal(claimedIssue.status, 'in_progress')
      assert.match(String(claimedIssue.assignee), /main-1$/u)
      const dispatch = claimed.dispatch as Record<string, unknown>
      assert.equal(dispatch.key, 'DH-12')
      assert.match(String(dispatch.instruction), /issue_work/u)
    } finally {
      await harness.dispose()
    }
  })

  it('proposes once from the turn-end pass, then stays quiet', async () => {
    const { harness, main } = await mount()
    try {
      await runSuperagentPass(harness.host, main)
      const first = await call(harness, main, TOOL_NAME, { action: 'get', key: 'DH-12' })
      const proposals = (): number => bodiesOf(first).filter(body => body.startsWith(PROPOSAL_MARKER)).length
      assert.equal(proposals(), 1, 'the pass proposes the ready issue without claiming it')

      await runSuperagentPass(harness.host, main)
      const second = await call(harness, main, TOOL_NAME, { action: 'get', key: 'DH-12' })
      assert.equal(bodiesOf(second).filter(body => body.startsWith(PROPOSAL_MARKER)).length, 1, 'the latest proposal suppresses another')
    } finally {
      await harness.dispose()
    }
  })

  it('reports readiness, proposals and what needs a person', async () => {
    const { harness, main } = await mount()
    try {
      const initial = await call(harness, main, STATUS_TOOL_NAME, {})
      assert.equal(initial.ok, true, JSON.stringify(initial.error))
      const initialCounts = initial.counts as Record<string, number>
      assert.ok((initialCounts.ready ?? 0) >= 1, JSON.stringify(initialCounts))
      assert.equal(initialCounts.proposed, 0)
      assert.equal((initial.needs_person as unknown[]).length, 0)

      await call(harness, main, CLAIM_TOOL_NAME, { action: 'propose', key: 'DH-12', why: 'status test' })
      const proposed = await call(harness, main, STATUS_TOOL_NAME, {})
      const counts = proposed.counts as Record<string, number>
      assert.equal(counts.proposed, 1)
      assert.ok((proposed.needs_person as { key: string; reason: string }[]).some(row => row.key === 'DH-12' && row.reason === 'confirm the proposal'))
    } finally {
      await harness.dispose()
    }
  })

  it('refuses a second claim: the first one spent the proposal', async () => {
    const { harness, main } = await mount()
    try {
      await call(harness, main, CLAIM_TOOL_NAME, { action: 'propose', key: 'DH-12', why: 'take it' })
      await approve(harness)
      await call(harness, main, CLAIM_TOOL_NAME, { action: 'claim', key: 'DH-12' })
      const again = await call(harness, main, CLAIM_TOOL_NAME, { action: 'claim', key: 'DH-12' })
      assert.equal(again.ok, false)
      assert.match(JSON.stringify(again.error), /in_progress/u)
    } finally {
      await harness.dispose()
    }
  })

  it('refuses to propose a blocked issue, and says what blocks it', async () => {
    const { harness, main } = await mount()
    try {
      const created = await call(harness, main, TOOL_NAME, {
        action: 'create',
        project: 'DH',
        data: { summary: 'blocked one' },
      })
      assert.equal(created.ok, true, JSON.stringify(created.error))
      const key = String(issueOf(created).key)
      const linked = await call(harness, main, TOOL_NAME, {
        action: 'link',
        key,
        link: { type: 'is_blocked_by', target: 'DH-12' },
      })
      assert.equal(linked.ok, true, JSON.stringify(linked.error))
      const refused = await call(harness, main, CLAIM_TOOL_NAME, { action: 'propose', key, why: 'looks easy' })
      assert.equal(refused.ok, false)
      assert.match(JSON.stringify(refused.error), /is_blocked_by/u)
    } finally {
      await harness.dispose()
    }
  })

  it('runs the whole loop: proposal, confirmation, claim, dispatch, delivery', async () => {
    const { harness, main } = await mount()
    try {
      await call(harness, main, CLAIM_TOOL_NAME, { action: 'propose', key: 'DH-12', why: 'ready and small' })
      await approve(harness)
      const claimed = await call(harness, main, CLAIM_TOOL_NAME, { action: 'claim', key: 'DH-12' })
      assert.equal(claimed.ok, true, JSON.stringify(claimed.error))

      // The executor the dispatcher spawns writes through its own narrow surface (DH-512)…
      const executor = await bindExecutor(harness, 'DH-12', 'session-1')
      const delivered = await call(harness, executor, WORK_TOOL_NAME, {
        action: 'deliver',
        key: 'DH-12',
        body: 'done: the change is in and the check passes',
      })
      assert.equal(delivered.ok, true, JSON.stringify(delivered.error))
      assert.equal(issueOf(delivered).status, 'in_review')

      // …and the ledger now shows the whole trail: proposal, claim, evidence.
      const read = await call(harness, main, TOOL_NAME, { action: 'get', key: 'DH-12' })
      const bodies = bodiesOf(read)
      assert.ok(bodies.some(body => body.startsWith(PROPOSAL_MARKER)), 'the proposal survives')
      assert.ok(bodies.some(body => body.startsWith('done:')), 'the evidence survives')
    } finally {
      await harness.dispose()
    }
  })
})

describe('superagent daemon: the session-less dispatcher', () => {
  /** The identity the daemon writes under. */
  const DAEMON = `agent:daemon|dsh|a1b2c3d4|${DAEMON_SESSION_ID}`

  /** The comments one issue carries, read back through the service. */
  const commentsOf = async (harness: JiraHarness): Promise<readonly { body: string; author: unknown }[]> => {
    const read = await harness.ctx.jira.readIssue('DH-12' as never)
    assert.equal(read.ok, true, read.ok ? '' : JSON.stringify(read.error))
    if (!read.ok) throw new Error('unreachable')
    return read.value.comments ?? []
  }

  it('derives a machine-scoped identity and refuses an empty machine id', () => {
    assert.equal(String(daemonIdentityOf('a1b2c3d4')), DAEMON)
    assert.equal(daemonIdentityOf(''), undefined)
  })

  it('is inert without a worker preset, a checkout or a session controller', async () => {
    const { harness } = await mount()
    try {
      await runDaemonPass(harness.host, { maxWorkers: 2, cwd: '/tmp/work', propose: true })
      await runDaemonPass(harness.host, { workerPreset: 'jira-worker', maxWorkers: 2, propose: true })
      // A controller is required even to propose: a proposal this deployment could not dispatch
      // would be a dead end.
      await runDaemonPass(harness.host, { workerPreset: 'jira-worker', maxWorkers: 2, cwd: '/tmp/work', propose: true })
      assert.deepEqual(await commentsOf(harness), [])
    } finally {
      await harness.dispose()
    }
  })

  it('proposes as the daemon identity without any session', async () => {
    const { harness } = await mount({}, 'jira-worker')
    try {
      const controller = await provideController(harness)
      await runDaemonPass(harness.host, { workerPreset: 'jira-worker', maxWorkers: 2, cwd: '/tmp/work', propose: true })

      const read = await harness.ctx.jira.readIssue('DH-12' as never)
      assert.equal(read.ok, true)
      if (!read.ok) throw new Error('unreachable')
      assert.equal(read.value.issue.status, 'todo')
      assert.equal(read.value.issue.assignee, undefined)
      const last = read.value.comments?.at(-1)
      assert.equal(String(last?.author), DAEMON)
      assert.match(last?.body ?? '', /^\[claim-proposal\]/u)
      // It proposed; it did not claim, dispatch, or mint a human credential.
      assert.equal(controller.sessions.length, 0)
      assert.equal(controller.prompts.length, 0)
      assert.equal((read.value.comments ?? []).filter(comment => comment.body.startsWith(CLAIM_APPROVED_MARKER)).length, 0)
    } finally {
      await harness.dispose()
    }
  })

  it('claims a confirmed own proposal and dispatches it into the configured checkout', async () => {
    const { harness } = await mount({}, 'jira-worker')
    try {
      const controller = await provideController(harness)
      await runDaemonPass(harness.host, { workerPreset: 'jira-worker', maxWorkers: 2, cwd: '/tmp/work', propose: true })
      await approve(harness)
      await runDaemonPass(harness.host, { workerPreset: 'jira-worker', maxWorkers: 2, cwd: '/tmp/work', propose: false })

      const read = await harness.ctx.jira.readIssue('DH-12' as never)
      assert.equal(read.ok, true)
      if (!read.ok) throw new Error('unreachable')
      assert.equal(read.value.issue.status, 'in_progress')
      assert.equal(String(read.value.issue.assignee), DAEMON)
      assert.equal(controller.sessions.length, 1)
      assert.deepEqual(controller.sessions[0]?.request, { cwd: '/tmp/work', agentPreset: 'jira-worker' })
      const records = (read.value.comments ?? []).map(comment => comment.body).filter(body => body.startsWith(DISPATCH_MARKER))
      assert.deepEqual(records, [`${DISPATCH_MARKER} session-1 starting`, `${DISPATCH_MARKER} session-1 started`])
      // The only human credential on the issue is the person's; the daemon never writes one.
      assert.equal((read.value.comments ?? []).filter(comment => comment.body.startsWith(CLAIM_APPROVED_MARKER)).length, 1)
    } finally {
      await harness.dispose()
    }
  })

  it('recovers a daemon executor whose Session is gone, and stays quiet while it holds work', async () => {
    const { harness } = await mount({}, 'jira-worker')
    try {
      const controller = await provideController(harness)
      await runDaemonPass(harness.host, { workerPreset: 'jira-worker', maxWorkers: 2, cwd: '/tmp/work', propose: true })
      await approve(harness)
      await runDaemonPass(harness.host, { workerPreset: 'jira-worker', maxWorkers: 2, cwd: '/tmp/work', propose: false })
      assert.equal(controller.sessions.length, 1)

      // The Session recorded by the dispatch is no longer running: the next pass revives it.
      await runDaemonPass(harness.host, { workerPreset: 'jira-worker', maxWorkers: 2, cwd: '/tmp/work', propose: false })
      assert.equal(controller.sessions.length, 2)
      assert.equal(controller.sessions[1]?.request.agentPreset, 'jira-worker')
      assert.equal(controller.sessions[1]?.request.cwd, '/tmp/work')

      // While the replacement runs, the pass leaves the issue alone and proposes nothing.
      controller.running.add('session-2')
      const before = (await commentsOf(harness)).length
      await runDaemonPass(harness.host, { workerPreset: 'jira-worker', maxWorkers: 2, cwd: '/tmp/work', propose: true })
      assert.equal((await commentsOf(harness)).length, before)
      assert.equal(controller.sessions.length, 2)
    } finally {
      await harness.dispose()
    }
  })
})
