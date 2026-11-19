/**
 * `workspace_tasks`: dispatch tasks, the optional intent card a task may
 * reference, and the alignment checklist its receipt may carry.
 *
 * A task belongs to exactly one workspace. `create` records the brief directly,
 * or, when the caller supplies an active card version in the task's workspace,
 * validates it and requires a coverage mapping for every card point (or an
 * explicit non-coverage reason). `receipt` appends the post-execution alignment
 * when the task references a card, and the state machine refuses `done` while
 * any acceptance point is `not_satisfied` or any boundary is `violated`.
 * @module @deepseek-ai/dsh-workspace-tools/tasks
 */

import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ObjectValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { WorkspaceIntentError, WorkspaceRecordError, WorkspaceTaskError } from './errors.ts'
import { artifactView } from './artifacts.ts'
import type { ArtifactView } from './artifacts.ts'
import {
  checkAlignment,
  checkCoverage,
  confirmationRequest,
} from './intent-rules.ts'
import type { AlignmentCheck } from './intent-rules.ts'
import { readIntentIndex, readIntentVersion } from './intent-store.ts'
import { pageOf } from './paging.ts'
import type { Page } from './paging.ts'
import type {
  AcceptanceAlignmentStatus,
  ArtifactRecord,
  BoundaryAlignmentStatus,
  IntentIndex,
  IntentVersionRecord,
  OutputFormAlignmentStatus,
  TaskAlignment,
  TaskCoverage,
  TaskNonCoverage,
  TaskRecord,
  TaskStatus,
  TaskType,
} from './records.ts'
import { TASK_STATUSES, TASK_TYPES } from './records.ts'
import { resolveWorkspace, workspaceDirectory } from './scope.ts'
import { artifactVersion, listTasks, readArtifact, readTask, writeTask } from './store.ts'
import { oneLine, requireCallerSession } from './tooling.ts'

/** One reported outcome as the tool returns it. */
export interface TaskReceiptView {
  /** Stable receipt id inside the task. */
  readonly receiptId: string
  /** ISO-8601 instant the executor appended the receipt. */
  readonly at: string
  /** Reported or effective state. */
  readonly status: TaskStatus
  /** Optional one-line note. */
  readonly note?: string
  /** Idempotency key of the receipt call. */
  readonly requestId?: string
  /** Post-execution alignment recorded with the receipt. */
  readonly alignment?: TaskAlignment
}

/** One dispatch task as the `get` action returns it. */
export interface TaskView {
  /** Stable task id. */
  readonly taskId: string
  /** Workspace that owns the task. */
  readonly workspaceId: string
  /** Short human title. */
  readonly title: string
  /** What the task must achieve. */
  readonly goal: string
  /** Acceptance points the receipt is checked against. */
  readonly acceptance: string[]
  /** Boundaries the executor must respect. */
  readonly boundaries: string[]
  /** Expected deliverable items. */
  readonly outputForm?: string[]
  /** Current state. */
  readonly status: TaskStatus
  /** Assignee identity, when recorded. */
  readonly assignee?: string
  /** Session expected to execute the task. */
  readonly targetSessionId?: string
  /** Session that started the task; a task-bound cross-workspace return targets it. */
  readonly dispatcherSessionId?: string
  /** Intent card this task was dispatched against. */
  readonly intentId?: string
  /** Intent card version this task was dispatched against. */
  readonly intentVersion?: number
  /** Card points mapped to task-brief items at dispatch time. */
  readonly coverage?: { readonly point: string; readonly brief: string; readonly note?: string }[]
  /** Card points explicitly left uncovered. */
  readonly nonCoverage?: { readonly point: string; readonly reason: string }[]
  /** Six-category task type. */
  readonly taskType?: TaskType
  /** ISO-8601 creation instant. */
  readonly createdAt: string
  /** ISO-8601 instant of the last mutation. */
  readonly updatedAt: string
  /** Idempotency key of the create call. */
  readonly requestId: string
  /** One-line note recorded by the last update. */
  readonly note?: string
  /** Appended receipts in report order. */
  readonly receipts: TaskReceiptView[]
  /** Artifact ids published for this task. */
  readonly artifactIds: string[]
}

/** One task summary as the list action returns it. */
export interface TaskSummary {
  /** Stable task id. */
  readonly taskId: string
  /** Short human title. */
  readonly title: string
  /** Current state. */
  readonly status: TaskStatus
  /** Assignee identity, when recorded. */
  readonly assignee?: string
  /** Session expected to execute the task. */
  readonly targetSessionId?: string
  /** Session that started the task. */
  readonly dispatcherSessionId?: string
  /** ISO-8601 instant of the last mutation. */
  readonly updatedAt: string
  /** Instant of the newest receipt. */
  readonly latestReceiptAt?: string
}

/** One `workspace_tasks` result value. */
export interface WorkspaceTasksValue {
  /** Workspace the result belongs to. */
  readonly workspace: string
  /** Paged task summaries. */
  readonly items?: TaskSummary[]
  /** Full task returned by `get`. */
  readonly task?: TaskView
  /** Task id returned by `create`, `update`, or `receipt`. */
  readonly taskId?: string
  /** Task state after the call. */
  readonly status?: TaskStatus
  /** Session that started the task, when one was recorded. */
  readonly dispatcherSessionId?: string
  /** ISO-8601 creation instant returned by `create`. */
  readonly createdAt?: string
  /** Receipt appended by `receipt`. */
  readonly receipt?: TaskReceiptView
  /** Card points whose alignment blocked `done`. */
  readonly deviations?: string[]
  /** Whether an idempotent retry replayed an earlier result. */
  readonly replayed?: boolean
  /** Target session title, when the task names one. */
  readonly targetSession?: { readonly sessionId: string; readonly title?: string }
  /** Artifact references recorded for the task. */
  readonly artifacts?: ArtifactView[]
  /** Cursor of the next page. */
  readonly nextCursor?: string
}

/**
 * Build `workspace_tasks`.
 * @param ctx - context carrying the store, session-query, and registry.
 * @returns the tool definition.
 */
