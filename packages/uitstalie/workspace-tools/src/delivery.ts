/**
 * Delivery seam for `workspace_message.send`.
 *
 * A message becomes real when the host's Session controller admits it into the
 * target Session's inbox. The controller is composed by the host, not by this
 * toolset, so it is read from the context and duck-typed: a deployment without
 * one still records the message (status `queued`) instead of failing the call.
 * The controller's own `requestId` dedupe is reused, so a retried send cannot
 * append the same message twice even when the record write was lost.
 * @module @deepseek-ai/dsh-workspace-tools/delivery
 */

import type { Context } from '@deepseek-ai/cordis'

/** The one controller verb a message send uses. */
export interface MessageDeliveryController {
  /**
   * Admit one text prompt into a Session's inbox.
   * @param request - stable request identity, target Session, delivery mode, and text.
   * @param signal - cancellation for the admission.
   * @returns the host's acknowledgement.
   */
  prompt(request: {
    readonly requestId: string
    readonly sessionId: string
    readonly mode: 'queue' | 'steer'
    readonly content: readonly { readonly type: 'text'; readonly text: string }[]
  }, signal: AbortSignal): Promise<{ readonly accepted: boolean }>
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
