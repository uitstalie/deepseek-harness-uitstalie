/**
 * Tests for `issue_work`, the executor's narrow surface (DH-512).
 *
 * Two layers are checked separately. `workAccess` is a pure function, so its truth table is
 * asserted directly. Everything else runs through the real composition — the shipped tool
 * registry, the dafeiyu organizer and a real store on disk — because the claim the tool depends on
 * is a fact about files, not about the session.
 *
 * The harness mounts every agent on the root context, so a child's registrations share the root's
 * tool table. That table is therefore **not** what keeps `jira_issue` away from an executor; the
 * scope check and the write guard are, and those are what these tests assert.
 */

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

import { type Identity, type IssueKey, removeTree } from '@deepseek-ai/dsh-jira-core'
import { SessionId } from '@deepseek-ai/dsh-session'
import { type Caller } from './caller.ts'
import { DISPATCH_MARKER, TOOL_NAME, WORK_TOOL_NAME, jiraWorkerTools, workAccess } from './index.ts'
import * as jiraAgent from './index.ts'
import { type JiraHarness, createLedgerFixture, dispatchTool, mountJira, testAgent } from './testing/host.ts'

/** An agent handle the harness built, so the helpers can name the shape once. */
type AgentHandle = ReturnType<typeof testAgent>

/** Ledgers created by this file, removed once the run settles. */
const throwaway: string[] = []

after(async () => {
  for (const dir of throwaway.splice(0)) await removeTree(dir)
})

/** A fresh ledger: the tests write to it, so none of them may share one. */
const fixture = async (): Promise<string> => {
  const dir = await createLedgerFixture()
  throwaway.push(dir)
  return dir
}

/** Let activation and dispatch continuations run. */
const settle = async (): Promise<void> => {
  await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
}

/** One mounted composition with a main agent and one executor dispatched by it. */
interface Wired {
  readonly harness: JiraHarness
  readonly main: AgentHandle
  readonly worker: AgentHandle
}

/**
 * Mount the plugin and wire a root agent plus one delegated child of it.
 *
 * The child's tool is registered directly: every agent in this harness shares the root context, so
 * wiring a second one through `agent/created` would contend for the ledger's tool names. The
 * per-agent split itself is asserted against the contribution in `superagent.test.ts`.
 * @param dir - the ledger root to mount.
 * @param options - process facts and the capability gate.
 * @returns the harness and the two handles.
 */
const wire = async (dir: string, options: Parameters<typeof mountJira>[1] = {}): Promise<Wired> => {
  const harness = await mountJira(dir, options)
  await harness.ctx.plugin(jiraAgent, { superagent_worker_preset: 'jira-worker' })
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

/** Dispatch one call and return the envelope it settled. */
const call = async (
  harness: JiraHarness,
  agent: AgentHandle,
  name: string,
  args: unknown,
): Promise<Record<string, unknown>> => {
  const result = await dispatchTool(harness, agent, name, args, `${name}-${String(Math.random()).slice(2)}`)
  const value = result.value
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value), `expected an envelope for ${name}`)
  return value
}

/** Claim one issue as the main agent, which is what opens the executor's write window. */
const claim = async (harness: JiraHarness, main: AgentHandle, key = 'DH-12'): Promise<void> => {
  const assigned = await call(harness, main, TOOL_NAME, { action: 'assignee', key, assignee: 'self' })
  assert.equal(assigned.ok, true, JSON.stringify(assigned.error))
  const moved = await call(harness, main, TOOL_NAME, { action: 'switch_state', key, to: 'in_progress' })
  assert.equal(moved.ok, true, JSON.stringify(moved.error))
}

/** Bind a Session the way `superagent_dispatch` does: the record precedes the executor's first write. */
const recordDispatch = async (harness: JiraHarness, main: AgentHandle, key = 'DH-12', session = 'worker-1'): Promise<void> => {
  const written = await call(harness, main, TOOL_NAME, {
    action: 'comment',
    key,
    comment: { body: `${DISPATCH_MARKER} ${session} started` },
  })
  assert.equal(written.ok, true, JSON.stringify(written.error))
}

/** The issue an envelope returned. */
const issueOf = (envelope: Record<string, unknown>): Record<string, unknown> => {
  const issue = envelope.issue
  assert.ok(typeof issue === 'object' && issue !== null, 'envelope must carry the issue')
  return issue as Record<string, unknown>
}

