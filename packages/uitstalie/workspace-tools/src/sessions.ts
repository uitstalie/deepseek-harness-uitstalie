/**
 * `workspace_sessions`: which sessions a workspace has, what each is doing, and
 * the lifecycle of a real Session in a registered workspace.
 *
 * Status, current activity, and recent progress are folded from the session's
 * own log, so the answer is the durable record rather than a remembered copy.
 * The tool returns bounded one-line summaries; raw turns stay behind
 * `session_event_read`. Lifecycle actions (`start`, `append`, `prompt`, `stop`,
 * `abort`, `fork`, `archive`, `compact`, `delete`) drive the host's Session
 * controller and workspace registry by duck-typed lookup, and are open to agents
 * in the caller's workspace; a cross-workspace action is reserved for the super
 * agent, and `list` and `get` stay available to every agent.
 * @module @deepseek-ai/dsh-workspace-tools/sessions
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentRole } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { defineTool, ToolArgsError } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { Page } from './paging.ts'
import { pageOf } from './paging.ts'
import { WorkspaceRecordError, WorkspaceSessionError } from './errors.ts'
import { resolveWorkspace, workspaceDirectory } from './scope.ts'
import { listArtifacts, listMessages, listTasks } from './store.ts'
import type { SessionRosterEntry, TaskRecord } from './records.ts'
import { actorOf, noteRosterArchive, noteRosterFork, noteRosterStart, reconcileRoster } from './roster.ts'
import { noteDispatch } from './dispatch.ts'
import { oneLine, requireCallerSession } from './tooling.ts'

/** One derived status of a workspace session. */
export type WorkspaceSessionStatus = 'running' | 'idle' | 'blocked' | 'done'

/** Every accepted session status. */
export const WORKSPACE_SESSION_STATUSES: readonly WorkspaceSessionStatus[] = ['running', 'idle', 'blocked', 'done']

/** Actions that only read a workspace. */
export const WORKSPACE_SESSION_READ_ACTIONS = ['list', 'get'] as const

/** Actions that create or change a real Session; a cross-workspace write requires the super agent. */
export const WORKSPACE_SESSION_LIFECYCLE_ACTIONS = [
  'run', 'start', 'append', 'prompt', 'stop', 'abort', 'fork', 'archive', 'compact', 'delete',
] as const

/** Every accepted `workspace_sessions` action. */
export const WORKSPACE_SESSION_ACTIONS = [
  ...WORKSPACE_SESSION_READ_ACTIONS,
  ...WORKSPACE_SESSION_LIFECYCLE_ACTIONS,
] as const

/** One accepted action. */
export type WorkspaceSessionAction = (typeof WORKSPACE_SESSION_ACTIONS)[number]

/** How a caller asked a message to be delivered. */
export type SessionDeliveryMode = 'queue' | 'interrupt'

/** Reason recorded by the latest `turn/end` event. */
type TurnEndReason = Extract<SessionEvent, { type: 'turn/end' }>['data']['reason']

/** One recent progress line. */
export interface ProgressEntry {
  /** ISO-8601 instant of the line's event. */
  readonly at: string
  /** Bounded one-line summary. */
  readonly summary: string
}

/** Current facts about one workspace session. */
export interface SessionFacts {
  /** Effective status. */
  readonly status: WorkspaceSessionStatus
  /** Latest turn number the log recorded; zero when the log has no turn. */
  readonly currentTurn: number
  /** Bounded description of the last observed activity. */
  readonly currentActivity?: string
  /** ISO-8601 instant of the latest progress line. */
  readonly lastProgressAt?: string
  /** Latest assistant progress line. */
  readonly latestProgress?: string
  /** Recent assistant progress lines, oldest first. */
  readonly recentProgress: ProgressEntry[]
  /** ISO-8601 instant of the latest recorded event. */
  readonly updatedAt?: string
  /** Role of the live Agent, when the session is live. */
  readonly role?: AgentRole
}

/** Session summary as the list action returns it. */
export interface SessionSummary {
  /** Session identity. */
  readonly sessionId: string
  /** Workspace that accounts for the session. */
  readonly workspaceId?: string
  /** Title of that workspace. */
  readonly workspaceTitle?: string
  /** Role of the live Agent, or the workspace's durable role when not live. */
  readonly role?: string
  /** Latest log-backed title, when the session has one. */
  readonly title?: string
  /** Effective status. */
  readonly status: WorkspaceSessionStatus
  /** Latest turn number. */
  readonly currentTurn: number
  /** Bounded description of the last observed activity. */
  readonly currentActivity?: string
  /** ISO-8601 instant of the latest progress line. */
  readonly lastProgressAt?: string
  /** Latest assistant progress line. */
  readonly latestProgress?: string
  /** ISO-8601 instant of the latest recorded event. */
  readonly updatedAt?: string
  /** Task the session is executing, when one targets it. */
  readonly taskId?: string
  /** Identity that created the session: `user` or `agent:<sessionId>`. */
  readonly createdBy?: string
  /** ISO-8601 creation instant. */
  readonly createdAt?: string
  /** Session this one was forked from. */
  readonly forkedFrom?: string
  /** Identity that archived the session: `user` or `agent:<sessionId>`. */
  readonly archivedBy?: string
  /** ISO-8601 archive instant. */
  readonly archivedAt?: string
  /** Whether the registry counts the session as archived. */
  readonly archived?: boolean
  /** Context pressure of the live Agent, when the host can measure it. */
  readonly contextUsage?: SessionContextUsage
}

/** One Session created by `start`. */
export interface StartedSession {
  /** New Session identity. */
  readonly sessionId: string
  /** Workspace the Session belongs to. */
  readonly workspace: string
  /** Directory the Session works in. */
  readonly cwd: string
  /** Durable purpose title the caller asked for. */
  readonly title: string
  /** Whether the host recorded the title (a host without a rename API cannot). */
  readonly titleRecorded: boolean
  /** Whether the first task was admitted. */
  readonly admitted: boolean
}

/** One admitted instruction and how the host delivered it. */
export interface SessionDelivery {
  /** Receiving Session. */
  readonly sessionId: string
  /** What the caller asked for. */
  readonly requested: SessionDeliveryMode
  /** What the host actually used (`interrupt` only steers a running turn). */
  readonly used: SessionDeliveryMode
  /** Whether the host admitted the text. */
  readonly accepted: boolean
  /** Whether the Session was running at admission. */
  readonly wasRunning: boolean
  /** True when `interrupt` was requested on an idle Session and queued instead. */
  readonly fallback?: boolean
}

/** Result of `stop`. */
export interface StoppedSession {
  /** Session whose turn was stopped. */
  readonly sessionId: string
  /** Whether a cancel was sent. */
  readonly accepted: boolean
  /** Whether a turn was running at the call. */
  readonly wasRunning: boolean
  /** True when an idle Session was left alone. */
  readonly alreadyIdle?: boolean
  /** Which host channel carried the cancel. */
  readonly cancelledVia?: 'controller'
}

/** Result of `abort`. */
export interface AbortedSession {
  /** Session whose turn was aborted and continued. */
  readonly sessionId: string
  /** Whether the cancel was accepted. */
  readonly accepted: boolean
  /** Whether the follow-up text was admitted. */
  readonly resumed: boolean
}

/** Result of `fork`. */
export interface ForkedSession {
  /** New Session identity. */
  readonly sessionId: string
  /** Source Session. */
  readonly forkedFrom: string
  /** Exact event boundary the branch started from, when one was given. */
  readonly atSeq?: number
}

/** Result of `archive`. */
export interface ArchivedSession {
  /** Session hidden from the workspace groupings. */
  readonly sessionId: string
  /** Always true on success. */
  readonly archived: boolean
}

/** One Session's context pressure as a percentage of its window. */
export interface SessionContextUsage {
  /** Occupancy the next request would carry, in tokens. */
  readonly tokens?: number
  /** Routed context window in tokens. */
  readonly window?: number
  /** Rounded occupancy percentage. */
  readonly percent?: number
}

/** Result of `compact`. */
export interface CompactedSession {
  /** Compressed Session. */
  readonly sessionId: string
  /** Usage before compaction, when the host can measure it. */
  readonly before?: SessionContextUsage
  /** Usage after compaction, when the host can measure it. */
  readonly after?: SessionContextUsage
  /** Whether the engine actually compacted anything. */
  readonly compacted: boolean
  /** Tokens the compaction shadowed. */
  readonly shadowedTokens?: number
}

/** Result of `delete`. */
export interface DeletedSession {
  /** Session whose stored log was deleted. */
  readonly sessionId: string
  /** Always true on success. */
  readonly deleted: boolean
}

/** One `workspace_sessions` result value. */
export interface WorkspaceSessionsValue {
  /** Workspace the result belongs to. */
  readonly workspace: string
  /** Paged session summaries. */
  readonly items?: SessionSummary[]
  /** Detailed view returned by `get`. */
  readonly session?: SessionSummary & {
    readonly recentProgress: ProgressEntry[]
    readonly pendingInbox: number
    readonly artifactCount: number
  }
  /** Cursor of the next page. */
  readonly nextCursor?: string
  /** Session created by `start`. */
  readonly started?: StartedSession
  /** Instruction delivered by `append`, `prompt`, or `abort`. */
  readonly delivery?: SessionDelivery
  /** Result of `stop`. */
  readonly stopped?: StoppedSession
  /** Result of `abort`. */
  readonly aborted?: AbortedSession
  /** Result of `fork`. */
  readonly forked?: ForkedSession
  /** Result of `archive`. */
  readonly archived?: ArchivedSession
  /** Result of `compact`. */
  readonly compacted?: CompactedSession
  /** Result of `delete`. */
  readonly deleted?: DeletedSession
}

/** One Session row as the host Session controller reports it. */
interface SessionSummaryLike {
  readonly sessionId: unknown
  readonly running: boolean
  readonly cwd?: string
  readonly parentSessionId?: unknown
  readonly origin?: string
  readonly blank?: boolean
  /** Last activity in epoch milliseconds; `append` prefers the most recent Session. */
  readonly updatedAt?: number
}

/**
 * The slice of the host Session controller this tool uses.
 *
 * Duck-typed on purpose: a deployment without one still lists and reads
 * Sessions and refuses a lifecycle action with a readable reason. `cancel`,
 * `selectModel`, `rename`, `resolveAgent`, `fork`, and `delete` are optional
 * because the host may not expose every verb.
 */
