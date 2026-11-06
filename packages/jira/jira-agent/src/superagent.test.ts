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
  MEMORY_CURATION_INSTRUCTION,
  activityOf,
  longRunningSummary,
  claimability,
  createJiraContribution,
  createSessionRecorder,
  createSuperagentContribution,
  daemonIdentityOf,
  deliverTaskReport,
  handleTaskTurnEnd,
  pendingDispatchForSession,
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
import { type DispatchLedgerTask, listDispatchTasks, recordDispatch, resolveDispatchTask } from './dispatch-ledger.ts'
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

/** Minimal controller with list/create/prompt for the routing and stop tests. */
class CompactController extends ModelSelectingController {
  items: { sessionId: string; running: boolean; cwd?: string; blank?: boolean; updatedAt?: number }[] = []
  prompted: { sessionId: string; text: string; mode?: string }[] = []
  compactCalls = 0
  async prompt(request: { sessionId: string; mode?: string; content: readonly { text: string }[] }) {
    this.prompted.push({ sessionId: String(request.sessionId), text: request.content[0]?.text ?? '', ...(request.mode === undefined ? {} : { mode: request.mode }) })
    return { accepted: true }
  }
  async list() { return { items: this.items } }
  async create() { return { sessionId: 'w-session' } }
  async resolveAgent(sessionId: string) { return { agent: { id: sessionId, session: {} } } }
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
    assert.equal((started.session as { workspaceTitle?: string }).workspaceTitle, 'hello')

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

    // Follow-up work never guesses the conversation: two candidates without `session` refuse.
    controller.items = [
      ...controller.items,
      { sessionId: 'w-newer', running: false, cwd: workspacePath, blank: false, updatedAt: 999 },
    ]
    const ambiguous = await runSessionTool(
      { action: 'append', workspace: 'hello', text: 'one more section' },
      options, me, ctx, { tasks },
    )
    assert.equal(ambiguous.ok, false, 'append with several candidates must name the Session')
    assert.match(JSON.stringify(ambiguous.error), /append needs `session`/u)
    const candidates = (ambiguous.error as { context?: { candidates?: { id: string }[] } }).context?.candidates
    assert.deepEqual(candidates?.map(row => row.id), ['w-newer', 'w-session'])

    const routed = await runSessionTool(
      { action: 'append', workspace: 'hello', text: 'one more section', session: 'latest' },
      options, me, ctx, { tasks },
    )
    assert.equal(routed.ok, true, JSON.stringify(routed.error))
    assert.equal(controller.prompted.at(-1)?.sessionId, 'w-newer')
    assert.equal(tasks.get('w-newer')?.superSession, 'super-1')
    const foreign = await runSessionTool(
      { action: 'append', workspace: 'hello', text: 'no', session: 'elsewhere' },
      options, me, ctx, { tasks },
    )
    assert.equal(foreign.ok, false)
    assert.match(JSON.stringify(foreign.error), /not a Session of/u)

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

describe('superagent: report recovery after a plugin remount', () => {
  interface RecoveryPrompt {
    readonly sessionId: string
    readonly text: string
  }

  const recoveryController = (root: string): {
    prompted: RecoveryPrompt[]
    create(): Promise<{ sessionId: string }>
    list(): Promise<{ items: readonly { sessionId: string; running: boolean; cwd: string; updatedAt: number }[] }>
    prompt(request: { sessionId: unknown; content: readonly { text: string }[] }): Promise<{ accepted: boolean }>
  } => {
    const prompted: RecoveryPrompt[] = []
    return {
      prompted,
      async create() { return { sessionId: 'unused' } },
      async list() {
        return { items: [{ sessionId: 'super-1', running: false, cwd: root, updatedAt: 1 }] }
      },
      async prompt(request) {
        prompted.push({ sessionId: String(request.sessionId), text: request.content[0]?.text ?? '' })
        return { accepted: true }
      },
    }
  }

  const recoveryHost = (controller: unknown, warnings: unknown[][] = []) => ({
    ctx: {
      get: (key: string) => key === 'sessionController' ? controller : undefined,
      logger: {
        warn: (...args: unknown[]) => { warnings.push(args) },
        info: () => {},
      },
    },
    env: {},
    clock: () => Date.parse(AT),
    recorder: createSessionRecorder(),
  })

  const completed = (id: string, text?: string) => {
    const events = text === undefined
      ? []
      : [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } }]
    const agent = { id, session: { snapshotEvents: () => events } }
    return {
      agent,
      session: agent.session,
      turn: 1,
      event: { data: { reason: { kind: 'completed' } } },
      signal: new AbortController().signal,
    }
  }

