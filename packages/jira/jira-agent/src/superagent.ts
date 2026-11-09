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
import { copyFile, mkdir } from 'node:fs/promises'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { type Comment, type FieldSpec, type Identity, type Issue, type IssueKey, type Timestamp } from '@deepseek-ai/dsh-jira-core'
import { clampText, asIdentity, invalidInput, ioFailed, leaseIsActive, notFound, readOnlySession, renderIssueHuman, validateArgs } from '@deepseek-ai/dsh-jira-core'
import { SUMMARY_MAX_CHARS } from '@deepseek-ai/dsh-jira-core'
import { type GhRunner, type GithubItem, pollGithub } from './github.ts'
import { dispatchBody, dispatchRecordOf } from './dispatch.ts'
import { createDispatchStore, type DispatchStore } from './dispatch-store.ts'
import { DispatchReportStore, newDispatchReportId, type DispatchReportRecord, type DispatchReportWorkspace } from './dispatch-reports.ts'
import { type RunOptions, type ToolValue, actorFor, asString, asStringList, failure, nowUtc, okValue } from './envelope.ts'
import { callerCwd, isExecutorSession, isSubagent, type Caller } from './caller.ts'
import { ensureSuperWorkspaceDefinition } from './super-workspace-definition.ts'
import {
  findDispatchTask,
  isDispatchLedgerStatus,
  listAllDispatchTasks,
  listDispatchTasks,
  pendingTask,
  queryDispatchTasks,
  recordDispatch,
  resolveDispatchTask,
  type DispatchLedgerTask,
} from './dispatch-ledger.ts'
import { type Spec, type ToolHost, callerOf, defineJiraTool, identityOf, runOptionsOf } from './tools.ts'
import {
  applySessionPermission,
  PERMISSION_DESCRIPTION,
  PERMISSION_PARAMETERS,
  PERMISSION_TOOL_NAME,
  runPermissionTool,
  WORKSPACE_SESSION_PERMISSION,
} from './superagent-permission.ts'

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
  text: 'You are the super agent: the single conversation a person has with this harness. A workspace\'s '
    + 'work belongs to a Session in that workspace; the harness itself — system environment, DSH and '
    + 'plugin settings, global configuration, work spanning workspaces — belongs to you here. Do not '
    + 'route a global change through a workspace Session. Ask the person which directory to register '
    + 'before creating a workspace.\n'
    + '\n'
    + '- Route deliberately, never by guess. List the workspace\'s Sessions and reuse one whose title '
    + 'and purpose match; `append` requires an explicit `session` (an id or "latest") and refuses when '
    + 'the target is ambiguous. If the person says "the other session", name the candidate you '
    + 'understood and ask when it is still unclear. Open a new Session only when the person asks for '
    + 'one, no existing Session fits, or the task is genuinely isolated; never mirror one workspace\'s '
    + 'work into two Sessions editing the same files. State each dispatch target in one line ("→ reuse '
    + '<title> (<id>)" or "→ new <title>, reason: …").\n'
    + '- While a Session runs, append to it rather than starting a parallel one. Use `delivery: '
    + '"interrupt"` only for a correction or pivotal fact that turn must see; otherwise queue. After '
    + 'handing over work, end your turn: reports arrive as new messages in a later turn.\n'
    + '- A `[superagent monitor]` line means a workspace turn is long. Call `inspect` first and judge '
    + 'whether it is slow or stuck; age alone is not a reason to act. To end work, `stop` cancels the '
    + 'turn and admits nothing; `abort` cancels it and then sends the redirect `text`. Never use a '
    + 'message where a stop is meant, and never stop or abort an idle Session.\n'
    + '- Reports are evidence: if one names a blocker, pass that fact on in one line. Answer the person '
    + 'briefly with what was sent where, the outcome, and any decision they owe; do not paste the whole '
    + 'report. Use `superagent_ledger` for structured dispatch state and `memory_write` for the durable '
    + 'conclusion.\n'
    + '- Ask before you decide for the person: registering a directory, changing global configuration, '
    + 'removing or renaming a workspace, deleting or archiving a Session, or choosing an outcome when '
    + 'the right result is unclear. A workspace\'s memory, files and history belong to that workspace; '
    + 'never edit another workspace\'s memory from here.\n'
    + '- Use `subagent` only for quick research that belongs to no workspace; a real Session is what '
    + 'the person can see, continue, archive and branch. Do not claim or dispatch jira ledger issues '
    + 'from here: this workspace dispatches work, it does not run the claim loop.\n'
    + '- When a file must be handed over (a report, spreadsheet, or attachment), deliver it into the '
    + 'target workspace and name the delivered path in the task; do not process the material here.\n'
    + '- Use `superagent_permission` to list, read, or switch one explicitly addressed workspace '
    + 'Session\'s permission. New Sessions start with workspace-write. `soft` selects the guarded '
    + 'tool/path blacklist only in the unconfined soft-policy composition; it is not an OS sandbox. '
    + 'Widening access requires a reason, which the tool records; no extra human approval is needed.\n',
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
  /** Change the display title; optional because a host may expose a read-only registry slice. */
  setTitle?(title: string): Promise<void>
}

/** The registry methods the workspace tool calls. */
export interface WorkspaceRegistryLike {
  list(): readonly WorkspaceLike[]
  create(path: string, title?: string): Promise<WorkspaceLike>
  /** Look one registration up by id; optional like every host-specific verb. */
  get?(id: string): WorkspaceLike | undefined
  /** Unregister one workspace without touching its directory or Session logs. */
  delete?(id: string): Promise<boolean>
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
  // The role is a file in the workspace, not only this capability's prompt section (DH-802).
  await ensureSuperWorkspaceDefinition(path)
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
    description: 'roster: list the registered workspaces with their directory status. orphans: list only '
      + 'registrations whose directory is missing. ensure: register a directory as one. remove: '
      + 'unregister a workspace (keeps its directory and Session logs; destructive). rename: change '
      + 'its display title.',
    enum: ['roster', 'orphans', 'ensure', 'remove', 'rename'],
  },
  path: { type: 'string', description: 'ensure: the directory to own, created when missing. Required for ensure.' },
  workspace: { type: 'string', description: 'remove/rename: the workspace id, title, or canonical path.' },
  title: { type: 'string', description: 'ensure/rename: the display title.' },
  confirm: {
    type: 'string',
    description: 'remove: required; repeat the target workspace id, title, or path exactly. The removal '
      + 'is irreversible for the registration (the directory and Session logs survive).',
  },
})

/**
 * `superagent_workspace`'s description.
 *
 * The `ensure` half writes outside the ledger, so it says what it will do to the filesystem and who
 * decides the path.
 */
export const WORKSPACE_DESCRIPTION =
  'Inspect or change the host\'s workspace list so a dispatch can name the checkout it works in. '
  + 'Use `roster`/`orphans` to find one. Ask the person which directory before `ensure` creates it. '
  + '`remove` unregisters through the live registry (never by editing a storage file), keeps its '
  + 'directory and Session logs, and requires `confirm` to repeat the target id, title or path. '
  + '`rename` changes only the display title. Never remove or rename the super workspace this Session '
  + 'runs in.'

/** The tool a super agent uses to run and steer real workspace Sessions (DH-719). */
export const SESSION_TOOL_NAME = 'superagent_session'

/** `superagent_session`'s schema. */
export const SESSION_PARAMETERS: Readonly<Record<string, FieldSpec>> = Object.freeze({
  action: {
    type: 'string',
    required: true,
    description: 'append: continue ONE of the workspace\'s Sessions with more work: with more than '
      + 'one candidate it refuses and lists them, so pass `session` (an id, or "latest" for the most '
      + 'recently updated) — never guess which conversation the work belongs to. start: open a NEW '
      + 'Session (pass `title` naming its purpose), only when the person asks for one, no existing '
      + 'Session matches the purpose, or the task is genuinely isolated. prompt: append to a Session '
      + 'the caller named. list: show one workspace\'s Sessions with title, model, context usage and '
      + 'last error. archive: hide one Session. fork: branch one Session. delete: erase '
      + 'one stored Session only when the host exposes a real delete API; current hosts do not, and '
      + 'the tool refuses instead of pretending. compact: compact the Session history now; it refuses '
      + 'while the Session runs (never interrupts a task). inspect: show a running Session\'s status and '
      + 'recent steps to judge whether it is stuck. stop: CUT OFF the running turn — cancel it '
      + 'immediately, admit no message, start no new turn; the Session ends idle and the result '
      + 'reports the scene it captured. abort: stop the running turn, THEN continue the Session with '
      + '`text` (the scene is reported); never substitute a plain message for stop.',
    enum: ['append', 'start', 'prompt', 'list', 'archive', 'fork', 'delete', 'compact', 'inspect', 'stop', 'abort'],
  },
  workspace: { type: 'string', description: 'append/start/list: the workspace path or title; prompt/archive/fork/delete use it for the report headline.' },
  task: { type: 'string', description: 'start: the self-contained task for that workspace agent.' },
  title: {
    type: 'string',
    description: 'start: the new Session\'s durable purpose title (e.g. "code review", "stop feature '
      + 'implementation"), so a later `list` tells the conversations apart at a glance.',
  },
  session: {
    type: 'string',
    description: 'prompt/append/archive/fork/delete/stop/abort: the Session id; append also accepts '
      + '"latest" for the workspace\'s most recently updated Session.',
  },
  text: { type: 'string', description: 'append/prompt: the follow-up instruction; abort: the instruction to run after aborting the running turn.' },
  confirm: { type: 'string', description: 'delete: required; repeat the target Session id exactly. Deletion is irreversible.' },
  provider: { type: 'string', description: 'start/append/prompt: optional LLM provider id; requires `model`. Check superagent_models first.' },
  model: { type: 'string', description: 'start/append/prompt: optional model id; requires `provider`.' },
  reasoning_effort: {
    type: 'string',
    description: 'start/append/prompt: adapter-owned reasoning effort; requires `provider` and '
      + '`model`. Mandatory when the chosen model advertises reasoning efforts — ask the person which '
      + 'one first; the tool refuses the bare route and lists the available efforts. Only the person\'s '
      + 'explicit "use the default" may pass the id `superagent_models` marks as default.',
  },
  atSeq: { type: 'number', description: 'fork: branch from this event seq; default the latest completed turn.' },
  compact: {
    type: 'boolean',
    description: 'append/prompt: compact this Session before admitting the text; refuses (and sends nothing) '
      + 'while the Session runs or when compaction fails. The super agent decides from list usage; nothing '
      + 'is compacted automatically.',
  },
  curate_memory: {
    type: 'boolean',
    description: 'append/start/prompt: prepend an instruction that makes the workspace Session curate its own '
      + 'memory (merge, expire, add conclusions) before the task. Memory stays per-workspace; this tool never '
      + 'writes another workspace\'s memory.',
  },
  delivery: {
    type: 'string',
    description: 'append/prompt: queue (default) waits for the running turn to end and admits the text as the '
      + 'next turn; interrupt steers the text into the running turn, so the Session sees it at its next step '
      + 'without aborting a tool call already in flight. An idle Session queues regardless. start does not '
      + 'take this option.',
    enum: ['queue', 'interrupt'],
  },
})

/** `superagent_session`'s description: what the verbs do and where the report goes. */
export const SESSION_DESCRIPTION =
  'Run work in a registered workspace as a real Session of its own. Use it for work owned by a '
  + 'workspace; list before choosing, reuse a matching Session by title and purpose, and never guess '
  + 'a route. `append` requires an explicit `session` (an id or "latest"); `start` only when no '
  + 'existing Session fits, the person asks for a new one, or the task is genuinely isolated. Every '
  + 'Session you address reports its completed, failed, or aborted turn back here as a new message. '
  + '`stop` cancels the running turn and starts nothing; `abort` cancels it and then sends `text` as '
  + 'the redirect; never use a message where a stop is meant. See the parameter descriptions for the '
  + 'per-action requirements.'

/** Model discovery for the super agent's workspace Sessions (DH-803). */
export const MODELS_TOOL_NAME = 'superagent_models'

/** `superagent_models`'s schema. */
export const MODELS_PARAMETERS: Readonly<Record<string, FieldSpec>> = Object.freeze({
  provider: { type: 'string', description: 'Registered LLM provider id; omit to list providers.' },
  model: { type: 'string', description: 'Exact model id; requires `provider`; omit to list that provider\'s models.' },
})

/** `superagent_models`'s description: same LLM registry the workspace Session uses. */
export const MODELS_DESCRIPTION =
  'List the LLM providers and models this deployment can route a workspace Session to. Omit both '
  + 'fields for providers, pass `provider` for its models, and provider + model for that model\'s '
  + 'reasoning efforts. This is the same `llm` registry `session.selectModel` validates against; '
  + 'subagent authorization policy does not apply to a workspace Session.'

/** One reasoning-effort row: id plus display name, marking the model's default. */
export interface AdvertisedEffort {
  readonly id: string
  readonly name: string
  readonly default?: boolean
}

/** One advertised model row as this tool returns it. */
interface AdvertisedModel {
  readonly provider: string
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly efforts: readonly AdvertisedEffort[]
}

/** The slice of the host LLM runtime used for discovery; duck-typed like every host seam. */
interface LlmLike {
  listProviders(): readonly { readonly id: string; readonly name: string }[]
  listModels(provider: string): Promise<readonly {
    readonly id: string
    readonly name: string
    readonly description?: string
    readonly reasoning?: {
      readonly defaultEffort?: string
      readonly efforts?: readonly { readonly id: string; readonly name: string }[]
    }
  }[]>
  resolveModelInfo?(provider: string, model: string, signal?: AbortSignal): Promise<{
    readonly id: string
    readonly name: string
    readonly description?: string
    readonly reasoning?: {
      readonly defaultEffort?: string
      readonly efforts?: readonly { readonly id: string; readonly name: string; readonly description?: string }[]
    }
  }>
}

/** Read the host LLM runtime, when this deployment has one. */
const llmOf = (ctx: unknown): LlmLike | undefined => {
  const get = (ctx as { get?: (key: string) => unknown } | undefined)?.get
  if (typeof get !== 'function') return undefined
  const service = get.call(ctx, 'llm') as Partial<LlmLike> | undefined
  if (service === undefined || typeof service.listProviders !== 'function' || typeof service.listModels !== 'function') {
    return undefined
  }
  return service as LlmLike
}

/** Render one provider/model row for the model-facing text. */
const modelLine = (model: AdvertisedModel): string => {
  const efforts = model.efforts.length === 0
    ? ''
    : ` [efforts: ${model.efforts.map(effort => `${effort.id} (${effort.name})${effort.default === true ? ', default' : ''}`).join(', ')}]`
  return `${model.provider}/${model.id} — ${model.name}${model.description === undefined ? '' : `: ${model.description}`}${efforts}`
}

/**
 * `superagent_models`: list providers, a provider's models, or one model's reasoning efforts.
 * @param args - the raw tool arguments, validated against {@link MODELS_PARAMETERS}.
 * @param options - the caller verdict.
 * @param me - the caller identity tuple.
 * @param ctx - the plugin context carrying `llm`.
 * @returns the advertised rows, or a refusal naming the layer that failed.
 */
export const runModelsTool = async (
  args: unknown,
  options: RunOptions,
  me: unknown,
  ctx: ToolHost['ctx'],
): Promise<ToolValue> => {
  const { caller } = options
  const validated = validateArgs(MODELS_PARAMETERS, args)
  if (!validated.ok) return failure(validated.error, caller, me)
  const llm = llmOf(ctx)
  if (llm === undefined) {
    return failure(invalidInput('this deployment has no LLM registry, so workspace Session models cannot be listed'), caller, me)
  }
  const providerId = asString(validated.value.provider)?.trim()
  const modelId = asString(validated.value.model)?.trim()
  if (modelId !== undefined && providerId === undefined) {
    return failure(invalidInput('`model` requires `provider`', { model: modelId }), caller, me)
  }
  try {
    if (providerId === undefined) {
      const providers = llm.listProviders().map(provider => Object.freeze({ id: provider.id, name: provider.name }))
      return Object.freeze({ ...verdictOf(caller, me), providers })
    }
    const provider = llm.listProviders().find(candidate => candidate.id === providerId)
    if (provider === undefined) {
      const available = llm.listProviders().map(candidate => candidate.id).join(', ') || '(none)'
      return failure(invalidInput(`LLM provider "${providerId}" is not registered; available providers: ${available}`, { provider: providerId }), caller, me)
    }
    if (modelId === undefined) {
      const models = (await llm.listModels(provider.id)).map(model => Object.freeze({
        provider: provider.id,
        id: model.id,
        name: model.name,
        ...(model.description === undefined ? {} : { description: model.description }),
        efforts: Object.freeze((model.reasoning?.efforts ?? []).map(effort => Object.freeze({
          id: effort.id,
          name: effort.name,
          ...(model.reasoning?.defaultEffort === effort.id ? { default: true } : {}),
        } satisfies AdvertisedEffort))),
      }))
      return Object.freeze({ ...verdictOf(caller, me), models: Object.freeze(models) })
    }
    if (llm.resolveModelInfo === undefined) {
      return failure(invalidInput('this deployment cannot resolve one model\'s reasoning efforts', { provider: providerId, model: modelId }), caller, me)
    }
    const info = await llm.resolveModelInfo(provider.id, modelId)
    const efforts = (info.reasoning?.efforts ?? []).map(effort => Object.freeze({
      id: effort.id,
      name: effort.name,
      ...(effort.description === undefined ? {} : { description: effort.description }),
      ...(info.reasoning?.defaultEffort === effort.id ? { default: true } : {}),
    }))
    return Object.freeze({
      ...verdictOf(caller, me),
      models: Object.freeze([{
        provider: provider.id,
        id: info.id,
        name: info.name,
        ...(info.description === undefined ? {} : { description: info.description }),
        efforts,
      }]),
    })
  } catch (error: unknown) {
    return failure(invalidInput(
      `the LLM registry refused ${providerId}/${String(modelId ?? '')}: ${error instanceof Error ? error.message : String(error)}`,
      { provider: providerId, ...(modelId === undefined ? {} : { model: modelId }) },
    ), caller, me)
  }
}

/** The common success envelope without a file or state payload. */
const verdictOf = (caller: Caller, me: unknown): ToolValue => Object.freeze({
  ok: true,
  writable: caller.writable,
  ...(caller.reason === undefined ? {} : { reason: caller.reason }),
  me,
})

/** The tool that records and updates the per-workspace dispatch ledger (DH-802). */
export const LEDGER_TOOL_NAME = 'superagent_ledger'

/** `superagent_ledger`'s schema. */
export const LEDGER_PARAMETERS: Readonly<Record<string, FieldSpec>> = Object.freeze({
  action: {
    type: 'string',
    required: true,
    description: 'list: read the dispatch ledger, optionally by workspace/status/query. record: append a '
      + 'pending task manually when automatic dispatch recording is unavailable. resolve: settle or '
      + 'correct the business result of an existing task id, including artifacts and open decisions. '
      + 'report_status: list failed or unsettled deliveries with reasons. retry_report: retry one saved failed report by id.',
    enum: ['list', 'record', 'resolve', 'report_status', 'retry_report'],
  },
  workspace: { type: 'string', description: 'record/list: the workspace id, title, or path.' },
  task: { type: 'string', description: 'record: the one-line task sent to the workspace.' },
  id: { type: 'string', description: 'resolve/retry_report: the task id returned by the dispatch or `record`.' },
  status: { type: 'string', enum: ['pending', 'returned', 'failed'], description: 'list: optional filter; resolve: returned or failed, never pending.' },
  outcome: { type: 'string', description: 'resolve: the conclusion; required when first settling a pending task and when correcting a failed result.' },
  decisions: { type: 'array', items: { type: 'string' }, description: 'resolve: unresolved decisions, one per array entry.' },
  artifacts: { type: 'array', items: { type: 'string' }, description: 'resolve: paths produced by the workspace.' },
  issue: { type: 'string', description: 'record/resolve: optional jira issue key this task references.' },
  query: { type: 'string', description: 'list: match task, outcome, workspace, artifact and decision text.' },
  limit: { type: 'number', description: 'list: maximum rows, default 20, maximum 100.' },
})