interface SessionControllerLike {
  /**
   * Create one Session; `workspaceId` is what makes it appear under that
   * workspace.
   * @param request - target workspace and optional preset.
   * @returns the new Session identity.
   */
  create(request: {
    readonly workspaceId?: string
    readonly cwd?: string
    readonly agentPreset?: string
  }): Promise<{ readonly sessionId: unknown }>
  /**
   * Admit one text prompt.
   * @param request - request identity, target Session, delivery mode, and text.
   * @param signal - cancellation for the admission.
   * @returns the host's acknowledgement.
   */
  prompt(request: {
    readonly requestId: string
    readonly sessionId: string
    readonly mode: 'queue' | 'steer'
    readonly content: readonly { readonly type: 'text'; readonly text: string }[]
  }, signal: AbortSignal): Promise<{ readonly accepted: boolean }>
  /**
   * List every visible Session, cold included.
   * @param request - reserved list request.
   * @param signal - cancellation for the read.
   * @returns the Session rows.
   */
  list(
    request?: unknown,
    signal?: AbortSignal,
  ): Promise<{ readonly items: readonly SessionSummaryLike[] }>
  /**
   * Abort one Session's active turn without dropping its pending inbox.
   * @param request - target Session.
   * @returns the host acknowledgement.
   */
  cancel?(request: { readonly sessionId: string }): { readonly accepted: boolean } | Promise<{ readonly accepted: boolean }>
  /**
   * Record a model selection for the Session's next turn.
   * @param request - target Session and requested route.
   * @returns the route the host installed.
   */
  selectModel?(request: {
    readonly sessionId: string
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string
  }): Promise<{ readonly selected: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string } }>
  /**
   * Record the Session's durable display title.
   * @param request - target Session and title.
   * @returns the accepted title.
   */
  rename?(request: { readonly sessionId: string; readonly title: string }): Promise<{ readonly title: string }>
  /**
   * Resolve (resuming when cold) the Agent behind one Session.
   * @param sessionId - target Session.
   * @returns the live Agent, or the host's failure.
   */
  resolveAgent?(sessionId: string): Promise<{ readonly agent?: unknown; readonly error?: unknown }>
  /**
   * Branch one Session from a completed-turn prefix.
   * @param request - source Session and optional exact inclusive boundary.
   * @returns the new Session identity.
   */
  fork?(request: { readonly sessionId: string; readonly atSeq?: number }): Promise<{ readonly sessionId: unknown }>
  /**
   * Permanently delete one stored Session. Optional: a host that exposes only
   * archive refuses `delete` rather than pretending.
   * @param sessionId - target Session.
   */
  delete?(sessionId: string): Promise<void>
}

/** The optional model route one lifecycle action requested. */
interface SessionModelChoice {
  /** LLM provider id. */
  readonly provider: string
  /** Model id. */
  readonly model: string
  /** Adapter-owned reasoning effort, when requested. */
  readonly reasoningEffort?: string
}

/** The lifecycle arguments after the tool schema validated their shape. */
interface LifecycleArguments {
  /** Startup task for `start`. */
  readonly task?: string
  /** Durable purpose title for `start`. */
  readonly title?: string
  /** Follow-up text for `append`, `prompt`, or `abort`. */
  readonly text?: string
  /** Target Session for `run`, `append`, `get`, `prompt`, and the rest; `run`/`append` use the latest when omitted. */
  readonly sessionId?: string
  /** Exact Session id the caller repeated for `delete`. */
  readonly confirm?: string
  /** Requested delivery mode for `append` and `prompt`. */
  readonly delivery?: SessionDeliveryMode
  /** Exact fork boundary for `fork`. */
  readonly atSeq?: number
  /** Force `run` to start a new Session instead of reusing one. */
  readonly new_session?: boolean
  /** Optional LLM provider id. */
  readonly provider?: string
  /** Optional model id. */
  readonly model?: string
  /** Optional reasoning effort. */
  readonly reasoning_effort?: string
}

/** The slice of the host token meter lifecycle results read. */
interface TokenMeterLike {
  /**
   * Measure one Session's context pressure.
   * @param session - live Session.
   * @returns the newest provider sample, the projected next-request occupancy, and the routed window.
   */
  contextPressure(session: unknown): {
    readonly pressureTokens?: number
    readonly projectedTokens?: number
    readonly contextWindow?: number
  }
}

/** The permission-preset registry seam a dispatched Session inherits its preset from. */
interface PermissionPresetsLike {
  /**
   * Read the preset the Session currently runs under.
   * @param session - Session whose preset is read.
   * @returns the preset name.
   */
  current(session: Session): string
}

/** The sandbox-policy seam that resolves the dispatcher's effective sandbox mode. */
interface SandboxPolicyLike {
  /**
   * Resolve the policy one call runs under.
   * @param request - Session whose effective policy is resolved.
   * @returns the effective policy, including its mode.
   */
  resolve(request: { readonly session: Session }): { readonly mode?: string } | undefined
}

/** The Session-store append seam delegation events are written through. */
interface DelegationSessionLike {
  /**
   * Append one Session event.
   * @param type - event type.
   * @param data - event payload.
   */
  append(type: string, data: Readonly<Record<string, unknown>>): unknown
}

/** The Session-store lookup a delegation seed resolves its new Session through. */
interface SessionStoreLike {
  /**
   * Resolve one live Session.
   * @param id - Session identity.
   * @returns the Session, when the store holds it.
   */
  get(id: SessionId): DelegationSessionLike | undefined
}

/** A sandbox mode a dispatched Session may inherit. */
type DelegatedSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** The dispatcher permission state seeded onto a dispatched Session's log. */
interface DelegatedPermissionPolicy {
  /** Dispatcher preset, when it runs in Auto or Full access. */
  readonly preset: 'auto' | 'danger-full-access' | undefined
  /** Dispatcher's effective sandbox mode. */
  readonly mode: DelegatedSandboxMode | undefined
  /** `'never'` whenever the approval capability is composed. */
  readonly approval: 'never' | undefined
}

/** The slice of the host manual-compaction seam this tool drives. */
interface CompactionLike {
  /**
   * Compact one Agent's Session history.
   * @param agent - live Agent to compact.
   * @param signal - cancellation for the compaction.
   * @returns what the compaction shadowed, or null when there was nothing to do.
   */
  compactNow(agent: unknown, signal: AbortSignal): Promise<{ readonly shadowedTokenCount?: number } | null>
}

/** The preset registry's bridge into one Agent's isolated preset services. */
interface AgentPresetsLike {
  /**
   * Read one service from an Agent's own preset isolate.
   * @param agent - the Agent whose preset owns the service.
   * @param name - service name inside the preset.
   * @returns the service, when the preset mounts it.
   */
  serviceFor?(agent: { readonly ctx: unknown }, name: 'compaction'): unknown
}

/** The outcome of one manual compaction attempt. */
interface CompactionOutcome {
  /** Usage before compaction, when measurable. */
  readonly before?: SessionContextUsage
  /** Usage after compaction, when measurable. */
  readonly after?: SessionContextUsage
  /** Whether the engine compacted anything. */
  readonly compacted: boolean
  /** Tokens the compaction shadowed. */
  readonly shadowedTokens?: number
}

/** Output schema shared by the `list` rows and the `get` session view. */
const sessionSummarySchema = {
  sessionId: { type: 'string', required: true },
  workspaceId: { type: 'string' },
  workspaceTitle: { type: 'string' },
  role: { type: 'string' },
  title: { type: 'string' },
  status: { type: 'string', required: true, enum: [...WORKSPACE_SESSION_STATUSES] },
  currentTurn: { type: 'integer', required: true },
  currentActivity: { type: 'string' },
  lastProgressAt: { type: 'string' },
  latestProgress: { type: 'string' },
  updatedAt: { type: 'string' },
  taskId: { type: 'string' },
  createdBy: { type: 'string' },
  createdAt: { type: 'string' },
  forkedFrom: { type: 'string' },
  archivedBy: { type: 'string' },
  archivedAt: { type: 'string' },
  archived: { type: 'boolean' },
  contextUsage: {
    type: 'object',
    additionalProperties: false,
    properties: {
      tokens: { type: 'integer' },
      window: { type: 'integer' },
      percent: { type: 'integer' },
    },
  },
} as const

/**
 * Build `workspace_sessions`.
 * @param ctx - context carrying session-query, the store, and the registries.
 * @returns the tool definition.
 */
