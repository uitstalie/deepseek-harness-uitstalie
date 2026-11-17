/**
 * `workspace_intents`: workspace intent cards, their versions, and the
 * dispatch-alignment metrics derived from them.
 *
 * A card is one workspace's record of one user request. Every version keeps
 * the user's original words verbatim and annotates each goal, acceptance,
 * boundary, and output-form item with where it came from: the user's words, a
 * named workspace document, or the super agent's inference. An all-traceable
 * version is active immediately; a version with inferred items is proposed
 * until the user confirms it once. Corrections append a version and leave the
 * old one readable. The card is never memory and never a host-global record.
 * @module @deepseek-ai/dsh-workspace-tools/intents
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ObjectValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { WorkspaceIntentError, WorkspaceRecordError } from './errors.ts'
import {
  confirmationRequest,
  cardPoints,
  changedPointRefs,
  changedPointTexts,
  initialIntentStatus,
  normalizeIntentItems,
} from './intent-rules.ts'
import type { ConfirmationRequest } from './intent-rules.ts'
import {
  listIntentIndexes,
  readIntentIndex,
  readIntentVersion,
  updateIntentIndex,
  writeIntentIndex,
  writeIntentVersion,
} from './intent-store.ts'
import { pageOf } from './paging.ts'
import type {
  IntentIndex,
  IntentItem,
  IntentItemKind,
  IntentItems,
  IntentItemSource,
  IntentStatus,
  IntentVersionRecord,
  IntentVersionSummary,
  TaskType,
} from './records.ts'
import { INTENT_ITEM_KINDS, INTENT_ITEM_SOURCES, INTENT_STATUSES, TASK_TYPES } from './records.ts'
import { resolveWorkspace } from './scope.ts'
import { listTasks } from './store.ts'
import { oneLine, requireCallerSession } from './tooling.ts'

/** One card item as the tool returns it. */
export interface IntentItemView {
  /** Stable point identity, such as `acceptance[0]`. */
  readonly point: string
  /** Item text. */
  readonly text: string
  /** How the item was sourced. */
  readonly source: IntentItemSource
  /** Quoted document and heading for a `user-anchor` item. */
  readonly anchor?: { readonly path: string; readonly heading?: string }
  /** Why an `inference` item was inferred. */
  readonly reason?: string
  /** Instant the user confirmed this inferred item. */
  readonly confirmedAt?: string
  /** Identity that recorded the confirmation. */
  readonly confirmedBy?: string
}

/** One card version as `get` returns it. */
export interface IntentCardView {
  /** Stable card id inside the workspace. */
  readonly intentId: string
  /** Workspace that owns the card. */
  readonly workspaceId: string
  /** Version number. */
  readonly version: number
  /** Current state of this version. */
  readonly status: IntentStatus
  /** The user's original words, verbatim. */
  readonly rawUserText: string
  /** Source-annotated items, grouped by card part. */
  readonly items: {
    readonly goal: IntentItemView[]
    readonly acceptance: IntentItemView[]
    readonly boundaries: IntentItemView[]
    readonly outputForm: IntentItemView[]
  }
  /** Session where the user stated the request. */
  readonly sourceSessionId?: string
  /** Turn where the user stated the request. */
  readonly sourceTurn?: number
  /** ISO-8601 creation instant. */
  readonly createdAt: string
  /** Identity that created this version. */
  readonly author: string
  /** ISO-8601 instant the user confirmed the inferred items. */
  readonly confirmedAt?: string
  /** Identity that recorded the confirmation. */
  readonly confirmedBy?: string
  /** Version this one replaces, when it is a correction. */
  readonly supersedesVersion?: number
  /** Why the correction was made. */
  readonly reason?: string
  /** The user's correcting words, verbatim. */
  readonly correctionText?: string
  /** Latest version a task may reference; absent while no version is active. */
  readonly latestActiveVersion?: number
  /** One consolidated confirmation request, present while the version is proposed. */
  readonly confirmation?: ConfirmationRequest
  /** Rejection of this proposed version, when the user rejected it. */
  readonly rejection?: { readonly at: string; readonly by: string }
}

/** One version summary as `history` returns it. */
export interface IntentVersionView {
  /** Version number. */
  readonly version: number
  /** Current state. */
  readonly status: IntentStatus
  /** ISO-8601 creation instant. */
  readonly createdAt: string
  /** Identity that created this version. */
  readonly author: string
  /** ISO-8601 instant the user confirmed the inferred items. */
  readonly confirmedAt?: string
  /** Identity that recorded the confirmation. */
  readonly confirmedBy?: string
  /** Version this one replaces, when it is a correction. */
  readonly supersedesVersion?: number
  /** Why the correction was made. */
  readonly reason?: string
  /** Whether this version was appended by a user correction. */
  readonly correction?: boolean
  /** Card point texts that changed. */
  readonly changedPoints?: string[]
  /** Card point identities that changed. */
  readonly changedPointRefs?: string[]
  /** Six-category task type this version is attributed to. */
  readonly taskType?: TaskType
}

/** One rolling metrics window. */
export interface IntentMetricsWindow {
  /** Window length in days. */
  readonly days: number
  /** Tasks dispatched in the window. */
  readonly dispatchedTasks: number
  /** User corrections in the window. */
  readonly corrections: number
  /** Corrections divided by dispatched tasks; null when no task was dispatched. */
  readonly deviationRate: number | null
  /** Corrections whose point had been corrected before. */
  readonly recurringCorrections: number
  /** Recurring corrections divided by corrections; null when there were none. */
  readonly recurrenceRate: number | null
}

