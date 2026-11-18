/**
 * Global memory: the cross-workspace facts and conventions stored at
 * `$DSH_HOME/memory/GLOBAL.md`.
 *
 * The format is one YAML frontmatter block with a positive `version`, the
 * `updatedAt` time of the latest write, and an `entries` sequence. An active
 * entry has exactly the four fields the design names: `topic`,
 * `sourceSessionId`, `createdAt`, and `text`. The topic comes from a closed
 * allowlist, so an entry cannot describe a workspace or a dispatch: those
 * writes are refused with a pointer to the workspace toolset.
 *
 * A newer entry with the same topic archives the older one beside the active
 * file in `GLOBAL.archive.md`, where it stays searchable and is never injected.
 * The active file is capped at 8 KiB; a write that cannot fit fails loudly
 * instead of evicting a fact silently.
 *
 * This module owns the file format and the whole-file operations. The
 * model-facing tools in `tools.ts` and the one-time migration in `migration.ts`
 * both read and write through it, so there is one parser and one renderer.
 * @module @deepseek-ai/dsh-memory/global-memory
 */

import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-error'
import { FsError } from '@deepseek-ai/dsh-fs'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

/** Store-relative path of the global memory file. */
export const GLOBAL_MEMORY_STORE_PATH = 'memory/GLOBAL.md'

/** Store-relative path of the append-only global memory archive. */
export const GLOBAL_MEMORY_ARCHIVE_STORE_PATH = 'memory/GLOBAL.archive.md'

/** Whole-file limit of the active global memory file, in UTF-8 bytes. */
export const GLOBAL_MEMORY_MAX_BYTES = 8 * 1024

/** Maximum `text` of one global entry, in UTF-8 bytes. */
export const GLOBAL_MEMORY_MAX_TEXT_BYTES = GLOBAL_MEMORY_MAX_BYTES

/** Default and maximum number of `memory_search` results. */
export const GLOBAL_MEMORY_SEARCH_LIMIT = 10

/** Maximum rendered size of one `memory_search` result, in UTF-8 bytes. */
export const GLOBAL_MEMORY_SEARCH_MAX_BYTES = 8 * 1024

/** Every accepted topic, in display order. */
export const GLOBAL_MEMORY_TOPICS = [
  'global-model',
  'global-server',
  'global-convention',
  'global-account',
  'global-tooling',
] as const

/** One accepted global-memory topic. */
export type GlobalMemoryTopic = typeof GLOBAL_MEMORY_TOPICS[number]

/** Why an entry left the active file. */
export type GlobalMemoryArchiveReason = 'superseded' | 'manual-forget' | 'migration'

/** Stable failure codes for global memory. */
export type GlobalMemoryErrorCode =
  | 'NOT_GLOBAL_MEMORY'
  | 'GLOBAL_MEMORY_FULL'
  | 'GLOBAL_MEMORY_INVALID_DOCUMENT'
  | 'GLOBAL_MEMORY_UNKNOWN_TOPIC'
  | 'GLOBAL_MEMORY_FILTER_REQUIRED'

/** Typed global-memory failure with an actionable message. */
export class GlobalMemoryError extends HarnessError {
  /**
   * @param message - reason naming the offending value or the tool to use instead.
   * @param code - stable failure kind.
   */
  constructor(message: string, override readonly code: GlobalMemoryErrorCode) {
    super(message, code)
    this.name = 'GlobalMemoryError'
  }
}

/** One active global entry. */
export interface GlobalMemoryEntry {
  /** `gm-` prefixed content hash; unique in the archive, stable across writes. */
  readonly id: string
  /** Topic from {@link GLOBAL_MEMORY_TOPICS}. */
  readonly topic: GlobalMemoryTopic
  /** Session that wrote the entry. */
  readonly sourceSessionId: string
  /** ISO-8601 time the entry was written. */
  readonly createdAt: string
  /** One-line fact or convention. */
  readonly text: string
}

/** One archived global entry, with the rule that removed it. */
export interface GlobalMemoryArchiveEntry extends GlobalMemoryEntry {
  /** ISO-8601 time the entry left the active file. */
  readonly archivedAt: string
  /** Rule that removed the entry. */
  readonly reason: GlobalMemoryArchiveReason
  /** Human-readable account naming the rule and its input. */
  readonly detail: string
}

/** One parsed active global memory document. */
export interface GlobalMemoryDocument {
  /** Positive document revision, incremented on every write. */
  readonly version: number
  /** UTC ISO-8601 time of the latest write. */
  readonly updatedAt: string
  /** Active entries, one per topic, in canonical topic order. */
  readonly entries: readonly GlobalMemoryEntry[]
}

/** One parsed global memory archive. */
export interface GlobalMemoryArchiveDocument {
  /** Positive document revision, incremented on every write. */
  readonly version: number
  /** UTC ISO-8601 time of the latest write. */
  readonly updatedAt: string
  /** Archived entries, oldest first. */
  readonly entries: readonly GlobalMemoryArchiveEntry[]
}

/** One global memory read; the document is absent when the file does not exist. */
export interface GlobalMemoryRead {
  /** Absolute path shown to the user. */
  readonly path: string
  /** Parsed document when the file exists. */
  readonly document?: GlobalMemoryDocument
  /** Opaque store version for the next guarded write. */
  readonly version?: string
}

/** One global archive read; the document is absent when the file does not exist. */
export interface GlobalMemoryArchiveRead {
  /** Absolute path shown to the user. */
  readonly path: string
  /** Parsed document when the file exists. */
  readonly document?: GlobalMemoryArchiveDocument
  /** Opaque store version for the next guarded write. */
  readonly version?: string
}