export function workspaceSessionsTool(ctx: Context): ToolDefinition {
  return defineTool({
    name: 'workspace_sessions',
    description:
      'List the sessions of a workspace and report what each is doing, read one session, or manage the '
      + 'lifecycle of a real Session in a registered workspace. `list` and `get` are open to every agent and '
      + 'return the caller\'s workspace by default; a cross-workspace read needs the registered workspace id. '
      + 'The lifecycle actions are open to an agent in the Session\'s workspace, and a cross-workspace action '
      + 'requires the super agent. `run` is the one-call dispatch: it delivers `text` to the target Session '
      + '(`sessionId` for an explicit one, otherwise the most recently updated Session) '
      + 'and starts a new Session only when the workspace has none; pass `new_session: true` to force a fresh '
      + 'Session even when one exists, when the person asked for a new or isolated conversation. `task` and `title` '
      + 'are optional for that new Session, and the title is derived from the task when omitted. A Session started '
      + 'here inherits the dispatcher\'s permission policy as delegation events on its own log: the Auto or Full-access '
      + 'preset, the effective sandbox mode, and the `never` approval policy (a dispatched Session asks the person '
      + 'nothing directly; the dispatcher relays questions). `start` forces a new Session with a first '
      + '`task` and an optional `title` (no intent card is involved); `append` continues `sessionId`, or the latest '
      + 'Session when omitted; `prompt` sends text to an explicit sessionId; `stop` '
      + 'cuts off the running turn and admits nothing; `abort` cuts it off and then sends `text`; `fork` branches '
      + 'a Session at an optional `atSeq`; `archive` hides it; `compact` compresses its history; `delete` erases '
      + 'a stored Session only when the host exposes a real delete API — otherwise it refuses, because an archive '
      + 'is not a deletion. `delivery` is queue (default) or interrupt for `run`, `append`, and `prompt`; trust '
      + '`get` before addressing a Session. A normal delivery is admitted at the target\'s next turn boundary, '
      + 'and `get` reports a snapshot rather than waiting. After dispatching, end your turn: a reply is queued for '
      + 'your next turn and opens it; do not sleep or poll for it.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: [...WORKSPACE_SESSION_ACTIONS],
        description: '`list`/`get` read a workspace. `run`, `start`, `append`, `prompt`, `stop`, `abort`, `fork`, '
          + '`archive`, `compact`, and `delete` change a real Session; a cross-workspace action requires the '
          + 'super agent.',
      },
      workspace: {
        type: 'string',
        description: 'Registered workspace id to read or change; defaults to the caller\'s workspace. A '
          + 'lifecycle target Session must belong to this workspace, and a cross-workspace call must name it.',
      },
      sessionId: {
        type: 'string',
        description: 'Target Session for `run`, `append`, `get`, `prompt`, `stop`, `abort`, `fork`, `archive`, '
          + '`compact`, and `delete`. `run` and `append` continue this Session, or the most recently updated one '
          + 'when it is omitted; `prompt` and the rest require it.',
      },
      task: {
        type: 'string',
        description: '`start`/`run`: the self-contained first task for a new Session; `run` uses `text` when omitted.',
      },
      title: {
        type: 'string',
        description: '`start`/`run`: the new Session\'s durable purpose title; optional, derived from the task when omitted.',
      },
      text: {
        type: 'string',
        description: '`run`/`append`/`prompt`: the instruction to deliver. `abort`: the instruction to run after '
          + 'the running turn is cancelled.',
      },
      delivery: {
        type: 'string',
        enum: ['queue', 'interrupt'],
        description: '`run`/`append`/`prompt`: queue (default) admits at the target\'s next turn boundary; '
          + 'interrupt steers the target\'s running step and queues instead when the Session is idle.',
      },
      atSeq: {
        type: 'integer',
        description: '`fork`: branch from this exact event seq; defaults to the latest completed turn.',
      },
      confirm: {
        type: 'string',
        description: '`delete`: required; repeat the target Session id exactly. Deletion is irreversible.',
      },
      new_session: {
        type: 'boolean',
        description: '`run`: true starts a new Session even when the workspace already has one. Use it when the '
          + 'person explicitly asks for a new or isolated conversation; omit sessionId and session with it.',
      },
      provider: {
        type: 'string',
        description: '`start`/`append`/`prompt`: optional LLM provider id; requires `model`.',
      },
      model: {
        type: 'string',
        description: '`start`/`append`/`prompt`: optional model id; requires `provider`.',
      },
      reasoning_effort: {
        type: 'string',
        description: '`start`/`append`/`prompt`: optional adapter-owned reasoning effort; requires '
          + '`provider` and `model`.',
      },
      status: {
        type: 'string',
        enum: [...WORKSPACE_SESSION_STATUSES],
        description: 'Only list sessions in this status.',
      },
      cursor: {
        type: 'string',
        description: 'Cursor a previous page returned; omit for the first page.',
      },
      limit: {
        type: 'integer',
        description: 'Page size, 1 to 100; defaults to 20.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          workspace: { type: 'string', required: true },
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: sessionSummarySchema,
            },
          },
          session: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ...sessionSummarySchema,
              recentProgress: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    at: { type: 'string', required: true },
                    summary: { type: 'string', required: true },
                  },
                },
              },
              pendingInbox: { type: 'integer', required: true },
              artifactCount: { type: 'integer', required: true },
            },
          },
          nextCursor: { type: 'string' },
          started: {
            type: 'object',
            additionalProperties: false,
            properties: {
              sessionId: { type: 'string', required: true },
              workspace: { type: 'string', required: true },
              cwd: { type: 'string', required: true },
              title: { type: 'string', required: true },
              titleRecorded: { type: 'boolean', required: true },
              admitted: { type: 'boolean', required: true },
            },
          },
          delivery: {
            type: 'object',
            additionalProperties: false,
            properties: {
              sessionId: { type: 'string', required: true },
              requested: { type: 'string', required: true, enum: ['queue', 'interrupt'] },
              used: { type: 'string', required: true, enum: ['queue', 'interrupt'] },
              accepted: { type: 'boolean', required: true },
              wasRunning: { type: 'boolean', required: true },
              fallback: { type: 'boolean' },
            },
          },
          stopped: {
            type: 'object',
            additionalProperties: false,
            properties: {
              sessionId: { type: 'string', required: true },
              accepted: { type: 'boolean', required: true },
              wasRunning: { type: 'boolean', required: true },
              alreadyIdle: { type: 'boolean' },
              cancelledVia: { type: 'string', enum: ['controller'] },
            },
          },
          aborted: {
            type: 'object',
            additionalProperties: false,
            properties: {
              sessionId: { type: 'string', required: true },
              accepted: { type: 'boolean', required: true },
              resumed: { type: 'boolean', required: true },
            },
          },
          forked: {
            type: 'object',
            additionalProperties: false,
            properties: {
              sessionId: { type: 'string', required: true },
              forkedFrom: { type: 'string', required: true },
              atSeq: { type: 'integer' },
            },
          },
          archived: {
            type: 'object',
            additionalProperties: false,
            properties: {
              sessionId: { type: 'string', required: true },
              archived: { type: 'boolean', required: true },
            },
          },
          compacted: {
            type: 'object',
            additionalProperties: false,
            properties: {
              sessionId: { type: 'string', required: true },
              compacted: { type: 'boolean', required: true },
              shadowedTokens: { type: 'integer' },
              before: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  tokens: { type: 'integer' },
                  window: { type: 'integer' },
                  percent: { type: 'integer' },
                },
              },
              after: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  tokens: { type: 'integer' },
                  window: { type: 'integer' },
                  percent: { type: 'integer' },
                },
              },
            },
          },
          deleted: {
            type: 'object',
            additionalProperties: false,
            properties: {
              sessionId: { type: 'string', required: true },
              deleted: { type: 'boolean', required: true },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderSessions(value) }],
    },
    async execute(args, exec) {
      const session = requireCallerSession(exec.agent?.session, 'workspace_sessions')
      const action = args.action as WorkspaceSessionAction
      if (action === 'get') {
        if (args.sessionId === undefined || args.sessionId.trim() === '') {
          throw new ToolArgsError(['workspace_sessions with action "get" requires sessionId'])
        }
        const scope = await resolveWorkspace(ctx, session, 'sessions.get', args.workspace)
        return {
          workspace: String(scope.workspace.id),
          session: await describeSession(ctx, scope.workspace, args.sessionId, exec.signal),
        }
      }
      if (action === 'list') {
        const scope = await resolveWorkspace(ctx, session, 'sessions.list', args.workspace)
        const page = await listWorkspaceSessions(ctx, scope.workspace, args, exec.signal)
        return {
          workspace: String(scope.workspace.id),
          items: page.items,
          ...page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor },
        }
      }

      validateLifecycleArguments(action, args)
      const scope = await resolveWorkspace(ctx, session, `sessions.${action}`, args.workspace)
      requireLifecycleRole(exec.agent, action, scope.crossWorkspace)
      const workspace = scope.workspace
      const controller = requireSessionController(ctx)
      const signal = exec.signal ?? new AbortController().signal
      const requestedDelivery: SessionDeliveryMode = args.delivery === 'interrupt' ? 'interrupt' : 'queue'

      if (action === 'start') {
        const model = modelChoiceOf(args)
        const started = await startWorkspaceSession(ctx, controller, workspace, session, {
          task: requiredText(args.task, 'task', action),
          ...args.title === undefined ? {} : { title: args.title },
          role: exec.agent?.role ?? 'agent',
          ...model === undefined ? {} : { model },
          signal,
        })
        if (started.admitted) await noteSessionDispatch(ctx, workspace, session, started.sessionId, exec.agent?.role, action)
        return { workspace: String(workspace.id), started }
      }

      if (action === 'run') {
        const text = (args.text?.trim() ?? '') || (args.task?.trim() ?? '')
        const model = modelChoiceOf(args)
        const forceNew = args.new_session === true
        let target: SessionSummaryLike | undefined
        if (forceNew) {
          target = undefined
        } else {
          try {
            target = await appendTargetOf(controller, workspace, args.sessionId, signal)
          } catch (error: unknown) {
            if (!(error instanceof WorkspaceRecordError) || error.code !== 'WORKSPACE_RECORD_NOT_FOUND') throw error
          }
        }
        if (target === undefined) {
          const started = await startWorkspaceSession(ctx, controller, workspace, session, {
            task: text,
            ...args.title === undefined ? {} : { title: args.title },
            role: exec.agent?.role ?? 'agent',
            ...model === undefined ? {} : { model },
            signal,
          })
          if (started.admitted) await noteSessionDispatch(ctx, workspace, session, started.sessionId, exec.agent?.role, action)
          return { workspace: String(workspace.id), started }
        }
        const sessionId = String(target.sessionId)
        await applySessionModel(controller, sessionId, model)
        const delivery = decideDelivery(requestedDelivery, target.running)
        const admitted = await admit(controller, sessionId, delivery.used, text, action, deliveryHeader(workspace, exec.agent?.role ?? 'agent', String(session.id)), signal)
        if (admitted) await noteSessionDispatch(ctx, workspace, session, sessionId, exec.agent?.role, action)
        return {
          workspace: String(workspace.id),
          delivery: deliveryOf(sessionId, requestedDelivery, delivery, target.running, admitted),
        }
      }

      if (action === 'append') {
        const text = requiredText(args.text, 'text', action)
        const target = await appendTargetOf(controller, workspace, args.sessionId, signal)
        const sessionId = String(target.sessionId)
        const model = modelChoiceOf(args)
        await applySessionModel(controller, sessionId, model)
        const delivery = decideDelivery(requestedDelivery, target.running)
        const admitted = await admit(controller, sessionId, delivery.used, text, action, deliveryHeader(workspace, exec.agent?.role ?? 'agent', String(session.id)), signal)
        if (admitted) await noteSessionDispatch(ctx, workspace, session, sessionId, exec.agent?.role, action)
        return {
          workspace: String(workspace.id),
          delivery: deliveryOf(sessionId, requestedDelivery, delivery, target.running, admitted),
        }
      }

      if (action === 'prompt') {
        const text = requiredText(args.text, 'text', action)
        const sessionId = requiredText(args.sessionId, 'sessionId', action).trim()
        const target = await listedSessionOf(controller, workspace, sessionId, signal)
        const model = modelChoiceOf(args)
        await applySessionModel(controller, sessionId, model)
        const delivery = decideDelivery(requestedDelivery, target.running)
        const admitted = await admit(controller, sessionId, delivery.used, text, action, deliveryHeader(workspace, exec.agent?.role ?? 'agent', String(session.id)), signal)
        if (admitted) await noteSessionDispatch(ctx, workspace, session, sessionId, exec.agent?.role, action)
        return {
          workspace: String(workspace.id),
          delivery: deliveryOf(sessionId, requestedDelivery, delivery, target.running, admitted),
        }
      }

      if (action === 'stop') {
        const sessionId = requiredText(args.sessionId, 'sessionId', action).trim()
        const target = await listedSessionOf(controller, workspace, sessionId, signal)
        if (target.running !== true) {
          return {
            workspace: String(workspace.id),
            stopped: { sessionId, accepted: false, wasRunning: false, alreadyIdle: true },
          }
        }
        await cancelSession(controller, sessionId, 'stop')
        return {
          workspace: String(workspace.id),
          stopped: { sessionId, accepted: true, wasRunning: true, cancelledVia: 'controller' as const },
        }
      }

      if (action === 'abort') {
        const text = requiredText(args.text, 'text', action)
        const sessionId = requiredText(args.sessionId, 'sessionId', action).trim()
        const target = await listedSessionOf(controller, workspace, sessionId, signal)
        if (target.running !== true) {
          throw new WorkspaceSessionError(
            `Session ${sessionId} is idle, so there is nothing to abort; use append or prompt to continue it`,
            'WORKSPACE_SESSION_INVALID',
          )
        }
        await cancelSession(controller, sessionId, 'abort')
        const delivery = decideDelivery('queue', false)
        const admitted = await admit(controller, sessionId, delivery.used, text, action, deliveryHeader(workspace, exec.agent?.role ?? 'agent', String(session.id)), signal)
        if (admitted) await noteSessionDispatch(ctx, workspace, session, sessionId, exec.agent?.role, action)
        return {
          workspace: String(workspace.id),
          aborted: { sessionId, accepted: true, resumed: admitted },
          delivery: deliveryOf(sessionId, 'queue', delivery, false, admitted),
        }
      }

      if (action === 'fork') {
        const sessionId = requiredText(args.sessionId, 'sessionId', action).trim()
        requireWorkspaceMember(workspace, sessionId)
        if (typeof controller.fork !== 'function') {
          throw new WorkspaceSessionError('this deployment cannot branch a Session', 'WORKSPACE_SESSION_UNAVAILABLE')
        }
        let forked: { readonly sessionId: unknown }
        try {
          forked = await controller.fork({
            sessionId,
            ...(args.atSeq === undefined ? {} : { atSeq: args.atSeq }),
          })
        } catch (error: unknown) {
          throw new WorkspaceSessionError(`Session ${sessionId} could not be branched: ${messageOf(error)}`, 'WORKSPACE_SESSION_INVALID')
        }
        const forkedId = String(forked.sessionId)
        await noteRosterFork(ctx, workspace, forkedId, sessionId, actorOf(String(session.id)), new Date().toISOString())
        return {
          workspace: String(workspace.id),
          forked: {
            sessionId: forkedId,
            forkedFrom: sessionId,
            ...(args.atSeq === undefined ? {} : { atSeq: args.atSeq }),
          },
        }
      }

      if (action === 'archive') {
        const sessionId = requiredText(args.sessionId, 'sessionId', action).trim()
        requireWorkspaceMember(workspace, sessionId)
        const directory = workspaceDirectory(ctx)
        if (typeof directory.archiveSession !== 'function') {
          throw new WorkspaceSessionError('this deployment has no Session archive API', 'WORKSPACE_SESSION_UNAVAILABLE')
        }
        try {
          await directory.archiveSession(SessionId(sessionId), { stopActivity: true })
        } catch (error: unknown) {
          throw new WorkspaceSessionError(`Session ${sessionId} could not be archived: ${messageOf(error)}`, 'WORKSPACE_SESSION_INVALID')
        }
        await noteRosterArchive(ctx, workspace, sessionId, actorOf(String(session.id)))
        return { workspace: String(workspace.id), archived: { sessionId, archived: true } }
      }

      if (action === 'compact') {
        const sessionId = requiredText(args.sessionId, 'sessionId', action).trim()
        requireWorkspaceMember(workspace, sessionId)
        const outcome = await compactWorkspaceSession(ctx, controller, sessionId, signal)
        return {
          workspace: String(workspace.id),
          compacted: { sessionId, ...outcome },
        }
      }

      const sessionId = requiredText(args.sessionId, 'sessionId', action).trim()
      const confirm = requiredText(args.confirm, 'confirm', action).trim()
      if (confirm !== sessionId) {
        throw new ToolArgsError([
          `workspace_sessions with action "delete" requires confirm to repeat the Session id exactly; got ${confirm}`,
        ])
      }
      if (String(session.id) === sessionId) {
        throw new WorkspaceSessionError('cannot delete the Session that is calling this tool', 'WORKSPACE_SESSION_INVALID')
      }
      requireWorkspaceMember(workspace, sessionId)
      if (typeof controller.delete !== 'function') {
        throw new WorkspaceSessionError(
          'this host exposes no Session delete API: a Session log can be hidden with archive, but the durable '
          + 'log survives and this tool will not fake a deletion',
          'WORKSPACE_SESSION_UNAVAILABLE',
        )
      }
      try {
        await controller.delete(sessionId)
      } catch (error: unknown) {
        throw new WorkspaceSessionError(`Session ${sessionId} could not be deleted: ${messageOf(error)}`, 'WORKSPACE_SESSION_INVALID')
      }
      return { workspace: String(workspace.id), deleted: { sessionId, deleted: true } }
    },
  })
}