/** Metrics of one task type. */
export interface TaskTypeMetrics {
  /** Six-category task type. */
  readonly taskType: TaskType
  /** Windows computed for this type. */
  readonly windows: IntentMetricsWindow[]
}

/** Dispatch-alignment metrics of one workspace. */
export interface IntentMetrics {
  /** Whole-workspace windows, 7 and 30 days. */
  readonly windows: IntentMetricsWindow[]
  /** The same windows per task type with recorded activity. */
  readonly byTaskType: TaskTypeMetrics[]
}

/** One `workspace_intents` result value. */
export interface WorkspaceIntentsValue {
  /** Workspace the result belongs to. */
  readonly workspace: string
  /** Card the result addresses. */
  readonly intentId?: string
  /** Full card version. */
  readonly intent?: IntentCardView
  /** Paged version summaries. */
  readonly versions?: IntentVersionView[]
  /** Dispatch-alignment metrics. */
  readonly metrics?: IntentMetrics
  /** Cursor of the next page. */
  readonly nextCursor?: string
}

/** Window lengths metrics reports. */
const METRIC_WINDOWS: readonly number[] = [7, 30]

/**
 * Build `workspace_intents`.
 * @param ctx - context carrying the store, session-query, and registry.
 * @returns the tool definition.
 */
export function workspaceIntentsTool(ctx: Context): ToolDefinition {
  return defineTool({
    name: 'workspace_intents',
    description:
      'Create, read, confirm, and correct a workspace intent card: one record of what the user asked for, with '
      + 'each goal, acceptance, boundary, and output-form item annotated as the user\'s words, a named workspace '
      + 'document, or an inference. `create` computes the state from those annotations: all traceable means '
      + '`active`, any inference means `proposed` with one consolidated confirmation request. `confirm` records '
      + 'that confirmation; `correct` appends a version and supersedes the previous one. `history` lists versions '
      + 'and `metrics` summarizes dispatch alignment. Reads are open to every agent; `create`, `confirm`, and '
      + '`correct` require the super agent role or the user. The caller\'s workspace is the default scope.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['create', 'get', 'confirm', 'correct', 'history', 'metrics'],
        description: 'Action to run.',
      },
      workspace: {
        type: 'string',
        description: 'Registered workspace id; defaults to the caller\'s workspace. Reading another workspace is recorded.',
      },
      intentId: {
        type: 'string',
        description: 'Card id returned by `create`; required by `get`, `confirm`, `correct`, and `history`.',
      },
      version: {
        type: 'integer',
        description: 'Version to read for `get`, to confirm for `confirm`, or to correct for `correct`; defaults to the latest.',
      },
      requestId: {
        type: 'string',
        description: 'Idempotency key; required by `create`, `confirm`, and `correct`. A retry returns the first result.',
      },
      rawUserText: {
        type: 'string',
        description: 'The user\'s original request, verbatim. Required by `create` and stored unchanged; never paraphrase it.',
      },
      items: {
        type: 'object',
        additionalProperties: false,
        description: 'Card items grouped by part; required by `create` and `correct`. Quote the user\'s words for traceable items.',
        properties: {
          goal: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                text: { type: 'string', required: true, description: 'Item text; verbatim for `user-verbatim`.' },
                source: { type: 'string', required: true, enum: [...INTENT_ITEM_SOURCES] },
                anchor: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    path: { type: 'string', required: true, description: 'Workspace-relative document path.' },
                    heading: { type: 'string', description: 'Heading inside that document.' },
                  },
                },
                reason: { type: 'string', description: 'Why an `inference` item was inferred.' },
              },
            },
          },
          acceptance: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                text: { type: 'string', required: true },
                source: { type: 'string', required: true, enum: [...INTENT_ITEM_SOURCES] },
                anchor: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    path: { type: 'string', required: true },
                    heading: { type: 'string' },
                  },
                },
                reason: { type: 'string' },
              },
            },
          },
          boundaries: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                text: { type: 'string', required: true },
                source: { type: 'string', required: true, enum: [...INTENT_ITEM_SOURCES] },
                anchor: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    path: { type: 'string', required: true },
                    heading: { type: 'string' },
                  },
                },
                reason: { type: 'string' },
              },
            },
          },
          outputForm: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                text: { type: 'string', required: true },
                source: { type: 'string', required: true, enum: [...INTENT_ITEM_SOURCES] },
                anchor: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    path: { type: 'string', required: true },
                    heading: { type: 'string' },
                  },
                },
                reason: { type: 'string' },
              },
            },
          },
        },
      },
      sourceSessionId: {
        type: 'string',
        description: 'Session where the user stated the request; defaults to the calling session.',
      },
      sourceTurn: {
        type: 'integer',
        description: 'Turn where the user stated the request; defaults to the calling session\'s current turn.',
      },
      decision: {
        type: 'string',
        enum: ['confirm', 'reject'],
        description: '`confirm` activates a proposed version; `reject` leaves it proposed and dispatch stays blocked.',
      },
      note: {
        type: 'string',
        description: 'Optional note recorded with a confirmation or rejection.',
      },
      reason: {
        type: 'string',
        description: 'Why the correction was made; required by `correct`.',
      },
      correctionText: {
        type: 'string',
        description: 'The user\'s correcting words, verbatim, when the correction came from the user.',
      },
      taskId: {
        type: 'string',
        description: 'Task the correction is attributed to; its task type feeds the metrics.',
      },
      taskType: {
        type: 'string',
        enum: [...TASK_TYPES],
        description: 'Six-category task type to attribute the correction to, when no task is named.',
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
          intentId: { type: 'string' },
          intent: {
            type: 'object',
            additionalProperties: false,
            properties: {
              intentId: { type: 'string', required: true },
              workspaceId: { type: 'string', required: true },
              version: { type: 'integer', required: true },
              status: { type: 'string', required: true, enum: [...INTENT_STATUSES] },
              rawUserText: { type: 'string', required: true },
              items: {
                type: 'object',
                required: true,
                additionalProperties: false,
                properties: {
                  goal: { type: 'array', required: true, items: itemViewSchema },
                  acceptance: { type: 'array', required: true, items: itemViewSchema },
                  boundaries: { type: 'array', required: true, items: itemViewSchema },
                  outputForm: { type: 'array', required: true, items: itemViewSchema },
                },
              },
              sourceSessionId: { type: 'string' },
              sourceTurn: { type: 'integer' },
              createdAt: { type: 'string', required: true },
              author: { type: 'string', required: true },
              confirmedAt: { type: 'string' },
              confirmedBy: { type: 'string' },
              supersedesVersion: { type: 'integer' },
              reason: { type: 'string' },
              correctionText: { type: 'string' },
              latestActiveVersion: { type: 'integer' },
              confirmation: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  requestId: { type: 'string', required: true },
                  items: {
                    type: 'array',
                    required: true,
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        point: { type: 'string', required: true },
                        text: { type: 'string', required: true },
                        reason: { type: 'string', required: true },
                      },
                    },
                  },
                },
              },
              rejection: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  at: { type: 'string', required: true },
                  by: { type: 'string', required: true },
                },
              },
            },
          },
          versions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                version: { type: 'integer', required: true },
                status: { type: 'string', required: true, enum: [...INTENT_STATUSES] },
                createdAt: { type: 'string', required: true },
                author: { type: 'string', required: true },
                confirmedAt: { type: 'string' },
                confirmedBy: { type: 'string' },
                supersedesVersion: { type: 'integer' },
                reason: { type: 'string' },
                correction: { type: 'boolean' },
                changedPoints: { type: 'array', items: { type: 'string' } },
                changedPointRefs: { type: 'array', items: { type: 'string' } },
                taskType: { type: 'string', enum: [...TASK_TYPES] },
              },
            },
          },
          metrics: {
            type: 'object',
            additionalProperties: false,
            properties: {
              windows: { type: 'array', required: true, items: metricsWindowSchema },
              byTaskType: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    taskType: { type: 'string', required: true, enum: [...TASK_TYPES] },
                    windows: { type: 'array', required: true, items: metricsWindowSchema },
                  },
                },
              },
            },
          },
          nextCursor: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderIntents(value) }],
    },
    async execute(args, exec) {
      const session = requireCallerSession(exec.agent?.session, 'workspace_intents')
      const scope = await resolveWorkspace(ctx, session, `intents.${args.action}`, args.workspace)
      switch (args.action) {
        case 'create':
          return await createIntent(ctx, scope.workspace, args, exec.agent, session, exec.signal)
        case 'get':
          return await getIntent(ctx, scope.workspace, args, exec.signal)
        case 'confirm':
          return await confirmIntent(ctx, scope.workspace, args, exec.agent, session, exec.signal)
        case 'correct':
          return await correctIntent(ctx, scope.workspace, args, exec.agent, session, exec.signal)
        case 'history':
          return await historyIntent(ctx, scope.workspace, args, exec.signal)
        case 'metrics':
          return await intentMetrics(ctx, scope.workspace, exec.signal)
        default:
          throw new WorkspaceIntentError(`unknown workspace_intents action ${JSON.stringify(String(args.action))}`, 'INTENT_INVALID')
      }
    },
  })
}