/** `superagent_ledger`'s description: structured dispatch state, separate from jira. */
export const LEDGER_DESCRIPTION =
  'Read and correct the super workspace\'s dispatch ledger. The ledger is the structured task truth: '
  + 'dispatch records `pending` automatically, and the child turn end records `returned`/`failed`; '
  + 'use `record` only as a manual fallback and `resolve` to add the conclusion, artifact paths and '
  + 'open decisions the automatic record could not know. The storage domain owns task results; '
  + 'Markdown under `.superagent/ledger/` is a human-readable projection, with a Markdown-only '
  + 'compatibility store when no domain is composed. Report delivery is separate: a task result does '
  + 'not prove its report reached the super Session. Use `report_status` to inspect failed deliveries '
  + 'and `retry_report` to resend the exact saved report after the recipient is available. The ledger '
  + 'references jira issue keys without '
  + 'copying issue state. `memory_write` '
  + 'is the separate durable conclusion layer: record the decision/open outcome there, not a copy of '
  + 'the ledger.'

/** One ledger write attempted next to a dispatch; failure never fails the dispatch itself. */
type LedgerAttempt = Readonly<{ ledger?: Readonly<{ root: string; task: DispatchLedgerTask }>; error?: string }>

/**
 * Record the pending entry for a dispatch. This is deliberately best-effort: a ledger write failure
 * is reported beside the dispatch result, but it must not silently lose a Session that did start.
 * @param caller - the dispatching session, whose cwd is the super workspace root.
 * @param workspace - the target workspace.
 * @param task - the instruction sent to the Session.
 * @param sessionId - the child Session id.
 * @param at - the dispatch instant, fixed-width UTC.
 * @param superSession - the receiving super Session, persisted for reload recovery.
 * @param store - the durable store, when the deployment composes one.
 * @param requestId - the prompt identity bound to this task, matched at turn end.
 * @param id - the task id already minted for the report binding, so both records share one identity.
 * @returns the recorded entry or the failure text.
 */
const recordTaskLedger = async (
  ctx: ToolHost['ctx'],
  caller: Caller,
  workspace: WorkspaceLike,
  task: string,
  sessionId: string,
  at: Timestamp,
  superSession?: string,
  store?: DispatchStore,
  requestId?: string,
  id?: string,
): Promise<LedgerAttempt> => {
  const root = caller.cwd
  if (root === undefined) return Object.freeze({ error: 'the caller has no checkout, so no ledger root is known' })
  const pending = pendingTask({
    ...(id === undefined ? {} : { id }),
    workspaceId: workspace.id,
    workspaceTitle: workspace.title,
    workspacePath: workspace.path,
    task,
    dispatchedAt: at,
    sessionId,
    ...(requestId === undefined ? {} : { requestId }),
  })
  if (store !== undefined) {
    try {
      const persisted = await store.record(pending, superSession)
      if (persisted !== undefined) return Object.freeze({ ledger: Object.freeze({ root, task: persisted.task }) })
    } catch (error: unknown) {
      ctx.logger.warn('superagent: durable dispatch record failed; falling back to Markdown: %s', String(error))
    }
  }
  try {
    const recorded = await recordDispatch(root, {
      id: workspace.id,
      title: workspace.title,
      path: workspace.path,
    }, {
      ...(id === undefined ? {} : { id }),
      task,
      dispatchedAt: at,
      sessionId,
      ...(requestId === undefined ? {} : { requestId }),
    })
    return Object.freeze({ ledger: Object.freeze({ root, task: recorded.task }) })
  } catch (error: unknown) {
    return Object.freeze({ error: `the dispatch ledger could not record the pending task: ${error instanceof Error ? error.message : String(error)}` })
  }
}

/** One report journal per super workspace root; a store serializes the writes it receives. */
const reportJournals = new Map<string, DispatchReportStore>()

/**
 * The report journal for one super workspace root, shared by the tools and the turn-end hook of
 * the same process. A fresh process builds a fresh instance over the same file, which is what makes
 * an in-flight dispatch recoverable after a plugin remount.
 * @param root - the super workspace root.
 * @returns the shared journal instance.
 */
const reportStoreAt = (root: string): DispatchReportStore => {
  const existing = reportJournals.get(root)
  if (existing !== undefined) return existing
  const created = new DispatchReportStore(root)
  reportJournals.set(root, created)
  return created
}

/**
 * Record the report binding for a dispatch **before** its child prompt is admitted.
 *
 * This is the superagent-owned half of a dispatch and deliberately has no ledger argument: the
 * child turn end matches its report through this record alone. The optional ledger coordinates are
 * carried as opaque data so the caller that owns the ledger can project the outcome there after
 * delivery, but a ledger write can never decide whether the report is sent.
 * @param context - the tool context carrying the configured journal, when wired.
 * @param caller - the dispatching session; its checkout is the journal root.
 * @param workspace - the target workspace.
 * @param task - the instruction sent to the child.
 * @param sessionId - the child Session id, known before the prompt.
 * @param at - the dispatch instant.
 * @param superSession - the receiving super Session, when the host names it.
 * @param requestId - the prompt identity bound into the child's first `user/message`.
 * @param id - the task id, shared with the ledger projection when one is written.
 * @returns the durable binding.
 */
const recordDispatchReport = async (
  context: SessionToolContext,
  caller: Caller,
  workspace: DispatchReportWorkspace,
  task: string,
  sessionId: string,
  at: Timestamp,
  superSession: string | undefined,
  requestId: string,
  id: string,
): Promise<DispatchReportRecord> => {
  const root = caller.cwd
  if (root === undefined) throw new Error('the dispatcher has no checkout, so the report journal has no root')
  const store = context.reports ?? reportStoreAt(root)
  return await store.record({
    id,
    workspace: { id: workspace.id, title: workspace.title, path: workspace.path },
    sessionId,
    ...(superSession === undefined || superSession === '' ? {} : { superSession }),
    requestId,
    task,
    dispatchedAt: at,
    // A follow-up may have no registered Workspace to write a ledger row into; the binding still
    // exists, and omitting the projection avoids a warning for a row that was never written.
    ...(workspace.id === '' ? {} : { ledger: { root, taskId: id } }),
  })
}

/**
 * Record a dispatch whose prompt admission failed, so the failed attempt is not left pending.
 * @param context - the tool context carrying the journal.
 * @param caller - the dispatching session.
 * @param id - the task id the binding was recorded under.
 * @param at - the failure instant.
 * @param error - the prompt or creation failure.
 */
const failDispatchReport = async (
  context: SessionToolContext,
  caller: Caller,
  id: string,
  at: Timestamp,
  error: unknown,
): Promise<void> => {
  const root = caller.cwd
  if (root === undefined) return
  try {
    await (context.reports ?? reportStoreAt(root)).settle(id, 'failed', at, error instanceof Error ? error.message : String(error))
  } catch {
    // The tool already returns the dispatch failure; a journal write failure must not mask it.
  }
}

/**
 * Resolve the ledger entry when a dispatched child finishes: the hook sees this even though the
 * report is delivered as a new message in the super conversation.
 *
 * A turn bound by its own prompt may correct an earlier misattributed result. `project: false`
 * records the business result without writing the human projection before report delivery.
 * @param record - the task bookkeeping captured at dispatch.
 * @param text - the child's last assistant text, when it produced one.
 * @param at - the turn-end instant.
 * @param store - the durable store, when the deployment composes one.
 * @param options - whether to append the human-readable projection.
 * @returns after the outcome section is appended; a record without a ledger is a no-op.
 */
export const resolveReportedTask = async (
  record: TaskSessionRecord,
  text: string | undefined,
  at: Timestamp,
  store?: DispatchStore,
  options: { readonly project?: boolean } = {},
): Promise<void> => {
  if (record.ledger === undefined) return
  const patch = {
    status: 'returned' as const,
    updatedAt: at,
    outcome: text ?? 'The child turn ended without assistant text.',
  }
  if (store !== undefined) {
    const resolved = await store.resolve(record.ledger.task.id, patch, options)
    if (resolved !== undefined || options.project === false) return
  }
  const current = record.ledger.task
  if (options.project === false) return
  if (current.status === patch.status && current.outcome === patch.outcome) return
  await resolveDispatchTask(record.ledger.root, current, patch)
}

/** Add the ledger fields to a dispatch result without hiding a ledger failure. */
const withLedger = (value: ToolValue, attempt: LedgerAttempt): ToolValue => Object.freeze({
  ...value,
  ...(attempt.ledger === undefined ? {} : {
    ledger: Object.freeze({
      taskId: attempt.ledger.task.id,
      directory: join(attempt.ledger.root, '.superagent', 'ledger'),
      file: join(attempt.ledger.root, '.superagent', 'ledger', `${attempt.ledger.task.workspaceId}.md`),
    }),
  }),
  ...(attempt.error === undefined ? {} : { ledgerError: attempt.error }),
})

/** One Session a super agent started or addressed, so its report can be routed back. */
export interface TaskSessionRecord {
  /** The super agent Session that receives the report. */
  readonly superSession: string
  /** The workspace the Session works in, for the report headline. */
  readonly workspace: string
  /** The report binding id, named in the report headline. */
  readonly taskId?: string
  /** The structured dispatch entry this turn will resolve, when the ledger recorded one. */
  readonly ledger?: Readonly<{ root: string; task: DispatchLedgerTask }>
  /**
   * The prompt request identity (`requestId`) of the message that carried this task.
   *
   * The accepted `user/message` echoes it as `source.rpcId`, so a turn end matches the task by the
   * turn's own prompt instead of the Session's newest task. Records from older deployments lack it
   * and fall back to FIFO.
   */
  readonly requestId?: string
  /** The Session's context usage measured just before its task was admitted (DH-720). */
  readonly usageBefore?: ContextUsage
  /** Exact report saved in the journal for an explicit retry after a failed delivery. */
  readonly reportText?: string
}

/** What one superagent_session call needs beyond the shared run options. */
export interface SessionToolContext {
  /** The configured preset a started Session joins; unset keeps the deployment default. */
  readonly agentPreset?: string
  /**
   * Sessions this super agent addressed, in dispatch order per Session.
   *
   * A Session can hold several queued dispatches, so the value is a FIFO list: overwriting a single
   * record is what routed a later task's id onto an earlier turn's report.
   */
  readonly tasks: Map<string, readonly TaskSessionRecord[]>
  /** Durable dispatch store; absent means the Markdown-only compatibility path. */
  readonly store?: DispatchStore
  /**
   * Superagent-owned report bindings. The tool records a binding here **before** admitting the
   * child prompt, so the turn-end hook can match the turn to its task without consulting the jira
   * ledger. Absent only in a bare test composition; production wiring always passes it.
   */
  readonly reports?: DispatchReportStore
  /** Context percentage at which a list row suggests compacting; a suggestion, never enforcement. */
  readonly compactThresholdPercent?: number
  /** Minutes a running Session may run before the monitor names it (a suggestion, default 10). */
  readonly longRunningMinutes?: number
}

/** The newest dispatch record for a Session, if it has one. */
const lastTaskRecord = (
  tasks: Map<string, readonly TaskSessionRecord[]>,
  sessionId: string,
): TaskSessionRecord | undefined => tasks.get(sessionId)?.at(-1)

/** Append one dispatch record to a Session's FIFO queue; queued dispatches never overwrite. */
const enqueueTaskRecord = (
  tasks: Map<string, readonly TaskSessionRecord[]>,
  sessionId: string,
  record: TaskSessionRecord,
): void => {
  const queue = tasks.get(sessionId) ?? []
  tasks.set(sessionId, Object.freeze([...queue, Object.freeze(record)]))
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
    providers: { type: 'array' },
    models: { type: 'array' },
    workspace: { type: 'object', additionalProperties: true },
    ledger: { type: 'object', additionalProperties: true },
    ledgerError: { type: 'string' },
    entries: { type: 'array' },
    task: { type: 'object', additionalProperties: true },
    file: { type: 'string' },
    memory: { type: 'object', additionalProperties: true },
    removed: { type: 'boolean' },
    renamed: { type: 'boolean' },
    directoryKept: { type: 'boolean' },
    sessionsKept: { type: 'boolean' },
    sessions: { type: 'array' },
    session: { type: 'object', additionalProperties: true },
    delivered: { type: 'object', additionalProperties: true },
    usage: { type: 'object', additionalProperties: true },
    compaction: { type: 'object', additionalProperties: true },
    delivery: { type: 'object', additionalProperties: true },
    status: { type: 'object', additionalProperties: true },
    activity: { type: 'array' },
    abort: { type: 'object', additionalProperties: true },
    longRunningMinutes: { type: 'number' },
    longRunning: { type: 'boolean' },
    model: { type: 'object', additionalProperties: true },
    permission: { type: 'object', additionalProperties: true },
    presets: { type: 'array' },
    defaultPreset: { type: 'string' },
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
/** One roster row; `status` never hides a broken directory behind a thrown probe. */
const workspaceRowOf = async (workspace: WorkspaceLike): Promise<Readonly<Record<string, unknown>>> => {
  let status: string
  try {
    status = await workspace.status()
  } catch {
    status = 'unknown'
  }
  return Object.freeze({
    id: String(workspace.id),
    path: workspace.path,
    title: workspace.title,
    status,
    sessions: workspace.sessionIds.length,
  })
}

/** Whether the target is the workspace this very Session lives in. */
const isCurrentWorkspace = (workspace: WorkspaceLike, caller: Caller): boolean =>
  caller.cwd !== undefined && sameCheckout(workspace.path, caller.cwd)

/**
 * `superagent_workspace`: list, create, unregister, rename, or find orphaned registrations.
 * @param args - the raw tool arguments, validated against `WORKSPACE_PARAMETERS`.
 * @param options - the store, caller verdict and clock for this run.
 * @param me - the caller's identity tuple, returned in every result.
 * @param ctx - the plugin context the workspace registry is read from.
 * @returns the roster, the orphan list, or the changed/registered workspace.
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

  if (action === 'roster' || action === 'orphans') {
    const rows = await Promise.all(registry.list().map(workspaceRowOf))
    const workspaces = action === 'orphans'
      ? rows.filter(row => row.status === 'missing-dir')
      : rows
    return Object.freeze({ ...verdict, workspaces: Object.freeze(workspaces) })
  }

  if (!caller.writable) {
    return failure(invalidInput(`${action} needs a session that may write`), caller, me)
  }

  if (action === 'ensure') {
    const path = asString(validated.value.path)
    if (path === undefined || path.trim() === '') return failure(invalidInput('ensure needs `path`'), caller, me)
    try {
      // `create` owns an existing directory, so the tool creates it first; both halves are idempotent.
      await mkdir(path, { recursive: true })
      const workspace = await registry.create(path, asString(validated.value.title))
      return Object.freeze({
        ...verdict,
        workspace: Object.freeze({
          ...(await workspaceRowOf(workspace)),
          // The canonical path, not the argument: that is what a dispatched session's cwd must be.
          path: workspace.path,
        }),
      })
    } catch (error: unknown) {
      return failure(invalidInput(`${path} could not be registered as a workspace: ${error instanceof Error ? error.message : String(error)}`, { path }), caller, me)
    }
  }

  const selector = asString(validated.value.workspace)
  const workspace = selector === undefined ? undefined : findWorkspace(registry, selector)
  if (workspace === undefined) {
    return failure(invalidInput(`"${String(selector ?? '')}" is not a registered workspace; run superagent_workspace roster first`), caller, me)
  }
  // The workspace that hosts this Session is the dispatcher's own home: unregistering or even
  // renaming it would make the running role disappear. The title check is a second guard for a
  // caller that reaches here through a host without a cwd on the caller.
  if (isCurrentWorkspace(workspace, caller) || workspace.title === SUPERAGENT_WORKSPACE_TITLE) {
    return failure(invalidInput(
      `cannot ${action} "${workspace.title}": it is the workspace this Session runs in (the super workspace)`,
      { workspace: workspace.path },
    ), caller, me)
  }

  if (action === 'remove') {
    const confirm = asString(validated.value.confirm)
    if (confirm === undefined || ![workspace.id, workspace.title, workspace.path].includes(confirm.trim())) {
      return failure(invalidInput(
        `remove needs \`confirm\` to repeat the workspace id, title, or path exactly; got ${String(confirm ?? 'nothing')}`,
        { workspace: workspace.path, accepted: [workspace.id, workspace.title, workspace.path] },
      ), caller, me)
    }
    if (registry.delete === undefined) {
      return failure(invalidInput('this host has no workspace delete, so the registration cannot be removed here'), caller, me)
    }
    try {
      const removed = await registry.delete(workspace.id)
      if (!removed) {
        return failure(invalidInput(`the registry no longer knows "${workspace.title}"; nothing was removed`, { workspace: workspace.path }), caller, me)
      }
      return Object.freeze({
        ...verdict,
        removed: true,
        directoryKept: true,
        sessionsKept: true,
        workspace: Object.freeze({
          ...(await workspaceRowOf(workspace)),
          removed: true,
          directoryKept: true,
          sessionsKept: true,
        }),
      })
    } catch (error: unknown) {
      return failure(invalidInput(
        `"${workspace.title}" could not be unregistered: ${error instanceof Error ? error.message : String(error)}`,
        { workspace: workspace.path },
      ), caller, me)
    }
  }

  if (action === 'rename') {
    const title = asString(validated.value.title)
    if (title === undefined || title.trim() === '') {
      return failure(invalidInput('rename needs `title`: the new display title'), caller, me)
    }
    if (workspace.setTitle === undefined) {
      return failure(invalidInput('this host exposes no workspace title change'), caller, me)
    }
    try {
      await workspace.setTitle(title.trim())
      return Object.freeze({
        ...verdict,
        renamed: true,
        workspace: Object.freeze({ ...(await workspaceRowOf(workspace)), renamed: true }),
      })
    } catch (error: unknown) {
      return failure(invalidInput(
        `"${workspace.title}" could not be renamed: ${error instanceof Error ? error.message : String(error)}`,
        { workspace: workspace.path },
      ), caller, me)
    }
  }

  return failure(invalidInput(`unknown action "${String(action)}"`), caller, me)
}

/**
 * The registered workspaces a super-agent session may hand files to.
 *
 * This is the capability's contribution to the filesystem fence's fs-only grant, not to process
 * confinement: the super agent delivers materials (reports, spreadsheets, user attachments) into a
 * workspace for that workspace's Session to parse, and shell sandboxes stay as narrow as before.
 * Only registered workspaces are eligible; an entry is skipped when it is missing, is not a
 * directory, or is spelled through a symlink — a grant must name the physical directory the person
 * registered, and a workspace that disappeared must not break every later write.
 * @param ctx - the plugin context carrying the workspace registry.
 * @param session - the session whose policy is being resolved.
 * @param home - the configured super workspace path; only sessions there receive the grant.
 * @returns the physical registered workspace directories, or undefined for other sessions.
 */
export const superAgentFsRoots = (ctx: unknown, session: unknown, home: string | undefined): readonly string[] | undefined => {
  if (home === undefined || home.trim() === '') return undefined
  const cwd = (session as { header?: { cwd?: string } } | undefined)?.header?.cwd
  if (cwd === undefined || !sameCheckout(cwd, home)) return undefined
  const registry = workspaceRegistryOf(ctx)
  if (registry === undefined) return undefined
  const roots: string[] = []
  for (const workspace of registry.list()) {
    if (sameCheckout(workspace.path, home)) continue
    const physical = physicalDirectory(workspace.path)
    if (physical !== undefined && !roots.includes(physical)) roots.push(physical)
  }
  return roots.length === 0 ? undefined : Object.freeze(roots)
}

/**
 * The physical path of an existing directory, or undefined when it cannot be granted.
 * @param path - candidate directory, as the registry spells it.
 * @returns the canonical physical path when the entry is a plain directory.
 */
const physicalDirectory = (path: string): string | undefined => {
  if (path.trim() === '' || !isAbsolute(path) || path.includes('\0')) return undefined
  try {
    const physical = realpathSync.native(path)
    if (!statSync(physical).isDirectory()) return undefined
    // A symlinked spelling would silently follow a link the person did not register.
    return resolve(path) === physical ? physical : undefined
  } catch {
    return undefined
  }
}

/** Whether `candidate` resolves to a path strictly inside `root` (both physical). */
const insidePhysicalRoot = (root: string, candidate: string): boolean => {
  const relativeToRoot = relative(root, candidate)
  return relativeToRoot !== '' && !relativeToRoot.startsWith('..') && !isAbsolute(relativeToRoot)
}

/**
 * The deepest existing ancestor of one path, canonicalized; used to prove that a destination
 * spelled through a symlinked directory still lands inside the granted workspace.
 * @param path - an absolute destination path whose leaf may not exist yet.
 * @returns the physical existing ancestor.
 */
const existingAncestor = (path: string): string => {
  let cursor = path
  for (;;) {
    if (existsSync(cursor)) return realpathSync.native(cursor)
    const parent = dirname(cursor)
    if (parent === cursor) return parent
    cursor = parent
  }
}

/** `superagent_deliver`'s schema. */
export const DELIVER_TOOL_NAME = 'superagent_deliver'

/** `superagent_deliver`'s parameters. */
export const DELIVER_PARAMETERS: Readonly<Record<string, FieldSpec>> = Object.freeze({
  source: {
    type: 'string',
    required: true,
    description: 'Absolute path of the file to hand over. Files the person attached under '
      + '$DSH_HOME/attachments are readable too.',
  },
  workspace: { type: 'string', required: true, description: 'The registered workspace path or title to deliver into.' },
  destination: { type: 'string', description: 'Path inside the workspace; defaults to the source file name.' },
  overwrite: { type: 'boolean', description: 'Replace an existing destination file; default false.' },
})

/** `superagent_deliver`'s description: the one write the super agent performs in a workspace. */
export const DELIVER_DESCRIPTION =
  'Hand one local file to a registered workspace by copying it into that workspace\'s directory. '
  + 'Use it for material the workspace\'s Session should parse (a report, xlsx/csv, an attachment '
  + 'the person dropped here) instead of reading that material in the super conversation. The '
  + 'destination must stay inside the workspace; the copy never overwrites unless `overwrite` is true.'

/**
 * Deliver one local file into a registered workspace.
 *
 * The copy happens in the host process, so it does not need (or grant) a process sandbox; the
 * authority is the narrower one this function enforces: the destination must be a registered
 * workspace, must stay inside its physical directory (no `..`, no symlinked parent), and an existing
 * file is replaced only on request. Missing sources, workspaces and directories are reported, never
 * thrown as a crash.
 * @param args - the raw tool arguments, validated against {@link DELIVER_PARAMETERS}.
 * @param options - the caller verdict.
 * @param me - the caller identity tuple.
 * @param ctx - the plugin context carrying the workspace registry.
 * @returns the delivered path and byte count.
 */
export const runDeliverTool = async (
  args: unknown,
  options: RunOptions,
  me: unknown,
  ctx: unknown,
): Promise<ToolValue> => {
  const { caller } = options
  const validated = validateArgs(DELIVER_PARAMETERS, args)
  if (!validated.ok) return failure(validated.error, caller, me)
  if (!caller.writable) {
    return failure(invalidInput('delivering a file needs a session that may write'), caller, me)
  }
  const source = asString(validated.value.source)
  const workspaceArg = asString(validated.value.workspace)
  const destinationArg = asString(validated.value.destination)
  const overwrite = validated.value.overwrite === true
  if (source === undefined || !isAbsolute(source)) {
    return failure(invalidInput('deliver needs an absolute `source` path'), caller, me)
  }
  const registry = workspaceRegistryOf(ctx)
  if (registry === undefined) {
    return failure(invalidInput('this deployment has no workspace registry to deliver into'), caller, me)
  }
  const workspace = workspaceArg === undefined ? undefined : findWorkspace(registry, workspaceArg)
  if (workspace === undefined) {
    return failure(invalidInput(`"${String(workspaceArg ?? '')}" is not a registered workspace; run superagent_workspace roster first`), caller, me)
  }
  const workspaceRoot = physicalDirectory(workspace.path)
  if (workspaceRoot === undefined) {
    return failure(invalidInput(`${workspace.path} is not an existing directory any more`, { workspace: workspace.path }), caller, me)
  }
  let sourceInfo: ReturnType<typeof statSync>
  try {
    sourceInfo = statSync(source)
  } catch (error: unknown) {
    return failure(invalidInput(`the source ${source} cannot be read: ${error instanceof Error ? error.message : String(error)}`), caller, me)
  }
  if (!sourceInfo.isFile()) {
    return failure(invalidInput(`the source ${source} is not a regular file`), caller, me)
  }
  const destination = resolve(workspaceRoot, destinationArg ?? basename(source))
  if (!insidePhysicalRoot(workspaceRoot, destination)) {
    return failure(invalidInput(`the destination must stay inside ${workspace.path}`, { workspace: workspace.path }), caller, me)
  }
  // Prove the existing part of the destination is still inside the physical workspace, so a
  // symlinked directory cannot redirect the copy outside it.
  const destinationAncestor = existingAncestor(destination)
  if (destinationAncestor !== workspaceRoot && !insidePhysicalRoot(workspaceRoot, destinationAncestor)) {
    return failure(invalidInput(`the destination resolves outside ${workspace.path}`, { workspace: workspace.path }), caller, me)
  }
  try {
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(source, destination, overwrite ? 0 : 1)
    const bytes = statSync(destination).size
    return Object.freeze({
      ok: true,
      writable: caller.writable,
      ...(caller.reason === undefined ? {} : { reason: caller.reason }),
      me,
      delivered: Object.freeze({
        source,
        path: destination,
        workspace: workspace.path,
        title: workspace.title,
        bytes,
      }),
    })
  } catch (error: unknown) {
    return failure(invalidInput(
      `the file could not be delivered to ${destination}: ${error instanceof Error ? error.message : String(error)}`,
      { workspace: workspace.path },
    ), caller, me)
  }
}

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
  return rows.find(row => row.id === value)
    ?? rows.find(row => row.title === value)
    ?? rows.find(row => row.path === value)
    ?? rows.find(row => sameCheckout(row.path, value))
}