  it('recovers a pending ledger binding when the in-memory map is empty', async () => {
    const root = await scratchDirectory()
    const controller = recoveryController(root)
    const recorded = await recordDispatch(root, { id: 'w1', title: 'workspace', path: root }, {
      task: 'finish the task', dispatchedAt: AT, sessionId: 'child-1',
    })
    const warnings: unknown[][] = []
    const handled = await handleTaskTurnEnd(
      recoveryHost(controller, warnings) as never,
      completed('child-1', 'the work is complete') as never,
      new Map(),
      [],
      root,
    )

    assert.equal(handled, true)
    assert.match(controller.prompted[0]?.text ?? '', /\[task-report\] child-1/u)
    assert.match(controller.prompted[0]?.text ?? '', /the work is complete/u)
    const rows = await listDispatchTasks(root, { status: 'returned' })
    assert.equal(rows[0]?.id, recorded.task.id)
    assert.equal(rows[0]?.status, 'returned')
    assert.deepEqual(warnings, [])
  })

  it('does not revive a returned or failed task after the map is gone', async () => {
    const root = await scratchDirectory()
    const controller = recoveryController(root)
    const returned = await recordDispatch(root, { id: 'w1', title: 'workspace', path: root }, {
      task: 'already done', dispatchedAt: AT, sessionId: 'child-2',
    })
    await resolveDispatchTask(root, returned.task, { status: 'returned', updatedAt: AT, outcome: 'done' })
    const failed = await recordDispatch(root, { id: 'w1', title: 'workspace', path: root }, {
      task: 'already failed', dispatchedAt: AT, sessionId: 'child-2-failed',
    })
    await resolveDispatchTask(root, failed.task, { status: 'failed', updatedAt: AT, outcome: 'failed' })

    for (const sessionId of ['child-2', 'child-2-failed']) {
      const handled = await handleTaskTurnEnd(
        recoveryHost(controller) as never,
        completed(sessionId, 'a late duplicate') as never,
        new Map(),
        [],
        root,
      )
      assert.equal(handled, false)
    }
    assert.deepEqual(controller.prompted, [])
  })

  it('leaves a Session with no ledger binding alone', async () => {
    const root = await scratchDirectory()
    const controller = recoveryController(root)
    const handled = await handleTaskTurnEnd(
      recoveryHost(controller) as never,
      completed('ordinary-child', 'not dispatched') as never,
      new Map(),
      [],
      root,
    )

    assert.equal(handled, false)
    assert.deepEqual(controller.prompted, [])
  })

  it('sends a minimal report and warns when the completed turn has no assistant text', async () => {
    const root = await scratchDirectory()
    const controller = recoveryController(root)
    const warnings: unknown[][] = []
    const recorded = await recordDispatch(root, { id: 'w1', title: 'workspace', path: root }, {
      task: 'finished silently', dispatchedAt: AT, sessionId: 'child-3',
    })

    const handled = await handleTaskTurnEnd(
      recoveryHost(controller, warnings) as never,
      completed('child-3') as never,
      new Map(),
      [],
      root,
    )

    assert.equal(handled, true)
    assert.match(controller.prompted[0]?.text ?? '', /no assistant text/u)
    assert.match(controller.prompted[0]?.text ?? '', new RegExp(recorded.task.id, 'u'))
    assert.equal(warnings.length, 1)
    const rows = await listDispatchTasks(root, { status: 'returned' })
    assert.equal(rows[0]?.status, 'returned')
  })

  it('resolves the ledger and warns without throwing when delivery fails', async () => {
    const root = await scratchDirectory()
    const controller = recoveryController(root)
    controller.prompt = async () => { throw new Error('queue is closed') }
    const warnings: unknown[][] = []
    const recorded = await recordDispatch(root, { id: 'w1', title: 'workspace', path: root }, {
      task: 'delivery failure', dispatchedAt: AT, sessionId: 'child-4',
    })

    const handled = await handleTaskTurnEnd(
      recoveryHost(controller, warnings) as never,
      completed('child-4', 'the work is complete') as never,
      new Map(),
      [],
      root,
    )

    assert.equal(handled, true)
    assert.equal(warnings.length, 1)
    assert.match(String(warnings[0]?.[0] ?? ''), /could not be delivered/u)
    const rows = await listDispatchTasks(root, { status: 'returned' })
    assert.equal(rows[0]?.id, recorded.task.id)
    assert.equal(rows[0]?.status, 'returned')
  })

