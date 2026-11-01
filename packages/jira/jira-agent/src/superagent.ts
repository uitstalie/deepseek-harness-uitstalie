/**
 * plugin/superagent — the claim loop: find a ready issue, propose taking it, then take it.
 *
 * The two steps exist because a person has to say yes (DH-513, design §7). `propose` costs one
 * append-only comment and changes no state; `claim` runs only while the **latest** comment on the
 * issue is still this session's proposal. That is the whole gate: a proposal somebody answered, and
 * a proposal another session wrote, cannot become a claim — and the state change itself spends the
 * proposal, because the issue stops being `todo`.
 *
 * Both tools read and write through `ctx.jira`; nothing here reaches outside the store.
 *
 * @module @deepseek-ai/dsh-jira-agent/superagent
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CapabilityContribution, TurnEndInput } from '@deepseek-ai/dsh-dafeiyu'
import { mkdir } from 'node:fs/promises'
import { type Comment, type FieldSpec, type Identity, type Issue, type IssueKey, type Timestamp } from '@deepseek-ai/dsh-jira-core'
import { clampText, invalidInput, leaseIsActive, renderIssueHuman, validateArgs } from '@deepseek-ai/dsh-jira-core'
import { type RunOptions, type ToolValue, actorFor, asString, failure, nowUtc, okValue } from './envelope.ts'
import { type Spec, type ToolHost, callerOf, defineJiraTool, identityOf, runOptionsOf } from './tools.ts'

/** The capability id this provider registers with the organizer. */
export const SUPERAGENT_CAPABILITY_ID = 'superagent'

/** Display name in the organizer's capability list. */
export const SUPERAGENT_CAPABILITY_LABEL = 'Super agent'

/** One-sentence capability-list description. */
export const SUPERAGENT_CAPABILITY_DESCRIPTION = 'Takes a ready issue from the ledger once a person confirms'

/** The settings section the capability list links to. */
export const SUPERAGENT_SETTINGS_SECTION = 'superagent'

/** Where the super-agent section sorts. */
export const SUPERAGENT_SETTINGS_ORDER = 220

/** The only status an issue may be in to be proposed or claimed. */
export const CLAIMABLE_STATUS = 'todo'

/** The marker a proposal comment starts with, so a claim finds it without reading prose. */
export const PROPOSAL_MARKER = '[claim-proposal]'

/** The tool names the host registry refers to. */
export const SCAN_TOOL_NAME = 'superagent_scan'
export const CLAIM_TOOL_NAME = 'superagent_claim'
export const STATUS_TOOL_NAME = 'superagent_status'

/** How often the live-agent timer runs one pass; a daemon without sessions is deferred. */
export const SUPERAGENT_POLL_MS = 5 * 60_000

/** Whether an issue can be taken right now, and why not when it cannot. */
export type Claimability = Readonly<{
  ready: boolean
  reason?: string
}>

const READY: Claimability = Object.freeze({ ready: true })

/**
 * A refusal, phrased for whoever has to clear it.
 * @param reason - the concrete reason the issue cannot be taken.
 * @returns the frozen verdict.
 */
const NOT_READY = (reason: string): Claimability => Object.freeze({ ready: false, reason })

/**
 * Whether an `is_blocked_by` target of this issue keeps it closed (DH-513).
 *
 * A target that cannot be found counts as blocking: "I cannot tell" must not open the gate.
 * @param issue - the issue whose links are read.
 * @param byKey - every issue in the ledger, so a target can be resolved.
 * @param closed - the vocabulary's closed statuses.
 * @returns whether the issue is blocked.
 */
export const isBlocked = (issue: Issue, byKey: ReadonlyMap<string, Issue>, closed: readonly string[]): boolean =>
  issue.links.some((link) => {
    if (link.type !== 'is_blocked_by') return false
    const target = byKey.get(link.target)
    return target === undefined || !closed.includes(target.status)
  })

/**
 * Whether an issue may be proposed or claimed.
 *
 * Four facts decide it, in the order a person would ask them: is something still in the way, is it
 * still unstarted, is somebody else on it, and can it be claimed at all.
 * @param issue - the issue as the ledger stores it.
 * @param blocked - {@link isBlocked}'s verdict for this issue.
 * @param at - the current time, for the lease.
 * @returns the verdict with its reason.
 */
