/**
 * MEMORY.md repository: the workspace-shared memory file at
 * `<projectRoot>/.dsh/memory/sessions/MEMORY.md`.
 *
 * The file has two halves. The YAML frontmatter carries machine state (the
 * window thresholds, per-session turn tiers, and seq ranges); the managed block
 * between the `memory:begin` and `memory:end` markers carries the readable
 * summary entries. Text outside the managed block is hand-written and preserved
 * byte-for-byte, while the managed block is provider-owned and rewritten.
 *
 * Reads and writes go through `ctx.dshStore`, which owns `.dsh` path resolution
 * and confinement; this module never assembles a `.dsh` path itself. Writes are
 * version-guarded: the version read before composing the next text is required
 * by the write, and one conflicting write is retried after a re-read before the
 * failure surfaces. The same module applies the window planner's tier migrations
 * in one batch write and records each surface checkpoint's seq.
 * @module @deepseek-ai/dsh-memory/memory-file
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { FsError } from '@deepseek-ai/dsh-fs'
import { parse as parseYaml } from 'yaml'
import type { StoreWriteOptions } from '@deepseek-ai/dsh-store-atom'
import { appendMemoryArchive } from './archive.ts'
import { replaceSurfaceRange } from './checkpoint.ts'
import { cleanupMemoryDocument, resolveMemoryEntries } from './cleanup.ts'
import { classifySummaryFailure } from './failure.ts'
import type { MemoryCleanupNewerEntry, MemoryResolveFilter } from './cleanup.ts'
import { collectMemoryEntryTimes } from './entry-times.ts'
import { errorMessage } from './text.ts'
import { planTierMigrations } from './window.ts'
import type { SurfaceRetry, TierMigrationPlan, TurnRange } from './window.ts'

/** Store-relative path of the per-workspace memory file. */
export const MEMORY_STORE_PATH = 'memory/sessions/MEMORY.md'

/** Store-relative path of the summary edit history beside MEMORY.md. */
export const MEMORY_HISTORY_STORE_PATH = 'memory/sessions/MEMORY.history.json'

/** Store-relative path of the append-only archive for entries removed from the active block. */
export const MEMORY_ARCHIVE_STORE_PATH = 'memory/sessions/MEMORY.archive.md'

/** Marker opening the provider-owned archive block. */
export const MEMORY_ARCHIVE_BEGIN = '<!-- memory-archive:begin -->'

/** Marker closing the provider-owned archive block. */
export const MEMORY_ARCHIVE_END = '<!-- memory-archive:end -->'

/** Maximum summary-history records kept; the oldest records fall off the front. */
export const MEMORY_HISTORY_LIMIT = 100

/** Marker opening the provider-owned managed block. */
export const MEMORY_BLOCK_BEGIN = '<!-- memory:begin -->'

/** Marker closing the provider-owned managed block. */
export const MEMORY_BLOCK_END = '<!-- memory:end -->'

/** Document format version this module reads and writes. */
export const MEMORY_DOCUMENT_VERSION = 1

/**
 * Default body budget in UTF-8 bytes.
 *
 * The provider renders the complete managed body into the durable snapshot, whose own fixed budget is
 * {@link MEMORY_SNAPSHOT_MAX_BYTES} (also 16 KiB). Keeping the persisted body at or below the snapshot
 * budget makes the file and its model-facing rendering one prompt-sized block instead of letting the
 * file outgrow what the model can see. Raise it when a workspace needs more retained detail and accepts
 * a larger snapshot; lower it to bound prompt cost.
 */
export const DEFAULT_MEMORY_MAX_BYTES = 16 * 1024

/** Default per-session entry cap kept in the managed block. */
export const DEFAULT_MEMORY_MAX_ENTRIES = 40

/** Maximum eviction records retained in the frontmatter, newest last. */
export const MEMORY_EVICTION_RECORD_LIMIT = 50

/** Maximum characters of one evicted entry text kept in its record. */
export const MEMORY_EVICTION_TEXT_MAX_CHARS = 200

/** Maximum entries one brief checkpoint may carry. */
export const MEMORY_BRIEF_MAX_ENTRIES = 2

/** Maximum total characters across the entry texts of one brief checkpoint. */
export const MEMORY_BRIEF_MAX_CHARS = 160

/** Entry kinds the managed block may carry, in canonical order. */
export const MEMORY_ENTRY_KINDS = ['decision', 'files', 'open', 'preference'] as const

/** One recognized entry kind. */
export type MemoryEntryKind = typeof MEMORY_ENTRY_KINDS[number]

/** Summary tiers a body section can carry. */
export type MemoryTier = 'detail' | 'brief'

/** Why one entry left the managed block. */
export type MemoryEvictionReason =
  | 'byte-budget'
  | 'manual-forget'
  | 'ttl'
  | 'resolved'
  | 'superseded'
  | 'duplicate'

/**
 * One entry the provider removed from the managed block, recorded in the frontmatter.
 *
 * The record is the durable answer to "where did that fact go?": it names the entry, its kind and turn,
 * when it left, and why. The body no longer carries the text, so this is the only in-file trace.
 */
export interface MemoryEvictionRecord {
  /** ISO-8601 time of the removal. */
  readonly at: string
  /** Session the entry belonged to. */
  readonly sessionId: string
  /** Kind of the removed entry. */
  readonly kind: MemoryEntryKind
  /** Labels the removed entry carried, when any. */
  readonly tags?: readonly string[]
  /** Turn the entry summarized, when it carried one. */
  readonly turn?: number
  /** Bounded copy of the removed entry text. */
  readonly text: string
  /** Whether the budget or an explicit forget removed it. */
  readonly reason: MemoryEvictionReason
  /** Human-readable account of the pressure or filter that removed it. */
  readonly detail: string
  /** Entry time inferred from the turn log or session update, when known. */
  readonly originalAt?: string
}

/** One archived entry; the searchable copy behind every automatic removal. */
export interface MemoryArchiveRecord {
  /** Session the entry belonged to. */
  readonly sessionId: string
  /** Kind of the removed entry. */
  readonly kind: MemoryEntryKind
  /** Full entry text, never truncated: this is the recoverable copy. */
  readonly text: string
  /** Turn the entry summarized, when it carried one. */
  readonly turn?: number
  /** Labels the entry carried, in write order. */
  readonly tags?: readonly string[]
  /** ISO-8601 time the archive record was written. */
  readonly archivedAt: string
  /** Entry time inferred from the turn log or session update, when known. */
  readonly originalAt?: string
  /** Rule that removed the entry. */
  readonly reason: MemoryEvictionReason
  /** Human-readable account naming the rule and its input. */
  readonly detail: string
}

/** Least durable kind first: an open question or file pointer leaves before a decision. */
const MEMORY_KIND_EVICTION_ORDER: Readonly<Record<MemoryEntryKind, number>> = {
  open: 0,
  files: 1,
  decision: 2,
  preference: 3,
}

/** Outcome codes a MEMORY.md read or write can report. */
export type MemoryDocumentErrorCode = 'invalid-document' | 'unknown-kind' | 'budget-exceeded' | 'empty-summary'

/** Typed MEMORY.md failure; `code` is stable for callers and logs. */
export class MemoryDocumentError extends Error {
  /**
   * @param message - actionable description naming the offending field or line.
   * @param code - stable failure kind.
   */
  constructor(message: string, readonly code: MemoryDocumentErrorCode) {
    super(message)
    this.name = 'MemoryDocumentError'
  }
}

/** One entry kind and what it records. */
export interface MemoryKindDefinition {
  /** Stable kind id written between brackets. */
  readonly id: MemoryEntryKind
  /** What an entry of this kind records, for the tool schema and diagnostics. */
  readonly description: string
}

/** The kind registry the parser, renderer, and tool schema share. */
export const MEMORY_KIND_REGISTRY: readonly MemoryKindDefinition[] = [
  { id: 'decision', description: 'a durable decision and its reason' },
  { id: 'files', description: 'files or paths changed or worth revisiting' },
  { id: 'open', description: 'unfinished work or an open question' },
  { id: 'preference', description: 'a user preference that should persist across sessions' },
]

/** Window thresholds recorded in the frontmatter and applied by the summary job. */
export interface MemoryWindow {
  /** Turn age at which a detail summary replaces the verbatim turn. */
  readonly detail: number
  /** Turn age at which a brief summary replaces the detail summary. */
  readonly brief: number
  /** Turn age at which the summary body is dropped from the context. */
  readonly forget: number
  /** Number of sessions kept with summaries in this file. */
  readonly sessions: number
}

/** Default window thresholds; the provider configuration overrides them. */
export const DEFAULT_MEMORY_WINDOW: MemoryWindow = { detail: 6, brief: 16, forget: 21, sessions: 10 }

/** One turn's machine state in the frontmatter. */
export interface MemoryTurnRecord {
  /** Turn number from the session log. */
  readonly turn: number
  /** Inclusive seq range of the turn's events. */
  readonly seq: readonly [number, number]
  /** Summary tier currently stored for this turn. */
  readonly tier: MemoryTier
  /** Seq of the checkpoint that replaced the turn on the model surface, once one exists. */
  readonly checkpointSeq?: number
}

/** One session's machine state in the frontmatter. */
export interface MemorySessionRecord {
  /** Session id. */
  readonly id: string
  /** Session working directory; the authorization boundary is exact equality. */
  readonly cwd: string
  /** ISO-8601 time of the last write for this session. */
  readonly updatedAt: string
  /** Turns this file holds a tier for. */
  readonly turns: readonly MemoryTurnRecord[]
  /** Highest turn whose summary body has been forgotten; absent while nothing was forgotten. */
  readonly forgottenThrough?: number
}

/** One summary entry in the managed block. */
export interface MemoryEntry {
  /** Kind from {@link MEMORY_ENTRY_KINDS}. */
  readonly kind: MemoryEntryKind
  /** Single-line entry text. */
  readonly text: string
  /** Turn the entry summarizes; absent on entries written before per-turn attribution. */
  readonly turn?: number
  /** Optional labels recorded beside the text, in the order the writer supplied them. */
  readonly tags?: readonly string[]
  /** Where the text came from: the automatic summary job, or a human edit. */
  readonly source?: 'auto' | 'manual'
  /** Revision of the text; absent until a human edit records one. */
  readonly version?: number
}

/** One managed-block section: consecutive turns of one session at one tier. */
export interface MemorySection {
  /** Session this section summarizes. */
  readonly sessionId: string
  /** First turn covered by this section. */
  readonly startTurn: number
  /** Last turn covered by this section. */
  readonly endTurn: number
  /** Tier of the summaries in this section. */
  readonly tier: MemoryTier
  /** Entries in file order. */
  readonly entries: readonly MemoryEntry[]
}

/** Text around the managed block, preserved verbatim on render. */
export interface MemoryFrame {
  /** Bytes between the frontmatter block and the begin marker. */
  readonly before: string
  /** Bytes after the end marker. */
  readonly after: string
}

/** Complete MEMORY.md content. */
export interface MemoryDocument {
  /** Document format version. */
  readonly version: number
  /** Window thresholds this file was written with. */
  readonly window: MemoryWindow
  /** Per-session machine state. */
  readonly sessions: readonly MemorySessionRecord[]
  /** Managed-block summary sections. */
  readonly sections: readonly MemorySection[]
  /** Hand-written text around the managed block. */
  readonly frame: MemoryFrame
  /** Whether the automatic summary job is paused for this workspace; absent or false runs it. */
  readonly summaryPaused?: boolean
  /** Recent entries the provider removed, oldest first; absent on documents that never evicted. */
  readonly evictions?: readonly MemoryEvictionRecord[]
}

/** One entry a caller appends, with the turn it belongs to. */
export interface MemoryEntryInput {
  /** Kind from the registry. */
  readonly kind: MemoryEntryKind
  /** Single-line entry text. */
  readonly text: string
  /** Optional labels recorded beside the text. */
  readonly tags?: readonly string[]
  /** Turn number the entry belongs to. */
  readonly turn: number
  /** Inclusive seq range of that turn. */
  readonly seq: readonly [number, number]
  /** Section tier to join; defaults to `detail`. */
  readonly tier?: MemoryTier
  /** Tags that explicitly supersede older entries of the same kind in this session. */
  readonly supersedes?: readonly string[]
}

/** One turn's detail summary to append as a single managed-block section. */
export interface MemoryTurnSummaryInput {
  /** Turn number from the session log. */
  readonly turn: number
  /** Inclusive seq range of the turn's events. */
  readonly seq: readonly [number, number]
  /** Validated entries produced by the summary job. */
  readonly entries: readonly MemoryEntry[]
}

/** Options of one turn-summary append. */
export interface MemoryTurnSummaryOptions {
  /** Window thresholds recorded when the append creates the document. */
  readonly window?: MemoryWindow
  /** Maximum managed-block body size in UTF-8 bytes. */
  readonly maxBytes?: number
  /** Maximum entries retained per session; older sections leave the block. */
  readonly maxEntries?: number
  /** TTL of `open` entries in days; 0 disables the rule. */
  readonly openTtlDays?: number
  /** TTL of `files` entries in days; 0 disables the rule. */
  readonly filesTtlDays?: number
  /** Shared tags required for implicit supersession. */
  readonly supersessionMinSharedTags?: number
  /** Clock for cleanup tests; defaults to now. */
  readonly now?: Date
}

/** Result of one multi-turn summary append. */
export interface MemoryTurnSummariesResult {
  /** Store-relative path that was written. */
  readonly path: string
  /** Version of the written file, when the store reported one. */
  readonly version?: string
  /** Turns whose detail entries were appended, in batch order. */
  readonly turns: readonly { readonly turn: number; readonly entries: number }[]
  /** Entries this write evicted or archived. */
  readonly evictions: readonly MemoryEvictionRecord[]
}

/** Result of one turn-summary append. */
export interface MemoryTurnSummaryResult {
  /** Store-relative path that was written. */
  readonly path: string
  /** Version of the written file, when the store reported one. */
  readonly version?: string
  /** Turn whose detail entries were appended. */
  readonly turn: number
  /** Number of entries appended. */
  readonly entries: number
  /** Entries this write evicted to stay inside the body budget. */
  readonly evictions: readonly MemoryEvictionRecord[]
}

/**
 * Compress one detail section for a brief checkpoint.
 *
 * The callback is the summary job's model call. It receives the section's
 * current entries and must return one or two entries whose texts total at most
 * {@link MEMORY_BRIEF_MAX_CHARS} characters; the repository normalizes a larger
 * result, and a thrown call keeps the detail section unchanged.
 * @param range - turns the section covers.
 * @param entries - detail entries read from MEMORY.md.
 * @param signal - cancellation for the model call.
 * @returns entries for the brief checkpoint.
 */
export type MemoryTierCompressor = (
  range: TurnRange,
  entries: readonly MemoryEntry[],
  signal: AbortSignal | undefined,
) => Promise<readonly MemoryEntry[]>

/** Options of one tier migration pass. */
export interface MemoryTierMigrationOptions {
  /** Window thresholds applied to turn ages. */
  readonly window?: MemoryWindow
  /** Maximum managed-block body size in UTF-8 bytes. */
  readonly maxBytes?: number
  /** Maximum entries retained per session; older sections leave the block. */
  readonly maxEntries?: number
  /**
   * Whether surface turn ranges may be replaced in this pass. False between compactions: the
   * document still migrates but the surface stays append-only, and the pending replacement is
   * retried at the next compaction boundary.
   */
  readonly allowSurfaceReplace?: boolean
}