/** The optional model route requested by one Session action. */
interface SessionModelChoice {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/**
 * Read the three model-facing fields. They are all optional, but an explicit choice must name both
 * provider and model; effort alone is meaningless, matching the subagent tool's contract.
 * @param values - the validated tool arguments.
 * @returns the choice, or the argument error.
 */
const modelChoiceOf = (values: Readonly<Record<string, unknown>>): Readonly<{ choice?: SessionModelChoice; error?: string }> => {
  const provider = asString(values.provider)
  const model = asString(values.model)
  const reasoningEffort = asString(values.reasoning_effort)
  if (provider === undefined && model === undefined && reasoningEffort === undefined) return Object.freeze({})
  if (provider === undefined || model === undefined) {
    return Object.freeze({ error: '`provider` and `model` must be supplied together' })
  }
  if (provider.trim() === '' || model.trim() === '') {
    return Object.freeze({ error: '`provider` and `model` must be non-empty' })
  }
  if (reasoningEffort !== undefined && reasoningEffort.trim() === '') {
    return Object.freeze({ error: '`reasoning_effort` must be non-empty when supplied' })
  }
  return Object.freeze({
    choice: Object.freeze({
      provider: provider.trim(),
      model: model.trim(),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort: reasoningEffort.trim() }),
    }),
  })
}

/** The chosen route a Session action accepted, echoed back to the caller. */
export interface AcceptedModel {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
  /** True when the host resolved a different route than requested. */
  readonly fallback: boolean
  /** True when the route change was recorded while a turn runs and lands at the next boundary. */
  readonly deferred?: boolean
}

/**
 * The reasoning efforts one model advertises, when the host's LLM registry can resolve them.
 * @param ctx - the plugin context carrying `llm`.
 * @param choice - the requested route.
 * @returns the effort list with the model's default marked, or undefined when unresolvable.
 */
const effortsFor = async (
  ctx: unknown,
  choice: SessionModelChoice,
): Promise<readonly AdvertisedEffort[] | undefined> => {
  const llm = llmOf(ctx)
  if (llm?.resolveModelInfo === undefined) return undefined
  try {
    const info = await llm.resolveModelInfo(choice.provider, choice.model)
    const efforts = info.reasoning?.efforts ?? []
    if (efforts.length === 0) return undefined
    return Object.freeze(efforts.map(effort => Object.freeze({
      id: effort.id,
      name: effort.name,
      ...(info.reasoning?.defaultEffort === effort.id ? { default: true } : {}),
    })))
  } catch {
    return undefined
  }
}

/**
 * One failure of a tool action, in the same envelope a success uses: `failure(...)` needs a caller
 * verdict, so the guard checks that never ran (a thrown middleware before validation) still report.
 *
 * `me` is mandatory: the tool's output schema requires `ok`, `writable` and `me` on every result,
 * and the registry throws `ToolOutputError` when a value omits one of them.
 * @param message - the readable failure.
 * @param me - the caller identity tuple the output schema requires.
 * @param details - machine-readable context beside the message.
 * @returns the frozen failed envelope.
 */
export const sessionActionFailure = (message: string, me: unknown, details?: Readonly<Record<string, unknown>>): ToolValue =>
  Object.freeze({
    ok: false,
    error: invalidInput(message, details ?? {}),
    writable: false,
    me,
  })

/**
 * Apply a requested route to an existing Session before its next prompt. The host's
 * `selectModel` writes `model/selection`; the next turn's request header uses it. This is why
 * append/prompt can switch models without forking — and why a switch recorded mid-turn never
 * touches the running turn's requests (the loop reads the selection at the next step/turn
 * preparation, so a mid-turn selection lands at the following turn boundary).
 *
 * A model that advertises reasoning efforts must not be entered silently on its default: the
 * caller chooses an effort explicitly, or the route is refused with the available list.
 * @param controller - the host Session controller.
 * @param sessionId - the Session whose next turn is being addressed.
 * @param values - validated tool arguments.
 * @param ctx - the plugin context, for the LLM registry's effort list.
 * @param running - whether the Session's turn is currently open (marks the echo deferred).
 * @returns the selected model, or the layer that refused it.
 */
const applySessionModel = async (
  controller: SessionControllerLike,
  sessionId: string,
  values: Readonly<Record<string, unknown>>,
  ctx?: unknown,
  running = false,
): Promise<Readonly<{ model?: AcceptedModel; error?: string; errorDetails?: Readonly<Record<string, unknown>> }>> => {
  const parsed = modelChoiceOf(values)
  if (parsed.error !== undefined) return Object.freeze({ error: parsed.error })
  if (parsed.choice === undefined) return Object.freeze({})
  const choice = parsed.choice
  const efforts = await effortsFor(ctx, choice)
  if (efforts !== undefined) {
    const available = Object.freeze(efforts.map(effort => `${effort.id} (${effort.name})${effort.default === true ? ', default' : ''}`))
    if (choice.reasoningEffort === undefined) {
      return Object.freeze({
        error: `${choice.provider}/${choice.model} advertises reasoning efforts, so name one with `
          + '`reasoning_effort` — ask the person which effort they want (the model default applies '
          + 'only when they explicitly ask for it)',
        errorDetails: Object.freeze({ provider: choice.provider, model: choice.model, availableEfforts: available }),
      })
    }
    if (!efforts.some(effort => effort.id === choice.reasoningEffort)) {
      return Object.freeze({
        error: `"${choice.reasoningEffort}" is not a reasoning effort of ${choice.provider}/${choice.model}`,
        errorDetails: Object.freeze({ provider: choice.provider, model: choice.model, availableEfforts: available }),
      })
    }
  }
  if (controller.selectModel === undefined) {
    return Object.freeze({ error: 'this host exposes no Session model-selection API, so the requested model cannot be applied' })
  }
  try {
    const selected = await controller.selectModel({
      sessionId,
      provider: choice.provider,
      model: choice.model,
      ...(choice.reasoningEffort === undefined ? {} : { reasoningEffort: choice.reasoningEffort }),
    })
    const accepted = selected.selected
    // The host may resolve a different route than the one requested; surface that instead of
    // echoing the request as if it had landed.
    const fallback = accepted.provider !== choice.provider
      || accepted.model !== choice.model
      || (accepted.reasoningEffort ?? '') !== (choice.reasoningEffort ?? '')
    return Object.freeze({
      model: Object.freeze({ ...accepted, fallback, ...(running ? { deferred: true } : {}) }),
    })
  } catch (error: unknown) {
    return Object.freeze({
      error: `the host rejected the model selection (${choice.provider}/${choice.model}): ${error instanceof Error ? error.message : String(error)}`,
    })
  }
}

/** One Session's context pressure as a percentage of its window, when the host can read it. */
export interface ContextUsage {
  readonly tokens?: number
  readonly window?: number
  readonly percent?: number
}

/** The slice of the host token meter this capability reads. */
interface TokenMeterLike {
  contextPressure(session: unknown): { pressureTokens?: number; contextWindow?: number }
}

/** The slice of the host compaction seam this capability drives. */
interface CompactionLike {
  compactNow(agent: unknown, signal: AbortSignal): Promise<{ readonly shadowedTokenCount?: number } | null>
}

/** The slice of the host agent registry this capability reads; it holds live Sessions only. */
interface AgentsLike {
  get(id: string): unknown
  list?(): readonly unknown[]
}

/** Read the host token meter when the deployment mounts one. */
const tokenMeterOf = (ctx: unknown): TokenMeterLike | undefined => {
  const get = (ctx as { get?: (key: string) => unknown } | undefined)?.get
  const service = typeof get === 'function' ? get.call(ctx, 'tokenMeter') as Partial<TokenMeterLike> | undefined : undefined
  return service !== undefined && typeof service.contextPressure === 'function' ? service as TokenMeterLike : undefined
}

/** Read the host compaction seam when the deployment mounts one. */
const compactionOf = (ctx: unknown): CompactionLike | undefined => {
  const get = (ctx as { get?: (key: string) => unknown } | undefined)?.get
  const service = typeof get === 'function' ? get.call(ctx, 'compaction') as Partial<CompactionLike> | undefined : undefined
  return service !== undefined && typeof service.compactNow === 'function' ? service as CompactionLike : undefined
}

/** Read the host agent registry when the deployment mounts one. */
const agentsOf = (ctx: unknown): AgentsLike | undefined => {
  const get = (ctx as { get?: (key: string) => unknown } | undefined)?.get
  const service = typeof get === 'function' ? get.call(ctx, 'agents') as Partial<AgentsLike> | undefined : undefined
  return service !== undefined && typeof service.get === 'function' ? service as AgentsLike : undefined
}

/**
 * Read one Session's context usage. An absent field stays absent: without both the measured tokens
 * and the routed window there is no honest percentage to report, and inventing a denominator would
 * turn "unknown" into a misleading suggestion.
 * @param meter - the host token meter, when mounted.
 * @param session - the live Session to read.
 * @returns the usage, or undefined when the host cannot measure it.
 */
export const contextUsageOf = (meter: TokenMeterLike | undefined, session: unknown): ContextUsage | undefined => {
  if (meter === undefined || session === undefined) return undefined
  const { pressureTokens, contextWindow } = meter.contextPressure(session)
  if (pressureTokens === undefined || contextWindow === undefined || contextWindow <= 0) return undefined
  return Object.freeze({
    tokens: pressureTokens,
    window: contextWindow,
    percent: Math.min(100, Math.round(pressureTokens / contextWindow * 100)),
  })
}

/**
 * Render the report's context marker. A compaction shows both sides; otherwise the single
 * measurement is enough.
 * @param before - usage before compaction or task admission.
 * @param after - usage at turn end.
 * @returns '' when neither side is measurable, else a parenthesized marker.
 */
const contextMarker = (before?: ContextUsage, after?: ContextUsage): string => {
  const text = (usage?: ContextUsage): string | undefined => usage?.percent === undefined ? undefined : `${usage.percent}%`
  const from = text(before)
  const to = text(after)
  if (from === undefined && to === undefined) return ''
  if (from !== undefined && to !== undefined && from !== to) return ` (context ${from} → ${to})`
  return ` (context ${to ?? from})`
}

/** The standing instruction handed to a workspace Session that should curate its own memory first. */
export const MEMORY_CURATION_INSTRUCTION =
  'Before starting: curate this workspace\'s memory. Read the memory entries and summaries '
  + '(`memory_search` / `memory_read`), merge duplicates, mark what is stale, and add one line for a '
  + 'missing durable conclusion. Memory is per-workspace: do not read or write another workspace\'s '
  + 'memory. Then do the following work.\n\n'

/**
 * Prepend the curation instruction when the caller asked for it. The instruction is delivered as
 * ordinary prompt text so the workspace agent uses its own tools on its own memory store; this
 * capability never writes another workspace's `.dsh/memory`.
 * @param text - the caller's task text.
 * @param curate - whether the caller asked for memory curation first.
 * @returns the text to admit.
 */
const composeTask = (text: string, curate: boolean): string => curate ? MEMORY_CURATION_INSTRUCTION + text : text

/**
 * The durable seq of the newest user message on a Session's log: where an admitted instruction
 * landed. Best-effort — the host may not expose a live Session, in which case the field is absent.
 * @param ctx - the plugin context carrying the agent registry.
 * @param sessionId - the Session that just accepted the instruction.
 * @returns the newest `user/message` seq, or undefined.
 */
const insertionSeqOf = (ctx: unknown, sessionId: string): number | undefined => {
  const agent = agentsOf(ctx)?.get(sessionId) as
    | { session?: { snapshotEvents?: () => readonly { type?: string; seq?: number }[] } }
    | undefined
  const events = agent?.session?.snapshotEvents?.() ?? []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'user/message' && typeof event.seq === 'number') return event.seq
  }
  return undefined
}

/** One Session's live status, derived from its durable event log (DH-722). */
export interface SessionActivity {
  /** Whether a turn is open (the last `turn/start` is newer than the last `turn/end`). */
  readonly running: boolean
  /** When the open turn started, epoch ms; absent when idle. */
  readonly turnStartedAt?: number
  /** How long the open turn has run, ms; absent when idle. */
  readonly elapsedMs?: number
  /** When the most recent event was appended, epoch ms. */
  readonly lastActivityAt?: number
  /** How long ago that was, ms. */
  readonly lastActivityAgeMs?: number
  /** The most recent `tool/call` name. */
  readonly lastTool?: string
  /** The `tool/call` still waiting for its result, when one is. */
  readonly inFlightTool?: string
  /** The most recent tool failure's reason, when one failed. */
  readonly lastError?: string
  /** The most recent assistant text, truncated for diagnosis. */
  readonly lastAssistantText?: string
}

/** The event slice this capability reads; duck-typed so older hosts keep working. */
interface SessionEventLike {
  readonly type?: string
  readonly seq?: number
  readonly time?: number
  readonly data?: unknown
}