/** Result of one global-memory write. */
export interface GlobalMemoryWriteResult {
  /** Absolute path of the active file. */
  readonly path: string
  /** Topic that was written. */
  readonly topic: GlobalMemoryTopic
  /** Id of the new active entry. */
  readonly id: string
  /** New document revision. */
  readonly revision: number
  /** Opaque store version after the write. */
  readonly version?: string
  /** Older active entry the write archived, when the topic already existed. */
  readonly archived?: GlobalMemoryArchiveEntry
}

/** One `memory_search` hit. */
export interface GlobalMemorySearchItem {
  /** Entry id. */
  readonly id: string
  /** Entry topic. */
  readonly topic: GlobalMemoryTopic
  /** Entry text. */
  readonly text: string
  /** Session that wrote the entry. */
  readonly sourceSessionId: string
  /** ISO-8601 time the entry was written. */
  readonly createdAt: string
  /** Whether the hit came from the archive. */
  readonly archived?: boolean
  /** Rule that archived the entry, when `archived` is true. */
  readonly reason?: GlobalMemoryArchiveReason
}

/** Result of one `memory_search` call. */
export interface GlobalMemorySearchValue {
  /** The query the results answer. */
  readonly query: string
  /** Ranked results, at most {@link GLOBAL_MEMORY_SEARCH_LIMIT}. */
  readonly items: GlobalMemorySearchItem[]
  /** Whether results were dropped to stay inside the budget. */
  readonly truncated?: boolean
}

/** One forget selector; at least one field is required. */
export interface GlobalMemoryForgetFilter {
  /** Topic whose active entry is archived. */
  readonly topic?: GlobalMemoryTopic
  /** Id of an entry in the active file or the archive. */
  readonly entryId?: string
}

/** Result of one forget call. */
export interface GlobalMemoryForgetResult {
  /** Absolute path the removal was recorded in. */
  readonly path: string
  /** Entries removed. */
  readonly removed: number
  /** Entries remaining in the active file. */
  readonly remaining: number
  /** Topics removed, in canonical order. */
  readonly topics: readonly string[]
}

/**
 * Absolute path of the global memory file under the current harness home.
 * @returns the `memory/GLOBAL.md` path inside the resolved DSH home.
 */
export function globalMemoryPath(): string {
  return join(resolveDshHome(), 'memory', 'GLOBAL.md')
}

/** Absolute path of the global memory archive under the current harness home. */
export function globalMemoryArchivePath(): string {
  return join(resolveDshHome(), 'memory', 'GLOBAL.archive.md')
}

/**
 * Stable entry id: `gm-` plus twelve hex characters of the content hash.
 * @param topic - topic the entry belongs to.
 * @param createdAt - ISO-8601 creation instant included in the hash.
 * @param text - normalized entry text included in the hash.
 * @returns the `gm-`-prefixed twelve-hex-character id.
 */
export function globalMemoryEntryId(topic: GlobalMemoryTopic, createdAt: string, text: string): string {
  return `gm-${createHash('sha256').update(`${topic}\u0000${createdAt}\u0000${text}`).digest('hex').slice(0, 12)}`
}

/** Whether a value is one accepted topic. */
export function isGlobalMemoryTopic(value: unknown): value is GlobalMemoryTopic {
  return typeof value === 'string' && (GLOBAL_MEMORY_TOPICS as readonly string[]).includes(value)
}

/** Canonical topic rank used by render and parse. */
const TOPIC_RANK = new Map<GlobalMemoryTopic, number>(
  GLOBAL_MEMORY_TOPICS.map((topic, index) => [topic, index]),
)

/** Sort active entries into canonical topic order. */
function sortActive(entries: readonly GlobalMemoryEntry[]): readonly GlobalMemoryEntry[] {
  return [...entries].sort((left, right) =>
    (TOPIC_RANK.get(left.topic) ?? 0) - (TOPIC_RANK.get(right.topic) ?? 0))
}

/**
 * Create an empty active document at revision 1.
 * @param now - write instant stamped as `updatedAt`; defaults to the current time.
 * @returns a revision-1 document with no entries.
 */
export function createGlobalMemoryDocument(now: Date = new Date()): GlobalMemoryDocument {
  return { version: 1, updatedAt: now.toISOString(), entries: [] }
}

/**
 * Create an empty archive document at revision 1.
 * @param now - write instant stamped as `updatedAt`; defaults to the current time.
 * @returns a revision-1 archive document with no entries.
 */
export function createGlobalArchiveDocument(now: Date = new Date()): GlobalMemoryArchiveDocument {
  return { version: 1, updatedAt: now.toISOString(), entries: [] }
}

/**
 * Render the active document as canonical file text.
 * @param document - the active document to render.
 * @returns the `---`-delimited YAML frontmatter with entries in canonical topic order.
 */
export function renderGlobalMemoryDocument(document: GlobalMemoryDocument): string {
  const body = stringifyYaml({
    version: document.version,
    updatedAt: document.updatedAt,
    entries: sortActive(document.entries).map(entry => ({
      id: entry.id,
      topic: entry.topic,
      sourceSessionId: entry.sourceSessionId,
      createdAt: entry.createdAt,
      text: entry.text,
    })),
  }, { lineWidth: 0 })
  return `---\n${body}---\n`
}