export function workspaceTasksTool(ctx: Context): ToolDefinition {
  return defineTool({
    name: 'workspace_tasks',
    description:
      'Create, read, and update dispatch tasks and their receipts. `create` needs only `workspace` and `goal`; '
      + '`acceptance`, `boundaries`, `taskType`, and `requestId` are optional — `taskType` defaults to `other`, an '
      + 'omitted `requestId` is generated (so omit it to create a new task per call, supply it to make a retry '
      + 'idempotent). When the caller supplies an active intent card version in the task\'s workspace, `create` also '
      + 'requires a coverage mapping for every card point (or an explicit non-coverage reason) and refuses a missing, '
      + 'proposed, or stale card. The card is optional: omit `intentId`/`intentVersion` to create a task without one. '
      + '`update` moves the task state and `receipt` appends the executor\'s alignment against the referenced card '
      + 'version, when the task has one. A receipt with an unsatisfied acceptance point or a violated boundary cannot '
      + 'move the task to `done`; it becomes `waiting_review` or `blocked` with the checklist. Reads are open to every '
      + 'agent. Mutations are open to an agent in the task\'s workspace; a cross-workspace mutation requires the '
      + 'super agent. `create` records the calling session as `dispatcherSessionId`, and a task-bound '
      + 'cross-workspace return from the target session to that dispatcher is the only cross-workspace message a '
      + 'task authorizes.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'get', 'create', 'update', 'receipt'],
        description: '`list` returns summaries; `get` returns one task; `create`, `update`, and `receipt` mutate.',
      },
      workspace: {
        type: 'string',
        description: 'Registered workspace id. `create` requires it; reads default to the caller\'s workspace.',
      },
      taskId: {
        type: 'string',
        description: 'Task to read or mutate; required by `get`, `update`, and `receipt`.',
      },
      status: {
        type: 'string',
        enum: [...TASK_STATUSES],
        description: 'Only list tasks in this state, or the state `update`/`receipt` moves the task to.',
      },
      assignee: {
        type: 'string',
        description: 'Only list tasks assigned to this identity, or the assignee `update` records.',
      },
      title: {
        type: 'string',
        description: 'Short task title; defaults to the goal\'s first line.',
      },
      goal: {
        type: 'string',
        description: 'What the task must achieve; required by `create`.',
      },
      acceptance: {
        type: 'array',
        items: { type: 'string' },
        description: 'Checkable acceptance points; optional, defaults to none. Mirrored by the coverage list when a card is used.',
      },
      boundaries: {
        type: 'array',
        items: { type: 'string' },
        description: 'Boundaries the executor must respect; optional, defaults to none.',
      },
      outputForm: {
        type: 'array',
        items: { type: 'string' },
        description: 'Expected deliverable items the card\'s output form requires.',
      },
      intentId: {
        type: 'string',
        description: 'Active card the task is optionally dispatched against; supply it together with `intentVersion`, or omit both.',
      },
      intentVersion: {
        type: 'integer',
        description: 'Card version the task is optionally dispatched against; required when `intentId` is supplied.',
      },
      coverage: {
        type: 'array',
        description: 'When the task references a card, one mapping per card point: the point and the task-brief item that covers it. Required for every card point unless `nonCoverage` waives it.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            point: { type: 'string', required: true, description: 'Card point from `workspace_intents.get`, such as `acceptance[0]`.' },
            brief: { type: 'string', required: true, description: 'Exact text of the task-brief item that covers the point.' },
            note: { type: 'string' },
          },
        },
      },
      nonCoverage: {
        type: 'array',
        description: 'Explicit non-coverage for a card point; the super agent confirms dispatch with this reason. There is no default pass.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            point: { type: 'string', required: true },
            reason: { type: 'string', required: true },
          },
        },
      },
      alignment: {
        type: 'object',
        additionalProperties: false,
        description: 'Post-execution checklist for `receipt`: one status and one piece of evidence per card point.',
        properties: {
          intentId: { type: 'string', description: 'Card the checklist checks; defaults to the task\'s card and must match it.' },
          intentVersion: { type: 'integer', description: 'Card version the checklist checks; defaults to the task\'s version and must match it.' },
          acceptance: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                point: { type: 'string', required: true },
                status: { type: 'string', required: true, enum: ['satisfied', 'not_satisfied', 'out_of_scope'] },
                evidence: { type: 'string', required: true },
              },
            },
          },
          boundaries: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                point: { type: 'string', required: true },
                status: { type: 'string', required: true, enum: ['respected', 'violated'] },
                evidence: { type: 'string', required: true },
              },
            },
          },
          outputForm: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                point: { type: 'string', required: true },
                status: { type: 'string', required: true, enum: ['matched', 'not_matched'] },
                evidence: { type: 'string', required: true },
              },
            },
          },
        },
      },
      taskType: {
        type: 'string',
        enum: [...TASK_TYPES],
        description: 'Six-category task type; optional, defaults to `other`.',
      },
      targetSessionId: {
        type: 'string',
        description: 'Session expected to execute the task; optional on `create`.',
      },
      note: {
        type: 'string',
        description: 'Optional one-line note.',
      },
      requestId: {
        type: 'string',
        description: 'Idempotency key; optional for `create` (a generated one makes each call a new task) and required by `receipt`. A repeated key returns the first result.',
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
                taskId: { type: 'string', required: true },
                title: { type: 'string', required: true },
                status: { type: 'string', required: true, enum: [...TASK_STATUSES] },
                assignee: { type: 'string' },
                targetSessionId: { type: 'string' },
                dispatcherSessionId: { type: 'string' },
                updatedAt: { type: 'string', required: true },
                latestReceiptAt: { type: 'string' },
              },
            },
          },
          task: {
            type: 'object',
            additionalProperties: false,
            properties: {
              taskId: { type: 'string', required: true },
              workspaceId: { type: 'string', required: true },
              title: { type: 'string', required: true },
              goal: { type: 'string', required: true },
              acceptance: { type: 'array', required: true, items: { type: 'string' } },
              boundaries: { type: 'array', required: true, items: { type: 'string' } },
              outputForm: { type: 'array', items: { type: 'string' } },
              status: { type: 'string', required: true, enum: [...TASK_STATUSES] },
              assignee: { type: 'string' },
              targetSessionId: { type: 'string' },
              dispatcherSessionId: { type: 'string' },
              intentId: { type: 'string' },
              intentVersion: { type: 'integer' },
              coverage: { type: 'array', items: coverageSchema },
              nonCoverage: { type: 'array', items: nonCoverageSchema },
              taskType: { type: 'string', enum: [...TASK_TYPES] },
              createdAt: { type: 'string', required: true },
              updatedAt: { type: 'string', required: true },
              requestId: { type: 'string', required: true },
              note: { type: 'string' },
              receipts: { type: 'array', required: true, items: receiptSchema },
              artifactIds: { type: 'array', required: true, items: { type: 'string' } },
            },
          },
          taskId: { type: 'string' },
          status: { type: 'string', enum: [...TASK_STATUSES] },
          dispatcherSessionId: { type: 'string' },
          createdAt: { type: 'string' },
          receipt: receiptSchema,
          deviations: { type: 'array', items: { type: 'string' } },
          replayed: { type: 'boolean' },
          targetSession: {
            type: 'object',
            additionalProperties: false,
            properties: {
              sessionId: { type: 'string', required: true },
              title: { type: 'string' },
            },
          },
          artifacts: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                artifactId: { type: 'string', required: true },
                workspaceId: { type: 'string', required: true },
                path: { type: 'string', required: true },
                sha256: { type: 'string', required: true },
                size: { type: 'integer', required: true },
                version: { type: 'integer', required: true },
                kind: { type: 'string', required: true },
                sessionId: { type: 'string', required: true },
                taskId: { type: 'string' },
                createdAt: { type: 'string', required: true },
                summary: { type: 'string' },
              },
            },
          },
          nextCursor: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderTasks(value) }],
    },
    async execute(args, exec) {
      const session = requireCallerSession(exec.agent?.session, 'workspace_tasks')
      const scope = await resolveWorkspace(ctx, session, `tasks.${args.action}`, args.workspace)
      switch (args.action) {
        case 'get': {
          const taskId = args.taskId
          if (taskId === undefined) throw new WorkspaceRecordError('workspace_tasks with action "get" requires taskId', 'WORKSPACE_RECORD_NOT_FOUND')
          return await readOneTask(ctx, scope.workspace, taskId, exec.signal)
        }
        case 'list': {
          const page = await listWorkspaceTasks(ctx, scope.workspace, args, exec.signal)
          return {
            workspace: String(scope.workspace.id),
            items: page.items,
            ...page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor },
          }
        }
        case 'create':
          return await createTask(ctx, scope.workspace, args, exec.agent, scope.crossWorkspace, exec.signal)
        case 'update':
          return await updateTask(ctx, scope.workspace, args, exec.agent, scope.crossWorkspace, exec.signal)
        case 'receipt':
          return await appendReceipt(ctx, scope.workspace, args, exec.agent, scope.crossWorkspace, exec.signal)
        default:
          throw new WorkspaceRecordError(`unknown workspace_tasks action ${JSON.stringify(String(args.action))}`, 'WORKSPACE_RECORD_NOT_FOUND')
      }
    },
  })
}