export const claimability = (issue: Issue, blocked: boolean, at: Timestamp): Claimability => {
  if (blocked) return NOT_READY('an `is_blocked_by` target is still open or missing')
  if (issue.status !== CLAIMABLE_STATUS) {
    return NOT_READY(`its status is '${issue.status}'; only '${CLAIMABLE_STATUS}' can be taken`)
  }
  if (leaseIsActive(issue, at)) {
    return NOT_READY(`it is claimed by ${String(issue.assignee)} until ${String(issue.leaseExpiresAt)}`)
  }
  return READY
}

/**
 * Whether this session holds an unspent proposal on the issue.
 *
 * The rule is deliberately narrow: the **latest** comment must be this session's proposal. A
 * proposal somebody replied to is spent, and a claim cannot reach past the conversation that
 * answered it.
 * @param comments - the issue's comments, oldest first.
 * @param by - the caller's identity.
 * @returns the verdict with its reason.
 */
export const openProposal = (comments: readonly Comment[], by: Identity | undefined): Claimability => {
  if (by === undefined) return NOT_READY('this session has no identity to propose under')
  const last = comments.at(-1)
  if (last === undefined) return NOT_READY(`no ${PROPOSAL_MARKER} comment on the issue; propose first`)
  if (last.author !== by) return NOT_READY(`the latest comment is ${String(last.author)}'s, not this session's`)
  if (!last.body.trimStart().startsWith(PROPOSAL_MARKER)) {
    return NOT_READY(`the latest comment is not a ${PROPOSAL_MARKER}; propose again`)
  }
  return READY
}

/** `superagent_scan`'s schema. */
export const SCAN_PARAMETERS: Readonly<Record<string, FieldSpec>> = Object.freeze({
  limit: { type: 'number', description: 'How many candidates to return; default 20.' },
})

/** `superagent_scan`'s description: what it answers, and that it writes nothing. */
export const SCAN_DESCRIPTION =
  'List the local dsh-jira ledger\'s issues that could be taken now, of any project, ready ones '
  + 'first and then by priority and recency. An entry with `ready: false` says why not. Read-only.'

/** `superagent_claim`'s schema. */
export const CLAIM_PARAMETERS: Readonly<Record<string, FieldSpec>> = Object.freeze({
  action: {
    type: 'string',
    required: true,
    description: 'propose: record that you would take the issue. claim: take it, after a person agreed.',
    enum: ['propose', 'claim'],
  },
  key: { type: 'string', required: true, description: 'The issue key, e.g. DH-12.' },
  why: { type: 'string', description: 'propose: why this issue, in one sentence. Required for propose.' },
  cwd: { type: 'string', description: 'claim: the checkout to dispatch the work into; defaults to this session\'s own.' },
})

/**
 * `superagent_claim`'s description.
 *
 * It names the two-step rule and the person's part, because neither is discoverable from a result:
 * proposing costs a comment, claiming needs their yes.
 */
export const CLAIM_DESCRIPTION =
  'Take one ready issue from the local dsh-jira ledger, in two steps so a person stays in charge. '
  + '`propose` appends a comment saying why this issue and changes nothing else. `claim` runs only '
  + 'when the latest comment on the issue is still that proposal; it assigns the issue to this '
  + 'session and moves it to in_progress. Ask the person between the two steps, and do not claim an '
  + 'issue they have not agreed to.'

/** The tool name for workspace selection. */
export const WORKSPACE_TOOL_NAME = 'superagent_workspace'

/**
 * The slice of the host's workspace registry this capability uses.
 *
 * Duck-typed on purpose (decision 108): the adapter imports no host package, so a deployment
 * without a workspace registry loses one tool instead of failing to mount.
 */
export interface WorkspaceLike {
  readonly id: string
  readonly path: string
  readonly title: string
  readonly sessionIds: readonly unknown[]
  status(): Promise<string>
}

/** The registry methods the workspace tool calls. */
export interface WorkspaceRegistryLike {
  list(): readonly WorkspaceLike[]
  create(path: string, title?: string): Promise<WorkspaceLike>
}

/**
 * Read the host's workspace registry, if this deployment has one.
 * @param ctx - the plugin context, duck-typed.
 * @returns the registry when it is present and has both methods.
 */
