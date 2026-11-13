/**
 * Deterministic automatic cleanup for the active memory block: TTL, explicit
 * supersession, and obvious same-turn duplication. The planner is pure; the
 * repository writes its archive records before the active file so a failed
 * archive never silently loses an entry.
 *
 * Order is fixed: TTL first, then supersession, then same-turn deduplication.
 * Capacity eviction remains the repository's last step. Only `open` and `files`
 * entries are eligible for automatic rules; `decision` and `preference` leave
 * only through an explicit forget or resolve.
 * @module @deepseek-ai/dsh-memory/cleanup
 */

import {
  normalizeEntryTags,
  memoryArchiveRecord,
  pruneEmptyMemorySessions,
  removeMemoryEntry,
} from './memory-file.ts'
import type {
  MemoryArchiveRecord,
  MemoryDocument,
  MemoryEntry,
  MemoryEntryKind,
  MemorySection,
} from './memory-file.ts'

/** Milliseconds in one TTL day. */
const DAY_MS = 24 * 60 * 60 * 1000

/** Default TTL of `open` entries, in days. */
export const DEFAULT_MEMORY_OPEN_TTL_DAYS = 3

/** Default TTL of `files` entries, in days. */
export const DEFAULT_MEMORY_FILES_TTL_DAYS = 14

/** Default number of shared tags required for an implicit supersession. */
export const DEFAULT_MEMORY_SUPERSESSION_MIN_SHARED_TAGS = 2

/** The newer entry that may supersede older siblings. */
export interface MemoryCleanupNewerEntry {
  /** Session the new entry belongs to. */
  readonly sessionId: string
  /** Turn of the new entry. */
  readonly turn: number
  /** Kind of the new entry. */
  readonly kind: MemoryEntryKind
  /** Labels of the new entry. */
  readonly tags?: readonly string[]
  /** Tags that explicitly name the older entries this write replaces. */
  readonly supersedes?: readonly string[]
}

/** Inputs of one deterministic cleanup pass. */
export interface MemoryCleanupOptions {
  /** Clock to evaluate TTL against; defaults to now. */
  readonly now?: Date
  /** TTL of `open` entries in days; 0 disables the rule. Defaults to 3. */
  readonly openTtlDays?: number
  /** TTL of `files` entries in days; 0 disables the rule. Defaults to 14. */
  readonly filesTtlDays?: number
  /** Shared tags required when no explicit `supersedes` tag is given. Defaults to 2. */
  readonly supersessionMinSharedTags?: number
  /** Event time per entry, from the session turn log; absent falls back to the session `updatedAt`. */
  readonly entryTimes?: ReadonlyMap<MemoryEntry, number>
  /** The entry just appended; supersession only considers older turns of the same session. */
  readonly newerEntry?: MemoryCleanupNewerEntry
}

/** Counts of the automatic rules applied by one pass. */
export interface MemoryCleanupCounts {
  /** Entries removed by kind TTL. */
  readonly ttl: number
  /** Entries removed by same-kind supersession. */
  readonly superseded: number
  /** Entries removed as obvious same-turn duplicates. */
  readonly duplicate: number
}

/** Result of one automatic cleanup pass. */
export interface MemoryCleanupResult {
  /** Active document after the removals. */
  readonly document: MemoryDocument
  /** Archive records for every removal, in rule order. */
  readonly records: readonly MemoryArchiveRecord[]
  /** What each rule removed. */
  readonly counts: MemoryCleanupCounts
}

/** Filter for the explicit resolve channel. */
export interface MemoryResolveFilter {
  /** Session whose entries are resolved. */
  readonly sessionId: string
  /** Kind to resolve; defaults to `open`. */
  readonly kind?: MemoryEntryKind
  /** Only entries attributed to this turn. */
  readonly turn?: number
  /** Only entries carrying this label. */
  readonly tag?: string
  /** Required when neither `turn` nor `tag` is supplied. */
  readonly all?: boolean
}

/** Result of one explicit resolve. */
export interface MemoryResolveResult {
  /** Active document after the removals. */
  readonly document: MemoryDocument
  /** Archive records for the resolved entries. */
  readonly records: readonly MemoryArchiveRecord[]
  /** Number of resolved entries. */
  readonly removed: number
}

/**
 * Apply TTL, supersession, and same-turn deduplication in that fixed order.
 *
 * Each removal is returned as a full-text archive record; the caller writes the
 * archive and then the active file. No rule touches a `decision` or
 * `preference`, so the automatic path cannot erase a durable conclusion.
 * @param document - active document after the new entry was appended.
 * @param options - clock, thresholds, entry times, and the just-appended entry.
 * @returns the cleaned document, archive records, and per-rule counts.
 */