/** Output schema of one coverage entry. */
const coverageSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    point: { type: 'string', required: true },
    brief: { type: 'string', required: true },
    note: { type: 'string' },
  },
} as const satisfies ObjectValueSchemaSpec

/** Output schema of one non-coverage entry. */
const nonCoverageSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    point: { type: 'string', required: true },
    reason: { type: 'string', required: true },
  },
} as const satisfies ObjectValueSchemaSpec

/** Output schema of one alignment. */
const alignmentSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    intentId: { type: 'string', required: true },
    intentVersion: { type: 'integer', required: true },
    acceptance: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          point: { type: 'string', required: true },
          status: { type: 'string', required: true, enum: ['satisfied', 'not_satisfied', 'out_of_scope'] },
          evidence: { type: 'string', required: true },
        },
      },
    },
    boundaries: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          point: { type: 'string', required: true },
          status: { type: 'string', required: true, enum: ['respected', 'violated'] },
          evidence: { type: 'string', required: true },
        },
      },
    },
    outputForm: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          point: { type: 'string', required: true },
          status: { type: 'string', required: true, enum: ['matched', 'not_matched'] },
          evidence: { type: 'string', required: true },
        },
      },
    },
  },
} as const satisfies ObjectValueSchemaSpec

/** Output schema of one receipt. */
const receiptSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    receiptId: { type: 'string', required: true },
    at: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: [...TASK_STATUSES] },
    note: { type: 'string' },
    requestId: { type: 'string' },
    alignment: alignmentSchema,
  },
} as const satisfies ObjectValueSchemaSpec



/** Caller-supplied alignment after schema validation. */
interface AlignmentInput {
  readonly intentId?: string
  readonly intentVersion?: number
  readonly acceptance?: readonly { readonly point: string; readonly status: AcceptanceAlignmentStatus; readonly evidence: string }[]
  readonly boundaries?: readonly { readonly point: string; readonly status: BoundaryAlignmentStatus; readonly evidence: string }[]
  readonly outputForm?: readonly { readonly point: string; readonly status: OutputFormAlignmentStatus; readonly evidence: string }[]
}

/** Caller-supplied create arguments after schema validation. */
interface CreateTaskInput {
  readonly workspace?: string
  readonly taskId?: string
  readonly title?: string
  readonly goal?: string
  readonly acceptance?: readonly string[]
  readonly boundaries?: readonly string[]
  readonly outputForm?: readonly string[]
  readonly intentId?: string
  readonly intentVersion?: number
  readonly coverage?: readonly TaskCoverage[]
  readonly nonCoverage?: readonly TaskNonCoverage[]
  readonly taskType?: TaskType
  readonly targetSessionId?: string
  readonly note?: string
  readonly requestId?: string
}

/**
 * One dispatch task to create, optionally against a workspace's active intent card.
 *
 * This is the programmatic half of `workspace_tasks.create`: the tool supplies
 * the same fields, and a trusted in-process caller creates the task through the
 * service instead of re-implementing the card, coverage, and idempotency rules.
 */
export interface DispatchTaskInput {
  /** Workspace that owns both the task and the card. */
  readonly workspaceId: string
  /** What the task must achieve; required. */
  readonly goal?: string
  /** Short task title; defaults to the goal's first line. */
  readonly title?: string
  /** Checkable acceptance points; optional, defaults to none. */
  readonly acceptance?: readonly string[]
  /** Boundaries the executor must respect; optional, defaults to none. */
  readonly boundaries?: readonly string[]
  /** Expected deliverable items the card's output form requires. */
  readonly outputForm?: readonly string[]
  /** Active card the task is optionally dispatched against; supply it with `intentVersion` or omit both. */
  readonly intentId?: string
  /** Card version the task is optionally dispatched against; required when `intentId` is supplied. */
  readonly intentVersion?: number
  /** One mapping per card point; required when the task references a card, unless `nonCoverage` waives it. */
  readonly coverage?: readonly TaskCoverage[]
  /** Explicit non-coverage for a card point, with the reason. */
  readonly nonCoverage?: readonly TaskNonCoverage[]
  /** Six-category task type; optional, defaults to `other`. */
  readonly taskType?: TaskType
  /** Session expected to execute the task. */
  readonly targetSessionId?: string
  /** One-line note. */
  readonly note?: string
  /** Idempotency key; optional. Omit to create a new task, supply it to make a retry idempotent. */
  readonly requestId?: string
}

/** Identity of the task one dispatch create call produced. */
export interface DispatchTaskIdentity {
  /** Workspace that owns the task. */
  readonly workspace: string
  /** Stable task id. */
  readonly taskId: string
  /** Task state after the call. */
  readonly status: TaskStatus
  /** ISO-8601 creation instant, absent on a replay. */
  readonly createdAt?: string
  /** Whether an idempotent retry replayed an earlier result. */
  readonly replayed?: boolean
}

/** Caller-supplied update arguments after schema validation. */
interface UpdateTaskInput {
  readonly taskId?: string
  readonly status?: TaskStatus
  readonly assignee?: string
  readonly note?: string
  readonly requestId?: string
}

/** Caller-supplied receipt arguments after schema validation. */
interface ReceiptInput {
  readonly taskId?: string
  readonly status?: TaskStatus
  readonly note?: string
  readonly alignment?: AlignmentInput
  readonly requestId?: string
}

/**
 * Create one task; the active card version and coverage map are optional.
 * @param ctx - context carrying the store and registry.
 * @param workspace - workspace that owns the task.
 * @param args - create arguments.
 * @param agent - calling agent, when the call has one.
 * @param signal - cancellation for the store reads and writes.
 * @returns the created or replayed task identity.
 */
async function createTask(
  ctx: Context,
  workspace: Workspace,
  args: CreateTaskInput,
  agent: Agent | undefined,
  crossWorkspace: boolean,
  signal: AbortSignal | undefined,
): Promise<WorkspaceTasksValue> {
  return await createDispatchTask(ctx, {
    workspaceId: String(workspace.id),
    ...args.goal === undefined ? {} : { goal: args.goal },
    ...args.title === undefined ? {} : { title: args.title },
    ...args.acceptance === undefined ? {} : { acceptance: args.acceptance },
    ...args.boundaries === undefined ? {} : { boundaries: args.boundaries },
    ...args.outputForm === undefined ? {} : { outputForm: args.outputForm },
    ...args.intentId === undefined ? {} : { intentId: args.intentId },
    ...args.intentVersion === undefined ? {} : { intentVersion: args.intentVersion },
    ...args.coverage === undefined ? {} : { coverage: args.coverage },
    ...args.nonCoverage === undefined ? {} : { nonCoverage: args.nonCoverage },
    ...args.taskType === undefined ? {} : { taskType: args.taskType },
    ...args.targetSessionId === undefined ? {} : { targetSessionId: args.targetSessionId },
    ...args.note === undefined ? {} : { note: args.note },
    ...args.requestId === undefined ? {} : { requestId: args.requestId },
  }, {
    authorized: !crossWorkspace || agent?.role === 'super',
    workspaceNamed: args.workspace !== undefined,
    ...agent?.session === undefined ? {} : { session: agent.session },
    ...signal === undefined ? {} : { signal },
  })
}

