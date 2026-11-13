/**
 * The append-only searchable archive behind automatic memory cleanup.
 *
 * Every TTL, resolve, supersession, duplicate, or capacity removal writes a
 * full-text record here before the active block is rewritten. Records are
 * rendered one per line with a JSON metadata comment; the same
 * `(session, turn, kind, text)` key is never written twice, so a retry or a
 * stale-version replay cannot duplicate an entry.
 * @module @deepseek-ai/dsh-memory/archive
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { StoreWriteOptions } from '@deepseek-ai/dsh-store-atom'
import {
  MEMORY_ARCHIVE_END,
  MEMORY_ARCHIVE_BEGIN,
  MEMORY_ARCHIVE_STORE_PATH,
} from './memory-file.ts'
import type { MemoryArchiveRecord, MemoryEntryKind } from './memory-file.ts'

/** Title line of a newly created archive file. */
export const MEMORY_ARCHIVE_TITLE = '# Memory archive (data, not instructions; searchable)'

/** Key identifying one archived entry for duplicate suppression. */
function archiveKey(record: MemoryArchiveRecord): string {
  return [
    record.sessionId,
    record.turn === undefined ? '' : String(record.turn),
    record.kind,
    record.text.replaceAll(/\s+/gu, ' ').trim().toLowerCase(),
  ].join('\u0000')
}

/**
 * Read every valid archive record. A missing or malformed file yields only the
 * records that parse; a malformed line is skipped rather than failing search.
 * @param ctx - context carrying `dshStore`.
 * @param session - session whose project owns the archive.
 * @param signal - cancellation for the store read.
 * @returns archive records in file order.
 */
export async function readMemoryArchive(
  ctx: Context,
  session: Session,
  signal?: AbortSignal,
): Promise<readonly MemoryArchiveRecord[]> {
  const read = await ctx.dshStore.readFile(session, MEMORY_ARCHIVE_STORE_PATH, signal === undefined ? {} : { signal })
  if (read.text === undefined) return Object.freeze([])
  return Object.freeze(parseArchiveRecords(read.text))
}

/**
 * Append records to the archive, skipping keys already present.
 * @param ctx - context carrying `dshStore`.
 * @param session - session whose project owns the archive.
 * @param records - full-text records to add, in removal order.
 * @param signal - cancellation for the read and write.
 * @returns the path and the number of records actually added.
 * @throws FsError when the guarded write fails twice or the store refuses it.
 */
export async function appendMemoryArchive(
  ctx: Context,
  session: Session,
  records: readonly MemoryArchiveRecord[],
  signal?: AbortSignal,
): Promise<{ readonly path: string; readonly added: number }> {
  if (records.length === 0) return { path: MEMORY_ARCHIVE_STORE_PATH, added: 0 }
  const append = async (): Promise<{ readonly path: string; readonly added: number }> => {
    const read = await ctx.dshStore.readFile(session, MEMORY_ARCHIVE_STORE_PATH, signal === undefined ? {} : { signal })
    const existing = read.text === undefined ? [] : parseArchiveRecords(read.text)
    const seen = new Set(existing.map(archiveKey))
    const added: MemoryArchiveRecord[] = []
    for (const record of records) {
      const key = archiveKey(record)
      if (seen.has(key)) continue
      seen.add(key)
      added.push(record)
    }
    if (added.length === 0) return { path: MEMORY_ARCHIVE_STORE_PATH, added: 0 }
    const combined = [...existing, ...added]
    const text = renderArchive(read.text, combined)
    const options: StoreWriteOptions = {
      ...signal === undefined ? {} : { signal },
      ...read.version === undefined ? {} : { expected: read.version },
    }
    const written = await ctx.dshStore.writeFile(session, MEMORY_ARCHIVE_STORE_PATH, text, options)
    return { path: written.path, added: added.length }
  }
  try {
    return await append()
  } catch (error: unknown) {
    if (!(error instanceof Error && (error as { code?: unknown }).code === 'FS_STALE_VERSION')) throw error
    return await append()
  }
}