export const workspaceRegistryOf = (ctx: unknown): WorkspaceRegistryLike | undefined => {
  const get = (ctx as { get?: (key: string) => unknown } | undefined)?.get
  if (typeof get !== 'function') return undefined
  const service = get.call(ctx, 'workspaceRegistry') as Partial<WorkspaceRegistryLike> | undefined
  if (service === undefined || typeof service.list !== 'function' || typeof service.create !== 'function') {
    return undefined
  }
  return service as WorkspaceRegistryLike
}

/** `superagent_workspace`'s schema. */
export const WORKSPACE_PARAMETERS: Readonly<Record<string, FieldSpec>> = Object.freeze({
  action: {
    type: 'string',
    required: true,
    description: 'roster: list the registered workspaces. ensure: register a directory as one.',
    enum: ['roster', 'ensure'],
  },
  path: { type: 'string', description: 'ensure: the directory to own, created when missing. Required for ensure.' },
  title: { type: 'string', description: 'ensure: the display title for a newly registered workspace.' },
})

/**
 * `superagent_workspace`'s description.
 *
 * The `ensure` half writes outside the ledger, so it says what it will do to the filesystem and who
 * decides the path.
 */
export const WORKSPACE_DESCRIPTION =
  'Inspect or extend the host\'s workspace list, so a dispatch can name the checkout it works in. '
  + '`roster` lists each workspace with its path, status and session count. `ensure` registers a '
  + 'directory, creating it when it does not exist, and answers with the canonical path to dispatch '
  + 'into. Ask the person which directory before you register one.'

/** The envelope both tools advertise; `items`, `issue` and `dispatch` carry the payloads. */
export const SUPERAGENT_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    writable: { type: 'boolean' },
    items: { type: 'array' },
    workspaces: { type: 'array' },
    workspace: { type: 'object', additionalProperties: true },
    issue: { type: 'object', additionalProperties: true },
    dispatch: { type: 'object', additionalProperties: true },
    me: { type: 'object', additionalProperties: true },
    error: { type: 'object', additionalProperties: true },
    reason: { type: 'string' },
    rejected: { type: 'array' },
    message: { type: 'string' },
  },
  required: Object.freeze(['ok', 'writable', 'me']),
})

/** One candidate as the tool returns it. */
interface Candidate {
  key: string
  project: string
  priority: string
  summary: string
  updated: string
  ready: boolean
  reason?: string
}

/** Ready first, then priority (S1 before S5, which sorts lexicographically), then most recent. */
const candidateOrder = (left: Candidate, right: Candidate): number => {
  if (left.ready !== right.ready) return left.ready ? -1 : 1
  if (left.priority !== right.priority) return left.priority < right.priority ? -1 : 1
  return left.updated < right.updated ? 1 : -1
}

/**
 * The per-issue half of a dispatch; the executor's standing instructions are a prompt section
 * (`jira:executor`, DH-514), so they are paid for once instead of on every dispatch.
 * @param key - the claimed issue.
 * @returns the instruction text.
 */
export const dispatchInstruction = (key: string): string =>
  `Work on ${key} in this checkout. Read it first with jira_issue get, then report through issue_work.`

/** The ledger read both tools start from: every issue, plus the vocabulary's closed set. */
const readLedger = async (jira: RunOptions['jira']): Promise<Readonly<{
  byKey: ReadonlyMap<string, Issue>
  issues: readonly Issue[]
  closed: readonly string[]
} | undefined>> => {
  const snapshot = await jira.snapshot()
  if (!snapshot.ok) return undefined
  const byKey = new Map<string, Issue>(snapshot.value.issues.map(issue => [String(issue.key), issue]))
  return Object.freeze({
    byKey,
    issues: snapshot.value.issues,
    closed: snapshot.value.vocab?.closed ?? ['closed', 'cancelled'],
  })
}

/**
 * `superagent_scan`: read every candidate and say which could be taken.
 * @param args - the raw tool arguments, validated against `SCAN_PARAMETERS`.
 * @param options - the store, caller verdict and clock for this run.
 * @param me - the caller's identity tuple, returned in every result.
 * @returns the candidates with their verdicts.
 */