/** Result of one tier migration pass. */
export interface MemoryTierMigrationResult {
  /** Store-relative path that was written. */
  readonly path: string
  /** Version of the written file, when the store reported one. */
  readonly version?: string
  /** Number of raw ranges replaced with a detail checkpoint. */
  readonly detailed: number
  /** Number of sections replaced with a brief checkpoint. */
  readonly briefed: number
  /** Number of sections whose body was forgotten. */
  readonly forgotten: number
  /** Number of earlier-skipped surface replacements this pass completed. */
  readonly retried: number
  /** Entries this pass evicted to stay inside the body budget. */
  readonly evictions: readonly MemoryEvictionRecord[]
}

/** Options of one append. */
export interface MemoryAppendOptions {
  /** Window thresholds recorded when the append creates the document. */
  readonly window?: MemoryWindow
  /** Maximum managed-block body size in UTF-8 bytes. */
  readonly maxBytes?: number
  /** Maximum entries retained per session; older sections leave the block. */
  readonly maxEntries?: number
  /** TTL of `open` entries in days; 0 disables the rule. */
  readonly openTtlDays?: number
  /** TTL of `files` entries in days; 0 disables the rule. */
  readonly filesTtlDays?: number
  /** Shared tags required for implicit supersession. */
  readonly supersessionMinSharedTags?: number
  /** Clock for cleanup tests; defaults to now. */
  readonly now?: Date
}

/** Result of one append. */
export interface MemoryAppendResult {
  /** Store-relative path that was written. */
  readonly path: string
  /** Version of the written file, when the store reported one. */
  readonly version?: string
  /** Kind of the appended entry. */
  readonly kind: MemoryEntryKind
  /** Entries this write evicted to stay inside the body budget. */
  readonly evictions: readonly MemoryEvictionRecord[]
}

/** Result of one read. */
export interface MemoryDocumentRead {
  /** Store-relative path that was read. */
  readonly path: string
  /** Parsed document; absent while the file does not exist. */
  readonly document?: MemoryDocument
  /** Version of the existing file, passed to a guarded write. */
  readonly version?: string
}

/** Text between the frontmatter and the managed block of a new file. */
const DEFAULT_MEMORY_FRAME: MemoryFrame = { before: '\n', after: '\n' }

/** Section heading in the managed block, with the pinned separator characters. */
const SECTION_HEADING = /^## (?<sessionId>.+) · turn (?<startTurn>\d+)–(?<endTurn>\d+)（(?<tier>detail|brief)）$/u

/** Entry line in the managed block. */
const ENTRY_LINE = /^- \[(?<kind>[a-z]+)\] (?<text>.+)$/u

/** Optional label suffix of one entry line; entries written before labels existed have none. */
const ENTRY_TAGS = /^(?<text>[^]*?)\s*<!-- tags: (?<tags>[^>]*) -->$/u

/** Optional turn suffix of one entry line, written before the label suffix when both exist. */
const ENTRY_TURN = /^(?<text>[^]*?)\s*<!-- turn: (?<turn>\d+) -->$/u

/** Optional origin suffix of one entry line, written after the label suffix when present. */
const ENTRY_SOURCE = /^(?<text>[^]*?)\s*<!-- source: (?<source>auto|manual) -->$/u

/** Optional revision suffix of one entry line, written after the origin suffix when present. */
const ENTRY_VERSION = /^(?<text>[^]*?)\s*<!-- version: (?<version>\d+) -->$/u

/** Maximum number of labels one entry may carry; extra labels are dropped. */
export const MEMORY_ENTRY_TAGS_LIMIT = 8

/** Maximum characters of one label; a longer label is truncated with an ellipsis. */
export const MEMORY_ENTRY_TAG_MAX_CHARS = 64

/** Frontmatter block at the start of the file. */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u

/**
 * Look up one entry kind.
 * @param kind - candidate kind id from a document or a caller.
 * @returns the registry definition, or undefined for an unrecognized id.
 */
export function memoryKindDefinition(kind: string): MemoryKindDefinition | undefined {
  return MEMORY_KIND_REGISTRY.find(definition => definition.id === kind)
}

/**
 * Validate one entry kind at a durable-file or caller boundary.
 * @param kind - candidate kind id.
 * @returns the narrowed kind.
 * @throws MemoryDocumentError `unknown-kind` listing every valid kind.
 */
export function assertMemoryEntryKind(kind: string): MemoryEntryKind {
  const definition = memoryKindDefinition(kind)
  if (definition !== undefined) return definition.id
  throw new MemoryDocumentError(
    `unknown memory entry kind ${JSON.stringify(kind)}; valid kinds: ${MEMORY_ENTRY_KINDS.join(', ')}`,
    'unknown-kind',
  )
}

/**
 * Create an empty document for a file that does not exist yet.
 * @param window - thresholds to record.
 * @returns a document with no sessions and no entries.
 */
export function createMemoryDocument(window: MemoryWindow = DEFAULT_MEMORY_WINDOW): MemoryDocument {
  return {
    version: MEMORY_DOCUMENT_VERSION,
    window,
    sessions: [],
    sections: [],
    frame: DEFAULT_MEMORY_FRAME,
  }
}

/**
 * Parse MEMORY.md into machine state and managed sections.
 * @param text - complete file text.
 * @returns the parsed document, including the preserved hand-written text.
 * @throws MemoryDocumentError `invalid-document` or `unknown-kind` when the file cannot be read safely.
 */
export function parseMemoryDocument(text: string): MemoryDocument {
  const frontmatter = splitFrontmatter(text)
  const block = splitManagedBlock(frontmatter.content)
  const machine = parseFrontmatter(frontmatter.frontmatter)
  return {
    ...machine,
    sections: parseManagedBody(block.body),
    frame: block.frame,
  }
}

/**
 * Render a document back to MEMORY.md text.
 *
 * The frontmatter is written in the canonical style this module parses, so a
 * parse/render round trip reproduces the bytes of a file this module wrote.
 * @param document - document to render.
 * @returns complete file text ending with one newline.
 */
export function renderMemoryDocument(document: MemoryDocument): string {
  const frontmatter = renderFrontmatter(document)
  const body = renderManagedBody(document.sections)
  return `---\n${frontmatter}---\n${document.frame.before}${MEMORY_BLOCK_BEGIN}\n${body}${MEMORY_BLOCK_END}${document.frame.after}`
}

/**
 * Read the workspace MEMORY.md. A missing file is not an error: the caller
 * composes a new document and writes it without a version guard.
 * @param ctx - context carrying `dshStore`.
 * @param session - session whose project owns the file.
 * @param signal - cancellation for the store read.
 * @returns the path plus the parsed document and version when the file exists.
 * @throws MemoryDocumentError when an existing file cannot be parsed.
 */
export async function readMemoryDocument(
  ctx: Context,
  session: Session,
  signal?: AbortSignal,
): Promise<MemoryDocumentRead> {
  const read = await ctx.dshStore.readFile(session, MEMORY_STORE_PATH, signalOptions(signal))
  if (read.text === undefined) return { path: read.path }
  return {
    path: read.path,
    document: parseMemoryDocument(read.text),
    ...read.version === undefined ? {} : { version: read.version },
  }
}

/** One recorded summary edit or revert, kept beside MEMORY.md for rollback. */
export interface MemorySummaryHistoryRecord {
  /** ISO-8601 time of the change. */
  readonly at: string
  /** Session the edited summary belongs to. */
  readonly sessionId: string
  /** Turn the edited summary covers. */
  readonly turn: number
  /** Tier of the section that held the entry. */
  readonly tier: MemoryTier
  /** Whether the record came from an edit or a revert. */
  readonly action: 'edit' | 'revert'
  /** Text before the change. */
  readonly before: string
  /** Text after the change. */
  readonly after: string
}

/** Locator for one summary entry: a turn in the file's session by default. */
export interface MemorySummaryTarget {
  /** Session whose summary is edited; defaults to the calling session. */
  readonly sessionId?: string
  /** Turn whose entry is edited. */
  readonly turn: number
}

/** Result of one summary edit or revert. */
export interface MemorySummaryEditResult {
  /** Store-relative path that was written. */
  readonly path: string
  /** Version of the written MEMORY.md, when the store reported one. */
  readonly version?: string
  /** Session of the edited summary. */
  readonly sessionId: string
  /** Turn of the edited summary. */
  readonly turn: number
  /** Tier of the section that held the entry. */
  readonly tier: MemoryTier
  /** What changed. */
  readonly action: 'edit' | 'revert'
  /** Text before the change. */
  readonly before: string
  /** Text after the change. */
  readonly after: string
}

/**
 * Whether this document pauses the automatic summary job.
 * @param document - the parsed document, absent while MEMORY.md does not exist.
 * @returns whether completed turns skip summarization.
 */
export function summaryPaused(document: MemoryDocument | undefined): boolean {
  return document?.summaryPaused === true
}

/**
 * Read the summary edit history. A missing file is an empty history.
 * @param ctx - context carrying `dshStore`.
 * @param session - session whose project owns the file.
 * @param signal - cancellation for the store read.
 * @returns the recorded edits, oldest first.
 * @throws MemoryDocumentError when the file exists but is not a valid history array.
 */
export async function readMemorySummaryHistory(
  ctx: Context,
  session: Session,
  signal?: AbortSignal,
): Promise<readonly MemorySummaryHistoryRecord[]> {
  const read = await ctx.dshStore.readFile(session, MEMORY_HISTORY_STORE_PATH, signalOptions(signal))
  if (read.text === undefined) return Object.freeze([])
  return parseSummaryHistory(read.text)
}

/**
 * Pause or resume the automatic summary job and persist the choice in MEMORY.md.
 * @param ctx - context carrying `dshStore`.
 * @param session - session whose project owns the file.
 * @param paused - whether future completed turns skip summarization.
 * @param signal - cancellation for the reads and write.
 * @param options - window thresholds for a new document and the body budget.
 * @returns the written path, the new version, and the flag now in effect.
 */
export async function setMemorySummaryPaused(
  ctx: Context,
  session: Session,
  paused: boolean,
  signal?: AbortSignal,
  options: MemoryAppendOptions = {},
): Promise<{ readonly path: string; readonly version?: string; readonly paused: boolean }> {
  const current = await readMemoryDocument(ctx, session, signal)
  const document = current.document ?? createMemoryDocument(options.window ?? DEFAULT_MEMORY_WINDOW)
  const next: MemoryDocument = paused
    ? Object.freeze({ ...document, summaryPaused: true })
    : Object.freeze({
      version: document.version,
      window: document.window,
      sessions: document.sessions,
      sections: document.sections,
      frame: document.frame,
    })
  const written = await writeNextMemoryDocument(ctx, session, next, current.version, signal, options)
  return { path: written.path, ...written.version === undefined ? {} : { version: written.version }, paused }
}

/**
 * Replace one summary entry's text and record the change for rollback.
 * @param ctx - context carrying `dshStore`.
 * @param session - session whose project owns the file.
 * @param target - the session and turn whose entry is edited.
 * @param text - the new single-line text.
 * @param signal - cancellation for the reads and writes.
 * @param options - window thresholds and the body budget.
 * @returns what the edit changed.
 * @throws MemoryDocumentError when the file or the entry is missing, or the text is empty.
 */
export async function editMemorySummary(
  ctx: Context,
  session: Session,
  target: MemorySummaryTarget,
  text: string,
  signal?: AbortSignal,
  options: MemoryAppendOptions = {},
): Promise<MemorySummaryEditResult> {
  return applySummaryChange(ctx, session, target, normalizeSummaryText(text), 'edit', signal, options)
}

/**
 * Restore the text recorded by the latest edit of one summary entry.
 * @param ctx - context carrying `dshStore`.
 * @param session - session whose project owns the file.
 * @param target - the session and turn whose entry is restored.
 * @param signal - cancellation for the reads and writes.
 * @param options - window thresholds and the body budget.
 * @returns what the revert changed.
 * @throws MemoryDocumentError when the file, the entry, or a recorded edit is missing.
 */
export async function revertMemorySummary(
  ctx: Context,
  session: Session,
  target: MemorySummaryTarget,
  signal?: AbortSignal,
  options: MemoryAppendOptions = {},
): Promise<MemorySummaryEditResult> {
  const sessionId = target.sessionId ?? String(session.id)
  const history = await readMemorySummaryHistory(ctx, session, signal)
  const record = [...history].reverse().find(candidate =>
    candidate.sessionId === sessionId && candidate.turn === target.turn && candidate.action === 'edit')
  if (record === undefined) {
    throw new MemoryDocumentError(
      `no recorded edit for session ${sessionId} turn ${String(target.turn)}; only edited summaries can be reverted`,
      'invalid-document',
    )
  }
  return applySummaryChange(ctx, session, target, record.before, 'revert', signal, options)
}

/** Apply one edit or revert, write MEMORY.md, and append the history record. */
async function applySummaryChange(
  ctx: Context,
  session: Session,
  target: MemorySummaryTarget,
  text: string,
  action: 'edit' | 'revert',
  signal: AbortSignal | undefined,
  options: MemoryAppendOptions,
): Promise<MemorySummaryEditResult> {
  const current = await readMemoryDocument(ctx, session, signal)
  if (current.document === undefined) {
    throw new MemoryDocumentError('MEMORY.md does not exist yet; run one summarized turn first', 'invalid-document')
  }
  const sessionId = target.sessionId ?? String(session.id)
  const located = locateSummaryEntry(current.document, sessionId, target.turn)
  const before = located.entry.text
  const nextEntry: MemoryEntry = Object.freeze({
    kind: located.entry.kind,
    text,
    turn: target.turn,
    ...located.entry.tags === undefined ? {} : { tags: located.entry.tags },
    source: 'manual',
    version: (located.entry.version ?? 0) + 1,
  })
  const next: MemoryDocument = Object.freeze({
    ...current.document,
    sections: current.document.sections.map((section) => {
      if (section !== located.section) return section
      return Object.freeze({
        ...section,
        entries: section.entries.map(entry => entry === located.entry ? nextEntry : entry),
      })
    }),
  })
  const written = await writeNextMemoryDocument(ctx, session, next, current.version, signal, options)
  try {
    await appendSummaryHistory(ctx, session, {
      at: new Date().toISOString(),
      sessionId,
      turn: target.turn,
      tier: located.section.tier,
      action,
      before,
      after: text,
    }, signal)
  } catch (error: unknown) {
    // The edit already landed; losing the sidecar record only loses the ability to revert this one change.
    ctx.logger.warn('memory: could not record summary history: %s', errorMessage(error))
  }
  return {
    path: written.path,
    ...written.version === undefined ? {} : { version: written.version },
    sessionId,
    turn: target.turn,
    tier: located.section.tier,
    action,
    before,
    after: text,
  }
}