/** Output schema of one item view. */
const itemViewSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    point: { type: 'string', required: true },
    text: { type: 'string', required: true },
    source: { type: 'string', required: true, enum: [...INTENT_ITEM_SOURCES] },
    anchor: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', required: true },
        heading: { type: 'string' },
      },
    },
    reason: { type: 'string' },
    confirmedAt: { type: 'string' },
    confirmedBy: { type: 'string' },
  },
} as const satisfies ObjectValueSchemaSpec

/** Output schema of one metrics window. */
const metricsWindowSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    days: { type: 'integer', required: true },
    dispatchedTasks: { type: 'integer', required: true },
    corrections: { type: 'integer', required: true },
    deviationRate: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
    recurringCorrections: { type: 'integer', required: true },
    recurrenceRate: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
  },
} as const satisfies ObjectValueSchemaSpec

/** Caller-supplied items; every part defaults to an empty list. */
type IntentItemsInput = { readonly [K in IntentItemKind]?: readonly IntentItem[] }

/** Caller-supplied create arguments after schema validation. */
interface CreateArgs {
  readonly workspace?: string
  readonly requestId?: string
  readonly rawUserText?: string
  readonly items?: IntentItemsInput
  readonly sourceSessionId?: string
  readonly sourceTurn?: number
}

/** Caller-supplied confirm arguments after schema validation. */
interface ConfirmArgs {
  readonly intentId?: string
  readonly version?: number
  readonly decision?: 'confirm' | 'reject'
  readonly note?: string
  readonly requestId?: string
}

/** Caller-supplied correct arguments after schema validation. */
interface CorrectArgs {
  readonly intentId?: string
  readonly version?: number
  readonly items?: IntentItemsInput
  readonly reason?: string
  readonly correctionText?: string
  readonly taskId?: string
  readonly taskType?: TaskType
  readonly requestId?: string
}

/** Caller-supplied read arguments after schema validation. */
interface ReadArgs {
  readonly intentId?: string
  readonly version?: number
  readonly cursor?: string
  readonly limit?: number
}

