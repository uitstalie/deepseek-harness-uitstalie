/**
 * `workspace_message`: send or retry a message to one Session, read the
 * delivery receipts a workspace holds, and inspect one message's delivery
 * status.
 *
 * Delivery is an explicit tool call: `send` validates the target, the artifact
 * citations, and the caller's scope, then hands the text to the host Session
 * controller. A controller that throws or declines is recorded as a durable
 * `failed` message with its reason and attempt count instead of losing the
 * message. `retry` re-sends one failed message under its original identity, so
 * the controller's request dedupe prevents a second admission. `status` returns
 * one message with its delivery state, failure reason, attempts, and artifact
 * citations; `read` returns one message by id, or a bounded page filtered by
 * target Session, with delivery receipts and artifact citations.
 * @module @deepseek-ai/dsh-workspace-tools/messages
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Session } from '@deepseek-ai/dsh-session'
import type { AgentRole } from '@deepseek-ai/dsh-agent'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { WorkspaceMessageError, WorkspaceRecordError } from './errors.ts'
import { DELIVERY_ERROR_MAX_CHARS, isArchivedSession, messageDeliveryController, requestDelivery } from './delivery.ts'
import type { DeliveryOutcome } from './delivery.ts'
import { pageOf } from './paging.ts'
import type {
  ArtifactCitation,
  MessageDeliveryStatus,
  MessageKind,
  MessagePriority,
  MessageRecord,
  TaskRecord,
  UrgentReason,
} from './records.ts'
import { MESSAGE_DELIVERY_STATUSES, URGENT_REASONS } from './records.ts'
import { artifactVersion, listMessages, listTasks, readArtifact, readMessage, readTask, writeMessage } from './store.ts'
import { resolveWorkspace } from './scope.ts'
import { oneLine, requireCallerSession } from './tooling.ts'

/** Longest accepted message body, in characters. */
export const MESSAGE_TEXT_MAX_CHARS = 600

/** One message as a read result returns it. */
export interface MessageView {
  /** Stable message id. */
  readonly messageId: string
  /** Session the message addresses. */
  readonly targetSessionId: string
  /** Session that sent the message. */
  readonly sourceSessionId: string
  /** Role the sender held when it sent. */
  readonly sourceRole?: AgentRole
  /** Message body. */
  readonly text: string
  /** Whether this is a message or a follow-up. */
  readonly kind: 'message' | 'followup'
  /** Effective priority. */
  readonly priority: 'normal' | 'urgent'
  /** Which of the three cases made the message urgent; absent for a normal message. */
  readonly urgentReason?: UrgentReason
  /** Current delivery state. */
  readonly status: MessageDeliveryStatus
  /** ISO-8601 creation instant. */
  readonly createdAt: string
  /** ISO-8601 instant the message reached its target. */
  readonly deliveredAt?: string
  /** Readable reason the last delivery attempt failed; absent while no attempt failed. */
  readonly error?: string
  /** Delivery attempts made; absent on records written before this field existed. */
  readonly attempts?: number
  /** Message this one answers. */
  readonly replyTo?: string
  /** Task this message reports on. */
  readonly taskId?: string
  /** Delivery observations in report order. */
  readonly receipts: { readonly at: string; readonly status: MessageDeliveryStatus }[]
  /** Artifact citations attached at send time. */
  readonly references: { readonly artifactId: string; readonly version: number; readonly sha256: string }[]
}

/** Result of one `send` or `retry` call. */
export interface SentMessage {
  /** Stable message id. */
  readonly messageId: string
  /** Session the message addresses. */
  readonly targetSessionId: string
  /** Effective delivery state. */
  readonly status: MessageDeliveryStatus
  /** ISO-8601 instant the message reached its target. */
  readonly deliveredAt?: string
  /** Readable reason a `failed` send or retry could not be delivered; absent otherwise. */
  readonly error?: string
  /** Delivery attempts made; absent on records written before this field existed. */
  readonly attempts?: number
  /** Citations captured at send time. */
  readonly references: ArtifactCitation[]
}

/** One `workspace_message` result value. */
export interface WorkspaceMessageValue {
  /** Workspace the result belongs to. */
  readonly workspace: string
  /** Messages read, newest first. */
  readonly messages?: MessageView[]
  /** Result of one send or retry. */
  readonly sent?: SentMessage
  /** One message inspected by `status`. */
  readonly message?: MessageView
  /** Cursor of the next page. */
  readonly nextCursor?: string
}

/**
 * Build `workspace_message`.
 * @param ctx - context carrying the store, registry, and Session controller.
 * @returns the tool definition.
 */