/**
 * Drop duplicate entries and over-cap sections of one session, and report what changed.
 *
 * This is the `/memory prune` path: unlike the implicit retention on every append, it runs only
 * when a human asks for it and reports the counts.
 * @param ctx - context carrying `dshStore`.
 * @param session - session whose project owns the file.
 * @param target - the session to prune and the entry cap; defaults to the calling session and the
 *   append options' cap.
 * @param signal - cancellation for the reads and write.
 * @param options - window thresholds and the body budget.
 * @returns the written path, what was removed, and how many entries remain.
 * @throws MemoryDocumentError when MEMORY.md does not exist or cannot be parsed.
 */
export async function pruneMemorySession(
  ctx: Context,
  session: Session,
  target: { readonly sessionId?: string; readonly keep?: number } = {},
  signal?: AbortSignal,
  options: MemoryAppendOptions = {},
): Promise<MemoryPruneResult> {
  const current = await readMemoryDocument(ctx, session, signal)
  if (current.document === undefined) {
    throw new MemoryDocumentError('MEMORY.md does not exist yet; there is nothing to prune', 'invalid-document')
  }
  const sessionId = target.sessionId ?? String(session.id)
  const keep = Math.max(1, Math.floor(target.keep ?? options.maxEntries ?? DEFAULT_MEMORY_MAX_ENTRIES))
  const pruned = pruneSessionEntries(current.document, sessionId, keep)
  if (pruned.duplicates === 0 && pruned.overCap === 0) {
    return {
      path: current.path,
      ...current.version === undefined ? {} : { version: current.version },
      sessionId,
      duplicates: 0,
      overCap: 0,
      remaining: summarizeMemoryEntries(current.document, sessionId).entries,
      keep,
    }
  }
  const written = await writeNextMemoryDocument(ctx, session, pruned.document, current.version, signal, options)
  return {
    path: written.path,
    ...written.version === undefined ? {} : { version: written.version },
    sessionId,
    duplicates: pruned.duplicates,
    overCap: pruned.overCap,
    remaining: summarizeMemoryEntries(pruned.document, sessionId).entries,
    keep,
  }
}

/** Filter for one explicit forget pass; at least one of kind, tag, or beforeTurn is required. */
export interface MemoryForgetFilter {
  /** Session to forget in; defaults to the calling session. */
  readonly sessionId?: string
  /** Forget from every session in the file instead of one. */
  readonly allSessions?: boolean
  /** Keep only entries of another kind when matching. */
  readonly kind?: MemoryEntryKind
  /** Keep only entries carrying this label when matching. */
  readonly tag?: string
  /** Keep only entries older than this turn when matching; entries without a turn are not matched. */
  readonly beforeTurn?: number
}

/** Result of one explicit forget pass. */
export interface MemoryForgetResult {
  /** Store-relative path that was written or left untouched. */
  readonly path: string
  /** Version of the written file, when the store reported one. */
  readonly version?: string
  /** Entries removed by the filter. */
  readonly removed: number
  /** Entries remaining in the target sessions. */
  readonly remaining: number
  /** Sessions the filter covered. */
  readonly sessions: readonly string[]
  /** Removed entries per kind. */
  readonly kinds: Readonly<Record<MemoryEntryKind, number>>
  /** Records this pass wrote into the frontmatter. */
  readonly evictions: readonly MemoryEvictionRecord[]
}

/**
 * Remove entries selected by kind, tag, or turn age and record each removal.
 *
 * The filter is conjunctive: an entry must match every supplied condition. A filter without any
 * condition is refused, because an accidental empty filter would otherwise erase the workspace's
 * memory. The write keeps the version guard and one stale retry, and entries are dropped from the
 * managed block and the frontmatter turn index together.
 * @param ctx - context carrying `dshStore`.
 * @param session - session whose project owns the file; its id is the default target.
 * @param filter - session scope and matching conditions.
 * @param signal - cancellation for the reads and write.
 * @param options - window thresholds for a missing document and the body budget.
 * @returns what was removed and what remains.
 * @throws MemoryDocumentError when the filter is empty, invalid, or MEMORY.md is missing.
 * @throws FsError when the guarded write fails twice or the store refuses the write.
 */
export async function forgetMemoryEntries(
  ctx: Context,
  session: Session,
  filter: MemoryForgetFilter,
  signal?: AbortSignal,
  options: MemoryAppendOptions = {},
): Promise<MemoryForgetResult> {
  const kind = filter.kind === undefined ? undefined : assertMemoryEntryKind(filter.kind)
  const tag = filter.tag?.trim()
  if (tag !== undefined && tag.length === 0) {
    throw new MemoryDocumentError('a forget tag must not be empty', 'invalid-document')
  }
  if (filter.beforeTurn !== undefined
    && (!Number.isSafeInteger(filter.beforeTurn) || filter.beforeTurn < 0)) {
    throw new MemoryDocumentError('forget beforeTurn must be a non-negative integer', 'invalid-document')
  }
  if (kind === undefined && tag === undefined && filter.beforeTurn === undefined) {
    throw new MemoryDocumentError(
      'forget needs at least one of kind, tag, or beforeTurn',
      'invalid-document',
    )
  }
  if (filter.allSessions === true && filter.sessionId !== undefined) {
    throw new MemoryDocumentError('forget cannot combine allSessions with sessionId', 'invalid-document')
  }
  const current = await readMemoryDocument(ctx, session, signal)
  if (current.document === undefined) {
    throw new MemoryDocumentError('MEMORY.md does not exist yet; there is nothing to forget', 'invalid-document')
  }
  const targetIds = filter.allSessions === true
    ? new Set(current.document.sessions.map(record => record.id))
    : new Set([filter.sessionId ?? String(session.id)])
  const kinds: Record<MemoryEntryKind, number> = { decision: 0, files: 0, open: 0, preference: 0 }
  const removed: MemoryEvictionRecord[] = []
  const removedTurns = new Set<number>()
  const sections: MemorySection[] = []
  for (const section of current.document.sections) {
    if (!targetIds.has(section.sessionId)) {
      sections.push(section)
      continue
    }
    const kept: MemoryEntry[] = []
    for (const entry of section.entries) {
      if (!matchesForget(entry, kind, tag, filter.beforeTurn)) {
        kept.push(entry)
        continue
      }
      removed.push(evictionRecord(entry, section, 'manual-forget', describeForget(filter, kind, tag)))
      kinds[entry.kind] += 1
      if (entry.turn !== undefined) removedTurns.add(entry.turn)
    }
    if (kept.length === 0) continue
    sections.push(kept.length === section.entries.length
      ? section
      : Object.freeze({ ...section, entries: Object.freeze(kept) }))
  }
  if (removed.length === 0) {
    return {
      path: current.path,
      ...current.version === undefined ? {} : { version: current.version },
      removed: 0,
      remaining: countSessionEntries(current.document, targetIds),
      sessions: [...targetIds],
      kinds,
      evictions: [],
    }
  }
  const remainingTurns = new Set(sections
    .filter(section => targetIds.has(section.sessionId))
    .flatMap(section => section.entries.flatMap(entry => entry.turn === undefined ? [] : [entry.turn])))
  const sessions = current.document.sessions
    .filter(record => sections.some(section => section.sessionId === record.id))
    .map((record) => {
      const turns = record.turns.filter(turn => !removedTurns.has(turn.turn) || remainingTurns.has(turn.turn))
      return turns.length === record.turns.length ? record : Object.freeze({ ...record, turns: Object.freeze(turns) })
    })
  const evictions = [...(current.document.evictions ?? []), ...removed].slice(-MEMORY_EVICTION_RECORD_LIMIT)
  const next = Object.freeze({ ...current.document, sections: Object.freeze(sections), sessions, evictions })
  const written = await writeNextMemoryDocument(ctx, session, next, current.version, signal, options)
  return {
    path: written.path,
    ...written.version === undefined ? {} : { version: written.version },
    removed: removed.length,
    remaining: countSessionEntries(next, targetIds),
    sessions: [...targetIds],
    kinds,
    evictions: removed,
  }
}

/** Whether one entry matches a forget filter; every supplied condition must hold. */
function matchesForget(
  entry: MemoryEntry,
  kind: MemoryEntryKind | undefined,
  tag: string | undefined,
  beforeTurn: number | undefined,
): boolean {
  if (kind !== undefined && entry.kind !== kind) return false
  if (tag !== undefined && !(entry.tags ?? []).includes(tag)) return false
  if (beforeTurn !== undefined && (entry.turn === undefined || entry.turn >= beforeTurn)) return false
  return true
}

/** Render the filter into the durable eviction record. */
function describeForget(
  filter: MemoryForgetFilter,
  kind: MemoryEntryKind | undefined,
  tag: string | undefined,
): string {
  const parts = [
    kind === undefined ? undefined : `kind=${kind}`,
    tag === undefined ? undefined : `tag=${JSON.stringify(tag)}`,
    filter.beforeTurn === undefined ? undefined : `beforeTurn=${String(filter.beforeTurn)}`,
    filter.allSessions === true ? 'allSessions' : undefined,
  ].filter((part): part is string => part !== undefined)
  return `manual forget (${parts.join(', ')})`
}

/** Count entries in the target sessions. */
function countSessionEntries(document: MemoryDocument, sessionIds: ReadonlySet<string>): number {
  return document.sections
    .filter(section => sessionIds.has(section.sessionId))
    .reduce((total, section) => total + section.entries.length, 0)
}

/** Result of one `/memory prune`. */
export interface MemoryPruneResult {
  /** Store-relative path that was written or left untouched. */
  readonly path: string
  /** Version of the written file, when the store reported one. */
  readonly version?: string
  /** Session that was pruned. */
  readonly sessionId: string
  /** Entries removed as duplicates. */
  readonly duplicates: number
  /** Entries removed with the oldest sections over the cap. */
  readonly overCap: number
  /** Entries remaining for the session. */
  readonly remaining: number
  /** Entry cap the prune used. */
  readonly keep: number
}

/** Result of one explicit resolve call. */
export interface MemoryResolveStoreResult {
  /** Store-relative path that was written or left untouched. */
  readonly path: string
  /** Version of the written file, when the store reported one. */
  readonly version?: string
  /** Number of entries resolved and archived. */
  readonly removed: number
  /** Entries remaining in the target session after the resolve. */
  readonly remaining: number
  /** Archive records written by this resolve. */
  readonly records: readonly MemoryArchiveRecord[]
}

/**
 * Resolve entries explicitly: archive them, remove them from the active block,
 * and write MEMORY.md under the version guard.
 * @param ctx - context carrying `dshStore`.
 * @param session - session whose project owns the files; the default target.
 * @param filter - session, kind, and the turn/tag/all narrowing condition.
 * @param signal - cancellation for the reads and write.
 * @param options - window thresholds and the body budget.
 * @returns what was archived and what remains.
 * @throws MemoryDocumentError when the filter is under-specified or MEMORY.md is missing.
 * @throws FsError when the guarded write fails twice or the store refuses the write.
 */
export async function resolveMemoryEntriesInStore(
  ctx: Context,
  session: Session,
  filter: MemoryResolveFilter,
  signal?: AbortSignal,
  options: MemoryAppendOptions = {},
): Promise<MemoryResolveStoreResult> {
  const current = await readMemoryDocument(ctx, session, signal)
  if (current.document === undefined) {
    throw new MemoryDocumentError('MEMORY.md does not exist yet; there is nothing to resolve', 'invalid-document')
  }
  const resolved = resolveMemoryEntries(current.document, filter)
  const sessionId = filter.sessionId
  const remaining = resolved.document.sections
    .filter(section => section.sessionId === sessionId)
    .reduce((total, section) => total + section.entries.length, 0)
  if (resolved.removed === 0) {
    return {
      path: current.path,
      ...current.version === undefined ? {} : { version: current.version },
      removed: 0,
      remaining,
      records: [],
    }
  }
  if (!await archiveContained(ctx, session, resolved.records, signal)) {
    ctx.logger.warn('memory: resolve skipped [FILE_IO]; the archive could not be written')
    throw new MemoryDocumentError(
      'MEMORY.archive.md could not be written; the resolve was skipped and no active entry was removed',
      'invalid-document',
    )
  }
  const next = appendEvictionRecords(
    resolved.document,
    resolved.records.map(archiveEvictionRecord),
  )
  const written = await writeNextMemoryDocument(ctx, session, next, current.version, signal, options)
  return {
    path: written.path,
    ...written.version === undefined ? {} : { version: written.version },
    removed: resolved.removed,
    remaining,
    records: resolved.records,
  }
}

/** Locate the entry for one turn, naming the turns this session does have. */
function locateSummaryEntry(
  document: MemoryDocument,
  sessionId: string,
  turn: number,
): { readonly section: MemorySection; readonly entry: MemoryEntry } {
  for (const section of document.sections) {
    if (section.sessionId !== sessionId) continue
    const entry = section.entries.find(candidate => candidate.turn === turn)
    if (entry !== undefined) return { section, entry }
  }
  const known = document.sections
    .filter(section => section.sessionId === sessionId)
    .flatMap(section => section.entries.map(entry => entry.turn))
    .filter((candidate): candidate is number => candidate !== undefined)
  const names = known.length === 0 ? 'none' : known.join(', ')
  throw new MemoryDocumentError(
    `MEMORY.md has no per-turn summary for session ${sessionId} turn ${String(turn)}; known turns: ${names}`,
    'invalid-document',
  )
}

/** Re-render and write one document, retrying once after a stale-version refusal. */
async function writeNextMemoryDocument(
  ctx: Context,
  session: Session,
  document: MemoryDocument,
  expected: string | undefined,
  signal: AbortSignal | undefined,
  options: MemoryAppendOptions,
): Promise<{ readonly path: string; readonly version?: string }> {
  const maxBytes = options.maxBytes ?? DEFAULT_MEMORY_MAX_BYTES
  assertBodyBudget(document, maxBytes)
  const write = async (version: string | undefined): Promise<{ readonly path: string; readonly version?: string }> => {
    const written = await ctx.dshStore.writeFile(
      session,
      MEMORY_STORE_PATH,
      renderMemoryDocument(document),
      writeOptions(signal, version),
    )
    return { path: written.path, ...written.version === undefined ? {} : { version: written.version } }
  }
  try {
    return await write(expected)
  } catch (error: unknown) {
    if (!isStaleVersion(error)) throw error
    const reread = await readMemoryDocument(ctx, session, signal)
    return await write(reread.version)
  }
}

/** Append one history record, keeping the newest {@link MEMORY_HISTORY_LIMIT} records. */
async function appendSummaryHistory(
  ctx: Context,
  session: Session,
  record: MemorySummaryHistoryRecord,
  signal?: AbortSignal,
): Promise<void> {
  const read = await ctx.dshStore.readFile(session, MEMORY_HISTORY_STORE_PATH, signalOptions(signal))
  const records = read.text === undefined ? [] : parseSummaryHistory(read.text)
  const next = [...records, record].slice(-MEMORY_HISTORY_LIMIT)
  await ctx.dshStore.writeFile(
    session,
    MEMORY_HISTORY_STORE_PATH,
    `${JSON.stringify(next, null, 2)}\n`,
    writeOptions(signal, read.version),
  )
}