/**
 * Create the first version of one card.
 *
 * The id is derived from the workspace and the user's words, so creating the
 * same request again reuses the card instead of duplicating it. The state is
 * computed from the source annotations, and a proposed version returns the one
 * consolidated confirmation request.
 * @param ctx - context carrying the store and session-query.
 * @param workspace - workspace that owns the card.
 * @param args - create arguments.
 * @param agent - calling agent, when the call has one.
 * @param session - calling session.
 * @param signal - cancellation for the store reads and writes.
 * @returns the created or reused card.
 */
async function createIntent(
  ctx: Context,
  workspace: Workspace,
  args: CreateArgs,
  agent: Agent | undefined,
  session: Session,
  signal: AbortSignal | undefined,
): Promise<WorkspaceIntentsValue> {
  const role = agent?.role
  if (role !== undefined && role !== 'super') {
    throw new WorkspaceIntentError(
      'workspace_intents.create requires the super agent role or the user; ordinary agents read cards only',
      'INTENT_PERMISSION_DENIED',
    )
  }
  const requestId = requiredText(args.requestId, 'requestId', 'create')
  const rawUserText = requiredText(args.rawUserText, 'rawUserText', 'create')
  if (args.items === undefined) {
    throw new WorkspaceIntentError('workspace_intents.create requires items', 'INTENT_INVALID')
  }
  const items = normalizeIntentItems(rawUserText, itemsOf(args.items))
  const intentId = intentIdFor(workspace.id, rawUserText)
  const existing = await readIntentIndex(ctx, workspace.id, intentId, signal)
  if (existing !== undefined) {
    return await cardValue(ctx, workspace, existing.index, existing.index.versions.at(-1)?.version, signal)
  }
  const status = initialIntentStatus(items)
  const now = new Date().toISOString()
  const author = callerIdentity(agent, session)
  const sourceTurn = args.sourceTurn ?? await currentTurnOf(ctx, session, signal)
  const record: IntentVersionRecord = {
    intentId,
    workspaceId: String(workspace.id),
    version: 1,
    status,
    rawUserText,
    items,
    ...args.sourceSessionId === undefined ? { sourceSessionId: String(session.id) } : { sourceSessionId: args.sourceSessionId },
    ...sourceTurn === undefined ? {} : { sourceTurn },
    createdAt: now,
    author,
    requestId,
  }
  const summary: IntentVersionSummary = {
    version: 1,
    status,
    createdAt: now,
    author,
    requestId,
  }
  const index: IntentIndex = {
    intentId,
    workspaceId: String(workspace.id),
    createdAt: now,
    latestVersion: 1,
    ...status === 'active' ? { latestActiveVersion: 1 } : {},
    versions: [summary],
  }
  await writeIntentVersion(ctx, record)
  await writeIntentIndex(ctx, index)
  return await cardValue(ctx, workspace, index, 1, signal)
}

/**
 * Read one card version, defaulting to the latest.
 * @param ctx - context carrying the store.
 * @param workspace - workspace that owns the card.
 * @param args - read arguments.
 * @param signal - cancellation for the store reads.
 * @returns the requested card version.
 */
async function getIntent(
  ctx: Context,
  workspace: Workspace,
  args: ReadArgs,
  signal: AbortSignal | undefined,
): Promise<WorkspaceIntentsValue> {
  const intentId = requiredText(args.intentId, 'intentId', 'get')
  const stored = await readIntentIndex(ctx, workspace.id, intentId, signal)
  if (stored === undefined) {
    throw new WorkspaceRecordError(
      `workspace ${String(workspace.id)} holds no intent card ${JSON.stringify(intentId)}`,
      'WORKSPACE_RECORD_NOT_FOUND',
    )
  }
  const version = args.version ?? stored.index.latestVersion
  if (!stored.index.versions.some(candidate => candidate.version === version)) {
    throw new WorkspaceRecordError(
      `intent card ${JSON.stringify(intentId)} holds no version ${String(version)}`,
      'WORKSPACE_RECORD_NOT_FOUND',
    )
  }
  return await cardValue(ctx, workspace, stored.index, version, signal)
}

/**
 * Record the user's confirmation or rejection of one proposed version.
 * @param ctx - context carrying the store.
 * @param workspace - workspace that owns the card.
 * @param args - confirm arguments.
 * @param agent - calling agent.
 * @param session - calling session.
 * @param signal - cancellation for the store reads and writes.
 * @returns the updated card version.
 */