export const runScanTool = async (args: unknown, options: RunOptions, me: unknown): Promise<ToolValue> => {
  const { jira, caller } = options
  const validated = validateArgs(SCAN_PARAMETERS, args)
  if (!validated.ok) return failure(validated.error, caller, me)

  const ledger = await readLedger(jira)
  if (ledger === undefined) return failure(invalidInput('the ledger could not be read'), caller, me)

  const limit = typeof validated.value.limit === 'number' && validated.value.limit > 0
    ? Math.min(Math.floor(validated.value.limit), 100)
    : 20
  const candidates: Candidate[] = []
  for (const issue of ledger.issues) {
    const verdict = claimability(issue, isBlocked(issue, ledger.byKey, ledger.closed), options.at)
    // The ledger is the truth for readiness; a blocked or started issue is still worth naming when
    // it is the closest thing to ready, so only closed issues are dropped outright.
    if (ledger.closed.includes(issue.status)) continue
    candidates.push({
      key: String(issue.key),
      project: issue.project,
      priority: issue.priority,
      summary: issue.summary,
      updated: issue.updatedAt,
      ready: verdict.ready,
      ...(verdict.reason === undefined ? {} : { reason: verdict.reason }),
    })
  }
  candidates.sort(candidateOrder)
  const items = Object.freeze(candidates.slice(0, limit).map(candidate => Object.freeze(candidate)))
  return Object.freeze({
    ok: true,
    writable: caller.writable,
    ...(caller.reason === undefined ? {} : { reason: caller.reason }),
    me,
    items,
  })
}

/** `superagent_status`'s description: what needs a person right now. */
export const STATUS_DESCRIPTION =
  'Report the small set of facts a person needs about the claim loop: how many issues are ready, '
  + 'proposed, in progress, waiting for review, or blocked, and which proposed/review issues need a '
  + 'reply. Read-only; it changes no state.'

/**
 * `superagent_status`: what needs a person now, and what the loop is doing.
 * @param options - the service, caller verdict and clock for this run.
 * @param me - the caller's identity tuple, returned in every result.
 * @returns counts plus the issues that need attention.
 */
export const runStatusTool = async (options: RunOptions, me: unknown): Promise<ToolValue> => {
  const { jira, caller } = options
  const ledger = await readLedger(jira)
  if (ledger === undefined) return failure(invalidInput('the ledger could not be read'), caller, me)

  const ready: Record<string, unknown>[] = []
  const inProgress: Record<string, unknown>[] = []
  const inReview: Record<string, unknown>[] = []
  const blocked: Record<string, unknown>[] = []
  const proposed: Record<string, unknown>[] = []
  let proposedCount = 0

  const open = ledger.issues.filter(issue => !ledger.closed.includes(issue.status))
  const comments = await Promise.all(open.map(async (issue) => {
    const read = await jira.readIssue(issue.key)
    return read.ok ? read.value.comments ?? [] : []
  }))

  for (const [index, issue] of open.entries()) {
    const isBlockedNow = isBlocked(issue, ledger.byKey, ledger.closed)
    const verdict = claimability(issue, isBlockedNow, options.at)
    const row = {
      key: String(issue.key),
      priority: issue.priority,
      summary: issue.summary,
      ...(issue.assignee === undefined ? {} : { assignee: String(issue.assignee) }),
    }
    if (verdict.ready) ready.push(row)
    if (issue.status === 'in_progress') inProgress.push(row)
    if (issue.status === 'in_review') inReview.push(row)
    if (isBlockedNow) blocked.push(row)
    const latest = comments[index]?.at(-1)
    if (latest !== undefined && latest.body.trimStart().startsWith(PROPOSAL_MARKER)) {
      proposedCount += 1
      proposed.push({ ...row, author: String(latest.author) })
    }
  }

  const needsPerson = [
    ...proposed.map(row => ({ ...row, reason: 'confirm the proposal' })),
    ...inReview.map(row => ({ ...row, reason: 'review the delivery' })),
  ]
  return Object.freeze({
    ok: true,
    writable: caller.writable,
    ...(caller.reason === undefined ? {} : { reason: caller.reason }),
    me,
    counts: Object.freeze({
      ready: ready.length,
      proposed: proposedCount,
      inProgress: inProgress.length,
      inReview: inReview.length,
      blocked: blocked.length,
    }),
    ready: Object.freeze(ready),
    proposed: Object.freeze(proposed),
    inProgress: Object.freeze(inProgress),
    inReview: Object.freeze(inReview),
    blocked: Object.freeze(blocked),
    needsPerson: Object.freeze(needsPerson),
  })
}