/**
 * Render the archive as canonical file text.
 * @param document - the archive document to render.
 * @returns the `---`-delimited YAML frontmatter with entries in their stored order.
 */
export function renderGlobalArchiveDocument(document: GlobalMemoryArchiveDocument): string {
  const body = stringifyYaml({
    version: document.version,
    updatedAt: document.updatedAt,
    entries: document.entries.map(entry => ({
      id: entry.id,
      topic: entry.topic,
      sourceSessionId: entry.sourceSessionId,
      createdAt: entry.createdAt,
      text: entry.text,
      archivedAt: entry.archivedAt,
      reason: entry.reason,
      detail: entry.detail,
    })),
  }, { lineWidth: 0 })
  return `---\n${body}---\n`
}

/** Split one `---`-delimited YAML frontmatter block; no trailing body is accepted. */
function splitFrontmatter(text: string, subject: string): string {
  const source = text.replace(/^\uFEFF/u, '')
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?([\s\S]*)$/u.exec(source)
  if (match === null) {
    throw new GlobalMemoryError(`${subject} must start with a YAML frontmatter block delimited by "---"`, 'GLOBAL_MEMORY_INVALID_DOCUMENT')
  }
  if ((match[2] ?? '').trim().length > 0) {
    throw new GlobalMemoryError(`${subject} must contain only the YAML frontmatter`, 'GLOBAL_MEMORY_INVALID_DOCUMENT')
  }
  return match[1] as string
}

/**
 * Parse one active `GLOBAL.md`, rejecting unknown shapes and invalid entries.
 * @param text - the whole file text; a leading BOM and CRLF line endings are accepted.
 * @returns the parsed document with entries in canonical topic order.
 * @throws GlobalMemoryError `GLOBAL_MEMORY_INVALID_DOCUMENT` for a malformed frontmatter block, field, or entry.
 * @throws GlobalMemoryError `GLOBAL_MEMORY_FULL` when the re-rendered document exceeds the whole-file cap.
 */
export function parseGlobalMemoryDocument(text: string): GlobalMemoryDocument {
  const record = parseFrontmatterRecord(text, 'GLOBAL.md')
  const entries: GlobalMemoryEntry[] = []
  const seen = new Set<string>()
  for (const [index, raw] of entriesOf(record, 'GLOBAL.md').entries()) {
    const entry = parseActiveEntry(raw, index)
    if (seen.has(entry.topic)) {
      throw new GlobalMemoryError(`GLOBAL.md has more than one active entry for topic ${JSON.stringify(entry.topic)}`, 'GLOBAL_MEMORY_INVALID_DOCUMENT')
    }
    seen.add(entry.topic)
    entries.push(entry)
  }
  const document: GlobalMemoryDocument = {
    version: versionOf(record, 'GLOBAL.md'),
    updatedAt: updatedAtOf(record, 'GLOBAL.md'),
    entries: sortActive(entries),
  }
  assertGlobalBudget(renderGlobalMemoryDocument(document))
  return document
}

/**
 * Parse one `GLOBAL.archive.md`, rejecting unknown shapes and invalid entries.
 * @param text - the whole archive file text; a leading BOM and CRLF line endings are accepted.
 * @returns the parsed archive with its entries in their stored order.
 * @throws GlobalMemoryError `GLOBAL_MEMORY_INVALID_DOCUMENT` for a malformed block, field, entry, or archive reason.
 */
export function parseGlobalArchiveDocument(text: string): GlobalMemoryArchiveDocument {
  const record = parseFrontmatterRecord(text, 'GLOBAL.archive.md')
  const entries: GlobalMemoryArchiveEntry[] = []
  for (const [index, raw] of entriesOf(record, 'GLOBAL.archive.md').entries()) {
    const entry = parseActiveEntry(raw, index, 'GLOBAL.archive.md')
    const archiveRecord = raw as Record<string, unknown>
    const archivedAt = stringField(archiveRecord, 'archivedAt', `GLOBAL.archive.md.entries[${String(index)}]`)
    if (Number.isNaN(Date.parse(archivedAt))) {
      throw new GlobalMemoryError(`GLOBAL.archive.md.entries[${String(index)}].archivedAt must be an ISO-8601 string`, 'GLOBAL_MEMORY_INVALID_DOCUMENT')
    }
    const reason = archiveRecord['reason']
    if (reason !== 'superseded' && reason !== 'manual-forget' && reason !== 'migration') {
      throw new GlobalMemoryError(`GLOBAL.archive.md.entries[${String(index)}].reason must be superseded, manual-forget, or migration`, 'GLOBAL_MEMORY_INVALID_DOCUMENT')
    }
    const detail = stringField(archiveRecord, 'detail', `GLOBAL.archive.md.entries[${String(index)}]`)
    entries.push({ ...entry, archivedAt, reason, detail })
  }
  return {
    version: versionOf(record, 'GLOBAL.archive.md'),
    updatedAt: updatedAtOf(record, 'GLOBAL.archive.md'),
    entries,
  }
}

/** Parse the frontmatter object itself, rejecting a non-mapping. */
function parseFrontmatterRecord(text: string, subject: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = parseYaml(splitFrontmatter(text, subject))
  } catch (error: unknown) {
    if (error instanceof GlobalMemoryError) throw error
    throw new GlobalMemoryError(`${subject} frontmatter is not valid YAML: ${String(error)}`, 'GLOBAL_MEMORY_INVALID_DOCUMENT')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new GlobalMemoryError(`${subject} frontmatter must be a YAML mapping`, 'GLOBAL_MEMORY_INVALID_DOCUMENT')
  }
  return parsed as Record<string, unknown>
}