export function cleanupMemoryDocument(
  document: MemoryDocument,
  options: MemoryCleanupOptions = {},
): MemoryCleanupResult {
  const now = options.now?.getTime() ?? Date.now()
  const nowIso = new Date(now).toISOString()
  const records: MemoryArchiveRecord[] = []
  const counts = { ttl: 0, superseded: 0, duplicate: 0 }
  const removed = new Set<MemoryEntry>()
  let current = document
  const updatedAt = new Map(document.sessions.map(record => [record.id, Date.parse(record.updatedAt)]))
  const timeOf = (entry: MemoryEntry, section: MemorySection): number | undefined => {
    const fromLog = options.entryTimes?.get(entry)
    if (fromLog !== undefined) return fromLog
    const fallback = updatedAt.get(section.sessionId)
    return fallback === undefined || Number.isNaN(fallback) ? undefined : fallback
  }
  const archive = (section: MemorySection, entry: MemoryEntry, reason: MemoryArchiveRecord['reason'], detail: string): void => {
    const time = timeOf(entry, section)
    records.push(memoryArchiveRecord(
      entry, section, reason, detail, nowIso,
      time === undefined ? undefined : new Date(time).toISOString(),
    ))
    removed.add(entry)
    current = removeActiveEntry(current, entry)
  }

  // 1. TTL: only the two short-lived kinds, and only with a known timestamp.
  for (const section of [...current.sections]) {
    for (const entry of [...section.entries]) {
      if (removed.has(entry)) continue
      const days = entry.kind === 'open'
        ? options.openTtlDays ?? DEFAULT_MEMORY_OPEN_TTL_DAYS
        : entry.kind === 'files' ? options.filesTtlDays ?? DEFAULT_MEMORY_FILES_TTL_DAYS : 0
      if (days <= 0) continue
      const time = timeOf(entry, section)
      if (time === undefined || now - time < days * DAY_MS) continue
      archive(section, entry, 'ttl', `ttl: ${entry.kind} older than ${String(days)} day(s)`)
      counts.ttl += 1
    }
  }

  // 2. Supersession: same session, same short-lived kind, older turn.
  const newer = options.newerEntry
  if (newer !== undefined && (newer.kind === 'open' || newer.kind === 'files')) {
    const newTags = new Set(normalizeEntryTags(newer.tags ?? []))
    const explicit = new Set(normalizeEntryTags(newer.supersedes ?? []))
    const minShared = Math.max(1, Math.floor(options.supersessionMinSharedTags
      ?? DEFAULT_MEMORY_SUPERSESSION_MIN_SHARED_TAGS))
    for (const section of [...current.sections]) {
      if (section.sessionId !== newer.sessionId) continue
      for (const entry of [...section.entries]) {
        if (removed.has(entry) || entry.kind !== newer.kind) continue
        if (entry.turn === undefined || entry.turn >= newer.turn) continue
        const oldTags = new Set(normalizeEntryTags(entry.tags ?? []))
        const explicitHit = [...explicit].some(tag => oldTags.has(tag))
        const shared = [...newTags].filter(tag => oldTags.has(tag)).length
        const union = new Set([...newTags, ...oldTags]).size
        const implicitHit = newTags.size >= minShared
          && oldTags.size >= minShared
          && shared >= minShared
          && shared * 2 >= union
        if (!explicitHit && !implicitHit) continue
        archive(section, entry, 'superseded', explicitHit
          ? 'superseded: explicit supersedes tag'
          : `superseded: ${String(shared)} shared tag(s)`)
        counts.superseded += 1
      }
    }
  }

  // 3. Same-turn deduplication: only strong shared identifiers.
  const groups = new Map<string, MemoryEntry[]>()
  for (const section of current.sections) {
    for (const entry of section.entries) {
      if (removed.has(entry) || (entry.kind !== 'open' && entry.kind !== 'files')) continue
      if (entry.turn === undefined) continue
      const key = `${section.sessionId}\u0000${String(entry.turn)}\u0000${entry.kind}`
      const group = groups.get(key)
      if (group === undefined) groups.set(key, [entry])
      else group.push(entry)
    }
  }
  for (const group of groups.values()) {
    const kept: MemoryEntry[] = []
    for (const entry of group) {
      const duplicateOf = kept.find(candidate => isObviousDuplicate(candidate, entry))
      if (duplicateOf === undefined) {
        kept.push(entry)
        continue
      }
      const [keep, drop] = keepLonger(duplicateOf, entry)
      if (keep === duplicateOf) {
        kept[kept.indexOf(duplicateOf)] = keep
      }
      if (removed.has(drop)) continue
      const detail = duplicateDetail(keep, drop)
      const section = sectionOf(current, drop)
      if (section === undefined) continue
      archive(section, drop, 'duplicate', detail)
      counts.duplicate += 1
    }
  }

  current = pruneEmptyMemorySessions(current)
  return { document: current, records: records, counts }
}

