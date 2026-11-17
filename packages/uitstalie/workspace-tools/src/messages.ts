/**
 * `workspace_message`: send a message or follow-up to one Session and read the
 * delivery receipts a workspace holds.
 *
 * Delivery is an explicit tool call: `send` validates the target, the artifact
 * citations, and the caller's scope, then hands the text to the host Session
 * controller. The controller's request identity is derived from the message id,
 * so a retried send cannot append the same message twice. `read` returns one
 * message by id, or a bounded page filtered by target Session, with delivery
 * receipts and artifact citations.
 * @module @deepseek-ai/dsh-workspace-tools/messages
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { WorkspaceMessageError, WorkspaceRecordError } from './errors.ts'
import { isArchivedSession, messageDeliveryController } from './delivery.ts'
import { pageOf } from './paging.ts'
import type { ArtifactCitation, MessageKind, MessagePriority, MessageRecord, UrgentReason } from './records.ts'
import { URGENT_REASONS } from './records.ts'
import { artifactVersion, listMessages, readArtifact, readMessage, readTask, writeMessage } from './store.ts'
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
  /** Message body. */
  readonly text: string
  /** Whether this is a message or a follow-up. */
  readonly kind: 'message' | 'followup'
  /** Effective priority. */
  readonly priority: 'normal' | 'urgent'
  /** Which of the three cases made the message urgent; absent for a normal message. */
  readonly urgentReason?: UrgentReason
  /** Current delivery state. */
  readonly status: 'queued' | 'delivered' | 'interrupted' | 'target_archived'
  /** ISO-8601 creation instant. */
  readonly createdAt: string
  /** ISO-8601 instant the message reached its target. */
  readonly deliveredAt?: string
  /** Message this one answers. */
  readonly replyTo?: string
  /** Task this message reports on. */
  readonly taskId?: string
  /** Delivery observations in report order. */
  readonly receipts: { readonly at: string; readonly status: 'queued' | 'delivered' | 'interrupted' | 'target_archived' }[]
  /** Artifact citations attached at send time. */
  readonly references: { readonly artifactId: string; readonly version: number; readonly sha256: string }[]
}

/** Result of one `send` call. */
export interface SentMessage {
  /** Stable message id. */
  readonly messageId: string
  /** Session the message addresses. */
  readonly targetSessionId: string
  /** Effective delivery state. */
  readonly status: 'queued' | 'delivered' | 'interrupted' | 'target_archived'
  /** ISO-8601 instant the message reached its target. */
  readonly deliveredAt?: string
  /** Citations captured at send time. */
  readonly references: ArtifactCitation[]
}