/** Parse the sidecar history, rejecting a malformed record instead of losing rollback silently. */
function parseSummaryHistory(text: string): readonly MemorySummaryHistoryRecord[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error: unknown) {
    throw new MemoryDocumentError(`MEMORY.history.json is not valid JSON: ${errorMessage(error)}`, 'invalid-document')
  }
  if (!Array.isArray(parsed)) {
    throw new MemoryDocumentError('MEMORY.history.json must be an array of records', 'invalid-document')
  }
  return Object.freeze(parsed.map((value, index) => {
    const subject = `MEMORY.history.json[${String(index)}]`
    const record = asRecord(value, subject)
    const action = record['action']
    if (action !== 'edit' && action !== 'revert') {
      throw new MemoryDocumentError(`${subject}.action must be "edit" or "revert"`, 'invalid-document')
    }
    const tier = record['tier']
    if (tier !== 'detail' && tier !== 'brief') {
      throw new MemoryDocumentError(`${subject}.tier must be "detail" or "brief"`, 'invalid-document')
    }
    return Object.freeze({
      at: requireString(record, 'at', subject),
      sessionId: requireString(record, 'sessionId', subject),
      turn: requireInteger(record, 'turn', subject, 0),
      tier,
      action,
      before: requireString(record, 'before', subject),
      after: requireString(record, 'after', subject),
    })
  }))
}

/** Collapse one manual summary edit onto one line and refuse empty text. */
function normalizeSummaryText(text: string): string {
  const normalized = text.replaceAll(/\s+/gu, ' ').trim()
  if (normalized === '') throw new MemoryDocumentError('a summary edit needs non-empty text', 'empty-summary')
  return normalized
}

/**
 * Write archive records without failing the active write.
 * @returns whether every record was archived.
 */
async function archiveContained(
  ctx: Context,
  session: Session,
  records: readonly MemoryArchiveRecord[],
  signal: AbortSignal | undefined,
): Promise<boolean> {
  if (records.length === 0) return true
  try {
    const written = await appendMemoryArchive(ctx, session, records, signal)
    ctx.logger.debug(
      'memory: archived %d entr%s to %s: %s',
      written.added,
      written.added === 1 ? 'y' : 'ies',
      written.path,
      records.map(record => `${record.sessionId}/${record.turn === undefined ? '?' : String(record.turn)}/${record.kind}:${record.text.slice(0, 60)}`).join(' | '),
    )
    return true
  } catch (error: unknown) {
    const failure = classifySummaryFailure(error, 1)
    ctx.logger.warn(
      'memory: could not archive %d removed entry/entries [%s]: %s; keeping the active file write',
      records.length,
      failure.code,
      failure.detail,
    )
    ctx.logger.debug('memory: archive failure detail: %o', error)
    ctx.logger.debug(
      'memory: unarchived entries: %s',
      records.map(record => `${record.sessionId}/${record.turn === undefined ? '?' : String(record.turn)}/${record.kind}:${record.text.slice(0, 60)}`).join(' | '),
    )
    return false
  }
}

/**
 * Run the automatic cleanup rules over a composed append.
 * @param ctx - context carrying the session query for entry ages.
 * @param document - document after the new entries were composed.
 * @param options - TTL and supersession settings.
 * @param signal - cancellation for the best-effort log reads.
 * @param newer - the just-appended entry, when it may supersede older siblings.
 * @returns the cleaned document and archive records.
 */
async function cleanupForAppend(
  ctx: Context,
  previous: MemoryDocument,
  document: MemoryDocument,
  options: MemoryAppendOptions,
  signal: AbortSignal | undefined,
  newer?: MemoryCleanupNewerEntry,
): Promise<{ readonly document: MemoryDocument; readonly records: readonly MemoryArchiveRecord[] }> {
  const openTtlDays = options.openTtlDays ?? 3
  const filesTtlDays = options.filesTtlDays ?? 14
  if (openTtlDays <= 0 && filesTtlDays <= 0 && newer === undefined) {
    return { document, records: [] }
  }
  let entryTimes: ReadonlyMap<MemoryEntry, number> | undefined
  if (openTtlDays > 0 || filesTtlDays > 0) {
    const times = new Map(await collectMemoryEntryTimes(ctx, document, signal))
    // The append updates the session's frontmatter timestamp, so an entry with no
    // turn-log time must fall back to the timestamp from before this write.
    for (const section of previous.sections) {
      const fallback = Date.parse(previous.sessions.find(record => record.id === section.sessionId)?.updatedAt ?? '')
      if (Number.isNaN(fallback)) continue
      for (const entry of section.entries) {
        if (!times.has(entry)) times.set(entry, fallback)
      }
    }
    entryTimes = times
  }
  try {
    const cleaned = cleanupMemoryDocument(document, {
      ...options.now === undefined ? {} : { now: options.now },
      openTtlDays,
      filesTtlDays,
      ...options.supersessionMinSharedTags === undefined ? {} : {
        supersessionMinSharedTags: options.supersessionMinSharedTags,
      },
      ...entryTimes === undefined ? {} : { entryTimes },
      ...newer === undefined ? {} : { newerEntry: newer },
    })
    return { document: cleaned.document, records: cleaned.records }
  } catch (error: unknown) {
    // Cleanup is auxiliary: a planner failure must not turn a valid memory write into a failure.
    const failure = classifySummaryFailure(error, 1)
    ctx.logger.warn('memory: automatic cleanup failed [%s]: %s; keeping active entries', failure.code, failure.detail)
    ctx.logger.debug('memory: automatic cleanup failure detail: %o', error)
    return { document, records: [] }
  }
}

/**
 * Append one entry to the managed block of the workspace MEMORY.md.
 *
 * The entry joins the last section of its session when that section covers the
 * same turn and tier; otherwise a new section and frontmatter turn record are
 * created. Automatic cleanup runs before retention: TTL, explicit supersession,
 * and same-turn deduplication archive entries without failing the write. The
 * write is version-guarded against the text that was read, and one
 * `FS_STALE_VERSION` conflict is retried after a re-read.
 * @param ctx - context carrying `dshStore`.
 * @param session - session the entry belongs to; its project owns the file.
 * @param entry - the entry and the turn it summarizes.
 * @param signal - cancellation for the store read and write.
 * @param options - window thresholds, body budget, and cleanup settings.
 * @returns the written path, the new version, the entry kind, and every removal.
 * @throws MemoryDocumentError `budget-exceeded` when the body would exceed the budget.
 * @throws FsError when the guarded write fails twice or the store refuses the write.
 */
export async function appendMemoryEntry(
  ctx: Context,
  session: Session,
  entry: MemoryEntryInput,
  signal?: AbortSignal,
  options: MemoryAppendOptions = {},
): Promise<MemoryAppendResult> {
  const kind = assertMemoryEntryKind(entry.kind)
  const window = options.window ?? DEFAULT_MEMORY_WINDOW
  const maxBytes = options.maxBytes ?? DEFAULT_MEMORY_MAX_BYTES
  const maxEntries = options.maxEntries ?? DEFAULT_MEMORY_MAX_ENTRIES
  const protect = (candidate: MemoryEntry, section: MemorySection): boolean =>
    section.sessionId === String(session.id) && candidate.turn === entry.turn
  const append = async (): Promise<MemoryAppendResult> => {
    const current = await readMemoryDocument(ctx, session, signal)
    const document = current.document ?? createMemoryDocument(window)
    const composed = appendToDocument(document, session, entry, kind)
    const newer: MemoryCleanupNewerEntry = {
      sessionId: String(session.id),
      turn: entry.turn,
      kind,
      ...entry.tags === undefined ? {} : { tags: normalizeEntryTags(entry.tags) },
      ...entry.supersedes === undefined ? {} : { supersedes: normalizeEntryTags(entry.supersedes) },
    }
    const cleaned = await cleanupForAppend(ctx, document, composed, options, signal, newer)
    let retained = retainDocument(cleaned.document, session.id, window, maxBytes, maxEntries, protect)
    assertBodyBudget(retained.document, maxBytes)
    const cleanupArchived = await archiveContained(ctx, session, cleaned.records, signal)
    let evictions = retained.evictions
    if (!cleanupArchived) {
      // Keep the entries that could not be archived; retention still guarantees the budget.
      retained = retainDocument(composed, session.id, window, maxBytes, maxEntries, protect)
      await archiveContained(ctx, session, retained.archive, signal)
      evictions = retained.evictions
    } else {
      await archiveContained(ctx, session, retained.archive, signal)
      evictions = [...retained.evictions, ...cleaned.records.map(archiveEvictionRecord)]
    }
    const next = appendEvictionRecords(
      retained.document,
      cleanupArchived ? cleaned.records.map(archiveEvictionRecord) : [],
    )
    assertBodyBudget(next, maxBytes)
    const written = await ctx.dshStore.writeFile(
      session,
      MEMORY_STORE_PATH,
      renderMemoryDocument(next),
      writeOptions(signal, current.version),
    )
    return {
      path: written.path,
      kind,
      evictions,
      ...written.version === undefined ? {} : { version: written.version },
    }
  }
  try {
    return await append()
  } catch (error: unknown) {
    if (!isStaleVersion(error)) throw error
    return await append()
  }
}

/**
 * Append several completed turns' detail summaries in one version-guarded write.
 *
 * The batch is composed in turn order: each turn gets its own frontmatter
 * `turns` record and its entries carry that turn marker, while consecutive
 * turns may share one detail section. Cleanup, retention, archive, and the
 * write happen once, so a failure before the write leaves every turn pending
 * and no partial batch in the file.
 * @param ctx - context carrying `dshStore`.
 * @param session - session the summaries belong to.
 * @param summaries - validated entry groups for the batch turns.
 * @param signal - cancellation for the reads and write.
 * @param options - window thresholds, body budget, and cleanup settings.
 * @returns the written path, version, per-turn counts, and removals.
 * @throws MemoryDocumentError when the batch is empty, has duplicate turns, or has no entries.
 * @throws FsError when the guarded write fails twice or the store refuses the write.
 */
export async function appendTurnSummaries(
  ctx: Context,
  session: Session,
  summaries: readonly MemoryTurnSummaryInput[],
  signal?: AbortSignal,
  options: MemoryTurnSummaryOptions = {},
): Promise<MemoryTurnSummariesResult> {
  if (summaries.length === 0) {
    throw new MemoryDocumentError('a turn summary batch needs at least one turn', 'empty-summary')
  }
  const seen = new Set<number>()
  const prepared = summaries.map((summary) => {
    if (seen.has(summary.turn)) {
      throw new MemoryDocumentError(`a turn summary batch repeats turn ${String(summary.turn)}`, 'invalid-document')
    }
    seen.add(summary.turn)
    if (summary.entries.length === 0) {
      throw new MemoryDocumentError('a turn summary needs at least one entry', 'empty-summary')
    }
    return {
      summary,
      entries: summary.entries.map(entry => ({
        kind: assertMemoryEntryKind(entry.kind),
        text: entry.text,
        ...entry.tags === undefined ? {} : { tags: normalizeEntryTags(entry.tags) },
      })),
    }
  })
  const window = options.window ?? DEFAULT_MEMORY_WINDOW
  const maxBytes = options.maxBytes ?? DEFAULT_MEMORY_MAX_BYTES
  const maxEntries = options.maxEntries ?? DEFAULT_MEMORY_MAX_ENTRIES
  const turns = new Set(summaries.map(summary => summary.turn))
  const protect = (candidate: MemoryEntry, section: MemorySection): boolean =>
    section.sessionId === String(session.id) && candidate.turn !== undefined && turns.has(candidate.turn)
  const append = async (): Promise<MemoryTurnSummariesResult> => {
    const current = await readMemoryDocument(ctx, session, signal)
    const document = current.document ?? createMemoryDocument(window)
    let composed = document
    for (const { summary, entries } of prepared) {
      composed = appendTurnToDocument(composed, session, summary, entries)
    }
    const cleaned = await cleanupForAppend(ctx, document, composed, options, signal)
    let retained = retainDocument(cleaned.document, session.id, window, maxBytes, maxEntries, protect)
    assertBodyBudget(retained.document, maxBytes)
    const cleanupArchived = await archiveContained(ctx, session, cleaned.records, signal)
    let evictions = retained.evictions
    if (!cleanupArchived) {
      retained = retainDocument(composed, session.id, window, maxBytes, maxEntries, protect)
      await archiveContained(ctx, session, retained.archive, signal)
      evictions = retained.evictions
    } else {
      await archiveContained(ctx, session, retained.archive, signal)
      evictions = [...retained.evictions, ...cleaned.records.map(archiveEvictionRecord)]
    }
    const next = appendEvictionRecords(
      retained.document,
      cleanupArchived ? cleaned.records.map(archiveEvictionRecord) : [],
    )
    assertBodyBudget(next, maxBytes)
    const written = await ctx.dshStore.writeFile(
      session,
      MEMORY_STORE_PATH,
      renderMemoryDocument(next),
      writeOptions(signal, current.version),
    )
    return {
      path: written.path,
      turns: prepared.map(item => ({ turn: item.summary.turn, entries: item.entries.length })),
      evictions,
      ...written.version === undefined ? {} : { version: written.version },
    }
  }
  try {
    return await append()
  } catch (error: unknown) {
    if (!isStaleVersion(error)) throw error
    return await append()
  }
}

/**
 * Append one turn's detail summary to the managed block of the workspace MEMORY.md.
 *
 * The entries form one section covering the turn. A section for the same
 * session whose last turn is this turn or the turn immediately before it is
 * extended, so consecutive summarized turns share one `turn N–M（detail）`
 * heading. The frontmatter turn record is replaced with this turn's seq range
 * and tier, and the write is version-guarded exactly like
 * {@link appendMemoryEntry}: one stale-version conflict is retried after a
 * re-read.
 * @param ctx - context carrying `dshStore`.
 * @param session - session the summary belongs to; its project owns the file.
 * @param summary - the turn, its seq range, and its validated entries.
 * @param signal - cancellation for the store read and write.
 * @param options - window thresholds for a new document and the body budget.
 * @returns the written path, the new version, and the entry count.
 * @throws MemoryDocumentError `empty-summary` when no entries are supplied,
 *   `unknown-kind` for an invalid entry kind, or `budget-exceeded` when the body
 *   would exceed the budget.
 * @throws FsError when the guarded write fails twice or the store refuses the write.
 */