/**
 * Refuse a lifecycle write only when it crosses workspaces without the super agent.
 * A caller in the Session's workspace may write it; a cross-workspace write still
 * requires the super agent.
 * @param agent - the calling agent, when one is attached.
 * @param action - lifecycle action being attempted.
 * @param crossWorkspace - whether the call named another workspace.
 * @throws WorkspaceSessionError `WORKSPACE_SESSION_FORBIDDEN` for a cross-workspace caller that is not the super agent.
 */
function requireLifecycleRole(agent: Agent | undefined, action: WorkspaceSessionAction, crossWorkspace: boolean): void {
  if (!crossWorkspace) return
  if (agent?.role === 'super') return
  throw new WorkspaceSessionError(
    `workspace_sessions.${action} from another workspace requires the super agent; an agent may list, read, `
    + 'and write Sessions in its own workspace',
    'WORKSPACE_SESSION_FORBIDDEN',
  )
}

/**
 * Read the host Session controller when the deployment mounts one.
 * @param ctx - context that may carry `sessionController`.
 * @returns the controller when its create, prompt, and list verbs are present.
 */
function sessionControllerOf(ctx: Context): SessionControllerLike | undefined {
  const service = ctx.get('sessionController') as Partial<SessionControllerLike> | undefined
  if (service === undefined
    || typeof service.create !== 'function'
    || typeof service.prompt !== 'function'
    || typeof service.list !== 'function') {
    return undefined
  }
  return service as SessionControllerLike
}

/**
 * Require the host Session controller for a lifecycle action.
 * @param ctx - context that may carry `sessionController`.
 * @returns the controller.
 * @throws WorkspaceSessionError `WORKSPACE_SESSION_UNAVAILABLE` when no controller is mounted.
 */
function requireSessionController(ctx: Context): SessionControllerLike {
  const controller = sessionControllerOf(ctx)
  if (controller === undefined) {
    throw new WorkspaceSessionError(
      'this deployment has no Session controller, so a workspace Session cannot be changed',
      'WORKSPACE_SESSION_UNAVAILABLE',
    )
  }
  return controller
}

/**
 * Validate the action-specific and cross-field argument rules before any write.
 * @param action - lifecycle action being attempted.
 * @param args - the validated tool arguments.
 * @throws ToolArgsError naming every violation at once.
 */
function validateLifecycleArguments(action: WorkspaceSessionAction, args: LifecycleArguments): void {
  const violations: string[] = []
  const require = (field: string, value: string | undefined): void => {
    if (value === undefined || value.trim() === '') {
      violations.push(`workspace_sessions with action "${action}" requires ${field}`)
    }
  }
  switch (action) {
    case 'start':
      require('task', args.task)
      break
    case 'run':
      // `run` starts when the workspace has no Session, so either `text` or `task` can carry the instruction.
      if ((args.text === undefined || args.text.trim() === '')
        && (args.task === undefined || args.task.trim() === '')) {
        violations.push('workspace_sessions with action "run" requires text (or task for a new Session)')
      }
      break
    case 'append':
      // The selector is checked after the candidate list is read, so the refusal can name
      // every Session instead of only repeating that the field is missing.
      require('text', args.text)
      break
    case 'prompt':
    case 'abort':
      require('sessionId', args.sessionId)
      require('text', args.text)
      break
    case 'stop':
    case 'fork':
    case 'archive':
    case 'compact':
      require('sessionId', args.sessionId)
      break
    case 'delete':
      require('sessionId', args.sessionId)
      require('confirm', args.confirm)
      break
    default:
      break
  }
  if (args.delivery !== undefined && action !== 'append' && action !== 'prompt' && action !== 'run') {
    violations.push('delivery is accepted only by append, prompt, and run')
  }
  if (args.atSeq !== undefined && action !== 'fork') {
    violations.push('atSeq is accepted only by fork')
  }
  if (args.new_session !== undefined && action !== 'run') {
    violations.push('new_session is accepted only by run')
  }
  if (action === 'run' && args.new_session === true && (args.sessionId?.trim() ?? '') !== '') {
    violations.push('run with new_session: true starts a fresh Session; omit sessionId')
  }
  if (args.provider !== undefined || args.model !== undefined || args.reasoning_effort !== undefined) {
    if (action !== 'start' && action !== 'append' && action !== 'prompt' && action !== 'run') {
      violations.push('provider, model, and reasoning_effort are accepted only by run, start, append, and prompt')
    }
  }
  if (violations.length > 0) throw new ToolArgsError(violations)
}

/**
 * Read one required non-blank argument.
 * @param value - the model-supplied value, when present.
 * @param field - argument name used in the refusal.
 * @param action - action being validated.
 * @returns the original text.
 * @throws ToolArgsError when the value is missing or blank.
 */
