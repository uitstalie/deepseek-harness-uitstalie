/**
 * `workspace_tasks` (read side): dispatch tasks and the receipts they carry.
 *
 * A task belongs to exactly one workspace and is read from that workspace's
 * own task directory. The read actions return the task, its receipts, its
 * target session, and the artifact references recorded for it.
 * @module @deepseek-ai/dsh-workspace-tools/tasks
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { WorkspaceRecordError } from './errors.ts'
import { pageOf } from './paging.ts'
import type { Page } from './paging.ts'
import type { ArtifactRecord, TaskRecord, TaskStatus, TaskType } from './records.ts'
import { TASK_STATUSES, TASK_TYPES } from './records.ts'
import type { ArtifactView } from './artifacts.ts'
import { artifactView } from './artifacts.ts'
import { resolveWorkspace } from './scope.ts'
import { artifactVersion, listTasks, readArtifact, readTask } from './store.ts'
import { oneLine, requireCallerSession } from './tooling.ts'

/** One reported outcome as the tool returns it. */
export interface TaskReceiptView {
  /** Stable receipt id inside the task. */
  readonly receiptId: string
  /** ISO-8601 instant the executor appended the receipt. */
  readonly at: string
  /** Reported state. */
  readonly status: TaskStatus
  /** Optional one-line note. */
  readonly note?: string
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
  /** Current state. */
  readonly status: TaskStatus
  /** Assignee identity, when recorded. */
  readonly assignee?: string
  /** Session expected to execute the task. */
  readonly targetSessionId?: string
  /** Intent card this task was dispatched against. */
  readonly intentId?: string
  /** Intent card version this task was dispatched against. */
  readonly intentVersion?: number
  /** Six-category task type. */
  readonly taskType?: TaskType
  /** ISO-8601 creation instant. */
  readonly createdAt: string
  /** ISO-8601 instant of the last mutation. */
  readonly updatedAt: string
  /** Idempotency key of the create call. */
  readonly requestId: string
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
  /** Target session title, when the task names one. */
  readonly targetSession?: { readonly sessionId: string; readonly title?: string }
  /** Artifact references recorded for the task. */
  readonly artifacts?: ArtifactView[]
  /** Cursor of the next page. */
  readonly nextCursor?: string
}

/**
 * Build `workspace_tasks`.
 * @param ctx - context carrying the store and session-query.
 * @returns the tool definition.
 */
export function workspaceTasksTool(ctx: Context): ToolDefinition {
  return defineTool({
    name: 'workspace_tasks',
    description:
      'Read the dispatch tasks of a workspace. `list` returns bounded task summaries filtered by status and '
      + 'assignee; `get` returns one task with its receipts, its target session, and its artifact references. '
      + 'The caller\'s workspace is the default scope; another workspace requires its registered id.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'get'],
        description: '`list` returns task summaries; `get` returns one task with its receipts and artifacts.',
      },
      workspace: {
        type: 'string',
        description: 'Registered workspace id to read; defaults to the caller\'s workspace.',
      },
      taskId: {
        type: 'string',
        description: 'Task to read for `get`; required there.',
      },
      status: {
        type: 'string',
        enum: [...TASK_STATUSES],
        description: 'Only list tasks in this state.',
      },
      assignee: {
        type: 'string',
        description: 'Only list tasks assigned to this identity.',
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
              status: { type: 'string', required: true, enum: [...TASK_STATUSES] },
              assignee: { type: 'string' },
              targetSessionId: { type: 'string' },
              intentId: { type: 'string' },
              intentVersion: { type: 'integer' },
              taskType: { type: 'string', enum: [...TASK_TYPES] },
              createdAt: { type: 'string', required: true },
              updatedAt: { type: 'string', required: true },
              requestId: { type: 'string', required: true },
              receipts: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    receiptId: { type: 'string', required: true },
                    at: { type: 'string', required: true },
                    status: { type: 'string', required: true, enum: [...TASK_STATUSES] },
                    note: { type: 'string' },
                  },
                },
              },
              artifactIds: { type: 'array', required: true, items: { type: 'string' } },
            },
          },
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
      if (args.action === 'get') {
        const taskId = args.taskId
        if (taskId === undefined) throw new WorkspaceRecordError('workspace_tasks with action "get" requires taskId', 'WORKSPACE_RECORD_NOT_FOUND')
        return await readOneTask(ctx, scope.workspace, taskId, exec.signal)
      }
      const page = await listWorkspaceTasks(ctx, scope.workspace, args, exec.signal)
      return {
        workspace: String(scope.workspace.id),
        items: page.items,
        ...page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor },
      }
    },
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
  const page = pageOf(filtered.map(summarizeTask), request.limit, request.cursor)
  return page
}