/**
 * Create one dispatch task through the same optional-card, coverage, and
 * idempotency rules the `workspace_tasks.create` tool applies.
 *
 * A task may reference an active card version, in which case the card and the
 * coverage map are validated exactly as before; without one, the brief is
 * recorded as supplied and the card-specific checks are skipped.
 *
 * Authorization is a parameter rather than an Agent verdict: the tool computes
 * it from the caller's workspace and role, and a trusted in-process caller
 * passes `authorized: true`.
 * @param ctx - context carrying the store and registry.
 * @param input - complete create input; missing required fields refuse with `INTENT_INCOMPLETE`.
 * @param options - the authorization verdict, whether the caller named a workspace, the calling Session, and cancellation.
 * @returns the created or replayed task identity.
 * @throws WorkspaceTaskError `WORKSPACE_TASK_FORBIDDEN` when the caller may not write the task.
 * @throws WorkspaceIntentError the card, coverage, or field refusal.
 */
export async function createDispatchTask(
  ctx: Context,
  input: DispatchTaskInput,
  options: {
    readonly authorized: boolean
    readonly workspaceNamed?: boolean
    readonly session?: Session
    readonly signal?: AbortSignal
  },
): Promise<DispatchTaskIdentity> {
  if (!options.authorized) {
    throw new WorkspaceTaskError(
      'workspace_tasks.create requires an agent in the task\'s workspace; a cross-workspace create requires the super agent',
      'WORKSPACE_TASK_FORBIDDEN',
    )
  }
  const missing = [
    options.workspaceNamed === false || input.workspaceId === '' ? 'workspace' : undefined,
    input.goal === undefined ? 'goal' : undefined,
  ].filter((field): field is string => field !== undefined)
  if (missing.length > 0) {
    throw new WorkspaceIntentError(
      `workspace_tasks.create requires ${missing.join(', ')}`,
      'INTENT_INCOMPLETE',
    )
  }
  const carded = input.intentId !== undefined || input.intentVersion !== undefined
  if (carded && (input.intentId === undefined || input.intentVersion === undefined)) {
    throw new WorkspaceIntentError(
      'workspace_tasks.create needs intentId and intentVersion together, or neither',
      'INTENT_INCOMPLETE',
    )
  }
  if (!carded && (input.coverage !== undefined || input.nonCoverage !== undefined)) {
    throw new WorkspaceIntentError(
      'workspace_tasks.create accepts coverage only when the task references an intent card',
      'INTENT_INCOMPLETE',
    )
  }
  const workspaceId = input.workspaceId
  const intentId = carded ? input.intentId as string : undefined
  const intentVersion = carded ? input.intentVersion as number : undefined
  const requestId = input.requestId?.trim() || randomUUID()
  const taskId = taskIdFor(workspaceId, requestId)
  const existing = await readTask(ctx, workspaceId, taskId, options.signal)
  if (existing !== undefined) {
    return {
      workspace: workspaceId,
      taskId: existing.task.taskId,
      status: existing.task.status,
      createdAt: existing.task.createdAt,
      replayed: true,
    }
  }
  const acceptance = [...input.acceptance ?? []]
  const boundaries = [...input.boundaries ?? []]
  const outputForm = [...input.outputForm ?? []]
  const brief = [input.goal as string, ...acceptance, ...boundaries, ...outputForm]
  const coverage = input.coverage === undefined ? undefined : [...input.coverage]
  const nonCoverage = input.nonCoverage === undefined ? undefined : [...input.nonCoverage]
  if (carded) {
    const card = await dispatchCard(ctx, workspaceId, intentId as string, intentVersion as number, options.signal)
    const checked = checkCoverage(card.record.items, brief, coverage, nonCoverage)
    if (checked.unknown.length > 0) {
      throw new WorkspaceIntentError(
        `coverage names card point${checked.unknown.length > 1 ? 's' : ''} ${checked.unknown.map(point => JSON.stringify(point)).join(', ')} that ${intentId} v${String(intentVersion)} does not have`,
        'INTENT_INVALID',
      )
    }
    if (checked.missing.length > 0) {
      throw new WorkspaceIntentError(
        `dispatch does not cover card point${checked.missing.length > 1 ? 's' : ''}: ${checked.missing.map(entry =>
          `${entry.point} (${entry.reason})`).join('; ')}. Add the point to the task brief or an explicit non-coverage reason; there is no default pass.`,
        'INTENT_COVERAGE_MISSING',
      )
    }
  }
  const now = new Date().toISOString()
  const task: TaskRecord = {
    taskId,
    workspaceId,
    title: input.title ?? oneLine(input.goal as string, 120),
    goal: input.goal as string,
    acceptance,
    boundaries,
    ...outputForm.length === 0 ? {} : { outputForm },
    status: 'pending',
    ...input.targetSessionId === undefined ? {} : { targetSessionId: input.targetSessionId },
    ...options.session === undefined ? {} : { dispatcherSessionId: String(options.session.id) },
    ...intentId === undefined ? {} : { intentId },
    ...intentVersion === undefined ? {} : { intentVersion },
    ...coverage === undefined ? {} : { coverage },
    ...nonCoverage === undefined ? {} : { nonCoverage },
    taskType: input.taskType ?? 'other',
    createdAt: now,
    updatedAt: now,
    requestId,
    ...input.note === undefined ? {} : { note: input.note },
    receipts: [],
    artifactIds: [],
  }
  await writeTask(ctx, workspaceId, task, options.session === undefined ? {} : { session: options.session })
  return {
    workspace: workspaceId,
    taskId,
    status: 'pending',
    createdAt: now,
  }
}

/**
 * Cancel a dispatch task whose Session never started, leaving a terminal task
 * untouched. This keeps a refused dispatch from leaving a misleading `pending`
 * record: only `pending` moves to `cancelled`.
 * @param ctx - context carrying the store.
 * @param input - the workspace, task, and reason recorded on the task.
 * @param signal - cancellation for the store reads and writes.
 * @returns whether the task moved to `cancelled`.
 */
export async function cancelDispatchTask(
  ctx: Context,
  input: { readonly workspaceId: string; readonly taskId: string; readonly reason: string },
  signal?: AbortSignal,
  session?: Session,
): Promise<boolean> {
  const stored = await readTask(ctx, input.workspaceId, input.taskId, signal)
  if (stored === undefined || stored.task.status !== 'pending') return false
  const task: TaskRecord = {
    ...stored.task,
    status: 'cancelled',
    updatedAt: new Date().toISOString(),
    note: oneLine(`dispatch did not start: ${input.reason}`, 240),
  }
  await writeTask(ctx, input.workspaceId, task, {
    ...stored.version === undefined ? {} : { expected: stored.version },
    ...session === undefined ? {} : { session },
  })
  return true
}

/**
 * Resolve the card version a dispatch references.
 *
 * A card outside the task's workspace is distinguished from a missing one, so
 * the caller sees `INTENT_SCOPE_MISMATCH` rather than a misleading
 * `INTENT_INCOMPLETE`.
 * @param ctx - context carrying the store and registry.
 * @param workspaceId - workspace that owns the task.
 * @param intentId - card identity.
 * @param intentVersion - card version.
 * @param signal - cancellation for the store reads.
 * @returns the card index, summary, and version record.
 */