export function workspaceMessageTool(ctx: Context): ToolDefinition {
  return defineTool({
    name: 'workspace_message',
    description:
      'Send a message or follow-up to one Session, retry a failed delivery, inspect one message\'s delivery status, '
      + 'or read messages a workspace delivered and their receipts. '
      + '`send` requires `targetSessionId` and `text` (at most 600 characters: conclusion, evidence, next step); '
      + '`requestId` is optional — omit it to send a new message, supply it so a retry returns the first result. '
      + 'Same-workspace sends are allowed. A '
      + 'cross-workspace send is allowed only as a task-bound return: the caller must be the task\'s '
      + '`targetSessionId`, the target Session must be the task\'s `dispatcherSessionId`, and the task must live in '
      + 'the caller\'s workspace; `retry` applies the same task-binding rule when the message crosses '
      + 'workspaces. A delivery the host rejects is '
      + 'recorded as `failed` with its reason and attempt count instead of being lost. `status` returns one message '
      + 'by `messageId` (or the newest message for `targetSessionId`) with its delivery state, failure reason, '
      + 'attempts, receipts, and references. `retry` re-delivers one `failed` message under its original identity; '
      + 'retrying a message that is not failed returns its current state without delivering again. '
      + '`priority: "urgent"` is limited '
      + 'to an urgentReason: a wrong conclusion being acted on, a stop order for a dangerous operation, or a user '
      + 'instruction change. Attach files with `references` (artifact ids), never pasted content. '
      + 'A delivered message starts with a `[workspace_message]` header naming the sender\'s role, Session, workspace, '
      + 'and task, so the receiver replies to that Session with `workspace_message.send`; a dispatched Session never '
      + 'asks the user directly. '
      + '`read` returns one message by id or a page filtered by target session. '
      + 'The caller\'s workspace is the default scope.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['send', 'read', 'status', 'retry'],
        description:
          '`send` delivers one message; `read` returns messages and receipts; `status` returns one message\'s '
          + 'delivery status, failure reason, attempts, and references; `retry` re-delivers one failed message.',
      },
      workspace: {
        type: 'string',
        description: 'Registered workspace id to address; defaults to the caller\'s workspace.',
      },
      targetSessionId: {
        type: 'string',
        description:
          'Target session for `send`; required there. For `read`, filters the page to one receiver; for `status`, '
          + 'names the newest message addressed to that session when `messageId` is omitted.',
      },
      messageId: {
        type: 'string',
        description:
          'Message to read, inspect with `status`, or re-deliver with `retry`; required by `retry`.',
      },
      text: {
        type: 'string',
        description: 'Message body for `send`; conclusion, evidence, next step, at most 600 characters.',
      },
      kind: {
        type: 'string',
        enum: ['message', 'followup'],
        description: '`message` (default) or `followup` for a later check on the same work.',
      },
      priority: {
        type: 'string',
        enum: ['normal', 'urgent'],
        description: '`normal` (default) queues for the next turn boundary; `urgent` steers the current step.',
      },
      urgentReason: {
        type: 'string',
        enum: [...URGENT_REASONS],
        description: 'Required for `priority: "urgent"`: wrong-conclusion, stop-order, or instruction-change.',
      },
      replyTo: {
        type: 'string',
        description: 'Message this one answers.',
      },
      references: {
        type: 'array',
        description: 'Artifact citations to push with the message; each names artifactId, version, and sha256.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            artifactId: { type: 'string', required: true },
            version: { type: 'integer' },
            sha256: { type: 'string' },
          },
        },
      },
      taskId: {
        type: 'string',
        description: 'Task this message reports on or follows up.',
      },
      requestId: {
        type: 'string',
        description: 'Idempotency key for `send`; optional. Omit to send a new message each call, supply it so a retry returns the first result.',
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
          messages: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                messageId: { type: 'string', required: true },
                targetSessionId: { type: 'string', required: true },
                sourceSessionId: { type: 'string', required: true },
                sourceRole: { type: 'string', enum: ['subagent', 'agent', 'super'] },
                text: { type: 'string', required: true },
                kind: { type: 'string', required: true, enum: ['message', 'followup'] },
                priority: { type: 'string', required: true, enum: ['normal', 'urgent'] },
                urgentReason: { type: 'string', enum: [...URGENT_REASONS] },
                status: { type: 'string', required: true, enum: [...MESSAGE_DELIVERY_STATUSES] },
                createdAt: { type: 'string', required: true },
                deliveredAt: { type: 'string' },
                error: { type: 'string' },
                attempts: { type: 'integer' },
                replyTo: { type: 'string' },
                taskId: { type: 'string' },
                receipts: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      at: { type: 'string', required: true },
                      status: { type: 'string', required: true, enum: [...MESSAGE_DELIVERY_STATUSES] },
                    },
                  },
                },
                references: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      artifactId: { type: 'string', required: true },
                      version: { type: 'integer', required: true },
                      sha256: { type: 'string', required: true },
                    },
                  },
                },
              },
            },
          },
          message: {
            type: 'object',
            additionalProperties: false,
            properties: {
              messageId: { type: 'string', required: true },
              targetSessionId: { type: 'string', required: true },
              sourceSessionId: { type: 'string', required: true },
              sourceRole: { type: 'string', enum: ['subagent', 'agent', 'super'] },
              text: { type: 'string', required: true },
              kind: { type: 'string', required: true, enum: ['message', 'followup'] },
              priority: { type: 'string', required: true, enum: ['normal', 'urgent'] },
              urgentReason: { type: 'string', enum: [...URGENT_REASONS] },
              status: { type: 'string', required: true, enum: [...MESSAGE_DELIVERY_STATUSES] },
              createdAt: { type: 'string', required: true },
              deliveredAt: { type: 'string' },
              error: { type: 'string' },
              attempts: { type: 'integer' },
              replyTo: { type: 'string' },
              taskId: { type: 'string' },
              receipts: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    at: { type: 'string', required: true },
                    status: { type: 'string', required: true, enum: [...MESSAGE_DELIVERY_STATUSES] },
                  },
                },
              },
              references: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    artifactId: { type: 'string', required: true },
                    version: { type: 'integer', required: true },
                    sha256: { type: 'string', required: true },
                  },
                },
              },
            },
          },
          sent: {
            type: 'object',
            additionalProperties: false,
            properties: {
              messageId: { type: 'string', required: true },
              targetSessionId: { type: 'string', required: true },
              status: { type: 'string', required: true, enum: [...MESSAGE_DELIVERY_STATUSES] },
              deliveredAt: { type: 'string' },
              error: { type: 'string' },
              attempts: { type: 'integer' },
              references: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    artifactId: { type: 'string', required: true },
                    version: { type: 'integer', required: true },
                    sha256: { type: 'string', required: true },
                  },
                },
              },
            },
          },
          nextCursor: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderMessages(value) }],
    },
    async execute(args, exec) {
      const session = requireCallerSession(exec.agent?.session, 'workspace_message')
      if (args.action === 'send' || args.action === 'retry') {
        const scope = await resolveWorkspace(ctx, session, `message.${args.action}`, args.workspace)
        if (args.action === 'retry') {
          if (scope.crossWorkspace) {
            const messageId = args.messageId?.trim() ?? ''
            if (messageId !== '') {
              const stored = await readMessage(ctx, scope.workspace.id, messageId, exec.signal)
              if (stored !== undefined) {
                await boundTaskOf(
                  ctx,
                  session,
                  stored.message.targetSessionId,
                  stored.message.taskId,
                  'retry',
                  exec.signal,
                )
              }
            }
          }
          return {
            workspace: String(scope.workspace.id),
            sent: await retryMessage(ctx, scope.workspace, session, args.messageId, exec.signal),
          }
        }
        const targetSessionId = args.targetSessionId?.trim() ?? ''
        const binding = scope.crossWorkspace && targetSessionId !== ''
          ? await boundTaskOf(ctx, session, targetSessionId, args.taskId, 'send', exec.signal)
          : undefined
        return {
          workspace: String(scope.workspace.id),
          sent: await sendMessage(ctx, scope.workspace, session, args, binding, exec.agent?.role ?? 'agent', exec.signal),
        }
      }
      const scope = await resolveWorkspace(ctx, session, 'message.read', args.workspace)
      if (args.action === 'status') {
        return {
          workspace: String(scope.workspace.id),
          message: await statusMessage(ctx, scope.workspace, args.messageId, args.targetSessionId, exec.signal),
        }
      }
      if (args.messageId !== undefined) {
        return {
          workspace: String(scope.workspace.id),
          messages: [await readOneMessage(ctx, scope.workspace, args.messageId, exec.signal)],
        }
      }
      const page = await listWorkspaceMessages(ctx, scope.workspace, args, exec.signal)
      return {
        workspace: String(scope.workspace.id),
        messages: page.items,
        ...page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor },
      }
    },
  })
}