/**
 * `superagent_claim`: propose, or claim the issue the proposal named.
 * @param args - the raw tool arguments, validated against `CLAIM_PARAMETERS`.
 * @param options - the store, caller verdict and clock for this run.
 * @param me - the caller's identity tuple, returned in every result.
 * @returns the proposal, or the claimed issue with its dispatch facts.
 */
export const runClaimTool = async (args: unknown, options: RunOptions, me: unknown): Promise<ToolValue> => {
  const { jira, caller } = options
  const validated = validateArgs(CLAIM_PARAMETERS, args)
  if (!validated.ok) return failure(validated.error, caller, me)
  if (!caller.writable) {
    return failure(invalidInput('taking an issue needs a session that may write the ledger'), caller, me)
  }
  const action = String(validated.value.action)
  const key = asString(validated.value.key) ?? ''
  const cwd = asString(validated.value.cwd) ?? caller.cwd

  const ledger = await readLedger(jira)
  if (ledger === undefined) return failure(invalidInput('the ledger could not be read'), caller, me)
  const issue = ledger.byKey.get(key)
  if (issue === undefined) return failure(invalidInput(`${key} is not in the ledger`, { key }), caller, me)
  const verdict = claimability(issue, isBlocked(issue, ledger.byKey, ledger.closed), options.at)
  if (!verdict.ready) return failure(invalidInput(`${key} cannot be taken: ${String(verdict.reason)}`, { key }), caller, me)

  const actor = { by: actorFor(options, caller), at: options.at }
  const issueKey = key as IssueKey
  if (action === 'propose') {
    const why = asString(validated.value.why)
    if (why === undefined || why.trim() === '') {
      return failure(invalidInput('propose needs `why`: one sentence on why this issue'), caller, me)
    }
    const proposed = await jira.mutateIssue(issueKey, {
      action: 'comment',
      body: `${PROPOSAL_MARKER} ${why.trim()}`,
    }, actor, {})
    if (!proposed.ok) return failure(proposed.error, caller, me)
    return okValue(caller, me, proposed.value.transaction.change.issue, proposed.value.comments, [], 'write')
  }

  const read = await jira.readIssue(issueKey)
  if (!read.ok) return failure(read.error, caller, me)
  const proposal = openProposal(read.value.comments ?? [], caller.identity)
  if (!proposal.ready) {
    return failure(invalidInput(`${key} cannot be claimed yet: ${String(proposal.reason)}`, { key }), caller, me)
  }
  const assigned = await jira.mutateIssue(issueKey, { action: 'assignee', value: 'self' }, actor, {})
  if (!assigned.ok) return failure(assigned.error, caller, me)
  const started = await jira.mutateIssue(issueKey, { action: 'switch_state', to: 'in_progress' }, actor, {})
  if (!started.ok) return failure(started.error, caller, me)
  return Object.freeze({
    ...okValue(caller, me, started.value.transaction.change.issue, started.value.comments, [], 'write'),
    dispatch: Object.freeze({
      key,
      ...(cwd === undefined ? {} : { cwd }),
      instruction: dispatchInstruction(key),
    }),
  })
}

/**
 * One turn-end pass: propose the first ready issue, once.
 *
 * The pass never claims — a person still confirms — and it stays quiet when this session already
 * has work in progress or when the latest comment is already a proposal. That keeps the default
 * behavior "observe": one proposal costs one comment, and a reply spends it.
 * @param host - the plugin host the caller identity comes from.
 * @param agent - the root agent whose turn just ended.
 * @param signal - cancellation owned by the turn that triggered the pass.
 * @returns a promise that settles after the proposal attempt.
 */