export async function appendTurnSummary(
  ctx: Context,
  session: Session,
  summary: MemoryTurnSummaryInput,
  signal?: AbortSignal,
  options: MemoryTurnSummaryOptions = {},
): Promise<MemoryTurnSummaryResult> {
  if (summary.entries.length === 0) {
    throw new MemoryDocumentError('a turn summary needs at least one entry', 'empty-summary')
  }
  const entries = summary.entries.map(entry => ({
    kind: assertMemoryEntryKind(entry.kind),
    text: entry.text,
    ...entry.tags === undefined ? {} : { tags: normalizeEntryTags(entry.tags) },
  }))
  const window = options.window ?? DEFAULT_MEMORY_WINDOW
  const maxBytes = options.maxBytes ?? DEFAULT_MEMORY_MAX_BYTES
  const maxEntries = options.maxEntries ?? DEFAULT_MEMORY_MAX_ENTRIES
  const protect = (candidate: MemoryEntry, section: MemorySection): boolean =>
    section.sessionId === String(session.id) && candidate.turn === summary.turn
  const append = async (): Promise<MemoryTurnSummaryResult> => {
    const current = await readMemoryDocument(ctx, session, signal)
    const document = current.document ?? createMemoryDocument(window)
    const composed = appendTurnToDocument(document, session, summary, entries)
    const cleaned = await cleanupForAppend(ctx, document, composed, options, signal)
    let retained = retainDocument(cleaned.document, session.id, window, maxBytes, maxEntries, protect)
    assertBodyBudget(retained.document, maxBytes)
    const cleanupArchived = await archiveContained(ctx, session, cleaned.records, signal)
    let evictions = retained.evictions
    if (!cleanupArchived) {
      retained = retainDocument(composed, session.id, window, maxBytes, maxEntries, protect)
      await archiveContained(ctx, session, retained.archive, signal)
      evictions = retained.evictions
    } else {
      await archiveContained(ctx, session, retained.archive, signal)
      evictions = [...retained.evictions, ...cleaned.records.map(archiveEvictionRecord)]
    }
    const next = appendEvictionRecords(
      retained.document,
      cleanupArchived ? cleaned.records.map(archiveEvictionRecord) : [],
    )
    assertBodyBudget(next, maxBytes)
    const written = await ctx.dshStore.writeFile(
      session,
      MEMORY_STORE_PATH,
      renderMemoryDocument(next),
      writeOptions(signal, current.version),
    )
    return {
      path: written.path,
      turn: summary.turn,
      entries: entries.length,
      evictions,
      ...written.version === undefined ? {} : { version: written.version },
    }
  }
  try {
    return await append()
  } catch (error: unknown) {
    if (!isStaleVersion(error)) throw error
    return await append()
  }
}

/**
 * Apply one session's tier migrations to the workspace MEMORY.md.
 *
 * The pass reads the document once, replaces each detail range that reached the
 * detail age with a detail checkpoint, compresses each detail section that
 * reached the brief age through the supplied model callback, replaces the
 * matching surface range with a brief checkpoint, removes forgotten section
 * bodies, and writes the complete batch with one version-guarded write. Ranges an
 * earlier pass migrated but could not replace on the surface (a snapshot, a
 * compaction checkpoint, or a gap) are retried from the stored text, without
 * re-compressing. A failed compression keeps that section at detail and does not
 * block the other ranges. One stale-version conflict re-reads and applies the
 * plan once more; surface replacements already made are reused by their window,
 * so they are not appended twice.
 * @param ctx - context carrying the store, session query, and logger.
 * @param session - session whose turns are migrated.
 * @param currentTurn - latest completed turn of that session.
 * @param compress - model callback that turns one detail section into a brief.
 * @param signal - cancellation for model calls and the page write.
 * @param options - window thresholds and the managed-body budget.
 * @returns the written path and migrated section counts, or undefined when the
 *   document has nothing to migrate and no skipped replacement to retry.
 * @throws MemoryDocumentError `budget-exceeded` when the body after migration
 *   would exceed the budget.
 * @throws FsError when the guarded write fails twice or the store refuses it.
 */
export async function migrateMemoryTiers(
  ctx: Context,
  session: Session,
  currentTurn: number,
  compress: MemoryTierCompressor,
  signal?: AbortSignal,
  options: MemoryTierMigrationOptions = {},
): Promise<MemoryTierMigrationResult | undefined> {
  const allowSurfaceReplace = options.allowSurfaceReplace ?? true
  const window = options.window ?? DEFAULT_MEMORY_WINDOW
  const maxBytes = options.maxBytes ?? DEFAULT_MEMORY_MAX_BYTES
  const compressed = new Map<string, readonly MemoryEntry[]>()
  const checkpoints = new Map<string, number>()
  const migrate = async (): Promise<MemoryTierMigrationResult | undefined> => {
    signal?.throwIfAborted()
    const current = await readMemoryDocument(ctx, session, signal)
    if (current.document === undefined) return undefined
    const plan = planTierMigrations(current.document, currentTurn, { ...window, sessionId: session.id })
    if (plan.toDetail.length === 0 && plan.toBrief.length === 0 && plan.toForget.length === 0
      && plan.retry.length === 0) return undefined
    const briefs = await compressBriefs(ctx, current.document, session, plan, compress, compressed, signal)
    if (plan.toDetail.length === 0 && briefs.length === 0 && plan.toForget.length === 0
      && plan.retry.length === 0) return undefined
    await checkpointMigrations(ctx, current.document, session, plan, briefs, checkpoints, signal, allowSurfaceReplace)
    const retried = plan.retry.filter(retry => checkpoints.has(rangeKey(retry.action, retry))).length
    const detailed = plan.toDetail.filter(range => checkpoints.has(rangeKey('detail', range))).length
    // The document still migrates when surface replacements are deferred (between compactions):
    // MEMORY.md keeps the tiered summaries for search, and a missing checkpointSeq records the
    // pending surface action for the next compaction boundary. A deferred detail range alone
    // changes nothing on disk, so it must not rewrite MEMORY.md on every turn.
    const documentChanged = detailed > 0 || briefs.length > 0 || plan.toForget.length > 0 || retried > 0
    if (!documentChanged) return undefined
    // Once a checkpoint left the surface, the metadata write must finish even if the
    // provider was disabled meanwhile: skipping it here is exactly the half-committed
    // state (checkpoint published, MEMORY.md unchanged) this pass avoids.
    const retained = retainDocument(
      applyMigrations(current.document, session, plan, briefs, checkpoints),
      session.id,
      window,
      maxBytes,
      options.maxEntries ?? DEFAULT_MEMORY_MAX_ENTRIES,
      (_candidate, section) => section.sessionId === String(session.id) && section.tier === 'brief',
    )
    const next = retained.document
    assertBodyBudget(next, maxBytes)
    await archiveContained(ctx, session, retained.archive, undefined)
    const written = await ctx.dshStore.writeFile(
      session,
      MEMORY_STORE_PATH,
      renderMemoryDocument(next),
      writeOptions(undefined, current.version),
    )
    return {
      path: written.path,
      detailed,
      briefed: briefs.length,
      forgotten: plan.toForget.length,
      retried,
      evictions: retained.evictions,
      ...written.version === undefined ? {} : { version: written.version },
    }
  }
  try {
    return await migrate()
  } catch (error: unknown) {
    if (!isStaleVersion(error)) throw error
    return await migrate()
  }
}

/** One detail section compressed for its brief checkpoint. */
interface BriefMigration {
  /** Turns the section covers. */
  readonly range: TurnRange
  /** Brief entries to store and publish. */
  readonly entries: readonly MemoryEntry[]
}

/** Compress every planned brief section, keeping failures as detail. */
async function compressBriefs(
  ctx: Context,
  document: MemoryDocument,
  session: Session,
  plan: TierMigrationPlan,
  compress: MemoryTierCompressor,
  compressed: Map<string, readonly MemoryEntry[]>,
  signal: AbortSignal | undefined,
): Promise<BriefMigration[]> {
  const briefs: BriefMigration[] = []
  for (const range of plan.toBrief) {
    const section = findContainingSection(document.sections, session.id, range, 'detail')
    if (section === undefined) {
      ctx.logger.debug(
        'memory: skipping brief migration for turns %d–%d because its section changed',
        range.startTurn,
        range.endTurn,
      )
      continue
    }
    const source = entriesForRange(section, range)
    if (source.length === 0) {
      ctx.logger.debug(
        'memory: skipping brief migration for turns %d–%d because it has no entries',
        range.startTurn,
        range.endTurn,
      )
      continue
    }
    const key = rangeKey('brief', range)
    let entries = compressed.get(key)
    if (entries === undefined) {
      try {
        entries = normalizeBriefEntries(await compress(range, source, signal))
      } catch (error: unknown) {
        if (signal?.aborted === true) throw error
        ctx.logger.warn(
          'memory: could not compress turns %d–%d for a brief checkpoint; keeping detail: %s',
          range.startTurn,
          range.endTurn,
          errorMessage(error),
        )
        continue
      }
      compressed.set(key, entries)
    }
    briefs.push({ range, entries })
  }
  return briefs
}

/** Find the section of one tier that contains a range; a split range is smaller than its section. */
function findContainingSection(
  sections: readonly MemorySection[],
  sessionId: string,
  range: TurnRange,
  tier: MemoryTier,
): MemorySection | undefined {
  return sections.find(section => section.sessionId === sessionId
    && section.tier === tier
    && section.startTurn <= range.startTurn
    && section.endTurn >= range.endTurn)
}

/** Entries a range moves: per-turn entries by turn, legacy entries only with the whole section. */
function entriesForRange(section: MemorySection, range: TurnRange): readonly MemoryEntry[] {
  return section.entries.filter(entry => entryInRange(entry, range, section))
}

/** Whether one entry belongs to a migration range. */
function entryInRange(entry: MemoryEntry, range: TurnRange, section: MemorySection): boolean {
  if (entry.turn !== undefined) return entry.turn >= range.startTurn && entry.turn <= range.endTurn
  return section.startTurn >= range.startTurn && section.endTurn <= range.endTurn
}

/**
 * Split the entries a migration keeps into contiguous per-turn sections.
 *
 * A section whose older turns moved to brief can leave newer turns on both sides of the gap;
 * one heading spanning the gap would claim a turn whose summary now lives in another section.
 * Legacy entries (no turn marker) keep the section as it was.
 * @param section - the section the entries came from.
 * @param entries - the entries that stay.
 * @returns one section per contiguous turn run.
 */
function narrowSections(section: MemorySection, entries: readonly MemoryEntry[]): MemorySection[] {
  const turns = entries.flatMap(entry => entry.turn === undefined ? [] : [entry.turn])
  if (turns.length !== entries.length) return [{ ...section, entries }]
  const sorted = entries
    .map(entry => ({ entry, turn: entry.turn as number }))
    .sort((left, right) => left.turn - right.turn)
  const runs: MemoryEntry[][] = []
  let previous: number | undefined
  for (const item of sorted) {
    if (previous === undefined || item.turn > previous + 1) runs.push([])
    runs.at(-1)?.push(item.entry)
    previous = item.turn
  }
  return runs.map((run) => {
    const runTurns = run.map(entry => entry.turn as number)
    return {
      ...section,
      startTurn: Math.min(...runTurns),
      endTurn: Math.max(...runTurns),
      entries: run,
    }
  })
}

/** Publish the batch's checkpoint replacements, reusing seqs from a prior attempt. */
async function checkpointMigrations(
  ctx: Context,
  document: MemoryDocument,
  session: Session,
  plan: TierMigrationPlan,
  briefs: readonly BriefMigration[],
  checkpoints: Map<string, number>,
  signal: AbortSignal | undefined,
  allowSurfaceReplace: boolean,
): Promise<void> {
  // Between compactions the surface is append-only: rewriting an early turn range would
  // invalidate the provider's prefix cache for the whole conversation after it. The document
  // still records the tier migration, and its missing checkpointSeq becomes a surface retry
  // that the next compaction pass executes (the compaction rewrites history anyway).
  if (!allowSurfaceReplace) return
  for (const range of plan.toDetail) {
    if (signal?.aborted === true) return
    const key = rangeKey('detail', range)
    if (checkpoints.has(key)) continue
    const section = findContainingSection(document.sections, session.id, range, 'detail')
    const entries = section === undefined ? [] : entriesForRange(section, range)
    if (entries.length === 0) {
      ctx.logger.debug(
        'memory: skipping detail checkpoint for turns %d–%d because its section changed or is empty',
        range.startTurn,
        range.endTurn,
      )
      continue
    }
    const seq = await replaceSurfaceRange(ctx, session, range, {
      text: renderEntryText(entries),
      tier: 'detail',
    }, signal)
    if (seq !== undefined) checkpoints.set(key, seq)
  }
  for (const brief of briefs) {
    if (signal?.aborted === true) return
    const key = rangeKey('brief', brief.range)
    if (checkpoints.has(key)) continue
    const seq = await replaceSurfaceRange(ctx, session, brief.range, {
      text: renderEntryText(brief.entries),
      tier: 'brief',
    }, signal)
    if (seq !== undefined) checkpoints.set(key, seq)
  }
  for (const range of plan.toForget) {
    if (signal?.aborted === true) return
    const key = rangeKey('forget', range)
    if (checkpoints.has(key)) continue
    const seq = await replaceSurfaceRange(ctx, session, range, {
      text: renderForgetText(session.id, range),
      tier: range.tier,
    }, signal)
    if (seq !== undefined) checkpoints.set(key, seq)
  }
  for (const retry of plan.retry) {
    if (signal?.aborted === true) return
    const key = rangeKey(retry.action, retry)
    if (checkpoints.has(key)) continue
    const text = retryText(document, session.id, retry)
    if (text === undefined) continue
    const seq = await replaceSurfaceRange(ctx, session, retry, { text, tier: retry.tier }, signal)
    if (seq !== undefined) checkpoints.set(key, seq)
  }
}

/**
 * Render the text one earlier-skipped replacement needs.
 *
 * A brief retry republishes the section's stored entries; a forgotten run republishes the
 * one-line pointer. Both are derived from the document, so a retry never compresses again.
 * @param document - the parsed document the plan was computed from.
 * @param sessionId - session the ranges belong to.
 * @param retry - the range and the action it retries.
 * @returns the checkpoint text, or undefined when the section is gone or empty.
 */
function retryText(
  document: MemoryDocument,
  sessionId: string,
  retry: SurfaceRetry,
): string | undefined {
  if (retry.action === 'forget') return renderForgetText(sessionId, retry)
  const section = findSection(document.sections, sessionId, retry)
  if (section === undefined || section.entries.length === 0) return undefined
  return renderEntryText(section.entries)
}

/** Compose the post-migration document without writing it. */
function applyMigrations(
  document: MemoryDocument,
  session: Session,
  plan: TierMigrationPlan,
  briefs: readonly BriefMigration[],
  checkpoints: ReadonlyMap<string, number>,
): MemoryDocument {
  let sections: MemorySection[] = [...document.sections]
  let turns = document.sessions.find(record => record.id === session.id)?.turns ?? []
  for (const range of plan.toDetail) {
    const checkpointSeq = checkpoints.get(rangeKey('detail', range))
    if (checkpointSeq !== undefined) turns = updateTurnRange(turns, range, { checkpointSeq })
  }
  for (const brief of briefs) {
    const container = findContainingSection(sections, session.id, brief.range, 'detail')
    if (container !== undefined) {
      const moved = entriesForRange(container, brief.range)
      const kept = container.entries.filter(entry => !moved.includes(entry))
      sections = sections.filter(section => section !== container)
      if (kept.length > 0) sections.push(...narrowSections(container, kept))
      sections.push({
        sessionId: session.id,
        startTurn: brief.range.startTurn,
        endTurn: brief.range.endTurn,
        tier: 'brief',
        entries: copyEntries(brief.entries),
      })
    }
    const checkpointSeq = checkpoints.get(rangeKey('brief', brief.range))
    turns = updateTurnRange(turns, brief.range, {
      tier: 'brief',
      ...checkpointSeq === undefined ? {} : { checkpointSeq },
    })
  }
  for (const range of plan.toForget) {
    sections = sections.flatMap((section) => {
      if (section.sessionId !== session.id) return [section]
      const kept = section.entries.filter(entry => !entryInRange(entry, range, section))
      if (kept.length === section.entries.length) return [section]
      if (kept.length === 0) return []
      return narrowSections(section, kept)
    })
    const checkpointSeq = checkpoints.get(rangeKey('forget', range))
    if (checkpointSeq !== undefined) turns = updateTurnRange(turns, range, { checkpointSeq })
  }
  for (const retry of plan.retry) {
    const checkpointSeq = checkpoints.get(rangeKey(retry.action, retry))
    if (checkpointSeq !== undefined) turns = updateTurnRange(turns, retry, { checkpointSeq })
  }
  sections.sort((left, right) =>
    left.startTurn - right.startTurn
    || left.endTurn - right.endTurn
    || (left.tier === right.tier ? 0 : left.tier === 'detail' ? -1 : 1))
  return {
    ...document,
    sections,
    sessions: document.sessions.map((record) => {
      if (record.id !== session.id) return record
      const updated = { ...record, updatedAt: new Date().toISOString(), turns }
      return plan.window.forgottenThrough === undefined
        ? updated
        : { ...updated, forgottenThrough: plan.window.forgottenThrough }
    }),
  }
}

