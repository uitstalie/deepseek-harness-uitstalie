/**
 * `workspace_sessions`: which sessions a workspace has, what each is doing, and
 * the lifecycle of a real Session in a registered workspace.
 *
 * Status, current activity, and recent progress are folded from the session's
 * own log, so the answer is the durable record rather than a remembered copy.
 * The tool returns bounded one-line summaries; raw turns stay behind
 * `session_event_read`. Lifecycle actions (`start`, `append`, `prompt`, `stop`,
 * `abort`, `fork`, `archive`, `compact`, `delete`) drive the host's Session
 * controller and workspace registry by duck-typed lookup, and are reserved for
 * the super agent; `list` and `get` stay available to every agent.
 * @module @deepseek-ai/dsh-workspace-tools/sessions
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { defineTool, ToolArgsError } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { Page } from './paging.ts'
import { pageOf } from './paging.ts'
import { WorkspaceIntentError, WorkspaceRecordError, WorkspaceSessionError, WorkspaceTaskError } from './errors.ts'
import { resolveWorkspace, workspaceDirectory } from './scope.ts'
import { listArtifacts, listMessages, listTasks, readTask } from './store.ts'
import { TASK_TYPES } from './records.ts'
import type { TaskCoverage, TaskNonCoverage, TaskRecord, TaskType } from './records.ts'
import { attachDispatchTaskSession } from './tasks.ts'
import { oneLine, requireCallerSession } from './tooling.ts'

/** One derived status of a workspace session. */
export type WorkspaceSessionStatus = 'running' | 'idle' | 'blocked' | 'done'

/** Every accepted session status. */
export const WORKSPACE_SESSION_STATUSES: readonly WorkspaceSessionStatus[] = ['running', 'idle', 'blocked', 'done']

/** Actions that only read a workspace. */
export const WORKSPACE_SESSION_READ_ACTIONS = ['list', 'get'] as const

/** Actions that create or change a real Session; they require the super agent. */
export const WORKSPACE_SESSION_LIFECYCLE_ACTIONS = [
  'start', 'append', 'prompt', 'stop', 'abort', 'fork', 'archive', 'compact', 'delete',
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
}

/** Session summary as the list action returns it. */
export interface SessionSummary {
  /** Session identity. */
  readonly sessionId: string
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
  /** Task the session is executing, when one targets it. */
  readonly taskId?: string
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
  /** The task record created or referenced before the Session was prompted. */
  readonly taskId: string
  /** Intent card the task was dispatched against, when it has one. */
  readonly intentId?: string
  /** Intent card version the task was dispatched against, when it has one. */
  readonly intentVersion?: number
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
  /** The task record this delivery was associated with, when one was named. */
  readonly taskId?: string
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
  /** Measured pressure tokens. */
  readonly tokens?: number
  /** Routed context window in tokens. */
  readonly window?: number
  /** Rounded pressure percentage. */
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
  /** Target Session for `append`; an id or `latest`. */
  readonly session?: string
  /** Target Session for every other lifecycle action. */
  readonly sessionId?: string
  /** Exact Session id the caller repeated for `delete`. */
  readonly confirm?: string
  /** Requested delivery mode for `append` and `prompt`. */
  readonly delivery?: SessionDeliveryMode
  /** Exact fork boundary for `fork`. */
  readonly atSeq?: number
  /** Optional LLM provider id. */
  readonly provider?: string
  /** Optional model id. */
  readonly model?: string
  /** Optional reasoning effort. */
  readonly reasoning_effort?: string
  /** Existing dispatch task to start from, or to associate an append/prompt with. */
  readonly taskId?: string
  /** Active intent card the new Session is dispatched against. */
  readonly intentId?: string
  /** Card version the new Session is dispatched against. */
  readonly intentVersion?: number
  /** The brief's acceptance items, mirrored on the task record. */
  readonly acceptance?: readonly string[]
  /** The brief's boundaries, mirrored on the task record. */
  readonly boundaries?: readonly string[]
  /** The brief's deliverable items. */
  readonly outputForm?: readonly string[]
  /** One mapping per card point. */
  readonly coverage?: readonly TaskCoverage[]
  /** Explicit non-coverage for a card point. */
  readonly nonCoverage?: readonly TaskNonCoverage[]
  /** Six-category task type the card dispatch requires. */
  readonly taskType?: TaskType
}