async function dispatchCard(
  ctx: Context,
  workspaceId: string,
  intentId: string,
  intentVersion: number,
  signal: AbortSignal | undefined,
): Promise<{ readonly index: IntentIndex; readonly record: IntentVersionRecord }> {
  const stored = await readIntentIndex(ctx, workspaceId, intentId, signal)
  if (stored === undefined) {
    const owner = await findCardOwner(ctx, intentId, workspaceId, signal)
    if (owner !== undefined) {
      throw new WorkspaceIntentError(
        `intent card ${JSON.stringify(intentId)} belongs to workspace ${owner}, not ${workspaceId}; a task must reference the card in its own workspace`,
        'INTENT_SCOPE_MISMATCH',
      )
    }
    throw new WorkspaceIntentError(
      `workspace ${workspaceId} holds no intent card ${JSON.stringify(intentId)}; create the card before dispatching`,
      'INTENT_INCOMPLETE',
    )
  }
  const summary = stored.index.versions.find(candidate => candidate.version === intentVersion)
  if (summary === undefined) {
    throw new WorkspaceIntentError(
      `intent card ${intentId} has no version ${String(intentVersion)}`,
      'INTENT_INCOMPLETE',
    )
  }
  if (summary.status === 'proposed') {
    const proposed = await readCardRecord(ctx, workspaceId, intentId, intentVersion, signal)
    const confirmation = confirmationRequest(intentId, intentVersion, proposed.items)
    throw new WorkspaceIntentError(
      `intent card ${intentId} v${String(intentVersion)} is proposed and not confirmed; dispatch is blocked until the user confirms it once`
      + (confirmation === undefined ? '' : ` (confirmation request ${confirmation.requestId})`),
      'INTENT_UNCONFIRMED',
    )
  }
  if (summary.status === 'superseded' || stored.index.latestActiveVersion !== intentVersion) {
    throw new WorkspaceIntentError(
      `intent card ${intentId} v${String(intentVersion)} is stale; the latest active version is ${String(stored.index.latestActiveVersion ?? 'none')}, so re-read the card and dispatch against the active version`,
      'INTENT_STALE',
    )
  }
  const record = await readCardRecord(ctx, workspaceId, intentId, intentVersion, signal)
  return { index: stored.index, record }
}

/**
 * Read one card version record, failing when the index points at a missing file.
 * @param ctx - context carrying the store.
 * @param workspaceId - workspace that owns the card.
 * @param intentId - card identity.
 * @param version - version number.
 * @param signal - cancellation for the store read.
 * @returns the version record.
 */
async function readCardRecord(
  ctx: Context,
  workspaceId: string,
  intentId: string,
  version: number,
  signal: AbortSignal | undefined,
): Promise<IntentVersionRecord> {
  const stored = await readIntentVersion(ctx, workspaceId, intentId, version, signal)
  if (stored === undefined) {
    throw new WorkspaceRecordError(
      `intent card ${intentId} v${String(version)} has no stored version in workspace ${workspaceId}`,
      'WORKSPACE_RECORD_CORRUPT',
    )
  }
  return stored.record
}

/**
 * Find which workspace owns one card id, for the scope-mismatch refusal.
 * @param ctx - context carrying the store and registry.
 * @param intentId - card identity.
 * @param ownWorkspaceId - workspace that owns the task.
 * @param signal - cancellation for the store reads.
 * @returns the owning workspace id, or undefined when no workspace has the card.
 */
async function findCardOwner(
  ctx: Context,
  intentId: string,
  ownWorkspaceId: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  for (const candidate of workspaceDirectory(ctx).list()) {
    if (String(candidate.id) === ownWorkspaceId) continue
    const stored = await readIntentIndex(ctx, candidate.id, intentId, signal)
    if (stored !== undefined) {
      ctx.logger.info(
        'workspace-tools: task in workspace %s referenced intent card %s owned by workspace %s',
        ownWorkspaceId,
        intentId,
        String(candidate.id),
      )
      return String(candidate.id)
    }
  }
  return undefined
}

/**
 * Move one task's state, or record its assignee and note.
 * @param ctx - context carrying the store.
 * @param workspace - workspace that owns the task.
 * @param args - update arguments.
 * @param agent - calling agent, when the call has one.
 * @param signal - cancellation for the store reads and writes.
 * @returns the task id and its state after the call.
 */
async function updateTask(
  ctx: Context,
  workspace: Workspace,
  args: UpdateTaskInput,
  agent: Agent | undefined,
  crossWorkspace: boolean,
  signal: AbortSignal | undefined,
): Promise<WorkspaceTasksValue> {
  const taskId = requireTaskId(args.taskId, 'update')
  const stored = await readTask(ctx, workspace.id, taskId, signal)
  if (stored === undefined) {
    throw new WorkspaceRecordError(
      `workspace ${String(workspace.id)} holds no task ${JSON.stringify(taskId)}`,
      'WORKSPACE_RECORD_NOT_FOUND',
    )
  }
  requireTaskMutator(agent, 'update', crossWorkspace)
  if (args.status === undefined && args.assignee === undefined && args.note === undefined) {
    throw new WorkspaceTaskError('workspace_tasks.update requires status, assignee, or note', 'WORKSPACE_TASK_TRANSITION')
  }
  if (args.requestId !== undefined && args.requestId === stored.task.lastRequestId) {
    return {
      workspace: String(workspace.id),
      taskId,
      status: stored.task.status,
      ...stored.task.dispatcherSessionId === undefined ? {} : { dispatcherSessionId: stored.task.dispatcherSessionId },
      replayed: true,
    }
  }
  if (args.status !== undefined) {
    assertTransition(stored.task.status, args.status)
    if (args.status === 'done') await requireDoneGate(ctx, workspace, stored.task, undefined, signal)
  }
  const next: TaskRecord = {
    ...stored.task,
    ...args.status === undefined ? {} : { status: args.status },
    ...args.assignee === undefined ? {} : { assignee: args.assignee },
    ...args.note === undefined ? {} : { note: args.note },
    updatedAt: new Date().toISOString(),
    ...args.requestId === undefined ? {} : { lastRequestId: args.requestId },
  }
  await writeTask(ctx, workspace.id, next, {
    ...stored.version === undefined ? {} : { expected: stored.version },
    ...agent?.session === undefined ? {} : { session: agent.session },
  })
  return {
    workspace: String(workspace.id),
    taskId,
    status: next.status,
    ...next.dispatcherSessionId === undefined ? {} : { dispatcherSessionId: next.dispatcherSessionId },
  }
}

/**
 * Append one receipt and apply the state machine, including the `done` gate.
 * @param ctx - context carrying the store.
 * @param workspace - workspace that owns the task.
 * @param args - receipt arguments.
 * @param agent - calling agent, when the call has one.
 * @param signal - cancellation for the store reads and writes.
 * @returns the appended receipt and the task's effective state.
 */