/** Find the exact section a planned range names. */
function findSection(
  sections: readonly MemorySection[],
  sessionId: string,
  range: TurnRange,
): MemorySection | undefined {
  return sections.find(section => sameSection(section, sessionId, range))
}

/** Whether a section is the exact range the plan names. */
function sameSection(section: MemorySection, sessionId: string, range: TurnRange): boolean {
  return section.sessionId === sessionId
    && section.startTurn === range.startTurn
    && section.endTurn === range.endTurn
    && section.tier === range.tier
}

/** Replace the frontmatter turn records inside a range. */
function updateTurnRange(
  turns: readonly MemoryTurnRecord[],
  range: TurnRange,
  update: Pick<MemoryTurnRecord, 'tier'> | Pick<MemoryTurnRecord, 'checkpointSeq'>,
): readonly MemoryTurnRecord[] {
  return turns.map(turn =>
    turn.turn >= range.startTurn && turn.turn <= range.endTurn ? { ...turn, ...update } : turn)
}

/** Copy entries so caller-owned arrays cannot mutate the document. */
function copyEntries(entries: readonly MemoryEntry[]): readonly MemoryEntry[] {
  return entries.map(entry => ({
    kind: entry.kind,
    text: entry.text,
    ...entry.turn === undefined ? {} : { turn: entry.turn },
    ...entry.tags === undefined ? {} : { tags: [...entry.tags] },
  }))
}

/** Key one planned range by action and turns. */
function rangeKey(action: 'detail' | 'brief' | 'forget', range: TurnRange): string {
  return `${action}:${String(range.startTurn)}:${String(range.endTurn)}`
}

/** Enforce the brief entry and character bounds before the write. */
function normalizeBriefEntries(entries: readonly MemoryEntry[]): readonly MemoryEntry[] {
  const kept: MemoryEntry[] = []
  let characters = 0
  for (const entry of entries) {
    if (kept.length === MEMORY_BRIEF_MAX_ENTRIES) break
    const remaining = MEMORY_BRIEF_MAX_CHARS - characters
    if (remaining <= 0) break
    const text = entry.text.trim()
    if (text.length === 0) continue
    const bounded = text.length <= remaining ? text : truncateChars(text, remaining)
    if (bounded.length === 0) continue
    kept.push({ kind: assertMemoryEntryKind(entry.kind), text: bounded })
    characters += bounded.length
  }
  if (kept.length === 0) throw new Error('memory: brief compression produced no entries')
  return kept
}

/** Truncate a string to a character budget, marking the loss with an ellipsis. */
function truncateChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  if (maxChars <= 1) return '…'.slice(0, maxChars)
  return `${text.slice(0, maxChars - 1)}…`
}

/** Render stored entries as the model-facing checkpoint text. */
function renderEntryText(entries: readonly MemoryEntry[]): string {
  return entries.map(entry => `- [${entry.kind}] ${entry.text}`).join('\n')
}

/** Render the one-line pointer that replaces a forgotten checkpoint. */
function renderForgetText(sessionId: string, range: TurnRange): string {
  const turns = range.startTurn === range.endTurn
    ? `turn ${String(range.startTurn)}`
    : `turns ${String(range.startTurn)}–${String(range.endTurn)}`
  const seq = range.seq[0] === range.seq[1]
    ? `seq ${String(range.seq[0])}`
    : `seq ${String(range.seq[0])}–${String(range.seq[1])}`
  return `Memory pointer: session ${sessionId}, ${turns} (${seq}) left the context; the original remains searchable with memory_search / memory_read.`
}

/** Split the leading frontmatter block from the rest of the file. */
function splitFrontmatter(text: string): { frontmatter: string; content: string } {
  const match = FRONTMATTER.exec(text)
  if (match === null) {
    throw new MemoryDocumentError(
      'MEMORY.md must start with a YAML frontmatter block between `---` lines',
      'invalid-document',
    )
  }
  return { frontmatter: match[1] ?? '', content: text.slice(match[0].length) }
}

/** Split the managed block from the hand-written text around it. */
function splitManagedBlock(content: string): { body: string; frame: MemoryFrame } {
  const begin = content.indexOf(MEMORY_BLOCK_BEGIN)
  if (begin < 0) {
    throw new MemoryDocumentError(`MEMORY.md has no ${MEMORY_BLOCK_BEGIN} marker`, 'invalid-document')
  }
  const bodyStart = begin + MEMORY_BLOCK_BEGIN.length
  const end = content.indexOf(MEMORY_BLOCK_END, bodyStart)
  if (end < 0) {
    throw new MemoryDocumentError(`MEMORY.md has no ${MEMORY_BLOCK_END} marker after the begin marker`, 'invalid-document')
  }
  return {
    body: content.slice(bodyStart, end),
    frame: {
      before: content.slice(0, begin),
      after: content.slice(end + MEMORY_BLOCK_END.length),
    },
  }
}

/** Parse the YAML frontmatter into the machine-state fields. */
function parseFrontmatter(source: string): Pick<MemoryDocument, 'version' | 'window' | 'sessions' | 'summaryPaused' | 'evictions'> {
  const data = parseFrontmatterYaml(source)
  const record = asRecord(data, 'frontmatter')
  const version = requireInteger(record, 'version', 'frontmatter', 0)
  if (version !== MEMORY_DOCUMENT_VERSION) {
    throw new MemoryDocumentError(
      `unsupported MEMORY.md version ${version}; this provider reads version ${MEMORY_DOCUMENT_VERSION}`,
      'invalid-document',
    )
  }
  const windowRecord = asRecord(record['window'], 'frontmatter.window')
  const sessions = record['sessions']
  if (!Array.isArray(sessions)) {
    throw new MemoryDocumentError('frontmatter.sessions must be an array', 'invalid-document')
  }
  const summaryPaused = record['summaryPaused']
  if (summaryPaused !== undefined && typeof summaryPaused !== 'boolean') {
    throw new MemoryDocumentError('frontmatter.summaryPaused must be a boolean', 'invalid-document')
  }
  const evictions = record['evictions']
  if (evictions !== undefined && !Array.isArray(evictions)) {
    throw new MemoryDocumentError('frontmatter.evictions must be an array', 'invalid-document')
  }
  return {
    version,
    window: {
      detail: requireInteger(windowRecord, 'detail', 'frontmatter.window', 1),
      brief: requireInteger(windowRecord, 'brief', 'frontmatter.window', 1),
      forget: requireInteger(windowRecord, 'forget', 'frontmatter.window', 1),
      sessions: requireInteger(windowRecord, 'sessions', 'frontmatter.window', 1),
    },
    sessions: sessions.map((session, index) => parseSessionRecord(session, index)),
    ...summaryPaused === true ? { summaryPaused: true } : {},
    ...evictions === undefined ? {} : {
      evictions: evictions.map((value, index) => parseEvictionRecord(value, `frontmatter.evictions[${String(index)}]`)),
    },
  }
}

/** Parse one frontmatter eviction record. */
function parseEvictionRecord(value: unknown, subject: string): MemoryEvictionRecord {
  const record = asRecord(value, subject)
  const reason = record['reason']
  if (!isEvictionReason(reason)) {
    throw new MemoryDocumentError(
      `${subject}.reason must be one of ${EVICTION_REASONS.join(', ')}`,
      'invalid-document',
    )
  }
  const turn = optionalInteger(record, 'turn', subject)
  const tags = parseEvictionTags(record['tags'], subject)
  const originalAt = record['originalAt']
  if (originalAt !== undefined && typeof originalAt !== 'string') {
    throw new MemoryDocumentError(`${subject}.originalAt must be a string`, 'invalid-document')
  }
  return {
    at: requireString(record, 'at', subject),
    sessionId: requireString(record, 'sessionId', subject),
    kind: assertMemoryEntryKind(requireString(record, 'kind', subject)),
    ...tags === undefined ? {} : { tags },
    ...turn === undefined ? {} : { turn },
    text: requireString(record, 'text', subject),
    reason,
    detail: requireString(record, 'detail', subject),
    ...originalAt === undefined ? {} : { originalAt },
  }
}

/** All eviction reasons the frontmatter and archive understand. */
const EVICTION_REASONS: readonly MemoryEvictionReason[] = [
  'byte-budget', 'manual-forget', 'ttl', 'resolved', 'superseded', 'duplicate',
]

/** Narrow one persisted eviction reason. */
function isEvictionReason(value: unknown): value is MemoryEvictionReason {
  return typeof value === 'string' && (EVICTION_REASONS as readonly string[]).includes(value)
}

/** Parse the optional labels of one eviction record. */
function parseEvictionTags(value: unknown, subject: string): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(tag => typeof tag !== 'string')) {
    throw new MemoryDocumentError(`${subject}.tags must be an array of strings`, 'invalid-document')
  }
  const tags = normalizeEntryTags(value)
  return tags.length === 0 ? undefined : tags
}

/** Parse one YAML block, reporting the parser message on failure. */
function parseFrontmatterYaml(source: string): unknown {
  try {
    return parseYaml(source)
  } catch (error: unknown) {
    throw new MemoryDocumentError(
      `MEMORY.md frontmatter is not valid YAML: ${errorMessage(error)}`,
      'invalid-document',
    )
  }
}

/** Parse one frontmatter session record. */
function parseSessionRecord(value: unknown, index: number): MemorySessionRecord {
  const subject = `frontmatter.sessions[${String(index)}]`
  const record = asRecord(value, subject)
  const id = requireString(record, 'id', subject)
  if (id.length === 0) throw new MemoryDocumentError(`${subject}.id must not be empty`, 'invalid-document')
  const cwd = requireString(record, 'cwd', subject)
  const updatedAt = requireString(record, 'updatedAt', subject)
  const turns = record['turns']
  if (!Array.isArray(turns)) {
    throw new MemoryDocumentError(`${subject}.turns must be an array`, 'invalid-document')
  }
  const forgottenThrough = optionalInteger(record, 'forgottenThrough', subject)
  return {
    id,
    cwd,
    updatedAt,
    turns: turns.map((turn, turnIndex) => parseTurnRecord(turn, `${subject}.turns[${String(turnIndex)}]`)),
    ...forgottenThrough === undefined ? {} : { forgottenThrough },
  }
}

/** Parse one frontmatter turn record. */
function parseTurnRecord(value: unknown, subject: string): MemoryTurnRecord {
  const record = asRecord(value, subject)
  const seq = record['seq']
  if (!Array.isArray(seq) || seq.length !== 2) {
    throw new MemoryDocumentError(`${subject}.seq must be a [start, end] integer pair`, 'invalid-document')
  }
  const pair: unknown[] = seq
  const [start, end] = pair
  if (typeof start !== 'number' || !Number.isInteger(start)
    || typeof end !== 'number' || !Number.isInteger(end)) {
    throw new MemoryDocumentError(`${subject}.seq must be a [start, end] integer pair`, 'invalid-document')
  }
  const checkpointSeq = optionalInteger(record, 'checkpointSeq', subject)
  return {
    turn: requireInteger(record, 'turn', subject, 0),
    seq: [start, end],
    tier: requireTier(record['tier'], subject),
    ...checkpointSeq === undefined ? {} : { checkpointSeq },
  }
}

/** Parse the managed-block body into sections. */
function parseManagedBody(body: string): MemorySection[] {
  const sections: MemorySection[] = []
  let entries: MemoryEntry[] | undefined
  for (const [index, line] of body.split(/\r?\n/u).entries()) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    if (trimmed.startsWith('## ')) {
      const heading = parseSectionHeading(trimmed, index)
      entries = []
      sections.push({ ...heading, entries })
      continue
    }
    if (entries === undefined) {
      throw new MemoryDocumentError(
        `managed block line ${String(index + 1)}: entry before the first section heading`,
        'invalid-document',
      )
    }
    entries.push(parseEntryLine(trimmed, index))
  }
  return sections
}

/** Parse one section heading. */
function parseSectionHeading(line: string, index: number): Omit<MemorySection, 'entries'> {
  const match = SECTION_HEADING.exec(line)
  const groups = match?.groups
  if (groups === undefined) {
    throw new MemoryDocumentError(
      `managed block line ${String(index + 1)}: expected "## <sessionId> · turn N–M（detail|brief）"`,
      'invalid-document',
    )
  }
  return {
    sessionId: groups['sessionId'] ?? '',
    startTurn: Number(groups['startTurn']),
    endTurn: Number(groups['endTurn']),
    tier: groups['tier'] === 'brief' ? 'brief' : 'detail',
  }
}

/** Parse one entry line, rejecting an unknown kind with the registry list. */
function parseEntryLine(line: string, index: number): MemoryEntry {
  const match = ENTRY_LINE.exec(line)
  const groups = match?.groups
  if (groups === undefined || groups['text'] === undefined) {
    throw new MemoryDocumentError(
      `managed block line ${String(index + 1)}: expected "- [kind] text"`,
      'invalid-document',
    )
  }
  const withoutVersion = splitEntryVersion(groups['text'])
  const withoutSource = splitEntrySource(withoutVersion.text)
  const withoutTags = splitEntryTags(withoutSource.text)
  const { text, turn } = splitEntryTurn(withoutTags.text)
  return {
    kind: assertMemoryEntryKind(groups['kind'] ?? ''),
    text,
    ...turn === undefined ? {} : { turn },
    ...withoutTags.tags === undefined ? {} : { tags: withoutTags.tags },
    ...withoutSource.source === undefined ? {} : { source: withoutSource.source },
    ...withoutVersion.version === undefined ? {} : { version: withoutVersion.version },
  }
}

/**
 * Split the optional turn suffix from one entry's text.
 *
 * The suffix is written before the label suffix, so it is the last thing parsed out. A line
 * without a well-formed suffix keeps its complete text, which is how entries written before
 * per-turn attribution still parse.
 * @param raw - entry text after the label suffix was removed.
 * @returns the text and the turn, or the text unchanged without a turn.
 */
function splitEntryTurn(raw: string): { text: string; turn?: number } {
  const match = ENTRY_TURN.exec(raw)
  const text = match?.groups?.['text']
  const serialized = match?.groups?.['turn']
  if (text === undefined || serialized === undefined) return { text: raw }
  const turn = Number(serialized)
  if (!Number.isSafeInteger(turn) || turn < 0 || text.length === 0) return { text: raw }
  return { text, turn }
}