/** The bodies of the comments an envelope returned, oldest first. */
const commentBodies = (envelope: Record<string, unknown>): string[] => {
  const comments = envelope.comments
  if (!Array.isArray(comments)) return []
  return comments.map((comment) => {
    const body = (comment as { body?: unknown }).body
    return typeof body === 'string' ? body : ''
  })
}

/** A caller verdict for the pure scope tests: a delegated child of `main-1`. */
const callerOf = (
  overrides: Partial<Omit<Caller, 'parentSessionId'>> & { readonly parentSessionId?: string | undefined } = {},
): Caller => {
  const { parentSessionId, ...rest } = overrides
  // An explicit `undefined` must mean "no dispatcher", so the default only applies when the key
  // is absent — a destructuring default would silently turn the root-session case back into a child.
  const parent = 'parentSessionId' in overrides ? parentSessionId : 'main-1'
  return Object.freeze({
    writable: false,
    reason: 'subagent',
    sessionId: 'worker-1',
    identity: 'agent:deepseek-flash|dsh|a1b2c3d4|worker-1' as Identity,
    ...rest,
    ...(parent === undefined ? {} : { parentSessionId: parent }),
  })
}

/** The issue facts the pure scope tests vary, with the claim this caller's dispatcher placed. */
interface IssueFacts {
  readonly key: IssueKey
  readonly status: string
  readonly assignee?: Identity | undefined
}

/** An issue-shaped value for the pure scope tests: claimed by this caller's dispatcher. */
const issueOfPure = (overrides: Partial<IssueFacts> = {}): IssueFacts => ({
  key: 'DH-12' as IssueKey,
  status: 'in_progress',
  assignee: 'agent:deepseek-flash|dsh|a1b2c3d4|main-1' as Identity,
  ...overrides,
})

void describe('issue_work: the scope check', () => {
  void it('accepts the issue dispatched to this session and left in progress', () => {
    assert.deepEqual(workAccess(issueOfPure(), callerOf(), 'worker-1'), { allowed: true })
  })

  void it('refuses every other shape, and says which one', () => {
    const cases: readonly (readonly [string, unknown])[] = [
      ['a read-only deployment', workAccess(issueOfPure(), callerOf({ reason: 'dsh-read-only' }), 'worker-1')],
      ['a session that was never dispatched', workAccess(issueOfPure(), callerOf(), undefined)],
      ['another session\'s dispatch', workAccess(issueOfPure(), callerOf(), 'worker-2')],
      ['a review already handed back', workAccess(issueOfPure({ status: 'in_review' }), callerOf(), 'worker-1')],
      ['a closed issue', workAccess(issueOfPure({ status: 'closed' }), callerOf(), 'worker-1')],
    ]
    for (const [what, raw] of cases) {
      const verdict = raw as { allowed: boolean; reason?: string }
      assert.equal(verdict.allowed, false, what)
      assert.notEqual(verdict.reason, '', what)
    }
  })

  void it('binds by the dispatch record, not by the assignee', () => {
    const verdict = workAccess(issueOfPure({ assignee: 'human:daiqc' as Identity }), callerOf(), 'worker-1')
    assert.deepEqual(verdict, { allowed: true })
  })
})