export const runSuperagentPass = async (host: ToolHost, agent: unknown, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted === true) return
  const caller = callerOf(host, agent)
  if (!caller.writable || caller.identity === undefined || caller.sessionId === undefined) return
  try {
    const active = await host.ctx.jira.list({ status: 'in_progress', assignee: String(caller.identity) })
    if (active.ok && active.value.items.length > 0) return

    const call = { jira: host.ctx.jira, caller, me: identityOf(host, agent) }
    const options = runOptionsOf(host, call)
    const scanned = await runScanTool({ limit: 10 }, options, call.me)
    if (!scanned.ok) return
    const items = Array.isArray(scanned.items) ? scanned.items as unknown as Candidate[] : []
    const ready = items.find(item => item.ready)
    if (ready === undefined) return

    const read = await host.ctx.jira.readIssue(ready.key as IssueKey)
    if (!read.ok) return
    const last = (read.value.comments ?? []).at(-1)
    if (last !== undefined && last.body.trimStart().startsWith(PROPOSAL_MARKER)) return

    await runClaimTool({
      action: 'propose',
      key: ready.key,
      why: 'turn-end pass: it is ready, unclaimed, and not blocked',
    }, options, call.me)
  } catch {
    // A background pass must never turn a completed turn into a failed one.
  }
}

/** One text block, clamped to the model's budget. */
const renderText = (text: string): ContentBlock[] => [{ type: 'text', text: clampText(text) }]

/**
 * `superagent_workspace`: list the registered workspaces, or register one.
 * @param args - the raw tool arguments, validated against `WORKSPACE_PARAMETERS`.
 * @param options - the store, caller verdict and clock for this run.
 * @param me - the caller's identity tuple, returned in every result.
 * @param ctx - the plugin context the workspace registry is read from.
 * @returns the roster, or the registered workspace with the path to dispatch into.
 */
export const runWorkspaceTool = async (
  args: unknown,
  options: RunOptions,
  me: unknown,
  ctx: ToolHost['ctx'],
): Promise<ToolValue> => {
  const { caller } = options
  const validated = validateArgs(WORKSPACE_PARAMETERS, args)
  if (!validated.ok) return failure(validated.error, caller, me)
  const registry = workspaceRegistryOf(ctx)
  if (registry === undefined) {
    return failure(invalidInput('this deployment has no workspace registry, so there is no checkout to dispatch into'), caller, me)
  }
  const action = String(validated.value.action)
  const verdict = Object.freeze({
    ok: true,
    writable: caller.writable,
    ...(caller.reason === undefined ? {} : { reason: caller.reason }),
    me,
  })
  if (action === 'roster') {
    const workspaces = await Promise.all(registry.list().map(async workspace => Object.freeze({
      id: String(workspace.id),
      path: workspace.path,
      title: workspace.title,
      status: await workspace.status(),
      sessions: workspace.sessionIds.length,
    })))
    return Object.freeze({ ...verdict, workspaces: Object.freeze(workspaces) })
  }

  if (!caller.writable) {
    return failure(invalidInput('registering a workspace needs a session that may write'), caller, me)
  }
  const path = asString(validated.value.path)
  if (path === undefined || path.trim() === '') return failure(invalidInput('ensure needs `path`'), caller, me)
  try {
    // `create` owns an existing directory, so the tool creates it first; both halves are idempotent.
    await mkdir(path, { recursive: true })
    const workspace = await registry.create(path, asString(validated.value.title))
    return Object.freeze({
      ...verdict,
      workspace: Object.freeze({
        id: String(workspace.id),
        // The canonical path, not the argument: that is what a dispatched session's cwd must be.
        path: workspace.path,
        title: workspace.title,
        status: await workspace.status(),
      }),
    })
  } catch (error: unknown) {
    return failure(invalidInput(`${path} could not be registered as a workspace: ${error instanceof Error ? error.message : String(error)}`, { path }), caller, me)
  }
}

/**
 * Build the three tool definitions the capability contributes.
 *
 * The schemas, the runners and the descriptions live here; this function only turns them into the
 * registry's shape, so each tool declares its timeout and concurrency class in one place.
 * @param host - the plugin host the call context is resolved from.
 * @returns the capability contribution the organizer wires onto root agents.
 */