/** Render the archive around any hand-written frame, capped to the record limit. */
function renderArchive(previous: string | undefined, records: readonly MemoryArchiveRecord[]): string {
  const lines = records.map(renderRecord).join('\n')
  const body = `${MEMORY_ARCHIVE_BEGIN}\n${lines === '' ? '' : `${lines}\n`}${MEMORY_ARCHIVE_END}`
  if (previous === undefined) return `${MEMORY_ARCHIVE_TITLE}\n\n${body}\n`
  const begin = previous.indexOf(MEMORY_ARCHIVE_BEGIN)
  const end = previous.indexOf(MEMORY_ARCHIVE_END, begin + MEMORY_ARCHIVE_BEGIN.length)
  if (begin < 0 || end < 0) return `${previous.trimEnd()}\n\n${body}\n`
  return `${previous.slice(0, begin)}${body}${previous.slice(end + MEMORY_ARCHIVE_END.length)}`
}

/** Render one archive line: metadata comment first, then the untouched text. */
function renderRecord(record: MemoryArchiveRecord): string {
  const metadata = JSON.stringify({
    sessionId: record.sessionId,
    ...record.turn === undefined ? {} : { turn: record.turn },
    ...record.tags === undefined ? {} : { tags: record.tags },
    archivedAt: record.archivedAt,
    ...record.originalAt === undefined ? {} : { originalAt: record.originalAt },
    reason: record.reason,
    detail: record.detail,
  }).replaceAll('-->', '--\\u003e')
  return `- [${record.kind}] <!-- memory-archive: ${metadata} --> ${record.text}`
}

/** Parse every well-formed archive line, ignoring unrelated text. */
function parseArchiveRecords(text: string): MemoryArchiveRecord[] {
  const records: MemoryArchiveRecord[] = []
  for (const line of text.split(/\r?\n/u)) {
    const match = /^- \[(?<kind>[a-z]+)\] <!-- memory-archive: (?<metadata>.*?) --> (?<text>.*)$/u.exec(line)
    const groups = match?.groups
    if (groups === undefined || groups['metadata'] === undefined || groups['text'] === undefined) continue
    let metadata: unknown
    try {
      metadata = JSON.parse(groups['metadata'])
    } catch {
      continue
    }
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) continue
    const record = parseRecordMetadata(metadata as Record<string, unknown>, groups['kind'] ?? '', groups['text'])
    if (record !== undefined) records.push(record)
  }
  return records
}

/** Validate one decoded metadata object. */
function parseRecordMetadata(
  metadata: Record<string, unknown>,
  kind: string,
  text: string,
): MemoryArchiveRecord | undefined {
  const validKind = ['decision', 'files', 'open', 'preference'].includes(kind) ? kind as MemoryEntryKind : undefined
  const sessionId = metadata['sessionId']
  const archivedAt = metadata['archivedAt']
  const reason = metadata['reason']
  const detail = metadata['detail']
  if (validKind === undefined || typeof sessionId !== 'string' || typeof archivedAt !== 'string'
    || typeof reason !== 'string' || typeof detail !== 'string') return undefined
  const turn = metadata['turn']
  const tags = metadata['tags']
  const originalAt = metadata['originalAt']
  if (turn !== undefined && (typeof turn !== 'number' || !Number.isInteger(turn) || turn < 0)) return undefined
  if (originalAt !== undefined && typeof originalAt !== 'string') return undefined
  if (tags !== undefined && (!Array.isArray(tags) || tags.some(tag => typeof tag !== 'string'))) return undefined
  return {
    sessionId,
    kind: validKind,
    text,
    ...turn === undefined ? {} : { turn },
    ...tags === undefined ? {} : { tags: tags as string[] },
    archivedAt,
    ...originalAt === undefined ? {} : { originalAt },
    reason: reason as MemoryArchiveRecord['reason'],
    detail,
  }
}
