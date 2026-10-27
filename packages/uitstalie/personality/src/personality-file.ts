/**
 * PERSONALITY.md repository: the global user profile at
 * `$DSH_HOME/personality/PERSONALITY.md` and its optional workspace overlay at
 * `.dsh/memory/PERSONALITY.md`.
 *
 * The file has a YAML frontmatter carrying the document revision, the update
 * time, and the entry count, plus a managed block between the
 * `personality:begin` and `personality:end` markers carrying one
 * `## <kind>.<name>` entry per paragraph. Text outside the managed block is
 * hand-written and preserved byte for byte, while the managed block is
 * provider-owned and rewritten.
 *
 * The global file is read and written through `ctx.fs`, because the `.dsh`
 * store is confined to the workspace. The overlay is read and written through
 * `ctx.dshStore`. Every write is version-guarded: the version observed before
 * composing the next text is required by the write, and one stale conflict is
 * retried after a re-read before the failure surfaces.
 * @module @deepseek-ai/dsh-personality/personality-file
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { FsError } from '@deepseek-ai/dsh-fs'
import { parse as parseYaml } from 'yaml'
import type { StoreWriteOptions } from '@deepseek-ai/dsh-store-atom'
import type { PersonalitySettings } from './config.ts'

/** Default file name of the global personality profile. */
export const PERSONALITY_FILE_NAME = 'PERSONALITY.md'

/** Default file name of the append-only version history beside a profile file. */
export const PERSONALITY_HISTORY_FILE_NAME = 'PERSONALITY.history.jsonl'

/** Store-relative path of the workspace overlay. */
export const PERSONALITY_STORE_PATH = `memory/${PERSONALITY_FILE_NAME}`

/** Store-relative path of the workspace overlay's version history. */
export const PERSONALITY_HISTORY_STORE_PATH = `memory/${PERSONALITY_HISTORY_FILE_NAME}`

/** Store-relative path of the global profile under the user's `$DSH_HOME`. */
export const PERSONALITY_GLOBAL_STORE_PATH = `personality/${PERSONALITY_FILE_NAME}`

/** Store-relative path of the global history under the user's `$DSH_HOME`. */
export const PERSONALITY_GLOBAL_HISTORY_STORE_PATH = `personality/${PERSONALITY_HISTORY_FILE_NAME}`

/** Marker opening the provider-owned managed block. */
export const PERSONALITY_BLOCK_BEGIN = '<!-- personality:begin -->'

/** Marker closing the provider-owned managed block. */
export const PERSONALITY_BLOCK_END = '<!-- personality:end -->'

/** Revision a profile file starts at; every write increments it. */
export const PERSONALITY_INITIAL_VERSION = 1

/** Default managed-body budget in UTF-8 bytes. */
export const DEFAULT_PERSONALITY_MAX_BYTES = 2048

/** Entry kinds a personality file may carry, in the order the parser lists them. */
export const PERSONALITY_ENTRY_KINDS = ['understanding', 'style', 'preference', 'identity'] as const

/** Entry kinds the workspace overlay may carry; identity and understanding stay global. */
export const PERSONALITY_WORKSPACE_ENTRY_KINDS = ['style', 'preference'] as const

/** One recognized entry kind. */
export type PersonalityEntryKind = typeof PERSONALITY_ENTRY_KINDS[number]

/** Where a history record came from. */
export type PersonalityHistorySource = 'user' | 'auto'

/** Outcome codes a personality read or write can report. */
export type PersonalityDocumentErrorCode =
  | 'invalid-document'
  | 'unknown-kind'
  | 'budget-exceeded'
  | 'identity-manual'
  | 'workspace-kind-not-allowed'

/** Typed PERSONALITY.md failure; `code` is stable for callers and logs. */
export class PersonalityDocumentError extends Error {
  /**
   * @param message - actionable description naming the offending entry or line.
   * @param code - stable failure kind.
   */
  constructor(message: string, readonly code: PersonalityDocumentErrorCode) {
    super(message)
    this.name = 'PersonalityDocumentError'
  }
}

/** One entry kind and what it records. */
export interface PersonalityKindDefinition {
  /** Stable kind id written before the dot of an entry id. */
  readonly id: PersonalityEntryKind
  /** What an entry of this kind records, for the tool schema and diagnostics. */
  readonly description: string
}

/** The kind registry the parser, renderer, prompt, and tool schema share. */
export const PERSONALITY_KIND_REGISTRY: readonly PersonalityKindDefinition[] = [
  { id: 'understanding', description: 'how this user words requests, terms, and ambiguous input' },
  { id: 'style', description: 'how this user prefers replies to be written' },
  { id: 'preference', description: 'an enduring working preference of this user' },
  { id: 'identity', description: 'who this user is; user-confirmed manual edits only' },
]

/** One personality entry in the managed block. */
export interface PersonalityEntry {
  /** Merge key in the form `<kind>.<name>`. */
  readonly id: string
  /** Kind parsed from {@link PersonalityEntry.id}. */
  readonly kind: PersonalityEntryKind
  /** Lower-kebab name parsed from {@link PersonalityEntry.id}. */
  readonly name: string
  /** One paragraph of entry text. */
  readonly text: string
}

/** Text around the managed block, preserved verbatim on render. */
export interface PersonalityFrame {
  /** Bytes between the frontmatter block and the begin marker. */
  readonly before: string
  /** Bytes after the end marker. */
  readonly after: string
}