async function confirmIntent(
  ctx: Context,
  workspace: Workspace,
  args: ConfirmArgs,
  agent: Agent | undefined,
  session: Session,
  signal: AbortSignal | undefined,
): Promise<WorkspaceIntentsValue> {
  const role = agent?.role
  if (role !== undefined && role !== 'super') {
    throw new WorkspaceIntentError(
      'workspace_intents.confirm requires the super agent role or the user; ordinary agents read cards only',
      'INTENT_PERMISSION_DENIED',
    )
  }
  const intentId = requiredText(args.intentId, 'intentId', 'confirm')
  const version = requiredVersion(args.version, 'confirm')
  const decision = args.decision
  if (decision !== 'confirm' && decision !== 'reject') {
    throw new WorkspaceIntentError('workspace_intents.confirm requires decision "confirm" or "reject"', 'INTENT_INVALID')
  }
  requiredText(args.requestId, 'requestId', 'confirm')
  const stored = await readIntentIndex(ctx, workspace.id, intentId, signal)
  if (stored === undefined) {
    throw new WorkspaceRecordError(
      `workspace ${String(workspace.id)} holds no intent card ${JSON.stringify(intentId)}`,
      'WORKSPACE_RECORD_NOT_FOUND',
    )
  }
  const summary = stored.index.versions.find(candidate => candidate.version === version)
  if (summary === undefined) {
    throw new WorkspaceRecordError(
      `intent card ${JSON.stringify(intentId)} holds no version ${String(version)}`,
      'WORKSPACE_RECORD_NOT_FOUND',
    )
  }
  if (summary.status === 'superseded') {
    throw new WorkspaceIntentError(
      `intent card ${intentId} v${String(version)} is superseded; read the latest version and confirm that one`,
      'INTENT_STALE',
    )
  }
  if (summary.status === 'active') {
    if (decision === 'reject') {
      throw new WorkspaceIntentError(`intent card ${intentId} v${String(version)} is already active and cannot be rejected`, 'INTENT_INVALID')
    }
    return await cardValue(ctx, workspace, stored.index, version, signal)
  }
  const storedVersion = await readIntentVersion(ctx, workspace.id, intentId, version, signal)
  if (storedVersion === undefined) {
    throw new WorkspaceRecordError(
      `intent card ${intentId} v${String(version)} has no stored version`,
      'WORKSPACE_RECORD_CORRUPT',
    )
  }
  const inferredPoints = cardPoints(storedVersion.record.items)
    .filter(({ item }) => item.source === 'inference')
    .map(({ point }) => point)
  const now = new Date().toISOString()
  const identity = callerIdentity(agent, session)
  const next = await updateIntentIndex(ctx, workspace.id, intentId, (current) => {
    const versions = current.versions.map((candidate) => {
      if (candidate.version !== version) {
        return candidate.status === 'active' ? { ...candidate, status: 'superseded' as const } : candidate
      }
      if (decision === 'confirm') {
        return {
          ...candidate,
          status: 'active' as const,
          confirmedAt: now,
          confirmedBy: identity,
          confirmedPoints: inferredPoints,
        }
      }
      return { ...candidate, rejectedAt: now, rejectedBy: identity }
    })
    return {
      ...current,
      ...decision === 'confirm' ? { latestActiveVersion: version } : {},
      versions,
    }
  }, signal)
  return await cardValue(ctx, workspace, next, version, signal)
}

/**
 * Append one correction version and supersede the previous one.
 * @param ctx - context carrying the store.
 * @param workspace - workspace that owns the card.
 * @param args - correct arguments.
 * @param agent - calling agent.
 * @param session - calling session.
 * @param signal - cancellation for the store reads and writes.
 * @returns the new card version.
 */
async function correctIntent(
  ctx: Context,
  workspace: Workspace,
  args: CorrectArgs,
  agent: Agent | undefined,
  session: Session,
  signal: AbortSignal | undefined,
): Promise<WorkspaceIntentsValue> {
  const role = agent?.role
  if (role !== undefined && role !== 'super') {
    throw new WorkspaceIntentError(
      'workspace_intents.correct requires the super agent role or the user; ordinary agents read cards only',
      'INTENT_PERMISSION_DENIED',
    )
  }
  const intentId = requiredText(args.intentId, 'intentId', 'correct')
  const requestId = requiredText(args.requestId, 'requestId', 'correct')
  const reason = requiredText(args.reason, 'reason', 'correct')
  if (args.items === undefined) {
    throw new WorkspaceIntentError('workspace_intents.correct requires items', 'INTENT_INVALID')
  }
  const stored = await readIntentIndex(ctx, workspace.id, intentId, signal)
  if (stored === undefined) {
    throw new WorkspaceRecordError(
      `workspace ${String(workspace.id)} holds no intent card ${JSON.stringify(intentId)}`,
      'WORKSPACE_RECORD_NOT_FOUND',
    )
  }
  const duplicate = stored.index.versions.find(candidate => candidate.requestId === requestId)
  if (duplicate !== undefined) {
    return await cardValue(ctx, workspace, stored.index, duplicate.version, signal)
  }
  const targetVersion = args.version ?? stored.index.latestVersion
  if (targetVersion !== stored.index.latestVersion) {
    throw new WorkspaceIntentError(
      `intent card ${intentId} v${String(targetVersion)} is stale; the latest version is ${String(stored.index.latestVersion)}`,
      'INTENT_STALE',
    )
  }
  const base = await readIntentVersion(ctx, workspace.id, intentId, targetVersion, signal)
  if (base === undefined) {
    throw new WorkspaceRecordError(
      `intent card ${intentId} v${String(targetVersion)} has no stored version`,
      'WORKSPACE_RECORD_CORRUPT',
    )
  }
  const items = normalizeIntentItems(base.record.rawUserText, itemsOf(args.items))
  const status = initialIntentStatus(items)
  const version = stored.index.latestVersion + 1
  const now = new Date().toISOString()
  const author = callerIdentity(agent, session)
  const changedPoints = changedPointTexts(base.record.items, items)
  const changedRefs = changedPointRefs(base.record.items, items)
  const taskType = await attributeTaskType(ctx, workspace, args, intentId, base.record.taskType, signal)
  const record: IntentVersionRecord = {
    intentId,
    workspaceId: String(workspace.id),
    version,
    status,
    rawUserText: base.record.rawUserText,
    items,
    ...base.record.sourceSessionId === undefined ? {} : { sourceSessionId: base.record.sourceSessionId },
    ...base.record.sourceTurn === undefined ? {} : { sourceTurn: base.record.sourceTurn },
    createdAt: now,
    author,
    supersedesVersion: targetVersion,
    reason,
    ...args.correctionText === undefined ? {} : { correctionText: args.correctionText },
    ...changedPoints.length === 0 ? {} : { changedPoints },
    ...changedRefs.length === 0 ? {} : { changedPointRefs: changedRefs },
    ...taskType === undefined ? {} : { taskType },
    requestId,
  }
  const summary: IntentVersionSummary = {
    version,
    status,
    createdAt: now,
    author,
    requestId,
    supersedesVersion: targetVersion,
    reason,
    correction: true,
    ...changedPoints.length === 0 ? {} : { changedPoints },
    ...changedRefs.length === 0 ? {} : { changedPointRefs: changedRefs },
    ...taskType === undefined ? {} : { taskType },
  }
  await writeIntentVersion(ctx, record)
  const next = await updateIntentIndex(ctx, workspace.id, intentId, current => ({
    ...current,
    latestVersion: version,
    ...status === 'active' ? { latestActiveVersion: version } : { latestActiveVersion: undefined },
    versions: [
      ...current.versions.map(candidate =>
        candidate.status === 'active' || candidate.status === 'proposed'
          ? { ...candidate, status: 'superseded' as const }
          : candidate),
      summary,
    ],
  }), signal)
  return await cardValue(ctx, workspace, next, version, signal)
}