/** The send arguments after the tool schema validated their presence. */
interface SendRequest {
  readonly targetSessionId?: string
  readonly text?: string
  readonly kind?: MessageKind
  readonly priority?: MessagePriority
  readonly urgentReason?: UrgentReason
  readonly replyTo?: string
  readonly references?: readonly { readonly artifactId: string; readonly version?: number; readonly sha256?: string }[]
  readonly taskId?: string
  readonly requestId?: string
}

/**
 * Resolve the task that authorizes one cross-workspace send.
 *
 * A cross-workspace send is allowed only as a task-bound return: the task lives
 * in the caller's workspace, its `targetSessionId` is the caller, and its
 * `dispatcherSessionId` is the target Session. With `taskId` the caller names
 * the task; without it the one task that binds this caller and target is used.
 * @param ctx - context carrying the store and registry.
 * @param session - sending Session.
 * @param targetSessionId - target Session of the send or retry.
 * @param taskId - caller-named or message-recorded task, when one was supplied.
 * @param action - `send` or `retry`, for the refusal message.
 * @param signal - cancellation for the store reads.
 * @returns the binding task.
 * @throws WorkspaceMessageError `WORKSPACE_MESSAGE_FORBIDDEN` when no task binds this cross-workspace delivery.
 */
async function boundTaskOf(
  ctx: Context,
  session: Session,
  targetSessionId: string,
  taskId: string | undefined,
  action: 'send' | 'retry',
  signal: AbortSignal | undefined,
): Promise<TaskRecord> {
  const caller = await resolveWorkspace(ctx, session, 'message.send')
  const callerSessionId = String(session.id)
  const task = taskId === undefined
    ? (await listTasks(ctx, caller.workspace.id, signal)).find(candidate =>
      candidate.targetSessionId === callerSessionId
        && candidate.dispatcherSessionId === targetSessionId)
    : (await readTask(ctx, caller.workspace.id, taskId, signal))?.task
  if (task === undefined
    || task.targetSessionId !== callerSessionId
    || task.dispatcherSessionId !== targetSessionId) {
    throw new WorkspaceMessageError(
      taskId === undefined
        ? `a cross-workspace ${action} from session ${callerSessionId} to session ${targetSessionId} requires a task `
          + 'in the caller\'s workspace whose targetSessionId is the caller and whose dispatcherSessionId is the target'
        : `task ${JSON.stringify(taskId)} does not bind session ${callerSessionId} to session ${targetSessionId}: `
          + 'the task must live in the caller\'s workspace, with targetSessionId the caller and '
          + 'dispatcherSessionId the target',
      'WORKSPACE_MESSAGE_FORBIDDEN',
    )
  }
  return task
}