/** Read the required positive document revision. */
function versionOf(record: Record<string, unknown>, subject: string): number {
  const version = record['version']
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new GlobalMemoryError(`${subject}.version must be a positive integer`, 'GLOBAL_MEMORY_INVALID_DOCUMENT')
  }
  return version
}

/** Read the required ISO-8601 `updatedAt`. */
function updatedAtOf(record: Record<string, unknown>, subject: string): string {
  const updatedAt = record['updatedAt']
  if (typeof updatedAt !== 'string' || Number.isNaN(Date.parse(updatedAt))) {
    throw new GlobalMemoryError(`${subject}.updatedAt must be a UTC ISO-8601 string`, 'GLOBAL_MEMORY_INVALID_DOCUMENT')
  }
  return updatedAt
}

/** Read the required `entries` sequence. */
function entriesOf(record: Record<string, unknown>, subject: string): unknown[] {
  const entries = record['entries']
  if (!Array.isArray(entries)) {
    throw new GlobalMemoryError(`${subject}.entries must be a sequence`, 'GLOBAL_MEMORY_INVALID_DOCUMENT')
  }
  return entries
}

/** Parse one active entry from a decoded YAML mapping. */
function parseActiveEntry(raw: unknown, index: number, subject = 'GLOBAL.md'): GlobalMemoryEntry {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new GlobalMemoryError(`${subject}.entries[${String(index)}] must be a mapping`, 'GLOBAL_MEMORY_INVALID_DOCUMENT')
  }
  const record = raw as Record<string, unknown>
  const id = stringField(record, 'id', `${subject}.entries[${String(index)}]`)
  const topic = record['topic']
  if (!isGlobalMemoryTopic(topic)) {
    throw new GlobalMemoryError(
      `${subject}.entries[${String(index)}].topic must be one of ${GLOBAL_MEMORY_TOPICS.join(', ')}`,
      'GLOBAL_MEMORY_INVALID_DOCUMENT',
    )
  }
  const sourceSessionId = stringField(record, 'sourceSessionId', `${subject}.entries[${String(index)}]`)
  const createdAt = stringField(record, 'createdAt', `${subject}.entries[${String(index)}]`)
  if (Number.isNaN(Date.parse(createdAt))) {
    throw new GlobalMemoryError(`${subject}.entries[${String(index)}].createdAt must be an ISO-8601 string`, 'GLOBAL_MEMORY_INVALID_DOCUMENT')
  }
  const text = normalizeEntryText(stringField(record, 'text', `${subject}.entries[${String(index)}]`))
  return { id, topic, sourceSessionId, createdAt, text }
}

/** Read one required non-empty string field. */
function stringField(record: Record<string, unknown>, key: string, subject: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new GlobalMemoryError(`${subject}.${key} must be a non-empty string`, 'GLOBAL_MEMORY_INVALID_DOCUMENT')
  }
  return value
}

/** Throw when the rendered active file exceeds the 8 KiB whole-file cap. */
function assertGlobalBudget(rendered: string): void {
  const bytes = Buffer.byteLength(rendered, 'utf8')
  if (bytes > GLOBAL_MEMORY_MAX_BYTES) {
    throw new GlobalMemoryError(
      `GLOBAL_MEMORY_FULL: the rendered global memory file is ${String(bytes)} bytes; the whole-file limit is ${String(GLOBAL_MEMORY_MAX_BYTES)}. Forgetting an older topic with memory_forget frees space.`,
      'GLOBAL_MEMORY_FULL',
    )
  }
}

/**
 * Trim and validate one entry's text.
 * @param text - the raw one-line candidate, trimmed before validation.
 * @returns the trimmed text, otherwise unchanged.
 * @throws GlobalMemoryError `GLOBAL_MEMORY_INVALID_DOCUMENT` when the text is empty, spans lines, or exceeds the byte limit.
 */
export function normalizeEntryText(text: string): string {
  const normalized = text.trim()
  if (normalized.length === 0) {
    throw new GlobalMemoryError('global memory text must not be empty', 'GLOBAL_MEMORY_INVALID_DOCUMENT')
  }
  if (/[\r\n]/u.test(normalized)) {
    throw new GlobalMemoryError('global memory text must be one line', 'GLOBAL_MEMORY_INVALID_DOCUMENT')
  }
  const bytes = Buffer.byteLength(normalized, 'utf8')
  if (bytes > GLOBAL_MEMORY_MAX_TEXT_BYTES) {
    throw new GlobalMemoryError(
      `global memory text is ${String(bytes)} bytes; the limit is ${String(GLOBAL_MEMORY_MAX_TEXT_BYTES)}`,
      'GLOBAL_MEMORY_INVALID_DOCUMENT',
    )
  }
  return normalized
}

/**
 * Read the active global memory file; a missing file is an empty read.
 * @param ctx - plugin context carrying the global store.
 * @param signal - cancellation for the store read.
 * @returns the file path and, when it exists, its parsed document and store version.
 */
export async function readGlobalMemory(ctx: Context, signal?: AbortSignal): Promise<GlobalMemoryRead> {
  const read = await ctx.dshStore.readFile(undefined, GLOBAL_MEMORY_STORE_PATH, {
    scope: 'global',
    ...signal === undefined ? {} : { signal },
  })
  if (read.text === undefined) return { path: globalMemoryPath() }
  return {
    path: globalMemoryPath(),
    document: parseGlobalMemoryDocument(read.text),
    ...read.version === undefined ? {} : { version: read.version },
  }
}