void describe('issue_work: through the real composition', () => {
  void it('lets the dispatched executor report progress on the claimed issue', async () => {
    const { harness, main, worker } = await wire(await fixture())
    try {
      await claim(harness, main)
      await recordDispatch(harness, main)
      const reported = await call(harness, worker, WORK_TOOL_NAME, { action: 'progress', key: 'DH-12', body: 'wired the thing up' })
      assert.equal(reported.ok, true, JSON.stringify(reported.error))
      assert.equal(reported.writable, true)
      assert.equal(issueOf(reported).status, 'in_progress')
      assert.ok(commentBodies(reported).includes('wired the thing up'), JSON.stringify(reported.comments))
    } finally {
      await harness.dispose()
    }
  })

  void it('hands the issue back for review, and then closes the write window', async () => {
    const { harness, main, worker } = await wire(await fixture())
    try {
      await claim(harness, main)
      await recordDispatch(harness, main)
      const delivered = await call(harness, worker, WORK_TOOL_NAME, {
        action: 'deliver',
        key: 'DH-12',
        body: 'done: `pnpm test` passes, see the branch',
      })
      assert.equal(delivered.ok, true, JSON.stringify(delivered.error))
      assert.equal(issueOf(delivered).status, 'in_review')
      // Decision 193's composition: the transition and its evidence land together, so the reviewer
      // never sees one without the other.
      assert.ok(commentBodies(delivered).some(body => body.startsWith('done:')), JSON.stringify(delivered.comments))

      const again = await call(harness, worker, WORK_TOOL_NAME, { action: 'progress', key: 'DH-12', body: 'still here' })
      assert.equal(again.ok, false)
      assert.equal(again.writable, false)
      assert.match(String(again.reason), /in_review/u)
    } finally {
      await harness.dispose()
    }
  })

  void it('records what a blocked report waits for, and leaves the status alone', async () => {
    const { harness, main, worker } = await wire(await fixture())
    try {
      await claim(harness, main)
      await recordDispatch(harness, main)
      const blocked = await call(harness, worker, WORK_TOOL_NAME, {
        action: 'blocked',
        key: 'DH-12',
        waiting_for: 'person',
        reason: 'the design question is yours to answer',
      })
      assert.equal(blocked.ok, true, JSON.stringify(blocked.error))
      // Blocking is a fact, not a state: the vocabulary has no `blocked`, and this tool adds none.
      assert.equal(issueOf(blocked).status, 'in_progress')
      const marker = commentBodies(blocked).find(body => body.includes('[blocked:'))
      assert.equal(marker, '[blocked:person] the design question is yours to answer')
    } finally {
      await harness.dispose()
    }
  })

  void it('refuses an issue dispatched to a different session', async () => {
    const { harness, main } = await wire(await fixture())
    try {
      await claim(harness, main)
      await recordDispatch(harness, main)
      const stranger = testAgent(harness.ctx, 'worker-2', {
        origin: 'subagent',
        delegationDepth: 1,
        parentSession: SessionId('main-2'),
      })
      const refused = await call(harness, stranger, WORK_TOOL_NAME, { action: 'progress', key: 'DH-12', body: 'mine now' })
      assert.equal(refused.ok, false)
      assert.equal(refused.writable, false)
      assert.match(String(refused.reason), /dispatched to session 'worker-1'/u)
    } finally {
      await harness.dispose()
    }
  })

  void it('refuses a root session that was not the dispatched executor', async () => {
    const { harness, main } = await wire(await fixture())
    try {
      await claim(harness, main)
      await recordDispatch(harness, main)
      const refused = await call(harness, main, WORK_TOOL_NAME, { action: 'progress', key: 'DH-12', body: 'talking to myself' })
      assert.equal(refused.ok, false)
      assert.match(String(refused.reason), /dispatched to session 'worker-1'/u)
    } finally {
      await harness.dispose()
    }
  })

  void it('refuses an issue nobody dispatched', async () => {
    const { harness, worker } = await wire(await fixture())
    try {
      const refused = await call(harness, worker, WORK_TOOL_NAME, { action: 'progress', key: 'DH-12', body: 'uninvited' })
      assert.equal(refused.ok, false)
      assert.match(String(refused.reason), /never dispatched/u)
    } finally {
      await harness.dispose()
    }
  })

  void it('keeps `jira_issue` refused for a delegated child', async () => {
    const { harness, main, worker } = await wire(await fixture())
    try {
      await claim(harness, main)
      await recordDispatch(harness, main)
      const result = await dispatchTool(harness, worker, TOOL_NAME, { action: 'update', key: 'DH-12', data: { summary: 'nope' } }, 'guard-worker')
      assert.equal(result.isError, true)
      assert.match(result.content.find(block => block.type === 'text')?.text ?? '', /may not write \(subagent\)/u)
    } finally {
      await harness.dispose()
    }
  })

  void it('keeps `jira_issue` refused for an executor Session that joined the worker preset', async () => {
    const { harness, main } = await wire(await fixture())
    try {
      await claim(harness, main)
      const executor = testAgent(harness.ctx, 'exec-1', { agentPreset: 'jira-worker' })
      const result = await dispatchTool(harness, executor, TOOL_NAME, { action: 'update', key: 'DH-12', data: { summary: 'nope' } }, 'guard-executor')
      assert.equal(result.isError, true)
      assert.match(result.content.find(block => block.type === 'text')?.text ?? '', /may not write \(executor\)/u)
    } finally {
      await harness.dispose()
    }
  })
})