async function appendReceipt(
  ctx: Context,
  workspace: Workspace,
  args: ReceiptInput,
  agent: Agent | undefined,
  crossWorkspace: boolean,
  signal: AbortSignal | undefined,
): Promise<WorkspaceTasksValue> {
  const taskId = requireTaskId(args.taskId, 'receipt')
  const requestId = args.requestId
  if (requestId === undefined || requestId.length === 0) {
    throw new WorkspaceTaskError('workspace_tasks.receipt requires requestId', 'WORKSPACE_TASK_TRANSITION')
  }
  const status = args.status
  if (status === undefined) {
    throw new WorkspaceTaskError('workspace_tasks.receipt requires status', 'WORKSPACE_TASK_TRANSITION')
  }
  const stored = await readTask(ctx, workspace.id, taskId, signal)
  if (stored === undefined) {
    throw new WorkspaceRecordError(
      `workspace ${String(workspace.id)} holds no task ${JSON.stringify(taskId)}`,
      'WORKSPACE_RECORD_NOT_FOUND',
    )
  }
  requireTaskMutator(agent, 'receipt', crossWorkspace)
  const replayed = stored.task.receipts.find(receipt => receipt.requestId === requestId)
  if (replayed !== undefined) {
    return {
      workspace: String(workspace.id),
      taskId,
      status: stored.task.status,
      ...stored.task.dispatcherSessionId === undefined ? {} : { dispatcherSessionId: stored.task.dispatcherSessionId },
      receipt: receiptView(replayed),
      replayed: true,
    }
  }
  const alignment = args.alignment === undefined
    ? undefined
    : normalizeAlignment(args.alignment, stored.task)
  let effective = status
  let deviations: string[] | undefined
  if (status === 'done') {
    const gate = await doneGate(ctx, workspace, stored.task, alignment, signal)
    if (!gate.ok) {
      if (gate.code === 'INTENT_ALIGNMENT_UNSATISFIED') {
        effective = gate.effectiveStatus
        deviations = gate.deviations
      } else {
        throw gate.error
      }
    }
  }
  if (effective !== status) {
    assertTransition(stored.task.status, effective)
  } else {
    assertTransition(stored.task.status, status)
  }
  const now = new Date().toISOString()
  const receipt = {
    receiptId: receiptIdFor(taskId, requestId),
    at: now,
    status: effective,
    ...args.note === undefined ? {} : { note: args.note },
    requestId,
    ...alignment === undefined ? {} : { alignment },
  }
  const next: TaskRecord = {
    ...stored.task,
    status: effective,
    updatedAt: now,
    receipts: [...stored.task.receipts, receipt],
  }
  await writeTask(ctx, workspace.id, next, {
    ...stored.version === undefined ? {} : { expected: stored.version },
    ...agent?.session === undefined ? {} : { session: agent.session },
  })
  return {
    workspace: String(workspace.id),
    taskId,
    status: effective,
    ...next.dispatcherSessionId === undefined ? {} : { dispatcherSessionId: next.dispatcherSessionId },
    receipt: receiptView(receipt),
    ...deviations === undefined ? {} : { deviations },
  }
}

/**
 * Refuse `done` unless the latest recorded alignment covers every card point
 * and reports no unsatisfied acceptance point or violated boundary.
 * @param ctx - context carrying the store.
 * @param workspace - workspace that owns the task.
 * @param task - task about to move to `done`.
 * @param alignment - alignment supplied by this call, when it supplied one.
 * @param signal - cancellation for the store reads.
 * @returns the gate outcome.
 */
async function requireDoneGate(
  ctx: Context,
  workspace: Workspace,
  task: TaskRecord,
  alignment: TaskAlignment | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  const gate = await doneGate(ctx, workspace, task, alignment, signal)
  if (!gate.ok) throw gate.error
}

/** Refusal from the `done` gate, with the state a deviation moves the task to. */
type DoneGateRefusal =
  | {
    readonly ok: false
    readonly code: 'INTENT_ALIGNMENT_MISSING' | 'INTENT_ALIGNMENT_INCOMPLETE' | 'INTENT_INVALID' | 'INTENT_INCOMPLETE'
    readonly error: WorkspaceIntentError
  }
  | {
    readonly ok: false
    readonly code: 'INTENT_ALIGNMENT_UNSATISFIED'
    readonly error: WorkspaceIntentError
    readonly effectiveStatus: 'waiting_review' | 'blocked'
    readonly deviations: string[]
  }

/** Outcome of the `done` gate. */
type DoneGate = { readonly ok: true } | DoneGateRefusal

/**
 * Evaluate the `done` gate against the card version the task committed to.
 * @param ctx - context carrying the store.
 * @param workspace - workspace that owns the task.
 * @param task - task about to move to `done`.
 * @param alignment - alignment supplied by this call, when it supplied one.
 * @param signal - cancellation for the store reads.
 * @returns the gate outcome.
 */
async function doneGate(
  ctx: Context,
  workspace: Workspace,
  task: TaskRecord,
  alignment: TaskAlignment | undefined,
  signal: AbortSignal | undefined,
): Promise<DoneGate> {
  if (task.intentId === undefined || task.intentVersion === undefined) return { ok: true }
  const effective = alignment ?? latestAlignment(task)
  if (effective === undefined) {
    return {
      ok: false,
      code: 'INTENT_ALIGNMENT_MISSING',
      error: new WorkspaceIntentError(
        `task ${task.taskId} cannot move to done without an alignment checklist for ${task.intentId} v${String(task.intentVersion)}`,
        'INTENT_ALIGNMENT_MISSING',
      ),
    }
  }
  if (effective.intentId !== task.intentId || effective.intentVersion !== task.intentVersion) {
    return {
      ok: false,
      code: 'INTENT_INVALID',
      error: new WorkspaceIntentError(
        `alignment checks ${effective.intentId} v${String(effective.intentVersion)}, but task ${task.taskId} references ${task.intentId} v${String(task.intentVersion)}`,
        'INTENT_INVALID',
      ),
    }
  }
  const record = await readCardRecord(ctx, String(workspace.id), task.intentId, task.intentVersion, signal)
  const checked: AlignmentCheck = checkAlignment(record.items, effective, task.intentId, task.intentVersion)
  if (checked.unknown.length > 0) {
    return {
      ok: false,
      code: 'INTENT_INVALID',
      error: new WorkspaceIntentError(
        `alignment names card point${checked.unknown.length > 1 ? 's' : ''} ${checked.unknown.map(point => JSON.stringify(point)).join(', ')} that ${task.intentId} v${String(task.intentVersion)} does not have (or repeats one)`,
        'INTENT_INVALID',
      ),
    }
  }
  if (checked.missing.length > 0) {
    return {
      ok: false,
      code: 'INTENT_ALIGNMENT_INCOMPLETE',
      error: new WorkspaceIntentError(
        `alignment leaves card point${checked.missing.length > 1 ? 's' : ''} ${checked.missing.join(', ')} unchecked; a done receipt must check every card point`,
        'INTENT_ALIGNMENT_INCOMPLETE',
      ),
    }
  }
  const deviations = [
    ...checked.unsatisfied.map(point => `acceptance ${point}: not_satisfied`),
    ...checked.violated.map(point => `boundary ${point}: violated`),
  ]
  if (checked.notMatched.length > 0) {
    deviations.push(...checked.notMatched.map(point => `output form ${point}: not_matched`))
  }
  if (checked.unsatisfied.length > 0 || checked.violated.length > 0) {
    return {
      ok: false,
      code: 'INTENT_ALIGNMENT_UNSATISFIED',
      error: new WorkspaceIntentError(
        `task ${task.taskId} cannot move to done: ${deviations.join('; ')}`,
        'INTENT_ALIGNMENT_UNSATISFIED',
      ),
      effectiveStatus: checked.violated.length > 0 ? 'blocked' : 'waiting_review',
      deviations,
    }
  }
  return { ok: true }
}

/**
 * Fill one alignment's optional card identity from the task and validate its shape.
 * @param input - caller-supplied alignment.
 * @param task - task the alignment belongs to.
 * @returns the complete alignment.
 */