/** A live Agent's session as far as the monitor reads it. */
interface LiveSessionLike {
  snapshotEvents?: () => readonly SessionEventLike[]
}

/** Read the durable events of a live Agent's session, when it exposes them. */
const eventsOf = (agent: unknown): readonly SessionEventLike[] => {
  const session = (agent as { session?: LiveSessionLike } | undefined)?.session
  return session?.snapshotEvents?.() ?? []
}

/** The last event of one type, scanning backwards. */
const lastEventOf = (events: readonly SessionEventLike[], type: string): SessionEventLike | undefined => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === type) return events[index]
  }
  return undefined
}

/**
 * The event range of one finished turn: the matching `turn/start` (exclusive) and the `turn/end`
 * event (exclusive upper bound).
 *
 * Reading a turn's own slice is what keeps a later turn's assistant text from being attributed to
 * an earlier one when the log already contains it. Without a turn number (a duck-typed host), the
 * whole log below the end event is used.
 * @param events - the Session snapshot.
 * @param turn - the ending turn number, when known.
 * @param endEvent - the committed `turn/end` event, for its identity and seq.
 * @returns indexes into `events`; `lower` is -1 when no matching start is visible.
 */
const turnBounds = (
  events: readonly SessionEventLike[],
  turn: number | undefined,
  endEvent: unknown,
): Readonly<{ lower: number; upper: number }> => {
  const endSeq = (endEvent as { seq?: number } | undefined)?.seq
  const endTurn = (endEvent as { data?: { turn?: number } } | undefined)?.data?.turn ?? turn
  let upper = endSeq === undefined ? events.length : events.findIndex(event => event.seq === endSeq)
  if (upper < 0) upper = events.length
  let lower = -1
  let untagged = -1
  for (let index = upper - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'turn/start') continue
    const eventTurn = (event.data as { turn?: number } | undefined)?.turn
    if (endTurn === undefined || eventTurn === endTurn) {
      lower = index
      break
    }
    // A start without a turn number is the best bound an older log can offer; keep looking for an
    // exact match first, so a nearby untagged turn cannot swallow a later tagged one.
    if (eventTurn === undefined && untagged === -1) untagged = index
  }
  if (lower === -1) lower = untagged
  return Object.freeze({ lower, upper })
}

/** Read one assistant message's text, bounded for diagnostics. */
const assistantTextOf = (event: SessionEventLike | undefined, limit = 400): string | undefined => {
  const message = (event?.data as { message?: { content?: readonly { type: string; text?: string }[] } } | undefined)?.message
  const text = (message?.content ?? [])
    .filter(block => block.type === 'text')
    .map(block => block.text ?? '')
    .join('\n')
    .trim()
  if (text === '') return undefined
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

/**
 * Derive one Session's live status from its durable log. Everything is read from events, so the
 * monitor never has to infer activity from wall-clock bookkeeping it does not own.
 * @param agent - the live Agent (or its session), or anything the host exposes.
 * @param now - the clock, for elapsed and age calculations.
 * @returns the activity snapshot, or undefined without a readable session.
 */
export const activityOf = (agent: unknown, now: number = Date.now()): SessionActivity | undefined => {
  const events = eventsOf(agent)
  if (events.length === 0) return undefined
  const started = lastEventOf(events, 'turn/start')
  const ended = lastEventOf(events, 'turn/end')
  const running = started !== undefined && (ended === undefined || (started.seq ?? 0) > (ended.seq ?? 0))
  const last = events[events.length - 1]
  const lastCall = lastEventOf(events, 'tool/call')
  let inFlightTool: string | undefined
  if (lastCall !== undefined) {
    const callId = (lastCall.data as { callId?: unknown } | undefined)?.callId
    const resultAfter = events.some(event => event.type === 'tool/result'
      && (event.data as { message?: { toolCallId?: unknown } } | undefined)?.message?.toolCallId === callId
      && (event.seq ?? 0) > (lastCall.seq ?? 0))
    if (!resultAfter) inFlightTool = (lastCall.data as { name?: string } | undefined)?.name
  }
  const lastError = (() => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type !== 'tool/result') continue
      const error = (event.data as { error?: { reason?: string; name?: string }; message?: { isError?: boolean } } | undefined)
      if (error?.error !== undefined) return error.error.reason ?? error.error.name
      if (error?.message?.isError === true) return 'tool result reported an error'
    }
    return undefined
  })()
  const lastAssistant = lastEventOf(events, 'assistant/message')
  const lastAssistantText = assistantTextOf(lastAssistant)
  const lastName = (lastCall?.data as { name?: unknown } | undefined)?.name
  const lastTool = typeof lastName === 'string' ? lastName : undefined
  return Object.freeze({
    running,
    ...(running && started?.time !== undefined
      ? {
        turnStartedAt: started.time,
        elapsedMs: Math.max(0, now - started.time),
      }
      : {}),
    ...(last?.time === undefined ? {} : {
      lastActivityAt: last.time,
      lastActivityAgeMs: Math.max(0, now - last.time),
    }),
    ...(lastTool === undefined ? {} : { lastTool }),
    ...(inFlightTool === undefined ? {} : { inFlightTool }),
    ...(lastError === undefined ? {} : { lastError }),
    ...(lastAssistantText === undefined ? {} : { lastAssistantText }),
  })
}

/**
 * The weighted cache-hit percentage over the most recent assistant requests of one live Session.
 *
 * `sum(cacheReadTokens) / sum(inputTokens + cacheReadTokens)`: a single request is a poor sample —
 * the turn's first request is the worst one, because whatever changed between turns is paid there.
 * Weighting a recent window shows the conversation's real health instead of the last outlier.
 * @param agent - the live Agent whose session log is read.
 * @param limit - how many recent assistant messages to include (default 20).
 * @returns the percentage (0–100), or undefined without a measurable usage record.
 */
export const cacheHitOf = (agent: unknown, limit = 20): number | undefined => {
  const events = eventsOf(agent)
  let read = 0
  let total = 0
  let samples = 0
  for (let index = events.length - 1; index >= 0 && samples < limit; index -= 1) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    const usage = (event.data as { usage?: { inputTokens?: number; cacheReadTokens?: number } } | undefined)?.usage
    if (usage?.inputTokens === undefined) continue
    read += usage.cacheReadTokens ?? 0
    total += usage.inputTokens + (usage.cacheReadTokens ?? 0)
    samples += 1
  }
  return total === 0 ? undefined : Math.round(read / total * 100)
}

/**
 * The model a live Session would use on its next turn, when the host exposes it.
 * @param ctx - plugin context carrying the agent registry.
 * @param sessionId - Session whose live Agent is asked.
 * @returns the current route, or undefined without a live Agent or a resolved model.
 */
const currentModelOf = (
  ctx: unknown,
  sessionId: string,
): Readonly<{ provider: string; model: string; reasoningEffort?: string }> | undefined => {
  const live = agentsOf(ctx)?.get(sessionId) as {
    model?: { current?: () => { provider?: string; model?: string; reasoningEffort?: string } | undefined }
  } | undefined
  const current = live?.model?.current?.()
  if (current?.provider === undefined || current.model === undefined) return undefined
  return Object.freeze({
    provider: current.provider,
    model: current.model,
    ...(current.reasoningEffort === undefined ? {} : { reasoningEffort: current.reasoningEffort }),
  })
}

/**
 * The latest durable title of one live Session, when it has one.
 * @param ctx - plugin context carrying the agent registry.
 * @param sessionId - Session whose log is scanned.
 * @returns the latest non-empty `session/title`, or undefined.
 */
const sessionTitleOf = (ctx: unknown, sessionId: string): string | undefined => {
  const events = eventsOf(agentsOf(ctx)?.get(sessionId))
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'session/title') continue
    const title = (event.data as { title?: unknown } | undefined)?.title
    if (typeof title === 'string' && title.trim() !== '') return title
  }
  return undefined
}

/**
 * A one-line summary of what a live Session was last asked to do: its latest user message.
 * @param ctx - plugin context carrying the agent registry.
 * @param sessionId - Session whose log is scanned.
 * @returns the latest user text, truncated, or undefined.
 */
const lastTaskOf = (ctx: unknown, sessionId: string): string | undefined => {
  const events = eventsOf(agentsOf(ctx)?.get(sessionId))
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'user/message') continue
    const text = assistantTextOf(event, 120)
    if (text !== undefined) return text
  }
  return undefined
}

/** One recent event as `inspect` reports it. */
export interface RecentActivity {
  readonly seq?: number
  readonly type: string
  readonly at?: number
  readonly tool?: string
  readonly text?: string
  readonly error?: string
}

/**
 * Summarize the most recent events of one Session, newest last, for a stuck-task diagnosis.
 * @param agent - the live Agent.
 * @param limit - how many trailing events to describe.
 * @returns a compact, model-readable activity list.
 */
export const recentActivityOf = (agent: unknown, limit = 10): readonly RecentActivity[] => {
  const events = eventsOf(agent)
  return Object.freeze(events.slice(-limit).map((event) => {
    const type = event.type ?? 'unknown'
    const data = event.data as Record<string, unknown> | undefined
    const tool = type === 'tool/call' ? (typeof data?.name === 'string' ? data.name : undefined) : undefined
    const text = type === 'assistant/message' ? assistantTextOf(event, 200) : undefined
    const error = (() => {
      if (type !== 'tool/result') return undefined
      const failure = data as { error?: { reason?: string; name?: string }; message?: { isError?: boolean } } | undefined
      return failure?.error?.reason ?? failure?.error?.name ?? (failure?.message?.isError === true ? 'tool result reported an error' : undefined)
    })()
    return Object.freeze({
      ...(event.seq === undefined ? {} : { seq: event.seq }),
      type,
      ...(event.time === undefined ? {} : { at: event.time }),
      ...(tool === undefined ? {} : { tool }),
      ...(text === undefined ? {} : { text }),
      ...(error === undefined ? {} : { error }),
    })
  }))
}

/** Render a duration for the model: seconds under a minute, then whole minutes. */
const durationText = (ms: number): string => ms < 60_000
  ? `${Math.max(0, Math.round(ms / 1000))}s`
  : `${Math.round(ms / 60_000)}m`

/**
 * The one-line monitor the super agent sees on every request: workspace Sessions whose open turn
 * has exceeded the configured threshold, with their age, last activity and in-flight tool. Empty
 * when nothing is long-running, so a quiet deployment pays nothing.
 * @param ctx - the plugin context carrying the agent registry.
 * @param superHome - the super workspace path; its own sessions are not workspace work.
 * @param thresholdMs - the configured suggestion threshold.
 * @param now - the clock.
 * @returns the context text (possibly empty).
 */
export const longRunningSummary = (
  ctx: unknown,
  superHome: string | undefined,
  thresholdMs: number,
  now: number = Date.now(),
): string => {
  const agents = agentsOf(ctx)
  if (agents?.list === undefined) return ''
  const rows: string[] = []
  for (const agent of agents.list()) {
    const header = (agent as { session?: { header?: { cwd?: string; origin?: string } } }).session?.header
    if (header?.origin === 'subagent') continue
    if (superHome !== undefined && header?.cwd !== undefined && sameCheckout(header.cwd, superHome)) continue
    const activity = activityOf(agent, now)
    if (activity?.running !== true || activity.elapsedMs === undefined || activity.elapsedMs < thresholdMs) continue
    const id = String((agent as { id?: unknown }).id)
    const tail = activity.lastActivityAgeMs === undefined ? '' : `last activity ${durationText(activity.lastActivityAgeMs)} ago`
    const tool = activity.inFlightTool === undefined
      ? (activity.lastTool === undefined ? '' : `last tool ${activity.lastTool}`)
      : `tool ${activity.inFlightTool} (in flight)`
    rows.push(`${id} ${durationText(activity.elapsedMs)}${tail === '' ? '' : ` — ${tail}`}${tool === '' ? '' : `, ${tool}`}`)
  }
  if (rows.length === 0) return ''
  return `[superagent monitor] ${rows.length} running Session(s) over ${durationText(thresholdMs)}: `
    + `${rows.join('; ')}. Inspect one with superagent_session action "inspect" before deciding whether to `
    + 'interrupt it (delivery "interrupt" on append/prompt) or abort and continue it (action "abort").'
}


/** How one admitted instruction reached the Session. */
export interface DeliveryOutcome {
  /** What the caller asked for. */
  readonly requested: 'queue' | 'interrupt'
  /** What the host actually used (`interrupt` only steers a running turn). */
  readonly used: 'queue' | 'interrupt'
  /** Whether the controller admitted the message. */
  readonly accepted: boolean
  /** Whether the Session was running at admission. */
  readonly wasRunning: boolean
  /** True when `interrupt` was requested on an idle Session, which queued instead. */
  readonly fallback?: boolean
  /** The durable seq of the newest user message, when the host exposes the Session log. */
  readonly insertedAtSeq?: number
}

/**
 * Choose the delivery the host can actually honor: only a running turn can be steered, so an
 * interrupt requested on an idle Session queues instead of failing (the person's instruction still
 * lands, just as the next turn). The fallback is reported, not silent.
 * @param requested - what the caller asked for.
 * @param wasRunning - whether the Session was running at admission.
 * @returns the mode to use and whether it fell back.
 */
const decideDelivery = (requested: 'queue' | 'interrupt', wasRunning: boolean): { used: 'queue' | 'interrupt'; fallback: boolean } => ({
  used: requested === 'interrupt' && wasRunning ? 'interrupt' : 'queue',
  fallback: requested === 'interrupt' && !wasRunning,
})

/**
 * Wait for an aborted Session to become idle. The Agent's own `whenIdle` is authoritative when the
 * host exposes it; otherwise the host list is polled within the same budget. A timeout returns
 * false, and the caller reports it instead of continuing on a turn that may still be running.
 * @param controller - the host session controller.
 * @param agent - the live Agent whose turn was aborted.
 * @param sessionId - the Session id.
 * @param timeoutMs - the budget.
 * @returns whether the Session reached idle inside the budget.
 */
const waitForIdle = async (
  controller: SessionControllerLike,
  agent: unknown,
  sessionId: string,
  timeoutMs: number,
): Promise<boolean> => {
  const whenIdle = (agent as { whenIdle?: () => Promise<void> }).whenIdle
  if (typeof whenIdle === 'function') {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        resolve(false)
      }, timeoutMs)
      timer.unref?.()
    })
    try {
      return await Promise.race([whenIdle.call(agent).then(() => true), timeout])
    } catch {
      return false
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const listed = await controller.list()
    const item = listed.items.find(entry => String(entry.sessionId) === sessionId)
    if (item?.running !== true) return true
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return false
}

/**
 * The cancellation boundary of one Session: the latest durable seq and the last turn-end reason.
 * @param agent - the live Agent whose log is read.
 * @returns the boundary fields, absent when the log is unreadable.
 */
const cancellationBoundary = (agent: unknown): Readonly<{ seq?: number; turnEndReason?: string }> => {
  const events = eventsOf(agent)
  const last = events.at(-1)
  let turnEndReason: string | undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'turn/end') continue
    const kind = (event.data as { reason?: { kind?: unknown } } | undefined)?.reason?.kind
    if (typeof kind === 'string') turnEndReason = kind
    break
  }
  return Object.freeze({
    ...(last?.seq === undefined ? {} : { seq: last.seq }),
    ...(turnEndReason === undefined ? {} : { turnEndReason }),
  })
}

/**
 * Assemble the delivery report a result carries, including where the instruction landed.
 * @param requested - what the caller asked for.
 * @param used - the mode the host used.
 * @param fallback - whether interrupt fell back to queue.
 * @param wasRunning - whether the Session was running at admission.
 * @param accepted - the controller's acknowledgement.
 * @param insertedAtSeq - the newest user-message seq, when readable.
 * @returns the frozen outcome.
 */
const deliveryOutcome = (
  requested: 'queue' | 'interrupt',
  used: 'queue' | 'interrupt',
  fallback: boolean,
  wasRunning: boolean,
  accepted: boolean,
  insertedAtSeq: number | undefined,
): DeliveryOutcome => Object.freeze({
  requested,
  used,
  accepted,
  wasRunning,
  ...(fallback ? { fallback: true } : {}),
  ...(insertedAtSeq === undefined ? {} : { insertedAtSeq }),
})

/** What one manual compaction attempt reports. */
export interface CompactionOutcome {
  readonly before?: ContextUsage
  readonly after?: ContextUsage
  readonly compacted?: boolean
  readonly shadowedTokens?: number
  readonly error?: string
  /** The host's stable failure class when it named one (`busy`, `changed`, …). */
  readonly code?: string
}

/**
 * Compact one Session through the host's manual-compaction seam.
 *
 * Resolving the Agent first is what makes a cold Session compactable; the engine itself refuses
 * (`busy`) while a turn is active, so a running task is never interrupted — the refusal is returned
 * as data for the super agent to observe. Every outcome is measured on both sides where the host
 * can measure it.
 * @param ctx - the plugin context carrying the compaction seam and token meter.
 * @param controller - the host session controller (for `resolveAgent`).
 * @param sessionId - the Session to compact.
 * @returns the outcome; `error` is set instead of throwing.
 */
