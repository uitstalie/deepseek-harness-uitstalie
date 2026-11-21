/**
 * Scope resolution for the workspace toolset.
 *
 * The calling session's workspace is the default scope: the registry account
 * that lists the session, or the registered workspace whose canonical path
 * equals the session's canonical cwd. A cross-workspace call must name a
 * registered workspace id; every other value is refused with the registration
 * step, so a subdirectory never becomes a workspace by addressing it.
 * @module @deepseek-ai/dsh-workspace-tools/scope
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Workspace, WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import { realpathNormalize } from '@deepseek-ai/dsh-workspace'
import { WorkspaceScopeError } from './errors.ts'

/** The registry operations scope resolution and Session archiving read. */
export type WorkspaceDirectory = Pick<WorkspaceRegistry, 'list' | 'archivedSessionIds' | 'archiveSession'>

/** One resolved scope: the workspace a call addresses and whether it is the caller's. */
export interface WorkspaceScope {
  /** Workspace the call addresses. */
  readonly workspace: Workspace
  /** Whether the caller named another workspace explicitly. */
  readonly crossWorkspace: boolean
}

/**
 * The workspace registry a call reads.
 * @param ctx - context that may carry the workspace registry.
 * @returns the registry operations the toolset uses.
 * @throws WorkspaceScopeError when no workspace registry is mounted.
 */
export function workspaceDirectory(ctx: Context): WorkspaceDirectory {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) {
    throw new WorkspaceScopeError(
      'the workspace toolset requires the workspace registry; mount the workspace plugin in this profile',
      'WORKSPACE_UNKNOWN',
    )
  }
  return registry
}

/**
 * Resolve the workspace one call addresses.
 *
 * A caller-supplied id is matched against the registry only; a directory path,
 * a subdirectory of a registered workspace, and an unknown id all take the
 * registration refusal. A cross-workspace read is recorded in the host log.
 * @param ctx - context carrying the workspace registry and the logger.
 * @param session - calling session, whose workspace is the default scope.
 * @param action - tool action being resolved, for the cross-workspace record.
 * @param requested - workspace id the caller named, when it named one.
 * @returns the resolved workspace and whether it is another workspace.
 * @throws WorkspaceScopeError when the id is unregistered or the caller has no workspace.
 */
export async function resolveWorkspace(
  ctx: Context,
  session: Session,
  action: string,
  requested?: string,
): Promise<WorkspaceScope> {
  const directory = workspaceDirectory(ctx)
  const all = directory.list()
  const requestedId = requested?.trim()
  if (requestedId !== undefined && requestedId.length > 0) {
    const match = all.find(workspace => String(workspace.id) === requestedId)
    if (match === undefined) {
      throw new WorkspaceScopeError(
        `workspace ${JSON.stringify(requestedId)} is not registered; register the directory as a workspace first `
        + '(a subdirectory of a registered workspace is not a workspace)',
        'WORKSPACE_NOT_REGISTERED',
      )
    }
    const caller = await callerWorkspace(all, session)
    if (caller?.id !== match.id) {
      ctx.logger.info(
        'workspace-tools: cross-workspace %s from session %s into workspace %s',
        action,
        String(session.id),
        String(match.id),
      )
    }
    return { workspace: match, crossWorkspace: caller?.id !== match.id }
  }
  const caller = await callerWorkspace(all, session)
  if (caller === undefined) {
    throw new WorkspaceScopeError(
      `session ${String(session.id)} belongs to no registered workspace; register its directory as a workspace first`,
      'WORKSPACE_UNKNOWN',
    )
  }
  return { workspace: caller, crossWorkspace: false }
}

/**
 * Find the registered workspace that contains one session.
 * @param all - every registered workspace.
 * @param session - session whose workspace is resolved.
 * @returns the account that lists the session, else the path match; undefined when neither matches.
 */
async function callerWorkspace(all: readonly Workspace[], session: Session): Promise<Workspace | undefined> {
  const accounted = all.find(workspace => workspace.sessionIds.includes(session.id))
  if (accounted !== undefined) return accounted
  const cwd = session.header.cwd
  if (cwd === undefined) return undefined
  let canonical: string
  try {
    canonical = await realpathNormalize(cwd)
  } catch (error: unknown) {
    // A session whose directory disappeared keeps its registry account; without one it has no
    // resolvable workspace, so scope resolution reports the registration step instead of guessing.
    if (!(error instanceof Error)) throw error
    return undefined
  }
  return all.find(workspace => workspace.path === canonical)
}

/**
 * Find the registered workspace that lists one Session id.
 *
 * A cross-workspace delivery records the sender's message in the receiver's workspace, while the receiver's reply is
 * recorded where its target lives. Reading only the caller's workspace therefore misses the reply; this lookup names
 * the other side's account from the id alone.
 * @param ctx - context carrying the workspace registry.
 * @param sessionId - session id to locate, branded or plain.
 * @returns the workspace whose account lists the session, or undefined when none does.
 */
export function workspaceOwningSession(ctx: Context, sessionId: string): Workspace | undefined {
  return workspaceDirectory(ctx).list().find(workspace => workspace.sessionIds.some(id => String(id) === sessionId))
}