function requiredText(value: string | undefined, field: string, action: string): string {
  if (value === undefined || value.trim() === '') {
    throw new ToolArgsError([`workspace_sessions with action "${action}" requires ${field}`])
  }
  return value
}

/**
 * Parse the optional model route.
 * @param args - the validated tool arguments.
 * @returns the route, or undefined when the caller named none.
 * @throws ToolArgsError when the three fields do not form one route.
 */
function modelChoiceOf(args: LifecycleArguments): SessionModelChoice | undefined {
  const provider = args.provider?.trim()
  const model = args.model?.trim()
  const reasoningEffort = args.reasoning_effort?.trim()
  if (provider === undefined && model === undefined && reasoningEffort === undefined) return undefined
  const violations: string[] = []
  if (provider === undefined || provider === '') violations.push('provider is required when model or reasoning_effort is supplied')
  if (model === undefined || model === '') violations.push('model is required when provider or reasoning_effort is supplied')
  if (reasoningEffort !== undefined && reasoningEffort === '') violations.push('reasoning_effort must be non-empty when supplied')
  if (reasoningEffort !== undefined && (provider === undefined || model === undefined)) {
    violations.push('reasoning_effort requires provider and model')
  }
  if (violations.length > 0) throw new ToolArgsError([...new Set(violations)])
  return {
    provider: provider as string,
    model: model as string,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  }
}

/**
 * Apply a requested model route to a Session before its next turn.
 * @param controller - host Session controller.
 * @param sessionId - Session whose next turn is addressed.
 * @param choice - route the caller requested, when one was given.
 * @throws WorkspaceSessionError when the host has no selection API or rejects the route.
 */
async function applySessionModel(
  controller: SessionControllerLike,
  sessionId: string,
  choice: SessionModelChoice | undefined,
): Promise<void> {
  if (choice === undefined) return
  if (typeof controller.selectModel !== 'function') {
    throw new WorkspaceSessionError(
      `this host exposes no Session model-selection API, so the requested route for ${sessionId} cannot be applied`,
      'WORKSPACE_SESSION_UNAVAILABLE',
    )
  }
  try {
    await controller.selectModel({
      sessionId,
      provider: choice.provider,
      model: choice.model,
      ...(choice.reasoningEffort === undefined ? {} : { reasoningEffort: choice.reasoningEffort }),
    })
  } catch (error: unknown) {
    throw new WorkspaceSessionError(
      `the host rejected the model selection ${choice.provider}/${choice.model} for ${sessionId}: ${messageOf(error)}`,
      'WORKSPACE_SESSION_INVALID',
    )
  }
}

/**
 * Choose the delivery the host can actually honor. Only a running turn can be
 * steered, so an interrupt requested on an idle Session queues instead.
 * @param requested - what the caller asked for.
 * @param wasRunning - whether the Session was running at admission.
 * @returns the mode to use and whether it fell back.
 */
function decideDelivery(
  requested: SessionDeliveryMode,
  wasRunning: boolean,
): Readonly<{ used: SessionDeliveryMode; fallback: boolean }> {
  return {
    used: requested === 'interrupt' && wasRunning ? 'interrupt' : 'queue',
    fallback: requested === 'interrupt' && !wasRunning,
  }
}

/**
 * Project one admission fact into the result.
 * @param sessionId - receiving Session.
 * @param requested - what the caller asked for.
 * @param decision - the mode the host used and its fallback flag.
 * @param wasRunning - whether the Session was running at admission.
 * @param accepted - whether the host admitted the text.
 * @returns the delivery record.
 */
function deliveryOf(
  sessionId: string,
  requested: SessionDeliveryMode,
  decision: Readonly<{ used: SessionDeliveryMode; fallback: boolean }>,
  wasRunning: boolean,
  accepted: boolean,
): SessionDelivery {
  return {
    sessionId,
    requested,
    used: decision.used,
    accepted,
    wasRunning,
    ...(decision.fallback ? { fallback: true } : {}),
  }
}

/**
 * Admit one text instruction through the host controller.
 * @param controller - host Session controller.
 * @param sessionId - receiving Session.
 * @param used - delivery mode to use.
 * @param text - instruction text.
 * @param action - lifecycle action, for the refusal message.
 * @param signal - cancellation for the admission.
 * @returns whether the host accepted the text.
 * @throws WorkspaceSessionError when the host refuses the admission.
 */
async function admit(
  controller: SessionControllerLike,
  sessionId: string,
  used: SessionDeliveryMode,
  text: string,
  action: WorkspaceSessionAction,
  header: string,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const admitted = await controller.prompt({
      requestId: `workspace-session-${action}-${randomUUID()}`,
      sessionId,
      mode: used === 'interrupt' ? 'steer' : 'queue',
      content: [{ type: 'text', text: header }, { type: 'text', text }],
    }, signal)
    return admitted.accepted
  } catch (error: unknown) {
    throw new WorkspaceSessionError(`the instruction could not be admitted to Session ${sessionId}: ${messageOf(error)}`, 'WORKSPACE_SESSION_INVALID')
  }
}

/**
 * Render the sender header a `workspace_sessions` delivery starts with.
 * @param workspace - workspace the delivery was made from.
 * @param role - sender's role.
 * @param sourceSessionId - dispatcher Session.
 * @returns the header line.
 */
function deliveryHeader(workspace: Workspace, role: AgentRole, sourceSessionId: string): string {
  return `[workspace_session] from ${role} ${sourceSessionId} in ${workspace.title} (${String(workspace.id)})\n`
    + `reply to ${sourceSessionId} with workspace_message.send`
}

/**
 * Record one admitted delivery's cross-workspace relation, so the receiving
 * Session can reply through the header without a pre-created task. A
 * same-workspace delivery records nothing because it is always replyable.
 * @param ctx - context carrying the store and registry.
 * @param targetWorkspace - workspace that received the delivery.
 * @param caller - Session that dispatched.
 * @param targetSessionId - Session the delivery reached.
 * @param role - sender's role, when known.
 * @param action - lifecycle action that delivered.
 */
async function noteSessionDispatch(
  ctx: Context,
  targetWorkspace: Workspace,
  caller: Session,
  targetSessionId: string,
  role: AgentRole | undefined,
  action: WorkspaceSessionAction,
): Promise<void> {
  await noteDispatch(ctx, targetWorkspace, {
    sourceSessionId: String(caller.id),
    targetSessionId,
    action,
    ...role === undefined ? {} : { sourceRole: role },
  })
}

/**
 * Cancel one Session's running turn through the host controller.
 * @param controller - host Session controller.
 * @param sessionId - Session whose turn is cancelled.
 * @param action - lifecycle action, for the refusal message.
 * @throws WorkspaceSessionError when the host exposes no cancel or refuses it.
 */
async function cancelSession(
  controller: SessionControllerLike,
  sessionId: string,
  action: 'stop' | 'abort',
): Promise<void> {
  if (typeof controller.cancel !== 'function') {
    throw new WorkspaceSessionError(
      `this host exposes no Session cancel, so ${action} cannot cut off the running turn`,
      'WORKSPACE_SESSION_UNAVAILABLE',
    )
  }
  try {
    await controller.cancel({ sessionId })
  } catch (error: unknown) {
    throw new WorkspaceSessionError(`the ${action} of Session ${sessionId} was refused: ${messageOf(error)}`, 'WORKSPACE_SESSION_INVALID')
  }
}

/**
 * List the host's visible Sessions with a readable failure.
 * @param controller - host Session controller.
 * @param signal - cancellation for the read.
 * @returns the Session rows.
 * @throws WorkspaceSessionError when the host cannot list Sessions.
 */
async function listControllerSessions(
  controller: SessionControllerLike,
  signal: AbortSignal | undefined,
): Promise<{ readonly items: readonly SessionSummaryLike[] }> {
  try {
    return await controller.list({}, signal)
  } catch (error: unknown) {
    throw new WorkspaceSessionError(`the Session list could not be read: ${messageOf(error)}`, 'WORKSPACE_SESSION_UNAVAILABLE')
  }
}

/**
 * Require one Session id to belong to the resolved workspace.
 * @param workspace - resolved workspace.
 * @param sessionId - target Session.
 * @throws WorkspaceRecordError `WORKSPACE_RECORD_NOT_FOUND` when the workspace does not account for it.
 */
function requireWorkspaceMember(workspace: Workspace, sessionId: string): void {
  if (workspace.sessionIds.some(id => String(id) === sessionId)) return
  throw new WorkspaceRecordError(
    `session ${sessionId} is not a session of workspace ${String(workspace.id)}`,
    'WORKSPACE_RECORD_NOT_FOUND',
  )
}

/**
 * Find one workspace member in the host's visible Session list.
 * @param controller - host Session controller.
 * @param workspace - resolved workspace.
 * @param sessionId - target Session.
 * @param signal - cancellation for the list read.
 * @returns the Session row.
 * @throws WorkspaceRecordError when the workspace does not account for it or the host cannot list it.
 */
async function listedSessionOf(
  controller: SessionControllerLike,
  workspace: Workspace,
  sessionId: string,
  signal: AbortSignal | undefined,
): Promise<SessionSummaryLike> {
  requireWorkspaceMember(workspace, sessionId)
  const listed = await listControllerSessions(controller, signal)
  const item = listed.items.find(candidate => String(candidate.sessionId) === sessionId)
  if (item === undefined) {
    throw new WorkspaceRecordError(
      `workspace ${String(workspace.id)} holds no listed Session ${sessionId}`,
      'WORKSPACE_RECORD_NOT_FOUND',
    )
  }
  return item
}

/**
 * Choose the Session an `append` or `run` continues. An omitted selector, or
 * `latest`, continues the most recently updated Session; any other value must
 * name one of the workspace's candidate Sessions.
 * @param controller - host Session controller.
 * @param workspace - resolved workspace.
 * @param selector - the caller's `sessionId` argument.
 * @param signal - cancellation for the list read.
 * @returns the chosen Session row.
 * @throws WorkspaceRecordError when the workspace has no Session or no matching one.
 */
