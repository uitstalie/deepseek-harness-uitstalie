/**
 * Cross-workspace dispatch relations: every delivery into another workspace is
 * recorded in the receiving workspace, and the receiving Session's reply is
 * authorized by that record instead of a pre-created task.
 *
 * A relation is written by `workspace_sessions.run`/`start`/`append`/`prompt`/
 * `abort` and by `workspace_message.send`/`retry` when the delivery crosses
 * workspaces, and read back by `workspace_message.send` before a reply. It is
 * one durable file per (sender, receiver) pair, so a host restart or a Session
 * reload keeps the reply path open. Same-workspace deliveries record nothing
 * because they never need one.
 * @module @deepseek-ai/dsh-workspace-tools/dispatch
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AgentRole } from '@deepseek-ai/dsh-agent'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { DispatchRelation } from './records.ts'
import { workspaceDirectory } from './scope.ts'
import { readDispatchRelation, recordDispatchRelation } from './store.ts'

/** One delivery that just reached a Session. */
export interface DeliveryNote {
  /** Session that sent the delivery. */
  readonly sourceSessionId: string
  /** Session the delivery reached. */
  readonly targetSessionId: string
  /** Role the sender held. */
  readonly sourceRole?: AgentRole | undefined
  /** Lifecycle action or message action that made the delivery. */
  readonly action: string
}

/**
 * Find the registered workspace that accounts for one Session.
 * @param ctx - context carrying the workspace registry.
 * @param sessionId - Session to look up.
 * @returns the owning workspace, or undefined when no registration lists the Session.
 */
export function workspaceOfSession(ctx: Context, sessionId: string): Workspace | undefined {
  const directory = workspaceDirectory(ctx)
  return directory.list().find(workspace => workspace.sessionIds.some(id => String(id) === sessionId))
}

/**
 * Record one delivery when it crossed workspaces.
 * @param ctx - context carrying the store and registry.
 * @param targetWorkspace - workspace that received the delivery.
 * @param note - sender, receiver, role, and action.
 * @param signal - cancellation for the store read and write.
 * @returns the recorded relation, or undefined for a same-workspace delivery.
 */
export async function noteDispatch(
  ctx: Context,
  targetWorkspace: Workspace,
  note: DeliveryNote,
  signal?: AbortSignal,
): Promise<DispatchRelation | undefined> {
  const source = workspaceOfSession(ctx, note.sourceSessionId)
  if (source !== undefined && String(source.id) === String(targetWorkspace.id)) return undefined
  return await recordDispatchRelation(ctx, targetWorkspace.id, {
    sourceSessionId: note.sourceSessionId,
    targetSessionId: note.targetSessionId,
    ...source === undefined ? {} : { sourceWorkspaceId: String(source.id) },
    ...note.sourceRole === undefined ? {} : { sourceRole: note.sourceRole },
    lastAction: note.action,
  }, signal === undefined ? {} : { signal })
}

/**
 * Whether the caller may reply to one Session without a task binding.
 *
 * The caller's own workspace must record a delivery from the target Session to
 * the caller, which every cross-workspace delivery writes; the relation is
 * durable, so a reload does not drop the reply right.
 * @param ctx - context carrying the store and registry.
 * @param callerWorkspace - workspace that accounts for the replying Session.
 * @param callerSessionId - Session doing the reply.
 * @param targetSessionId - Session the reply addresses.
 * @param signal - cancellation for the store read.
 * @returns whether a recorded delivery from the target to the caller exists.
 */
export async function hasInboundDelivery(
  ctx: Context,
  callerWorkspace: Workspace,
  callerSessionId: string,
  targetSessionId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  return await readDispatchRelation(ctx, callerWorkspace.id, targetSessionId, callerSessionId, signal) !== undefined
}
