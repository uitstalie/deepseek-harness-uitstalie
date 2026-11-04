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
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'
import { mkdir } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { type Comment, type FieldSpec, type Identity, type Issue, type IssueKey, type Timestamp } from '@deepseek-ai/dsh-jira-core'
import { clampText, asIdentity, invalidInput, leaseIsActive, renderIssueHuman, validateArgs } from '@deepseek-ai/dsh-jira-core'
import { SUMMARY_MAX_CHARS } from '@deepseek-ai/dsh-jira-core'
import { type GhRunner, type GithubItem, pollGithub } from './github.ts'
import { dispatchBody, dispatchRecordOf } from './dispatch.ts'
import { type RunOptions, type ToolValue, actorFor, asString, failure, nowUtc, okValue } from './envelope.ts'
import { callerCwd, isExecutorSession, isSubagent, type Caller } from './caller.ts'
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

/** The marker a person's confirmation comment starts with (DH-513 review): the credential a claim consumes. */
export const CLAIM_APPROVED_MARKER = '[claim-approved]'

/** The tool names the host registry refers to. */
export const SCAN_TOOL_NAME = 'superagent_scan'
/** The name of the claim tool: propose an issue, or take the one a proposal named. */
export const CLAIM_TOOL_NAME = 'superagent_claim'
/** The name of the status tool: what is ready, what is proposed, and what waits on a person. */
export const STATUS_TOOL_NAME = 'superagent_status'

/** How often the live-agent timer runs one pass; the session-less pass shares it (DH-714). */
export const SUPERAGENT_POLL_MS = 5 * 60_000

/** The synthetic session id the session-less dispatcher writes under. */
export const DAEMON_SESSION_ID = 'superagent-daemon'

/** The workspace title the super home is registered under, once, when the capability mounts. */
export const SUPERAGENT_WORKSPACE_TITLE = 'Super agent'

/** The prompt section only the session living in the super workspace reads. */
export const SUPERAGENT_SECTION_NAME = 'superagent:dispatcher'

/** One order after the executor's standing instructions: the same harness, the dispatcher's job. */
export const SUPERAGENT_SECTION_ORDER = 702

/**
 * The super agent's standing instructions.
 *
 * Static on purpose, like the executor's: the role belongs to the workspace, so a session opened
 * there pays for this text once and keeps the prefix cached. The dispatch itself is the host's own
 * `subagent` tool with `cwd` — this section only says when to use it and what to report back.
 */