/** Complete PERSONALITY.md content. */
export interface PersonalityDocument {
  /** Document revision; starts at {@link PERSONALITY_INITIAL_VERSION} and increments on every write. */
  readonly version: number
  /** ISO-8601 time of the last write. */
  readonly updatedAt: string
  /** Managed-block entries in file order. */
  readonly entries: readonly PersonalityEntry[]
  /** Hand-written text around the managed block. */
  readonly frame: PersonalityFrame
}

/** One entry a caller writes. */
export interface PersonalityEntryInput {
  /** Kind from the registry. */
  readonly kind: PersonalityEntryKind
  /** Lower-kebab name; the id becomes `<kind>.<name>`. */
  readonly name: string
  /** One paragraph of entry text. */
  readonly text: string
}

/** One file read: the path, plus the parsed document and version when the file exists. */
export interface PersonalityFileRead {
  /** Absolute path for the global file, store-relative path for the overlay. */
  readonly path: string
  /** Parsed document; absent while the file does not exist. */
  readonly document?: PersonalityDocument
  /** Opaque version of the existing file, passed to a guarded write. */
  readonly version?: string
}

/** The merged personality state one agent sees. */
export interface PersonalityRead {
  /** The global profile read. */
  readonly global: PersonalityFileRead
  /** The workspace overlay read; absent when the overlay is disabled. */
  readonly workspace?: PersonalityFileRead
  /** Global entries with workspace entries replacing them by id. */
  readonly entries: readonly PersonalityEntry[]
}

/** Which entry changed between two revisions, keyed by entry id. */
export interface PersonalityEntryChange {
  /** Entry id that changed. */
  readonly id: string
  /** Kind of change. */
  readonly change: 'added' | 'updated' | 'removed'
}

/** One line of `PERSONALITY.history.jsonl`. */
export interface PersonalityHistoryRecord {
  /** Document revision the write produced. */
  readonly version: number
  /** ISO-8601 time of the write. */
  readonly at: string
  /** Writer that produced the revision. */
  readonly source: PersonalityHistorySource
  /** Session that requested the write. */
  readonly session: string
  /** Entries added, updated, or removed by this revision. */
  readonly diff: readonly PersonalityEntryChange[]
  /** Complete managed block after the write, so a revert needs no diff replay. */
  readonly block: string
}

/** Contents of one version history file. */
export interface PersonalityHistoryRead {
  /** Path of the history file in the form its backend uses. */
  readonly path: string
  /** Parsed records in file order. */
  readonly records: readonly PersonalityHistoryRecord[]
}

/** Outcome of restoring one global history record's managed block. */
export type PersonalityRevertOutcome =
  | {
    /** The block was restored and a new revision written. */
    readonly kind: 'reverted'
    /** Absolute path of the written profile. */
    readonly path: string
    /** Document revision the write produced. */
    readonly revision: number
    /** History version whose block was restored. */
    readonly restored: number
    /** By-id changes between the replaced block and the restored block. */
    readonly diff: readonly PersonalityEntryChange[]
  }
  | {
    /** The profile already carries the requested version, so nothing was written. */
    readonly kind: 'current'
    /** Version that made the revert a no-op. */
    readonly version: number
  }

/** One personality file together with its history file. */
export interface PersonalityFileTarget {
  /** Whether the file is the global profile or the workspace overlay. */
  readonly scope: 'global' | 'workspace'
  /** Absolute path for the global file, store-relative path for the overlay. */
  readonly path: string
  /** History path beside the file, in the same path form as {@link PersonalityFileTarget.path}. */
  readonly historyPath: string
}

/** Options of one personality write. */
export interface PersonalityWriteOptions {
  /** Resolved provider settings, including paths and the body budget. */
  readonly settings: PersonalitySettings
  /** Writer recorded in the history line. */
  readonly source: PersonalityHistorySource
  /**
   * Write an identity entry that the user already confirmed.
   *
   * Identity entries describe who the user is, so the provider never writes one
   * on its own; only the proposal-acceptance path sets this, after a human chose
   * to accept a queued proposal.
   */
  readonly confirmIdentity?: boolean
}

/** Result of one personality write. */
export interface PersonalityWriteResult {
  /** Path that was written, in the same form as {@link PersonalityFileTarget.path}. */
  readonly path: string
  /** Opaque version of the written file, when the backend reported one. */
  readonly version?: string
  /** Document revision the write produced. */
  readonly revision: number
  /** Entry as it now appears in the file. */
  readonly entry: PersonalityEntry
}

/** Text between the frontmatter and the managed block of a new file. */
const DEFAULT_PERSONALITY_FRAME: PersonalityFrame = { before: '\n', after: '\n' }

/** Frontmatter block at the start of the file. */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u

/** Heading line of one managed-block entry, with the pinned separator characters. */
const ENTRY_HEADING = /^## (?<id>\S+)$/u