export const createSuperagentContribution = (host: ToolHost): CapabilityContribution => {
  const liveAgents = new Set<Agent>()
  let timer: ReturnType<typeof setInterval> | undefined
  let polling = false
  const poll = async (): Promise<void> => {
    if (polling) return
    polling = true
    try {
      for (const agent of liveAgents) {
        if (!callerOf(host, agent).writable) continue
        await runSuperagentPass(host, agent)
        return
      }
    } finally {
      polling = false
    }
  }
  timer = setInterval(() => { void poll() }, SUPERAGENT_POLL_MS)
  timer.unref?.()

  const scan: Spec = {
    name: SCAN_TOOL_NAME,
    description: SCAN_DESCRIPTION,
    parameters: SCAN_PARAMETERS,
    outputSchema: SUPERAGENT_OUTPUT_SCHEMA,
    timeoutMs: 5_000,
    isConcurrencySafe: () => true,
    render: (typed) => {
      const items = Array.isArray(typed.items) ? typed.items as Candidate[] : []
      if (items.length === 0) return renderText('no issue is open')
      return renderText(items
        .map(item => `${item.key}  ${item.priority}  ${item.ready ? 'ready' : `no (${item.reason ?? 'not ready'})`}  ${item.summary}`)
        .join('\n'))
    },
    run: (args, call) => runScanTool(args, runOptionsOf(host, call), call.me),
  }
  const status: Spec = {
    name: STATUS_TOOL_NAME,
    description: STATUS_DESCRIPTION,
    parameters: Object.freeze({}),
    outputSchema: SUPERAGENT_OUTPUT_SCHEMA,
    timeoutMs: 5_000,
    isConcurrencySafe: () => true,
    render: (typed) => {
      const counts = typed.counts as Record<string, number> | undefined
      if (counts === undefined) return renderText('ok')
      return renderText([
        `ready ${String(counts.ready)} · proposed ${String(counts.proposed)} · in progress ${String(counts.inProgress)} · in review ${String(counts.inReview)} · blocked ${String(counts.blocked)}`,
        ...(Array.isArray(typed.needsPerson)
          ? (typed.needsPerson as { key: string; reason: string }[]).map(row => `${row.key}  needs you: ${row.reason}`)
          : []),
      ].join('\n'))
    },
    run: (_args, call) => runStatusTool(runOptionsOf(host, call), call.me),
  }
  const claim: Spec = {
    name: CLAIM_TOOL_NAME,
    description: CLAIM_DESCRIPTION,
    parameters: CLAIM_PARAMETERS,
    outputSchema: SUPERAGENT_OUTPUT_SCHEMA,
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    render: (typed) => {
      const issue = typed.issue as Partial<Issue> | undefined
      return renderText(issue === undefined || issue.key === undefined
        ? 'ok'
        : renderIssueHuman(issue as Issue, [], nowUtc(host.clock)).replace(/\n$/u, ''))
    },
    run: (args, call) => runClaimTool(args, runOptionsOf(host, call), call.me),
  }
  const workspace: Spec = {
    name: WORKSPACE_TOOL_NAME,
    description: WORKSPACE_DESCRIPTION,
    parameters: WORKSPACE_PARAMETERS,
    outputSchema: SUPERAGENT_OUTPUT_SCHEMA,
    timeoutMs: 30_000,
    // `ensure` touches the filesystem, so the conservative default applies to both verbs.
    isConcurrencySafe: () => false,
    render: (typed) => {
      if (Array.isArray(typed.workspaces)) {
        const rows = typed.workspaces as { id: string; path: string; title: string; status: string; sessions: number }[]
        if (rows.length === 0) return renderText('no workspace is registered')
        return renderText(rows
          .map(row => `${row.title}  ${row.path}  ${row.status}  ${String(row.sessions)} session(s)`)
          .join('\n'))
      }
      const registered = typed.workspace as { path?: string; title?: string } | undefined
      return renderText(registered?.path === undefined
        ? 'ok'
        : `${String(registered.title)}  ${String(registered.path)}`)
    },
    run: (args, call) => runWorkspaceTool(args, runOptionsOf(host, call), call.me, host.ctx),
  }
  return Object.freeze({
    scope: 'root',
    tools: () => Object.freeze([
      defineJiraTool(host, scan),
      defineJiraTool(host, claim),
      defineJiraTool(host, workspace),
      defineJiraTool(host, status),
    ]),
    onAgentCreated: (agent: Agent) => {
      liveAgents.add(agent)
      agent.ctx.effect(() => () => { liveAgents.delete(agent) }, 'superagent: forget a disposed agent')
    },
    onTurnEnd: async (input: TurnEndInput) => {
      await runSuperagentPass(host, input.agent, input.signal)
    },
    dispose: () => {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
      liveAgents.clear()
    },
  })
}