function normalizeAlignment(input: AlignmentInput, task: TaskRecord): TaskAlignment {
  const intentId = input.intentId ?? task.intentId
  const intentVersion = input.intentVersion ?? task.intentVersion
  if (intentId === undefined || intentVersion === undefined) {
    throw new WorkspaceIntentError(
      `task ${task.taskId} has no intent card, so an alignment cannot be checked against one`,
      'INTENT_ALIGNMENT_MISSING',
    )
  }
  return {
    intentId,
    intentVersion,
    acceptance: (input.acceptance ?? []).map(entry => ({ point: entry.point, status: entry.status, evidence: entry.evidence })),
    boundaries: (input.boundaries ?? []).map(entry => ({ point: entry.point, status: entry.status, evidence: entry.evidence })),
    outputForm: (input.outputForm ?? []).map(entry => ({ point: entry.point, status: entry.status, evidence: entry.evidence })),
  }
}

/**
 * Latest alignment recorded on a task.
 * @param task - task whose receipts are read newest first.
 * @returns the latest alignment, when a receipt carries one.
 */
function latestAlignment(task: TaskRecord): TaskAlignment | undefined {
  for (let index = task.receipts.length - 1; index >= 0; index -= 1) {
    const alignment = task.receipts[index]?.alignment
    if (alignment !== undefined) return alignment
  }
  return undefined
}

/**
 * Whether one task state may move to another.
 *
 * Any state may return to `in_progress`; completed states are terminal except
 * for that return. A `done` transition still has to pass the alignment gate.
 * @param from - current state.
 * @param to - requested state.
 * @throws WorkspaceTaskError `WORKSPACE_TASK_TRANSITION` for a disallowed move.
 */
export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (from === to || to === 'in_progress') return
  const allowed: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
    pending: ['cancelled'],
    in_progress: ['waiting_review', 'done', 'blocked', 'cancelled'],
    waiting_review: ['done', 'blocked', 'cancelled'],
    done: [],
    blocked: [],
    cancelled: [],
  }
  if (!allowed[from].includes(to)) {
    throw new WorkspaceTaskError(
      `task state cannot move from ${from} to ${to}; allowed transitions are pending → in_progress → waiting_review → done | blocked | cancelled, and any state may return to in_progress`,
      'WORKSPACE_TASK_TRANSITION',
    )
  }
}

/**
 * Refuse a mutation only when it crosses workspaces without the super agent.
 * A caller in the task's workspace may mutate it; a cross-workspace mutation
 * still requires the super agent.
 * @param agent - calling agent, when the call has one.
 * @param action - action name for the failure message.
 * @param crossWorkspace - whether the call named another workspace.
 * @throws WorkspaceTaskError `WORKSPACE_TASK_FORBIDDEN` for a cross-workspace caller that is not the super agent.
 */
function requireTaskMutator(agent: Agent | undefined, action: string, crossWorkspace: boolean): void {
  if (!crossWorkspace) return
  if (agent?.role === 'super') return
  throw new WorkspaceTaskError(
    `workspace_tasks.${action} from another workspace requires the super agent`,
    'WORKSPACE_TASK_FORBIDDEN',
  )
}

/**
 * Require one task id argument.
 * @param taskId - caller-supplied task id.
 * @param action - action name for the failure message.
 * @returns the task id.
 */
function requireTaskId(taskId: string | undefined, action: string): string {
  if (taskId === undefined || taskId.length === 0) {
    throw new WorkspaceRecordError(`workspace_tasks.${action} requires taskId`, 'WORKSPACE_RECORD_NOT_FOUND')
  }
  return taskId
}

/**
 * Stable task id from the workspace and the idempotency key.
 * @param workspaceId - workspace that owns the task.
 * @param requestId - create idempotency key.
 * @returns the task id.
 */
export function taskIdFor(workspaceId: string, requestId: string): string {
  const digest = createHash('sha256').update(`${workspaceId}\n${requestId}`).digest('hex')
  return `task-${digest.slice(0, 16)}`
}

/**
 * Stable receipt id from the task and the idempotency key.
 * @param taskId - task that owns the receipt.
 * @param requestId - receipt idempotency key.
 * @returns the receipt id.
 */
function receiptIdFor(taskId: string, requestId: string): string {
  const digest = createHash('sha256').update(`${taskId}\n${requestId}`).digest('hex')
  return `receipt-${digest.slice(0, 16)}`
}

/**
 * Project one durable task into a list summary.
 * @param task - the task record.
 * @returns the summary fields.
 */
function summarizeTask(task: TaskRecord): TaskSummary {
  const latest = task.receipts.at(-1)
  return {
    taskId: task.taskId,
    title: task.title,
    status: task.status,
    ...task.assignee === undefined ? {} : { assignee: task.assignee },
    ...task.targetSessionId === undefined ? {} : { targetSessionId: task.targetSessionId },
    ...task.dispatcherSessionId === undefined ? {} : { dispatcherSessionId: task.dispatcherSessionId },
    updatedAt: task.updatedAt,
    ...latest === undefined ? {} : { latestReceiptAt: latest.at },
  }
}

/**
 * Read one task with its target session and artifact references.
 * @param ctx - context carrying the store and session-query.
 * @param workspace - workspace that owns the task.
 * @param taskId - task identity.
 * @param signal - cancellation for the store and title reads.
 * @returns the full task value.
 * @throws WorkspaceRecordError when the workspace holds no such task.
 */
async function readOneTask(
  ctx: Context,
  workspace: Workspace,
  taskId: string,
  signal: AbortSignal | undefined,
): Promise<WorkspaceTasksValue> {
  const stored = await readTask(ctx, workspace.id, taskId, signal)
  if (stored === undefined) {
    throw new WorkspaceRecordError(
      `workspace ${String(workspace.id)} holds no task ${JSON.stringify(taskId)}`,
      'WORKSPACE_RECORD_NOT_FOUND',
    )
  }
  const targetSession = await targetSessionOf(ctx, stored.task.targetSessionId, signal)
  const artifacts = await artifactReferences(ctx, workspace, stored.task.artifactIds, signal)
  return {
    workspace: String(workspace.id),
    task: taskView(stored.task),
    ...targetSession === undefined ? {} : { targetSession },
    artifacts,
  }
}

/**
 * Project one durable task into the tool's view.
 * @param task - the task record.
 * @returns the task view.
 */
function taskView(task: TaskRecord): TaskView {
  return {
    taskId: task.taskId,
    workspaceId: task.workspaceId,
    title: task.title,
    goal: task.goal,
    acceptance: [...task.acceptance],
    boundaries: [...task.boundaries],
    ...task.outputForm === undefined ? {} : { outputForm: [...task.outputForm] },
    status: task.status,
    ...task.assignee === undefined ? {} : { assignee: task.assignee },
    ...task.targetSessionId === undefined ? {} : { targetSessionId: task.targetSessionId },
    ...task.dispatcherSessionId === undefined ? {} : { dispatcherSessionId: task.dispatcherSessionId },
    ...task.intentId === undefined ? {} : { intentId: task.intentId },
    ...task.intentVersion === undefined ? {} : { intentVersion: task.intentVersion },
    ...task.coverage === undefined ? {} : { coverage: task.coverage.map(entry => ({
      point: entry.point,
      brief: entry.brief,
      ...entry.note === undefined ? {} : { note: entry.note },
    })) },
    ...task.nonCoverage === undefined ? {} : { nonCoverage: task.nonCoverage.map(entry => ({ point: entry.point, reason: entry.reason })) },
    ...task.taskType === undefined ? {} : { taskType: task.taskType },
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    requestId: task.requestId,
    ...task.note === undefined ? {} : { note: task.note },
    receipts: task.receipts.map(receiptView),
    artifactIds: [...task.artifactIds],
  }
}

