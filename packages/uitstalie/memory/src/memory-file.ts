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
import { replaceSurfaceRange } from './checkpoint.ts'
import { planTierMigrations } from './window.ts'
import type { SurfaceRetry, TierMigrationPlan, TurnRange } from './window.ts'

/** Store-relative path of the per-workspace memory file. */
export const MEMORY_STORE_PATH = 'memory/sessions/MEMORY.md'

/** Marker opening the provider-owned managed block. */
export const MEMORY_BLOCK_BEGIN = '<!-- memory:begin -->'

/** Marker closing the provider-owned managed block. */
export const MEMORY_BLOCK_END = '<!-- memory:end -->'

/** Document format version this module reads and writes. */
export const MEMORY_DOCUMENT_VERSION = 1

/** Default body budget in UTF-8 bytes. */
export const DEFAULT_MEMORY_MAX_BYTES = 4096

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
}

/** Result of one tier migration pass. */
export interface MemoryTierMigrationResult {
  /** Store-relative path that was written. */
  readonly path: string
  /** Version of the written file, when the store reported one. */
  readonly version?: string
  /** Number of sections replaced with a brief checkpoint. */
  readonly briefed: number
  /** Number of sections whose body was forgotten. */
  readonly forgotten: number
  /** Number of earlier-skipped surface replacements this pass completed. */
  readonly retried: number
}

/** Options of one append. */
export interface MemoryAppendOptions {
  /** Window thresholds recorded when the append creates the document. */
  readonly window?: MemoryWindow
  /** Maximum managed-block body size in UTF-8 bytes. */
  readonly maxBytes?: number
}

/** Result of one append. */
export interface MemoryAppendResult {
  /** Store-relative path that was written. */
  readonly path: string
  /** Version of the written file, when the store reported one. */
  readonly version?: string
  /** Kind of the appended entry. */
  readonly kind: MemoryEntryKind
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

/**
 * Append one entry to the managed block of the workspace MEMORY.md.
 *
 * The entry joins the last section of its session when that section covers the
 * same turn and tier; otherwise a new section and frontmatter turn record are
 * created. The write is version-guarded against the text that was read, and one
 * `FS_STALE_VERSION` conflict is retried after a re-read.
 * @param ctx - context carrying `dshStore`.
 * @param session - session the entry belongs to; its project owns the file.
 * @param entry - the entry and the turn it summarizes.
 * @param signal - cancellation for the store read and write.
 * @param options - window thresholds for a new document and the body budget.
 * @returns the written path, the new version, and the entry kind.
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
  const append = async (): Promise<MemoryAppendResult> => {
    const current = await readMemoryDocument(ctx, session, signal)
    const document = current.document ?? createMemoryDocument(window)
    const next = appendToDocument(document, session, entry, kind)
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
  const append = async (): Promise<MemoryTurnSummaryResult> => {
    const current = await readMemoryDocument(ctx, session, signal)
    const document = current.document ?? createMemoryDocument(window)
    const next = appendTurnToDocument(document, session, summary, entries)
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
 * The pass reads the document once, compresses each detail section that reached
 * the brief age through the supplied model callback, replaces the matching
 * surface range with a checkpoint, removes forgotten section bodies, and writes
 * the complete batch with one version-guarded write. Ranges an earlier pass
 * migrated but could not replace on the surface (a snapshot, a compaction
 * checkpoint, or a gap) are retried from the stored text, without re-compressing.
 * A failed compression keeps that section at detail and does not block the other
 * ranges. One stale-version conflict re-reads and applies the plan once more;
 * surface replacements already made are reused by their window, so they are not
 * appended twice.
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
  const window = options.window ?? DEFAULT_MEMORY_WINDOW
  const maxBytes = options.maxBytes ?? DEFAULT_MEMORY_MAX_BYTES
  const compressed = new Map<string, readonly MemoryEntry[]>()
  const checkpoints = new Map<string, number>()
  const migrate = async (): Promise<MemoryTierMigrationResult | undefined> => {
    signal?.throwIfAborted()
    const current = await readMemoryDocument(ctx, session, signal)
    if (current.document === undefined) return undefined
    const plan = planTierMigrations(current.document, currentTurn, { ...window, sessionId: session.id })
    if (plan.toBrief.length === 0 && plan.toForget.length === 0 && plan.retry.length === 0) return undefined
    const briefs = await compressBriefs(ctx, current.document, session, plan, compress, compressed, signal)
    if (briefs.length === 0 && plan.toForget.length === 0 && plan.retry.length === 0) return undefined
    await checkpointMigrations(ctx, current.document, session, plan, briefs, checkpoints, signal)
    const retried = plan.retry.filter(retry => checkpoints.has(rangeKey(retry.action, retry))).length
    if (briefs.length === 0 && plan.toForget.length === 0 && retried === 0) return undefined
    // Once a checkpoint left the surface, the metadata write must finish even if the
    // provider was disabled meanwhile: skipping it here is exactly the half-committed
    // state (checkpoint published, MEMORY.md unchanged) this pass avoids.
    const next = applyMigrations(current.document, session, plan, briefs, checkpoints)
    assertBodyBudget(next, maxBytes)
    const written = await ctx.dshStore.writeFile(
      session,
      MEMORY_STORE_PATH,
      renderMemoryDocument(next),
      writeOptions(undefined, current.version),
    )
    return {
      path: written.path,
      briefed: briefs.length,
      forgotten: plan.toForget.length,
      retried,
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
): Promise<void> {
  for (const brief of briefs) {
    if (signal?.aborted === true) return
    const key = rangeKey('brief', brief.range)
    if (checkpoints.has(key)) continue
    const seq = await replaceSurfaceRange(ctx, session, brief.range, {
      text: renderBriefText(brief.entries),
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
  return renderBriefText(section.entries)
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
function rangeKey(action: 'brief' | 'forget', range: TurnRange): string {
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

/** Render brief entries as the model-facing checkpoint text. */
function renderBriefText(entries: readonly MemoryEntry[]): string {
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
function parseFrontmatter(source: string): Pick<MemoryDocument, 'version' | 'window' | 'sessions'> {
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
  return {
    version,
    window: {
      detail: requireInteger(windowRecord, 'detail', 'frontmatter.window', 1),
      brief: requireInteger(windowRecord, 'brief', 'frontmatter.window', 1),
      forget: requireInteger(windowRecord, 'forget', 'frontmatter.window', 1),
      sessions: requireInteger(windowRecord, 'sessions', 'frontmatter.window', 1),
    },
    sessions: sessions.map((session, index) => parseSessionRecord(session, index)),
  }
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
  const withoutTags = splitEntryTags(groups['text'])
  const { text, turn } = splitEntryTurn(withoutTags.text)
  return {
    kind: assertMemoryEntryKind(groups['kind'] ?? ''),
    text,
    ...turn === undefined ? {} : { turn },
    ...withoutTags.tags === undefined ? {} : { tags: withoutTags.tags },
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
    const entries = section.entries.map(entry => `- [${entry.kind}] ${entry.text}${renderEntryTurn(entry.turn)}${renderEntryTags(entry.tags)}\n`).join('')
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

/** Reject a document whose managed body exceeds the configured budget. */
function assertBodyBudget(document: MemoryDocument, maxBytes: number): void {
  const bytes = Buffer.byteLength(renderManagedBody(document.sections), 'utf8')
  if (bytes <= maxBytes) return
  throw new MemoryDocumentError(
    `memory body is ${String(bytes)} bytes, over the ${String(maxBytes)}-byte limit; forget or trim older entries before writing more`,
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

/** Flatten a thrown value into one line. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