/**
 * Read the global memory archive; a missing file is an empty read.
 * @param ctx - plugin context carrying the global store.
 * @param signal - cancellation for the store read.
 * @returns the archive path and, when it exists, its parsed document and store version.
 */
export async function readGlobalMemoryArchive(ctx: Context, signal?: AbortSignal): Promise<GlobalMemoryArchiveRead> {
  const read = await ctx.dshStore.readFile(undefined, GLOBAL_MEMORY_ARCHIVE_STORE_PATH, {
    scope: 'global',
    ...signal === undefined ? {} : { signal },
  })
  if (read.text === undefined) return { path: globalMemoryArchivePath() }
  return {
    path: globalMemoryArchivePath(),
    document: parseGlobalArchiveDocument(read.text),
    ...read.version === undefined ? {} : { version: read.version },
  }
}

/** Write one active document through the version guard. */
async function writeGlobalDocument(
  ctx: Context,
  document: GlobalMemoryDocument,
  expectedVersion: string | undefined,
  signal: AbortSignal | undefined,
): Promise<{ readonly path: string; readonly version?: string }> {
  const text = renderGlobalMemoryDocument(document)
  assertGlobalBudget(text)
  const written = await ctx.dshStore.writeFile(undefined, GLOBAL_MEMORY_STORE_PATH, text, {
    scope: 'global',
    ...expectedVersion === undefined ? {} : { expected: expectedVersion },
    ...signal === undefined ? {} : { signal },
  })
  return {
    path: globalMemoryPath(),
    ...written.version === undefined ? {} : { version: written.version },
  }
}

/** Write the archive through the version guard. */
async function writeGlobalArchive(
  ctx: Context,
  document: GlobalMemoryArchiveDocument,
  expectedVersion: string | undefined,
  signal: AbortSignal | undefined,
): Promise<{ readonly path: string; readonly version?: string }> {
  const text = renderGlobalArchiveDocument(document)
  const written = await ctx.dshStore.writeFile(undefined, GLOBAL_MEMORY_ARCHIVE_STORE_PATH, text, {
    scope: 'global',
    ...expectedVersion === undefined ? {} : { expected: expectedVersion },
    ...signal === undefined ? {} : { signal },
  })
  return {
    path: globalMemoryArchivePath(),
    ...written.version === undefined ? {} : { version: written.version },
  }
}

/** Whether one store failure is the version guard refusing a concurrent write. */
function isStaleWrite(error: unknown): boolean {
  return error instanceof FsError && error.code === 'FS_STALE_VERSION'
}

/**
 * Append entries to the archive and retry one stale write after a re-read.
 * @param ctx - plugin context carrying the global store.
 * @param entries - entries to append, oldest first.
 * @param signal - cancellation for the read and the write.
 * @returns the archive path, the new revision, and the store version.
 */
export async function appendGlobalArchive(
  ctx: Context,
  entries: readonly GlobalMemoryArchiveEntry[],
  signal?: AbortSignal,
): Promise<{ readonly path: string; readonly revision: number; readonly version?: string }> {
  if (entries.length === 0) {
    const read = await readGlobalMemoryArchive(ctx, signal)
    return { path: read.path, revision: read.document?.version ?? 0, ...read.version === undefined ? {} : { version: read.version } }
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const read = await readGlobalMemoryArchive(ctx, signal)
    const previous = read.document?.entries ?? []
    const document: GlobalMemoryArchiveDocument = {
      version: (read.document?.version ?? 0) + 1,
      updatedAt: new Date().toISOString(),
      entries: [...previous, ...entries],
    }
    try {
      const written = await writeGlobalArchive(ctx, document, read.version, signal)
      return { path: written.path, revision: document.version, ...written.version === undefined ? {} : { version: written.version } }
    } catch (error: unknown) {
      if (attempt === 0 && isStaleWrite(error)) continue
      throw error
    }
  }
  /* v8 ignore next -- the loop either returns or rethrows on its second attempt. */
  throw new Error('memory: global archive stale write retry exhausted')
}

/** Build one archive entry from an active entry. */
function archiveEntry(
  entry: GlobalMemoryEntry,
  reason: GlobalMemoryArchiveReason,
  detail: string,
  now: Date,
): GlobalMemoryArchiveEntry {
  return { ...entry, archivedAt: now.toISOString(), reason, detail }
}

/** One write's accepted input after validation. */
export interface GlobalMemoryWriteInput {
  /** Topic from the allowlist. */
  readonly topic: GlobalMemoryTopic
  /** One-line fact or convention. */
  readonly text: string
  /** Session that wrote the entry. */
  readonly sourceSessionId: string
}

/**
 * Write one active entry, archiving an older entry with the same topic.
 *
 * The archive write happens before the active write, so a failed active write
 * leaves the old copy recoverable. The active file's version guard is retried
 * once after a re-read.
 * @param ctx - plugin context carrying the global store.
 * @param input - topic, validated text, and source session.
 * @param signal - cancellation for each read and write.
 * @returns the new entry and the older entry the write archived, when any.
 * @throws GlobalMemoryError `NOT_GLOBAL_MEMORY` for a business, dispatch, or persona entry.
 * @throws GlobalMemoryError `GLOBAL_MEMORY_FULL` when the active file cannot fit the entry.
 */