/** The slice of the host token meter lifecycle results read. */
interface TokenMeterLike {
  /**
   * Measure one Session's context pressure.
   * @param session - live Session.
   * @returns pressure tokens and the routed window.
   */
  contextPressure(session: unknown): { readonly pressureTokens?: number; readonly contextWindow?: number }
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
      + 'The lifecycle actions require the super agent. `start` dispatches a new Session from an active intent '
      + 'card: read the card with `workspace_intents`, then pass `intentId`, `intentVersion`, the brief\'s '
      + '`acceptance`, `boundaries`, and `taskType`, plus one `coverage` entry per card point (or an explicit '
      + '`nonCoverage` reason). The workspace task record is created before the Session is prompted, and a '
      + 'missing, proposed, stale, or cross-workspace card, or an uncovered card point, refuses the dispatch; '
      + '`start` also accepts an existing pending `taskId` in place of the card fields. `append` continues one '
      + 'of the workspace\'s Sessions and needs `session` (an id, or "latest"); `prompt` sends text to an '
      + 'explicit sessionId; both accept `taskId` to associate the delivery with its task. `stop` cuts off the '
      + 'running turn and admits nothing; `abort` cuts it off and then sends `text`; `fork` branches a Session '
      + 'at an optional `atSeq`; `archive` hides it; `compact` compresses its history; `delete` erases a stored '
      + 'Session only when the host exposes a real delete API — otherwise it refuses, because an archive is not '
      + 'a deletion. `delivery` is queue (default) or interrupt for `append` and `prompt`; trust `get` before '
      + 'addressing a Session.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: [...WORKSPACE_SESSION_ACTIONS],
        description: '`list`/`get` read a workspace. `start`, `append`, `prompt`, `stop`, `abort`, `fork`, '
          + '`archive`, `compact`, and `delete` change a real Session and require the super agent.',
      },
      workspace: {
        type: 'string',
        description: 'Registered workspace id to read or change; defaults to the caller\'s workspace. A '
          + 'lifecycle target Session must belong to this workspace, and a cross-workspace call must name it.',
      },
      sessionId: {
        type: 'string',
        description: 'Target Session for `get`, `prompt`, `stop`, `abort`, `fork`, `archive`, `compact`, and '
          + '`delete`; required there and unused by `list` and `append`.',
      },
      session: {
        type: 'string',
        description: '`append`: the Session to continue, as an id or "latest" for the workspace\'s most '
          + 'recently updated Session. `append` refuses without it rather than guessing.',
      },
      task: {
        type: 'string',
        description: '`start`: the self-contained first task for the new Session; it becomes the task goal and '
          + 'is what the Session is prompted with.',
      },
      taskId: {
        type: 'string',
        description: '`start`: an existing pending `workspace_tasks` task to dispatch instead of creating one '
          + 'from a card (do not also pass card fields). `append`/`prompt`: associate this delivery with that '
          + 'task; it must belong to the target Session.',
      },
      intentId: {
        type: 'string',
        description: '`start`: the active intent card id read with `workspace_intents`; required unless `taskId` '
          + 'names an existing task.',
      },
      intentVersion: {
        type: 'integer',
        description: '`start`: the card version read with `workspace_intents`; required with `intentId`. A '
          + 'proposed version refuses with INTENT_UNCONFIRMED and a superseded one with INTENT_STALE.',
      },
      acceptance: {
        type: 'array',
        items: { type: 'string' },
        description: '`start`: the brief\'s acceptance items, one per checkable outcome; required with a card.',
      },
      boundaries: {
        type: 'array',
        items: { type: 'string' },
        description: '`start`: the brief\'s boundaries; required with a card.',
      },
      outputForm: {
        type: 'array',
        items: { type: 'string' },
        description: '`start`: the brief\'s deliverable items; covers the card\'s output form when it has one.',
      },
      coverage: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            point: { type: 'string', required: true, description: 'Card point from `workspace_intents` `get`, such as `acceptance[0]`.' },
            brief: { type: 'string', required: true, description: 'Exact text of the brief item that covers the point.' },
            note: { type: 'string' },
          },
        },
        description: '`start`: one entry per card point. A missing point refuses the dispatch with '
          + 'INTENT_COVERAGE_MISSING unless `nonCoverage` waives it; there is no default pass.',
      },
      nonCoverage: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            point: { type: 'string', required: true },
            reason: { type: 'string', required: true },
          },
        },
        description: '`start`: an explicit waiver for one card point, recorded on the task with its reason.',
      },
      taskType: {
        type: 'string',
        enum: [...TASK_TYPES],
        description: '`start`: the six-category task type; required with a card.',
      },
      title: {
        type: 'string',
        description: '`start`: the new Session\'s durable purpose title, so a later `list` tells the '
          + 'conversations apart.',
      },
      text: {
        type: 'string',
        description: '`append`/`prompt`: the instruction to deliver. `abort`: the instruction to run after '
          + 'the running turn is cancelled.',
      },
      delivery: {
        type: 'string',
        enum: ['queue', 'interrupt'],
        description: '`append`/`prompt`: queue (default) waits for the running turn to end; interrupt steers '
          + 'the text into the running turn and queues instead when the Session is idle.',
      },
      atSeq: {
        type: 'integer',
        description: '`fork`: branch from this exact event seq; defaults to the latest completed turn.',
      },
      confirm: {
        type: 'string',
        description: '`delete`: required; repeat the target Session id exactly. Deletion is irreversible.',
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
              properties: {
                sessionId: { type: 'string', required: true },
                title: { type: 'string' },
                status: { type: 'string', required: true, enum: [...WORKSPACE_SESSION_STATUSES] },
                currentTurn: { type: 'integer', required: true },
                currentActivity: { type: 'string' },
                lastProgressAt: { type: 'string' },
                latestProgress: { type: 'string' },
                taskId: { type: 'string' },
              },
            },
          },
          session: {
            type: 'object',
            additionalProperties: false,
            properties: {
              sessionId: { type: 'string', required: true },
              title: { type: 'string' },
              status: { type: 'string', required: true, enum: [...WORKSPACE_SESSION_STATUSES] },
              currentTurn: { type: 'integer', required: true },
              currentActivity: { type: 'string' },
              lastProgressAt: { type: 'string' },
              latestProgress: { type: 'string' },
              taskId: { type: 'string' },
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
              taskId: { type: 'string', required: true },
              intentId: { type: 'string' },
              intentVersion: { type: 'integer' },
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
              taskId: { type: 'string' },
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
      const action = args.action
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

      requireLifecycleRole(exec.agent, action)
      validateLifecycleArguments(action, args)
      const scope = await resolveWorkspace(ctx, session, `sessions.${action}`, args.workspace)
      const workspace = scope.workspace
      const controller = requireSessionController(ctx)
      const signal = exec.signal
      const requestedDelivery: SessionDeliveryMode = args.delivery === 'interrupt' ? 'interrupt' : 'queue'

      if (action === 'start') {
        const task = requiredText(args.task, 'task', action)
        const title = requiredText(args.title, 'title', action).trim()
        const model = modelChoiceOf(args)
        const taskRef = args.taskId?.trim()
        let taskId: string
        let intentId: string | undefined
        let intentVersion: number | undefined
        let createdTask = false
        if (taskRef !== undefined && taskRef !== '') {
          const existing = await readTask(ctx, workspace.id, taskRef, signal)
          if (existing === undefined) {
            throw new WorkspaceSessionError(
              `workspace ${String(workspace.id)} holds no task ${JSON.stringify(taskRef)}; create it with `
              + '`workspace_tasks.create` before dispatching',
              'WORKSPACE_SESSION_INVALID',
            )
          }
          if (existing.task.status !== 'pending') {
            throw new WorkspaceSessionError(
              `task ${taskRef} is ${existing.task.status}; only a pending task can be dispatched to a new Session`,
              'WORKSPACE_SESSION_INVALID',
            )
          }
          if (existing.task.targetSessionId !== undefined) {
            throw new WorkspaceTaskError(
              `task ${taskRef} is already dispatched to Session ${existing.task.targetSessionId}; one task is executed by one Session`,
              'WORKSPACE_TASK_TRANSITION',
            )
          }
          taskId = taskRef
          intentId = existing.task.intentId
          intentVersion = existing.task.intentVersion
        } else {
          const dispatchIntentId = args.intentId
          const dispatchIntentVersion = args.intentVersion
          const dispatchAcceptance = args.acceptance
          const dispatchBoundaries = args.boundaries
          const dispatchTaskType = args.taskType
          const missing = [
            dispatchIntentId === undefined || dispatchIntentId.trim() === '' ? 'intentId' : undefined,
            dispatchIntentVersion === undefined ? 'intentVersion' : undefined,
            dispatchAcceptance === undefined ? 'acceptance' : undefined,
            dispatchBoundaries === undefined ? 'boundaries' : undefined,
            dispatchTaskType === undefined ? 'taskType' : undefined,
          ].filter((field): field is string => field !== undefined)
          if (missing.length > 0
            || dispatchIntentId === undefined
            || dispatchIntentVersion === undefined
            || dispatchAcceptance === undefined
            || dispatchBoundaries === undefined
            || dispatchTaskType === undefined) {
            throw new WorkspaceIntentError(
              'workspace_sessions.start dispatches only from an active intent card: read the card with '
              + `\`workspace_intents\` and pass ${missing.join(', ')} (plus one \`coverage\` entry per card point), `
              + 'or name an existing pending `taskId`; the task record must exist before the Session is prompted',
              'INTENT_INCOMPLETE',
            )
          }
          const createdDispatch = await ctx.workspaceTasks.createDispatchTask({
            workspaceId: String(workspace.id),
            goal: task,
            title,
            acceptance: dispatchAcceptance,
            boundaries: dispatchBoundaries,
            ...args.outputForm === undefined ? {} : { outputForm: args.outputForm },
            intentId: dispatchIntentId,
            intentVersion: dispatchIntentVersion,
            ...args.coverage === undefined ? {} : { coverage: args.coverage },
            ...args.nonCoverage === undefined ? {} : { nonCoverage: args.nonCoverage },
            taskType: dispatchTaskType,
            requestId: `workspace-session-task-${randomUUID()}`,
          }, signal, session)
          taskId = createdDispatch.taskId
          intentId = dispatchIntentId
          intentVersion = dispatchIntentVersion
          createdTask = true
        }
        try {
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
          await applySessionModel(controller, sessionId, model)
          await attachDispatchTaskSession(
            ctx,
            { workspaceId: String(workspace.id), taskId, sessionId },
            { session, signal },
          )
          let admitted: { readonly accepted: boolean }
          try {
            admitted = await controller.prompt({
              requestId: `workspace-session-start-${randomUUID()}`,
              sessionId,
              mode: 'queue',
              content: [{ type: 'text', text: task }],
            }, signal)
          } catch (error: unknown) {
            throw new WorkspaceSessionError(
              `Session ${sessionId} was created in workspace ${String(workspace.id)} but its first task was not admitted: ${messageOf(error)}`,
              'WORKSPACE_SESSION_INVALID',
            )
          }
          return {
            workspace: String(workspace.id),
            started: {
              sessionId,
              workspace: String(workspace.id),
              cwd: workspace.path,
              title,
              titleRecorded,
              admitted: admitted.accepted,
              taskId,
              ...intentId === undefined ? {} : { intentId },
              ...intentVersion === undefined ? {} : { intentVersion },
            },
          }
        } catch (error: unknown) {
          if (createdTask) {
            await ctx.workspaceTasks.cancelDispatchTask({
              workspaceId: String(workspace.id),
              taskId,
              reason: messageOf(error),
            }, signal, session).catch(() => false)
          }
          throw error
        }
      }

      if (action === 'append') {
        const text = requiredText(args.text, 'text', action)
        const target = await appendTargetOf(controller, workspace, args.session, signal)
        const sessionId = String(target.sessionId)
        const model = modelChoiceOf(args)
        await applySessionModel(controller, sessionId, model)
        const taskId = await associateDeliveryTask(ctx, workspace, args.taskId, sessionId, session, signal)
        const delivery = decideDelivery(requestedDelivery, target.running)
        const admitted = await admit(controller, sessionId, delivery.used, text, action, signal)
        return {
          workspace: String(workspace.id),
          delivery: deliveryOf(sessionId, requestedDelivery, delivery, target.running, admitted, taskId),
        }
      }

      if (action === 'prompt') {
        const text = requiredText(args.text, 'text', action)
        const sessionId = requiredText(args.sessionId, 'sessionId', action).trim()
        const target = await listedSessionOf(controller, workspace, sessionId, signal)
        const model = modelChoiceOf(args)
        await applySessionModel(controller, sessionId, model)
        const taskId = await associateDeliveryTask(ctx, workspace, args.taskId, sessionId, session, signal)
        const delivery = decideDelivery(requestedDelivery, target.running)
        const admitted = await admit(controller, sessionId, delivery.used, text, action, signal)
        return {
          workspace: String(workspace.id),
          delivery: deliveryOf(sessionId, requestedDelivery, delivery, target.running, admitted, taskId),
        }
      }

      if (action === 'stop') {
        const sessionId = requiredText(args.sessionId, 'sessionId', action).trim()
        const target = await listedSessionOf(controller, workspace, sessionId, signal)
        if (!target.running) {
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
        if (!target.running) {
          throw new WorkspaceSessionError(
            `Session ${sessionId} is idle, so there is nothing to abort; use append or prompt to continue it`,
            'WORKSPACE_SESSION_INVALID',
          )
        }
        await cancelSession(controller, sessionId, 'abort')
        const delivery = decideDelivery('queue', false)
        const admitted = await admit(controller, sessionId, delivery.used, text, action, signal)
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
        return {
          workspace: String(workspace.id),
          forked: {
            sessionId: String(forked.sessionId),
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
 * Require the super agent for a lifecycle action.
 * @param agent - the calling agent, when one is attached.
 * @param action - lifecycle action being attempted.
 * @throws WorkspaceSessionError `WORKSPACE_SESSION_FORBIDDEN` for every other role.
 */
function requireLifecycleRole(agent: Agent | undefined, action: WorkspaceSessionAction): void {
  if (agent?.role === 'super') return
  throw new WorkspaceSessionError(
    `workspace_sessions.${action} requires the super agent role; an ordinary root or subagent may only `
    + 'list and read Sessions',
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
      require('title', args.title)
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
  if (args.delivery !== undefined && action !== 'append' && action !== 'prompt') {
    violations.push('delivery is accepted only by append and prompt')
  }
  if (args.atSeq !== undefined && action !== 'fork') {
    violations.push('atSeq is accepted only by fork')
  }
  if (args.provider !== undefined || args.model !== undefined || args.reasoning_effort !== undefined) {
    if (action !== 'start' && action !== 'append' && action !== 'prompt') {
      violations.push('provider, model, and reasoning_effort are accepted only by start, append, and prompt')
    }
  }
  const cardFields = ['intentId', 'intentVersion', 'acceptance', 'boundaries', 'outputForm', 'coverage', 'nonCoverage', 'taskType'] as const
  const namedCard = cardFields.some(field => args[field] !== undefined)
  const namedTask = args.taskId !== undefined && args.taskId.trim() !== ''
  if (namedCard && action !== 'start') {
    violations.push('intent card fields are accepted only by start; continue an existing Session with `taskId`')
  }
  if (args.taskId !== undefined && action !== 'start' && action !== 'append' && action !== 'prompt') {
    violations.push('taskId is accepted only by start, append, and prompt')
  }
  if (action === 'start' && namedCard && namedTask) {
    violations.push('taskId names an existing task; do not also pass intent card fields')
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
  taskId?: string,
): SessionDelivery {
  return {
    sessionId,
    requested,
    used: decision.used,
    accepted,
    wasRunning,
    ...(decision.fallback ? { fallback: true } : {}),
    ...taskId === undefined ? {} : { taskId },
  }
}

/**
 * Associate an `append`/`prompt` delivery with the task it names.
 *
 * The task reference is optional so a plain follow-up keeps the published
 * behavior; when one is named it must belong to the target Session, and an
 * unbound task is attached to it. The task was created (with its card and
 * coverage checks) before any Session consumed it.
 * @param ctx - context carrying the store.
 * @param workspace - workspace that owns the task and the Session.
 * @param taskIdArg - caller-supplied task id, when one was named.
 * @param sessionId - the Session receiving the delivery.
 * @param caller - the dispatching Session, for the store policy.
 * @param signal - cancellation for the store reads and writes.
 * @returns the task id, or undefined when the caller named none.
 * @throws WorkspaceSessionError when the task does not exist or belongs to another Session.
 */
async function associateDeliveryTask(
  ctx: Context,
  workspace: Workspace,
  taskIdArg: string | undefined,
  sessionId: string,
  caller: Session,
  signal: AbortSignal,
): Promise<string | undefined> {
  const taskId = taskIdArg?.trim()
  if (taskId === undefined || taskId === '') return undefined
  const stored = await readTask(ctx, workspace.id, taskId, signal)
  if (stored === undefined) {
    throw new WorkspaceSessionError(
      `workspace ${String(workspace.id)} holds no task ${JSON.stringify(taskId)}; create it with `
      + '`workspace_tasks.create` before continuing the Session',
      'WORKSPACE_SESSION_INVALID',
    )
  }
  const bound = stored.task.targetSessionId
  if (bound !== undefined && bound !== sessionId) {
    throw new WorkspaceSessionError(
      `task ${taskId} belongs to Session ${bound}, not ${sessionId}; a delivery is associated with its own task`,
      'WORKSPACE_SESSION_INVALID',
    )
  }
  if (bound === undefined) {
    await attachDispatchTaskSession(
      ctx,
      { workspaceId: String(workspace.id), taskId, sessionId },
      { session: caller, signal },
    )
  }
  return taskId
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
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const admitted = await controller.prompt({
      requestId: `workspace-session-${action}-${randomUUID()}`,
      sessionId,
      mode: used === 'interrupt' ? 'steer' : 'queue',
      content: [{ type: 'text', text }],
    }, signal)
    return admitted.accepted
  } catch (error: unknown) {
    throw new WorkspaceSessionError(`the instruction could not be admitted to Session ${sessionId}: ${messageOf(error)}`, 'WORKSPACE_SESSION_INVALID')
  }
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
 * Choose the Session an `append` continues. Without an explicit id or
 * `latest` the call refuses and names the candidates instead of guessing.
 * @param controller - host Session controller.
 * @param workspace - resolved workspace.
 * @param selector - the caller's `session` argument.
 * @param signal - cancellation for the list read.
 * @returns the chosen Session row.
 * @throws ToolArgsError when the selector is missing.
 * @throws WorkspaceRecordError when the workspace has no matching Session.
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
  if (value === undefined || value === '') {
    throw new ToolArgsError([
      'workspace_sessions with action "append" requires session: an id, or "latest"; candidates: '
      + candidates.map(item => String(item.sessionId)).join(', '),
    ])
  }
  if (value === 'latest') return first
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
 * Read the host token meter when the deployment mounts one.
 * @param ctx - context, or an Agent's own context, that may carry `tokenMeter`.
 * @returns the meter when it can measure context pressure.
 */
function tokenMeterOf(ctx: unknown): TokenMeterLike | undefined {
  const service = lookup(ctx, 'tokenMeter') as Partial<TokenMeterLike> | undefined
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
  const service = lookup(ctx, 'compaction') as Partial<CompactionLike> | undefined
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
  const service = lookup(ctx, 'agentPresets') as AgentPresetsLike | undefined
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
function lookup(ctx: unknown, key: string): unknown {
  const get = (ctx as { get?: (name: string) => unknown } | undefined)?.get
  if (typeof get !== 'function') return undefined
  return get.call(ctx, key)
}

/**
 * Read one Session's context usage. An absent field stays absent, because a
 * percentage without both measurements would be a misleading suggestion.
 * @param meter - host token meter, when mounted.
 * @param session - the Session to measure.
 * @returns the usage, or undefined when the host cannot measure it.
 */
function contextUsageOf(meter: TokenMeterLike | undefined, session: unknown): SessionContextUsage | undefined {
  if (meter === undefined || session === undefined) return undefined
  const { pressureTokens, contextWindow } = meter.contextPressure(session)
  if (pressureTokens === undefined || contextWindow === undefined || contextWindow <= 0) return undefined
  return {
    tokens: pressureTokens,
    window: contextWindow,
    percent: Math.min(100, Math.round(pressureTokens / contextWindow * 100)),
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
  const summaries: SessionSummary[] = []
  for (const record of records) {
    const id = String(record.header.id)
    const facts = await readSessionFacts(ctx, id, archived.has(id), signal)
    if (request.status !== undefined && facts.status !== request.status) continue
    const taskId = taskOf.get(id)
    summaries.push({
      sessionId: id,
      status: facts.status,
      currentTurn: facts.currentTurn,
      ...facts.currentActivity === undefined ? {} : { currentActivity: facts.currentActivity },
      ...facts.lastProgressAt === undefined ? {} : { lastProgressAt: facts.lastProgressAt },
      ...facts.latestProgress === undefined ? {} : { latestProgress: facts.latestProgress },
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
  const title = (await sessionTitles(ctx, [sessionId], signal)).get(sessionId)
  const taskId = activeTaskBySession(await listTasks(ctx, workspace.id, signal)).get(sessionId)
  const messages = await listMessages(ctx, workspace.id, signal)
  const pendingInbox = messages.filter(message => message.targetSessionId === sessionId && message.status === 'queued').length
  const artifacts = await listArtifacts(ctx, workspace.id, signal)
  const artifactCount = artifacts.filter(record => record.versions.some(reference => reference.sessionId === sessionId)).length
  return {
    sessionId,
    ...title === undefined ? {} : { title },
    status: facts.status,
    currentTurn: facts.currentTurn,
    ...facts.currentActivity === undefined ? {} : { currentActivity: facts.currentActivity },
    ...facts.lastProgressAt === undefined ? {} : { lastProgressAt: facts.lastProgressAt },
    ...facts.latestProgress === undefined ? {} : { latestProgress: facts.latestProgress },
    ...taskId === undefined ? {} : { taskId },
    recentProgress: facts.recentProgress,
    pendingInbox,
    artifactCount,
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
  return {
    status: archived ? 'done' : statusOf(live?.status, folded.lastEndReason),
    currentTurn: folded.currentTurn,
    ...folded.currentActivity === undefined ? {} : { currentActivity: folded.currentActivity },
    ...folded.lastProgressAt === undefined ? {} : { lastProgressAt: folded.lastProgressAt },
    ...folded.latestProgress === undefined ? {} : { latestProgress: folded.latestProgress },
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
      + ` · task ${started.taskId}`
      + (started.intentId === undefined ? '' : ` (intent ${started.intentId} v${String(started.intentVersion ?? '?')})`)
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
    + (delivery.taskId === undefined ? '' : ` · task ${delivery.taskId}`)
    + ` · ${delivery.used}${delivery.requested === delivery.used ? '' : ` (requested ${delivery.requested})`}`
    + (delivery.fallback === true ? ' · the Session was idle, so interrupt queued' : '')
    + ` · ${delivery.accepted ? 'accepted' : 'not accepted'}`
}