export const compactWorkspaceSession = async (
  ctx: unknown,
  controller: SessionControllerLike,
  sessionId: string,
): Promise<CompactionOutcome> => {
  if (controller.resolveAgent === undefined) return { error: 'this host exposes no resolveAgent for a Session' }
  let agent: unknown
  try {
    const resolved = await controller.resolveAgent(sessionId)
    agent = resolved.agent
    if (agent === undefined) {
      return { error: `the Session could not be resolved: ${String((resolved as { error?: unknown }).error ?? 'unknown')}` }
    }
  } catch (error: unknown) {
    return { error: `the Session could not be resolved: ${error instanceof Error ? error.message : String(error)}` }
  }
  // In the product composition compaction is owned by an agent-preset isolate, so the plugin's
  // root context cannot see it. The resolved Agent carries its own scoped context; prefer that
  // seam, with the root fallback kept for hosts that mount compaction globally.
  const agentCtx = (agent as { ctx?: unknown }).ctx
  const compaction = compactionOf(agentCtx) ?? compactionOf(ctx)
  if (compaction === undefined) return { error: 'this deployment has no compaction seam' }
  const meter = tokenMeterOf(agentCtx) ?? tokenMeterOf(ctx)
  const before = contextUsageOf(meter, (agent as { session?: unknown }).session)
  try {
    const result = await compaction.compactNow(agent, new AbortController().signal)
    const after = contextUsageOf(meter, (agent as { session?: unknown }).session)
    return {
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
      compacted: result !== null,
      shadowedTokens: result?.shadowedTokenCount ?? 0,
    }
  } catch (error: unknown) {
    const code = (error as { code?: unknown }).code
    return {
      ...(before === undefined ? {} : { before }),
      error: error instanceof Error ? error.message : String(error),
      ...(typeof code === 'string' ? { code } : {}),
    }
  }
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
  const controller: SessionControllerLike | undefined = sessionControllerOf(ctx)
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
  const meter = tokenMeterOf(ctx)
  const thresholdPercent = context.compactThresholdPercent ?? DEFAULT_COMPACT_THRESHOLD_PERCENT
  const wantCompact = validated.value.compact === true
  const curateMemory = validated.value.curate_memory === true
  const requestedDelivery: 'queue' | 'interrupt' = validated.value.delivery === 'interrupt' ? 'interrupt' : 'queue'
  const actionRequirements: Partial<Record<string, readonly string[]>> = {
    append: ['workspace', 'session', 'text'],
    start: ['workspace', 'task'],
    prompt: ['session', 'text'],
    inspect: ['session'],
    stop: ['session'],
    abort: ['session', 'text'],
    compact: ['session'],
    archive: ['session'],
    delete: ['session', 'confirm'],
    fork: ['session'],
  }
  const missing = (actionRequirements[action ?? ''] ?? []).filter((name) => {
    const value = validated.value[name]
    return value === undefined || (typeof value === 'string' && value.trim() === '')
  })
  if (missing.length > 0) {
    return failure(invalidInput(`${String(action)} needs ${missing.map(name => `\`${name}\``).join(', ')}`, {
      action,
      missing: Object.freeze(missing),
    }), caller, me)
  }
  const longRunningMinutes = context.longRunningMinutes ?? DEFAULT_LONG_RUNNING_MINUTES
  const longRunningMs = longRunningMinutes * 60_000

  // A thrown middleware between validation and the action handlers must still produce a readable
  // failure, not an uncaught rejection the caller never hears about.
  try {
    return await runSessionAction(controller, validated.value)
  } catch (error: unknown) {
    return sessionActionFailure(
      `the Session action "${String(action ?? '')}" failed before it could answer: ${error instanceof Error ? error.message : String(error)}`,
      me,
      { workspace: workspace?.path, session: sessionArg },
    )
  }

  /**
   * Dispatch the validated Session action. The handlers below keep their own refusal style
   * (`failure(...)` with the caller verdict); only unexpected throws reach the wrapper above.
   * @param controller - the host Session controller, already proven present.
   * @param values - the validated arguments.
   * @returns the action's envelope.
   */
  async function runSessionAction(
    controller: SessionControllerLike,
    values: Readonly<Record<string, unknown>>,
  ): Promise<ToolValue> {
    if (action === 'append') {
      if (workspace === undefined) {
        return failure(invalidInput(`"${String(workspaceArg ?? '')}" is not a registered workspace; run superagent_workspace roster first`), caller, me)
      }
      if (textArg === undefined || textArg.trim() === '') {
        return failure(invalidInput('append needs `text`: the follow-up instruction'), caller, me)
      }
      if (reportTo === undefined) {
        return failure(invalidInput(
          'the dispatching Session id is unavailable, so this dispatch could not route a report; no prompt was sent',
          { workspace: workspace.path },
        ), caller, me)
      }
      try {
        const listed = await controller.list()
        const candidates = listed.items
          .filter(item => item.parentSessionId === undefined && item.origin !== 'subagent' && item.blank !== true)
          .filter(item => item.cwd !== undefined && sameCheckout(item.cwd, workspace.path))
          .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
        if (candidates.length === 0) {
          return failure(invalidInput(
            `"${workspace.title}" has no Session to continue yet; start one with superagent_session start`,
            { workspace: workspace.path },
          ), caller, me)
        }
        const candidateRows = candidates.map((item) => {
          const id = String(item.sessionId)
          const live = agentsOf(ctx)?.get(id)
          const status = live === undefined ? undefined : activityOf(live, Date.now())
          return Object.freeze({
            id,
            running: item.running,
            ...(item.updatedAt === undefined ? {} : { updatedAt: item.updatedAt }),
            ...(sessionTitleOf(ctx, id) === undefined ? {} : { title: sessionTitleOf(ctx, id) }),
            ...(currentModelOf(ctx, id) === undefined ? {} : { model: currentModelOf(ctx, id) }),
            ...(lastTaskOf(ctx, id) === undefined ? {} : { lastTask: lastTaskOf(ctx, id) }),
            ...(status?.lastError === undefined ? {} : { lastError: status.lastError }),
          })
        })
        const explicitSession = sessionArg === undefined || sessionArg.trim() === ''
          ? undefined
          : sessionArg.trim()
        let target: (typeof candidates)[number] | undefined
        if (explicitSession !== undefined && explicitSession !== 'latest') {
          target = candidates.find(item => String(item.sessionId) === explicitSession)
          if (target === undefined) {
            return failure(invalidInput(
              `"${explicitSession}" is not a Session of "${workspace.title}"; pass \`session\` from superagent_session list`,
              { workspace: workspace.path, candidates: candidateRows },
            ), caller, me)
          }
        } else if (explicitSession === 'latest') {
          target = candidates[0]
        } else {
        // Never guess which conversation the work belongs to: routing follow-up work into the
        // wrong Session is worse than asking.
          return failure(invalidInput(
            `append needs \`session\`: which of "${workspace.title}"'s ${String(candidates.length)} Session(s) `
          + 'to continue (an id, or "latest" for the most recently updated); candidates are in the error details',
            { workspace: workspace.path, candidates: candidateRows },
          ), caller, me)
        }
        if (target === undefined) {
          return failure(invalidInput(
            `"${workspace.title}" has no Session to continue yet; start one with superagent_session start`,
            { workspace: workspace.path },
          ), caller, me)
        }
        const sessionId = String(target.sessionId)
        const wasRunning =  target.running
        const selected = await applySessionModel(controller, sessionId, values, ctx, wasRunning)
        if (selected.error !== undefined) {
          return failure(invalidInput(selected.error, { session: sessionId, ...selected.errorDetails ?? {} }), caller, me)
        }
        const delivery = decideDelivery(requestedDelivery, wasRunning)
        if (wantCompact && delivery.used === 'interrupt') {
          return failure(invalidInput(
            'compaction runs only while a Session is idle, so it cannot be combined with an interrupt of '
          + 'its running turn; send with delivery "queue" or wait for the turn to end',
            { session: sessionId },
          ), caller, me)
        }
        const compaction = wantCompact ? await compactWorkspaceSession(ctx, controller, sessionId) : undefined
        if (compaction?.error !== undefined) {
          return failure(invalidInput(
            `the context was not compacted, so the follow-up was not sent: ${compaction.error}`,
            { session: sessionId, compaction },
          ), caller, me)
        }
        const requestId = `superagent-append-${randomUUID()}`
        const taskId = newDispatchReportId()
        try {
          await recordDispatchReport(context, caller, workspace, textArg.trim(), sessionId, options.at, reportTo, requestId, taskId)
        } catch (error: unknown) {
          return failure(invalidInput(
            `the dispatch report binding could not be recorded, so no prompt was sent: ${error instanceof Error ? error.message : String(error)}`,
            { workspace: workspace.path },
          ), caller, me)
        }
        let admitted: { readonly accepted: boolean }
        try {
          admitted = await controller.prompt({
            requestId,
            sessionId,
            mode: delivery.used === 'interrupt' ? 'steer' : 'queue',
            content: [{ type: 'text', text: composeTask(textArg.trim(), curateMemory) }],
          }, new AbortController().signal)
        } catch (error: unknown) {
          await failDispatchReport(context, caller, taskId, options.at, error)
          throw error
        }
        const delivered = deliveryOutcome(
          requestedDelivery, delivery.used, delivery.fallback, wasRunning, admitted.accepted, insertionSeqOf(ctx, sessionId),
        )
        const ledger = await recordTaskLedger(
          ctx as ToolHost['ctx'], caller, workspace, textArg.trim(), sessionId, options.at, reportTo, context.store, requestId, taskId,
        )
        if (reportTo !== undefined) {
          enqueueTaskRecord(context.tasks, sessionId, {
            superSession: reportTo,
            workspace: workspace.path,
            requestId,
            ...(ledger.ledger === undefined ? {} : { ledger: ledger.ledger }),
            ...(compaction?.before === undefined ? {} : { usageBefore: compaction.before }),
          })
        }
        const sessionTitle = sessionTitleOf(ctx, sessionId)
        return withLedger(Object.freeze({
          ...verdict,
          session: Object.freeze({
            id: sessionId,
            workspace: workspace.path,
            workspaceTitle: workspace.title,
            ...(sessionTitle === undefined ? {} : { sessionTitle }),
            appended: true,
          }),
          delivery: delivered,
          ...((agentsOf(ctx)?.get(sessionId) as { session?: unknown } | undefined) === undefined
            ? {}
            : { status: Object.freeze(activityOf(agentsOf(ctx)?.get(sessionId), Date.now()) ?? { running: false }) }),
          ...((selected.model ?? currentModelOf(ctx, sessionId)) === undefined
            ? {}
            : { model: selected.model ?? currentModelOf(ctx, sessionId) }),
          ...(compaction === undefined ? {} : { compaction: Object.freeze(compaction) }),
        }), ledger)
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
      if (reportTo === undefined) {
        return failure(invalidInput(
          'the dispatching Session id is unavailable, so this dispatch could not route a report; no Session was started',
          { workspace: workspace.path },
        ), caller, me)
      }
      if (requestedDelivery === 'interrupt') {
        return failure(invalidInput(
          'start opens a new Session, so there is no running turn to interrupt; omit `delivery` or use "queue"',
          { workspace: workspace.path },
        ), caller, me)
      }
      const titleArg = asString(values.title)?.trim()
      try {
        const created = await controller.create({
          workspaceId: workspace.id,
          ...(context.agentPreset === undefined || context.agentPreset.trim() === ''
            ? {}
            : { agentPreset: context.agentPreset }),
        })
        const sessionId = String(created.sessionId)
        const initialPermission = await applySessionPermission(
          ctx, controller, workspace.id, sessionId, WORKSPACE_SESSION_PERMISSION, 'explicit default for a superagent-created workspace Session',
        )
        if (initialPermission.error !== undefined) {
          return failure(invalidInput(
            `the Session was created but its default workspace-write permission could not be set; no task was sent: ${initialPermission.error}`,
            { session: sessionId },
          ), caller, me)
        }
        const selected = await applySessionModel(controller, sessionId, values, ctx)
        if (selected.error !== undefined) {
          return failure(invalidInput(selected.error, { session: sessionId, ...selected.errorDetails ?? {} }), caller, me)
        }
        // Name the conversation before its first task, so a later `list` tells it apart.
        let title: string | undefined
        if (titleArg !== undefined && titleArg !== '') {
          try {
            title = (await controller.rename?.({ sessionId, title: titleArg }))?.title ?? titleArg
          } catch (error: unknown) {
            return failure(invalidInput(
              `the Session was created but its title could not be recorded: ${error instanceof Error ? error.message : String(error)}`,
              { session: sessionId },
            ), caller, me)
          }
        }
        const requestId = `superagent-task-${randomUUID()}`
        const taskId = newDispatchReportId()
        try {
          await recordDispatchReport(context, caller, workspace, taskArg.trim(), sessionId, options.at, reportTo, requestId, taskId)
        } catch (error: unknown) {
          return failure(invalidInput(
            `the dispatch report binding could not be recorded, so the Session was not prompted: ${error instanceof Error ? error.message : String(error)}`,
            { session: sessionId },
          ), caller, me)
        }
        try {
          await controller.prompt({
            requestId,
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text: composeTask(taskArg.trim(), curateMemory) }],
          }, new AbortController().signal)
        } catch (error: unknown) {
          await failDispatchReport(context, caller, taskId, options.at, error)
          throw error
        }
        const ledger = await recordTaskLedger(
          ctx as ToolHost['ctx'], caller, workspace, taskArg.trim(), sessionId, options.at, reportTo, context.store, requestId, taskId,
        )
        if (reportTo !== undefined) {
          enqueueTaskRecord(context.tasks, sessionId, {
            superSession: reportTo,
            workspace: workspace.path,
            requestId,
            ...(ledger.ledger === undefined ? {} : { ledger: ledger.ledger }),
          })
        }
        return withLedger(Object.freeze({
          ...verdict,
          session: Object.freeze({
            id: sessionId,
            workspace: workspace.path,
            workspaceTitle: workspace.title,
            ...(title === undefined ? {} : { sessionTitle: title }),
          }),
          permission: initialPermission.permission,
          ...(selected.model === undefined ? {} : { model: selected.model }),
        }), ledger)
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
      if (reportTo === undefined) {
        return failure(invalidInput(
          'the dispatching Session id is unavailable, so this dispatch could not route a report; no prompt was sent',
          { session: sessionArg.trim() },
        ), caller, me)
      }
      const sessionId = sessionArg.trim()
      try {
        const listed = await controller.list()
        const wasRunning = listed.items.some(item => String(item.sessionId) === sessionId &&  item.running)
        const selected = await applySessionModel(controller, sessionId, values, ctx, wasRunning)
        if (selected.error !== undefined) {
          return failure(invalidInput(selected.error, { session: sessionId, ...selected.errorDetails ?? {} }), caller, me)
        }
        const delivery = decideDelivery(requestedDelivery, wasRunning)
        if (wantCompact && delivery.used === 'interrupt') {
          return failure(invalidInput(
            'compaction runs only while a Session is idle, so it cannot be combined with an interrupt of '
          + 'its running turn; send with delivery "queue" or wait for the turn to end',
            { session: sessionArg },
          ), caller, me)
        }
        const compaction = wantCompact ? await compactWorkspaceSession(ctx, controller, sessionArg) : undefined
        if (compaction?.error !== undefined) {
          return failure(invalidInput(
            `the context was not compacted, so the follow-up was not admitted: ${compaction.error}`,
            { session: sessionArg, compaction },
          ), caller, me)
        }
        const requestId = `superagent-followup-${randomUUID()}`
        const taskId = newDispatchReportId()
        const knownBefore = lastTaskRecord(context.tasks, sessionId)
        // A follow-up may target a Session without naming its registered Workspace; the report only
        // needs a readable headline, while the ledger keeps its existing workspace-or-skip rule.
        const reportWorkspace: DispatchReportWorkspace = workspace ?? {
          id: '',
          title: knownBefore?.workspace ?? 'its workspace',
          path: knownBefore?.workspace ?? '',
        }
        try {
          await recordDispatchReport(context, caller, reportWorkspace, textArg.trim(), sessionId, options.at, reportTo, requestId, taskId)
        } catch (error: unknown) {
          return failure(invalidInput(
            `the dispatch report binding could not be recorded, so no prompt was sent: ${error instanceof Error ? error.message : String(error)}`,
            { session: sessionId },
          ), caller, me)
        }
        let admitted: { readonly accepted: boolean }
        try {
          admitted = await controller.prompt({
            requestId,
            sessionId: sessionArg,
            mode: delivery.used === 'interrupt' ? 'steer' : 'queue',
            content: [{ type: 'text', text: composeTask(textArg.trim(), curateMemory) }],
          }, new AbortController().signal)
        } catch (error: unknown) {
          await failDispatchReport(context, caller, taskId, options.at, error)
          throw error
        }
        const delivered = deliveryOutcome(
          requestedDelivery, delivery.used, delivery.fallback, wasRunning, admitted.accepted, insertionSeqOf(ctx, sessionId),
        )
        const ledger: LedgerAttempt = workspace === undefined
          ? Object.freeze({})
          : await recordTaskLedger(
            ctx as ToolHost['ctx'], caller, workspace, textArg.trim(), sessionId, options.at, reportTo, context.store, requestId, taskId,
          )
        if (reportTo !== undefined) {
          const known = lastTaskRecord(context.tasks, sessionId)
          enqueueTaskRecord(context.tasks, sessionId, {
            superSession: reportTo,
            workspace: workspace?.path ?? known?.workspace ?? 'its workspace',
            requestId,
            ...(ledger.ledger === undefined ? {} : { ledger: ledger.ledger }),
            ...(compaction?.before === undefined ? {} : { usageBefore: compaction.before }),
          })
        }
        const sessionTitle = sessionTitleOf(ctx, sessionId)
        return withLedger(Object.freeze({
          ...verdict,
          session: Object.freeze({ id: sessionId, ...(sessionTitle === undefined ? {} : { sessionTitle }) }),
          delivery: delivered,
          ...((agentsOf(ctx)?.get(sessionId) as { session?: unknown } | undefined) === undefined
            ? {}
            : { status: Object.freeze(activityOf(agentsOf(ctx)?.get(sessionId), Date.now()) ?? { running: false }) }),
          ...(selected.model === undefined ? {} : { model: selected.model }),
          ...(compaction === undefined ? {} : { compaction: Object.freeze(compaction) }),
        }), ledger)
      } catch (error: unknown) {
        return failure(invalidInput(
          `the follow-up could not be admitted: ${error instanceof Error ? error.message : String(error)}`,
          { session: sessionArg },
        ), caller, me)
      }
    }

    if (action === 'inspect') {
      if (sessionArg === undefined || sessionArg.trim() === '') {
        return failure(invalidInput('inspect needs `session`: the Session id'), caller, me)
      }
      const live = agentsOf(ctx)?.get(sessionArg.trim())
      if (live === undefined) {
        return failure(invalidInput(
          'that Session has no live Agent right now, so there is no running turn to inspect',
          { session: sessionArg },
        ), caller, me)
      }
      const status = activityOf(live, Date.now()) ?? { running: false }
      const events = eventsOf(live)
      const lastEnd = lastEventOf(events, 'turn/end')
      const lastTurnReason = (lastEnd?.data as {
        reason?: { kind?: string; error?: { message?: string; code?: string; status?: number } }
      } | undefined)?.reason
      const model = currentModelOf(ctx, sessionArg.trim())
      return Object.freeze({
        ...verdict,
        session: Object.freeze({ id: sessionArg.trim() }),
        status: Object.freeze(status),
        activity: recentActivityOf(live, 12),
        ...(model === undefined ? {} : { model }),
        ...(lastTurnReason?.kind === undefined || lastTurnReason.kind === 'completed'
          ? {}
          : {
            lastTurnError: Object.freeze({
              kind: lastTurnReason.kind,
              ...(lastTurnReason.error?.message === undefined ? {} : { message: lastTurnReason.error.message }),
              ...(lastTurnReason.error?.code === undefined ? {} : { code: lastTurnReason.error.code }),
            }),
          }),
      })
    }

    if (action === 'stop') {
      if (sessionArg === undefined || sessionArg.trim() === '') {
        return failure(invalidInput('stop needs `session`: the Session id'), caller, me)
      }
      const sessionId = sessionArg.trim()
      const live = agentsOf(ctx)?.get(sessionId)
      const status = activityOf(live, Date.now()) ?? { running: false }
      const scene = Object.freeze({ status, activity: recentActivityOf(live, 8) })
      if (!status.running) {
        return Object.freeze({
          ...verdict,
          session: Object.freeze({ id: sessionId }),
          stop: Object.freeze({ accepted: false, wasRunning: false, alreadyIdle: true, scene, boundary: cancellationBoundary(live) }),
        })
      }
      const agentCancel = (live as {
        cancel?: (cause: { readonly kind: 'user' }, options?: { readonly keepInbox?: boolean }) => void
      } | undefined)?.cancel
      let cancelledVia: 'agent' | 'controller'
      if (typeof agentCancel === 'function') {
        try {
        // A true stop: clear queued and steering work too, so the Session ends idle rather than
        // starting the queued text as a new turn.
          agentCancel.call(live, { kind: 'user' }, { keepInbox: false })
          cancelledVia = 'agent'
        } catch (error: unknown) {
          return failure(invalidInput(
            `the stop was refused: ${error instanceof Error ? error.message : String(error)}`,
            { session: sessionId, scene },
          ), caller, me)
        }
      } else if (controller.cancel !== undefined) {
        try {
          await controller.cancel({ sessionId })
          cancelledVia = 'controller'
        } catch (error: unknown) {
          return failure(invalidInput(
            `the stop was refused: ${error instanceof Error ? error.message : String(error)}`,
            { session: sessionId, scene },
          ), caller, me)
        }
      } else {
        return failure(invalidInput(
          'this host exposes no hard cancel channel (agent.cancel or controller.cancel), so a guaranteed stop is unavailable; use abort with an instruction, or upgrade the host',
          { session: sessionId, scene },
        ), caller, me)
      }
      const idle = await waitForIdle(controller, live, sessionId, 10_000)
      return Object.freeze({
        ...verdict,
        session: Object.freeze({ id: sessionId }),
        stop: Object.freeze({
          accepted: true,
          wasRunning: true,
          cancelledVia,
          clearedQueue: cancelledVia === 'agent',
          idle,
          scene,
          boundary: cancellationBoundary(live),
        }),
      })
    }

    if (action === 'abort') {
      if (sessionArg === undefined || sessionArg.trim() === '') {
        return failure(invalidInput('abort needs `session`: the Session id'), caller, me)
      }
      if (textArg === undefined || textArg.trim() === '') {
        return failure(invalidInput('abort needs `text`: the instruction to run after the abort'), caller, me)
      }
      const live = agentsOf(ctx)?.get(sessionArg.trim())
      if (live === undefined) {
        return failure(invalidInput(
          'that Session has no live Agent right now; only a running turn can be aborted',
          { session: sessionArg },
        ), caller, me)
      }
      const now = Date.now()
      const status = activityOf(live, now) ?? { running: false }
      const scene = Object.freeze({
        status,
        activity: recentActivityOf(live, 8),
      })
      if (!status.running) {
        return failure(invalidInput(
          'the Session is idle, so there is nothing to abort; use append/prompt to continue it',
          { session: sessionArg, scene },
        ), caller, me)
      }
      if (controller.cancel === undefined) {
        return failure(invalidInput('this host exposes no Session cancel, so the turn cannot be aborted', { session: sessionArg, scene }), caller, me)
      }
      try {
        await controller.cancel({ sessionId: sessionArg.trim() })
      } catch (error: unknown) {
        return failure(invalidInput(
          `the abort was refused: ${error instanceof Error ? error.message : String(error)}`,
          { session: sessionArg, scene },
        ), caller, me)
      }
      const idle = await waitForIdle(controller, live, sessionArg.trim(), 15_000)
      if (!idle) {
        return failure(invalidInput(
          'the abort was accepted but the Session did not become idle within 15s, so nothing was continued',
          { session: sessionArg, scene: Object.freeze({ ...scene, aborted: true }) },
        ), caller, me)
      }
      const admitted = await controller.prompt({
        requestId: `superagent-recover-${randomUUID()}`,
        sessionId: sessionArg.trim(),
        mode: 'queue',
        content: [{ type: 'text', text: composeTask(textArg.trim(), curateMemory) }],
      }, new AbortController().signal)
      const delivered = deliveryOutcome('queue', 'queue', false, false, admitted.accepted, insertionSeqOf(ctx, sessionArg.trim()))
      return Object.freeze({
        ...verdict,
        session: Object.freeze({ id: sessionArg.trim() }),
        abort: Object.freeze({ accepted: true, wasRunning: true, scene, resumed: true }),
        delivery: delivered,
      })
    }

    if (action === 'compact') {
      if (sessionArg === undefined || sessionArg.trim() === '') {
        return failure(invalidInput('compact needs `session`: the Session id'), caller, me)
      }
      const outcome = await compactWorkspaceSession(ctx, controller, sessionArg.trim())
      if (outcome.error !== undefined) {
        return failure(invalidInput(
          `the Session was not compacted: ${outcome.error}`,
          { session: sessionArg, compaction: outcome },
        ), caller, me)
      }
      return Object.freeze({
        ...verdict,
        session: Object.freeze({ id: sessionArg.trim(), ...(outcome.compacted === false ? { nothingToCompact: true } : {}) }),
        compaction: Object.freeze(outcome),
      })
    }

    if (action === 'list') {
      try {
        const listed = await controller.list()
        const rows = listed.items
          .filter(item => item.parentSessionId === undefined && item.origin !== 'subagent')
          .filter(item => workspace === undefined || item.cwd === undefined || sameCheckout(item.cwd, workspace.path))
          .map((item) => {
            const id = String(item.sessionId)
            const live = agentsOf(ctx)?.get(id) as { session?: unknown } | undefined
            const usage = contextUsageOf(meter, live?.session)
            const status = live === undefined ? undefined : activityOf(live, Date.now())
            const cacheHitPercent = live === undefined ? undefined : cacheHitOf(live)
            const title = sessionTitleOf(ctx, id)
            const model = currentModelOf(ctx, id)
            const lastTask = lastTaskOf(ctx, id)
            const events = eventsOf(live)
            const lastEnd = lastEventOf(events, 'turn/end')
            const lastTurn = lastEnd === undefined
              ? undefined
              : (lastEnd.data as {
                turn?: number
                reason?: { kind?: string; error?: { message?: string; code?: string; status?: number } }
              } | undefined)
            return Object.freeze({
              id,
              ...(title === undefined ? {} : { title }),
              ...(model === undefined ? {} : { model }),
              running: item.running,
              blank: item.blank === true,
              ...(item.cwd === undefined ? {} : { cwd: item.cwd }),
              ...(item.updatedAt === undefined ? {} : { updatedAt: item.updatedAt }),
              ...(lastTask === undefined ? {} : { lastTask }),
              ...(lastTurn?.reason === undefined || lastTurn.reason.kind === 'completed'
                ? {}
                : {
                  lastTurnError: Object.freeze({
                    ...(lastTurn.turn === undefined ? {} : { turn: lastTurn.turn }),
                    kind: lastTurn.reason.kind,
                    ...(lastTurn.reason.error?.message === undefined ? {} : { message: lastTurn.reason.error.message }),
                    ...(lastTurn.reason.error?.code === undefined ? {} : { code: lastTurn.reason.error.code }),
                    ...(lastTurn.reason.error?.status === undefined ? {} : { status: lastTurn.reason.error.status }),
                  }),
                }),
              ...(usage === undefined ? {} : { usage }),
              ...(usage?.percent === undefined || usage.percent < thresholdPercent ? {} : { recommendCompact: true }),
              ...(status === undefined ? {} : { status }),
              ...(cacheHitPercent === undefined ? {} : { cacheHitPercent }),
              ...(status?.elapsedMs === undefined || status.elapsedMs < longRunningMs ? {} : { longRunning: true }),
            })
          })
        return Object.freeze({
          ...verdict,
          sessions: Object.freeze(rows),
          compactThresholdPercent: thresholdPercent,
          longRunningMinutes,
        })
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

    if (action === 'delete') {
      if (sessionArg === undefined || sessionArg.trim() === '') {
        return failure(invalidInput('delete needs `session`: the Session id'), caller, me)
      }
      const callerSession = (me as { readonly session?: unknown } | undefined)?.session
      if (typeof callerSession === 'string' && callerSession === sessionArg.trim()) {
        return failure(invalidInput('cannot delete the Session that is calling this tool'), caller, me)
      }
      const confirm = asString(values.confirm)
      if (confirm === undefined || confirm.trim() !== sessionArg.trim()) {
        return failure(invalidInput(
          `delete needs \`confirm\` to repeat the Session id exactly; got ${String(confirm ?? 'nothing')}`,
          { session: sessionArg, accepted: sessionArg },
        ), caller, me)
      }
      if (controller.delete === undefined) {
        return failure(invalidInput(
          'this host exposes no Session delete API: a Session log can be hidden with `archive`, but the '
        + 'durable JSONL under ~/.dsh/sessions survives and this tool will not fake a deletion',
          { session: sessionArg },
        ), caller, me)
      }
      try {
        await controller.delete(sessionArg)
        context.tasks.delete(sessionArg)
        return Object.freeze({ ...verdict, session: Object.freeze({ id: sessionArg, deleted: true }) })
      } catch (error: unknown) {
        return failure(invalidInput(
          `the Session could not be deleted: ${error instanceof Error ? error.message : String(error)}`,
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
          const known = lastTaskRecord(context.tasks, sessionArg)
          enqueueTaskRecord(context.tasks, sessionId, {
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
}

/**
 * `superagent_ledger`: read, manually record, or resolve a per-workspace dispatch entry.
 * @param args - the raw tool arguments, validated against {@link LEDGER_PARAMETERS}.
 * @param options - the caller verdict and clock.
 * @param me - the caller identity tuple, echoed in every result.
 * @param ctx - the plugin context carrying the workspace registry and Session controller.
 * @returns the ledger rows, or the changed entry plus a memory-write suggestion.
 */
export const runLedgerTool = async (
  args: unknown,
  options: RunOptions,
  me: unknown,
  ctx: ToolHost['ctx'],
  store?: DispatchStore,
  reports?: DispatchReportStore,
): Promise<ToolValue> => {
  const retryHost = { ctx, env: {}, clock: () => Date.parse(options.at), recorder: options.jira as never }
  const { caller } = options
  const validated = validateArgs(LEDGER_PARAMETERS, args)
  if (!validated.ok) return failure(validated.error, caller, me)
  const root = caller.cwd
  if (root === undefined) {
    return failure(invalidInput('the dispatch ledger needs a super workspace checkout, and this caller has none'), caller, me)
  }
  const action = String(validated.value.action)
  const verdict = Object.freeze({
    ok: true,
    writable: caller.writable,
    ...(caller.reason === undefined ? {} : { reason: caller.reason }),
    me,
  })
  if (action === 'list') {
    try {
      const status = validated.value.status
      const query = {
        ...(asString(validated.value.workspace) === undefined ? {} : { workspace: String(validated.value.workspace) }),
        ...(isDispatchLedgerStatus(status) ? { status } : {}),
        ...(asString(validated.value.query) === undefined ? {} : { query: String(validated.value.query) }),
        ...(typeof validated.value.limit === 'number' ? { limit: validated.value.limit } : {}),
      }
      const durable = await store?.query(query)
      const listed = durable ?? queryDispatchTasks(await listAllDispatchTasks(root), query)
      return Object.freeze({ ...verdict, ...listed })
    } catch (error: unknown) {
      return failure(ioFailed(`the dispatch ledger could not be read: ${error instanceof Error ? error.message : String(error)}`), caller, me)
    }
  }

  if (action === 'report_status') {
    if (reports === undefined) return failure(invalidInput('this dispatch has no report journal'), caller, me)
    try {
      return Object.freeze({ ...verdict, entries: Object.freeze(await reports.failures()) })
    } catch (error: unknown) {
      return failure(ioFailed(`the report journal could not be read: ${error instanceof Error ? error.message : String(error)}`), caller, me)
    }
  }

  if (!caller.writable) {
    return failure(readOnlySession(caller.reason ?? 'changing the dispatch ledger needs a writable session'), caller, me)
  }

  if (action === 'retry_report') {
    const id = asString(validated.value.id)
    if (id === undefined || id.trim() === '') return failure(invalidInput('retry_report needs `id`: the failed task id'), caller, me)
    if (reports === undefined) return failure(invalidInput('this dispatch has no report journal'), caller, me)
    try {
      const current = (await reports.all()).get(id.trim())
      if (current === undefined) return failure(notFound(id.trim(), 'dispatch report'), caller, me)
      if (current.status !== 'failed') return failure(invalidInput(`report ${id.trim()} is ${current.status}, not failed`), caller, me)
      if (current.reportText === undefined) {
        return failure(invalidInput(`report ${id.trim()} predates saved report text; inspect the child Session and handle it manually`), caller, me)
      }
      const reopened = await reports.retry(id.trim(), options.at)
      if (reopened === undefined) return failure(invalidInput(`report ${id.trim()} could not be reopened`), caller, me)
      const claimed = await reports.claim(id.trim(), options.at)
      if (claimed === undefined) return failure(ioFailed(`report ${id.trim()} was reopened but could not be claimed; retry again`), caller, me)
      const delivered = await deliverTaskReport(retryHost, {
        superSession: current.superSession,
        workspace: current.workspace.path === '' ? current.workspace.title : current.workspace.path,
        taskId: current.id,
        reportText: current.reportText,
      }, { id: current.sessionId }, new AbortController().signal)
      let settled
      try {
        settled = await reports.settle(id.trim(), delivered ? 'delivered' : 'failed', options.at,
          delivered ? undefined : 'the explicit report retry could not be delivered')
      } catch (error: unknown) {
        return failure(ioFailed(
          `report ${id.trim()} was ${delivered ? 'accepted by the recipient' : 'not delivered'}, but its delivery settlement could not be saved: ${error instanceof Error ? error.message : String(error)}; inspect report_status before retrying`,
        ), caller, me)
      }
      if (settled === undefined) return failure(ioFailed(`report ${id.trim()} has no journal entry after its delivery attempt`), caller, me)
      if (delivered && current.result !== undefined && current.outcome !== undefined) {
        await projectReportToLedger(retryHost, current, current.outcome, current.result, options.at, store)
      }
      return Object.freeze({
        ...verdict,
        task: Object.freeze({ id: current.id, result: current.result, outcome: current.outcome }),
        delivery: Object.freeze({ status: delivered ? 'delivered' : 'failed', attempts: claimed.record.attempts }),
        ...(delivered ? {} : { message: 'The retry failed; report_status retains the reason and the saved report can be retried again.' }),
      })
    } catch (error: unknown) {
      return failure(ioFailed(`the report could not be retried: ${error instanceof Error ? error.message : String(error)}`), caller, me)
    }
  }

  if (action === 'record') {
    const registry = workspaceRegistryOf(ctx)
    const selector = asString(validated.value.workspace)
    const task = asString(validated.value.task)
    if (task === undefined || task.trim() === '') return failure(invalidInput('record needs `task`'), caller, me)
    if (selector === undefined) return failure(invalidInput('record needs `workspace`'), caller, me)
    const workspace = findWorkspace(registry, selector)
    if (workspace === undefined) {
      return failure(invalidInput(`"${selector}" is not a registered workspace; run superagent_workspace roster first`), caller, me)
    }
    try {
      const issue = asString(validated.value.issue)
      if (store !== undefined) {
        const pending = pendingTask({
          workspaceId: workspace.id,
          workspaceTitle: workspace.title,
          workspacePath: workspace.path,
          task: task.trim(),
          dispatchedAt: options.at,
          ...(issue === undefined ? {} : { issue: String(issue) }),
        })
        const durable = await store.record(pending, caller.sessionId)
        if (durable !== undefined) return Object.freeze({ ...verdict, task: durable.task, file: durable.file })
      }
      const recorded = await recordDispatch(root, {
        id: workspace.id,
        title: workspace.title,
        path: workspace.path,
      }, {
        task: task.trim(),
        dispatchedAt: options.at,
        ...(issue === undefined ? {} : { issue: String(issue) }),
      })
      return Object.freeze({ ...verdict, task: recorded.task, file: recorded.file })
    } catch (error: unknown) {
      return failure(ioFailed(`the task could not be recorded: ${error instanceof Error ? error.message : String(error)}`), caller, me)
    }
  }

  if (action === 'resolve') {
    const id = asString(validated.value.id)
    const status = validated.value.status
    if (id === undefined || id.trim() === '') return failure(invalidInput('resolve needs `id`: the task id'), caller, me)
    if (status !== 'returned' && status !== 'failed') {
      return failure(invalidInput('resolve needs `status` of returned or failed; it cannot make a task pending'), caller, me)
    }
    const outcome = asString(validated.value.outcome)
    try {
      const artifacts = asStringList(validated.value.artifacts)
      const decisions = asStringList(validated.value.decisions)
      const durable = store === undefined ? undefined : await store.find(id.trim())
      const current = durable?.task ?? await findDispatchTask(root, id.trim())
      if (current === undefined) return failure(notFound(id.trim(), 'dispatch task'), caller, me)
      if (current.status === 'pending' && (outcome === undefined || outcome.trim() === '')) {
        return failure(invalidInput('the first resolution of a pending task needs a non-empty `outcome`'), caller, me)
      }
      if (current.status === 'failed' && status === 'returned' && (outcome === undefined || outcome.trim() === '')) {
        return failure(invalidInput('correcting a failed task to returned needs a non-empty `outcome`'), caller, me)
      }
      const nextStatus: 'returned' | 'failed' = status
      const patch = {
        status: nextStatus,
        updatedAt: options.at,
        ...(outcome === undefined ? {} : { outcome }),
        ...(artifacts === undefined ? {} : { artifacts }),
        ...(decisions === undefined ? {} : { decisions }),
        ...(asString(validated.value.issue) === undefined ? {} : { issue: String(validated.value.issue) }),
      }
      const resolved = durable === undefined
        ? await resolveDispatchTask(root, current, patch)
        : await store?.resolve(id.trim(), patch)
      if (resolved === undefined) return failure(notFound(id.trim(), 'dispatch task'), caller, me)
      // Memory is a separate durable conclusion layer. This hint is not a write.
      const memory = Object.freeze({
        kind: status === 'failed' ? 'open' : 'decision',
        content: `${resolved.task.workspaceTitle} ${resolved.task.id}: ${resolved.task.outcome ?? resolved.task.task}`,
        tags: Object.freeze(['superagent', resolved.task.workspaceTitle, resolved.task.id]),
      })
      return Object.freeze({ ...verdict, task: resolved.task, file: resolved.file, memory })
    } catch (error: unknown) {
      return failure(ioFailed(`the ledger task could not be resolved: ${error instanceof Error ? error.message : String(error)}`), caller, me)
    }
  }

  return failure(invalidInput(`unknown action "${String(action)}"`), caller, me)
}

/**
 * The last assistant text of one turn, skipping reasoning and tool-call blocks.
 *
 * Bound to the turn that just ended: a later turn's message already in the log must not become
 * this turn's task outcome.
 * @param agent - the Session whose turn ended.
 * @param turn - the ending turn number, when known.
 * @param endEvent - the committed `turn/end` event, when available.
 * @returns the last assistant text inside the turn, or undefined.
 */
const lastAssistantText = (agent: unknown, turn?: number, endEvent?: unknown): string | undefined => {
  const events = eventsOf(agent)
  const { lower, upper } = turnBounds(events, turn, endEvent)
  for (let index = upper - 1; index > lower; index -= 1) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
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
 * @param turnEnd - how the turn ended; a non-`completed` kind reports the failure instead of text.
 * @param endEvent - the committed `turn/end` event, so the outcome is that turn's last text.
 * @returns whether a report was delivered.
 */
export const deliverTaskReport = async (
  host: ToolHost,
  record: TaskSessionRecord,
  agent: unknown,
  signal: AbortSignal,
  turnEnd?: Readonly<{
    kind?: string
    error?: { message?: string; code?: string; status?: number }
    reason?: { kind?: string }
  }>,
  endEvent?: unknown,
  reports?: DispatchReportStore,
  store?: DispatchStore,
): Promise<boolean> => {
  const turnKind = turnEnd?.kind ?? turnEnd?.reason?.kind
  const taskId = record.taskId ?? record.ledger?.task.id
  const prepareReport = async (body: string): Promise<boolean> => {
    if (reports === undefined || taskId === undefined) return true
    const result = turnKind !== undefined && turnKind !== 'completed' ? 'failed' : 'returned'
    const outcome = result === 'returned'
      ? lastAssistantText(agent, undefined, endEvent) ?? 'the turn ended completed without assistant text'
      : `the turn ended ${turnKind}${turnEnd?.error?.message === undefined ? '' : `: ${turnEnd.error.message}`}`
    try {
      const bound = await reports.prepare(taskId, nowUtc(host.clock), body, outcome, result)
      if (bound !== undefined) {
        await projectReportToLedger(host, bound, outcome, result, nowUtc(host.clock), store, false)
        return true
      }
    } catch (error: unknown) {
      host.ctx.logger.warn('superagent: the report for %s could not be saved for retry: %s', taskId, String(error))
    }
    return false
  }
  const controller = sessionControllerOf(host.ctx)
  const sessionId = String((agent as { id?: unknown }).id)
  if (controller === undefined) {
    host.ctx.logger.warn('superagent: no session controller is available to deliver task %s', taskId ?? sessionId)
    return false
  }
  if (record.reportText !== undefined) {
    try {
      await controller.prompt({
        requestId: `superagent-report-${randomUUID()}`,
        sessionId: record.superSession,
        mode: 'queue',
        content: [{ type: 'text', text: record.reportText }],
      }, signal)
      return true
    } catch (error: unknown) {
      host.ctx.logger.warn(
        'superagent: the saved task report for %s could not be delivered: %s',
        record.superSession,
        error instanceof Error ? error.message : String(error),
      )
      return false
    }
  }
  const usageAfter = contextUsageOf(tokenMeterOf(host.ctx), (agent as { session?: unknown }).session)
  // A non-completed turn is never silent: the initiator hears the failure with its identity even
  // when the Session produced no assistant text.
  if (turnKind !== undefined && turnKind !== 'completed') {
    const failureFacts = [
      turnEnd?.error?.code === undefined ? undefined : `code ${turnEnd.error.code}`,
      turnEnd?.error?.status === undefined ? undefined : `status ${String(turnEnd.error.status)}`,
    ].filter((fact): fact is string => fact !== undefined)
    const detail = turnEnd?.error?.message === undefined
      ? ''
      : `: ${turnEnd.error.message.length <= 600 ? turnEnd.error.message : `${turnEnd.error.message.slice(0, 600)}…`}`
    const body = `[task-report] ${sessionId} in ${record.workspace} FAILED — its turn ended "${turnKind}"`
      + `${failureFacts.length === 0 ? '' : ` (${failureFacts.join(', ')})`}${detail}.`
      + contextMarker(record.usageBefore, usageAfter)
      + '\n\nThe Session is idle now. Inspect it (`superagent_session inspect`), then stop/abort, '
      + 'retry with a clean turn boundary, or compact; record the outcome with superagent_ledger '
      + 'resolve (status failed) and memory_write.'
    if (await prepareReport(body) === false) return false
    try {
      await controller.prompt({
        requestId: `superagent-report-${randomUUID()}`,
        sessionId: record.superSession,
        mode: 'queue',
        content: [{ type: 'text', text: body }],
      }, signal)
      return true
    } catch (error: unknown) {
      host.ctx.logger.warn(
        'superagent: the failure report for %s could not be delivered: %s',
        record.superSession,
        error instanceof Error ? error.message : String(error),
      )
      return false
    }
  }
  const text = lastAssistantText(agent, undefined, endEvent)
  if (text === undefined) {
    host.ctx.logger.warn(
      'superagent: the task report for %s from %s has no assistant text; sending a minimal report',
      record.superSession,
      sessionId,
    )
  }
  const body = text === undefined
    ? `[task-report] ${sessionId} in ${record.workspace} finished its turn`
      + (taskId === undefined ? '' : ` (task ${taskId})`)
      + `${contextMarker(record.usageBefore, usageAfter)}, but produced no assistant text.`
      + '\n\nInspect the Session (`superagent_session inspect`) and record the outcome with '
      + 'superagent_ledger resolve; do not assume the task succeeded.'
    : `[task-report] ${sessionId} in ${record.workspace} finished its turn`
      + (taskId === undefined ? '' : ` (task ${taskId})`)
      + `${contextMarker(record.usageBefore, usageAfter)}.`
      + `\n\n${text}\n\n`
      + 'Record the durable conclusion with memory_write (kind decision/open/files, tags including '
      + 'superagent, the workspace and the task id); use superagent_ledger resolve for any outcome, '
      + 'artifact or decision the automatic record could not know.'
  if (await prepareReport(body) === false) return false
  try {
    await controller.prompt({
      requestId: `superagent-report-${randomUUID()}`,
      sessionId: record.superSession,
      mode: 'queue',
      content: [{ type: 'text', text: body }],
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

/**
 * Find the oldest pending dispatch whose ledger `session` field names this workspace Session.
 *
 * This is the compatibility/FIFO view for records written before prompt identities were stored.
 * The in-memory task map is intentionally not the source of truth: a live plugin reload while a
 * long workspace turn runs replaces the map, but the ledger survives.
 * @param root - the super workspace root that owns `.superagent/ledger`.
 * @param sessionId - the workspace Session whose turn just ended.
 * @returns the oldest pending task, or undefined when none is bound to this Session.
 */
export const pendingDispatchForSession = async (
  root: string,
  sessionId: string,
): Promise<DispatchLedgerTask | undefined> => {
  const rows = await listDispatchTasks(root, { status: 'pending', limit: 100 })
  return rows.filter(row => row.sessionId === sessionId).at(-1)
}

/** The prompt identities one turn claimed, read from its own `user/message` events. */
interface TurnPromptScan {
  /** Request identities in claim order; each is the `requestId` of one admitted dispatch. */
  readonly requestIds: readonly string[]
  /** Whether the turn carries any prompt identity at all. */
  readonly sawPrompt: boolean
}

/**
 * Read the prompt identities recorded inside one turn.
 *
 * The turn boundary comes from the `turn/start` matching the ending turn; when the log does not
 * carry turn numbers (older/duck-typed hosts), the whole visible log is scanned rather than
 * guessing from dispatch time.
 * @param agent - the Session whose turn ended.
 * @param turn - the ending turn number, when known.
 * @param endEvent - the committed `turn/end` event, for its seq.
 * @returns the request identities and whether any prompt was seen.
 */
const turnPromptScan = (agent: unknown, turn: number | undefined, endEvent: unknown): TurnPromptScan => {
  const events = eventsOf(agent)
  const { lower, upper } = turnBounds(events, turn, endEvent)
  const requestIds: string[] = []
  let sawPrompt = false
  for (let index = lower + 1; index < upper; index += 1) {
    const event = events[index]
    if (event?.type !== 'user/message') continue
    const source = (event.data as { source?: { kind?: string; rpcId?: string } } | undefined)?.source
    if (source?.kind !== 'user' || typeof source.rpcId !== 'string' || source.rpcId === '') continue
    sawPrompt = true
    if (!requestIds.includes(source.rpcId)) requestIds.push(source.rpcId)
  }
  return Object.freeze({ requestIds: Object.freeze(requestIds), sawPrompt })
}

/**
 * Pick the visible super Session that owns a recovered report. The ledger records the child
 * Session but not its dispatcher, so prefer the newest visible Session in the super workspace;
 * fall back to a live root agent when the controller cannot list Sessions.
 * @param host - the plugin host, for the session controller.
 * @param superHome - the super workspace root.
 * @param liveAgents - agents currently known to the capability.
 * @returns the receiving Session id, or undefined when no dispatcher is visible.
 */
const superSessionForReport = async (
  host: ToolHost,
  superHome: string,
  liveAgents: Iterable<unknown>,
): Promise<string | undefined> => {
  const controller = sessionControllerOf(host.ctx)
  if (controller !== undefined) {
    try {
      const listed = await controller.list()
      const candidates = listed.items
        .filter(item => item.parentSessionId === undefined && item.origin !== 'subagent')
        .filter(item => item.cwd !== undefined && sameCheckout(item.cwd, superHome))
        .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
      const newest = candidates[0]
      if (newest !== undefined) return String(newest.sessionId)
    } catch (error: unknown) {
      host.ctx.logger.warn(
        'superagent: could not list Sessions to recover a pending dispatch report: %s',
        error instanceof Error ? error.message : String(error),
      )
    }
  }
  for (const agent of liveAgents) {
    if (isSuperAgentSession(agent, superHome)) return String((agent as { id?: unknown }).id)
  }
  return undefined
}

/**
 * Settle one dispatch report after a delivery attempt, logging (never throwing) a journal failure.
 * @param host - the plugin host, for the warning.
 * @param journal - the report journal.
 * @param id - the dispatch id.
 * @param status - the settled status.
 * @param at - the settlement instant.
 * @param error - why a failed delivery could not be sent.
 * @returns after the append attempt.
 */
const settleReport = async (
  host: ToolHost,
  journal: DispatchReportStore,
  id: string,
  status: 'delivered' | 'failed',
  at: Timestamp,
  error?: string,
): Promise<void> => {
  try {
    await journal.settle(id, status, at, error)
  } catch (failure: unknown) {
    host.ctx.logger.warn(
      'superagent: the report journal entry for %s could not record %s: %s',
      id,
      status,
      failure instanceof Error ? failure.message : String(failure),
    )
  }
}

/**
 * Project a delivered report into its human-readable ledger entry, when the dispatch opted in.
 *
 * This is the jira side of a dispatch and runs only after the report itself has been built; a
 * failure here is logged and changes nothing about delivery. The report journal, not this
 * projection, is what bound the turn to its task.
 * @param host - the plugin host, for the warning.
 * @param report - the dispatch report being delivered.
 * @param outcome - the text to record.
 * @param status - `returned` for a completed turn, `failed` for a non-completed one.
 * @param at - the settlement instant.
 * @param store - the durable ledger store, when composed.
 * @returns after the best-effort projection attempt.
 */
const projectReportToLedger = async (
  host: ToolHost,
  report: DispatchReportRecord,
  outcome: string,
  status: 'returned' | 'failed',
  at: Timestamp,
  store?: DispatchStore,
  project = true,
): Promise<void> => {
  const ledger = report.ledger
  if (ledger === undefined) return
  try {
    const patch = { status, updatedAt: at, outcome }
    if (store !== undefined) {
      const resolved = await store.resolve(ledger.taskId, patch, { project })
      if (resolved !== undefined && !project) return
      if (project) {
        const projected = await store.project(ledger.taskId)
        if (projected !== undefined) return
      }
    }
    if (!project) return
    const task = await findDispatchTask(ledger.root, ledger.taskId)
    if (task === undefined) {
      host.ctx.logger.warn(
        'superagent: the ledger projection for dispatch %s is missing; the report delivery is unaffected',
        ledger.taskId,
      )
      return
    }
    await resolveDispatchTask(ledger.root, task, patch)
  } catch (error: unknown) {
    host.ctx.logger.warn(
      'superagent: the ledger projection for dispatch %s failed; the report delivery is unaffected: %s',
      ledger.taskId,
      error instanceof Error ? error.message : String(error),
    )
  }
}

/**
 * Resolve a dispatched Session's turn end into the report of the task that turn actually ran.
 *
 * The binding is the report journal this superagent owns: a dispatch records
 * `sessionId + requestId + superSession` **before** the child prompt is admitted, so the turn end
 * never depends on the jira dispatch ledger, its `pending` state, or its `dispatched` field. The
 * turn's own `user/message.source.rpcId` is the deterministic key; a record written before prompt
 * identities existed falls back to FIFO only when the turn carries no prompt identity at all.
 *
 * A report is claimed before delivery and settled after it: a replayed turn end finds `delivered`
 * and posts nothing, while a failed delivery is marked `failed` and logged. A known dispatched
 * Session whose binding cannot name a recipient is an explicit warning, never a silent drop.
 *
 * This is the logic behind `onTurnEnd`, kept separate so a remount can be exercised with an empty
 * {@link SessionToolContext.tasks} map. A missing report recipient or a failed delivery never
 * throws out of the turn-end hook.
 * @param host - the plugin host.
 * @param input - the child Session's turn-end input.
 * @param tasks - the capability's live dispatch queues, used only for pre-dispatch usage facts.
 * @param livingAgents - currently known agents, used only when the controller cannot list.
 * @param superHome - the configured super workspace root.
 * @param store - the durable ledger store, used only for the best-effort ledger projection.
 * @param reports - the report journal; defaults to the journal at {@link superHome}.
 * @returns whether this turn end belonged to a dispatched Session and was handled.
 */
export const handleTaskTurnEnd = async (
  host: ToolHost,
  input: TurnEndInput,
  tasks: Map<string, readonly TaskSessionRecord[]>,
  livingAgents: Iterable<unknown>,
  superHome: string | undefined,
  store?: DispatchStore,
  reports?: DispatchReportStore,
): Promise<boolean> => {
  const sessionId = String(input.agent.id)
  const journal = reports ?? (superHome === undefined ? undefined : reportStoreAt(superHome))
  if (journal === undefined) return false
  let bindings: readonly DispatchReportRecord[]
  try {
    bindings = await journal.forSession(sessionId)
  } catch (error: unknown) {
    host.ctx.logger.warn(
      'superagent: the dispatch report journal for %s could not be read: %s',
      sessionId,
      error instanceof Error ? error.message : String(error),
    )
    return false
  }
  // No binding means this turn was not dispatched through this capability; staying quiet is the
  // only correct behaviour (a person's own Session must not be treated as a lost report).
  if (bindings.length === 0) return false

  const turn = typeof input.turn === 'number'
    ? input.turn
    : (input.event.data as { turn?: number } | undefined)?.turn
  const scan = turnPromptScan(input.agent, turn, input.event)
  const pending = bindings.filter(binding => binding.status === 'pending' || binding.status === 'delivering')
  const targets: DispatchReportRecord[] = []
  const settled = new Set<string>()
  for (const requestId of scan.requestIds) {
    const binding = bindings.find(candidate => candidate.requestId === requestId)
    if (binding === undefined) continue
    if (binding.status === 'pending' || binding.status === 'delivering') {
      if (!targets.some(target => target.id === binding.id)) targets.push(binding)
    } else {
      settled.add(binding.id)
    }
  }
  // A turn whose log carries no prompt identity cannot contradict FIFO: bind the oldest pending
  // dispatch for this Session, which is the only order left for records written before identities.
  if (targets.length === 0 && !scan.sawPrompt) {
    const oldest = pending
      .slice()
      .sort((left, right) => left.dispatchedAt === right.dispatchedAt
        ? (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
        : (left.dispatchedAt < right.dispatchedAt ? -1 : 1))[0]
    if (oldest !== undefined) targets.push(oldest)
  }
  if (targets.length === 0) {
    // A replayed turn end for an already-settled binding is consumed, never re-sent. A pending
    // binding with a different prompt identity belongs to another turn on this Session and is left
    // alone. With no pending work at all the Session is still ours, so the dispatcher pass must not
    // treat this turn as an ordinary workspace turn.
    if (settled.size > 0) return true
    return pending.length === 0
  }

  const reason = input.event.data.reason as {
    kind?: string
    error?: { message?: string; code?: string; status?: number }
  }
  const turnKind = reason.kind
  const completed = turnKind === undefined || turnKind === 'completed'
  const text = completed ? lastAssistantText(input.agent, turn, input.event) : undefined
  const at = nowUtc(host.clock)
  let handled = false
  for (const binding of targets) {
    let claimed
    try {
      claimed = await journal.claim(binding.id, at)
    } catch (error: unknown) {
      host.ctx.logger.warn(
        'superagent: dispatch %s for %s could not be claimed for its report: %s',
        binding.id,
        sessionId,
        error instanceof Error ? error.message : String(error),
      )
      continue
    }
    // Lost the claim to a concurrent/replayed hook or already settled: never deliver twice.
    if (claimed === undefined) continue
    if (claimed.retried) {
      host.ctx.logger.warn(
        'superagent: dispatch %s for %s had an unsettled delivery claim; retrying the report',
        binding.id,
        sessionId,
      )
    }
    handled = true
    let report = claimed.record
    if (report.superSession.trim() === '') {
      const superSession = await superSessionForReport(host, journal.root, livingAgents)
      if (superSession === undefined) {
        const message = 'turn ended; no visible super Session was available to receive the report'
        host.ctx.logger.warn(
          'superagent: dispatch %s for %s is bound, but no super Session is visible to receive the report',
          report.id,
          sessionId,
        )
        await settleReport(host, journal, report.id, 'failed', at, message)
        continue
      }
      report = { ...report, superSession }
    }
    const outcome = completed
      ? text ?? 'the turn ended completed without assistant text'
      : `the turn ended ${turnKind ?? 'unknown'}${reason.error?.message === undefined ? '' : `: ${reason.error.message}`}`
    const known = report.requestId === undefined
      ? tasks.get(sessionId)?.at(-1)
      : tasks.get(sessionId)?.find(candidate => candidate.requestId === report.requestId)
    const taskRecord: TaskSessionRecord = {
      superSession: report.superSession,
      workspace: report.workspace.path === '' ? report.workspace.title : report.workspace.path,
      taskId: report.id,
      ...(report.requestId === undefined ? {} : { requestId: report.requestId }),
      ...(known?.usageBefore === undefined ? {} : { usageBefore: known.usageBefore }),
    }
    let delivered = false
    try {
      delivered = await deliverTaskReport(host, taskRecord, input.agent, input.signal, reason, input.event, journal, store)
    } catch (error: unknown) {
      host.ctx.logger.warn(
        'superagent: the task report for %s from %s could not be delivered: %s',
        report.superSession,
        sessionId,
        error instanceof Error ? error.message : String(error),
      )
    }
    if (delivered) {
      await settleReport(host, journal, report.id, 'delivered', at)
      await projectReportToLedger(host, report, outcome, completed ? 'returned' : 'failed', at, store)
    } else {
      host.ctx.logger.warn(
        'superagent: dispatch %s for %s finished its turn but the report was NOT delivered; marking the report delivery failed',
        report.id,
        sessionId,
      )
      await settleReport(host, journal, report.id, 'failed', at, 'the report could not be delivered to the super Session')
    }
  }
  return handled
}

/** The dispatch record lives in its own module so `issue_work` can read the same binding. */
export { DISPATCH_MARKER, dispatchBody, dispatchRecordOf } from './dispatch.ts'
export type { DispatchRecord, DispatchStatus } from './dispatch.ts'

/** How many issues one dispatcher may keep in progress at once, unless the row says otherwise. */
export const DEFAULT_MAX_WORKERS = 2

/** The context percentage at which a Session row starts suggesting compaction (a suggestion only). */
export const DEFAULT_COMPACT_THRESHOLD_PERCENT = 30

/** Minutes a running Session may run before the monitor suggests looking at it (a suggestion only). */
export const DEFAULT_LONG_RUNNING_MINUTES = 10

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
  /**
   * Abort one Session's active turn. The host keeps the inbox and records its own turn-end, so the
   * caller can continue the Session afterwards with an ordinary prompt.
   */
  cancel?(request: { readonly sessionId: string }): { readonly accepted: boolean } | Promise<{ readonly accepted: boolean }>
  /**
   * Record a model selection for the Session's next turn. The host validates the route against
   * its LLM registry, then writes the durable selection projection the next step reads.
   */
  selectModel?(request: {
    readonly sessionId: string
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string
  }): Promise<{ readonly selected: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string } }>
  /** Record the Session's durable display title; optional on a host without a title service. */
  rename?(request: {
    readonly sessionId: string
    readonly title: string
  }): Promise<{ readonly title: string; readonly seq?: unknown }>
  /**
   * Resolve (resuming when cold) the Agent for one Session. Compaction and live-context
   * measurement are Agent operations, so this is the host seam that makes both reachable.
   */
  resolveAgent?(sessionId: string): Promise<{ readonly agent?: unknown; readonly error?: unknown }>
  /** Branch one Session from a completed-turn prefix; optional on a host without the verb. */
  fork?(request: {
    readonly sessionId: string
    readonly atSeq?: number
  }): Promise<{ readonly sessionId: unknown }>
  /**
   * Permanently delete one stored Session, when the host can. Deliberately optional: current hosts
   * expose archive only, and this adapter refuses `delete` rather than silently archiving.
   */
  delete?(sessionId: string): Promise<void>
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

/** The tool that starts a real Session instead of a subagent (DH-702). */
export const DISPATCH_TOOL_NAME = 'superagent_dispatch'

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
    const running = agentsOf(ctx)?.get(sessionId)
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
        ...(running === undefined ? {} : { activity: activityOf(running, Date.now()) }),
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
 * @param agentPreset - the preset a started workspace Session joins; unset keeps the deployment default.
 * @param writeRegisteredWorkspaces - whether super-agent sessions may hand files to every registered
 *   workspace through the in-process filesystem fence; defaults to true.
 * @param compactThresholdPercent - the context percentage at which a Session row suggests compacting;
 *   a suggestion for the super agent, never an automatic compaction (default 30).
 * @param longRunningMinutes - minutes a running Session may run before the monitor names it in the
 *   super agent's context; a suggestion, never an automatic abort (default 10).
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
  writeRegisteredWorkspaces = true,
  compactThresholdPercent: number = DEFAULT_COMPACT_THRESHOLD_PERCENT,
  longRunningMinutes: number = DEFAULT_LONG_RUNNING_MINUTES,
): CapabilityContribution => {
  const liveAgents = new Set<Agent>()
  let timer: ReturnType<typeof setInterval> | undefined
  let polling = false
  // Set by dispose(). The timer stops immediately, but a pass already admitted keeps running until
  // its next checkpoint; every entry point re-checks the flag so a disabled capability cannot
  // write a proposal or start a daemon pass after its teardown began.
  let disposed = false
  const superHome = home === undefined || home.trim() === '' ? undefined : home
  /** Sessions this super agent started or addressed, so their turn ends report back (DH-719). */
  const tasks = new Map<string, readonly TaskSessionRecord[]>()
  // Optional by design: a composition without storageDomain keeps the Markdown ledger.
  const dispatchStore = superHome === undefined ? undefined : createDispatchStore(host.ctx, superHome)
  // The report journal is superagent-owned and deliberately outside the ledger: it binds a child
  // turn to its dispatch before the prompt is admitted, so reports never depend on ledger state.
  const reportStore = superHome === undefined ? undefined : reportStoreAt(superHome)
  // The filesystem fence gets the registered workspaces, so the super agent can hand files over
  // without widening process confinement: shell and terminal backends never see these roots.
  let fsRootsDispose: (() => void) | undefined
  if (writeRegisteredWorkspaces && superHome !== undefined) {
    const sandboxPolicy = (host.ctx as { get?: (key: string) => unknown }).get?.('sandboxPolicy') as
      | { registerFsWritableRoots?: (provider: (session: unknown) => readonly string[] | undefined) => () => void }
      | undefined
    fsRootsDispose = sandboxPolicy?.registerFsWritableRoots?.(session => superAgentFsRoots(host.ctx, session, superHome))
  }
  // The super agent sees a refreshed long-running summary on every request, without polling: the
  // host rebuilds runtime context per request, and an empty summary contributes nothing.
  let monitorDispose: (() => void) | undefined
  const inject = (host.ctx as { inject?: (names: readonly string[], callback: (scope: unknown) => void) => unknown }).inject
  if (superHome !== undefined && typeof inject === 'function') {
    inject.call(host.ctx, ['systemPrompt'], (scope) => {
      const systemPrompt = (scope as {
        systemPrompt?: { context?: (entry: {
          name: string
          order: number
          text: (context: { agent?: unknown }) => string
        }) => () => void }
      }).systemPrompt
      if (systemPrompt?.context === undefined) return
      monitorDispose = systemPrompt.context({
        name: 'superagent:running',
        order: 705,
        text: (context: { agent?: unknown }) => isSuperAgentSession(context.agent, superHome)
          ? longRunningSummary(host.ctx, superHome, longRunningMinutes * 60_000)
          : '',
      })
    })
  }
  const daemonWorkspace = daemon?.workspace
  const daemonEnabled = daemon?.enabled === true && daemonWorkspace !== undefined && daemonWorkspace.trim() !== ''
  const poll = async (): Promise<void> => {
    if (disposed || polling) return
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
        if (disposed) return
      }
      if (live === undefined || disposed) return
      await runSuperagentPass(host, live, undefined, workerPreset, maxWorkers)
    } finally {
      polling = false
    }
  }
  // Archive/stop is the lifecycle signal available to a capability; retain the durable record and
  // mark it orphaned rather than deleting audit history. The Markdown projection stays untouched.
  let orphanDispose: (() => void) | undefined
  let domainChangeDispose: (() => void) | undefined
  const onEvent = (host.ctx as {
    on?: (event: string, handler: (payload: { sessionId: unknown }) => Promise<void> | void) => () => void
  }).on
  if ((dispatchStore !== undefined || reportStore !== undefined) && typeof onEvent === 'function') {
    orphanDispose = onEvent.call(host.ctx, 'workspace/session-stop', async ({ sessionId }) => {
      const id = String(sessionId)
      const at = nowUtc(host.clock)
      try {
        await dispatchStore?.markOrphaned(id, at)
      } catch (error: unknown) {
        host.ctx.logger.warn('superagent: could not mark dispatch records for %s orphaned: %s', id, String(error))
      }
      try {
        await reportStore?.failPendingForSessions([id], at, 'the Session was stopped before its report was delivered')
      } catch (error: unknown) {
        host.ctx.logger.warn('superagent: could not fail pending reports for stopped Session %s: %s', id, String(error))
      }
    })
  }
  // Plain archive (without stopActivity) emits no workspace/session-stop; the workspace domain's
  // global archivedSessionIds set is the durable archive signal. Mark records orphaned there too.
  const onDomain = (host.ctx as {
    on?: (event: string, handler: (change: unknown) => void) => () => void
  }).on
  if ((dispatchStore !== undefined || reportStore !== undefined) && typeof onDomain === 'function') {
    domainChangeDispose = onDomain.call(host.ctx, 'domain/changed', (change: unknown) => {
      const event = change as {
        domain?: string
        table?: string
        operation?: string
        value?: { archivedSessionIds?: unknown }
      }
      if (event.domain !== 'workspace' || event.table !== '' || event.operation !== 'put'
        || !Array.isArray(event.value?.archivedSessionIds)) return
      const archived = event.value.archivedSessionIds.filter((id): id is string => typeof id === 'string')
      const at = nowUtc(host.clock)
      void dispatchStore?.markArchivedSessions(archived, at).catch((error: unknown) => {
        host.ctx.logger.warn('superagent: could not mark archived dispatch records orphaned: %s', String(error))
      })
      void reportStore?.failPendingForSessions(archived, at, 'the Session was archived before its report was delivered').catch((error: unknown) => {
        host.ctx.logger.warn('superagent: could not fail pending reports for archived Sessions: %s', String(error))
      })
    })
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
  const models: Spec = {
    name: MODELS_TOOL_NAME,
    description: MODELS_DESCRIPTION,
    parameters: MODELS_PARAMETERS,
    outputSchema: SUPERAGENT_OUTPUT_SCHEMA,
    timeoutMs: 15_000,
    isConcurrencySafe: () => true,
    render: (typed) => {
      if (Array.isArray(typed.providers)) {
        const providers = typed.providers as { id: string; name: string }[]
        if (providers.length === 0) return renderText('(no LLM providers)')
        return renderText(providers.map(provider => `${provider.id} — ${provider.name}`).join('\n'))
      }
      const rows = Array.isArray(typed.models)
        ? typed.models as { provider: string; id: string; name: string; description?: string; efforts: readonly AdvertisedEffort[] }[]
        : []
      if (rows.length === 0) return renderText('(no models)')
      return renderText(rows.map(row => modelLine({
        provider: row.provider,
        id: row.id,
        name: row.name,
        ...(row.description === undefined ? {} : { description: row.description }),
        efforts: row.efforts,
      })).join('\n'))
    },
    run: (args, call) => runModelsTool(args, runOptionsOf(host, call), call.me, host.ctx),
  }
  const ledger: Spec = {
    name: LEDGER_TOOL_NAME,
    description: LEDGER_DESCRIPTION,
    parameters: LEDGER_PARAMETERS,
    outputSchema: SUPERAGENT_OUTPUT_SCHEMA,
    timeoutMs: 30_000,
    // The ledger appends to a file, so the conservative default applies.
    isConcurrencySafe: () => false,
    render: (typed) => {
      if (Array.isArray(typed.entries)) {
        const rows = typed.entries as { id: string; status: string; workspaceTitle: string; task: string }[]
        const counts = typed.counts as { remaining?: number } | undefined
        const suffix = counts?.remaining === undefined || counts.remaining === 0
          ? ''
          : `\n… ${String(counts.remaining)} more matching task(s); narrow the query or raise \`limit\``
        return renderText((rows.length === 0
          ? 'the dispatch ledger has no matching task'
          : rows.map(row => 'reportText' in row
            ? `${row.id}  report ${row.status}  ${row.workspaceTitle}  ${row.task}${'error' in row && typeof row.error === 'string' ? `\n  ${row.error}` : ''}`
            : `${row.id}  ${row.status}  ${row.workspaceTitle}  ${row.task}`).join('\n')) + suffix)
      }
      const task = typed.task as { id?: string; status?: string; workspaceTitle?: string } | undefined
      return renderText(task?.id === undefined
        ? 'ok'
        : `${String(task.id)}  ${String(task.status)}  ${String(task.workspaceTitle)}`)
    },
    run: (args, call) => runLedgerTool(args, runOptionsOf(host, call), call.me, host.ctx, dispatchStore, reportStore),
  }
  const permission: Spec = {
    name: PERMISSION_TOOL_NAME,
    description: PERMISSION_DESCRIPTION,
    parameters: PERMISSION_PARAMETERS,
    outputSchema: SUPERAGENT_OUTPUT_SCHEMA,
    timeoutMs: 30_000,
    isConcurrencySafe: args => (args as { action?: unknown }).action !== 'set',
    render: (typed) => {
      if (Array.isArray(typed.presets)) {
        const rows = typed.presets as { preset: string; description: string }[]
        return renderText(rows.map(row => `${row.preset} — ${row.description}`).join('\n'))
      }
      const current = typed.permission as { session?: string; preset?: string; kind?: string; toolPolicy?: string } | undefined
      return renderText(current?.session === undefined ? 'ok' : `${current.session}  ${current.preset ?? current.kind ?? 'unavailable'}`)
    },
    run: (args, call) => runPermissionTool(args, runOptionsOf(host, call), call.me, host.ctx),
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
        const rows = typed.sessions as {
          id: string
          title?: string
          lastTask?: string
          model?: { provider: string; model: string; reasoningEffort?: string }
          running: boolean
          cwd?: string
          blank?: boolean
          updatedAt?: number
          usage?: { percent?: number }
          cacheHitPercent?: number
          recommendCompact?: boolean
          longRunning?: boolean
          lastTurnError?: { turn?: number; kind?: string; message?: string }
          status?: { elapsedMs?: number }
        }[]
        if (rows.length === 0) return renderText('no Session in that workspace')
        return renderText(rows
          .map((row) => {
            const model = row.model === undefined
              ? ''
              : `  ${row.model.provider}/${row.model.model}${row.model.reasoningEffort === undefined ? '' : ` (${row.model.reasoningEffort})`}`
            const lastErrorMessage = row.lastTurnError?.message
            const error = row.lastTurnError === undefined
              ? ''
              : `\n    last turn ${row.lastTurnError.kind}${lastErrorMessage === undefined
                ? ''
                : `: ${lastErrorMessage.length <= 160 ? lastErrorMessage : `${lastErrorMessage.slice(0, 160)}…`}`}`
            const elapsed = row.status?.elapsedMs
            const parts = [
              `${row.id}  ${row.title ?? '(untitled)'}  ${row.running ? 'running' : 'idle'}${row.blank === true ? '  (blank)' : ''}`,
              elapsed === undefined ? '' : `  ${durationText(elapsed)}`,
              row.usage?.percent === undefined ? '' : `  context ${row.usage.percent}%`,
              model,
              row.cacheHitPercent === undefined ? '' : `  cache ${row.cacheHitPercent}%`,
              `${row.recommendCompact === true ? '  (consider compact)' : ''}${row.longRunning === true ? '  (long-running)' : ''}`,
              `${row.updatedAt === undefined ? '' : `  active ${new Date(row.updatedAt).toISOString()}`}  ${row.cwd ?? ''}`,
              row.lastTask === undefined ? '' : `\n    last: ${row.lastTask}`,
              error,
            ]
            return parts.join('')
          })
          .join('\n'))
      }
      const compaction = typed.compaction as {
        before?: { percent?: number }
        after?: { percent?: number }
        shadowedTokens?: number
      } | undefined
      if (compaction !== undefined) {
        const compactParts = [
          `compacted${compaction.before?.percent === undefined ? '' : ` ${compaction.before.percent}%`}`,
          compaction.after?.percent === undefined ? '' : ` → ${compaction.after.percent}%`,
          compaction.shadowedTokens === undefined ? '' : ` (${compaction.shadowedTokens} tokens shadowed)`,
        ]
        return renderText(compactParts.join(''))
      }
      const one = typed.session as { id?: string; archived?: boolean; forkedFrom?: string; sessionTitle?: string } | undefined
      if (one?.id === undefined) return renderText('ok')
      const status = typed.status as {
        running?: boolean
        elapsedMs?: number
        lastActivityAgeMs?: number
        inFlightTool?: string
        lastTool?: string
        lastError?: string
      } | undefined
      const stop = typed.stop as {
        accepted?: boolean
        wasRunning?: boolean
        alreadyIdle?: boolean
        cancelledVia?: string
        clearedQueue?: boolean
        idle?: boolean
        boundary?: { seq?: number; turnEndReason?: string }
      } | undefined
      if (stop !== undefined) {
        if (stop.accepted !== true) return renderText(`session ${one.id} is already idle; nothing to stop`)
        const scene = typed.stop as { scene?: { status?: { elapsedMs?: number; inFlightTool?: string; lastTool?: string } } }
        const sceneStatus = scene.scene?.status
        const stopParts = [
          `stopped ${one.id} (cut off`,
          sceneStatus?.elapsedMs === undefined ? '' : ` after ${durationText(sceneStatus.elapsedMs)}`,
          sceneStatus?.inFlightTool === undefined ? '' : `, ${sceneStatus.inFlightTool} was in flight`,
          `, via ${stop.cancelledVia ?? 'the host'}${stop.clearedQueue === true ? ', queue cleared' : ''}`,
          stop.idle === true ? ', idle now' : ', not idle yet',
          stop.boundary?.seq === undefined ? '' : `, log ends at seq ${stop.boundary.seq}`,
          `${stop.boundary?.turnEndReason === undefined ? '' : ` (${stop.boundary.turnEndReason})`})`,
        ]
        return renderText(stopParts.join(''))
      }
      const abort = typed.abort as { resumed?: boolean } | undefined
      if (abort !== undefined) {
        const abortedParts = [
          `aborted ${one.id}${status?.elapsedMs === undefined ? '' : ` after ${durationText(status.elapsedMs)}`}`,
          abort.resumed === true ? ' → continued' : '',
        ]
        return renderText(abortedParts.join(''))
      }
      const activity = typed.activity as readonly {
        seq?: number
        type?: string
        tool?: string
        error?: string
        text?: string
      }[] | undefined
      if (activity !== undefined) {
        const headParts = [
          `session ${one.id}${status?.running === true ? ` running ${durationText(status.elapsedMs ?? 0)}` : ' idle'}`,
          status?.inFlightTool === undefined ? '' : `, tool ${status.inFlightTool} in flight`,
          status?.lastError === undefined ? '' : `, last error ${status.lastError}`,
        ]
        const trail = activity.map(row => `${String(row.type)}${row.tool === undefined ? '' : ` ${row.tool}`}${row.error === undefined ? '' : ` [${row.error}]`}`).join('\n')
        return renderText(`${headParts.join('')}\n${trail}`)
      }
      if (one.archived === true) return renderText(`archived ${one.id}`)
      if (one.forkedFrom !== undefined) return renderText(`branched ${one.forkedFrom} → ${one.id}`)
      const delivery = typed.delivery as { used?: string; fallback?: boolean; insertedAtSeq?: number } | undefined
      const howParts = delivery === undefined
        ? []
        : [
          `  ${delivery.used === 'interrupt' ? 'interrupted' : 'queued'}${delivery.fallback === true ? ' (fallback)' : ''}`,
          delivery.insertedAtSeq === undefined ? '' : ` at seq ${delivery.insertedAtSeq}`,
        ]
      const how = howParts.join('')
      const echo = typed.model as {
        provider?: string
        model?: string
        reasoningEffort?: string
        fallback?: boolean
        deferred?: boolean
      } | undefined
      const echoModel = echo?.provider === undefined
        ? ''
        : `  → ${echo.provider}/${echo.model}${echo.reasoningEffort === undefined ? '' : ` (${echo.reasoningEffort})`}${echo.fallback === true ? ' (host fallback)' : ''}${echo.deferred === true ? ' (takes effect at the next turn boundary)' : ''}`
      return renderText(`session ${one.id}${one.sessionTitle === undefined ? '' : ` "${one.sessionTitle}"`}${how}${echoModel}`)
    },
    run: (args, call) => runSessionTool(args, runOptionsOf(host, call), call.me, host.ctx, {
      ...(agentPreset === undefined ? {} : { agentPreset }),
      tasks,
      ...(dispatchStore === undefined ? {} : { store: dispatchStore }),
      ...(reportStore === undefined ? {} : { reports: reportStore }),
      compactThresholdPercent,
      longRunningMinutes,
    }),
  }
  const deliver: Spec = {
    name: DELIVER_TOOL_NAME,
    description: DELIVER_DESCRIPTION,
    parameters: DELIVER_PARAMETERS,
    outputSchema: SUPERAGENT_OUTPUT_SCHEMA,
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    render: (typed) => {
      const file = typed.delivered as { path?: string; bytes?: number } | undefined
      return renderText(file?.path === undefined
        ? 'ok'
        : `delivered ${file.path} (${String(file.bytes ?? 0)} bytes)`)
    },
    run: (args, call) => runDeliverTool(args, runOptionsOf(host, call), call.me, host.ctx),
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
        ? Object.freeze([
          defineJiraTool(host, workspace),
          defineJiraTool(host, session),
          defineJiraTool(host, ledger),
          defineJiraTool(host, models),
          defineJiraTool(host, permission),
          defineJiraTool(host, deliver),
        ])
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
      if (disposed) return
      // DH-719: a Session this super agent started addresses reports back here as a queued message,
      // so the person's conversation is never held while that workspace works. A turn that did not
      // complete still reports: silence is how a failed workspace Session went unnoticed (DH-722 era).
      // The task map is only a fast path: a live reload during a long turn replaces it, while the
      // ledger keeps the pending dispatch and its `session` binding. handleTaskTurnEnd recovers that
      // binding before delivering, so a remount cannot silently drop the report.
      if (await handleTaskTurnEnd(host, input, tasks, liveAgents, superHome, dispatchStore, reportStore)) return
      // An executor Session is a root agent, but it must not propose new work (DH-703 review):
      // its turn end is delivery, not dispatch.
      if (isExecutorSession(input.agent, workerPreset)) return
      // DH-716: the super agent's turn end is a report to the person, not a pass over the ledger.
      if (isSuperAgentSession(input.agent, superHome)) return
      await runSuperagentPass(host, input.agent, input.signal, workerPreset, maxWorkers)
    },
    dispose: () => {
      disposed = true
      monitorDispose?.()
      monitorDispose = undefined
      fsRootsDispose?.()
      fsRootsDispose = undefined
      orphanDispose?.()
      orphanDispose = undefined
      domainChangeDispose?.()
      domainChangeDispose = undefined
      // The capability contract's dispose() is synchronous, so this close is deliberately not
      // awaited: the identity, timers and listeners above stop immediately, while the durable
      // store finishes its own close on its own task. Its failure is logged, never thrown.
      void dispatchStore?.close().catch((error: unknown) => {
        host.ctx.logger.warn('superagent: closing the dispatch store failed: %s', String(error))
      })
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
      liveAgents.clear()
    },
  })
}