/** Shape of an entry id: a lower-case kind, a dot, and a lower-kebab name. */
const ENTRY_ID = /^(?<kind>[a-z]+)\.(?<name>[a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/u

/** Shape of one lower-kebab entry name. */
const ENTRY_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u

/**
 * Look up one entry kind.
 * @param kind - candidate kind id from a document or a caller.
 * @returns the registry definition, or undefined for an unrecognized id.
 */
export function personalityKindDefinition(kind: string): PersonalityKindDefinition | undefined {
  return PERSONALITY_KIND_REGISTRY.find(definition => definition.id === kind)
}

/**
 * Validate one entry kind at a durable-file or caller boundary.
 * @param kind - candidate kind id.
 * @returns the narrowed kind.
 * @throws PersonalityDocumentError `unknown-kind` listing every valid kind.
 */
export function assertPersonalityEntryKind(kind: string): PersonalityEntryKind {
  const definition = personalityKindDefinition(kind)
  if (definition !== undefined) return definition.id
  throw new PersonalityDocumentError(
    `unknown personality entry kind ${JSON.stringify(kind)}; valid kinds: ${PERSONALITY_ENTRY_KINDS.join(', ')}`,
    'unknown-kind',
  )
}

/**
 * Split one entry id into its kind and name.
 * @param id - entry id in the form `<kind>.<name>`.
 * @returns the narrowed kind and the lower-kebab name.
 * @throws PersonalityDocumentError `invalid-document` for a malformed id and
 *   `unknown-kind` for a recognized shape with an unregistered kind.
 */
export function parsePersonalityEntryId(id: string): { kind: PersonalityEntryKind; name: string } {
  const match = ENTRY_ID.exec(id)
  const groups = match?.groups
  if (groups === undefined) {
    throw new PersonalityDocumentError(
      `personality entry id ${JSON.stringify(id)} must have the form "<kind>.<lower-kebab-name>"`,
      'invalid-document',
    )
  }
  return {
    kind: assertPersonalityEntryKind(groups['kind'] ?? ''),
    name: groups['name'] ?? '',
  }
}

/**
 * Create an empty document for a file that does not exist yet.
 * @param entries - entries to start with; defaults to none.
 * @returns a document at {@link PERSONALITY_INITIAL_VERSION} with no hand-written text.
 */
export function createPersonalityDocument(entries: readonly PersonalityEntry[] = []): PersonalityDocument {
  return {
    version: PERSONALITY_INITIAL_VERSION,
    updatedAt: new Date().toISOString(),
    entries,
    frame: DEFAULT_PERSONALITY_FRAME,
  }
}

/**
 * Parse PERSONALITY.md into its revision, update time, entries, and preserved text.
 * @param text - complete file text.
 * @returns the parsed document, including the hand-written text around the managed block.
 * @throws PersonalityDocumentError `invalid-document` or `unknown-kind` when the
 *   file cannot be read safely.
 */
export function parsePersonalityDocument(text: string): PersonalityDocument {
  const frontmatter = splitFrontmatter(text)
  const block = splitManagedBlock(frontmatter.content)
  const machine = parseFrontmatter(frontmatter.frontmatter)
  return {
    ...machine,
    entries: parseManagedBody(block.body),
    frame: block.frame,
  }
}

/**
 * Render a document back to PERSONALITY.md text.
 *
 * The frontmatter and managed block are written in the canonical style this
 * module parses, so a parse/render round trip reproduces the bytes of a file
 * this module wrote. The frontmatter entry count is re-rendered from the
 * entries, so a stale hand-edited count is corrected by the next write.
 * @param document - document to render.
 * @returns complete file text ending with the document frame's trailing text.
 */
export function renderPersonalityDocument(document: PersonalityDocument): string {
  const frontmatter = `version: ${String(document.version)}\nupdatedAt: ${document.updatedAt}\nentries: ${String(document.entries.length)}\n`
  return `---\n${frontmatter}---\n${document.frame.before}${renderPersonalityBlock(document.entries)}${document.frame.after}`
}

/**
 * Render the complete managed block, markers included.
 *
 * History lines store this text so a later revert can replace the managed block
 * without replaying a diff.
 * @param entries - entries to render, in file order.
 * @returns the begin marker, one heading plus paragraph per entry, and the end marker.
 */
export function renderPersonalityBlock(entries: readonly PersonalityEntry[]): string {
  return `${PERSONALITY_BLOCK_BEGIN}${renderPersonalityBody(entries)}${PERSONALITY_BLOCK_END}`
}

/**
 * Parse one complete managed block, markers included, into its entries.
 *
 * History records store the block so a revert replaces it without replaying a
 * diff. This validates a stored block at the durable-file boundary before a
 * revert writes it back.
 * @param block - complete managed block text.
 * @returns the entries the block carries, in file order.
 * @throws PersonalityDocumentError `invalid-document` when a marker is missing
 *   or text lies outside the managed block.
 */
export function parsePersonalityBlock(block: string): readonly PersonalityEntry[] {
  const split = splitManagedBlock(block)
  if (split.frame.before.trim().length > 0 || split.frame.after.trim().length > 0) {
    throw new PersonalityDocumentError(
      'history block carries text outside the personality:begin/end markers',
      'invalid-document',
    )
  }
  return parseManagedBody(split.body)
}

/**
 * Build the global profile target, including its history path.
 * @param settings - resolved provider settings.
 * @returns the global profile file and the history file beside it.
 */
export function personalityGlobalTarget(settings: PersonalitySettings): PersonalityFileTarget {
  return { scope: 'global', path: settings.globalPath, historyPath: settings.globalHistoryPath }
}

/** Render the managed-block body without its markers. */
function renderPersonalityBody(entries: readonly PersonalityEntry[]): string {
  if (entries.length === 0) return '\n\n'
  return `\n\n${entries.map(entry => `## ${entry.id}\n${entry.text}`).join('\n\n')}\n\n`
}

/**
 * Merge global entries with the workspace overlay by entry id.
 *
 * A workspace entry replaces the global entry with the same id and appends when
 * the id is new. The overlay may only carry style and preference entries.
 * @param global - entries from the global profile, in file order.
 * @param workspace - entries from the workspace overlay, in file order.
 * @returns the merged entries in global order, with new overlay entries appended.
 * @throws PersonalityDocumentError `workspace-kind-not-allowed` when an overlay
 *   entry is not a style or preference entry.
 */
export function mergePersonalityEntries(
  global: readonly PersonalityEntry[],
  workspace: readonly PersonalityEntry[],
): readonly PersonalityEntry[] {
  const merged = [...global]
  for (const entry of workspace) {
    assertWorkspaceEntry(entry)
    const index = merged.findIndex(existing => existing.id === entry.id)
    if (index < 0) merged.push(entry)
    else merged[index] = entry
  }
  return merged
}

/**
 * Read the global personality profile through the store atom's global scope.
 * A missing file is not an error: the caller composes a new document and
 * creates the file without a version guard.
 * @param ctx - context carrying `dshStore`.
 * @param settings - resolved provider settings, including the global display path and budget.
 * @param signal - cancellation for the store read.
 * @returns the path plus the parsed document and version when the file exists.
 * @throws PersonalityDocumentError when an existing file cannot be parsed or
 *   exceeds the managed-body budget.
 */
export async function readGlobalPersonality(
  ctx: Context,
  settings: PersonalitySettings,
  signal?: AbortSignal,
): Promise<PersonalityFileRead> {
  const read = await ctx.dshStore.readFile(undefined, PERSONALITY_GLOBAL_STORE_PATH, {
    scope: 'global',
    ...signalOptions(signal),
  })
  if (read.text === undefined) return { path: settings.globalPath }
  const document = parsePersonalityDocument(read.text)
  assertBodyBudget(document.entries, settings.maxBytes)
  return {
    path: settings.globalPath,
    document,
    ...read.version === undefined ? {} : { version: read.version },
  }
}

/**
 * Read the merged personality state one agent's session sees.
 *
 * The global profile is read through `ctx.fs`; the workspace overlay is read
 * through `ctx.dshStore` when {@link PersonalitySettings.workspaceOverlay} is
 * on. Entries merge by id, with the overlay replacing the global entry.
 * @param ctx - context carrying `fs` and `dshStore`.
 * @param session - session whose workspace owns the overlay.
 * @param settings - resolved provider settings.
 * @param signal - cancellation for both reads.
 * @returns the two file reads and the merged entries.
 * @throws PersonalityDocumentError when either file is invalid, carries an
 *   overlay-only kind in the overlay, or exceeds the managed-body budget.
 */
export async function readPersonality(
  ctx: Context,
  session: Session,
  settings: PersonalitySettings,
  signal?: AbortSignal,
): Promise<PersonalityRead> {
  const global = await readGlobalPersonality(ctx, settings, signal)
  const workspace = settings.workspaceOverlay
    ? await readWorkspacePersonality(ctx, session, settings, signal)
    : undefined
  return {
    global,
    ...workspace === undefined ? {} : { workspace },
    entries: mergePersonalityEntries(global.document?.entries ?? [], workspace?.document?.entries ?? []),
  }
}

/**
 * Read the global version history that drift review reads.
 *
 * Every global write appends one line and nothing rewrites the file. A missing
 * file is an empty history; a malformed line fails with `invalid-document`
 * naming the line, because a revert would otherwise write an unvalidated block.
 * @param ctx - context carrying `fs`.
 * @param settings - resolved provider settings.
 * @param signal - cancellation for the read.
 * @returns the history path and every parsed record in file order.
 * @throws PersonalityDocumentError when an existing history file is not a
 *   regular file or a line is not a valid record.
 */
export async function readGlobalPersonalityHistory(
  ctx: Context,
  settings: PersonalitySettings,
  signal?: AbortSignal,
): Promise<PersonalityHistoryRead> {
  const current = await readGlobalHistoryText(ctx, PERSONALITY_GLOBAL_HISTORY_STORE_PATH, signal)
  return { path: settings.globalHistoryPath, records: parseHistoryRecords(current.text) }
}

/**
 * Write one entry to the file that owns its kind.
 *
 * Identity entries are rejected before any I/O because the user must confirm
 * them by editing PERSONALITY.md. Style and preference entries go to the
 * workspace overlay when it is enabled, understanding entries go to the global
 * file, and a disabled overlay sends style and preference entries to the global
 * file too. The write is version-guarded against the text that was read, and one
 * `FS_STALE_VERSION` conflict is retried after a re-read. The history line is
 * appended after the entry write; a history failure is logged and does not
 * report the entry write as failed.
 * @param ctx - context carrying `fs` and `dshStore`.
 * @param session - session that requested the write; its workspace owns the overlay.
 * @param entry - the entry to add or replace.
 * @param options - resolved settings and the history source.
 * @param signal - cancellation for the reads, the write, and the history append.
 * @returns the written path, its version, the new revision, and the stored entry.
 * @throws PersonalityDocumentError `identity-manual` for an identity entry and
 *   `budget-exceeded` when the managed body would exceed the budget.
 * @throws FsError when the guarded write fails twice or the backend refuses the write.
 */
export async function writePersonalityEntry(
  ctx: Context,
  session: Session,
  entry: PersonalityEntryInput,
  options: PersonalityWriteOptions,
  signal?: AbortSignal,
): Promise<PersonalityWriteResult> {
  const kind = assertPersonalityEntryKind(entry.kind)
  if (kind === 'identity' && options.confirmIdentity !== true) {
    throw new PersonalityDocumentError(
      'identity entries need user confirmation: ask the user to accept a queued proposal or edit PERSONALITY.md directly, because this provider never writes identity.* entries on its own',
      'identity-manual',
    )
  }
  assertEntryName(entry.name)
  const input: PersonalityEntryInput = { kind, name: entry.name, text: normalizeEntryText(entry.text) }
  const target = personalityFileTarget(options.settings, kind)
  const write = async (): Promise<PersonalityWriteResult> => {
    const current = await readTargetFile(ctx, session, target, options.settings, signal)
    const previous = current.document?.entries ?? []
    const entries = upsertPersonalityEntry(previous, input)
    assertBodyBudget(entries, options.settings.maxBytes)
    const revision = (current.document?.version ?? 0) + 1
    const document: PersonalityDocument = {
      version: revision,
      updatedAt: new Date().toISOString(),
      entries,
      frame: current.document?.frame ?? DEFAULT_PERSONALITY_FRAME,
    }
    const written = await writeTargetFile(ctx, session, target, document, current.version, signal)
    const stored: PersonalityEntry = { id: `${kind}.${input.name}`, kind, name: input.name, text: input.text }
    const record: PersonalityHistoryRecord = {
      version: revision,
      at: document.updatedAt,
      source: options.source,
      session: session.id,
      diff: personalityEntryChanges(previous, entries),
      block: renderPersonalityBlock(entries),
    }
    try {
      await appendHistory(ctx, session, target, record, signal, options.settings.historyLimit)
    } catch (error: unknown) {
      ctx.logger.warn(
        'personality: wrote %s but could not append the version history: %s',
        written.path,
        error instanceof Error ? error.message : String(error),
      )
    }
    return {
      path: written.path,
      revision,
      entry: stored,
      ...written.version === undefined ? {} : { version: written.version },
    }
  }
  try {
    return await write()
  } catch (error: unknown) {
    if (!isStaleWrite(error)) throw error
    return await write()
  }
}

/**
 * Restore one history record's managed block into the global profile.
 *
 * The current file's hand-written frame and version are read, the stored block
 * is parsed and budget-checked, and the rebuilt document is written with the
 * observed version. One stale conflict is retried after a re-read. A successful
 * write appends a history line with `source: 'user'`, so a revert is itself
 * reviewable; a history failure is logged and does not fail the revert.
 * Restoring the version the file already carries writes nothing.
 * @param ctx - context carrying `fs`.
 * @param session - session that requested the revert; recorded in the new history line.
 * @param settings - resolved provider settings, including the global path and budget.
 * @param record - history record whose managed block to restore.
 * @param signal - cancellation for the reads, the write, and the history append.
 * @returns the written revision, or that the requested version is already current.
 * @throws PersonalityDocumentError when the stored block is malformed or would
 *   exceed the managed-body budget.
 * @throws FsError when the guarded write fails twice or the backend refuses the write.
 */
export async function revertGlobalPersonality(
  ctx: Context,
  session: Session,
  settings: PersonalitySettings,
  record: PersonalityHistoryRecord,
  signal?: AbortSignal,
): Promise<PersonalityRevertOutcome> {
  const entries = parsePersonalityBlock(record.block)
  assertBodyBudget(entries, settings.maxBytes)
  const target = personalityGlobalTarget(settings)
  const write = async (): Promise<PersonalityRevertOutcome> => {
    const current = await readGlobalPersonality(ctx, settings, signal)
    if (current.document?.version === record.version) {
      return { kind: 'current', version: record.version }
    }
    const revision = (current.document?.version ?? 0) + 1
    const document: PersonalityDocument = {
      version: revision,
      updatedAt: new Date().toISOString(),
      entries,
      frame: current.document?.frame ?? DEFAULT_PERSONALITY_FRAME,
    }
    const written = await writeTargetFile(ctx, session, target, document, current.version, signal)
    const diff = personalityEntryChanges(current.document?.entries ?? [], entries)
    const history: PersonalityHistoryRecord = {
      version: revision,
      at: document.updatedAt,
      source: 'user',
      session: session.id,
      diff,
      block: renderPersonalityBlock(entries),
    }
    try {
      await appendHistory(ctx, session, target, history, signal, settings.historyLimit)
    } catch (error: unknown) {
      ctx.logger.warn(
        'personality: reverted %s but could not append the version history: %s',
        written.path,
        error instanceof Error ? error.message : String(error),
      )
    }
    return { kind: 'reverted', path: written.path, revision, restored: record.version, diff }
  }
  try {
    return await write()
  } catch (error: unknown) {
    if (!isStaleWrite(error)) throw error
    return await write()
  }
}

/**
 * Append one version record to the history file beside a personality file.
 *
 * The existing history text is preserved byte for byte and one JSON line is
 * added; when the file would exceed `limit` records, the oldest lines are
 * dropped in the same write so the history stays bounded. The write is
 * version-guarded like the profile write, with one retry on a stale conflict.
 * @param ctx - context carrying `fs` and `dshStore`.
 * @param session - session whose workspace owns the overlay history.
 * @param target - the profile file whose history receives the record.
 * @param record - one complete revision record.
 * @param signal - cancellation for the read and the write.
 * @param limit - maximum records to keep; `Infinity` disables rotation.
 * @throws FsError when the guarded write fails twice or the backend refuses the write.
 */
export async function appendHistory(
  ctx: Context,
  session: Session,
  target: PersonalityFileTarget,
  record: PersonalityHistoryRecord,
  signal?: AbortSignal,
  limit: number = Number.POSITIVE_INFINITY,
): Promise<void> {
  const line = `${JSON.stringify(record)}\n`
  const append = async (): Promise<void> => {
    const current = await readHistory(ctx, session, target, signal)
    const prefix = current.text.length === 0 || current.text.endsWith('\n') ? current.text : `${current.text}\n`
    const text = boundHistory(`${prefix}${line}`, limit)
    await writeHistory(ctx, session, target, text, current.version, signal)
  }
  try {
    await append()
  } catch (error: unknown) {
    if (!isStaleWrite(error)) throw error
    await append()
  }
}

/**
 * Keep only the newest `limit` records of a JSONL history text.
 *
 * Non-empty lines are the records; the kept lines are rewritten in order with a
 * trailing newline. A limit at or above the record count returns the text
 * unchanged, so a normal append stays byte-for-byte append-only.
 * @param text - the complete history text, already including the new line.
 * @param limit - maximum records to keep.
 * @returns the bounded text.
 */
function boundHistory(text: string, limit: number): string {
  if (!Number.isFinite(limit)) return text
  const lines = text.split('\n').filter(line => line.trim().length > 0)
  if (lines.length <= limit) return text
  return `${lines.slice(-Math.max(1, Math.trunc(limit))).join('\n')}\n`
}

/** Split the leading frontmatter block from the rest of the file. */
function splitFrontmatter(text: string): { frontmatter: string; content: string } {
  const match = FRONTMATTER.exec(text)
  if (match === null) {
    throw new PersonalityDocumentError(
      'PERSONALITY.md must start with a YAML frontmatter block between `---` lines',
      'invalid-document',
    )
  }
  return { frontmatter: match[1] ?? '', content: text.slice(match[0].length) }
}

/** Split the managed block from the hand-written text around it. */
function splitManagedBlock(content: string): { body: string; frame: PersonalityFrame } {
  const begin = content.indexOf(PERSONALITY_BLOCK_BEGIN)
  if (begin < 0) {
    throw new PersonalityDocumentError(
      `PERSONALITY.md has no ${PERSONALITY_BLOCK_BEGIN} marker`,
      'invalid-document',
    )
  }
  const bodyStart = begin + PERSONALITY_BLOCK_BEGIN.length
  const end = content.indexOf(PERSONALITY_BLOCK_END, bodyStart)
  if (end < 0) {
    throw new PersonalityDocumentError(
      `PERSONALITY.md has no ${PERSONALITY_BLOCK_END} marker after the begin marker`,
      'invalid-document',
    )
  }
  return {
    body: content.slice(bodyStart, end),
    frame: {
      before: content.slice(0, begin),
      after: content.slice(end + PERSONALITY_BLOCK_END.length),
    },
  }
}

/** Parse the YAML frontmatter into the revision and update time. */
function parseFrontmatter(source: string): Pick<PersonalityDocument, 'version' | 'updatedAt'> {
  let data: unknown
  try {
    data = parseYaml(source)
  } catch (error: unknown) {
    throw new PersonalityDocumentError(
      `PERSONALITY.md frontmatter is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
      'invalid-document',
    )
  }
  const record = asRecord(data, 'frontmatter')
  const version = requireInteger(record, 'version', 'frontmatter', PERSONALITY_INITIAL_VERSION)
  const updatedAt = requireString(record, 'updatedAt', 'frontmatter')
  if (Number.isNaN(Date.parse(updatedAt))) {
    throw new PersonalityDocumentError('frontmatter.updatedAt must be an ISO-8601 timestamp', 'invalid-document')
  }
  // The count is informational: rendering writes the actual entry count, so a
  // hand edit that leaves the number stale does not block parsing.
  requireInteger(record, 'entries', 'frontmatter', 0)
  return { version, updatedAt }
}

/** Parse the managed-block body into entries. */
function parseManagedBody(body: string): readonly PersonalityEntry[] {
  return body
    .replaceAll(/\r\n/gu, '\n')
    .split(/\n{2,}/u)
    .map(chunk => chunk.trim())
    .filter(chunk => chunk.length > 0)
    .map((chunk, index) => {
      const lines = chunk.split('\n')
      const heading = lines[0] ?? ''
      const match = ENTRY_HEADING.exec(heading)
      const id = match?.groups?.['id']
      if (id === undefined) {
        throw new PersonalityDocumentError(
          `managed block entry ${String(index + 1)}: expected "## <kind>.<name>"`,
          'invalid-document',
        )
      }
      const text = lines.slice(1).join('\n').trim()
      if (text.length === 0) {
        throw new PersonalityDocumentError(`managed block entry ${JSON.stringify(id)} has no text`, 'invalid-document')
      }
      return { id, ...parsePersonalityEntryId(id), text }
    })
}

/** Parse every non-empty history line, validating each record. */
function parseHistoryRecords(text: string): readonly PersonalityHistoryRecord[] {
  const records: PersonalityHistoryRecord[] = []
  for (const [index, rawLine] of text.split('\n').entries()) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    records.push(parseHistoryRecord(line, index + 1))
  }
  return records
}

/** Validate one JSONL history line at the durable-file boundary. */
function parseHistoryRecord(line: string, lineNumber: number): PersonalityHistoryRecord {
  const subject = `${PERSONALITY_HISTORY_FILE_NAME} line ${String(lineNumber)}`
  let data: unknown
  try {
    data = JSON.parse(line)
  } catch (error: unknown) {
    throw new PersonalityDocumentError(
      `${subject} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      'invalid-document',
    )
  }
  const record = asRecord(data, subject)
  const at = requireString(record, 'at', subject)
  if (Number.isNaN(Date.parse(at))) {
    throw new PersonalityDocumentError(`${subject}.at must be an ISO-8601 timestamp`, 'invalid-document')
  }
  const source = record['source']
  if (source !== 'user' && source !== 'auto') {
    throw new PersonalityDocumentError(`${subject}.source must be "user" or "auto"`, 'invalid-document')
  }
  return {
    version: requireInteger(record, 'version', subject, PERSONALITY_INITIAL_VERSION),
    at,
    source,
    session: requireString(record, 'session', subject),
    diff: parseHistoryDiff(record['diff'], subject),
    block: requireString(record, 'block', subject),
  }
}

/** Validate the by-id change list of one history record. */
function parseHistoryDiff(value: unknown, subject: string): readonly PersonalityEntryChange[] {
  if (!Array.isArray(value)) {
    throw new PersonalityDocumentError(`${subject}.diff must be an array`, 'invalid-document')
  }
  return value.map((entry, index) => {
    const item = `${subject}.diff[${String(index)}]`
    const record = asRecord(entry, item)
    const change = record['change']
    if (change !== 'added' && change !== 'updated' && change !== 'removed') {
      throw new PersonalityDocumentError(`${item}.change must be added, updated, or removed`, 'invalid-document')
    }
    return { id: requireString(record, 'id', item), change }
  })
}

/** Compose the next entry list, replacing the entry with the same id. */
function upsertPersonalityEntry(
  entries: readonly PersonalityEntry[],
  input: PersonalityEntryInput,
): readonly PersonalityEntry[] {
  const entry: PersonalityEntry = { id: `${input.kind}.${input.name}`, kind: input.kind, name: input.name, text: input.text }
  const index = entries.findIndex(existing => existing.id === entry.id)
  if (index < 0) return [...entries, entry]
  return entries.map((existing, position) => position === index ? entry : existing)
}

/** Compute the by-id changes between two entry lists. */
function personalityEntryChanges(
  before: readonly PersonalityEntry[],
  after: readonly PersonalityEntry[],
): readonly PersonalityEntryChange[] {
  const previous = new Map(before.map(entry => [entry.id, entry.text]))
  const changes: PersonalityEntryChange[] = []
  for (const entry of after) {
    const text = previous.get(entry.id)
    if (text === undefined) changes.push({ id: entry.id, change: 'added' })
    else if (text !== entry.text) changes.push({ id: entry.id, change: 'updated' })
    previous.delete(entry.id)
  }
  for (const id of previous.keys()) changes.push({ id, change: 'removed' })
  return changes.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
}

/** Resolve the file that owns one entry kind. */
function personalityFileTarget(settings: PersonalitySettings, kind: PersonalityEntryKind): PersonalityFileTarget {
  const workspace = settings.workspaceOverlay && (kind === 'style' || kind === 'preference')
  return workspace
    ? { scope: 'workspace', path: settings.workspaceStorePath, historyPath: settings.workspaceHistoryStorePath }
    : personalityGlobalTarget(settings)
}

/** Read the file a write targets, validating overlay restrictions for the overlay. */
async function readTargetFile(
  ctx: Context,
  session: Session,
  target: PersonalityFileTarget,
  settings: PersonalitySettings,
  signal: AbortSignal | undefined,
): Promise<PersonalityFileRead> {
  return target.scope === 'workspace'
    ? await readWorkspacePersonality(ctx, session, settings, signal)
    : await readGlobalPersonality(ctx, settings, signal)
}

/** Read and validate the workspace overlay. */
async function readWorkspacePersonality(
  ctx: Context,
  session: Session,
  settings: PersonalitySettings,
  signal: AbortSignal | undefined,
): Promise<PersonalityFileRead> {
  const read = await ctx.dshStore.readFile(session, settings.workspaceStorePath, signalOptions(signal))
  if (read.text === undefined) return { path: read.path }
  const document = parsePersonalityDocument(read.text)
  for (const entry of document.entries) assertWorkspaceEntry(entry)
  assertBodyBudget(document.entries, settings.maxBytes)
  return {
    path: read.path,
    document,
    ...read.version === undefined ? {} : { version: read.version },
  }
}

/** Reject an overlay entry whose kind is not allowed there. */
function assertWorkspaceEntry(entry: PersonalityEntry): void {
  if ((PERSONALITY_WORKSPACE_ENTRY_KINDS as readonly string[]).includes(entry.kind)) return
  throw new PersonalityDocumentError(
    `workspace overlay may only carry ${PERSONALITY_WORKSPACE_ENTRY_KINDS.map(kind => `${kind}.*`).join(' and ')} entries; found ${entry.id}`,
    'workspace-kind-not-allowed',
  )
}

/** Write one rendered document through the backend that owns the target. */
async function writeTargetFile(
  ctx: Context,
  session: Session,
  target: PersonalityFileTarget,
  document: PersonalityDocument,
  version: string | undefined,
  signal: AbortSignal | undefined,
): Promise<{ path: string; version?: string }> {
  const text = renderPersonalityDocument(document)
  if (target.scope === 'workspace') {
    const written = await ctx.dshStore.writeFile(session, target.path, text, storeWriteOptions(signal, version))
    return { path: written.path, ...written.version === undefined ? {} : { version: written.version } }
  }
  const written = await ctx.dshStore.writeFile(undefined, PERSONALITY_GLOBAL_STORE_PATH, text, {
    ...storeWriteOptions(signal, version),
    scope: 'global',
  })
  return {
    path: target.path,
    ...written.version === undefined ? {} : { version: written.version },
  }
}

/** Read the accumulated history text and its version. */
async function readHistory(
  ctx: Context,
  session: Session,
  target: PersonalityFileTarget,
  signal: AbortSignal | undefined,
): Promise<{ text: string; version?: string }> {
  if (target.scope === 'workspace') {
    const read = await ctx.dshStore.readFile(session, target.historyPath, signalOptions(signal))
    return {
      text: read.text ?? '',
      ...read.version === undefined ? {} : { version: read.version },
    }
  }
  return await readGlobalHistoryText(ctx, PERSONALITY_GLOBAL_HISTORY_STORE_PATH, signal)
}

/** Read the global history text and its version through the store atom's global scope. */
async function readGlobalHistoryText(
  ctx: Context,
  storePath: string,
  signal: AbortSignal | undefined,
): Promise<{ text: string; version?: string }> {
  const read = await ctx.dshStore.readFile(undefined, storePath, {
    scope: 'global',
    ...signalOptions(signal),
  })
  if (read.text === undefined) return { text: '' }
  return {
    text: read.text,
    ...read.version === undefined ? {} : { version: read.version },
  }
}

/** Write the accumulated history text through the backend that owns the target. */
async function writeHistory(
  ctx: Context,
  session: Session,
  target: PersonalityFileTarget,
  text: string,
  version: string | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (target.scope === 'workspace') {
    await ctx.dshStore.writeFile(session, target.historyPath, text, storeWriteOptions(signal, version))
    return
  }
  await ctx.dshStore.writeFile(undefined, PERSONALITY_GLOBAL_HISTORY_STORE_PATH, text, {
    ...storeWriteOptions(signal, version),
    scope: 'global',
  })
}

/** Reject a document whose managed body exceeds the configured budget. */
function assertBodyBudget(entries: readonly PersonalityEntry[], maxBytes: number): void {
  const bodyBytes = Buffer.byteLength(renderPersonalityBody(entries), 'utf8')
  if (bodyBytes <= maxBytes) return
  const sizes = entries.map(entry => `${entry.id}=${String(Buffer.byteLength(entry.text, 'utf8'))}B`).join(', ')
  throw new PersonalityDocumentError(
    `personality body is ${String(bodyBytes)} bytes, over the ${String(maxBytes)}-byte limit; entries: ${sizes}`,
    'budget-exceeded',
  )
}

/** Validate one entry name at a caller boundary. */
function assertEntryName(name: string): void {
  if (ENTRY_NAME.test(name)) return
  throw new PersonalityDocumentError(
    `personality entry name ${JSON.stringify(name)} must be lower-kebab-case`,
    'invalid-document',
  )
}

/** Validate and normalize one entry text at a caller boundary. */
function normalizeEntryText(text: string): string {
  const normalized = text.trim()
  if (normalized.length === 0) {
    throw new PersonalityDocumentError('personality entry text must not be empty', 'invalid-document')
  }
  if (/\n[ \t]*\n/u.test(normalized)) {
    throw new PersonalityDocumentError('personality entry text must be one paragraph without blank lines', 'invalid-document')
  }
  return normalized
}

/** Narrow one parsed frontmatter value to a mapping. */
function asRecord(value: unknown, subject: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PersonalityDocumentError(`${subject} must be a mapping`, 'invalid-document')
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
    throw new PersonalityDocumentError(`${subject}.${key} must be an integer >= ${String(minimum)}`, 'invalid-document')
  }
  return value
}

/** Read one required string field. */
function requireString(record: Record<string, unknown>, key: string, subject: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new PersonalityDocumentError(`${subject}.${key} must be a non-empty string`, 'invalid-document')
  }
  return value
}

/** Whether a write failure means the observed version is stale. */
function isStaleWrite(error: unknown): boolean {
  return error instanceof FsError && (error.code === 'FS_STALE_VERSION' || error.code === 'FS_NOT_OBSERVED')
}

/** Build a call's signal options without an undefined field. */
function signalOptions(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal }
}

/** Build store write options without undefined fields. */
function storeWriteOptions(signal: AbortSignal | undefined, expected: string | undefined): StoreWriteOptions {
  return {
    ...signal === undefined ? {} : { signal },
    ...expected === undefined ? {} : { expected },
  }
}