async function appendTargetOf(
  controller: SessionControllerLike,
  workspace: Workspace,
  selector: string | undefined,
  signal: AbortSignal | undefined,
): Promise<SessionSummaryLike> {
  const listed = await listControllerSessions(controller, signal)
  const members = new Set(workspace.sessionIds.map(id => String(id)))
  const candidates = listed.items
    .filter(item => members.has(String(item.sessionId)))
    .filter(item => item.parentSessionId === undefined && item.origin !== 'subagent' && item.blank !== true)
    .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
  const first = candidates[0]
  if (first === undefined) {
    throw new WorkspaceRecordError(
      `workspace ${String(workspace.id)} has no Session to continue yet; start one with workspace_sessions start`,
      'WORKSPACE_RECORD_NOT_FOUND',
    )
  }
  const value = selector?.trim()
  if (value === undefined || value === '' || value === 'latest') return first
  const target = candidates.find(item => String(item.sessionId) === value)
  if (target === undefined) {
    throw new WorkspaceRecordError(
      `workspace ${String(workspace.id)} holds no Session ${value}; candidates: `
      + candidates.map(item => String(item.sessionId)).join(', '),
      'WORKSPACE_RECORD_NOT_FOUND',
    )
  }
  return target
}

/**
 * Capture the dispatcher permission state to seed into a Session it dispatches.
 * Read through duck-typed host services: a composition without them keeps
 * dispatching, just without an inherited policy. Call before the first await, so
 * a later switch belongs to the dispatcher's future rather than this dispatch.
 * @param ctx - context carrying the optional policy services.
 * @param caller - Session dispatching the new one.
 * @returns the policy to append to the new Session's log.
 */
function captureDelegatedPermissionPolicy(ctx: Context, caller: Session): DelegatedPermissionPolicy {
  const preset = lookup<PermissionPresetsLike>(ctx, 'permissionPresets')?.current(caller)
  const mode = lookup<SandboxPolicyLike>(ctx, 'sandboxPolicy')?.resolve({ session: caller })?.mode
  return {
    preset: preset === 'auto' || preset === 'danger-full-access' ? preset : undefined,
    mode: mode === 'read-only' || mode === 'workspace-write' || mode === 'danger-full-access' ? mode : undefined,
    approval: lookup<unknown>(ctx, 'approval') === undefined ? undefined : 'never',
  }
}

/**
 * Append a captured policy to a dispatched Session's log as
 * `source: 'delegation'` events, so its effective policy is reconstructable from
 * its own log. An absent store, or one that no longer holds the Session, is
 * skipped: the dispatch itself already succeeded.
 * @param ctx - context carrying the optional Session store.
 * @param sessionId - Session the policy is seeded into.
 * @param policy - policy captured at delegation.
 */
function appendDelegatedPermissionPolicy(
  ctx: Context,
  sessionId: string,
  policy: DelegatedPermissionPolicy,
): void {
  const target = lookup<SessionStoreLike>(ctx, 'sessions')?.get(SessionId(sessionId))
  if (target === undefined || typeof target.append !== 'function') return
  if (policy.mode !== undefined) target.append('sandbox/mode', { mode: policy.mode, source: 'delegation' })
  if (policy.approval !== undefined) target.append('approval/policy', { policy: policy.approval, source: 'delegation' })
  if (policy.preset !== undefined) target.append('permission/preset', { preset: policy.preset })
}

/**
 * Start one Session in a workspace and admit its first task.
 * @param ctx - context carrying the store.
 * @param controller - host Session controller.
 * @param workspace - workspace the Session belongs to.
 * @param caller - dispatching Session, named in the delivery header.
 * @param input - first task, optional title, caller role, model route, and cancellation.
 * @returns the started Session.
 */
async function startWorkspaceSession(
  ctx: Context,
  controller: SessionControllerLike,
  workspace: Workspace,
  caller: Session,
  input: {
    readonly task: string
    readonly title?: string
    readonly role: AgentRole
    readonly model?: SessionModelChoice
    readonly signal: AbortSignal
  },
): Promise<StartedSession> {
  const title = input.title?.trim() || derivedTitle(input.task)
  const delegatedPolicy = captureDelegatedPermissionPolicy(ctx, caller)
  let created: { readonly sessionId: unknown }
  try {
    created = await controller.create({ workspaceId: String(workspace.id) })
  } catch (error: unknown) {
    throw new WorkspaceSessionError(
      `workspace ${String(workspace.id)} could not create a Session: ${messageOf(error)}`,
      'WORKSPACE_SESSION_INVALID',
    )
  }
  const sessionId = String(created.sessionId)
  appendDelegatedPermissionPolicy(ctx, sessionId, delegatedPolicy)
  await noteRosterStart(ctx, workspace, sessionId, actorOf(String(caller.id)), new Date().toISOString())
  let titleRecorded = false
  if (typeof controller.rename === 'function') {
    try {
      await controller.rename({ sessionId, title })
      titleRecorded = true
    } catch (error: unknown) {
      throw new WorkspaceSessionError(
        `Session ${sessionId} was created but its title could not be recorded: ${messageOf(error)}; no task was sent`,
        'WORKSPACE_SESSION_INVALID',
      )
    }
  }
  await applySessionModel(controller, sessionId, input.model)
  let admitted: { readonly accepted: boolean }
  try {
    admitted = await controller.prompt({
      requestId: `workspace-session-start-${randomUUID()}`,
      sessionId,
      mode: 'queue',
      content: [
        { type: 'text', text: deliveryHeader(workspace, input.role, String(caller.id)) },
        { type: 'text', text: input.task },
      ],
    }, input.signal)
  } catch (error: unknown) {
    throw new WorkspaceSessionError(
      `Session ${sessionId} was created in workspace ${String(workspace.id)} but its first task was not admitted: ${messageOf(error)}`,
      'WORKSPACE_SESSION_INVALID',
    )
  }
  return {
    sessionId,
    workspace: String(workspace.id),
    cwd: workspace.path,
    title,
    titleRecorded,
    admitted: admitted.accepted,
  }
}

/**
 * Derive a durable Session title from the first task text.
 * @param task - first task text.
 * @returns a bounded one-line title.
 */
function derivedTitle(task: string): string {
  const line = oneLine(task, 120).trim()
  return line.length === 0 ? 'Workspace session' : line
}

/**
 * Read the host token meter when the deployment mounts one.
 * @param ctx - context, or an Agent's own context, that may carry `tokenMeter`.
 * @returns the meter when it can measure context pressure.
 */
function tokenMeterOf(ctx: unknown): TokenMeterLike | undefined {
  const service = lookup<Partial<TokenMeterLike>>(ctx, 'tokenMeter')
  return service !== undefined && typeof service.contextPressure === 'function'
    ? service as TokenMeterLike
    : undefined
}

/**
 * Read the host manual-compaction seam when the deployment mounts one.
 * @param ctx - context, or an Agent's own context, that may carry `compaction`.
 * @returns the compaction seam when it can compact now.
 */
function compactionOf(ctx: unknown): CompactionLike | undefined {
  const service = lookup<Partial<CompactionLike>>(ctx, 'compaction')
  return service !== undefined && typeof service.compactNow === 'function'
    ? service as CompactionLike
    : undefined
}

/**
 * Read the preset registry that owns the isolated compaction engine.
 * @param ctx - plugin context, duck-typed.
 * @returns the bridge when it exposes per-Agent preset services.
 */
function agentPresetsOf(ctx: unknown): AgentPresetsLike | undefined {
  const service = lookup<AgentPresetsLike>(ctx, 'agentPresets')
  return service !== undefined && typeof service.serviceFor === 'function' ? service : undefined
}

/**
 * Resolve the compaction engine through the target Agent's preset isolate.
 * @param ctx - plugin context.
 * @param agent - Agent being compacted.
 * @returns the engine, when the preset mounts one.
 */
function presetCompactionOf(ctx: unknown, agent: unknown): CompactionLike | undefined {
  const presets = agentPresetsOf(ctx)
  if (presets?.serviceFor === undefined) return undefined
  let candidate: unknown
  try {
    candidate = presets.serviceFor({ ctx: (agent as { ctx?: unknown }).ctx }, 'compaction')
  } catch {
    return undefined
  }
  const engine = candidate as Partial<CompactionLike> | undefined
  return engine !== undefined && typeof engine.compactNow === 'function' ? engine as CompactionLike : undefined
}

/**
 * Read one service off a context, without assuming the context declares it.
 * @param ctx - context or Agent context, duck-typed.
 * @param key - service name.
 * @returns the service, when present.
 */
function lookup<T>(ctx: unknown, key: string): T | undefined {
  const get = (ctx as { get?: (name: string) => unknown } | undefined)?.get
  if (typeof get !== 'function') return undefined
  return get.call(ctx, key) as T | undefined
}

/**
 * Read one Session's context usage from the occupancy the next request would
 * carry, falling back to the last sample.
 *
 * The provider sample alone cannot answer this: compaction reports no usage of
 * its own, so a compacted Session keeps its old sample until the next request.
 * The meter's projected figure adds the surface movement since that sample and
 * is what the client occupancy display divides by the window.
 * @param meter - host token meter, when mounted.
 * @param session - the Session to measure.
 * @returns the usage, or undefined when the host cannot measure it.
 */
function contextUsageOf(meter: TokenMeterLike | undefined, session: unknown): SessionContextUsage | undefined {
  if (meter === undefined || session === undefined) return undefined
  const { pressureTokens, projectedTokens, contextWindow } = meter.contextPressure(session)
  const tokens = projectedTokens ?? pressureTokens
  if (tokens === undefined || contextWindow === undefined || contextWindow <= 0) return undefined
  return {
    tokens,
    window: contextWindow,
    percent: Math.min(100, Math.round(tokens / contextWindow * 100)),
  }
}

/**
 * Compact one Session through the host's manual-compaction seam.
 *
 * The engine refuses (`busy`) while a turn is active, so a running task is
 * never interrupted; that refusal is reported as a readable failure. Every
 * outcome is measured on both sides where the host can measure it.
 * @param ctx - plugin context carrying the compaction seam and token meter.
 * @param controller - host Session controller (for `resolveAgent`).
 * @param sessionId - Session to compact.
 * @param signal - cancellation for the compaction.
 * @returns the before/after usage and what the compaction did.
 * @throws WorkspaceSessionError when the Session, engine, or compaction is unavailable.
 */
