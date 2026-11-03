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
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { type Context } from '@deepseek-ai/cordis'
import { type Comment, type Identity, type Issue, type Timestamp, removeTree } from '@deepseek-ai/dsh-jira-core'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  CLAIM_APPROVED_MARKER,
  CLAIM_TOOL_NAME,
  DISPATCH_MARKER,
  DISPATCH_TOOL_NAME,
  PROPOSAL_MARKER,
  SCAN_TOOL_NAME,
  SOURCE_TOOL_NAME,
  STATUS_TOOL_NAME,
  TOOL_NAME,
  WORKSPACE_TOOL_NAME,
  WORK_TOOL_NAME,
  claimability,
  createJiraContribution,
  createSessionRecorder,
  createSuperagentContribution,
  isBlocked,
  jiraWorkerTools,
  openProposal,
  runSourceTool,
  runSuperagentPass,
} from './index.ts'
import * as jiraAgent from './index.ts'
import { callerOf, identityOf } from './tools.ts'
import { type JiraHarness, createLedgerFixture, dispatchTool, mountJira, testAgent } from './testing/host.ts'

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
}

/**
 * A stand-in for the host's workspace registry.
 *
 * The real one needs `storageDomain` and `sessionPersistence`; the claim loop only reads the
 * registry through `ctx.get` and calls `list`/`create`, so a plain class with exactly those two
 * methods is what proves the duck typing works.
 */
class FakeWorkspaceRegistry {
  readonly rows: FakeWorkspace[] = []

  list(): readonly FakeWorkspace[] {
    return this.rows
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
    }
    this.rows.push(created)
    return created
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