/**
 * Project one task record into a list summary.
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
    task: {
      taskId: stored.task.taskId,
      workspaceId: stored.task.workspaceId,
      title: stored.task.title,
      goal: stored.task.goal,
      acceptance: [...stored.task.acceptance],
      boundaries: [...stored.task.boundaries],
      status: stored.task.status,
      ...stored.task.assignee === undefined ? {} : { assignee: stored.task.assignee },
      ...stored.task.targetSessionId === undefined ? {} : { targetSessionId: stored.task.targetSessionId },
      ...stored.task.intentId === undefined ? {} : { intentId: stored.task.intentId },
      ...stored.task.intentVersion === undefined ? {} : { intentVersion: stored.task.intentVersion },
      ...stored.task.taskType === undefined ? {} : { taskType: stored.task.taskType },
      createdAt: stored.task.createdAt,
      updatedAt: stored.task.updatedAt,
      requestId: stored.task.requestId,
      receipts: stored.task.receipts.map(receipt => ({
        receiptId: receipt.receiptId,
        at: receipt.at,
        status: receipt.status,
        ...receipt.note === undefined ? {} : { note: receipt.note },
      })),
      artifactIds: [...stored.task.artifactIds],
    },
    ...targetSession === undefined ? {} : { targetSession },
    artifacts,
  }
}

/**
 * Resolve the title of a task's target session.
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
 * Render one tasks value for the model.
 * @param value - the tool result.
 * @returns the model-facing text.
 */
function renderTasks(value: WorkspaceTasksValue): string {
  const task = value.task
  if (task !== undefined) {
    const lines = [
      `${task.taskId} · ${task.title} · ${task.status}`
      + `${task.assignee === undefined ? '' : ` · assignee ${task.assignee}`}`
      + `${task.targetSessionId === undefined ? '' : ` · session ${task.targetSessionId}`}`,
      `Goal: ${oneLine(task.goal, 300)}`,
      `Acceptance: ${task.acceptance.length === 0 ? 'none recorded' : task.acceptance.map(point => oneLine(point, 160)).join('; ')}`,
      `Boundaries: ${task.boundaries.length === 0 ? 'none recorded' : task.boundaries.map(point => oneLine(point, 160)).join('; ')}`,
      `Receipts: ${task.receipts.length === 0 ? 'none' : task.receipts.map(receipt =>
        `${receipt.at} ${receipt.status}${receipt.note === undefined ? '' : ` (${oneLine(receipt.note, 120)})`}`).join('; ')}`,
      `Artifacts: ${value.artifacts === undefined || value.artifacts.length === 0 ? 'none recorded'
        : value.artifacts.map(reference => `${reference.artifactId} v${String(reference.version)} ${reference.path}`).join('; ')}`,
    ]
    return lines.join('\n')
  }
  const items = value.items ?? []
  if (items.length === 0) return `No tasks in workspace ${value.workspace}.`
  const lines = items.map(item =>
    `- ${item.taskId} · ${item.title} · ${item.status}`
    + `${item.assignee === undefined ? '' : ` · ${item.assignee}`}`
    + `${item.targetSessionId === undefined ? '' : ` · session ${item.targetSessionId}`}`
    + ` · updated ${item.updatedAt}`)
  if (value.nextCursor !== undefined) lines.push(`(more tasks: pass cursor ${value.nextCursor})`)
  return lines.join('\n')
}