/**
 * Resolve entries explicitly and archive them.
 *
 * A resolve without `turn` or `tag` requires `all: true`; that keeps one tool
 * call from archiving an entire kind by accident.
 * @param document - active document.
 * @param filter - session, kind, and one narrowing condition.
 * @returns the cleaned document, records, and resolved count.
 * @throws Error when the filter is under-specified or names an empty tag.
 */
export function resolveMemoryEntries(
  document: MemoryDocument,
  filter: MemoryResolveFilter,
): MemoryResolveResult {
  const kind = filter.kind ?? 'open'
  if (filter.turn === undefined && filter.tag === undefined && filter.all !== true) {
    throw new Error('memory_resolve needs turn, tag, or all: true')
  }
  if (filter.tag !== undefined && filter.tag.trim() === '') {
    throw new Error('memory_resolve tag must not be empty')
  }
  const tag = filter.tag?.trim()
  const nowIso = new Date().toISOString()
  const records: MemoryArchiveRecord[] = []
  let current = document
  for (const section of [...document.sections]) {
    if (section.sessionId !== filter.sessionId) continue
    for (const entry of [...section.entries]) {
      if (entry.kind !== kind) continue
      if (filter.turn !== undefined && entry.turn !== filter.turn) continue
      if (tag !== undefined && !(entry.tags ?? []).includes(tag)) continue
      const detail = [
        `kind=${kind}`,
        ...filter.turn === undefined ? [] : [`turn=${String(filter.turn)}`],
        ...tag === undefined ? [] : [`tag=${JSON.stringify(tag)}`],
      ].join(', ')
      records.push(memoryArchiveRecord(entry, section, 'resolved', `resolved (${detail})`, nowIso))
      current = removeActiveEntry(current, entry)
    }
  }
  current = pruneEmptyMemorySessions(current)
  return { document: current, records: records, removed: records.length }
}

/** Find the current section holding one entry and remove it. */
function removeActiveEntry(document: MemoryDocument, entry: MemoryEntry): MemoryDocument {
  for (const section of document.sections) {
    if (section.entries.includes(entry)) return removeMemoryEntry(document, section, entry)
  }
  return document
}

/** Find the current section holding one entry. */
function sectionOf(document: MemoryDocument, entry: MemoryEntry): MemorySection | undefined {
  return document.sections.find(section => section.entries.includes(entry))
}

/** Extract strong duplicate identifiers: commit hashes, plus a lone file path for `files` entries. */
function identifiers(entry: MemoryEntry): { readonly hashes: Set<string>; readonly paths: Set<string> } {
  const hashes = new Set((entry.text.toLowerCase().match(/\b[0-9a-f]{7,40}\b/gu) ?? []))
  const paths = new Set((entry.text.match(FILE_PATH) ?? []).map(path => path.toLowerCase()))
  return { hashes, paths }
}

/** File-like tokens that are strong enough to be duplicate identifiers. */
const FILE_PATH = /[A-Za-z0-9_.\-/]+\.(?:ts|tsx|js|mjs|cjs|json|md|yaml|yml|toml|rs|py|go|java|kt|swift|css|scss|html)\b/gu

/** Whether two same-turn entries share a strong identifier that makes them obvious copies. */
function isObviousDuplicate(left: MemoryEntry, right: MemoryEntry): boolean {
  if (normalizeText(left.text) === normalizeText(right.text)) return false
  const leftIds = identifiers(left)
  const rightIds = identifiers(right)
  if ([...leftIds.hashes].some(hash => rightIds.hashes.has(hash))) return true
  if (left.kind === 'files' && right.kind === 'files'
    && leftIds.paths.size === 1 && rightIds.paths.size === 1
    && [...leftIds.paths][0] === [...rightIds.paths][0]) return true
  return false
}

/** Keep the longer text; on a tie keep the entry that came first. */
function keepLonger(left: MemoryEntry, right: MemoryEntry): readonly [MemoryEntry, MemoryEntry] {
  return right.text.length > left.text.length ? [right, left] : [left, right]
}

/** Name the identifier that made two entries duplicates. */
function duplicateDetail(keep: MemoryEntry, drop: MemoryEntry): string {
  const keepIds = identifiers(keep)
  const dropIds = identifiers(drop)
  const hash = [...dropIds.hashes].find(candidate => keepIds.hashes.has(candidate))
  if (hash !== undefined) return `duplicate: shared commit ${hash}`
  const path = [...dropIds.paths][0] ?? 'unknown path'
  return `duplicate: shared file ${path}`
}

/** Normalize text for the exact-copy check only. */
function normalizeText(text: string): string {
  return text.replaceAll(/\s+/gu, ' ').trim().toLowerCase()
}
