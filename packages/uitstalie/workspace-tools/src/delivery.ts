/**
 * Delivery seam for `workspace_message.send` and `workspace_message.retry`.
 *
 * A message becomes real when the host's Session controller admits it into the
 * target Session's inbox. The controller is composed by the host, not by this
 * toolset, so it is read from the context and duck-typed: a deployment without
 * one still records the message (status `queued`) instead of failing the call.
 * The controller's own `requestId` dedupe is reused, so a retried send cannot
 * append the same message twice even when the record write was lost.
 *
 * The host contract either returns `{ accepted: true }` or throws; both are
 * normalized into one outcome here so a failure can be persisted as a readable
 * `failed` record. A duck-typed deployment may additionally return
 * `accepted: false` (optionally with an `error`) to decline without throwing.
 * @module @deepseek-ai/dsh-workspace-tools/delivery
 */

import type { Context } from '@deepseek-ai/cordis'
import { oneLine } from './tooling.ts'

/** Longest failure reason kept in one message record, in characters. */
export const DELIVERY_ERROR_MAX_CHARS = 300

/** One prompt handed to the host controller. */
export interface MessagePrompt {
  /** Stable request identity derived from the message id. */
  readonly requestId: string
  /** Target Session id. */
  readonly sessionId: string
  /** Queue for the next turn boundary, or steer the running step. */
  readonly mode: 'queue' | 'steer'
  /** Bounded text blocks of the message. */
  readonly content: readonly { readonly type: 'text'; readonly text: string }[]
}

/** Normalized result of one delivery attempt. */
export interface DeliveryOutcome {
  /** Whether the host accepted the message into the target inbox. */
  readonly accepted: boolean
  /** Readable failure reason when the host threw or declined; absent on acceptance. */
  readonly error?: string
}

/** The one controller verb a message send or retry uses. */
export interface MessageDeliveryController {
  /**
   * Admit one text prompt into a Session's inbox.
   * @param request - stable request identity, target Session, delivery mode, and text.
   * @param signal - cancellation for the admission.
   * @returns the host's acknowledgement; a duck-typed controller may decline with `accepted: false` and an optional `error`.
   */
  prompt(request: MessagePrompt, signal: AbortSignal): Promise<{ readonly accepted: boolean; readonly error?: string }>
}

/**
 * Read the host's Session controller, if this deployment mounts one.
 * @param ctx - the plugin context, duck-typed through `get`.
 * @returns the controller when its `prompt` verb is present.
 */
export function messageDeliveryController(ctx: Context): MessageDeliveryController | undefined {
  const get = (ctx as { get?: (key: string) => unknown }).get
  if (typeof get !== 'function') return undefined
  const service = get.call(ctx, 'sessionController') as Partial<MessageDeliveryController> | undefined
  return service !== undefined && typeof service.prompt === 'function'
    ? service as MessageDeliveryController
    : undefined
}

/**
 * Hand one prompt to the host controller and normalize every failure into a
 * readable outcome, so a caller can persist `failed` instead of losing the
 * message to a thrown stack.
 * @param delivery - host Session controller.
 * @param request - message identity, target, mode, and content.
 * @param signal - cancellation for the admission.
 * @returns whether the host accepted the message, with the failure reason when it did not.
 */
export async function requestDelivery(
  delivery: MessageDeliveryController,
  request: MessagePrompt,
  signal: AbortSignal,
): Promise<DeliveryOutcome> {
  try {
    const result = await delivery.prompt(request, signal)
    if (result.accepted) return { accepted: true }
    return {
      accepted: false,
      error: result.error?.trim() || `the host session controller declined the message for session ${request.sessionId}`,
    }
  } catch (error: unknown) {
    return { accepted: false, error: deliveryFailureReason(error) }
  }
}

/**
 * Whether the target Session is archived.
 * @param ctx - context carrying the workspace registry.
 * @param sessionId - target Session id.
 * @returns whether the registry counts the Session as archived.
 */
export function isArchivedSession(ctx: Context, sessionId: string): boolean {
  const directory = ctx.get('workspaceRegistry')
  if (directory === undefined) return false
  return directory.archivedSessionIds.some(id => String(id) === sessionId)
}

/**
 * Render one thrown delivery error as a bounded, one-line failure reason.
 * @param error - whatever the host controller threw.
 * @returns the readable reason.
 */
function deliveryFailureReason(error: unknown): string {
  if (error instanceof Error) {
    const detail = oneLine(error.message, DELIVERY_ERROR_MAX_CHARS)
    return detail.length > 0
      ? detail
      : oneLine(error.name, DELIVERY_ERROR_MAX_CHARS) || 'the host session controller threw an unnamed error'
  }
  const detail = oneLine(String(error), DELIVERY_ERROR_MAX_CHARS)
  return detail.length > 0 ? detail : 'the host session controller threw a non-Error value'
}