export const SUPERAGENT_SECTION: PromptSection = Object.freeze({
  name: SUPERAGENT_SECTION_NAME,
  order: SUPERAGENT_SECTION_ORDER,
  text: 'You are the super agent: the one conversation a person has with this harness. You do not '
    + 'do the work yourself — you start a Session in the workspace that owns the work, and report what came back.\n'
    + '\n'
    + '- Find or create the workspace with `superagent_workspace`: `roster` lists every registered '
    + 'directory, `ensure` registers one. Ask the person which directory before `ensure` creates it.\n'
    + '- Follow-up work belongs in the workspace\'s existing conversation: use `superagent_session` '
    + 'action `append` with the workspace and the instruction. It continues that workspace\'s most '
    + 'recent Session and its report comes back here.\n'
    + '- Open a NEW Session (action `start`) only when the person asks for one or the workspace has '
    + 'none. Do not mirror one workspace\'s work into a second Session: two Sessions editing the same '
    + 'files is the conflict you must avoid.\n'
    + '- When the Session you need is already running, append to it — the instruction queues — instead '
    + 'of starting a parallel Session. If the person wants an isolated task, say so and start one.\n'
    + '- Continue a Session the person names with action `prompt` (use `list` to resolve which Session '
    + 'they mean), branch it with `fork`, and hide it with `archive`.\n'
    + '- Every report arrives here as a message in a new turn. After handing over work, end your turn '
    + 'instead of holding the conversation open; the person stays free to talk to you.\n'
    + '- Use `subagent` only for quick research that belongs to no workspace; a real Session is what '
    + 'the person can see, continue, archive and branch.\n'
    + '- Treat a report as evidence: when it names a blocker (a missing tool, a permission failure, a '
    + 'failed check), pass that fact on in one line instead of summarizing it away.\n'
    + '- When the report arrives, answer the person in one short message: what was sent where, the outcome, '
    + 'and any decision they owe you. Do not paste the whole report.\n'
    + '- Read the ledger when it helps, but do not claim or dispatch ledger issues from here; this '
    + 'workspace dispatches work, it does not run the claim loop.',
})

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
 * Whether this session holds an unspent proposal a person has confirmed.
 *
 * A proposal alone is not enough (DH-513 review): the confirmation is a **human-authored**
 * `[claim-approved]` comment that is the latest comment on the issue. The person writes it through
 * a human surface (the `jira` CLI's `comment` verb), so the model cannot mint the credential for
 * itself; the state change a claim makes then spends it, because the issue leaves `todo`.
 * @param comments - the issue's comments, oldest first.
 * @param by - the caller's identity.
 * @returns the verdict with its reason.
 */
export const openProposal = (comments: readonly Comment[], by: Identity | undefined): Claimability => {
  if (by === undefined) return NOT_READY('this session has no identity to propose under')
  let proposalIndex = -1
  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const candidate = comments[index]
    if (candidate === undefined) continue
    if (candidate.author === by && candidate.body.trimStart().startsWith(PROPOSAL_MARKER)) {
      proposalIndex = index
      break
    }
  }
  if (proposalIndex < 0) return NOT_READY(`no ${PROPOSAL_MARKER} comment on the issue; propose first`)
  const last = comments.at(-1)
  if (last === undefined || last.author === by) {
    return NOT_READY('the latest comment is still this session\'s proposal; ask a person to confirm with '
      + `a ${CLAIM_APPROVED_MARKER} comment`)
  }
  if (!last.body.trimStart().startsWith(CLAIM_APPROVED_MARKER)) {
    return NOT_READY(`the latest comment is not a ${CLAIM_APPROVED_MARKER} confirmation; ask a person first`)
  }
  if (!last.author.startsWith('human:')) {
    return NOT_READY(`the confirmation is authored by ${String(last.author)}, not a person; `
      + 'only a human comment is a credential')
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
 * proposing costs a comment, and claiming consumes a **human** confirmation comment.
 */
export const CLAIM_DESCRIPTION =
  'Take one ready issue from the local dsh-jira ledger, in two steps so a person stays in charge. '
  + '`propose` appends a comment saying why this issue and changes nothing else. `claim` runs only '
  + 'after the issue\'s latest comment is a person\'s confirmation (a `human:`-authored '
  + '`[claim-approved] ...` comment, written from the jira panel\'s Confirm button or the jira '
  + 'CLI\'s comment verb); it then assigns the '
  + 'issue to this session and moves it to in_progress. Ask the person to confirm between the two '
  + 'steps, and do not claim an issue they have not confirmed.'

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
  /**
   * Move one workspace within the durable display order. Optional: a host without ordering still
   * gets a registered super workspace, just not a pinned one.
   */
  insertBefore?(id: string, beforeId?: string): Promise<readonly string[]>
  /** Hide one Session from every grouping surface; optional because a host may not compose it. */
  archiveSession?(sessionId: string, options?: { readonly stopActivity?: boolean }): Promise<void>
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

/**
 * Compare two checkout paths the way the filesystem does.
 *
 * The workspace registry stores canonical paths (`fs.realpath`), while a session may name the same
 * directory through a symlink, a junction, or different case on Windows. Canonicalizing both sides
 * is what keeps "this session lives in the super workspace" a fact rather than a string guess; a
 * path that does not exist yet falls back to the lexical form, which is still exact.
 * @param left - one absolute path.
 * @param right - the other absolute path.
 * @returns whether both name the same directory.
 */
export const sameCheckout = (left: string, right: string): boolean => {
  const canonical = (value: string): string => {
    try {
      return realpathSync(value)
    } catch {
      return resolve(value)
    }
  }
  const a = canonical(left)
  const b = canonical(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * Whether this agent is the super agent: the session living in the configured super workspace.
 *
 * The role is the workspace, not a preset (DH-716): a person opens a conversation in the super
 * workspace and that conversation dispatches. A subagent dispatched *from* there runs in the target
 * checkout, so it never matches, which is what keeps workers out of the dispatcher's section.
 * @param agent - the agent being wired or calling, read duck-typed.
 * @param homePath - the configured super workspace path, when the deployment has one.
 * @returns whether this agent works from the super workspace.
 */
export const isSuperAgentSession = (agent: unknown, homePath: string | undefined): boolean => {
  if (homePath === undefined || homePath.trim() === '') return false
  // A delegated child that happens to start in the super home is still a worker, not the dispatcher.
  if (isSubagent(agent)) return false
  const cwd = callerCwd(agent)
  return cwd !== undefined && sameCheckout(cwd, homePath)
}

/**
 * Why one configured super home cannot be used, if it cannot.
 *
 * The super agent owns its checkout with a write-capable sandbox, so the location is a person's
 * decision, never a default: it must be absolute, it must not be a filesystem root, and it must not
 * live under the harness home — `.dsh` holds settings, sessions and memory, and a workspace there
 * would let the agent rewrite the harness that governs it.
 * @param path - the configured `superagent_home`.
 * @param dshHome - the resolved harness home that the path must stay out of.
 * @returns a sentence naming the rule, or undefined when the path is usable.
 */
export const superagentHomeProblem = (path: string, dshHome: string): string | undefined => {
  const value = path.trim()
  if (value === '') return 'set superagent_home to an absolute directory the super agent should own'
  if (!isAbsolute(value)) return `superagent_home must be an absolute path, got ${value}`
  const resolved = resolve(value)
  if (dirname(resolved) === resolved) return `superagent_home cannot be a filesystem root (${resolved})`
  const home = resolve(dshHome)
  const candidate = relative(home, resolved)
  if (candidate === '' || (!candidate.startsWith('..') && !isAbsolute(candidate))) {
    return `superagent_home cannot live under the harness home (${home}); choose a directory you own outside it`
  }
  return undefined
}

/**
 * Register the super workspace once, creating its directory when that is what is missing.
 *
 * `workspaceRegistry.create` owns an existing directory, so the directory comes first; repeat calls
 * are the registry's own idempotency (same canonical path, same row) rather than a second state.
 * The row is then pinned to the front of the display order, so the one workspace a person talks to
 * is not buried among project checkouts.
 * @param registry - the host's workspace registry, read through the duck-typed slice above.
 * @param path - the directory the super agent lives in, as configured.
 * @param dshHome - the harness home the path must stay out of.
 * @returns the registered workspace.
 * @throws Error naming the rule when the configured path is unsafe or not absolute.
 */
export const ensureSuperWorkspace = async (
  registry: WorkspaceRegistryLike,
  path: string,
  dshHome: string,
): Promise<WorkspaceLike> => {
  const problem = superagentHomeProblem(path, dshHome)
  if (problem !== undefined) throw new Error(problem)
  await mkdir(path, { recursive: true })
  const workspace = await registry.create(path, SUPERAGENT_WORKSPACE_TITLE)
  await pinWorkspaceFirst(registry, workspace)
  return workspace
}

/**
 * Move the super workspace to the front of the durable display order.
 *
 * Idempotent by construction: when it is already first the registry returns the same order. A host
 * without `insertBefore` keeps its own ordering and simply misses the pin.
 * @param registry - the host's workspace registry.
 * @param workspace - the registered super workspace.
 */
export const pinWorkspaceFirst = async (
  registry: WorkspaceRegistryLike,
  workspace: WorkspaceLike,
): Promise<void> => {
  if (registry.insertBefore === undefined) return
  const first = registry.list().find(row => row.id !== workspace.id)
  if (first === undefined) return
  await registry.insertBefore(workspace.id, first.id)
}

/**
 * Force the super agent onto a fixed permission preset.
 *
 * The super agent owns a checkout, so its sandbox must stay the workspace-write bundle: a session
 * that opened with a looser (or custom) bundle would otherwise be able to write outside that
 * checkout. The host's preset service is duck-typed (decision 108), so a deployment without one
 * keeps its own defaults instead of failing to mount.
 * @param ctx - the plugin context, duck-typed.
 * @param agent - the agent being wired.
 * @param homePath - the configured super workspace path.
 * @param preset - the preset name to select; unset or blank leaves the host default.
 * @returns whether a preset was written.
 * @throws Error when the host refuses the preset name.
 */
export const enforceSuperAgentPermission = (
  ctx: unknown,
  agent: unknown,
  homePath: string | undefined,
  preset: string | undefined,
): boolean => {
  if (preset === undefined || preset.trim() === '') return false
  if (!isSuperAgentSession(agent, homePath)) return false
  const service = (ctx as { get?: (key: string) => unknown } | undefined)?.get?.('permissionPresets') as
    | { set?: (session: unknown, name: string) => void }
    | undefined
  if (service === undefined || typeof service.set !== 'function') return false
  service.set((agent as { session: unknown }).session, preset)
  return true
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

/** The tool a super agent uses to run and steer real workspace Sessions (DH-719). */
export const SESSION_TOOL_NAME = 'superagent_session'

/** `superagent_session`'s schema. */
export const SESSION_PARAMETERS: Readonly<Record<string, FieldSpec>> = Object.freeze({
  action: {
    type: 'string',
    required: true,
    description: 'append: continue the workspace\'s most recent Session with more work (the default '
      + 'for follow-up work in a workspace). start: open a NEW Session, only when the person asks for '
      + 'one or the workspace has none. prompt: append to a Session the caller named. list: show one '
      + 'workspace\'s Sessions. archive: hide one Session. fork: branch one Session.',
    enum: ['append', 'start', 'prompt', 'list', 'archive', 'fork'],
  },
  workspace: { type: 'string', description: 'append/start/list: the workspace path or title; prompt/archive/fork use it for the report headline.' },
  task: { type: 'string', description: 'start: the self-contained task for that workspace agent.' },
  session: { type: 'string', description: 'prompt/archive/fork: the Session id.' },
  text: { type: 'string', description: 'append/prompt: the follow-up instruction.' },
  atSeq: { type: 'number', description: 'fork: branch from this event seq; default the latest completed turn.' },
})

/** `superagent_session`'s description: what the verbs do and where the report goes. */
export const SESSION_DESCRIPTION =
  'Run work inside a registered workspace as a real Session of its own. Follow-up work belongs in the '
  + 'workspace\'s existing conversation: `append` continues its most recent Session (the default), and '
  + '`prompt` continues one the person named — use `list` to resolve a name. `start` opens a NEW '
  + 'Session and is only for a task the person wants isolated; that agent decides whether to spawn '
  + 'subagents or do the work itself. Every Session this super agent addresses reports its turn end '
  + 'back here as a message. `archive` hides one Session, `fork` branches one.'

/** One Session a super agent started or addressed, so its report can be routed back. */
export interface TaskSessionRecord {
  /** The super agent Session that receives the report. */
  readonly superSession: string
  /** The workspace the Session works in, for the report headline. */
  readonly workspace: string
}

/** What one superagent_session call needs beyond the shared run options. */
export interface SessionToolContext {
  /** The configured preset a started Session joins; unset keeps the deployment default. */
  readonly agentPreset?: string
  /** Sessions this super agent addressed, so their turn ends report back to it. */
  readonly tasks: Map<string, TaskSessionRecord>
}

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
    sessions: { type: 'array' },
    session: { type: 'object', additionalProperties: true },
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
 *
 * The classification belongs to the service (`superagentStatus`), so the panel and the model
 * cannot disagree about what counts as ready, proposed or blocked. This tool is the model's way
 * in, not a second implementation of the rules.
 * @param options - the service, caller verdict and clock for this run.
 * @param me - the caller's identity tuple, returned in every result.
 * @returns counts plus the rows that need a person.
 */
export const runStatusTool = async (options: RunOptions, me: unknown): Promise<ToolValue> => {
  const { jira, caller } = options
  const status = await jira.superagentStatus()
  if (!status.ok) return failure(status.error, caller, me)
  return Object.freeze({
    ok: true,
    writable: caller.writable,
    ...(caller.reason === undefined ? {} : { reason: caller.reason }),
    me,
    ...status.value,
  })
}

/**
 * `superagent_claim`: propose, or claim the issue the proposal named.
 * @param args - the raw tool arguments, validated against `CLAIM_PARAMETERS`.
 * @param options - the store, caller verdict and clock for this run.
 * @param me - the caller's identity tuple, returned in every result.
 * @param maxWorkers - how many issues this session may already hold in progress; a claim at that
 *   limit is refused.
 * @returns the proposal, or the claimed issue with its dispatch facts.
 */
export const runClaimTool = async (
  args: unknown,
  options: RunOptions,
  me: unknown,
  maxWorkers: number = DEFAULT_MAX_WORKERS,
): Promise<ToolValue> => {
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
  // DH-704: a slot is a claimed issue. This session is the meter, so the number needs no new state
  // and a person's own session is never counted (it is a dispatcher, not a worker).
  const held = ledger.issues.filter(item => item.status === 'in_progress' && item.assignee === caller.identity).length
  if (held >= maxWorkers) {
    return failure(invalidInput(
      `${key} cannot be claimed yet: this session already holds ${String(held)} issue(s) in progress, `
      + `which is the configured limit (${String(maxWorkers)}); finish or release one first`,
      { key, held, maxWorkers },
    ), caller, me)
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
 * One turn-end pass: revive a lost executor, or propose the first ready issue, once.
 *
 * The pass never claims — a person still confirms — and it stays quiet when this session already
 * has work in progress or when the latest comment is already a proposal. That keeps the default
 * behavior "observe": one proposal costs one comment, and a reply spends it. Reviving an executor a
 * restart lost (DH-705) comes first and counts as this turn's action.
 * @param host - the plugin host the caller identity comes from.
 * @param agent - the root agent whose turn just ended.
 * @param signal - cancellation owned by the turn that triggered the pass.
 * @param workerPreset - the configured executor preset, when the deployment runs real executors.
 * @param maxWorkers - the configured slot count, forwarded to recovery.
 * @returns a promise that settles after the recovery or proposal attempt.
 */
export const runSuperagentPass = async (
  host: ToolHost,
  agent: unknown,
  signal?: AbortSignal,
  workerPreset?: string,
  maxWorkers: number = DEFAULT_MAX_WORKERS,
): Promise<void> => {
  if (signal?.aborted === true) return
  // An executor Session is a root, but the claim loop belongs to the dispatcher (DH-703 review).
  if (workerPreset !== undefined && workerPreset !== '' && isExecutorSession(agent, workerPreset)) return
  const caller = callerOf(host, agent)
  if (!caller.writable || caller.identity === undefined || caller.sessionId === undefined) return
  try {
    const call = { jira: host.ctx.jira, caller, me: identityOf(host, agent) }
    const options = runOptionsOf(host, call)

    // A restart ends the executor Sessions but not the claims, so reviving one is the more urgent
    // half of the pass; a revived work item means no proposal this turn.
    if (workerPreset !== undefined && workerPreset !== '') {
      const recovered = await runDispatchTool({ action: 'recover' }, options, call.me, host.ctx, workerPreset, maxWorkers)
      if (recovered.ok && Array.isArray(recovered.recovered) && recovered.recovered.length > 0) return
    }

    const active = await host.ctx.jira.list({ status: 'in_progress', assignee: String(caller.identity) })
    if (active.ok && active.value.items.length > 0) return

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

/**
 * The dispatcher identity a session-less pass writes as.
 *
 * It keeps the ledger's ordinary `agent:<model>|<tool>|<machine>|<session>` shape and uses a
 * synthetic session slot, because there is no Session to name; the machine is the real one the
 * service resolved, so the write is still attributed to this host and this ledger. No second
 * identity scheme and no second ledger are introduced (DH-714).
 * @param machineId - this machine's ledger identity, from `ctx.jira.status()`.
 * @returns the identity, or undefined when the machine id cannot form one.
 */
export const daemonIdentityOf = (machineId: string): Identity | undefined => {
  if (machineId.trim() === '') return undefined
  return asIdentity(`agent:daemon|dsh|${machineId}|${DAEMON_SESSION_ID}`)
}

/** How one session-less pass may act; an unset preset or checkout disables it. */
export interface DaemonPassOptions {
  /** The executor preset a claimed issue is dispatched into. */
  readonly workerPreset?: string
  /** How many issues the daemon may hold in progress; defaults to {@link DEFAULT_MAX_WORKERS}. */
  readonly maxWorkers?: number
  /** The checkout an executor works in. */
  readonly cwd?: string
  /** Whether this pass may add a proposal; only a pass with no writable session sets this. */
  readonly propose?: boolean
}

/**
 * One session-less dispatcher pass: recover, consume a confirmed own proposal, then propose.
 *
 * The daemon cannot propose and leave the claim to a person's session: a claim requires the
 * proposal to name the claiming identity (decision 210), so a daemon proposal is claimable only by
 * the daemon. It therefore finishes the job itself — claim, then dispatch into the configured
 * checkout — and the executor is still a real Session (DH-702/DH-712).
 *
 * It never writes a human credential, never claims an issue it did not propose, and adds at most
 * one proposal; a pending proposal from any session suppresses another. A pass is inert without a
 * worker preset, a checkout, or a session controller, so a deployment that cannot dispatch does not
 * accumulate proposals it can never act on.
 * @param host - the plugin host the ledger service and clock come from.
 * @param options - the preset, checkout, slot count and whether proposing is allowed.
 * @returns after the pass settles; failures never escape into the timer.
 */
export const runDaemonPass = async (host: ToolHost, options: DaemonPassOptions = {}): Promise<void> => {
  const workerPreset = options.workerPreset
  const cwd = options.cwd
  if (workerPreset === undefined || workerPreset.trim() === '') return
  if (cwd === undefined || cwd.trim() === '') return
  if (sessionControllerOf(host.ctx) === undefined) return
  const identity = daemonIdentityOf(host.ctx.jira.status().machineId)
  if (identity === undefined) return
  const caller: Caller = Object.freeze({ writable: true, identity, sessionId: DAEMON_SESSION_ID, cwd })
  const me = Object.freeze({ identity: String(identity), session: DAEMON_SESSION_ID })
  const runOptions: RunOptions = Object.freeze({ jira: host.ctx.jira, caller, at: nowUtc(host.clock) })
  const maxWorkers = options.maxWorkers ?? DEFAULT_MAX_WORKERS
  try {
    // A restart leaves the daemon's claims in place but its executor Sessions gone; reviving them
    // is the same dispatch path a live dispatcher uses.
    await runDispatchTool({ action: 'recover' }, runOptions, me, host.ctx, workerPreset, maxWorkers)
    const snapshot = await host.ctx.jira.snapshot()
    if (!snapshot.ok) return
    const held = snapshot.value.issues.filter(issue => issue.status === 'in_progress' && issue.assignee === identity).length
    if (held < maxWorkers) {
      // A person's confirmation leaves a human `[claim-approved]` comment last; the proposal before
      // it is the daemon's own, which is what `openProposal` checks.
      for (const issue of snapshot.value.issues) {
        if (issue.status !== CLAIMABLE_STATUS) continue
        const read = await host.ctx.jira.readIssue(issue.key)
        if (!read.ok) continue
        if (!openProposal(read.value.comments ?? [], identity).ready) continue
        const claimed = await runClaimTool({ action: 'claim', key: String(issue.key), cwd }, runOptions, me, maxWorkers)
        if (!claimed.ok) continue
        await runDispatchTool({ key: String(issue.key), cwd }, runOptions, me, host.ctx, workerPreset, maxWorkers)
        return
      }
    }
    if (options.propose !== true || held > 0) return
    const status = await host.ctx.jira.superagentStatus()
    // One pending proposal is enough; a second would be another comment to answer.
    if (status.ok && status.value.proposed.length > 0) return
    const scanned = await runScanTool({ limit: 10 }, runOptions, me)
    if (!scanned.ok) return
    const items = Array.isArray(scanned.items) ? scanned.items as unknown as Candidate[] : []
    const ready = items.find(item => item.ready)
    if (ready === undefined) return
    const read = await host.ctx.jira.readIssue(ready.key as IssueKey)
    if (!read.ok) return
    const last = (read.value.comments ?? []).at(-1)
    if (last !== undefined && last.body.trimStart().startsWith(PROPOSAL_MARKER)) return
    // The revision is the lease against a second host proposing the same issue: a comment that
    // landed in between makes the transaction stale instead of stacking a second proposal.
    await host.ctx.jira.mutateIssue(ready.key as IssueKey, {
      action: 'comment',
      body: `${PROPOSAL_MARKER} session-less pass: it is ready, unclaimed, and not blocked`,
    }, { by: identity, at: runOptions.at }, { expectedRevision: read.value.issue.revision })
  } catch {
    // A timer-driven pass never throws into the scheduler.
  }
}

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

/** The tool that starts a real Session instead of a subagent (DH-702). */
export const DISPATCH_TOOL_NAME = 'superagent_dispatch'

/**
 * Find one registered workspace by title, exact path, or the same checkout.
 * @param registry - the host's workspace registry, when present.
 * @param needle - the workspace the caller named.
 * @returns the matching workspace, or undefined.
 */
const findWorkspace = (registry: WorkspaceRegistryLike | undefined, needle: string): WorkspaceLike | undefined => {
  const value = needle.trim()
  if (value === '' || registry === undefined) return undefined
  const rows = registry.list()
  return rows.find(row => row.title === value)
    ?? rows.find(row => row.path === value)
    ?? rows.find(row => sameCheckout(row.path, value))
}

/**
 * Run one `superagent_session` call: open, continue, list, archive or branch a real workspace Session.
 *
 * `start` creates the Session through the host controller with `workspaceId`, which is what makes it
 * appear under that workspace and lets the person talk to it directly; the spawned agent decides
 * whether to spawn subagents or do the work itself. Every Session this tool starts or addresses is
 * remembered, so its turn end can report back here (DH-719).
 * @param args - the raw tool arguments, validated against {@link SESSION_PARAMETERS}.
 * @param options - the caller verdict, ledger and clock for this run.
 * @param me - the caller identity tuple, echoed in every result.
 * @param ctx - the plugin context the controller and registry are read from.
 * @param context - the configured preset and the report bookkeeping.
 * @returns the envelope, carrying the Session or the listing.
 */
export const runSessionTool = async (
  args: unknown,
  options: RunOptions,
  me: unknown,
  ctx: unknown,
  context: SessionToolContext,
): Promise<ToolValue> => {
  const { caller } = options
  const validated = validateArgs(SESSION_PARAMETERS, args)
  if (!validated.ok) return failure(validated.error, caller, me)
  const controller = sessionControllerOf(ctx)
  if (controller === undefined) {
    return failure(invalidInput('this deployment has no session controller, so a workspace Session cannot be run'), caller, me)
  }
  if (!caller.writable) {
    return failure(invalidInput('running a workspace Session needs a session that may write'), caller, me)
  }
  const verdict = Object.freeze({
    ok: true,
    writable: caller.writable,
    ...(caller.reason === undefined ? {} : { reason: caller.reason }),
    me,
  })
  const registry = workspaceRegistryOf(ctx)
  const action = asString(validated.value.action)
  const superSession = (me as { readonly session?: unknown } | undefined)?.session
  const reportTo = typeof superSession === 'string' && superSession !== '' ? superSession : undefined
  const workspaceArg = asString(validated.value.workspace)
  const sessionArg = asString(validated.value.session)
  const textArg = asString(validated.value.text)
  const taskArg = asString(validated.value.task)
  const atSeq = typeof validated.value.atSeq === 'number' ? validated.value.atSeq : undefined
  const workspace = workspaceArg === undefined ? undefined : findWorkspace(registry, workspaceArg)

  if (action === 'append') {
    if (workspace === undefined) {
      return failure(invalidInput(`"${String(workspaceArg ?? '')}" is not a registered workspace; run superagent_workspace roster first`), caller, me)
    }
    if (textArg === undefined || textArg.trim() === '') {
      return failure(invalidInput('append needs `text`: the follow-up instruction'), caller, me)
    }
    try {
      const listed = await controller.list()
      const target = listed.items
        .filter(item => item.parentSessionId === undefined && item.origin !== 'subagent' && item.blank !== true)
        .filter(item => item.cwd !== undefined && sameCheckout(item.cwd, workspace.path))
        .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))[0]
      if (target === undefined) {
        return failure(invalidInput(
          `"${workspace.title}" has no Session to continue yet; start one with superagent_session start`,
          { workspace: workspace.path },
        ), caller, me)
      }
      const sessionId = String(target.sessionId)
      await controller.prompt({
        requestId: `superagent-append-${randomUUID()}`,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: textArg.trim() }],
      }, new AbortController().signal)
      if (reportTo !== undefined) context.tasks.set(sessionId, { superSession: reportTo, workspace: workspace.path })
      return Object.freeze({
        ...verdict,
        session: Object.freeze({ id: sessionId, workspace: workspace.path, title: workspace.title, appended: true }),
      })
    } catch (error: unknown) {
      return failure(invalidInput(
        `the follow-up could not be appended: ${error instanceof Error ? error.message : String(error)}`,
        { workspace: workspace.path },
      ), caller, me)
    }
  }

  if (action === 'start') {
    if (workspace === undefined) {
      return failure(invalidInput(`"${String(workspaceArg ?? '')}" is not a registered workspace; run superagent_workspace roster first`), caller, me)
    }
    if (taskArg === undefined || taskArg.trim() === '') {
      return failure(invalidInput('start needs `task`: a self-contained brief for the workspace agent'), caller, me)
    }
    try {
      const created = await controller.create({
        workspaceId: workspace.id,
        ...(context.agentPreset === undefined || context.agentPreset.trim() === ''
          ? {}
          : { agentPreset: context.agentPreset }),
      })
      const sessionId = String(created.sessionId)
      await controller.prompt({
        requestId: `superagent-task-${randomUUID()}`,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: taskArg.trim() }],
      }, new AbortController().signal)
      if (reportTo !== undefined) context.tasks.set(sessionId, { superSession: reportTo, workspace: workspace.path })
      return Object.freeze({
        ...verdict,
        session: Object.freeze({ id: sessionId, workspace: workspace.path, title: workspace.title }),
      })
    } catch (error: unknown) {
      return failure(invalidInput(
        `the workspace Session could not be started: ${error instanceof Error ? error.message : String(error)}`,
        { workspace: workspace.path },
      ), caller, me)
    }
  }

  if (action === 'prompt') {
    if (sessionArg === undefined || sessionArg.trim() === '') {
      return failure(invalidInput('prompt needs `session`: the Session id'), caller, me)
    }
    if (textArg === undefined || textArg.trim() === '') {
      return failure(invalidInput('prompt needs `text`: the follow-up instruction'), caller, me)
    }
    try {
      await controller.prompt({
        requestId: `superagent-followup-${randomUUID()}`,
        sessionId: sessionArg,
        mode: 'queue',
        content: [{ type: 'text', text: textArg.trim() }],
      }, new AbortController().signal)
      if (reportTo !== undefined) {
        const known = context.tasks.get(sessionArg)
        context.tasks.set(sessionArg, {
          superSession: reportTo,
          workspace: workspace?.path ?? known?.workspace ?? 'its workspace',
        })
      }
      return Object.freeze({ ...verdict, session: Object.freeze({ id: sessionArg }) })
    } catch (error: unknown) {
      return failure(invalidInput(
        `the follow-up could not be admitted: ${error instanceof Error ? error.message : String(error)}`,
        { session: sessionArg },
      ), caller, me)
    }
  }

  if (action === 'list') {
    try {
      const listed = await controller.list()
      const rows = listed.items
        .filter(item => item.parentSessionId === undefined && item.origin !== 'subagent')
        .filter(item => workspace === undefined || item.cwd === undefined || sameCheckout(item.cwd, workspace.path))
        .map(item => Object.freeze({
          id: String(item.sessionId),
          running: item.running,
          blank: item.blank === true,
          ...(item.cwd === undefined ? {} : { cwd: item.cwd }),
          ...(item.updatedAt === undefined ? {} : { updatedAt: item.updatedAt }),
        }))
      return Object.freeze({ ...verdict, sessions: Object.freeze(rows) })
    } catch (error: unknown) {
      return failure(invalidInput(`the Session list could not be read: ${error instanceof Error ? error.message : String(error)}`), caller, me)
    }
  }

  if (action === 'archive') {
    if (sessionArg === undefined || sessionArg.trim() === '') {
      return failure(invalidInput('archive needs `session`: the Session id'), caller, me)
    }
    if (registry?.archiveSession === undefined) {
      return failure(invalidInput('this deployment has no workspace registry archive'), caller, me)
    }
    try {
      await registry.archiveSession(sessionArg)
      context.tasks.delete(sessionArg)
      return Object.freeze({ ...verdict, session: Object.freeze({ id: sessionArg, archived: true }) })
    } catch (error: unknown) {
      return failure(invalidInput(
        `the Session could not be archived: ${error instanceof Error ? error.message : String(error)}`,
        { session: sessionArg },
      ), caller, me)
    }
  }

  if (action === 'fork') {
    if (sessionArg === undefined || sessionArg.trim() === '') {
      return failure(invalidInput('fork needs `session`: the Session id'), caller, me)
    }
    if (controller.fork === undefined) {
      return failure(invalidInput('this deployment cannot branch a Session'), caller, me)
    }
    try {
      const forked = await controller.fork({
        sessionId: sessionArg,
        ...(atSeq === undefined ? {} : { atSeq }),
      })
      const sessionId = String(forked.sessionId)
      if (reportTo !== undefined) {
        const known = context.tasks.get(sessionArg)
        context.tasks.set(sessionId, {
          superSession: reportTo,
          workspace: workspace?.path ?? known?.workspace ?? 'its workspace',
        })
      }
      return Object.freeze({ ...verdict, session: Object.freeze({ id: sessionId, forkedFrom: sessionArg }) })
    } catch (error: unknown) {
      return failure(invalidInput(
        `the Session could not be branched: ${error instanceof Error ? error.message : String(error)}`,
        { session: sessionArg },
      ), caller, me)
    }
  }

  return failure(invalidInput(`unknown action "${String(action)}"`), caller, me)
}

/** The last assistant text of one Session, skipping reasoning and tool-call blocks. */
const lastAssistantText = (agent: unknown): string | undefined => {
  const session = (agent as { session?: { snapshotEvents?: () => readonly { type: string; data?: unknown }[] } }).session
  const events = session?.snapshotEvents?.() ?? []
  for (const event of [...events].reverse()) {
    if (event.type !== 'assistant/message') continue
    const message = (event.data as { message?: { content?: readonly { type: string; text?: string }[] } }).message
    const text = (message?.content ?? [])
      .filter(block => block.type === 'text')
      .map(block => block.text ?? '')
      .join('\n')
      .trim()
    if (text !== '') return text
  }
  return undefined
}

/**
 * Deliver one workspace Session's turn report back to the super agent that started or addressed it.
 *
 * The report is an ordinary queued message in the super Session: it starts a new turn there without
 * holding the person's conversation, which is the whole reason the super agent must not wait
 * (DH-719). A failure is logged rather than thrown — the worker's turn already committed.
 * @param host - the plugin host whose controller delivers the message.
 * @param record - the super Session and workspace the report belongs to.
 * @param agent - the workspace Session whose turn just ended.
 * @param signal - the turn-end signal.
 * @returns whether a report was delivered.
 */
export const deliverTaskReport = async (
  host: ToolHost,
  record: TaskSessionRecord,
  agent: unknown,
  signal: AbortSignal,
): Promise<boolean> => {
  const controller = sessionControllerOf(host.ctx)
  if (controller === undefined) return false
  const text = lastAssistantText(agent)
  if (text === undefined) return false
  const sessionId = String((agent as { id?: unknown }).id)
  try {
    await controller.prompt({
      requestId: `superagent-report-${randomUUID()}`,
      sessionId: record.superSession,
      mode: 'queue',
      content: [{
        type: 'text',
        text: `[task-report] ${sessionId} in ${record.workspace} finished its turn.\n\n${text}`,
      }],
    }, signal)
    return true
  } catch (error: unknown) {
    host.ctx.logger.warn(
      'superagent: the task report for %s could not be delivered: %s',
      record.superSession,
      error instanceof Error ? error.message : String(error),
    )
    return false
  }
}

/** The dispatch record lives in its own module so `issue_work` can read the same binding. */
export { DISPATCH_MARKER, dispatchBody, dispatchRecordOf } from './dispatch.ts'
export type { DispatchRecord, DispatchStatus } from './dispatch.ts'

/** How many issues one dispatcher may keep in progress at once, unless the row says otherwise. */
export const DEFAULT_MAX_WORKERS = 2

/** One Session row the list action reports. */
export interface SessionSummaryLike {
  readonly sessionId: unknown
  readonly running: boolean
  readonly cwd?: string
  readonly parentSessionId?: unknown
  readonly origin?: string
  readonly blank?: boolean
  /** Last activity in epoch milliseconds; the append action prefers the most recent Session. */
  readonly updatedAt?: number
}

/**
 * The slice of the host's session controller this capability uses.
 *
 * Duck-typed on purpose (decision 108): a deployment without one keeps every other verb and loses
 * only this one, with a readable refusal.
 */
export interface SessionControllerLike {
  /**
   * Create one Session. `workspaceId` attaches it to a registered Workspace (which is what makes it
   * appear under that workspace in the sidebar); `cwd` names the directory otherwise.
   */
  create(request: {
    readonly workspaceId?: string
    readonly cwd?: string
    readonly agentPreset?: string
  }): Promise<{ readonly sessionId: unknown }>
  /**
   * Admit the dispatch instruction as the Session's first prompt.
   *
   * `signal` is not decoration: the host's controller calls `throwIfAborted()` before it admits
   * anything, so a call without one throws at runtime even though a casual stand-in accepts it.
   */
  prompt(request: {
    readonly requestId: unknown
    readonly sessionId: unknown
    readonly mode: 'queue' | 'steer'
    readonly content: readonly { readonly type: 'text'; readonly text: string }[]
  }, signal: AbortSignal): Promise<{ readonly accepted: boolean }>
  /** Every visible Session, so a dispatch can tell whether its executor still runs. */
  list(): Promise<{ readonly items: readonly SessionSummaryLike[] }>
  /** Branch one Session from a completed-turn prefix; optional on a host without the verb. */
  fork?(request: {
    readonly sessionId: string
    readonly atSeq?: number
  }): Promise<{ readonly sessionId: unknown }>
}

/**
 * Read the host's session controller, if this deployment has one.
 * @param ctx - the plugin context, duck-typed.
 * @returns the controller when it is present and has both methods.
 */
export const sessionControllerOf = (ctx: unknown): SessionControllerLike | undefined => {
  const get = (ctx as { get?: (key: string) => unknown } | undefined)?.get
  if (typeof get !== 'function') return undefined
  const service = get.call(ctx, 'sessionController') as Partial<SessionControllerLike> | undefined
  if (service === undefined || typeof service.create !== 'function' || typeof service.prompt !== 'function'
    || typeof service.list !== 'function') {
    return undefined
  }
  return service as SessionControllerLike
}

/** `superagent_dispatch`'s schema. */
export const DISPATCH_PARAMETERS: Readonly<Record<string, FieldSpec>> = Object.freeze({
  action: {
    type: 'string',
    description: 'start: hand this issue to a new executor (the default). '
      + 'recover: restart the executors this session lost, oldest first.',
    enum: ['start', 'recover'],
  },
  key: { type: 'string', description: 'start: the issue key you claimed, e.g. DH-12.' },
  cwd: { type: 'string', description: 'start: the checkout the executor works in; defaults to this session\'s own.' },
})

/**
 * `superagent_dispatch`'s description.
 *
 * It names the one fact a caller cannot learn from a result: a real Session only exists when the
 * deployment configured the preset that makes it an executor rather than a second dispatcher.
 */
export const DISPATCH_DESCRIPTION =
  'Start the executor of a claimed issue as a real Session of its own, in the checkout the dispatch '
  + 'names, and hand it the issue. The issue must be in progress and assigned to this session; the '
  + 'deployment must configure a worker preset, because a Session without one would inherit the '
  + 'dispatcher\'s ledger rights instead of only `issue_work`. '
  + '`recover` restarts the executors this session lost — an issue it still holds whose recorded '
  + 'Session is gone — which is what a restart leaves behind.'

/**
 * `superagent_dispatch`: start a real Session as the executor of one claimed issue, or restart the
 * executors this session lost after a restart (DH-705).
 *
 * The refusal order is the one that tells the caller what to fix: configuration, then the service,
 * then the claim, then the ledger.
 * @param args - the raw tool arguments, validated against `DISPATCH_PARAMETERS`.
 * @param options - the store, caller verdict and clock for this run.
 * @param me - the caller's identity tuple, returned in every result.
 * @param ctx - the plugin context the session controller is read from.
 * @param workerPreset - the configured executor preset, or undefined when the deployment has none.
 * @param maxWorkers - how many issues one dispatcher may hold in progress; the first test this
 *   module needs, reported in the refusal.
 * @returns the started Session, or what `recover` revived and what it left alone.
 */
export const runDispatchTool = async (
  args: unknown,
  options: RunOptions,
  me: unknown,
  ctx: ToolHost['ctx'],
  workerPreset: string | undefined,
  maxWorkers: number = DEFAULT_MAX_WORKERS,
): Promise<ToolValue> => {
  const { jira, caller } = options
  const validated = validateArgs(DISPATCH_PARAMETERS, args)
  if (!validated.ok) return failure(validated.error, caller, me)
  if (!caller.writable) {
    return failure(invalidInput('dispatching an issue needs a session that may write the ledger'), caller, me)
  }
  if (workerPreset === undefined || workerPreset.trim() === '') {
    return failure(invalidInput(
      'no worker preset is configured, so a dispatched Session would inherit this session\'s tools '
      + 'instead of only issue_work; set the superagent worker preset before dispatching',
    ), caller, me)
  }
  const controller = sessionControllerOf(ctx)
  if (controller === undefined) {
    return failure(invalidInput('this deployment has no session controller, so it cannot start an executor Session'), caller, me)
  }

  const ledger = await readLedger(jira)
  if (ledger === undefined) return failure(invalidInput('the ledger could not be read'), caller, me)
  const cwd = asString(validated.value.cwd) ?? caller.cwd

  /**
   * Start one executor for an issue this session holds.
   * @param key - the claimed issue.
   * @returns the started Session, or the refusal that stopped it.
   */
  const dispatchOne = async (key: string): Promise<ToolValue> => {
    const issue = ledger.byKey.get(key)
    if (issue === undefined) return failure(invalidInput(`${key} is not in the ledger`, { key }), caller, me)
    if (issue.status !== 'in_progress') {
      return failure(invalidInput(`${key} is '${issue.status}'; claim it before dispatching`, { key }), caller, me)
    }
    if (issue.assignee === undefined || issue.assignee !== caller.identity) {
      return failure(invalidInput(`${key} is not assigned to this session; a dispatcher claims before it dispatches`, { key }), caller, me)
    }

    // DH-704: never leave two executors on one issue. The last dispatch record names the Session
    // that ran it; while that Session is still running, a second dispatch would duplicate the work.
    const full = await jira.readIssue(key as IssueKey)
    if (!full.ok) return failure(full.error, caller, me)
    const previous = dispatchRecordOf(full.value.comments ?? [])
    if (previous !== undefined && previous.status !== 'failed') {
      let running: boolean
      try {
        const listed = await controller.list()
        running = listed.items.some(item => String(item.sessionId) === previous.session && item.running)
      } catch {
        return failure(invalidInput(
          `${key} records executor session '${previous.session}', and whether it still runs cannot be read; `
          + 'stop it or wait before dispatching again',
          { key },
        ), caller, me)
      }
      if (running) {
        return failure(invalidInput(
          `${key} already has a running executor (session '${previous.session}'); wait for it or stop it before dispatching again`,
          { key },
        ), caller, me)
      }
    }

    const instruction = dispatchInstruction(key)
    let sessionId: string
    try {
      const created = await controller.create({
        ...(cwd === undefined ? {} : { cwd }),
        agentPreset: workerPreset,
      })
      sessionId = String(created.sessionId)
    } catch (error: unknown) {
      return failure(invalidInput(
        `the executor Session for ${key} could not be created: ${error instanceof Error ? error.message : String(error)}`,
        { key },
      ), caller, me)
    }
    // The record is written **before** the first prompt: the executor's first `issue_work` call
    // authorizes against it, so a record that only appeared after the prompt would refuse the real
    // worker (DH-702 review). A failed write means the executor is not started at all.
    const record = async (status: 'starting' | 'started' | 'failed'): Promise<boolean> => {
      const written = await jira.mutateIssue(key as IssueKey, {
        action: 'comment',
        body: dispatchBody(sessionId, status),
      }, { by: actorFor(options, caller), at: options.at }, {})
      return written.ok
    }
    if (!await record('starting')) {
      return failure(invalidInput(
        `${key}: the dispatch record could not be written, so the executor was not started `
        + `(session '${sessionId}' was created but never prompted)`,
        { key },
      ), caller, me)
    }
    try {
      await controller.prompt({
        requestId: `superagent-${randomUUID()}`,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: instruction }],
      }, new AbortController().signal)
    } catch (error: unknown) {
      await record('failed')
      return failure(invalidInput(
        `the executor Session for ${key} could not be started: ${error instanceof Error ? error.message : String(error)}`,
        { key },
      ), caller, me)
    }
    // The executor is running and bound by the `starting` record even if this richer status cannot
    // be written; the claim is not lost, and recovery sees the Session as still running.
    const recorded = await record('started')
    return Object.freeze({
      ok: true,
      writable: caller.writable,
      me,
      dispatch: Object.freeze({
        key,
        // `session` rather than `sessionId`, matching the `me` tuple: the wire conversion would
        // rename a camelCase key on the way out, and the model reads the rendered text either way.
        session: sessionId,
        ...(cwd === undefined ? {} : { cwd }),
        instruction,
        recorded,
        status: recorded ? 'started' : 'starting',
      }),
    })
  }

  if ((asString(validated.value.action) ?? 'start') !== 'recover') {
    const key = asString(validated.value.key)
    if (key === undefined || key.trim() === '') return failure(invalidInput('start needs a `key`'), caller, me)
    return dispatchOne(key)
  }

  // DH-705: a restart ends the executor Sessions but not the claims, so the dispatcher owes those
  // issues a new executor. Only issues that were dispatched before are considered: a claim without a
  // record may be work somebody is doing by hand.
  const mine = ledger.issues
    .filter(issue => issue.status === 'in_progress' && issue.assignee === caller.identity)
    .slice(0, Math.max(1, maxWorkers))
  const recovered: Record<string, unknown>[] = []
  const left: Record<string, unknown>[] = []
  for (const issue of mine) {
    const key = String(issue.key)
    const full = await jira.readIssue(issue.key)
    if (!full.ok) {
      left.push(Object.freeze({ key, reason: 'the issue could not be read' }))
      continue
    }
    const previous = dispatchRecordOf(full.value.comments ?? [])
    if (previous === undefined) {
      left.push(Object.freeze({ key, reason: 'it was never dispatched; nothing to restart' }))
      continue
    }
    let running = false
    try {
      const listed = await controller.list()
      running = listed.items.some(item => String(item.sessionId) === previous.session && item.running)
    } catch {
      left.push(Object.freeze({ key, reason: `executor '${previous.session}' state cannot be read` }))
      continue
    }
    if (running) {
      left.push(Object.freeze({ key, reason: `executor '${previous.session}' still runs` }))
      continue
    }
    const started = await dispatchOne(key)
    if (!started.ok) {
      left.push(Object.freeze({ key, reason: 'the executor could not be started' }))
      continue
    }
    const dispatch = started.dispatch as { session?: string } | undefined
    recovered.push(Object.freeze({ key, previous: previous.session, session: String(dispatch?.session ?? '') }))
  }
  return Object.freeze({
    ok: true,
    writable: caller.writable,
    me,
    recovered: Object.freeze(recovered),
    left: Object.freeze(left),
  })
}

/** The tool that turns a GitHub item into ledger work (DH-706). */
export const SOURCE_TOOL_NAME = 'superagent_source'

/** `superagent_source`'s schema. */
export const SOURCE_PARAMETERS: Readonly<Record<string, FieldSpec>> = Object.freeze({
  action: {
    type: 'string',
    required: true,
    description: 'poll: read the configured repository\'s open issues and create the ones the ledger does not have yet.',
    enum: ['poll'],
  },
  limit: { type: 'number', description: 'How many open issues to read; default 30.' },
  project: { type: 'string', description: 'The ledger project the imported issues land in; defaults to the session\'s checkout.' },
})

/**
 * `superagent_source`'s description.
 *
 * It says what the source does *not* do as plainly as what it does: GitHub is the intake channel,
 * the ledger is where the work lives, and nothing is written back.
 */
export const SOURCE_DESCRIPTION =
  'Read the configured GitHub repository\'s open issues and, for each one the ledger does not have '
  + 'yet, create a ledger issue that carries the original URL. Read-only towards GitHub: no comment, '
  + 'no label, no close. Poll only when someone asks; it is not a background watcher.'

/**
 * `superagent_source`: turn unseen GitHub issues into ledger issues.
 *
 * The deduplication is the ledger's: an item is known when some issue's body already carries its
 * URL, so a re-poll costs no new state and a restart cannot forget what was imported.
 * @param args - the raw tool arguments, validated against `SOURCE_PARAMETERS`.
 * @param options - the store, caller verdict and clock for this run.
 * @param me - the caller's identity tuple, returned in every result.
 * @param githubRepo - the configured `owner/name`, or undefined when the deployment has none.
 * @param runner - the `gh` runner; a test passes its own.
 * @returns the issues created and the ones left alone, with a reason each.
 */
export const runSourceTool = async (
  args: unknown,
  options: RunOptions,
  me: unknown,
  githubRepo: string | undefined,
  runner?: GhRunner,
): Promise<ToolValue> => {
  const { jira, caller } = options
  const validated = validateArgs(SOURCE_PARAMETERS, args)
  if (!validated.ok) return failure(validated.error, caller, me)
  if (!caller.writable) {
    return failure(invalidInput('polling a source creates ledger issues, so it needs a session that may write the ledger'), caller, me)
  }
  if (githubRepo === undefined || githubRepo.trim() === '') {
    return failure(invalidInput(
      'no GitHub repository is configured; set the row\'s superagent_github_repo to owner/name',
    ), caller, me)
  }

  const ledger = await readLedger(jira)
  if (ledger === undefined) return failure(invalidInput('the ledger could not be read'), caller, me)

  const limit = typeof validated.value.limit === 'number' && validated.value.limit > 0
    ? Math.min(Math.floor(validated.value.limit), 100)
    : 30
  let items: readonly GithubItem[]
  try {
    items = await pollGithub(githubRepo, runner, limit)
  } catch (error: unknown) {
    return failure(invalidInput(
      `GitHub could not be read: ${error instanceof Error ? error.message : String(error)}`,
      { repo: githubRepo },
    ), caller, me)
  }

  const actor = { by: actorFor(options, caller), at: options.at }
  const created: Record<string, unknown>[] = []
  const skipped: Record<string, unknown>[] = []
  for (const item of items) {
    if (ledger.issues.some(issue => issue.body.includes(item.url))) {
      skipped.push(Object.freeze({ number: item.number, url: item.url, reason: 'already in the ledger' }))
      continue
    }
    const made = await jira.createIssue(asString(validated.value.project), caller.cwd, {
      issueType: 'task',
      summary: item.title.slice(0, SUMMARY_MAX_CHARS),
      body: `From GitHub: ${item.url}\n\nOpened by @${item.author ?? 'unknown'} as ${githubRepo}#${String(item.number)}.`,
    }, actor)
    if (!made.ok) {
      skipped.push(Object.freeze({ number: item.number, url: item.url, reason: `could not be created: ${made.error.code}` }))
      continue
    }
    created.push(Object.freeze({
      key: String(made.value.created.change.issue.key),
      number: item.number,
      url: item.url,
    }))
  }
  return Object.freeze({
    ok: true,
    writable: caller.writable,
    me,
    created: Object.freeze(created),
    skipped: Object.freeze(skipped),
  })
}

/** One text block, clamped to the model's budget. */
const renderText = (text: string): ContentBlock[] => [{ type: 'text', text: clampText(text) }]

/**
 * The dispatch tool's declaration, shaped like the others.
 * @param host - the plugin host the call context is resolved from.
 * @param workerPreset - the configured executor preset, forwarded to the runner.
 * @returns the tool declaration.
 */
const dispatcher = (host: ToolHost, workerPreset: string | undefined, maxWorkers: number): Spec => ({
  name: DISPATCH_TOOL_NAME,
  description: DISPATCH_DESCRIPTION,
  parameters: DISPATCH_PARAMETERS,
  outputSchema: SUPERAGENT_OUTPUT_SCHEMA,
  timeoutMs: 30_000,
  isConcurrencySafe: () => false,
  render: (typed) => {
    if (Array.isArray(typed.recovered)) {
      const restarted = typed.recovered as { key: string; session: string }[]
      const left = Array.isArray(typed.left) ? typed.left as { key: string; reason: string }[] : []
      if (restarted.length === 0 && left.length === 0) return renderText('nothing to recover')
      return renderText([
        ...restarted.map(row => `${row.key}  restarted  session ${row.session}`),
        ...left.map(row => `${row.key}  left alone: ${row.reason}`),
      ].join('\n'))
    }
    const dispatch = typed.dispatch as { key?: string; session?: string; cwd?: string } | undefined
    return renderText(dispatch?.session === undefined
      ? 'ok'
      : `${String(dispatch.key)}  session ${String(dispatch.session)}  ${String(dispatch.cwd ?? '')}`.trim())
  },
  run: (args, call) => runDispatchTool(args, runOptionsOf(host, call), call.me, host.ctx, workerPreset, maxWorkers),
})


/** The daemon row configuration; both the switch and a checkout are required for it to run. */
export interface SuperagentDaemonConfig {
  /** Whether a session-less pass may run at all. */
  readonly enabled: boolean
  /** The checkout a claimed issue is dispatched into. */
  readonly workspace?: string
}

/**
 * Build the tool definitions the capability contributes.
 *
 * The schemas, the runners and the descriptions live here; this function only turns them into the
 * registry's shape, so each tool declares its timeout and concurrency class in one place.
 * @param host - the plugin host the call context is resolved from.
 * @param workerPreset - the configured executor preset; without one, dispatch refuses (DH-702).
 * @param maxWorkers - how many issues one dispatcher may hold in progress, forwarded to the claim
 *   and dispatch tools.
 * @param githubRepo - the configured `owner/name` the GitHub source tool imports from; without it
 *   the source tool refuses.
 * @param daemon - the session-less pass configuration; absent or disabled keeps the old behavior.
 * @param home - the configured super workspace path; a session opened there is the super agent.
 * @param permissionPreset - the permission preset a super agent is pinned to; unset keeps the host default.
 * @returns the capability contribution the organizer wires onto root agents.
 */
export const createSuperagentContribution = (
  host: ToolHost,
  workerPreset?: string,
  maxWorkers: number = DEFAULT_MAX_WORKERS,
  githubRepo?: string,
  daemon?: SuperagentDaemonConfig,
  home?: string,
  permissionPreset?: string,
  agentPreset?: string,
): CapabilityContribution => {
  const liveAgents = new Set<Agent>()
  let timer: ReturnType<typeof setInterval> | undefined
  let polling = false
  const superHome = home === undefined || home.trim() === '' ? undefined : home
  /** Sessions this super agent started or addressed, so their turn ends report back (DH-719). */
  const tasks = new Map<string, TaskSessionRecord>()
  const daemonWorkspace = daemon?.workspace
  const daemonEnabled = daemon?.enabled === true && daemonWorkspace !== undefined && daemonWorkspace.trim() !== ''
  const poll = async (): Promise<void> => {
    if (polling) return
    polling = true
    try {
      const live = [...liveAgents].find(agent => callerOf(host, agent).writable)
      // The session-less half revives its own executors and consumes its own confirmations even
      // while a session exists, but it leaves proposing to a live dispatcher: that session's
      // proposal is claimable by itself, so one proposer is enough.
      if (daemonEnabled) {
        await runDaemonPass(host, {
          ...(workerPreset === undefined ? {} : { workerPreset }),
          maxWorkers,
          ...(daemonWorkspace === undefined ? {} : { cwd: daemonWorkspace }),
          propose: live === undefined,
        })
      }
      if (live === undefined) return
      await runSuperagentPass(host, live, undefined, workerPreset, maxWorkers)
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
  const source: Spec = {
    name: SOURCE_TOOL_NAME,
    description: SOURCE_DESCRIPTION,
    parameters: SOURCE_PARAMETERS,
    outputSchema: SUPERAGENT_OUTPUT_SCHEMA,
    timeoutMs: 30_000,
    // One poll creates ledger issues in sequence; there is no read path to declare overlap-safe.
    isConcurrencySafe: () => false,
    render: (typed) => {
      const created = Array.isArray(typed.created) ? typed.created as { key: string; number: number }[] : []
      const skipped = Array.isArray(typed.skipped) ? typed.skipped as { number: number; reason: string }[] : []
      if (created.length === 0 && skipped.length === 0) return renderText('no open issue to import')
      return renderText([
        ...created.map(row => `${row.key}  from #${String(row.number)}`),
        ...skipped.map(row => `#${String(row.number)}  skipped: ${row.reason}`),
      ].join('\n'))
    },
    run: (args, call) => runSourceTool(args, runOptionsOf(host, call), call.me, githubRepo),
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
    run: (args, call) => runClaimTool(args, runOptionsOf(host, call), call.me, maxWorkers),
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
  const session: Spec = {
    name: SESSION_TOOL_NAME,
    description: SESSION_DESCRIPTION,
    parameters: SESSION_PARAMETERS,
    outputSchema: SUPERAGENT_OUTPUT_SCHEMA,
    timeoutMs: 30_000,
    // Starting or prompting a Session mutates the conversation, so the conservative default applies.
    isConcurrencySafe: () => false,
    render: (typed) => {
      if (Array.isArray(typed.sessions)) {
        const rows = typed.sessions as { id: string; running: boolean; cwd?: string; blank?: boolean }[]
        if (rows.length === 0) return renderText('no Session in that workspace')
        return renderText(rows
          .map(row => `${row.id}  ${row.running ? 'running' : 'idle'}${row.blank === true ? '  (blank)' : ''}  ${row.cwd ?? ''}`)
          .join('\n'))
      }
      const one = typed.session as { id?: string; archived?: boolean; forkedFrom?: string } | undefined
      if (one?.id === undefined) return renderText('ok')
      if (one.archived === true) return renderText(`archived ${one.id}`)
      if (one.forkedFrom !== undefined) return renderText(`branched ${one.forkedFrom} → ${one.id}`)
      return renderText(`session ${one.id}`)
    },
    run: (args, call) => runSessionTool(args, runOptionsOf(host, call), call.me, host.ctx, {
      ...(agentPreset === undefined ? {} : { agentPreset }),
      tasks,
    }),
  }
  return Object.freeze({
    // DH-703: an executor Session is a root agent, so the scope alone would hand it the dispatcher's
    // verbs. It gets none of them; the jira capability gives it the reading tools and `issue_work`.
    // DH-716: the super agent is a root too, and it dispatches rather than claims — it keeps the
    // workspace roster and loses the ledger-bound verbs that would only invite it into the loop.
    scope: 'root',
    tools: (agent: Agent) => (isExecutorSession(agent, workerPreset)
      ? Object.freeze([])
      : isSuperAgentSession(agent, superHome)
        ? Object.freeze([defineJiraTool(host, workspace), defineJiraTool(host, session)])
        : Object.freeze([
          defineJiraTool(host, source),
          defineJiraTool(host, scan),
          defineJiraTool(host, claim),
          defineJiraTool(host, workspace),
          defineJiraTool(host, status),
          defineJiraTool(host, dispatcher(host, workerPreset, maxWorkers)),
        ])),
    promptSections: (agent: Agent) => (isSuperAgentSession(agent, superHome)
      ? [SUPERAGENT_SECTION]
      : []),
    onAgentCreated: (agent: Agent) => {
      liveAgents.add(agent)
      agent.ctx.effect(() => () => { liveAgents.delete(agent) }, 'superagent: forget a disposed agent')
      // DH-718: the super agent must not inherit a looser bundle than the workspace it runs in.
      try {
        enforceSuperAgentPermission(host.ctx, agent, superHome, permissionPreset)
      } catch (error: unknown) {
        host.ctx.logger.warn(
          'superagent: session %s could not take permission preset %s: %s',
          String(agent.id),
          String(permissionPreset),
          String(error),
        )
      }
    },
    onTurnEnd: async (input: TurnEndInput) => {
      // DH-719: a Session this super agent started addresses reports back here as a queued message,
      // so the person's conversation is never held while that workspace works.
      const report = tasks.get(String(input.agent.id))
      if (report !== undefined) {
        await deliverTaskReport(host, report, input.agent, input.signal)
        return
      }
      // An executor Session is a root agent, but it must not propose new work (DH-703 review):
      // its turn end is delivery, not dispatch.
      if (isExecutorSession(input.agent, workerPreset)) return
      // DH-716: the super agent's turn end is a report to the person, not a pass over the ledger.
      if (isSuperAgentSession(input.agent, superHome)) return
      await runSuperagentPass(host, input.agent, input.signal, workerPreset, maxWorkers)
    },
    dispose: () => {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
      liveAgents.clear()
    },
  })
}
