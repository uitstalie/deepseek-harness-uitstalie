/**
 * `workspace_message` (read side): delivery receipts for messages a workspace holds.
 *
 * Messages are read from the workspace's own message directory. `read` returns
 * one message by id, or a bounded page filtered by target session, with the
 * delivery receipts it accumulated. It never sends anything; `send` is a
 * separate delivery action.
 * @module @deepseek-ai/dsh-workspace-tools/messages
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { WorkspaceRecordError } from './errors.ts'
import { pageOf } from './paging.ts'
import type { MessageRecord } from './records.ts'
import { resolveWorkspace } from './scope.ts'
import { listMessages, readMessage } from './store.ts'
import { oneLine, requireCallerSession } from './tooling.ts'

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

/** One `workspace_message` result value. */
export interface WorkspaceMessageValue {
  /** Workspace the result belongs to. */
  readonly workspace: string
  /** Messages read, newest first. */
  readonly messages: MessageView[]
  /** Cursor of the next page. */
  readonly nextCursor?: string
}

/**
 * Build `workspace_message`.
 * @param ctx - context carrying the store.
 * @returns the tool definition.
 */
export function workspaceMessageTool(ctx: Context): ToolDefinition {
  return defineTool({
    name: 'workspace_message',
    description:
      'Read messages a workspace delivered, and their delivery receipts. Pass `messageId` for one message, '
      + 'or `targetSessionId` to page the messages one session received. The caller\'s workspace is the default '
      + 'scope; reading another workspace requires its registered id. This action never sends anything.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['read'],
        description: 'Only `read` is available; delivery is a separate action.',
      },
      workspace: {
        type: 'string',
        description: 'Registered workspace id to read; defaults to the caller\'s workspace.',
      },
      messageId: {
        type: 'string',
        description: 'Message to read; when present, other filters are ignored.',
      },
      targetSessionId: {
        type: 'string',
        description: 'Only read messages addressed to this session.',
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
            required: true,
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
          nextCursor: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderMessages(value) }],
    },
    async execute(args, exec) {
      const session = requireCallerSession(exec.agent?.session, 'workspace_message')
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
 * @returns the view with mutable receipt and reference arrays.
 */
function messageView(message: MessageRecord): MessageView {
  return {
    messageId: message.messageId,
    targetSessionId: message.targetSessionId,
    sourceSessionId: message.sourceSessionId,
    text: message.text,
    kind: message.kind,
    priority: message.priority,
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
  if (value.messages.length === 0) return `No messages in workspace ${value.workspace}.`
  const lines = value.messages.map((message) => {
    const receipts = message.receipts.length === 0
      ? 'no receipts'
      : message.receipts.map(receipt => `${receipt.at} ${receipt.status}`).join('; ')
    const references = message.references.length === 0
      ? ''
      : ` · refs ${message.references.map(reference => `${reference.artifactId} v${String(reference.version)}`).join(', ')}`
    return `- ${message.messageId} · ${message.kind} · ${message.status} · to ${message.targetSessionId}`
      + ` · ${message.createdAt}${references}\n  ${oneLine(message.text, 600)}\n  receipts: ${receipts}`
  })
  if (value.nextCursor !== undefined) lines.push(`(more messages: pass cursor ${value.nextCursor})`)
  return lines.join('\n')
}