/**
 * Page one card's version history, newest first.
 * @param ctx - context carrying the store.
 * @param workspace - workspace that owns the card.
 * @param args - read arguments.
 * @param signal - cancellation for the store reads.
 * @returns the page of version summaries.
 */
async function historyIntent(
  ctx: Context,
  workspace: Workspace,
  args: ReadArgs,
  signal: AbortSignal | undefined,
): Promise<WorkspaceIntentsValue> {
  const intentId = requiredText(args.intentId, 'intentId', 'history')
  const stored = await readIntentIndex(ctx, workspace.id, intentId, signal)
  if (stored === undefined) {
    throw new WorkspaceRecordError(
      `workspace ${String(workspace.id)} holds no intent card ${JSON.stringify(intentId)}`,
      'WORKSPACE_RECORD_NOT_FOUND',
    )
  }
  const ordered = [...stored.index.versions].sort((left, right) => right.version - left.version)
  const page = pageOf(ordered.map(versionView), args.limit, args.cursor)
  return {
    workspace: String(workspace.id),
    intentId,
    versions: page.items,
    ...page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor },
  }
}

/**
 * Compute dispatch-alignment metrics from the stored tasks and corrections.
 * @param ctx - context carrying the store.
 * @param workspace - workspace whose metrics are computed.
 * @param signal - cancellation for the store reads.
 * @returns the workspace and per-type windows.
 */
async function intentMetrics(
  ctx: Context,
  workspace: Workspace,
  signal: AbortSignal | undefined,
): Promise<WorkspaceIntentsValue> {
  const [tasks, indexes] = await Promise.all([
    listTasks(ctx, workspace.id, signal),
    listIntentIndexes(ctx, workspace.id, signal),
  ])
  const now = Date.now()
  const corrections = indexes.flatMap(index =>
    index.versions
      .filter(version => version.correction === true)
      .map(version => ({
        at: Date.parse(version.createdAt),
        taskType: version.taskType ?? 'other',
        changedPoints: version.changedPoints ?? [],
        changedPointRefs: version.changedPointRefs ?? [],
      })))
    .sort((left, right) => left.at - right.at)
  const taskTypes = TASK_TYPES.filter(type =>
    tasks.some(task => (task.taskType ?? 'other') === type)
    || corrections.some(correction => correction.taskType === type))
  return {
    workspace: String(workspace.id),
    metrics: {
      windows: METRIC_WINDOWS.map(days => metricsWindow(days, now, tasks, corrections)),
      byTaskType: taskTypes.map(taskType => ({
        taskType,
        windows: METRIC_WINDOWS.map(days => metricsWindow(
          days,
          now,
          tasks.filter(task => (task.taskType ?? 'other') === taskType),
          corrections.filter(correction => correction.taskType === taskType),
        )),
      })),
    },
  }
}

/** One correction observation folded into metrics. */
interface CorrectionObservation {
  /** Parseable creation instant in milliseconds. */
  readonly at: number
  /** Six-category task type the correction is attributed to. */
  readonly taskType: TaskType
  /** Card point texts that changed. */
  readonly changedPoints: string[]
  /** Card point identities that changed. */
  readonly changedPointRefs?: string[]
}

/**
 * Compute one rolling window.
 * @param days - window length in days.
 * @param now - current instant in milliseconds.
 * @param tasks - workspace tasks.
 * @param corrections - every correction, oldest first.
 * @returns the window counts and rates.
 */
function metricsWindow(
  days: number,
  now: number,
  tasks: readonly { readonly createdAt: string }[],
  corrections: readonly CorrectionObservation[],
): IntentMetricsWindow {
  const from = now - days * 24 * 60 * 60 * 1000
  const dispatched = tasks.filter((task) => {
    const at = Date.parse(task.createdAt)
    return Number.isFinite(at) && at >= from && at <= now
  }).length
  const inWindow = corrections.filter(correction => correction.at >= from && correction.at <= now)
  let recurring = 0
  for (const correction of inWindow) {
    const earlier = corrections.filter(candidate => candidate.at < correction.at)
    const refs = correction.changedPointRefs ?? correction.changedPoints
    if (refs.some(ref => earlier.some(candidate => (candidate.changedPointRefs ?? candidate.changedPoints).includes(ref)))) {
      recurring += 1
    }
  }
  return {
    days,
    dispatchedTasks: dispatched,
    corrections: inWindow.length,
    deviationRate: dispatched === 0 ? null : inWindow.length / dispatched,
    recurringCorrections: recurring,
    recurrenceRate: inWindow.length === 0 ? null : recurring / inWindow.length,
  }
}