async function compactWorkspaceSession(
  ctx: Context,
  controller: SessionControllerLike,
  sessionId: string,
  signal: AbortSignal | undefined,
): Promise<CompactionOutcome> {
  if (typeof controller.resolveAgent !== 'function') {
    throw new WorkspaceSessionError(
      'this host exposes no Agent resolution for a Session, so the Session cannot be compacted',
      'WORKSPACE_SESSION_UNAVAILABLE',
    )
  }
  let agent: unknown
  try {
    const resolved = await controller.resolveAgent(sessionId)
    agent = resolved.agent
    if (agent === undefined) {
      const error = resolved.error
      throw new WorkspaceSessionError(
        `the Session could not be resolved: ${error === undefined ? 'the host returned no Agent' : messageOf(error)}`,
        'WORKSPACE_SESSION_UNAVAILABLE',
      )
    }
  } catch (error: unknown) {
    if (error instanceof WorkspaceSessionError) throw error
    throw new WorkspaceSessionError(`the Session could not be resolved: ${messageOf(error)}`, 'WORKSPACE_SESSION_UNAVAILABLE')
  }
  const agentCtx = (agent as { ctx?: unknown }).ctx
  const compaction = compactionOf(agentCtx) ?? presetCompactionOf(ctx, agent) ?? compactionOf(ctx)
  if (compaction === undefined) {
    throw new WorkspaceSessionError(
      agentPresetsOf(ctx) === undefined
        ? 'this host has no agent-presets bridge, so the Session compaction engine is not reachable'
        : 'this Session preset has no compaction engine mounted',
      'WORKSPACE_SESSION_UNAVAILABLE',
    )
  }
  const meter = tokenMeterOf(agentCtx) ?? tokenMeterOf(ctx)
  const session = (agent as { session?: unknown }).session
  const before = contextUsageOf(meter, session)
  try {
    const result = await compaction.compactNow(agent, signal ?? new AbortController().signal)
    const after = contextUsageOf(meter, session)
    return {
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
      compacted: result !== null,
      shadowedTokens: result?.shadowedTokenCount ?? 0,
    }
  } catch (error: unknown) {
    throw new WorkspaceSessionError(`the Session was not compacted: ${messageOf(error)}`, 'WORKSPACE_SESSION_INVALID')
  }
}

/**
 * Read one Error's message, or stringify the value.
 * @param error - thrown value.
 * @returns readable text.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * List the sessions a workspace accounts for, filtered and paged.
 * @param ctx - context carrying session-query, the store, and the registries.
 * @param workspace - workspace whose sessions are listed.
 * @param request - status filter, cursor, and page size.
 * @param signal - cancellation for the log and record reads.
 * @returns the page of summaries.
 */
async function listWorkspaceSessions(
  ctx: Context,
  workspace: Workspace,
  request: { readonly status?: WorkspaceSessionStatus; readonly cursor?: string; readonly limit?: number },
  signal: AbortSignal | undefined,
): Promise<Page<SessionSummary>> {
  const ids = workspace.sessionIds
  if (ids.length === 0) return { items: [] }
  const records = await ctx.sessionQuery.filterSessions([{ kind: 'id', values: ids }], signal)
  records.sort((left, right) => right.header.createdAt - left.header.createdAt
    || String(left.header.id).localeCompare(String(right.header.id)))
  const taskOf = activeTaskBySession(await listTasks(ctx, workspace.id, signal))
  const archived = new Set(workspaceDirectory(ctx).archivedSessionIds.map(id => String(id)))
  const known = new Map(records.map(record => [String(record.header.id), new Date(record.header.createdAt).toISOString()]))
  const roster = await reconcileRoster(ctx, workspace, known, archived, signal)
  const meter = tokenMeterOf(ctx)
  const summaries: SessionSummary[] = []
  for (const record of records) {
    const id = String(record.header.id)
    const facts = await readSessionFacts(ctx, id, archived.has(id), signal)
    if (request.status !== undefined && facts.status !== request.status) continue
    const taskId = taskOf.get(id)
    summaries.push({
      sessionId: id,
      workspaceId: String(workspace.id),
      workspaceTitle: workspace.title,
      ...rosterSummaryOf(id, roster.get(id), facts, archived.has(id), workspace.role, meter, ctx),
      status: facts.status,
      currentTurn: facts.currentTurn,
      ...facts.currentActivity === undefined ? {} : { currentActivity: facts.currentActivity },
      ...facts.lastProgressAt === undefined ? {} : { lastProgressAt: facts.lastProgressAt },
      ...facts.latestProgress === undefined ? {} : { latestProgress: facts.latestProgress },
      ...facts.updatedAt === undefined ? {} : { updatedAt: facts.updatedAt },
      ...taskId === undefined ? {} : { taskId },
    })
  }
  const page = pageOf(summaries, request.limit, request.cursor)
  const titles = await sessionTitles(ctx, page.items.map(item => item.sessionId), signal)
  return {
    items: page.items.map((item) => {
      const title = titles.get(item.sessionId)
      return title === undefined ? item : { ...item, title }
    }),
    ...page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor },
  }
}

/**
 * Describe one session in full: summary, recent progress, pending inbox, and artifact count.
 * @param ctx - context carrying session-query and the store.
 * @param workspace - workspace the session must belong to.
 * @param sessionId - target session id.
 * @param signal - cancellation for the log and record reads.
 * @returns the detailed session view.
 * @throws WorkspaceRecordError when the id is not a session of this workspace.
 */
async function describeSession(
  ctx: Context,
  workspace: Workspace,
  sessionId: string,
  signal: AbortSignal | undefined,
): Promise<NonNullable<WorkspaceSessionsValue['session']>> {
  if (!workspace.sessionIds.includes(SessionId(sessionId))) {
    throw new WorkspaceRecordError(
      `session ${sessionId} is not a session of workspace ${String(workspace.id)}`,
      'WORKSPACE_RECORD_NOT_FOUND',
    )
  }
  const archived = workspaceDirectory(ctx).archivedSessionIds.map(id => String(id)).includes(sessionId)
  const facts = await readSessionFacts(ctx, sessionId, archived, signal)
  const created = await ctx.sessionQuery.filterSessions([{ kind: 'id', values: [SessionId(sessionId)] }], signal)
  const known = new Map(created.map(record => [String(record.header.id), new Date(record.header.createdAt).toISOString()]))
  const roster = await reconcileRoster(ctx, workspace, known, new Set(archived ? [sessionId] : []), signal)
  const title = (await sessionTitles(ctx, [sessionId], signal)).get(sessionId)
  const taskId = activeTaskBySession(await listTasks(ctx, workspace.id, signal)).get(sessionId)
  const messages = await listMessages(ctx, workspace.id, signal)
  const pendingInbox = messages.filter(message => message.targetSessionId === sessionId && message.status === 'queued').length
  const artifacts = await listArtifacts(ctx, workspace.id, signal)
  const artifactCount = artifacts.filter(record => record.versions.some(reference => reference.sessionId === sessionId)).length
  return {
    sessionId,
    workspaceId: String(workspace.id),
    workspaceTitle: workspace.title,
    ...rosterSummaryOf(sessionId, roster.get(sessionId), facts, archived, workspace.role, tokenMeterOf(ctx), ctx),
    ...title === undefined ? {} : { title },
    status: facts.status,
    currentTurn: facts.currentTurn,
    ...facts.currentActivity === undefined ? {} : { currentActivity: facts.currentActivity },
    ...facts.lastProgressAt === undefined ? {} : { lastProgressAt: facts.lastProgressAt },
    ...facts.latestProgress === undefined ? {} : { latestProgress: facts.latestProgress },
    ...facts.updatedAt === undefined ? {} : { updatedAt: facts.updatedAt },
    ...taskId === undefined ? {} : { taskId },
    recentProgress: facts.recentProgress,
    pendingInbox,
    artifactCount,
  }
}

/**
 * Project the roster and live-Agent facts shared by `list` and `get`.
 * @param sessionId - Session the projection describes.
 * @param entry - roster entry, when one exists.
 * @param facts - folded Session facts.
 * @param archived - whether the registry counts the Session as archived.
 * @param workspaceRole - durable role of the workspace.
 * @param meter - host token meter, when mounted.
 * @param ctx - context carrying the Agent registry.
 * @returns the role, actor, archive, fork, and context-usage fields.
 */
function rosterSummaryOf(
  sessionId: string,
  entry: SessionRosterEntry | undefined,
  facts: SessionFacts,
  archived: boolean,
  workspaceRole: 'agent' | 'super',
  meter: TokenMeterLike | undefined,
  ctx: Context,
): Pick<SessionSummary, 'role' | 'createdBy' | 'createdAt' | 'forkedFrom' | 'archivedBy' | 'archivedAt' | 'archived' | 'contextUsage'> {
  const live = ctx.get('agents')?.get(SessionId(sessionId))
  const liveMeter = live === undefined ? meter : tokenMeterOf(live.ctx) ?? meter
  const contextUsage = contextUsageOf(liveMeter, live?.session)
  return {
    role: facts.role ?? workspaceRole,
    ...entry?.createdBy === undefined ? {} : { createdBy: entry.createdBy },
    ...entry?.createdAt === undefined ? {} : { createdAt: entry.createdAt },
    ...entry?.forkedFrom === undefined ? {} : { forkedFrom: entry.forkedFrom },
    ...entry?.archivedBy === undefined ? {} : { archivedBy: entry.archivedBy },
    ...entry?.archivedAt === undefined ? {} : { archivedAt: entry.archivedAt },
    archived,
    ...contextUsage === undefined ? {} : { contextUsage },
  }
}

/**
 * Fold status and progress out of one session log.
 * @param ctx - context carrying session-query and the live agent registry.
 * @param sessionId - session whose log is observed.
 * @param archived - whether the registry holds this session in its archive set.
 * @param signal - cancellation for the observation.
 * @returns the folded facts.
 */
async function readSessionFacts(
  ctx: Context,
  sessionId: string,
  archived: boolean,
  signal: AbortSignal | undefined,
): Promise<SessionFacts> {
  const id = SessionId(sessionId)
  using observation = await ctx.sessionQuery.observeSession(id, {
    projectionMode: 'none',
    ...signal === undefined ? {} : { signal },
  })
  const folded = foldLog(observation.events)
  const live = ctx.get('agents')?.get(id)
  const latest = observation.events.at(-1)
  return {
    status: archived ? 'done' : statusOf(live?.status, folded.lastEndReason),
    currentTurn: folded.currentTurn,
    ...folded.currentActivity === undefined ? {} : { currentActivity: folded.currentActivity },
    ...folded.lastProgressAt === undefined ? {} : { lastProgressAt: folded.lastProgressAt },
    ...folded.latestProgress === undefined ? {} : { latestProgress: folded.latestProgress },
    ...latest === undefined ? {} : { updatedAt: new Date(latest.time).toISOString() },
    ...live?.role === undefined ? {} : { role: live.role },
    recentProgress: folded.recentProgress,
  }
}