/**
 * Split the optional origin suffix from one entry's text.
 * @param raw - entry text after the revision suffix was removed.
 * @returns the text and the origin, or the text unchanged.
 */
function splitEntrySource(raw: string): { text: string; source?: 'auto' | 'manual' } {
  const match = ENTRY_SOURCE.exec(raw)
  const text = match?.groups?.['text']
  const source = match?.groups?.['source']
  if (text === undefined || source === undefined || text.length === 0) return { text: raw }
  return { text, source: source === 'manual' ? 'manual' : 'auto' }
}

/**
 * Split the optional revision suffix from one entry's text.
 * @param raw - entry text after the label suffix was removed.
 * @returns the text and the revision, or the text unchanged.
 */
function splitEntryVersion(raw: string): { text: string; version?: number } {
  const match = ENTRY_VERSION.exec(raw)
  const text = match?.groups?.['text']
  const serialized = match?.groups?.['version']
  if (text === undefined || serialized === undefined) return { text: raw }
  const version = Number(serialized)
  if (!Number.isSafeInteger(version) || version < 1 || text.length === 0) return { text: raw }
  return { text, version }
}

/**
 * Split the optional label suffix from one entry's text.
 *
 * A line that does not end in a well-formed `<!-- tags: ... -->` suffix keeps
 * its complete text, so a hand edit that merely contains the marker sequence
 * still parses as before labels existed.
 * @param raw - entry text after the kind marker, as read from the line.
 * @returns the text and the labels, or the text unchanged without labels.
 */
function splitEntryTags(raw: string): { text: string; tags?: readonly string[] } {
  const match = ENTRY_TAGS.exec(raw)
  const text = match?.groups?.['text']
  const serialized = match?.groups?.['tags']
  if (text === undefined || serialized === undefined) return { text: raw }
  const tags = normalizeEntryTags(serialized.split(','))
  return tags.length === 0 ? { text: raw } : { text: text.length === 0 ? raw : text, tags }
}

/**
 * Normalize labels at a caller or durable-file boundary.
 *
 * Labels are trimmed, empty labels are dropped, duplicates keep their first
 * position, and the result is bounded by {@link MEMORY_ENTRY_TAGS_LIMIT} and
 * {@link MEMORY_ENTRY_TAG_MAX_CHARS}.
 * @param tags - candidate labels from a tool call or a parsed line.
 * @returns the normalized labels, in write order.
 */
export function normalizeEntryTags(tags: readonly string[]): readonly string[] {
  const kept: string[] = []
  for (const candidate of tags) {
    const tag = candidate.trim()
    if (tag.length === 0 || kept.includes(tag)) continue
    kept.push(tag.length <= MEMORY_ENTRY_TAG_MAX_CHARS
      ? tag
      : `${tag.slice(0, MEMORY_ENTRY_TAG_MAX_CHARS - 1)}…`)
    if (kept.length === MEMORY_ENTRY_TAGS_LIMIT) break
  }
  return kept
}

/** Render the canonical frontmatter block. */
function renderFrontmatter(document: MemoryDocument): string {
  const window = document.window
  const lines = [
    `version: ${String(document.version)}`,
    `window: { detail: ${String(window.detail)}, brief: ${String(window.brief)}, forget: ${String(window.forget)}, sessions: ${String(window.sessions)} }`,
  ]
  if (document.summaryPaused === true) lines.push('summaryPaused: true')
  if (document.evictions !== undefined && document.evictions.length > 0) {
    lines.push('evictions:')
    for (const eviction of document.evictions) {
      const fields = [
        `at: ${JSON.stringify(eviction.at)}`,
        `sessionId: ${JSON.stringify(eviction.sessionId)}`,
        `kind: ${eviction.kind}`,
        ...eviction.tags === undefined ? [] : [`tags: [${eviction.tags.map(tag => JSON.stringify(tag)).join(', ')}]`],
        ...eviction.turn === undefined ? [] : [`turn: ${String(eviction.turn)}`],
        `text: ${JSON.stringify(eviction.text)}`,
        `reason: ${eviction.reason}`,
        `detail: ${JSON.stringify(eviction.detail)}`,
        ...eviction.originalAt === undefined ? [] : [`originalAt: ${JSON.stringify(eviction.originalAt)}`],
      ]
      lines.push(`  - { ${fields.join(', ')} }`)
    }
  }
  if (document.sessions.length === 0) {
    lines.push('sessions: []')
    return `${lines.join('\n')}\n`
  }
  lines.push('sessions:')
  for (const session of document.sessions) {
    lines.push(`  - id: ${JSON.stringify(session.id)}`)
    lines.push(`    cwd: ${JSON.stringify(session.cwd)}`)
    lines.push(`    updatedAt: ${JSON.stringify(session.updatedAt)}`)
    if (session.turns.length === 0) {
      lines.push('    turns: []')
    } else {
      lines.push('    turns:')
      for (const turn of session.turns) {
        const fields = [
          `turn: ${String(turn.turn)}`,
          `seq: [${String(turn.seq[0])}, ${String(turn.seq[1])}]`,
          `tier: ${turn.tier}`,
        ]
        if (turn.checkpointSeq !== undefined) fields.push(`checkpointSeq: ${String(turn.checkpointSeq)}`)
        lines.push(`      - { ${fields.join(', ')} }`)
      }
    }
    if (session.forgottenThrough !== undefined) {
      lines.push(`    forgottenThrough: ${String(session.forgottenThrough)}`)
    }
  }
  return `${lines.join('\n')}\n`
}

/** Render the managed-block body, including the newline after each section. */
function renderManagedBody(sections: readonly MemorySection[]): string {
  if (sections.length === 0) return '\n'
  return sections.map((section) => {
    const heading = `## ${section.sessionId} · turn ${String(section.startTurn)}–${String(section.endTurn)}（${section.tier}）`
    const entries = section.entries.map(entry => `- [${entry.kind}] ${entry.text}${renderEntryTurn(entry.turn)}${renderEntryTags(entry.tags)}${renderEntrySource(entry.source)}${renderEntryVersion(entry.version)}\n`).join('')
    return `\n${heading}\n${entries}`
  }).join('')
}

/** Render the optional turn suffix of one entry; an entry without a turn renders nothing. */
function renderEntryTurn(turn: number | undefined): string {
  return turn === undefined ? '' : ` <!-- turn: ${String(turn)} -->`
}

/** Render the optional label suffix of one entry; absent or empty labels render nothing. */
function renderEntryTags(tags: readonly string[] | undefined): string {
  const normalized = normalizeEntryTags(tags ?? [])
  return normalized.length === 0 ? '' : ` <!-- tags: ${normalized.join(', ')} -->`
}

/** Render the optional origin suffix of one entry; auto entries written by the job render nothing. */
function renderEntrySource(source: 'auto' | 'manual' | undefined): string {
  return source === undefined ? '' : ` <!-- source: ${source} -->`
}

/** Render the optional revision suffix of one entry; an entry never edited renders nothing. */
function renderEntryVersion(version: number | undefined): string {
  return version === undefined ? '' : ` <!-- version: ${String(version)} -->`
}

/** Compose the next document from the current one and one entry. */
function appendToDocument(
  document: MemoryDocument,
  session: Session,
  entry: MemoryEntryInput,
  kind: MemoryEntryKind,
): MemoryDocument {
  const tier = entry.tier ?? 'detail'
  return {
    ...document,
    sessions: recordTurn(document.sessions, session, entry.turn, entry.seq, tier),
    sections: appendSectionEntry(document.sections, session.id, entry, kind, tier),
  }
}

/** Compose the next document from the current one and one turn summary. */
function appendTurnToDocument(
  document: MemoryDocument,
  session: Session,
  summary: MemoryTurnSummaryInput,
  entries: readonly MemoryEntry[],
): MemoryDocument {
  return {
    ...document,
    sessions: recordTurn(document.sessions, session, summary.turn, summary.seq, 'detail'),
    sections: appendSummaryEntries(document.sections, session.id, summary.turn, entries),
  }
}

/** Append the entry to the matching section, or start a new section for the turn. */
function appendSectionEntry(
  sections: readonly MemorySection[],
  sessionId: string,
  entry: MemoryEntryInput,
  kind: MemoryEntryKind,
  tier: MemoryTier,
): readonly MemorySection[] {
  const tags = normalizeEntryTags(entry.tags ?? [])
  const appended: MemoryEntry = {
    kind,
    text: entry.text,
    turn: entry.turn,
    ...tags.length === 0 ? {} : { tags },
  }
  const last = sections.at(-1)
  if (last !== undefined && last.sessionId === sessionId && last.endTurn === entry.turn && last.tier === tier) {
    return [...sections.slice(0, -1), { ...last, entries: [...last.entries, appended] }]
  }
  return [...sections, {
    sessionId,
    startTurn: entry.turn,
    endTurn: entry.turn,
    tier,
    entries: [appended],
  }]
}

/** Extend the trailing detail section of consecutive turns, or start the turn's section. */
function appendSummaryEntries(
  sections: readonly MemorySection[],
  sessionId: string,
  turn: number,
  entries: readonly MemoryEntry[],
): readonly MemorySection[] {
  const appended = entries.map(entry => ({
    kind: entry.kind,
    text: entry.text,
    turn,
    ...entry.tags === undefined ? {} : { tags: normalizeEntryTags(entry.tags) },
  }))
  const last = sections.at(-1)
  if (last !== undefined
    && last.sessionId === sessionId
    && last.tier === 'detail'
    && (last.endTurn === turn || last.endTurn === turn - 1)) {
    return [...sections.slice(0, -1), {
      ...last,
      endTurn: turn,
      entries: [...last.entries, ...appended],
    }]
  }
  return [...sections, {
    sessionId,
    startTurn: turn,
    endTurn: turn,
    tier: 'detail',
    entries: appended,
  }]
}

/** Record the turn in the frontmatter session list, creating the session when needed. */
function recordTurn(
  sessions: readonly MemorySessionRecord[],
  session: Session,
  turnNumber: number,
  seq: readonly [number, number],
  tier: MemoryTier,
): readonly MemorySessionRecord[] {
  const updatedAt = new Date().toISOString()
  const turn: MemoryTurnRecord = { turn: turnNumber, seq: [seq[0], seq[1]], tier }
  const existing = sessions.find(record => record.id === session.id)
  if (existing === undefined) {
    return [...sessions, {
      id: session.id,
      cwd: session.header.cwd ?? '',
      updatedAt,
      turns: [turn],
    }]
  }
  const turns = [...existing.turns.filter(record => record.turn !== turnNumber), turn]
    .sort((left, right) => left.turn - right.turn)
  return sessions.map(record => record === existing ? { ...existing, updatedAt, turns } : record)
}

/**
 * Keep one persisted document inside the configured retention window.
 *
 * `window.sessions` is the number of sessions whose summaries stay in MEMORY.md, so the limit is
 * applied to **the file that is written**, together with the sections and the frontmatter index
 * that describe those sessions — not only to the snapshot a reader slices. The session that just
 * wrote is always retained. A body still over the byte budget loses individual entries in eviction
 * order — `open`, then `files`, then `decision`, then `preference`, oldest first inside one kind —
 * so the newest write is never the entry that makes room for itself. Each removal is recorded in the
 * frontmatter (`at`, entry, kind, turn, reason, detail) and a session left with no entries loses its
 * record too.
 * @param document - the document after this append or migration.
 * @param currentSessionId - the session the write belongs to; its record is kept while it has sections.
 * @param window - the configured retention window, recorded into the document.
 * @param maxBytes - the managed-body budget.
 * @param maxEntries - per-session entry cap applied before budget eviction.
 * @param protect - entries this write must keep; the just-appended turn passes one.
 * @returns the trimmed document and the records this call added.
 */
function retainDocument(
  document: MemoryDocument,
  currentSessionId: string,
  window: MemoryWindow,
  maxBytes: number,
  maxEntries: number = DEFAULT_MEMORY_MAX_ENTRIES,
  protect?: (entry: MemoryEntry, section: MemorySection) => boolean,
): MemoryRetention {
  let retained = retainSessions({ ...document, window }, currentSessionId, window.sessions)
  for (const record of retained.sessions) {
    retained = pruneSessionEntries(retained, record.id, maxEntries).document
  }
  const added: MemoryEvictionRecord[] = []
  const archive: MemoryArchiveRecord[] = []
  while (Buffer.byteLength(renderManagedBody(retained.sections), 'utf8') > maxBytes) {
    const candidate = selectEvictionCandidate(retained, protect)
    if (candidate === undefined) break
    const detail = `over the ${String(maxBytes)}-byte managed-body budget while writing session ${currentSessionId}`
    added.push(evictionRecord(candidate.entry, candidate.section, 'byte-budget', detail))
    archive.push(memoryArchiveRecord(candidate.entry, candidate.section, 'byte-budget', detail, new Date().toISOString()))
    retained = dropEmptySessions(removeSectionEntry(retained, candidate.section, candidate.entry))
  }
  if (added.length === 0) return { document: retained, evictions: added, archive }
  const evictions = [...(retained.evictions ?? []), ...added].slice(-MEMORY_EVICTION_RECORD_LIMIT)
  return { document: { ...retained, evictions }, evictions: added, archive }
}

/** Result of applying retention to one composed document. */
interface MemoryRetention {
  /** Trimmed document, with the new eviction records attached. */
  readonly document: MemoryDocument
  /** Records added by this call only, newest last. */
  readonly evictions: readonly MemoryEvictionRecord[]
  /** Full-text archive records for the same removals. */
  readonly archive: readonly MemoryArchiveRecord[]
}

/** One entry and its section chosen for budget eviction. */
interface EvictionCandidate {
  /** Section holding the entry. */
  readonly section: MemorySection
  /** Entry to remove. */
  readonly entry: MemoryEntry
}

/**
 * Choose the next entry the budget evicts.
 *
 * Kind order protects durable conclusions: an `open` item or a file pointer leaves before a
 * decision, and a preference leaves last. Inside one kind the oldest session (by `updatedAt`) and
 * the oldest turn leave first; an entry without a turn is treated as older than any turned entry in
 * its section. Manual edits are still eligible, after the automatic entries of the same kind/turn.
 * @param document - current retained document.
 * @param protect - entries this write must keep.
 * @returns the least durable entry, or undefined when every remaining entry is protected.
 */
function selectEvictionCandidate(
  document: MemoryDocument,
  protect: ((entry: MemoryEntry, section: MemorySection) => boolean) | undefined,
): EvictionCandidate | undefined {
  const updatedAt = new Map(document.sessions.map(record => [record.id, record.updatedAt]))
  const candidates: RankedEvictionCandidate[] = []
  for (const section of document.sections) {
    for (const entry of section.entries) {
      if (protect?.(entry, section) === true) continue
      candidates.push({
        section,
        entry,
        kindRank: MEMORY_KIND_EVICTION_ORDER[entry.kind],
        manualRank: entry.source === 'manual' ? 1 : 0,
        sessionUpdatedAt: updatedAt.get(section.sessionId) ?? '',
        turnRank: entry.turn ?? section.startTurn,
      })
    }
  }
  candidates.sort(compareEvictionCandidates)
  const chosen = candidates[0]
  return chosen === undefined ? undefined : { section: chosen.section, entry: chosen.entry }
}