export async function writeGlobalEntry(
  ctx: Context,
  input: GlobalMemoryWriteInput,
  signal?: AbortSignal,
): Promise<GlobalMemoryWriteResult> {
  const classification = classifyMemoryText(input.text)
  if (classification.class === 'business') {
    throw new GlobalMemoryError(
      `NOT_GLOBAL_MEMORY: this text records a business fact (${classification.reason}). Global memory keeps only cross-workspace facts and conventions. `
      + 'Record what the user asked for with `workspace_intents`, task work and receipts with `workspace_tasks`, session history with `session_search` or `session_event_read`, and files with `workspace_artifacts` or `read`.',
      'NOT_GLOBAL_MEMORY',
    )
  }
  if (classification.class === 'dispatch') {
    throw new GlobalMemoryError(
      `NOT_GLOBAL_MEMORY: this text records dispatch or session state (${classification.reason}). Global memory keeps only cross-workspace facts and conventions. `
      + 'Use `workspace_tasks` for task records and receipts, `workspace_sessions` for session status and progress, `workspace_message` for delivery, and `workspace_intents` for the request card.',
      'NOT_GLOBAL_MEMORY',
    )
  }
  if (classification.class === 'persona') {
    throw new GlobalMemoryError(
      `NOT_GLOBAL_MEMORY: this text records persona or writing-style guidance (${classification.reason}). Global memory keeps facts and conventions only. `
      + 'Persona and style belong to `personality_apply` / `personality_analyze` (or `write_like_human` for the writing rules); a stable instruction belongs in `rules/AGENTS.md`.',
      'NOT_GLOBAL_MEMORY',
    )
  }
  const text = normalizeEntryText(input.text)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const read = await readGlobalMemory(ctx, signal)
    const now = new Date()
    const previous = read.document?.entries.find(entry => entry.topic === input.topic)
    const entry: GlobalMemoryEntry = {
      id: globalMemoryEntryId(input.topic, now.toISOString(), text),
      topic: input.topic,
      sourceSessionId: input.sourceSessionId,
      createdAt: now.toISOString(),
      text,
    }
    const entries = [...(read.document?.entries ?? []).filter(candidate => candidate.topic !== input.topic), entry]
    const document: GlobalMemoryDocument = {
      version: (read.document?.version ?? 0) + 1,
      updatedAt: now.toISOString(),
      entries,
    }
    let archived: GlobalMemoryArchiveEntry | undefined
    if (previous !== undefined) {
      archived = archiveEntry(previous, 'superseded', `a newer ${input.topic} entry replaced this one`, now)
      await appendGlobalArchive(ctx, [archived], signal)
    }
    try {
      const written = await writeGlobalDocument(ctx, document, read.version, signal)
      return {
        path: written.path,
        topic: input.topic,
        id: entry.id,
        revision: document.version,
        ...written.version === undefined ? {} : { version: written.version },
        ...archived === undefined ? {} : { archived },
      }
    } catch (error: unknown) {
      if (attempt === 0 && isStaleWrite(error)) continue
      throw error
    }
  }
  /* v8 ignore next -- the loop either returns or rethrows on its second attempt. */
  throw new Error('memory: global stale write retry exhausted')
}

/**
 * Search active entries and, when requested, the archive.
 * @param ctx - plugin context carrying the global store.
 * @param query - literal text matched case-insensitively against topic and text.
 * @param options - result cap and whether archived entries are included.
 * @param signal - cancellation for the reads.
 * @returns ranked hits, active entries first, then archived entries newest first.
 */
export async function searchGlobalMemory(
  ctx: Context,
  query: string,
  options: { readonly limit?: number; readonly includeArchived?: boolean } = {},
  signal?: AbortSignal,
): Promise<GlobalMemorySearchValue> {
  const needle = query.toLowerCase()
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? GLOBAL_MEMORY_SEARCH_LIMIT), 1), GLOBAL_MEMORY_SEARCH_LIMIT)
  const items: GlobalMemorySearchItem[] = []
  const active = await readGlobalMemory(ctx, signal)
  for (const entry of active.document?.entries ?? []) {
    if (!matches(entry, needle)) continue
    items.push({
      id: entry.id,
      topic: entry.topic,
      text: entry.text,
      sourceSessionId: entry.sourceSessionId,
      createdAt: entry.createdAt,
    })
  }
  if (options.includeArchived === true) {
    const archive = await readGlobalMemoryArchive(ctx, signal)
    const archived = [...(archive.document?.entries ?? [])]
      .sort((left, right) => right.archivedAt.localeCompare(left.archivedAt))
    for (const entry of archived) {
      if (!matches(entry, needle)) continue
      items.push({
        id: entry.id,
        topic: entry.topic,
        text: entry.text,
        sourceSessionId: entry.sourceSessionId,
        createdAt: entry.createdAt,
        archived: true,
        reason: entry.reason,
      })
    }
  }
  return boundSearchValue({ query, items: items.slice(0, limit) }, GLOBAL_MEMORY_SEARCH_MAX_BYTES, items.length > limit)
}

/** Whether one entry matches the lower-cased needle. */
function matches(entry: GlobalMemoryEntry, needle: string): boolean {
  return entry.text.toLowerCase().includes(needle) || entry.topic.includes(needle)
}

/** Drop trailing results until the rendered value fits the byte budget. */
function boundSearchValue(value: GlobalMemorySearchValue, maxBytes: number, truncated: boolean): GlobalMemorySearchValue {
  const items = [...value.items]
  let current: GlobalMemorySearchValue = truncated ? { ...value, truncated: true } : value
  while (items.length > 0 && Buffer.byteLength(renderSearchValue(current), 'utf8') > maxBytes) {
    items.pop()
    current = { ...value, items, truncated: true }
  }
  return current
}