  it('finds the newest pending task for one Session', async () => {
    const root = await scratchDirectory()
    const first = await recordDispatch(root, { id: 'w1', title: 'workspace', path: root }, {
      task: 'older', dispatchedAt: '2026-10-15T11:00:00Z' as Timestamp, sessionId: 'shared-child',
    })
    const second = await recordDispatch(root, { id: 'w1', title: 'workspace', path: root }, {
      task: 'newer', dispatchedAt: AT, sessionId: 'shared-child',
    })

    assert.equal((await pendingDispatchForSession(root, 'shared-child'))?.id, second.task.id)
    assert.notEqual(first.task.id, second.task.id)
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
    assert.deepEqual(started.model, { provider: 'p', model: 'm', reasoningEffort: 'high', fallback: false })

    controller.list = async () => ({ items: [{ sessionId: 'model-child', running: false, cwd: workspacePath, blank: false }] })
    const followed = await runSessionTool(
      { action: 'append', workspace: 'model work', text: 'continue', provider: 'p2', model: 'm2', session: 'latest' },
      options, me, ctx, { tasks: new Map() },
    )
    assert.equal(followed.ok, true, JSON.stringify(followed.error))
    assert.deepEqual(controller.selections[1], { sessionId: 'model-child', provider: 'p2', model: 'm2' })
    assert.deepEqual(followed.model, { provider: 'p2', model: 'm2', fallback: false })
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

  it('renders effort id, name and default — never [object Object]', async () => {
    const llm = {
      listProviders: () => [{ id: 'p', name: 'Provider' }],
      async listModels() {
        return [{ id: 'm', name: 'Model', reasoning: {
          defaultEffort: 'medium',
          efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }],
        } }]
      },
      async resolveModelInfo() {
        return { id: 'm', name: 'Model', reasoning: {
          defaultEffort: 'medium',
          efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }],
        } }
      },
    }
    const ctx = { get: (key: string) => key === 'llm' ? llm : undefined }
    const options = { jira: {} as never, caller: { writable: true }, at: '2026-11-05T00:00:00Z' as never }
    const listed = await runModelsTool({ provider: 'p' }, options, { session: 's' }, ctx as never)
    const model = (listed.models as { efforts: readonly { id: string; name: string; default?: boolean }[] }[])[0]
    assert.deepEqual(model?.efforts, [
      { id: 'low', name: 'Low' },
      { id: 'medium', name: 'Medium', default: true },
      { id: 'high', name: 'High' },
    ])
    assert.equal(JSON.stringify(listed.models).includes('[object Object]'), false)
    const detail = await runModelsTool({ provider: 'p', model: 'm' }, options, { session: 's' }, ctx as never)
    assert.deepEqual((detail.models as { efforts: unknown[] }[])[0]?.efforts, [
      { id: 'low', name: 'Low' },
      { id: 'medium', name: 'Medium', default: true },
    ])
  })

  it('requires an explicit effort for a model that advertises them, and validates the value', async () => {
    const workspacePath = join(tmpdir(), 'effort-workspace')
    class Controller extends ModelSelectingController {
      async create() { return { sessionId: 'effort-child' } }
      async prompt() { return { accepted: true } }
      async list() { return { items: [{ sessionId: 'effort-child', running: false, cwd: workspacePath, blank: false }] } }
    }
    class Registry {
      rows = [{ id: 'w1', path: workspacePath, title: 'efforts', sessionIds: [], status: async () => 'ok' }]
      list() { return this.rows }
      async create(path: string, title?: string) { return { id: 'w2', path, title: title ?? path, sessionIds: [], status: async () => 'ok' } }
    }
    const llm = {
      listProviders: () => [{ id: 'p', name: 'Provider' }],
      async listModels() { return [] },
      async resolveModelInfo() {
        return { id: 'm', name: 'Model', reasoning: {
          defaultEffort: 'medium',
          efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }],
        } }
      },
    }
    const controller = new Controller()
    const ctx = {
      get: (key: string) => key === 'sessionController' ? controller
        : key === 'workspaceRegistry' ? new Registry()
          : key === 'llm' ? llm
            : undefined,
    }
    const options = {
      jira: {} as never,
      caller: { writable: true, sessionId: 'super-1', cwd: await scratchDirectory() } as never,
      at: '2026-11-05T00:00:00Z' as never,
    }
    const me = { session: 'super-1' }

    // Bare route on a reasoning model: refused, with the effort list — never the silent default.
    const bare = await runSessionTool(
      { action: 'start', workspace: 'efforts', task: 'plan', provider: 'p', model: 'm' },
      options, me, ctx, { tasks: new Map() },
    )
    assert.equal(bare.ok, false)
    assert.match(JSON.stringify(bare.error), /advertises reasoning efforts/u)
    const details = (bare.error as { context?: { availableEfforts?: string[] } }).context
    assert.deepEqual(details?.availableEfforts, ['low (Low)', 'medium (Medium), default', 'high (High)'])
    assert.equal(controller.selections.length, 0, 'a refused effort never reaches the host')

    // An unknown effort is refused with the same list.
    const unknown = await runSessionTool(
      { action: 'start', workspace: 'efforts', task: 'plan', provider: 'p', model: 'm', reasoning_effort: 'ultra' },
      options, me, ctx, { tasks: new Map() },
    )
    assert.equal(unknown.ok, false)
    assert.match(JSON.stringify(unknown.error), /not a reasoning effort/u)
    assert.equal(controller.selections.length, 0)

    // An explicit valid effort lands and is echoed.
    const chosen = await runSessionTool(
      { action: 'start', workspace: 'efforts', task: 'plan', provider: 'p', model: 'm', reasoning_effort: 'high' },
      options, me, ctx, { tasks: new Map() },
    )
    assert.equal(chosen.ok, true, JSON.stringify(chosen.error))
    assert.deepEqual(controller.selections[0], { sessionId: 'effort-child', provider: 'p', model: 'm', reasoningEffort: 'high' })
    assert.deepEqual(chosen.model, { provider: 'p', model: 'm', reasoningEffort: 'high', fallback: false })

    // The default effort only lands when the caller passes it explicitly.
    const defaulted = await runSessionTool(
      { action: 'prompt', session: 'effort-child', text: 'continue', provider: 'p', model: 'm', reasoning_effort: 'medium' },
      options, me, ctx, { tasks: new Map() },
    )
    assert.equal(defaulted.ok, true, JSON.stringify(defaulted.error))
    assert.deepEqual(controller.selections[1]?.reasoningEffort, 'medium')
  })

  it('lists each Session with title, model, effort, last task and last turn error', async () => {
    const workspacePath = join(tmpdir(), 'list-workspace')
    const options = {
      jira: {} as never,
      caller: { writable: true, sessionId: 'super-1' } as never,
      at: '2026-10-15T12:00:00Z' as never,
    }
    const me = { session: 'super-1' }
    const now = Date.now()
    const events = [
      { type: 'session/title', seq: 0, time: now - 100_000, data: { title: 'stop feature' } },
      { type: 'user/message', seq: 1, time: now - 90_000, data: { message: { content: [{ type: 'text', text: 'implement the real stop' }] } } },
      { type: 'turn/end', seq: 2, time: now - 80_000, data: { turn: 3, reason: { kind: 'error', error: { message: 'provider 400: orphan tool_call pwsh:223', code: 'INVALID_REQUEST', status: 400 } } } },
    ]
    const controller = new CompactController()
    controller.items = [{ sessionId: 'w-session', running: false, cwd: workspacePath, blank: false, updatedAt: now - 80_000 }]
    const ctx = {
      get: (key: string) => key === 'sessionController' ? controller
        : key === 'agents' ? {
          get: () => ({
            session: { header: { cwd: workspacePath }, snapshotEvents: () => events },
            model: { current: () => ({ provider: 'kimi-code-plan-cn', model: 'k3', reasoningEffort: 'high' }) },
          }),
        }
          : undefined,
    }
    const listed = await runSessionTool({ action: 'list' }, options, me, ctx, { tasks: new Map() })
    assert.equal(listed.ok, true, JSON.stringify(listed.error))
    const row = (listed.sessions as {
      title?: string
      model?: { provider: string; model: string; reasoningEffort?: string }
      lastTask?: string
      lastTurnError?: { kind?: string; code?: string; status?: number; turn?: number }
    }[])[0]
    assert.equal(row?.title, 'stop feature')
    assert.deepEqual(row?.model, { provider: 'kimi-code-plan-cn', model: 'k3', reasoningEffort: 'high' })
    assert.equal(row?.lastTask, 'implement the real stop')
    assert.deepEqual(row?.lastTurnError, {
      turn: 3,
      kind: 'error',
      message: 'provider 400: orphan tool_call pwsh:223',
      code: 'INVALID_REQUEST',
      status: 400,
    })
  })

  it('stop cuts a running turn off: nothing is admitted, the queue is cleared', async () => {
    const workspacePath = join(tmpdir(), 'stop-workspace')
    const options = {
      jira: {} as never,
      caller: { writable: true, sessionId: 'super-1' } as never,
      at: '2026-10-15T12:00:00Z' as never,
    }
    const me = { session: 'super-1' }
    const now = Date.now()
    const events = [
      { type: 'turn/start', seq: 1, time: now - 6 * 60_000, data: { turn: 7 } },
      { type: 'tool/call', seq: 2, time: now - 5 * 60_000, data: { turn: 7, step: 3, callId: 'c1', name: 'pwsh', arguments: '{}' } },
    ]
    let cancelled = 0
    let cancelOptions: unknown
    const controller = new CompactController()
    const agent = {
      session: { header: { cwd: workspacePath }, snapshotEvents: () => events },
      cancel: (_cause: unknown, options: unknown) => { cancelled += 1; cancelOptions = options },
      async whenIdle() {},
    }
    const ctx = {
      get: (key: string) => key === 'sessionController' ? controller
        : key === 'agents' ? { get: () => agent }
          : undefined,
    }
    const stopped = await runSessionTool({ action: 'stop', session: 'w-session' }, options, me, ctx, { tasks: new Map() })
    assert.equal(stopped.ok, true, JSON.stringify(stopped.error))
    const stop = stopped.stop as {
      accepted?: boolean
      wasRunning?: boolean
      cancelledVia?: string
      clearedQueue?: boolean
      idle?: boolean
      scene?: { status?: { inFlightTool?: string } }
      boundary?: { seq?: number }
    }
    assert.equal(stop.accepted, true)
    assert.equal(stop.wasRunning, true)
    assert.equal(stop.cancelledVia, 'agent')
    assert.equal(stop.clearedQueue, true)
    assert.equal(stop.idle, true)
    assert.equal(stop.scene?.status?.inFlightTool, 'pwsh')
    assert.equal(stop.boundary?.seq, 2)
    assert.equal(cancelled, 1)
    assert.deepEqual(cancelOptions, { keepInbox: false })
    assert.equal(controller.prompted.length, 0, 'stop admits no message and starts no turn')

    // An idle Session is reported, not cancelled.
    const idleAgent = { session: { header: { cwd: workspacePath }, snapshotEvents: () => [
      { type: 'turn/start', seq: 1, time: now - 100_000, data: { turn: 1 } },
      { type: 'turn/end', seq: 2, time: now - 90_000, data: { turn: 1, reason: { kind: 'completed' } } },
    ] } }
    const idleCtx = {
      get: (key: string) => key === 'sessionController' ? controller
        : key === 'agents' ? { get: () => idleAgent }
          : undefined,
    }
    const alreadyIdle = await runSessionTool({ action: 'stop', session: 'w-session' }, options, me, idleCtx, { tasks: new Map() })
    assert.equal(alreadyIdle.ok, true)
    assert.equal((alreadyIdle.stop as { alreadyIdle?: boolean }).alreadyIdle, true)
    assert.equal((alreadyIdle.stop as { accepted?: boolean }).accepted, false)

    // A host with no cancel channel says so plainly.
    const deafAgent = { session: { header: { cwd: workspacePath }, snapshotEvents: () => events } }
    const noCancel = new CompactController()
    delete (noCancel as { cancel?: unknown }).cancel
    const deafCtx = {
      get: (key: string) => key === 'sessionController' ? noCancel
        : key === 'agents' ? { get: () => deafAgent }
          : undefined,
    }
    const deaf = await runSessionTool({ action: 'stop', session: 'w-session' }, options, me, deafCtx, { tasks: new Map() })
    assert.equal(deaf.ok, false)
    assert.match(JSON.stringify(deaf.error), /no hard cancel channel/u)
  })

  it('reports a failed turn back to the initiator with reason, code and status', async () => {
    const workspacePath = join(tmpdir(), 'report-workspace')
    const controller = new CompactController()
    const host = {
      ctx: {
        get: (key: string) => key === 'sessionController' ? controller : undefined,
        logger: { warn: () => {} },
      },
      env: {},
      clock: () => Date.parse(AT),
      recorder: createSessionRecorder(),
    }
    const worker = {
      id: 'w-session',
      session: { snapshotEvents: () => [] },
    }
    const delivered = await deliverTaskReport(
      host as never,
      { superSession: 'super-1', workspace: workspacePath },
      worker,
      new AbortController().signal,
      { kind: 'error', error: { message: 'kimi responded 400: orphan tool_call pwsh:223', code: 'INVALID_REQUEST', status: 400 } },
    )
    assert.equal(delivered, true)
    const report = controller.prompted.at(-1)
    assert.equal(report?.sessionId, 'super-1')
    assert.match(report?.text ?? '', /\[task-report\] w-session .* FAILED — its turn ended "error" \(code INVALID_REQUEST, status 400\)/u)
    assert.match(report?.text ?? '', /orphan tool_call pwsh:223/u)

    const aborted = await deliverTaskReport(
      host as never,
      { superSession: 'super-1', workspace: workspacePath },
      worker,
      new AbortController().signal,
      { kind: 'aborted' },
    )
    assert.equal(aborted, true)
    assert.match(controller.prompted.at(-1)?.text ?? '', /ended "aborted"/u)

    // A completed turn without text is not silent: it sends a minimal report and warns.
    const quiet = await deliverTaskReport(
      host as never,
      { superSession: 'super-1', workspace: workspacePath },
      worker,
      new AbortController().signal,
      { kind: 'completed' },
    )
    assert.equal(quiet, true)
    assert.match(controller.prompted.at(-1)?.text ?? '', /no assistant text/u)
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

describe('superagent: context, compaction and memory curation', () => {
  const workspacePath = join(tmpdir(), 'compact-workspace')

  const compactController = (): CompactController => {
    const controller = new CompactController()
    controller.items = [{ sessionId: 'w-session', running: false, cwd: workspacePath, blank: false, updatedAt: 100 }]
    return controller
  }
  class CompactRegistry {
    rows = [{ id: 'w1', path: workspacePath, title: 'hello', sessionIds: [], status: async () => 'ok' }]
    list() { return this.rows }
    async create(path: string, title?: string) {
      return { id: 'w2', path, title: title ?? path, sessionIds: [], status: async () => 'ok' }
    }
  }
  const options = {
    jira: {} as never,
    caller: { writable: true, sessionId: 'super-1' } as never,
    at: '2026-10-15T12:00:00Z' as never,
  }
  const me = { session: 'super-1', identity: 'agent:test|dsh|m|super-1' }

  it('reports context usage and the compaction suggestion in list', async () => {
    const controller = compactController()
    const ctx = {
      get: (key: string) => key === 'sessionController' ? controller
        : key === 'agents' ? { get: (id: string) => id === 'w-session' ? { session: {} } : undefined }
          : key === 'tokenMeter' ? { contextPressure: () => ({ pressureTokens: 70_000, contextWindow: 200_000 }) }
            : undefined,
    }
    const listed = await runSessionTool({ action: 'list' }, options, me, ctx, { tasks: new Map(), compactThresholdPercent: 30 })
    assert.equal(listed.ok, true, JSON.stringify(listed.error))
    const row = (listed.sessions as { id: string; usage?: { percent?: number }; recommendCompact?: boolean }[])[0]
    assert.equal(row?.usage?.percent, 35)
    assert.equal(row?.recommendCompact, true)
    assert.equal(listed.compactThresholdPercent, 30)
  })

  it('compacts before admitting an append and reports both sides', async () => {
    const controller = compactController()
    const registry = new CompactRegistry()
    let calls = 0
    const compaction = { compactNow: async () => { controller.compactCalls += 1; return { shadowedTokenCount: 1200 } } }
    const ctx = {
      get: (key: string) => key === 'sessionController' ? controller
        : key === 'workspaceRegistry' ? registry
          : key === 'compaction' ? compaction
            : key === 'tokenMeter' ? { contextPressure: () => ({ pressureTokens: calls++ === 0 ? 70_000 : 10_000, contextWindow: 200_000 }) }
              : undefined,
    }
    const tasks = new Map<string, { superSession: string; workspace: string; usageBefore?: { percent?: number } }>()
    const result = await runSessionTool({ action: 'append', workspace: 'hello', text: 'next step', compact: true, session: 'latest' }, options, me, ctx, { tasks })
    assert.equal(result.ok, true, JSON.stringify(result.error))
    assert.equal(controller.compactCalls, 1)
    assert.equal(controller.prompted[0]?.text, 'next step')
    assert.equal((result.compaction as { before?: { percent?: number } }).before?.percent, 35)
    assert.equal((result.compaction as { after?: { percent?: number } }).after?.percent, 5)
    assert.equal(tasks.get('w-session')?.usageBefore?.percent, 35)
  })

  it('delivers a memory-curation instruction when asked', async () => {
    const controller = compactController()
    const registry = new CompactRegistry()
    const ctx = {
      get: (key: string) => key === 'sessionController' ? controller
        : key === 'workspaceRegistry' ? registry
          : undefined,
    }
    const result = await runSessionTool({ action: 'append', workspace: 'hello', text: 'next step', curate_memory: true, session: 'latest' }, options, me, ctx, { tasks: new Map() })
    assert.equal(result.ok, true, JSON.stringify(result.error))
    assert.equal(controller.prompted[0]?.text, MEMORY_CURATION_INSTRUCTION + 'next step')
  })

  it('refuses to compact a busy Session and sends nothing', async () => {
    const controller = compactController()
    const registry = new CompactRegistry()
    const compaction = {
      compactNow: async () => { throw Object.assign(new Error('the agent is not idle'), { name: 'ManualCompactionError', code: 'busy' }) },
    }
    const ctx = {
      get: (key: string) => key === 'sessionController' ? controller
        : key === 'workspaceRegistry' ? registry
          : key === 'compaction' ? compaction
            : undefined,
    }
    const result = await runSessionTool({ action: 'prompt', session: 'w-session', text: 'more', compact: true }, options, me, ctx, { tasks: new Map() })
    assert.equal(result.ok, false)
    assert.equal(controller.prompted.length, 0, 'a failed compaction never admits the task')
    assert.match(JSON.stringify(result.error), /not compacted/u)
    assert.match(JSON.stringify(result.error), /not idle/u)
  })

  it('compacts a Session through the compact action', async () => {
    const controller = compactController()
    let calls = 0
    const compaction = { compactNow: async () => { controller.compactCalls += 1; return { shadowedTokenCount: 800 } } }
    const ctx = {
      get: (key: string) => key === 'sessionController' ? controller
        : key === 'compaction' ? compaction
          : key === 'tokenMeter' ? { contextPressure: () => ({ pressureTokens: calls++ === 0 ? 70_000 : 10_000, contextWindow: 200_000 }) }
            : undefined,
    }
    const result = await runSessionTool({ action: 'compact', session: 'w-session' }, options, me, ctx, { tasks: new Map() })
    assert.equal(result.ok, true, JSON.stringify(result.error))
    assert.equal(controller.compactCalls, 1)
    assert.equal((result.compaction as { after?: { percent?: number } }).after?.percent, 5)
  })

  it('steers an interrupt into a running Session and reports where it landed', async () => {
    const controller = compactController()
    controller.items = [{ sessionId: 'w-run', running: true, cwd: workspacePath, blank: false, updatedAt: 100 }]
    const registry = new CompactRegistry()
    const ctx = {
      get: (key: string) => key === 'sessionController' ? controller
        : key === 'workspaceRegistry' ? registry
          : key === 'agents' ? { get: () => ({ session: { snapshotEvents: () => [{ type: 'user/message', seq: 42 }] } }) }
            : undefined,
    }
    const result = await runSessionTool({ action: 'append', workspace: 'hello', text: 'stop, use the other branch', delivery: 'interrupt', session: 'latest' }, options, me, ctx, { tasks: new Map() })
    assert.equal(result.ok, true, JSON.stringify(result.error))
    assert.equal(controller.prompted[0]?.mode, 'steer')
    const delivery = result.delivery as {
      requested?: string
      used?: string
      wasRunning?: boolean
      accepted?: boolean
      insertedAtSeq?: number
    }
    assert.equal(delivery.requested, 'interrupt')
    assert.equal(delivery.used, 'interrupt')
    assert.equal(delivery.wasRunning, true)
    assert.equal(delivery.accepted, true)
    assert.equal(delivery.insertedAtSeq, 42)
  })

  it('queues by default and falls back when interrupt meets an idle Session', async () => {
    const controller = compactController()
    const registry = new CompactRegistry()
    const ctx = {
      get: (key: string) => key === 'sessionController' ? controller
        : key === 'workspaceRegistry' ? registry
          : undefined,
    }
    const queued = await runSessionTool({ action: 'append', workspace: 'hello', text: 'new work', session: 'latest' }, options, me, ctx, { tasks: new Map() })
    assert.equal(queued.ok, true, JSON.stringify(queued.error))
    assert.equal(controller.prompted[0]?.mode, 'queue')
    assert.equal((queued.delivery as { used?: string }).used, 'queue')

    const fallback = await runSessionTool({ action: 'append', workspace: 'hello', text: 'urgent but idle', delivery: 'interrupt', session: 'latest' }, options, me, ctx, { tasks: new Map() })
    assert.equal(fallback.ok, true, JSON.stringify(fallback.error))
    assert.equal(controller.prompted[1]?.mode, 'queue')
    const delivery = fallback.delivery as { used?: string; fallback?: boolean }
    assert.equal(delivery.used, 'queue')
    assert.equal(delivery.fallback, true)
  })

  it('rejects interrupt on start and compact + interrupt on a running Session', async () => {
    const controller = compactController()
    controller.items = [{ sessionId: 'w-run', running: true, cwd: workspacePath, blank: false, updatedAt: 100 }]
    const registry = new CompactRegistry()
    const ctx = {
      get: (key: string) => key === 'sessionController' ? controller
        : key === 'workspaceRegistry' ? registry
          : key === 'compaction' ? { compactNow: async () => { controller.compactCalls += 1; return { shadowedTokenCount: 1 } } }
            : undefined,
    }
    const started = await runSessionTool({ action: 'start', workspace: 'hello', task: 'do it', delivery: 'interrupt' }, options, me, ctx, { tasks: new Map() })
    assert.equal(started.ok, false)
    const combined = await runSessionTool({ action: 'append', workspace: 'hello', text: 'urgent', delivery: 'interrupt', compact: true, session: 'latest' }, options, me, ctx, { tasks: new Map() })
    assert.equal(combined.ok, false)
    assert.match(JSON.stringify(combined.error), /cannot be combined with an interrupt/u)
    assert.equal(controller.prompted.length, 0)
    assert.equal(controller.compactCalls, 0)
  })

  it('reports live status and a long-running flag in list', async () => {
    const now = Date.now()
    const events = [
      { type: 'turn/start', seq: 1, time: now - 12 * 60_000, data: { turn: 1 } },
      { type: 'tool/call', seq: 2, time: now - 11 * 60_000, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' } },
      { type: 'assistant/message', seq: 3, time: now - 60_000, data: { message: { content: [{ type: 'text', text: 'still working' }] } } },
      { type: 'assistant/message', seq: 4, time: now - 30_000, data: { usage: { inputTokens: 1_000, cacheReadTokens: 9_000, outputTokens: 10, totalTokens: 10_010 } } },
      { type: 'assistant/message', seq: 5, time: now - 20_000, data: { usage: { inputTokens: 5_000, cacheReadTokens: 5_000, outputTokens: 10, totalTokens: 10_010 } } },
    ]
    const controller = compactController()
    const ctx = {
      get: (key: string) => key === 'sessionController' ? controller
        : key === 'agents' ? { get: () => ({ session: { header: { cwd: workspacePath }, snapshotEvents: () => events } }) }
          : undefined,
    }
    const listed = await runSessionTool({ action: 'list' }, options, me, ctx, { tasks: new Map(), longRunningMinutes: 10 })
    const row = (listed.sessions as {
      id: string
      running: boolean
      status?: { running?: boolean; elapsedMs?: number; inFlightTool?: string }
      longRunning?: boolean
    }[])[0]
    assert.equal(row?.status?.running, true)
    assert.ok((row?.status?.elapsedMs ?? 0) >= 12 * 60_000)
    assert.equal(row?.status?.inFlightTool, 'bash')
    assert.equal(row?.longRunning, true)
    // Weighted over the recent window, not the last (worst) request: (9000+5000)/(10000+10000) = 70.
    assert.equal((row as { cacheHitPercent?: number }).cacheHitPercent, 70)
    assert.equal(listed.longRunningMinutes, 10)
  })

  it('inspects a running Session and refuses an idle abort', async () => {
    const now = Date.now()
    const events = [
      { type: 'turn/start', seq: 1, time: now - 5 * 60_000, data: { turn: 1 } },
      { type: 'tool/call', seq: 2, time: now - 4 * 60_000, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' } },
      { type: 'tool/result', seq: 3, time: now - 3 * 60_000, data: { turn: 1, step: 1, message: { toolCallId: 'c1', content: [], isError: true }, error: { name: 'BashError', code: 'EXIT', reason: 'exit 1' } } },
    ]
    const controller = compactController()
    const agent = { session: { header: { cwd: workspacePath }, snapshotEvents: () => events } }
    const ctx = {
      get: (key: string) => key === 'sessionController' ? controller
        : key === 'agents' ? { get: () => agent }
          : undefined,
    }
    const inspected = await runSessionTool({ action: 'inspect', session: 'w-session' }, options, me, ctx, { tasks: new Map() })
    assert.equal(inspected.ok, true, JSON.stringify(inspected.error))
    assert.equal((inspected.status as { running?: boolean }).running, true)
    assert.equal((inspected.activity as unknown[]).length, 3)
    assert.equal((inspected.status as { lastError?: string }).lastError, 'exit 1')

    const idleAgent = { session: { header: { cwd: workspacePath }, snapshotEvents: () => [] } }
    const idleCtx = {
      get: (key: string) => key === 'sessionController' ? controller
        : key === 'agents' ? { get: () => idleAgent }
          : undefined,
    }
    const refused = await runSessionTool({ action: 'abort', session: 'w-session', text: 'retry' }, options, me, idleCtx, { tasks: new Map() })
    assert.equal(refused.ok, false)
    assert.match(JSON.stringify(refused.error), /idle/u)
  })

  it('aborts a running Session, reports the scene and continues it', async () => {
    const now = Date.now()
    const events = [
      { type: 'turn/start', seq: 1, time: now - 6 * 60_000, data: { turn: 1 } },
      { type: 'tool/call', seq: 2, time: now - 5 * 60_000, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' } },
      { type: 'assistant/message', seq: 3, time: now - 4 * 60_000, data: { message: { content: [{ type: 'text', text: 'stuck waiting' }] } } },
    ]
    let cancelled = 0
    let idleCalls = 0
    class AbortController extends CompactController {
      async cancel() { cancelled += 1; return { accepted: true } }
    }
    const controller = new AbortController()
    const agent = {
      session: { header: { cwd: workspacePath }, snapshotEvents: () => events },
      async whenIdle() { idleCalls += 1 },
    }
    const ctx = {
      get: (key: string) => key === 'sessionController' ? controller
        : key === 'agents' ? { get: () => agent }
          : undefined,
    }
    const result = await runSessionTool({ action: 'abort', session: 'w-session', text: 'skip the wait and continue' }, options, me, ctx, { tasks: new Map() })
    assert.equal(result.ok, true, JSON.stringify(result.error))
    assert.equal(cancelled, 1)
    assert.equal(idleCalls, 1)
    assert.equal(controller.prompted[0]?.text, 'skip the wait and continue')
    const abort = result.abort as { resumed?: boolean; scene?: { status?: { elapsedMs?: number }; activity?: unknown[] } }
    assert.equal(abort.resumed, true)
    assert.ok((abort.scene?.status?.elapsedMs ?? 0) >= 6 * 60_000)
    assert.equal((abort.scene?.activity as unknown[] | undefined)?.length, 3)
  })

  it('summarizes long-running Sessions for the super agent context', () => {
    const now = Date.now()
    const events = [
      { type: 'turn/start', seq: 1, time: now - 70 * 60_000, data: { turn: 1 } },
      { type: 'tool/call', seq: 2, time: now - 65 * 60_000, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' } },
    ]
    const agent = { id: 'slow-session', session: { header: { cwd: workspacePath }, snapshotEvents: () => events } }
    const ctx = { get: (key: string) => key === 'agents' ? { get: () => undefined, list: () => [agent] } : undefined }
    const text = longRunningSummary(ctx, '/super/home', 10 * 60_000, now)
    assert.match(text, /slow-session 70m/u)
    assert.match(text, /tool bash \(in flight\)/u)
    assert.equal(activityOf(agent, now)?.running, true)
    assert.equal(longRunningSummary({ get: () => ({ get: () => undefined, list: () => [] }) }, undefined, 10 * 60_000, now), '')
  })

  it('carries the context marker into the turn report', async () => {
    let report = ''
    const controller = {
      async prompt(request: { content: readonly { text: string }[] }) {
        report = request.content[0]?.text ?? ''
        return { accepted: true }
      },
      async create() { return { sessionId: 'unused' } },
      async list() { return { items: [] } },
    }
    const host = {
      ctx: {
        get: (key: string) => key === 'sessionController' ? controller
          : key === 'tokenMeter' ? { contextPressure: () => ({ pressureTokens: 10_000, contextWindow: 200_000 }) }
            : undefined,
      },
    }
    const agent = {
      id: 'w-session',
      session: {
        snapshotEvents: () => [{
          type: 'assistant/message',
          data: { message: { content: [{ type: 'text', text: 'done' }] } },
        }],
      },
    }
    const delivered = await deliverTaskReport(
      host as never,
      { superSession: 'super-1', workspace: workspacePath, usageBefore: { tokens: 70_000, window: 200_000, percent: 35 } },
      agent,
      new AbortController().signal,
    )
    assert.equal(delivered, true)
    assert.match(report, /context 35% → 5%/u)
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
      assert.deepEqual(contribution.promptSections?.(main).map(section => section.name), [])
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