/**
 * Project one durable receipt into the tool's view.
 * @param receipt - the receipt record.
 * @returns the receipt view.
 */
function receiptView(receipt: {
  readonly receiptId: string
  readonly at: string
  readonly status: TaskStatus
  readonly note?: string | undefined
  readonly requestId?: string | undefined
  readonly alignment?: TaskAlignment | undefined
}): TaskReceiptView {
  return {
    receiptId: receipt.receiptId,
    at: receipt.at,
    status: receipt.status,
    ...receipt.note === undefined ? {} : { note: receipt.note },
    ...receipt.requestId === undefined ? {} : { requestId: receipt.requestId },
    ...receipt.alignment === undefined ? {} : { alignment: receipt.alignment },
  }
}

/**
 * Target session of a task, resolved through session-query.
 * @param ctx - context carrying session-query.
 * @param sessionId - target session id, when the task names one.
 * @param signal - cancellation for the title read.
 * @returns the session id and its title, or undefined when the task names no session.
 */
async function targetSessionOf(
  ctx: Context,
  sessionId: string | undefined,
  signal: AbortSignal | undefined,
): Promise<{ readonly sessionId: string; readonly title?: string } | undefined> {
  if (sessionId === undefined) return undefined
  const [observation] = await ctx.sessionQuery.readTitleSnapshots([SessionId(sessionId)], signal)
  const title = observation?.status === 'fulfilled' ? observation.value.title?.title : undefined
  return { sessionId, ...title === undefined ? {} : { title } }
}

/**
 * Map recorded artifact ids to their latest published references.
 * @param ctx - context carrying the store.
 * @param workspace - workspace that owns the artifacts.
 * @param artifactIds - artifact ids recorded on the task.
 * @param signal - cancellation for the store reads.
 * @returns references for the ids that still exist, in recorded order.
 */
async function artifactReferences(
  ctx: Context,
  workspace: Workspace,
  artifactIds: readonly string[],
  signal: AbortSignal | undefined,
): Promise<ArtifactView[]> {
  if (artifactIds.length === 0) return []
  const records = await Promise.all(artifactIds.map(async (artifactId) => {
    const stored = await readArtifact(ctx, workspace.id, artifactId, signal)
    return stored?.record
  }))
  return records.flatMap((record: ArtifactRecord | undefined) => {
    if (record === undefined) return []
    const reference = artifactVersion(record)
    return reference === undefined ? [] : [artifactView(reference)]
  })
}

/**
 * List one workspace's tasks, filtered and paged.
 * @param ctx - context carrying the store.
 * @param workspace - workspace whose tasks are listed.
 * @param request - status and assignee filters, cursor, and page size.
 * @param signal - cancellation for the store reads.
 * @returns the page of summaries.
 */
async function listWorkspaceTasks(
  ctx: Context,
  workspace: Workspace,
  request: {
    readonly status?: TaskStatus
    readonly assignee?: string
    readonly cursor?: string
    readonly limit?: number
  },
  signal: AbortSignal | undefined,
): Promise<Page<TaskSummary>> {
  const tasks = await listTasks(ctx, workspace.id, signal)
  const filtered = tasks.filter(task =>
    (request.status === undefined || task.status === request.status)
    && (request.assignee === undefined || task.assignee === request.assignee))
  return pageOf(filtered.map(summarizeTask), request.limit, request.cursor)
}

/**
 * Render one tasks value for the model.
 * @param value - the tool result.
 * @returns the model-facing text.
 */
function renderTasks(value: WorkspaceTasksValue): string {
  const task = value.task
  if (task !== undefined) {
    const lines = [
      `${task.taskId} · ${task.title} · ${task.status}`
      + (task.assignee === undefined ? '' : ` · assignee ${task.assignee}`)
      + (task.targetSessionId === undefined ? '' : ` · session ${task.targetSessionId}`)
      + (task.intentId === undefined ? '' : ` · intent ${task.intentId} v${String(task.intentVersion)}`),
      `Goal: ${oneLine(task.goal, 300)}`,
      `Acceptance: ${task.acceptance.length === 0 ? 'none recorded' : task.acceptance.map(point => oneLine(point, 160)).join('; ')}`,
      `Boundaries: ${task.boundaries.length === 0 ? 'none recorded' : task.boundaries.map(point => oneLine(point, 160)).join('; ')}`,
      `Receipts: ${task.receipts.length === 0 ? 'none' : task.receipts.map(renderTaskReceipt).join('; ')}`,
      `Artifacts: ${value.artifacts === undefined || value.artifacts.length === 0 ? 'none recorded'
        : value.artifacts.map(reference => `${reference.artifactId} v${String(reference.version)} ${reference.path}`).join('; ')}`,
    ]
    return lines.join('\n')
  }
  if (value.receipt !== undefined) {
    const receipt = value.receipt
    const lines = [
      `${value.taskId ?? ''} · ${receipt.status} · receipt ${receipt.receiptId}`,
      ...receipt.alignment === undefined ? [] : [`Alignment: ${renderAlignment(receipt.alignment)}`],
      ...value.deviations === undefined ? [] : [`Deviations: ${value.deviations.join('; ')}`],
    ]
    return lines.join('\n')
  }
  if (value.taskId !== undefined) {
    return `${value.taskId} · ${value.status ?? 'unknown'}${value.replayed === true ? ' · replayed' : ''}`
  }
  const items = value.items ?? []
  if (items.length === 0) return `No tasks in workspace ${value.workspace}.`
  const lines = items.map(item =>
    `- ${item.taskId} · ${item.title} · ${item.status}`
    + (item.assignee === undefined ? '' : ` · ${item.assignee}`)
    + (item.targetSessionId === undefined ? '' : ` · session ${item.targetSessionId}`)
    + ` · updated ${item.updatedAt}`)
  if (value.nextCursor !== undefined) lines.push(`(more tasks: pass cursor ${value.nextCursor})`)
  return lines.join('\n')
}

/**
 * Render one receipt with its note and alignment size.
 * @param receipt - recorded receipt.
 * @returns the one-line receipt text.
 */
function renderTaskReceipt(receipt: TaskReceiptView): string {
  const note = receipt.note === undefined ? '' : ` (${oneLine(receipt.note, 120)})`
  const alignment = receipt.alignment === undefined
    ? ''
    : ` [alignment ${String(receipt.alignment.acceptance.length + receipt.alignment.boundaries.length + receipt.alignment.outputForm.length)} points]`
  return `${receipt.at} ${receipt.status}${note}${alignment}`
}

/**
 * Render one alignment checklist on a single line.
 * @param alignment - recorded alignment.
 * @returns the checklist text.
 */
function renderAlignment(alignment: TaskAlignment): string {
  return [
    ...alignment.acceptance.map(entry => `acceptance ${entry.point} ${entry.status} (${oneLine(entry.evidence, 100)})`),
    ...alignment.boundaries.map(entry => `boundary ${entry.point} ${entry.status} (${oneLine(entry.evidence, 100)})`),
    ...alignment.outputForm.map(entry => `output form ${entry.point} ${entry.status} (${oneLine(entry.evidence, 100)})`),
  ].join('; ')
}