/** The minimum shape of one rendered search hit. */
export interface RenderableSearchItem {
  /** Entry topic. */
  readonly topic: string
  /** Entry text. */
  readonly text: string
  /** Whether the hit came from the archive. */
  readonly archived?: boolean
  /** Rule that archived the entry. */
  readonly reason?: string
}

/** The minimum shape of one rendered search value. */
export interface RenderableSearchValue {
  /** The query the results answer. */
  readonly query: string
  /** Ranked results. */
  readonly items: readonly RenderableSearchItem[]
  /** Whether results were dropped to stay inside the budget. */
  readonly truncated?: boolean
}

/**
 * Render one search value; the tools render the same text, so the budget matches the model-visible size.
 * @param value - the query, ranked items, and whether results were truncated.
 * @returns one line per hit, or a no-match line when nothing matched.
 */
export function renderSearchValue(value: RenderableSearchValue): string {
  const lines = value.items.length === 0
    ? [`No global memory matches for ${JSON.stringify(value.query)}.`]
    : value.items.map(item =>
      `- [${item.topic}]${item.archived === true ? ` · archived: ${item.reason ?? 'unknown'}` : ''} · ${item.text}`)
  if (value.truncated === true) lines.push('(results truncated; narrow the query or lower `limit`)')
  return lines.join('\n')
}

/**
 * Forget active entries by topic or by entry id.
 *
 * Forgetting a topic archives its active entry, so the text stays searchable
 * with `includeArchived`. Forgetting an archived entry id deletes that record.
 * @param ctx - plugin context carrying the global store.
 * @param filter - topic or entry id; at least one is required.
 * @param signal - cancellation for each read and write.
 * @returns the path, the number removed, and the active entries that remain.
 * @throws GlobalMemoryError `GLOBAL_MEMORY_FILTER_REQUIRED` when neither selector is present.
 */
export async function forgetGlobalEntries(
  ctx: Context,
  filter: GlobalMemoryForgetFilter,
  signal?: AbortSignal,
): Promise<GlobalMemoryForgetResult> {
  if (filter.topic === undefined && filter.entryId === undefined) {
    throw new GlobalMemoryError(
      'memory_forget requires `topic` or `entryId`; there are no session, turn, or kind filters in global memory',
      'GLOBAL_MEMORY_FILTER_REQUIRED',
    )
  }
  if (filter.topic !== undefined) return await forgetGlobalTopic(ctx, filter.topic, signal)
  return await forgetGlobalEntryId(ctx, filter.entryId as string, signal)
}

/** Archive one active topic and rewrite the active file. */
async function forgetGlobalTopic(
  ctx: Context,
  topic: GlobalMemoryTopic,
  signal: AbortSignal | undefined,
): Promise<GlobalMemoryForgetResult> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const read = await readGlobalMemory(ctx, signal)
    const entries = read.document?.entries ?? []
    const removed = entries.filter(entry => entry.topic === topic)
    if (removed.length === 0) {
      return { path: read.path, removed: 0, remaining: entries.length, topics: [] }
    }
    const now = new Date()
    await appendGlobalArchive(
      ctx,
      removed.map(entry => archiveEntry(entry, 'manual-forget', 'removed by memory_forget', now)),
      signal,
    )
    const document: GlobalMemoryDocument = {
      version: (read.document?.version ?? 0) + 1,
      updatedAt: now.toISOString(),
      entries: entries.filter(entry => entry.topic !== topic),
    }
    try {
      const written = await writeGlobalDocument(ctx, document, read.version, signal)
      return { path: written.path, removed: removed.length, remaining: document.entries.length, topics: [topic] }
    } catch (error: unknown) {
      if (attempt === 0 && isStaleWrite(error)) continue
      throw error
    }
  }
  /* v8 ignore next -- the loop either returns or rethrows on its second attempt. */
  throw new Error('memory: global forget stale write retry exhausted')
}

/** Delete one active or archived entry by id. */
async function forgetGlobalEntryId(
  ctx: Context,
  entryId: string,
  signal: AbortSignal | undefined,
): Promise<GlobalMemoryForgetResult> {
  const active = await readGlobalMemory(ctx, signal)
  const activeMatch = (active.document?.entries ?? []).find(entry => entry.id === entryId)
  if (activeMatch !== undefined) {
    const now = new Date()
    await appendGlobalArchive(
      ctx,
      [archiveEntry(activeMatch, 'manual-forget', 'removed by memory_forget', now)],
      signal,
    )
    const document: GlobalMemoryDocument = {
      version: (active.document?.version ?? 0) + 1,
      updatedAt: now.toISOString(),
      entries: (active.document?.entries ?? []).filter(entry => entry.id !== entryId),
    }
    const written = await writeGlobalDocument(ctx, document, active.version, signal)
    return { path: written.path, removed: 1, remaining: document.entries.length, topics: [activeMatch.topic] }
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const archive = await readGlobalMemoryArchive(ctx, signal)
    const entries = archive.document?.entries ?? []
    const match = entries.find(entry => entry.id === entryId)
    if (match === undefined) {
      return { path: archive.path, removed: 0, remaining: active.document?.entries.length ?? 0, topics: [] }
    }
    const document: GlobalMemoryArchiveDocument = {
      version: (archive.document?.version ?? 0) + 1,
      updatedAt: new Date().toISOString(),
      entries: entries.filter(entry => entry.id !== entryId),
    }
    try {
      await writeGlobalArchive(ctx, document, archive.version, signal)
      return { path: archive.path, removed: 1, remaining: active.document?.entries.length ?? 0, topics: [match.topic] }
    } catch (error: unknown) {
      if (attempt === 0 && isStaleWrite(error)) continue
      throw error
    }
  }
  /* v8 ignore next -- the loop either returns or rethrows on its second attempt. */
  throw new Error('memory: global archive forget retry exhausted')
}

