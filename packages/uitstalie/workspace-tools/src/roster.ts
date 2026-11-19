/**
 * Session roster: who created each workspace Session and who archived it.
 *
 * The session store owns existence, titles, logs, and liveness, and the
 * workspace registry owns the archived set. This module adds only the two facts
 * those owners cannot express, and reconciles them on every read so a Session
 * created or archived from the UI (by the person, not through a tool call)
 * appears in the roster without any extra action.
 * @module @deepseek-ai/dsh-workspace-tools/roster
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { SessionRosterEntry } from './records.ts'
import { listRoster, writeRoster } from './store.ts'

/** The identity that owns one action: the person, or the calling Session. */
export function actorOf(sessionId: string | undefined): string {
  return sessionId === undefined ? 'user' : `agent:${sessionId}`
}

/**
 * Reconcile the roster with the live session store and the registry archive set.
 *
 * A Session the tool never recorded was created by the person in the UI, so it
 * gets `createdBy: 'user'`. An archived Session without an archive stamp was
 * archived by the person, so it gets `archivedBy: 'user'`. A tool-created or
 * tool-archived Session already carries its actor and is left alone.
 * @param ctx - context carrying the `.dsh` store.
 * @param workspace - workspace whose roster is reconciled.
 * @param known - session ids and their creation instants, from the session store.
 * @param archived - session ids the registry counts as archived.
 * @param signal - cancellation for the store reads and writes.
 * @returns every roster entry keyed by session id, including the reconciled ones.
 */
export async function reconcileRoster(
  ctx: Context,
  workspace: Workspace,
  known: ReadonlyMap<string, string>,
  archived: ReadonlySet<string>,
  signal: AbortSignal | undefined,
): Promise<Map<string, SessionRosterEntry>> {
  const entries = new Map((await listRoster(ctx, workspace.id, signal)).map(entry => [entry.sessionId, entry]))
  const now = new Date().toISOString()
  for (const [sessionId, createdAt] of known) {
    const existing = entries.get(sessionId)
    if (existing === undefined) {
      const entry: SessionRosterEntry = {
        sessionId,
        workspaceId: String(workspace.id),
        createdBy: 'user',
        createdAt,
        observedAt: now,
        ...archived.has(sessionId) ? { archivedBy: 'user', archivedAt: now } : {},
      }
      await writeRoster(ctx, workspace.id, entry)
      entries.set(sessionId, entry)
      continue
    }
    if (!archived.has(sessionId)) {
      // An unarchive in the UI clears the current archive stamp; the roster is current state,
      // not an audit log, so it must not keep claiming the Session is archived.
      if (existing.archivedAt === undefined && existing.archivedBy === undefined) continue
      const next: SessionRosterEntry = {
        sessionId: existing.sessionId,
        workspaceId: existing.workspaceId,
        ...existing.createdBy === undefined ? {} : { createdBy: existing.createdBy },
        ...existing.createdAt === undefined ? {} : { createdAt: existing.createdAt },
        ...existing.forkedFrom === undefined ? {} : { forkedFrom: existing.forkedFrom },
        observedAt: now,
      }
      await writeRoster(ctx, workspace.id, next)
      entries.set(sessionId, next)
      continue
    }
    if (existing.archivedAt !== undefined) continue
    const next: SessionRosterEntry = {
      ...existing,
      archivedBy: 'user',
      archivedAt: now,
      observedAt: now,
    }
    await writeRoster(ctx, workspace.id, next)
    entries.set(sessionId, next)
  }
  return entries
}

/**
 * Record a Session this tool created.
 * @param ctx - context carrying the `.dsh` store.
 * @param workspace - workspace that accounts for the Session.
 * @param sessionId - created Session.
 * @param actor - `agent:<sessionId>` of the caller.
 * @param createdAt - ISO-8601 creation instant.
 */
export async function noteRosterStart(
  ctx: Context,
  workspace: Workspace,
  sessionId: string,
  actor: string,
  createdAt: string,
): Promise<void> {
  await upsertRoster(ctx, workspace, sessionId, entry => ({
    ...entry,
    createdBy: actor,
    createdAt: entry.createdAt ?? createdAt,
  }))
}

/**
 * Record a Session this tool archived.
 * @param ctx - context carrying the `.dsh` store.
 * @param workspace - workspace that accounts for the Session.
 * @param sessionId - archived Session.
 * @param actor - `agent:<sessionId>` of the caller.
 */
export async function noteRosterArchive(
  ctx: Context,
  workspace: Workspace,
  sessionId: string,
  actor: string,
): Promise<void> {
  await upsertRoster(ctx, workspace, sessionId, entry => ({
    ...entry,
    archivedBy: actor,
    archivedAt: entry.archivedAt ?? new Date().toISOString(),
  }))
}

/**
 * Record a Session this tool branched.
 * @param ctx - context carrying the `.dsh` store.
 * @param workspace - workspace that accounts for the Session.
 * @param sessionId - new Session.
 * @param parentSessionId - Session it was branched from.
 * @param actor - `agent:<sessionId>` of the caller.
 * @param createdAt - ISO-8601 creation instant.
 */
export async function noteRosterFork(
  ctx: Context,
  workspace: Workspace,
  sessionId: string,
  parentSessionId: string,
  actor: string,
  createdAt: string,
): Promise<void> {
  await upsertRoster(ctx, workspace, sessionId, entry => ({
    ...entry,
    createdBy: actor,
    createdAt: entry.createdAt ?? createdAt,
    forkedFrom: parentSessionId,
  }))
}

/**
 * Read one entry, apply a mutation, and write it back.
 * @param ctx - context carrying the `.dsh` store.
 * @param workspace - workspace that accounts for the Session.
 * @param sessionId - Session whose entry is updated.
 * @param change - pure function over the current entry, or the new entry's seed.
 */
async function upsertRoster(
  ctx: Context,
  workspace: Workspace,
  sessionId: string,
  change: (entry: SessionRosterEntry) => SessionRosterEntry,
): Promise<void> {
  const current = (await listRoster(ctx, workspace.id)).find(entry => entry.sessionId === sessionId)
  const seed: SessionRosterEntry = current ?? {
    sessionId,
    workspaceId: String(workspace.id),
    observedAt: new Date().toISOString(),
  }
  const next: SessionRosterEntry = { ...change(seed), observedAt: new Date().toISOString() }
  await writeRoster(ctx, workspace.id, next)
}