/**
 * Build the returned value for one card version.
 * @param ctx - context carrying the store.
 * @param workspace - workspace that owns the card.
 * @param index - card index.
 * @param version - version to return; undefined means the latest.
 * @param signal - cancellation for the store read.
 * @returns the card value.
 */
async function cardValue(
  ctx: Context,
  workspace: Workspace,
  index: IntentIndex,
  version: number | undefined,
  signal: AbortSignal | undefined,
): Promise<WorkspaceIntentsValue> {
  const selected = version ?? index.latestVersion
  const summary = index.versions.find(candidate => candidate.version === selected)
  if (summary === undefined) {
    throw new WorkspaceRecordError(
      `intent card ${JSON.stringify(index.intentId)} holds no version ${String(selected)}`,
      'WORKSPACE_RECORD_NOT_FOUND',
    )
  }
  const stored = await readIntentVersion(ctx, workspace.id, index.intentId, selected, signal)
  if (stored === undefined) {
    throw new WorkspaceRecordError(
      `intent card ${JSON.stringify(index.intentId)} v${String(selected)} has no stored version`,
      'WORKSPACE_RECORD_CORRUPT',
    )
  }
  const record = stored.record
  const confirmation = summary.status === 'proposed'
    ? confirmationRequest(index.intentId, selected, record.items)
    : undefined
  const view: IntentCardView = {
    intentId: record.intentId,
    workspaceId: record.workspaceId,
    version: record.version,
    status: summary.status,
    rawUserText: record.rawUserText,
    items: itemsView(record.items, summary),
    ...record.sourceSessionId === undefined ? {} : { sourceSessionId: record.sourceSessionId },
    ...record.sourceTurn === undefined ? {} : { sourceTurn: record.sourceTurn },
    createdAt: record.createdAt,
    author: record.author,
    ...summary.confirmedAt === undefined ? {} : { confirmedAt: summary.confirmedAt },
    ...summary.confirmedBy === undefined ? {} : { confirmedBy: summary.confirmedBy },
    ...record.supersedesVersion === undefined ? {} : { supersedesVersion: record.supersedesVersion },
    ...record.reason === undefined ? {} : { reason: record.reason },
    ...record.correctionText === undefined ? {} : { correctionText: record.correctionText },
    ...index.latestActiveVersion === undefined ? {} : { latestActiveVersion: index.latestActiveVersion },
    ...confirmation === undefined ? {} : { confirmation },
    ...summary.rejectedAt === undefined || summary.rejectedBy === undefined
      ? {}
      : { rejection: { at: summary.rejectedAt, by: summary.rejectedBy } },
  }
  return { workspace: String(workspace.id), intentId: index.intentId, intent: view }
}

/**
 * Project stored items with their point identities and confirmation instants.
 * @param items - stored items.
 * @param summary - version summary that carries confirmations.
 * @returns the item view grouped by part.
 */
function itemsView(
  items: IntentItems,
  summary: IntentVersionSummary,
): IntentCardView['items'] {
  const confirmed = new Set(summary.confirmedPoints ?? [])
  const group = (kind: IntentItemKind): IntentItemView[] => items[kind].map((item, index) => {
    const point = `${kind}[${String(index)}]`
    return {
      point,
      text: item.text,
      source: item.source,
      ...item.anchor === undefined ? {} : {
        anchor: {
          path: item.anchor.path,
          ...item.anchor.heading === undefined ? {} : { heading: item.anchor.heading },
        },
      },
      ...item.reason === undefined ? {} : { reason: item.reason },
      ...!confirmed.has(point) || summary.confirmedAt === undefined
        ? {}
        : {
          confirmedAt: summary.confirmedAt,
          ...summary.confirmedBy === undefined ? {} : { confirmedBy: summary.confirmedBy },
        },
    }
  })
  return {
    goal: group('goal'),
    acceptance: group('acceptance'),
    boundaries: group('boundaries'),
    outputForm: group('outputForm'),
  }
}

/**
 * Project one version summary for `history`.
 * @param summary - stored summary.
 * @returns the history row.
 */
function versionView(summary: IntentVersionSummary): IntentVersionView {
  return {
    version: summary.version,
    status: summary.status,
    createdAt: summary.createdAt,
    author: summary.author,
    ...summary.confirmedAt === undefined ? {} : { confirmedAt: summary.confirmedAt },
    ...summary.confirmedBy === undefined ? {} : { confirmedBy: summary.confirmedBy },
    ...summary.supersedesVersion === undefined ? {} : { supersedesVersion: summary.supersedesVersion },
    ...summary.reason === undefined ? {} : { reason: summary.reason },
    ...summary.correction === undefined ? {} : { correction: summary.correction },
    ...summary.changedPoints === undefined ? {} : { changedPoints: [...summary.changedPoints] },
    ...summary.changedPointRefs === undefined ? {} : { changedPointRefs: [...summary.changedPointRefs] },
    ...summary.taskType === undefined ? {} : { taskType: summary.taskType },
  }
}

/**
 * Stable card id from the workspace and the user's words.
 * @param workspaceId - workspace that owns the card.
 * @param rawUserText - the user's original words.
 * @returns the stable id.
 */
export function intentIdFor(workspaceId: Workspace['id'], rawUserText: string): string {
  const digest = createHash('sha256').update(`${String(workspaceId)}\n${rawUserText}`).digest('hex')
  return `intent-${digest.slice(0, 16)}`
}

/**
 * Identity recorded as an author or confirmer.
 * @param agent - calling agent, when the call has one.
 * @param session - calling session.
 * @returns `user` for an agentless call, else the agent and session identity.
 */