/**
 * Validate, deliver, and record one message.
 *
 * The record is written only after the delivery attempt settles: a validation
 * failure leaves no half-record, while a host refusal is recorded as `failed`
 * with its reason and attempt count so the caller can inspect and retry it.
 * The controller request identity derives from the message id, so a retry
 * cannot make the recipient receive the body twice.
 * @param ctx - context carrying the store, registry, and controller.
 * @param workspace - workspace the message belongs to.
 * @param session - sending Session.
 * @param request - validated send fields.
 * @param binding - task that authorizes a cross-workspace return, when this send crosses workspaces.
 * @param role - role of the sending Agent, recorded and rendered in the delivery header.
 * @param signal - cancellation for the store and delivery operations.
 * @returns the send result.
 * @throws WorkspaceMessageError when a required field is missing or an urgent case is invalid.
 * @throws WorkspaceRecordError when the target, task, reply, or citation does not exist.
 */
async function sendMessage(
  ctx: Context,
  workspace: Workspace,
  session: Session,
  request: SendRequest,
  binding: TaskRecord | undefined,
  role: AgentRole,
  signal: AbortSignal | undefined,
): Promise<SentMessage> {
  const targetSessionId = request.targetSessionId?.trim() ?? ''
  if (targetSessionId === '') {
    throw new WorkspaceMessageError('workspace_message with action "send" requires targetSessionId', 'WORKSPACE_MESSAGE_INVALID')
  }
  const text = request.text ?? ''
  if (text.trim().length === 0) {
    throw new WorkspaceMessageError('workspace_message with action "send" requires non-empty text', 'WORKSPACE_MESSAGE_INVALID')
  }
  if (text.length > MESSAGE_TEXT_MAX_CHARS) {
    throw new WorkspaceMessageError(
      `a message body is at most ${String(MESSAGE_TEXT_MAX_CHARS)} characters; this one is ${String(text.length)}`,
      'WORKSPACE_MESSAGE_INVALID',
    )
  }
  const requestId = request.requestId?.trim() || randomUUID()
  const priority = request.priority ?? 'normal'
  if (priority === 'urgent' && request.urgentReason === undefined) {
    throw new WorkspaceMessageError(
      `priority "urgent" requires urgentReason (one of ${URGENT_REASONS.join(', ')})`,
      'WORKSPACE_MESSAGE_INVALID',
    )
  }
  if (priority === 'normal' && request.urgentReason !== undefined) {
    throw new WorkspaceMessageError('urgentReason is only valid with priority "urgent"', 'WORKSPACE_MESSAGE_INVALID')
  }
  if (!workspace.sessionIds.some(id => String(id) === targetSessionId)) {
    throw new WorkspaceMessageError(
      `session ${targetSessionId} is not a session of workspace ${String(workspace.id)}`,
      'WORKSPACE_MESSAGE_TARGET',
    )
  }
  const existing = (await listMessages(ctx, workspace.id, signal))
    .find(message => message.requestId === requestId
      && message.sourceSessionId === String(session.id)
      && message.targetSessionId === targetSessionId)
  if (existing !== undefined) return sentOf(existing)
  if (request.replyTo !== undefined && await readMessage(ctx, workspace.id, request.replyTo, signal) === undefined) {
    throw new WorkspaceRecordError(
      `workspace ${String(workspace.id)} holds no message ${JSON.stringify(request.replyTo)} to reply to`,
      'WORKSPACE_RECORD_NOT_FOUND',
    )
  }
  const taskId = request.taskId ?? binding?.taskId
  if (taskId !== undefined) {
    if (binding !== undefined) {
      if (taskId !== binding.taskId) {
        throw new WorkspaceMessageError(
          `task ${JSON.stringify(taskId)} is not the task that binds this cross-workspace return (${binding.taskId})`,
          'WORKSPACE_MESSAGE_FORBIDDEN',
        )
      }
    } else if (await readTask(ctx, workspace.id, taskId, signal) === undefined) {
      throw new WorkspaceRecordError(
        `workspace ${String(workspace.id)} holds no task ${JSON.stringify(taskId)}`,
        'WORKSPACE_RECORD_NOT_FOUND',
      )
    }
  }
  const references = await resolveCitations(ctx, workspace, request.references, signal)
  const createdAt = new Date().toISOString()
  const messageId = `message-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
  const kind = request.kind ?? 'message'
  const archived = isArchivedSession(ctx, targetSessionId)
  const header = deliveryHeader(workspace, role, String(session.id), taskId)
  let status: MessageDeliveryStatus = 'queued'
  let deliveredAt: string | undefined
  let error: string | undefined
  if (archived) {
    status = 'target_archived'
  } else {
    const delivery = messageDeliveryController(ctx)
    if (delivery !== undefined) {
      const outcome = await admit(ctx, delivery, messageId, targetSessionId, priority, header, text, signal)
      if (outcome.accepted) {
        status = 'delivered'
        deliveredAt = new Date().toISOString()
      } else {
        status = 'failed'
        error = outcome.error
      }
    }
  }
  const message: MessageRecord = {
    messageId,
    workspaceId: String(workspace.id),
    targetSessionId,
    sourceSessionId: String(session.id),
    sourceRole: role,
    text,
    kind,
    priority,
    ...request.urgentReason === undefined ? {} : { urgentReason: request.urgentReason },
    ...request.replyTo === undefined ? {} : { replyTo: request.replyTo },
    references,
    ...taskId === undefined ? {} : { taskId },
    requestId,
    status,
    createdAt,
    ...deliveredAt === undefined ? {} : { deliveredAt },
    ...error === undefined ? {} : { error },
    attempts: 1,
    receipts: [{ at: deliveredAt ?? createdAt, status }],
  }
  await writeMessage(ctx, workspace.id, message, { session })
  return sentOf(message)
}

/**
 * Re-deliver one failed message under its original identity.
 *
 * A message that is not `failed` is returned unchanged: it was already admitted
 * once (or is still queued), so retrying it must not enqueue a second copy. A
 * failed message keeps its id, request id, body, priority, citations, and
 * target, so the controller's stable request identity dedupes the retry even
 * when a previous acknowledgement was lost.
 * @param ctx - context carrying the store, registry, and controller.
 * @param workspace - workspace that owns the message.
 * @param session - Session asking for the retry, recorded on the updated record.
 * @param messageId - message to re-deliver.
 * @param signal - cancellation for the store and delivery operations.
 * @returns the message's delivery state after the retry attempt.
 * @throws WorkspaceMessageError when messageId is missing.
 * @throws WorkspaceRecordError when the workspace holds no such message.
 */
async function retryMessage(
  ctx: Context,
  workspace: Workspace,
  session: Session,
  messageId: string | undefined,
  signal: AbortSignal | undefined,
): Promise<SentMessage> {
  const id = messageId?.trim() ?? ''
  if (id === '') {
    throw new WorkspaceMessageError(
      'workspace_message with action "retry" requires messageId of the failed message',
      'WORKSPACE_MESSAGE_INVALID',
    )
  }
  const stored = await readMessage(ctx, workspace.id, id, signal)
  if (stored === undefined) {
    throw new WorkspaceRecordError(
      `workspace ${String(workspace.id)} holds no message ${JSON.stringify(id)}`,
      'WORKSPACE_RECORD_NOT_FOUND',
    )
  }
  const record = stored.message
  if (record.status !== 'failed') return sentOf(record)
  const attempts = (record.attempts ?? 1) + 1
  if (!workspace.sessionIds.some(sessionId => String(sessionId) === record.targetSessionId)) {
    return await persistedRetryFailure(
      ctx, workspace, record, session, stored.version, attempts,
      `session ${record.targetSessionId} is no longer a session of workspace ${String(workspace.id)}`,
    )
  }
  if (isArchivedSession(ctx, record.targetSessionId)) {
    return await persistedRetryFailure(
      ctx, workspace, record, session, stored.version, attempts,
      `target session ${record.targetSessionId} is archived`,
    )
  }
  const delivery = messageDeliveryController(ctx)
  if (delivery === undefined) {
    return await persistedRetryFailure(
      ctx, workspace, record, session, stored.version, attempts,
      'the host session controller is not mounted, so the message cannot be re-delivered',
    )
  }
  const outcome = await admit(
    ctx,
    delivery,
    record.messageId,
    record.targetSessionId,
    record.priority,
    deliveryHeader(workspace, record.sourceRole ?? 'agent', record.sourceSessionId, record.taskId),
    record.text,
    signal,
  )
  if (!outcome.accepted) {
    return await persistedRetryFailure(
      ctx, workspace, record, session, stored.version, attempts,
      outcome.error ?? 'the host session controller declined the message',
    )
  }
  const deliveredAt = new Date().toISOString()
  const delivered: MessageRecord = {
    ...record,
    status: 'delivered',
    deliveredAt,
    error: undefined,
    attempts,
    receipts: [...record.receipts, { at: deliveredAt, status: 'delivered' }],
  }
  await writeMessage(ctx, workspace.id, delivered, {
    session,
    ...stored.version === undefined ? {} : { expected: stored.version },
  })
  return sentOf(delivered)
}

/**
 * Persist one retry attempt that could not reach the host controller.
 * @param ctx - context carrying the store.
 * @param workspace - workspace that owns the message.
 * @param record - the failed message being retried.
 * @param session - Session asking for the retry.
 * @param expected - store version read before the retry.
 * @param attempts - attempt count including this one.
 * @param reason - readable failure reason.
 * @returns the updated `failed` send result.
 */
async function persistedRetryFailure(
  ctx: Context,
  workspace: Workspace,
  record: MessageRecord,
  session: Session,
  expected: string | undefined,
  attempts: number,
  reason: string,
): Promise<SentMessage> {
  const at = new Date().toISOString()
  const failed: MessageRecord = {
    ...record,
    status: 'failed',
    error: reason,
    attempts,
    receipts: [...record.receipts, { at, status: 'failed' }],
  }
  await writeMessage(ctx, workspace.id, failed, {
    session,
    ...expected === undefined ? {} : { expected },
  })
  return sentOf(failed)
}

/**
 * Read the delivery status of one message.
 *
 * `messageId` selects one message exactly. Without it, the newest message
 * addressed to `targetSessionId` is inspected, so a caller that only knows the
 * receiver can still see the latest delivery state.
 * @param ctx - context carrying the store.
 * @param workspace - workspace that owns the message.
 * @param messageId - message identity, when the caller named one.
 * @param targetSessionId - receiver whose newest message is inspected otherwise.
 * @param signal - cancellation for the store reads.
 * @returns the message's status view.
 * @throws WorkspaceMessageError when neither selector was given.
 * @throws WorkspaceRecordError when no matching message exists.
 */
async function statusMessage(
  ctx: Context,
  workspace: Workspace,
  messageId: string | undefined,
  targetSessionId: string | undefined,
  signal: AbortSignal | undefined,
): Promise<MessageView> {
  if (messageId !== undefined) return await readOneMessage(ctx, workspace, messageId, signal)
  const target = targetSessionId?.trim() ?? ''
  if (target === '') {
    throw new WorkspaceMessageError(
      'workspace_message with action "status" requires messageId or targetSessionId',
      'WORKSPACE_MESSAGE_INVALID',
    )
  }
  const newest = (await listMessages(ctx, workspace.id, signal))
    .find(message => message.targetSessionId === target)
  if (newest === undefined) {
    throw new WorkspaceRecordError(
      `workspace ${String(workspace.id)} holds no message for session ${JSON.stringify(target)}`,
      'WORKSPACE_RECORD_NOT_FOUND',
    )
  }
  return messageView(newest)
}

/**
 * Hand one message to the host controller.
 *
 * A normal message queues for the target's next turn boundary. An urgent one
 * first tries to steer the running step and falls back to the queue when the
 * target is idle, recording the same request identity either way. A thrown
 * refusal becomes the outcome's readable reason instead of escaping the call.
 * @param ctx - context, for the debug log on an urgent fallback.
 * @param delivery - host Session controller.
 * @param messageId - stable message id the request identity derives from.
 * @param targetSessionId - receiving Session.
 * @param priority - normal or urgent.
 * @param header - sender header naming the sender, its role, and where to reply.
 * @param text - message body.
 * @param signal - cancellation for the admission.
 * @returns whether the controller accepted the message, with the failure reason when it did not.
 */
async function admit(
  ctx: Context,
  delivery: NonNullable<ReturnType<typeof messageDeliveryController>>,
  messageId: string,
  targetSessionId: string,
  priority: MessagePriority,
  header: string,
  text: string,
  signal: AbortSignal | undefined,
): Promise<DeliveryOutcome> {
  const requestId = `workspace-message-${messageId}`
  const content = [{ type: 'text' as const, text: header }, { type: 'text' as const, text }]
  const admission = signal ?? new AbortController().signal
  if (priority === 'normal') {
    return await requestDelivery(delivery, { requestId, sessionId: targetSessionId, mode: 'queue', content }, admission)
  }
  const steered = await requestDelivery(
    delivery,
    { requestId, sessionId: targetSessionId, mode: 'steer', content },
    admission,
  )
  if (steered.accepted) return steered
  ctx.logger.debug(
    'workspace-tools: urgent steer to %s was refused, queueing instead: %s',
    targetSessionId,
    steered.error ?? 'declined',
  )
  return await requestDelivery(delivery, { requestId, sessionId: targetSessionId, mode: 'queue', content }, admission)
}

/**
 * Resolve artifact citations against the workspace's published references.
 * @param ctx - context carrying the store and filesystem.
 * @param workspace - workspace that owns the artifacts.
 * @param requested - citations named by the sender.
 * @param signal - cancellation for the store reads.
 * @returns the citations captured at send time.
 * @throws WorkspaceRecordError when a cited artifact or version does not exist.
 * @throws WorkspaceMessageError when the citation's hash no longer matches.
 */
async function resolveCitations(
  ctx: Context,
  workspace: Workspace,
  requested: readonly { readonly artifactId: string; readonly version?: number; readonly sha256?: string }[] | undefined,
  signal: AbortSignal | undefined,
): Promise<ArtifactCitation[]> {
  const citations: ArtifactCitation[] = []
  for (const citation of requested ?? []) {
    const stored = await readArtifact(ctx, workspace.id, citation.artifactId, signal)
    const reference = stored === undefined ? undefined : artifactVersion(stored.record, citation.version)
    if (reference === undefined) {
      throw new WorkspaceRecordError(
        `workspace ${String(workspace.id)} holds no artifact ${JSON.stringify(citation.artifactId)}`
        + (citation.version === undefined ? '' : ` version ${String(citation.version)}`),
        'WORKSPACE_RECORD_NOT_FOUND',
      )
    }
    if (citation.sha256 !== undefined && citation.sha256 !== reference.sha256) {
      throw new WorkspaceMessageError(
        `artifact ${citation.artifactId} v${String(reference.version)} has sha256 ${reference.sha256}, `
        + `not the cited ${citation.sha256}; publish the current file and cite that version`,
        'WORKSPACE_MESSAGE_INVALID',
      )
    }
    citations.push({ artifactId: reference.artifactId, version: reference.version, sha256: reference.sha256 })
  }
  return citations
}

/**
 * Project one sent record into the send result.
 * @param message - the durable message.
 * @returns the send result.
 */
function sentOf(message: MessageRecord): SentMessage {
  return {
    messageId: message.messageId,
    targetSessionId: message.targetSessionId,
    status: message.status,
    ...message.deliveredAt === undefined ? {} : { deliveredAt: message.deliveredAt },
    ...message.error === undefined ? {} : { error: message.error },
    ...message.attempts === undefined ? {} : { attempts: message.attempts },
    references: message.references.map(reference => ({
      artifactId: reference.artifactId,
      version: reference.version,
      sha256: reference.sha256,
    })),
  }
}

/**
 * Read one message and project it into the tool's view.
 * @param ctx - context carrying the store.
 * @param workspace - workspace that owns the message.
 * @param messageId - message identity.
 * @param signal - cancellation for the store read.
 * @returns the message view.
 * @throws WorkspaceRecordError when the workspace holds no such message.
 */
async function readOneMessage(
  ctx: Context,
  workspace: Workspace,
  messageId: string,
  signal: AbortSignal | undefined,
): Promise<MessageView> {
  const stored = await readMessage(ctx, workspace.id, messageId, signal)
  if (stored === undefined) {
    throw new WorkspaceRecordError(
      `workspace ${String(workspace.id)} holds no message ${JSON.stringify(messageId)}`,
      'WORKSPACE_RECORD_NOT_FOUND',
    )
  }
  return messageView(stored.message)
}

/**
 * List one workspace's messages, filtered and paged.
 * @param ctx - context carrying the store.
 * @param workspace - workspace whose messages are listed.
 * @param request - target-session filter, cursor, and page size.
 * @param signal - cancellation for the store reads.
 * @returns the page of message views.
 */
async function listWorkspaceMessages(
  ctx: Context,
  workspace: Workspace,
  request: { readonly targetSessionId?: string; readonly cursor?: string; readonly limit?: number },
  signal: AbortSignal | undefined,
): Promise<{ readonly items: MessageView[]; readonly nextCursor?: string }> {
  const messages = (await listMessages(ctx, workspace.id, signal))
    .filter(message => request.targetSessionId === undefined || message.targetSessionId === request.targetSessionId)
  const page = pageOf(messages.map(messageView), request.limit, request.cursor)
  return { items: page.items, ...page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor } }
}

/**
 * Project one durable message into the tool's view.
 * @param message - the durable message record.
 * @returns the view with receipt and reference arrays.
 */
function messageView(message: MessageRecord): MessageView {
  return {
    messageId: message.messageId,
    targetSessionId: message.targetSessionId,
    sourceSessionId: message.sourceSessionId,
    ...message.sourceRole === undefined ? {} : { sourceRole: message.sourceRole },
    text: message.text,
    kind: message.kind,
    priority: message.priority,
    ...message.urgentReason === undefined ? {} : { urgentReason: message.urgentReason },
    status: message.status,
    createdAt: message.createdAt,
    ...message.deliveredAt === undefined ? {} : { deliveredAt: message.deliveredAt },
    ...message.error === undefined ? {} : { error: message.error },
    ...message.attempts === undefined ? {} : { attempts: message.attempts },
    ...message.replyTo === undefined ? {} : { replyTo: message.replyTo },
    ...message.taskId === undefined ? {} : { taskId: message.taskId },
    receipts: message.receipts.map(receipt => ({ at: receipt.at, status: receipt.status })),
    references: message.references.map(reference => ({
      artifactId: reference.artifactId,
      version: reference.version,
      sha256: reference.sha256,
    })),
  }
}

/**
 * Render the sender header a delivered message starts with.
 *
 * The receiving agent must know who sent the request, which workspace it came
 * from, and where to reply without inferring any of it from the body. A
 * cross-workspace return names its task; a taskless request names the sending
 * Session, which is the dispatcher to route a question back to.
 * @param workspace - workspace the message was sent from.
 * @param role - sender's role.
 * @param sourceSessionId - sender Session.
 * @param taskId - task the message reports on, when one is bound.
 * @returns the header line.
 */
function deliveryHeader(
  workspace: Workspace,
  role: AgentRole,
  sourceSessionId: string,
  taskId: string | undefined,
): string {
  return `[workspace_message] from ${role} ${sourceSessionId} in ${workspace.title} (${String(workspace.id)})\n`
    + (taskId === undefined ? 'No task bound' : `Task ${taskId}`)
    + ` · reply to ${sourceSessionId} with workspace_message.send`
}

/**
 * Render one message value for the model.
 * @param value - the tool result.
 * @returns the model-facing text.
 */
function renderMessages(value: WorkspaceMessageValue): string {
  if (value.sent !== undefined) {
    const sent = value.sent
    const references = sent.references.length === 0
      ? ''
      : ` · refs ${sent.references.map(reference => `${reference.artifactId} v${String(reference.version)}`).join(', ')}`
    return `Sent ${sent.messageId} to ${sent.targetSessionId} · ${sent.status}`
      + (sent.deliveredAt === undefined ? '' : ` at ${sent.deliveredAt}`)
      + (sent.attempts === undefined ? '' : ` · attempt ${String(sent.attempts)}`)
      + (sent.error === undefined ? '' : ` · error: ${oneLine(sent.error, DELIVERY_ERROR_MAX_CHARS)}`)
      + references
  }
  if (value.message !== undefined) return renderOneMessage(value.message)
  const messages = value.messages ?? []
  if (messages.length === 0) return `No messages in workspace ${value.workspace}.`
  const lines = messages.map(message => `- ${renderOneMessage(message)}`)
  if (value.nextCursor !== undefined) lines.push(`(more messages: pass cursor ${value.nextCursor})`)
  return lines.join('\n')
}

/**
 * Render one message's delivery state, failure reason, attempts, receipts, and
 * citations as the multi-line body shared by `read` and `status`.
 * @param message - the message view.
 * @returns the model-facing text.
 */
function renderOneMessage(message: MessageView): string {
  const receipts = message.receipts.length === 0
    ? 'no receipts'
    : message.receipts.map(receipt => `${receipt.at} ${receipt.status}`).join('; ')
  const references = message.references.length === 0
    ? ''
    : ` · refs ${message.references.map(reference => `${reference.artifactId} v${String(reference.version)}`).join(', ')}`
  return `${message.messageId} · ${message.kind} · ${message.status} · to ${message.targetSessionId}`
    + ` · ${message.createdAt}`
    + (message.attempts === undefined ? '' : ` · attempt ${String(message.attempts)}`)
    + (message.deliveredAt === undefined ? '' : ` · delivered at ${message.deliveredAt}`)
    + references
    + (message.error === undefined ? '' : `\n  error: ${oneLine(message.error, DELIVERY_ERROR_MAX_CHARS)}`)
    + `\n  ${oneLine(message.text, MESSAGE_TEXT_MAX_CHARS)}\n  receipts: ${receipts}`
}