/** One candidate with the fields its eviction order compares. */
interface RankedEvictionCandidate extends EvictionCandidate {
  /** Kind order, least durable first. */
  readonly kindRank: number
  /** Automatic entries leave before manual edits of the same kind and turn. */
  readonly manualRank: number
  /** Session recency; the older session leaves first. */
  readonly sessionUpdatedAt: string
  /** Turn recency inside one session; a missing turn ranks as the section's first turn. */
  readonly turnRank: number
}

/** Compare two eviction candidates by durability, then age, then file order. */
function compareEvictionCandidates(left: RankedEvictionCandidate, right: RankedEvictionCandidate): number {
  return left.kindRank - right.kindRank
    || left.manualRank - right.manualRank
    || left.sessionUpdatedAt.localeCompare(right.sessionUpdatedAt)
    || left.turnRank - right.turnRank
}

/**
 * Build the full archive record for one removed entry.
 * @param entry - entry leaving the active block.
 * @param section - section that held it.
 * @param reason - rule that removed it.
 * @param detail - readable account of the rule input.
 * @param archivedAt - archive time.
 * @param originalAt - entry time inferred from the turn log, when known.
 * @returns the full-text archive record.
 */
export function memoryArchiveRecord(
  entry: MemoryEntry,
  section: MemorySection,
  reason: MemoryEvictionReason,
  detail: string,
  archivedAt: string,
  originalAt?: string,
): MemoryArchiveRecord {
  return {
    sessionId: section.sessionId,
    kind: entry.kind,
    text: entry.text,
    ...entry.turn === undefined ? {} : { turn: entry.turn },
    ...entry.tags === undefined || entry.tags.length === 0 ? {} : { tags: entry.tags },
    archivedAt,
    ...originalAt === undefined ? {} : { originalAt },
    reason,
    detail,
  }
}

/**
 * Convert one archive record into the bounded frontmatter audit record.
 * @param record - archive record to summarize.
 * @returns the frontmatter eviction record.
 */
export function archiveEvictionRecord(record: MemoryArchiveRecord): MemoryEvictionRecord {
  return {
    at: record.archivedAt,
    sessionId: record.sessionId,
    kind: record.kind,
    ...record.tags === undefined ? {} : { tags: record.tags },
    ...record.turn === undefined ? {} : { turn: record.turn },
    text: record.text.length <= MEMORY_EVICTION_TEXT_MAX_CHARS
      ? record.text
      : `${record.text.slice(0, MEMORY_EVICTION_TEXT_MAX_CHARS - 1)}…`,
    reason: record.reason,
    detail: record.detail,
    ...record.originalAt === undefined ? {} : { originalAt: record.originalAt },
  }
}

/** Attach cleanup/audit records to the frontmatter, newest last and bounded. */
export function appendEvictionRecords(
  document: MemoryDocument,
  records: readonly MemoryEvictionRecord[],
): MemoryDocument {
  if (records.length === 0) return document
  return {
    ...document,
    evictions: [...(document.evictions ?? []), ...records].slice(-MEMORY_EVICTION_RECORD_LIMIT),
  }
}

/** Build one durable eviction record, bounding the retained text. *//** Build one durable eviction record, bounding the retained text. */
function evictionRecord(
  entry: MemoryEntry,
  section: MemorySection,
  reason: MemoryEvictionReason,
  detail: string,
  originalAt?: string,
): MemoryEvictionRecord {
  return {
    at: new Date().toISOString(),
    sessionId: section.sessionId,
    kind: entry.kind,
    ...entry.tags === undefined || entry.tags.length === 0 ? {} : { tags: entry.tags },
    ...entry.turn === undefined ? {} : { turn: entry.turn },
    text: entry.text.length <= MEMORY_EVICTION_TEXT_MAX_CHARS
      ? entry.text
      : `${entry.text.slice(0, MEMORY_EVICTION_TEXT_MAX_CHARS - 1)}…`,
    reason,
    detail,
    ...originalAt === undefined ? {} : { originalAt },
  }
}

/** Remove one entry and, when that empties its section, the section and its turn records. */
function removeSectionEntry(
  document: MemoryDocument,
  section: MemorySection,
  entry: MemoryEntry,
): MemoryDocument {
  const entries = section.entries.filter(candidate => candidate !== entry)
  const sections = entries.length === 0
    ? document.sections.filter(candidate => candidate !== section)
    : document.sections.map(candidate => candidate === section
      ? Object.freeze({ ...candidate, entries: Object.freeze(entries) })
      : candidate)
  return {
    ...document,
    sections,
    sessions: entries.length === 0
      ? document.sessions.map((record) => {
        if (record.id !== section.sessionId) return record
        const covered = new Set(sections
          .filter(candidate => candidate.sessionId === section.sessionId)
          .flatMap(candidate => candidate.entries.flatMap(item => item.turn === undefined ? [] : [item.turn])))
        const turns = record.turns.filter(turn =>
          turn.turn < section.startTurn || turn.turn > section.endTurn || covered.has(turn.turn))
        return turns.length === record.turns.length ? record : Object.freeze({ ...record, turns: Object.freeze(turns) })
      })
      : document.sessions,
  }
}

/**
 * Remove one active entry, dropping an emptied section and its turn records.
 * @param document - document to change.
 * @param section - section holding the entry.
 * @param entry - entry to remove.
 * @returns the changed document.
 */
export function removeMemoryEntry(
  document: MemoryDocument,
  section: MemorySection,
  entry: MemoryEntry,
): MemoryDocument {
  return removeSectionEntry(document, section, entry)
}

/**
 * Drop session records that no longer describe any section.
 * @param document - document to compact.
 * @returns the document with empty session records removed.
 */
export function pruneEmptyMemorySessions(document: MemoryDocument): MemoryDocument {
  return dropEmptySessions(document)
}

/** Drop session records that no longer describe any section. */
function dropEmptySessions(document: MemoryDocument): MemoryDocument {
  const withSections = new Set(document.sections.map(section => section.sessionId))
  const sessions = document.sessions.filter(record => withSections.has(record.id))
  return sessions.length === document.sessions.length
    ? document
    : { ...document, sessions }
}

/** Duplicate entries and over-cap sections removed from one session. */
export interface SessionPrune {
  /** Document after the pruning. */
  readonly document: MemoryDocument
  /** Entries removed because an equal normalized text already appeared earlier in the session. */
  readonly duplicates: number
  /** Entries removed with the oldest whole sections over the per-session cap. */
  readonly overCap: number
}

/**
 * Drop duplicate entries and the oldest whole sections of one session beyond a cap.
 *
 * Deduplication keeps the first occurrence in file order, so the turn where a fact first entered
 * stays. The cap removes whole sections oldest-first and drops their frontmatter turn records too,
 * so the file never claims a summarized turn whose entries are gone. Manual edits are not special:
 * an over-cap session loses its oldest sections whichever source wrote them.
 * @param document - document to compact.
 * @param sessionId - session whose sections are pruned.
 * @param keep - maximum entries retained for that session.
 * @returns the compacted document and both removal counts.
 */
export function pruneSessionEntries(document: MemoryDocument, sessionId: string, keep: number): SessionPrune {
  const cap = Math.max(1, Math.floor(keep))
  const seen = new Set<string>()
  let duplicates = 0
  const keptSections: MemorySection[] = []
  const droppedTurns = new Set<number>()
  for (const section of document.sections) {
    if (section.sessionId !== sessionId) {
      keptSections.push(section)
      continue
    }
    const entries: MemoryEntry[] = []
    for (const entry of section.entries) {
      const key = normalizeEntryText(entry.text)
      if (seen.has(key)) {
        duplicates += 1
        continue
      }
      seen.add(key)
      entries.push(entry)
    }
    if (entries.length === 0) {
      rememberTurns(droppedTurns, section)
      continue
    }
    keptSections.push(entries.length === section.entries.length
      ? section
      : Object.freeze({ ...section, entries: Object.freeze(entries) }))
  }

  let remaining = keptSections
    .filter(section => section.sessionId === sessionId)
    .reduce((total, section) => total + section.entries.length, 0)
  let overCap = 0
  const ordered = keptSections
    .filter(section => section.sessionId === sessionId)
    .sort((left, right) => left.startTurn - right.startTurn)
  const dropped = new Set<MemorySection>()
  for (const section of ordered) {
    if (remaining <= cap) break
    dropped.add(section)
    remaining -= section.entries.length
    overCap += section.entries.length
    rememberTurns(droppedTurns, section)
  }
  const sections = dropped.size === 0 ? keptSections : keptSections.filter(section => !dropped.has(section))
  if (duplicates === 0 && overCap === 0) {
    return {
      document: sections === document.sections
        ? document
        : Object.freeze({ ...document, sections: Object.freeze(sections) }),
      duplicates,
      overCap,
    }
  }
  const sessions = droppedTurns.size === 0
    ? document.sessions
    : document.sessions.map((record) => {
      if (record.id !== sessionId) return record
      const turns = record.turns.filter(turn => !droppedTurns.has(turn.turn))
      return Object.freeze({ ...record, turns: Object.freeze(turns) })
    })
  return {
    document: Object.freeze({
      ...document,
      sections: Object.freeze(sections),
      sessions: Object.freeze(sessions),
    }),
    duplicates,
    overCap,
  }
}

/** Add every turn a dropped section covered to the removed-turn set. */
function rememberTurns(dropped: Set<number>, section: MemorySection): void {
  for (let turn = section.startTurn; turn <= section.endTurn; turn += 1) dropped.add(turn)
}

/** Normalize one entry text for duplicate detection. */
function normalizeEntryText(text: string): string {
  return text.replaceAll(/\s+/gu, ' ').trim().toLowerCase()
}

/** One session's curation counts, rendered by `/memory stats`. */
export interface MemoryEntryStats {
  /** Session the counts belong to. */
  readonly sessionId: string
  /** Entries across all of this session's sections. */
  readonly entries: number
  /** Entries written by the summary job. */
  readonly auto: number
  /** Entries a human edited. */
  readonly manual: number
  /** UTF-8 bytes of the entry texts. */
  readonly bytes: number
  /** Entries per kind. */
  readonly kinds: Readonly<Record<MemoryEntryKind, number>>
  /** Lowest and highest turn with an entry; absent when nothing has a turn. */
  readonly turns?: readonly [number, number]
}

/**
 * Count one session's entries for the maintenance command.
 * @param document - parsed MEMORY.md.
 * @param sessionId - session whose sections are counted.
 * @returns entry, source, kind, byte, and turn-range counts.
 */
export function summarizeMemoryEntries(document: MemoryDocument, sessionId: string): MemoryEntryStats {
  const kinds: Record<MemoryEntryKind, number> = { decision: 0, files: 0, open: 0, preference: 0 }
  let entries = 0
  let auto = 0
  let manual = 0
  let bytes = 0
  let lowest: number | undefined
  let highest: number | undefined
  for (const section of document.sections) {
    if (section.sessionId !== sessionId) continue
    for (const entry of section.entries) {
      entries += 1
      kinds[entry.kind] += 1
      bytes += Buffer.byteLength(entry.text, 'utf8')
      if (entry.source === 'manual') manual += 1
      else auto += 1
      if (entry.turn !== undefined) {
        lowest = lowest === undefined ? entry.turn : Math.min(lowest, entry.turn)
        highest = highest === undefined ? entry.turn : Math.max(highest, entry.turn)
      }
    }
  }
  return {
    sessionId,
    entries,
    auto,
    manual,
    bytes,
    kinds,
    ...lowest === undefined || highest === undefined ? {} : { turns: [lowest, highest] as const },
  }
}

/**
 * Drop the least recent sessions beyond the retention limit.
 * @param document - document whose window already carries the configured limit.
 * @param currentSessionId - session that must survive the trim.
 * @param limit - maximum sessions to keep.
 * @returns the document with older sessions and their sections removed.
 */
function retainSessions(
  document: MemoryDocument,
  currentSessionId: string,
  limit: number,
): MemoryDocument {
  const keep = Math.max(1, Math.floor(limit))
  if (document.sessions.length <= keep) return document
  const ranked = [...document.sessions]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))
    .slice(0, keep)
    .map(record => record.id)
  if (!ranked.includes(currentSessionId)) {
    // The append's own session survives even when its clock is behind the others'.
    if (ranked.length === keep) ranked[ranked.length - 1] = currentSessionId
    else ranked.push(currentSessionId)
  }
  return withoutSessions(document, new Set(ranked))
}

/**
 * Remove every session outside one keep set, and the sections that belong to them.
 * @param document - document to trim.
 * @param kept - session ids to retain.
 * @returns the document unchanged when nothing was dropped, otherwise the trimmed copy.
 */
function withoutSessions(document: MemoryDocument, kept: ReadonlySet<string>): MemoryDocument {
  const sessions = document.sessions.filter(record => kept.has(record.id))
  if (sessions.length === document.sessions.length) return document
  return {
    ...document,
    sessions,
    sections: document.sections.filter(section => kept.has(section.sessionId)),
  }
}

/** Reject a document whose managed body exceeds the configured budget. */
function assertBodyBudget(document: MemoryDocument, maxBytes: number): void {
  const bytes = Buffer.byteLength(renderManagedBody(document.sections), 'utf8')
  if (bytes <= maxBytes) return
  throw new MemoryDocumentError(
    `memory body is ${String(bytes)} bytes, over the ${String(maxBytes)}-byte limit after evicting every unprotected `
    + 'entry; the incoming write alone does not fit, so raise maxBytes or run /memory prune with a kind/tag filter',
    'budget-exceeded',
  )
}

/** Narrow one parsed frontmatter value to a mapping. */
function asRecord(value: unknown, subject: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MemoryDocumentError(`${subject} must be a mapping`, 'invalid-document')
  }
  return value as Record<string, unknown>
}

/** Read one required integer field. */
function requireInteger(
  record: Record<string, unknown>,
  key: string,
  subject: string,
  minimum: number,
): number {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
    throw new MemoryDocumentError(`${subject}.${key} must be an integer >= ${String(minimum)}`, 'invalid-document')
  }
  return value
}

/** Read one optional integer field. */
function optionalInteger(
  record: Record<string, unknown>,
  key: string,
  subject: string,
): number | undefined {
  if (!Object.hasOwn(record, key)) return undefined
  return requireInteger(record, key, subject, 0)
}

/** Read one required non-empty string field. */
function requireString(record: Record<string, unknown>, key: string, subject: string): string {
  const value = record[key]
  if (typeof value !== 'string') {
    throw new MemoryDocumentError(`${subject}.${key} must be a string`, 'invalid-document')
  }
  return value
}

/** Narrow one parsed tier value. */
function requireTier(value: unknown, subject: string): MemoryTier {
  if (value === 'detail' || value === 'brief') return value
  throw new MemoryDocumentError(`${subject}.tier must be "detail" or "brief"`, 'invalid-document')
}

/** Build store call options without an undefined signal. */
function signalOptions(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal }
}

/** Build write options without undefined fields. */
function writeOptions(signal: AbortSignal | undefined, expected: string | undefined): StoreWriteOptions {
  return {
    ...signal === undefined ? {} : { signal },
    ...expected === undefined ? {} : { expected },
  }
}

/** Whether a write failure is the store's stale-version refusal. */
function isStaleVersion(error: unknown): boolean {
  return error instanceof FsError && error.code === 'FS_STALE_VERSION'
}