function callerIdentity(agent: Agent | undefined, session: Session): string {
  return agent === undefined ? 'user' : `agent:${String(session.id)}`
}

/**
 * Latest turn number recorded in the calling session.
 * @param ctx - context carrying session-query.
 * @param session - calling session.
 * @param signal - cancellation for the observation.
 * @returns the current turn number, or undefined before any turn.
 */
async function currentTurnOf(ctx: Context, session: Session, signal: AbortSignal | undefined): Promise<number | undefined> {
  using observation = await ctx.sessionQuery.observeSession(session.id, {
    projectionMode: 'none',
    ...signal === undefined ? {} : { signal },
  })
  let turn: number | undefined
  for (const event of observation.events) {
    if (event.type === 'turn/start') turn = event.data.turn
  }
  return turn
}

/**
 * Resolve the task type a correction is attributed to.
 * @param ctx - context carrying the store.
 * @param workspace - workspace that owns the card.
 * @param args - correct arguments.
 * @param intentId - card identity.
 * @param fallback - task type recorded on the previous version.
 * @param signal - cancellation for the store reads.
 * @returns the task type, when one is known.
 */
async function attributeTaskType(
  ctx: Context,
  workspace: Workspace,
  args: CorrectArgs,
  intentId: string,
  fallback: TaskType | undefined,
  signal: AbortSignal | undefined,
): Promise<TaskType | undefined> {
  if (args.taskType !== undefined) return args.taskType
  if (args.taskId !== undefined) {
    const tasks = await listTasks(ctx, workspace.id, signal)
    return tasks.find(task => task.taskId === args.taskId)?.taskType
  }
  if (fallback !== undefined) return fallback
  const tasks = await listTasks(ctx, workspace.id, signal)
  return tasks
    .filter(task => task.intentId === intentId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]?.taskType
}

/**
 * Fill absent item parts with empty lists.
 * @param items - caller-supplied item parts.
 * @returns a complete item set.
 */
function itemsOf(items: IntentItemsInput): IntentItems {
  return {
    goal: [...items.goal ?? []],
    acceptance: [...items.acceptance ?? []],
    boundaries: [...items.boundaries ?? []],
    outputForm: [...items.outputForm ?? []],
  }
}

/**
 * Require one non-empty string argument.
 * @param value - caller-supplied value.
 * @param field - field name for the failure message.
 * @param action - action name for the failure message.
 * @returns the non-empty value.
 */
function requiredText(value: string | undefined, field: string, action: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new WorkspaceIntentError(`workspace_intents.${action} requires ${field}`, 'INTENT_INVALID')
  }
  return value
}

/**
 * Require one positive integer argument.
 * @param value - caller-supplied value.
 * @param action - action name for the failure message.
 * @returns the positive version.
 */
function requiredVersion(value: number | undefined, action: string): number {
  if (value === undefined || !Number.isInteger(value) || value < 1) {
    throw new WorkspaceIntentError(`workspace_intents.${action} requires a positive version`, 'INTENT_INVALID')
  }
  return value
}

/**
 * Render one intents value for the model.
 * @param value - the tool result.
 * @returns the model-facing text.
 */
function renderIntents(value: WorkspaceIntentsValue): string {
  const intent = value.intent
  if (intent !== undefined) {
    const lines = [
      `${intent.intentId} v${String(intent.version)} · ${intent.status}`
      + (intent.latestActiveVersion === undefined ? '' : ` · latest active v${String(intent.latestActiveVersion)}`),
    ]
    for (const kind of INTENT_ITEM_KINDS) {
      const items = intent.items[kind]
      if (items.length === 0) continue
      lines.push(`${kind}: ${items.map(item =>
        `${item.point} [${item.source}] ${oneLine(item.text, 180)}`).join('; ')}`)
    }
    lines.push(`Raw user text: ${oneLine(intent.rawUserText, 600)}`)
    if (intent.confirmation !== undefined) {
      lines.push(`Needs confirmation ${intent.confirmation.requestId}: ${intent.confirmation.items.map(item =>
        `${item.point} ${oneLine(item.text, 120)} (${oneLine(item.reason, 120)})`).join('; ')}`)
    }
    return lines.join('\n')
  }
  if (value.metrics !== undefined) {
    const lines = [value.metrics.windows.map(window =>
      `${String(window.days)}d: ${String(window.corrections)} corrections / ${String(window.dispatchedTasks)} tasks`
      + ` · deviation ${window.deviationRate === null ? 'n/a' : window.deviationRate.toFixed(3)}`
      + ` · recurrence ${window.recurrenceRate === null ? 'n/a' : window.recurrenceRate.toFixed(3)}`).join('\n')]
    if (value.metrics.byTaskType.length > 0) {
      lines.push(value.metrics.byTaskType.map(type =>
        `${type.taskType}: ${type.windows.map(window =>
          `${String(window.days)}d ${String(window.corrections)}/${String(window.dispatchedTasks)}`).join(', ')}`).join('\n'))
    }
    return lines.join('\n')
  }
  const versions = value.versions ?? []
  if (versions.length === 0) return `No versions of intent card ${value.intentId ?? ''} in workspace ${value.workspace}.`
  const lines = versions.map(version =>
    `- v${String(version.version)} · ${version.status} · ${version.createdAt}`
    + (version.correction === true ? ' · correction' : '')
    + (version.reason === undefined ? '' : ` · ${oneLine(version.reason, 160)}`))
  if (value.nextCursor !== undefined) lines.push(`(more versions: pass cursor ${value.nextCursor})`)
  return lines.join('\n')
}