/** Folded activity facts of one event log. */
interface LogFacts {
  /** Latest turn number. */
  readonly currentTurn: number
  /** Last observed activity line. */
  readonly currentActivity?: string
  /** Instant of the latest progress line. */
  readonly lastProgressAt?: string
  /** Latest assistant progress line. */
  readonly latestProgress?: string
  /** Recent assistant progress lines. */
  readonly recentProgress: ProgressEntry[]
  /** Reason of the latest `turn/end`. */
  readonly lastEndReason?: TurnEndReason
}

/**
 * Fold the parts of one log that answer "what is this session doing".
 * @param events - complete event log in seq order.
 * @returns turn, activity, and recent progress lines.
 */
function foldLog(events: readonly SessionEvent[]): LogFacts {
  let currentTurn = 0
  let currentActivity: string | undefined
  let lastEndReason: TurnEndReason | undefined
  const progress: ProgressEntry[] = []
  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        currentTurn = event.data.turn
        break
      case 'assistant/message': {
        const text = event.data.message.content
          .flatMap(block => block.type === 'text' ? [block.text] : [])
          .join(' ')
          .trim()
        if (text.length === 0) break
        progress.push({ at: new Date(event.time).toISOString(), summary: oneLine(text, 200) })
        currentActivity = `Assistant: ${oneLine(text, 120)}`
        break
      }
      case 'tool/call':
        currentActivity = `Calling ${event.data.name}`
        break
      case 'turn/end':
        lastEndReason = event.data.reason
        currentActivity = reasonLine(event.data.reason)
        break
      default:
        break
    }
  }
  const latest = progress.at(-1)
  return {
    currentTurn,
    ...currentActivity === undefined ? {} : { currentActivity },
    ...latest === undefined ? {} : { lastProgressAt: latest.at },
    ...latest === undefined ? {} : { latestProgress: latest.summary },
    recentProgress: progress.slice(-5),
    ...lastEndReason === undefined ? {} : { lastEndReason },
  }
}

/**
 * Derive the status from the live agent and the last turn outcome.
 * @param liveStatus - status of the live agent, or undefined when the session is not live.
 * @param lastEndReason - reason of the last `turn/end`, when the log has one.
 * @returns the effective status.
 */
function statusOf(
  liveStatus: 'idle' | 'running' | undefined,
  lastEndReason: TurnEndReason | undefined,
): WorkspaceSessionStatus {
  if (liveStatus === 'running') return 'running'
  if (lastEndReason?.kind === 'blocked') return 'blocked'
  return 'idle'
}

/**
 * Render one turn-ending reason as a bounded activity line.
 * @param reason - the durable turn-ending reason.
 * @returns the activity line.
 */
function reasonLine(reason: TurnEndReason): string {
  switch (reason.kind) {
    case 'completed':
      return 'Turn completed'
    case 'blocked':
      return 'Blocked'
    case 'error':
      return `Turn failed: ${oneLine(reason.error.message, 120)}`
    case 'aborted':
      return 'Turn aborted'
    case 'max-tokens':
      return 'Turn reached the output token cap'
    case 'interrupted':
      return 'Turn was interrupted'
    case 'forked':
      return 'Turn was closed by a fork'
    default:
      return 'Turn ended'
  }
}

/**
 * Read the latest log-backed title of each session.
 * @param ctx - context carrying session-query.
 * @param sessionIds - sessions whose titles are read.
 * @param signal - cancellation for the reads.
 * @returns title text by session id, for the sessions that carry one.
 */
async function sessionTitles(
  ctx: Context,
  sessionIds: readonly string[],
  signal: AbortSignal | undefined,
): Promise<ReadonlyMap<string, string>> {
  const ids = [...new Set(sessionIds)]
  if (ids.length === 0) return new Map()
  const observations = await ctx.sessionQuery.readTitleSnapshots(ids.map(id => SessionId(id)), signal)
  const titles = new Map<string, string>()
  ids.forEach((id, index) => {
    const observation = observations[index]
    if (observation === undefined || observation.status === 'rejected') return
    const title = observation.value.title?.title
    if (title !== undefined) titles.set(id, title)
  })
  return titles
}

/**
 * Map each session to the task currently targeting it.
 * @param tasks - workspace tasks, most recently updated first.
 * @returns the first active task's id by target session.
 */
function activeTaskBySession(tasks: readonly TaskRecord[]): ReadonlyMap<string, string> {
  const active = new Map<string, string>()
  for (const task of tasks) {
    if (task.targetSessionId === undefined) continue
    if (task.status !== 'pending' && task.status !== 'in_progress' && task.status !== 'waiting_review') continue
    if (!active.has(task.targetSessionId)) active.set(task.targetSessionId, task.taskId)
  }
  return active
}

/**
 * Render one sessions value for the model.
 * @param value - the tool result.
 * @returns the model-facing text.
 */
function renderSessions(value: WorkspaceSessionsValue): string {
  const lifecycle = renderLifecycle(value)
  if (lifecycle !== undefined) return lifecycle
  const details = value.session
  if (details !== undefined) {
    const lines = [
      (details.title === undefined ? details.sessionId : `${details.title} (${details.sessionId})`)
      + ` · ${details.status} · turn ${String(details.currentTurn)}`
      + (details.role === undefined ? '' : ` · ${details.role}`)
      + (details.createdBy === undefined ? '' : ` · by ${details.createdBy}`)
      + (details.archivedBy === undefined ? '' : ` · archived by ${details.archivedBy}`)
      + (details.contextUsage?.percent === undefined ? '' : ` · ctx ${String(details.contextUsage.percent)}%`)
      + (details.taskId === undefined ? '' : ` · task ${details.taskId}`)
      + ` · ${String(details.pendingInbox)} queued · ${String(details.artifactCount)} artifacts`,
      `Current: ${details.currentActivity ?? 'no activity recorded'}${details.lastProgressAt === undefined ? '' : ` (${details.lastProgressAt})`}`,
    ]
    if (details.recentProgress.length > 0) {
      lines.push('Recent progress:')
      for (const entry of details.recentProgress) lines.push(`- ${entry.at} · ${entry.summary}`)
    }
    return lines.join('\n')
  }
  const items = value.items ?? []
  if (items.length === 0) return `No sessions in workspace ${value.workspace}.`
  const lines = items.map(item =>
    `- ${item.title === undefined ? item.sessionId : `${item.title} (${item.sessionId})`}`
    + ` · ${item.status} · turn ${String(item.currentTurn)}`
    + (item.role === undefined ? '' : ` · ${item.role}`)
    + (item.createdBy === undefined ? '' : ` · by ${item.createdBy}`)
    + (item.archivedBy === undefined ? '' : ` · archived by ${item.archivedBy}`)
    + (item.contextUsage?.percent === undefined ? '' : ` · ctx ${String(item.contextUsage.percent)}%`)
    + (item.currentActivity === undefined ? '' : ` · ${item.currentActivity}`)
    + (item.taskId === undefined ? '' : ` · task ${item.taskId}`))
  if (value.nextCursor !== undefined) lines.push(`(more sessions: pass cursor ${value.nextCursor})`)
  return lines.join('\n')
}

/**
 * Render one lifecycle result.
 * @param value - the tool result.
 * @returns the model-facing text, or undefined for a read result.
 */
function renderLifecycle(value: WorkspaceSessionsValue): string | undefined {
  const started = value.started
  if (started !== undefined) {
    return `Started "${started.title}" (${started.sessionId}) in workspace ${started.workspace}`
      + ` · cwd ${started.cwd}`
      + (started.titleRecorded ? '' : ' · title not recorded: the host exposes no rename API')
      + (started.admitted ? ' · first task admitted' : ' · first task not admitted')
  }
  const aborted = value.aborted
  if (aborted !== undefined) {
    const delivery = value.delivery
    return `Aborted ${aborted.sessionId}`
      + (aborted.resumed ? ' and admitted the follow-up instruction' : '; the follow-up instruction was not admitted')
      + (delivery === undefined ? '' : `\n${renderDelivery(delivery)}`)
  }
  const delivery = value.delivery
  if (delivery !== undefined) return renderDelivery(delivery)
  const stopped = value.stopped
  if (stopped !== undefined) {
    return stopped.accepted
      ? `Stopped ${stopped.sessionId}: the running turn was cancelled and no text was admitted.`
      : `No stop sent to ${stopped.sessionId}: it is already idle.`
  }
  const forked = value.forked
  if (forked !== undefined) {
    return `Forked ${forked.forkedFrom} into ${forked.sessionId}`
      + (forked.atSeq === undefined ? ' from the latest completed turn' : ` at event ${String(forked.atSeq)}`)
  }
  const archived = value.archived
  if (archived !== undefined) return `Archived ${archived.sessionId}: it is hidden from the workspace groupings.`
  const compacted = value.compacted
  if (compacted !== undefined) {
    if (!compacted.compacted) return `Nothing to compact in ${compacted.sessionId}.`
    const before = compacted.before?.percent
    const after = compacted.after?.percent
    const usage = before === undefined || after === undefined ? '' : ` · context ${String(before)}% → ${String(after)}%`
    const shadowed = compacted.shadowedTokens === undefined ? '' : ` · ${String(compacted.shadowedTokens)} tokens shadowed`
    return `Compacted ${compacted.sessionId}${usage}${shadowed}`
  }
  const deleted = value.deleted
  if (deleted !== undefined) return `Deleted ${deleted.sessionId}: its stored Session log is gone.`
  return undefined
}

/**
 * Render one delivery result.
 * @param delivery - the admitted instruction record.
 * @returns the model-facing line.
 */
function renderDelivery(delivery: SessionDelivery): string {
  return `Delivered to ${delivery.sessionId}`
    + ` · ${delivery.used}${delivery.requested === delivery.used ? '' : ` (requested ${delivery.requested})`}`
    + (delivery.fallback === true ? ' · the Session was idle, so interrupt queued' : '')
    + ` · ${delivery.accepted ? 'accepted' : 'not accepted'}`
}
