/**
 * Best-effort per-entry timestamps for TTL cleanup.
 *
 * Entries written before timestamps existed carry only a turn number, while the
 * frontmatter session `updatedAt` moves on every write. Reading the turn-start
 * time from the session log recovers the real age without changing the file
 * format; a session that cannot be read simply falls back to the session
 * `updatedAt` in the cleanup planner.
 * @module @deepseek-ai/dsh-memory/entry-times
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { MemoryDocument, MemoryEntry, MemorySection } from './memory-file.ts'

/**
 * Collect turn-start times for entries that can expire.
 * @param ctx - context carrying `sessionQuery` when the composition provides it.
 * @param document - active document whose entries need ages.
 * @param signal - cancellation for the best-effort log reads.
 * @returns event time by entry identity; absent entries use the session fallback.
 */
export async function collectMemoryEntryTimes(
  ctx: Context,
  document: MemoryDocument,
  signal?: AbortSignal,
): Promise<ReadonlyMap<MemoryEntry, number>> {
  const times = new Map<MemoryEntry, number>()
  const query = ctx.get('sessionQuery')
  if (query === undefined) return times
  const sections = new Map<string, MemorySection[]>()
  for (const section of document.sections) {
    if (!section.entries.some(entry => (entry.kind === 'open' || entry.kind === 'files') && entry.turn !== undefined)) continue
    const list = sections.get(section.sessionId)
    if (list === undefined) sections.set(section.sessionId, [section])
    else list.push(section)
  }
  for (const [sessionId, sessionSections] of sections) {
    try {
      using observation = await query.observeSession(SessionId(sessionId), {
        projectionMode: 'none',
        ...signal === undefined ? {} : { signal },
      })
      const turnTimes = new Map<number, number>()
      for (const event of observation.events) {
        if (event.type === 'turn/start') turnTimes.set(event.data.turn, event.time)
      }
      for (const section of sessionSections) {
        for (const entry of section.entries) {
          if (entry.turn === undefined) continue
          const time = turnTimes.get(entry.turn)
          if (time !== undefined) times.set(entry, time)
        }
      }
    } catch {
      // A missing or unreadable historical log falls back to the session timestamp.
    }
  }
  return times
}