/** One `workspace_message` result value. */
export interface WorkspaceMessageValue {
  /** Workspace the result belongs to. */
  readonly workspace: string
  /** Messages read, newest first. */
  readonly messages?: MessageView[]
  /** Result of one send. */
  readonly sent?: SentMessage
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
      'Send a message or follow-up to one Session, or read messages a workspace delivered and their receipts. '
      + '`send` requires `targetSessionId`, `text` (at most 600 characters: conclusion, evidence, next step), and '
      + '`requestId`; a repeated `requestId` returns the first result. Same-workspace sends are allowed; a '
      + 'cross-workspace send requires the super agent and the target workspace id. `priority: "urgent"` is limited '
      + 'to an urgentReason: a wrong conclusion being acted on, a stop order for a dangerous operation, or a user '
      + 'instruction change. Attach files with `references` (artifact ids), never pasted content. '
      + '`read` returns one message by id or a page filtered by target session. '
      + 'The caller\'s workspace is the default scope.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['send', 'read'],
        description: '`send` delivers one message; `read` returns messages and receipts.',
      },
      workspace: {
        type: 'string',
        description: 'Registered workspace id to address; defaults to the caller\'s workspace.',
      },
      targetSessionId: {
        type: 'string',
        description: 'Target session for `send`; required there. For `read`, filters the page to one receiver.',
      },
      messageId: {
        type: 'string',
        description: 'Message to read; when present, other read filters are ignored.',
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
        description: 'Idempotency key for `send`; a retry with the same key returns the first result.',
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
                text: { type: 'string', required: true },
                kind: { type: 'string', required: true, enum: ['message', 'followup'] },
                priority: { type: 'string', required: true, enum: ['normal', 'urgent'] },
                urgentReason: { type: 'string', enum: [...URGENT_REASONS] },
                status: { type: 'string', required: true, enum: ['queued', 'delivered', 'interrupted', 'target_archived'] },
                createdAt: { type: 'string', required: true },
                deliveredAt: { type: 'string' },
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
                      status: { type: 'string', required: true, enum: ['queued', 'delivered', 'interrupted', 'target_archived'] },
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
          sent: {
            type: 'object',
            additionalProperties: false,
            properties: {
              messageId: { type: 'string', required: true },
              targetSessionId: { type: 'string', required: true },
              status: { type: 'string', required: true, enum: ['queued', 'delivered', 'interrupted', 'target_archived'] },
              deliveredAt: { type: 'string' },
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
      if (args.action === 'send') {
        const scope = await resolveWorkspace(ctx, session, 'message.send', args.workspace)
        if (scope.crossWorkspace && exec.agent?.role !== 'super') {
          throw new WorkspaceMessageError(
            `a cross-workspace message requires the super agent; session ${String(session.id)} may message only `
            + `workspace ${String(scope.workspace.id)} directly`,
            'WORKSPACE_MESSAGE_FORBIDDEN',
          )
        }
        return {
          workspace: String(scope.workspace.id),
          sent: await sendMessage(ctx, scope.workspace, session, args, exec.signal),
        }
      }
      const scope = await resolveWorkspace(ctx, session, 'message.read', args.workspace)
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
 * Validate, deliver, and record one message.
 *
 * The record is written only after the delivery attempt settles: a failed tool
 * call leaves no half-record, and a retry reuses the deterministic controller
 * request identity so the recipient cannot receive the body twice.
 * @param ctx - context carrying the store, registry, and controller.
 * @param workspace - workspace the message belongs to.
 * @param session - sending Session.
 * @param request - validated send fields.
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
  const requestId = request.requestId?.trim() ?? ''
  if (requestId === '') {
    throw new WorkspaceMessageError(
      'workspace_message with action "send" requires requestId so a retry cannot deliver twice',
      'WORKSPACE_MESSAGE_INVALID',
    )
  }
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
  if (request.taskId !== undefined && await readTask(ctx, workspace.id, request.taskId, signal) === undefined) {
    throw new WorkspaceRecordError(
      `workspace ${String(workspace.id)} holds no task ${JSON.stringify(request.taskId)}`,
      'WORKSPACE_RECORD_NOT_FOUND',
    )
  }
  const references = await resolveCitations(ctx, workspace, request.references, signal)
  const createdAt = new Date().toISOString()
  const messageId = `message-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
  const kind = request.kind ?? 'message'
  const archived = isArchivedSession(ctx, targetSessionId)
  let status: MessageRecord['status'] = 'queued'
  let deliveredAt: string | undefined
  if (!archived) {
    const delivery = messageDeliveryController(ctx)
    if (delivery !== undefined) {
      const admitted = await admit(ctx, delivery, messageId, targetSessionId, priority, text, signal)
      if (admitted) {
        status = 'delivered'
        deliveredAt = new Date().toISOString()
      }
    }
  } else {
    status = 'target_archived'
  }
  const message: MessageRecord = {
    messageId,
    workspaceId: String(workspace.id),
    targetSessionId,
    sourceSessionId: String(session.id),
    text,
    kind,
    priority,
    ...request.urgentReason === undefined ? {} : { urgentReason: request.urgentReason },
    ...request.replyTo === undefined ? {} : { replyTo: request.replyTo },
    references,
    ...request.taskId === undefined ? {} : { taskId: request.taskId },
    requestId,
    status,
    createdAt,
    ...deliveredAt === undefined ? {} : { deliveredAt },
    receipts: [{ at: deliveredAt ?? createdAt, status }],
  }
  await writeMessage(ctx, workspace.id, message, { session })
  return sentOf(message)
}

/**
 * Hand one message to the host controller.
 *
 * A normal message queues for the target's next turn boundary. An urgent one
 * first tries to steer the running step and falls back to the queue when the
 * target is idle, recording the same request identity either way.
 * @param ctx - context, for the debug log on an urgent fallback.
 * @param delivery - host Session controller.
 * @param messageId - stable message id the request identity derives from.
 * @param targetSessionId - receiving Session.
 * @param priority - normal or urgent.
 * @param text - message body.
 * @param signal - cancellation for the admission.
 * @returns whether the controller accepted the message.
 */
async function admit(
  ctx: Context,
  delivery: NonNullable<ReturnType<typeof messageDeliveryController>>,
  messageId: string,
  targetSessionId: string,
  priority: MessagePriority,
  text: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const requestId = `workspace-message-${messageId}`
  const content = [{ type: 'text' as const, text }]
  const admission = signal ?? new AbortController().signal
  if (priority === 'normal') {
    const result = await delivery.prompt({ requestId, sessionId: targetSessionId, mode: 'queue', content }, admission)
    return result.accepted
  }
  try {
    const result = await delivery.prompt({ requestId, sessionId: targetSessionId, mode: 'steer', content }, admission)
    return result.accepted
  } catch (error: unknown) {
    ctx.logger.debug(
      'workspace-tools: urgent steer to %s was refused, queueing instead: %s',
      targetSessionId,
      error instanceof Error ? error.message : String(error),
    )
    const result = await delivery.prompt({ requestId, sessionId: targetSessionId, mode: 'queue', content }, admission)
    return result.accepted
  }
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
    text: message.text,
    kind: message.kind,
    priority: message.priority,
    ...message.urgentReason === undefined ? {} : { urgentReason: message.urgentReason },
    status: message.status,
    createdAt: message.createdAt,
    ...message.deliveredAt === undefined ? {} : { deliveredAt: message.deliveredAt },
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
      + (sent.deliveredAt === undefined ? '' : ` at ${sent.deliveredAt}`) + references
  }
  const messages = value.messages ?? []
  if (messages.length === 0) return `No messages in workspace ${value.workspace}.`
  const lines = messages.map((message) => {
    const receipts = message.receipts.length === 0
      ? 'no receipts'
      : message.receipts.map(receipt => `${receipt.at} ${receipt.status}`).join('; ')
    const references = message.references.length === 0
      ? ''
      : ` · refs ${message.references.map(reference => `${reference.artifactId} v${String(reference.version)}`).join(', ')}`
    return `- ${message.messageId} · ${message.kind} · ${message.status} · to ${message.targetSessionId}`
      + ` · ${message.createdAt}${references}\n  ${oneLine(message.text, MESSAGE_TEXT_MAX_CHARS)}\n  receipts: ${receipts}`
  })
  if (value.nextCursor !== undefined) lines.push(`(more messages: pass cursor ${value.nextCursor})`)
  return lines.join('\n')
}