/** Classification of one candidate entry text. */
export type MemoryFactClass = 'global' | 'dispatch' | 'business' | 'persona' | 'unclassified'

/** One classification result, with the reason and the proposed topic when global. */
export interface MemoryClassification {
  /** Which class the text belongs to. */
  readonly class: MemoryFactClass
  /** Readable account of the marker that decided the class. */
  readonly reason: string
  /** Proposed global topic, present only for a positive `global` classification. */
  readonly topic?: GlobalMemoryTopic
}

/** Dispatch and session-state markers; such text belongs to the workspace toolset. */
const DISPATCH_MARKERS: readonly (readonly [RegExp, string])[] = [
  [/\b(?:dispatched|dispatch(?:ed)? to|dispatch task|task id|ledger|receipt|handoff|next step|waiting for|in progress|blocked on|blocked by)\b/iu, 'dispatch or task state'],
  [/\b(?:session id|turn \d+|step \d+|session [\w-]{6,})\b/iu, 'session or turn state'],
  [/\.superagent\b|\bworkspace_(?:tasks|sessions|message|artifacts|intents)\b|\bsuperagent_/iu, 'workspace tool state'],
]

/** Business markers; such text belongs to its workspace or session owner. */
const BUSINESS_MARKERS: readonly (readonly [RegExp, string])[] = [
  [/(?:^|\s)\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+/u, 'an absolute path'],
  [/\b[A-Za-z]:\\/u, 'an absolute Windows path'],
  [/\b[A-Z][A-Z0-9]{1,9}-\d{2,6}\b/u, 'a JIRA key'],
  [/\b[0-9a-f]{7,40}\b/u, 'a commit hash'],
  [/\bv?\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?\b/u, 'a version'],
  [/\b(?:HEAD|commit|branch|repo(?:sitory)?|workspace)\b/iu, 'workspace, repository, or commit detail'],
  [/\b(?:test results?|tests? (?:passed|failed|green|red)|coverage)\b/iu, 'a test result'],
  [/\b(?:device|mirror|production deployment|deployed)\b/iu, 'a device, mirror, or deployment detail'],
  [/\b(?:analysis|finding|root cause|conclusion)\b/iu, 'an analysis conclusion'],
  [/\.(?:ts|tsx|js|json|md|py|yml|yaml)\b/u, 'a file name'],
]

/** Persona and writing-style markers; those records belong to the personality capability. */
const PERSONA_MARKERS: readonly (readonly [RegExp, string])[] = [
  [/\b(?:persona|personality|tone of voice|writing style|communication style|style guide)\b/iu, 'persona or writing style'],
]

/** Positive topic signals used only when a caller asks for a candidate, never to reject a write. */
const TOPIC_MARKERS: readonly (readonly [GlobalMemoryTopic, RegExp, string])[] = [
  ['global-server', /\b(?:server|host|endpoint|address|url|dns|ipv4|proxy|gateway|port)\b/iu, 'a shared server or host fact'],
  ['global-model', /\b(?:model|llm|provider|deepseek|anthropic|openai|qwen|reasoning effort|temperature)\b/iu, 'a model or provider fact'],
  ['global-account', /\b(?:account|credential|username|login|email|api key)\b/iu, 'a shared account fact'],
  ['global-tooling', /\b(?:tool|plugin|package|pnpm|node|cli|harness|dsh|typescript|vitest)\b/iu, 'a shared tooling fact'],
  ['global-convention', /\b(?:always|never|must|should|convention|rule|policy|prefer|require[sd]?)\b/iu, 'a shared convention'],
]

/** First matching marker of one table, if any. */
function firstMarker(
  text: string,
  table: readonly (readonly [RegExp, string])[],
): string | undefined {
  for (const [pattern, reason] of table) {
    if (pattern.test(text)) return reason
  }
  return undefined
}

/**
 * Classify one candidate text for a migration report or a write refusal.
 *
 * A write is refused when the text carries a business, dispatch, or persona
 * marker. A `global` classification additionally needs a positive global topic
 * signal; text with no marker at all is `unclassified` and is never migrated
 * automatically.
 * @param text - one-line candidate entry.
 * @returns the class, its reason, and the proposed topic for a global candidate.
 */
export function classifyMemoryText(text: string): MemoryClassification {
  const dispatch = firstMarker(text, DISPATCH_MARKERS)
  if (dispatch !== undefined) return { class: 'dispatch', reason: dispatch }
  const business = firstMarker(text, BUSINESS_MARKERS)
  if (business !== undefined) return { class: 'business', reason: business }
  const persona = firstMarker(text, PERSONA_MARKERS)
  if (persona !== undefined) return { class: 'persona', reason: persona }
  for (const [topic, pattern, reason] of TOPIC_MARKERS) {
    if (pattern.test(text)) return { class: 'global', reason, topic }
  }
  return { class: 'unclassified', reason: 'no global topic signal and no owner marker' }
}
