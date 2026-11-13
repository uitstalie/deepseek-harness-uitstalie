/**
 * The global personality store: the only profile file, its legacy migration,
 * and the version-guarded write path the new capability uses.
 *
 * The new format is a YAML frontmatter with `version`, `updatedAt`, and an
 * `entries` sequence. It has no workspace overlay and no history file. The
 * profile lives under the store atom's `global` scope; the legacy move uses the
 * filesystem seam because the old file predates the new document format.
 * @module @deepseek-ai/dsh-personality/global-store
 */

import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsTarget, FsVersion } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-store-atom'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

/** File name of the global personality profile. */
export const PERSONALITY_FILE_NAME = 'PERSONALITY.md'

/** Store-relative path of the global personality profile. */
export const PERSONALITY_STORE_PATH = `personality/${PERSONALITY_FILE_NAME}`

/** Sibling directory that keeps the pre-rewrite profile. */
export const PERSONALITY_LEGACY_DIR_NAME = 'legacy'

/** Entry kinds the new format accepts, in prompt order. */
export const PERSONALITY_ENTRY_KINDS = ['understanding', 'preference', 'style', 'identity'] as const

/** One accepted entry kind. */
export type PersonalityEntryKind = typeof PERSONALITY_ENTRY_KINDS[number]

/** One personality entry. The name is encoded in the id. */
export interface PersonalityEntry {
  /** `<kind>.<lower-kebab-name>`, unique in the document. */
  readonly id: string
  /** Entry kind parsed from the id. */
  readonly kind: PersonalityEntryKind
  /** One paragraph of text. */
  readonly text: string
}

/** One parsed profile document. */
export interface PersonalityDocument {
  /** Positive document revision, incremented on every write. */
  readonly version: number
  /** UTC ISO-8601 time of the latest write. */
  readonly updatedAt: string
  /** Entries in canonical order. */
  readonly entries: readonly PersonalityEntry[]
}

/** A profile read; `document` is absent when the file does not exist. */
export interface PersonalityRead {
  /** Absolute path shown to the user. */
  readonly path: string
  /** Parsed document when the file exists. */
  readonly document?: PersonalityDocument
  /** Opaque store version for the next guarded write. */
  readonly version?: string
}

/** One entry input before its id is derived. */
export interface PersonalityEntryInput {
  /** Entry kind; identity is refused by the tool path. */
  readonly kind: PersonalityEntryKind
  /** Lower-kebab entry name. */
  readonly name: string
  /** One paragraph of text. */
  readonly text: string
}

/** Result of a successful entry write. */
export interface PersonalityWriteResult {
  /** Absolute path shown to the user. */
  readonly path: string
  /** New document revision. */
  readonly revision: number
  /** Stored entry. */
  readonly entry: PersonalityEntry
  /** Opaque store version after the write. */
  readonly version?: string
}

/** Stable failure codes for profile parsing and writing. */
export type PersonalityStoreErrorCode =
  | 'invalid-document'
  | 'unknown-kind'
  | 'invalid-name'
  | 'identity-manual'
  | 'budget-exceeded'
  | 'legacy-conflict'

/** Typed profile failure with an actionable message. */
export class PersonalityStoreError extends Error {
  /**
   * @param message - reason naming the offending value or file.
   * @param code - stable failure kind.
   */
  constructor(message: string, readonly code: PersonalityStoreErrorCode) {
    super(message)
    this.name = 'PersonalityStoreError'
  }
}

/** Result of inspecting and moving the old profile. */
export type LegacyMigration =
  | { readonly status: 'absent' }
  | { readonly status: 'current' }
  | { readonly status: 'moved'; readonly legacyPath: string }
  | { readonly status: 'already-migrated'; readonly legacyPath: string }

/** Maximum characters in one entry text. */
export const PERSONALITY_MAX_ENTRY_CHARS = 400

/** Maximum serialized document size in UTF-8 bytes. */
export const PERSONALITY_MAX_BODY_BYTES = 32 * 1024

/** Absolute path of the global profile under the current harness home. */
export function globalPersonalityPath(): string {
  return join(resolveDshHome(), 'personality', PERSONALITY_FILE_NAME)
}

/** Build an entry id from its kind and lower-kebab name. */
export function personalityEntryId(kind: PersonalityEntryKind, name: string): string {
  return `${kind}.${name}`
}

/** Parse one entry id, rejecting an unknown kind or a malformed name. */
export function parsePersonalityEntryId(id: string): { readonly kind: PersonalityEntryKind; readonly name: string } {
  const separator = id.indexOf('.')
  if (separator < 1 || separator === id.length - 1) {
    throw new PersonalityStoreError(
      `personality entry id ${JSON.stringify(id)} must be "<kind>.<lower-kebab-name>"`,
      'invalid-name',
    )
  }
  const kind = id.slice(0, separator)
  const name = id.slice(separator + 1)
  if (!(PERSONALITY_ENTRY_KINDS as readonly string[]).includes(kind)) {
    throw new PersonalityStoreError(
      `unknown personality entry kind ${JSON.stringify(kind)}; valid kinds: ${PERSONALITY_ENTRY_KINDS.join(', ')}`,
      'unknown-kind',
    )
  }
  assertEntryName(name)
  return { kind: kind as PersonalityEntryKind, name }
}

/** Create an empty document at revision 1. */
export function createPersonalityDocument(
  entries: readonly PersonalityEntry[] = [],
  now: Date = new Date(),
): PersonalityDocument {
  return {
    version: 1,
    updatedAt: now.toISOString(),
    entries: sortEntries(entries),
  }
}

/** Render one document as the canonical file text. */
export function renderPersonalityDocument(document: PersonalityDocument): string {
  const body = stringifyYaml({
    version: document.version,
    updatedAt: document.updatedAt,
    entries: sortEntries(document.entries).map(entry => ({ id: entry.id, kind: entry.kind, text: entry.text })),
  }, { lineWidth: 0 })
  assertDocumentBudget(body)
  return `---\n${body}---\n`
}

/** Parse one profile file, rejecting unknown shapes and invalid entries. */
export function parsePersonalityDocument(text: string): PersonalityDocument {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?([\s\S]*)$/u.exec(text.replace(/^\uFEFF/u, ''))
  if (match === null) {
    throw new PersonalityStoreError('PERSONALITY.md must start with a YAML frontmatter block delimited by "---"', 'invalid-document')
  }
  const trailing = match[2]
  if (trailing !== undefined && trailing.trim().length > 0) {
    throw new PersonalityStoreError('PERSONALITY.md must contain only the YAML frontmatter', 'invalid-document')
  }
  let parsed: unknown
  try {
    parsed = parseYaml(match[1] as string)
  } catch (error: unknown) {
    throw new PersonalityStoreError(
      `PERSONALITY.md frontmatter is not valid YAML: ${String(error)}`,
      'invalid-document',
    )
  }
  const record = asRecord(parsed, 'PERSONALITY.md frontmatter')
  const version = record.version
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new PersonalityStoreError('PERSONALITY.md.version must be a positive integer', 'invalid-document')
  }
  const updatedAt = record.updatedAt
  if (typeof updatedAt !== 'string' || Number.isNaN(Date.parse(updatedAt))) {
    throw new PersonalityStoreError('PERSONALITY.md.updatedAt must be a UTC ISO-8601 string', 'invalid-document')
  }
  if (!Array.isArray(record.entries)) {
    throw new PersonalityStoreError('PERSONALITY.md.entries must be a sequence', 'invalid-document')
  }
  const entries: PersonalityEntry[] = []
  const seen = new Set<string>()
  for (const [index, raw] of record.entries.entries()) {
    const entry = asRecord(raw, `PERSONALITY.md.entries[${String(index)}]`)
    const id = entry.id
    const kind = entry.kind
    const entryText = entry.text
    if (typeof id !== 'string' || typeof kind !== 'string' || typeof entryText !== 'string') {
      throw new PersonalityStoreError(`PERSONALITY.md.entries[${String(index)}] needs string id, kind, and text`, 'invalid-document')
    }
    const parsedId = parsePersonalityEntryId(id)
    if (parsedId.kind !== kind) {
      throw new PersonalityStoreError(
        `PERSONALITY.md.entries[${String(index)}].kind ${JSON.stringify(kind)} does not match id ${JSON.stringify(id)}`,
        'invalid-document',
      )
    }
    if (seen.has(id)) {
      throw new PersonalityStoreError(`PERSONALITY.md has duplicate entry id ${JSON.stringify(id)}`, 'invalid-document')
    }
    seen.add(id)
    entries.push({ id, kind: parsedId.kind, text: normalizeEntryText(entryText) })
  }
  const document: PersonalityDocument = { version, updatedAt, entries: sortEntries(entries) }
  assertDocumentBudget(renderPersonalityBody(document))
  return document
}

/** Read the global profile; a missing file is an empty read, not an error. */
export async function readGlobalPersonality(ctx: Context, signal?: AbortSignal): Promise<PersonalityRead> {
  const read = await ctx.dshStore.readFile(undefined, PERSONALITY_STORE_PATH, {
    scope: 'global',
    ...signal === undefined ? {} : { signal },
  })
  if (read.text === undefined) return { path: globalPersonalityPath() }
  return {
    path: globalPersonalityPath(),
    document: parsePersonalityDocument(read.text),
    ...read.version === undefined ? {} : { version: read.version },
  }
}

/**
 * Write one document through the version guard.
 *
 * `expectedVersion` is the store version observed by the caller. Omitting it is
 * reserved for a first create; an existing file then fails the guard instead of
 * being silently overwritten.
 */
export async function writeGlobalPersonality(
  ctx: Context,
  document: PersonalityDocument,
  expectedVersion?: string,
  signal?: AbortSignal,
): Promise<{ readonly path: string; readonly version?: string }> {
  const text = renderPersonalityDocument(document)
  const written = await ctx.dshStore.writeFile(undefined, PERSONALITY_STORE_PATH, text, {
    scope: 'global',
    ...expectedVersion === undefined ? {} : { expected: expectedVersion },
    ...signal === undefined ? {} : { signal },
  })
  return {
    path: globalPersonalityPath(),
    ...written.version === undefined ? {} : { version: written.version },
  }
}

/**
 * Upsert one entry by id and retry one stale write after a re-read.
 *
 * Identity is refused before any I/O because the user owns that kind; the new
 * tool path has no proposal queue.
 */
export async function upsertGlobalPersonalityEntry(
  ctx: Context,
  input: PersonalityEntryInput,
  signal?: AbortSignal,
): Promise<PersonalityWriteResult> {
  const normalized = normalizeInput(input)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const read = await readGlobalPersonality(ctx, signal)
    const previous = read.document?.entries ?? []
    const entry: PersonalityEntry = {
      id: personalityEntryId(normalized.kind, normalized.name),
      kind: normalized.kind,
      text: normalized.text,
    }
    const entries = upsertEntry(previous, entry)
    const document: PersonalityDocument = {
      version: (read.document?.version ?? 0) + 1,
      updatedAt: new Date().toISOString(),
      entries,
    }
    try {
      const written = await writeGlobalPersonality(ctx, document, read.version, signal)
      return {
        path: written.path,
        revision: document.version,
        entry,
        ...written.version === undefined ? {} : { version: written.version },
      }
    } catch (error: unknown) {
      if (attempt === 0 && isStaleWrite(error)) continue
      throw error
    }
  }
  /* v8 ignore next -- the loop either returns or rethrows on its second attempt. */
  throw new Error('personality: stale write retry exhausted')
}

/**
 * Move the pre-rewrite profile into `legacy/`, or finish a crash-interrupted move.
 *
 * The move uses `fs.moveFile` with a source version guard and a
 * create-if-absent destination. A backend without move support falls back to
 * read → write destination → compare → delete source; a failure at any step
 * leaves the source in place and reports the legacy path when it already exists.
 */
export async function migrateLegacyPersonality(ctx: Context, signal?: AbortSignal): Promise<LegacyMigration> {
  const sourcePath = globalPersonalityPath()
  const legacyDir = join(dirname(sourcePath), PERSONALITY_LEGACY_DIR_NAME)
  const source = await ctx.fs.resolve(sourcePath, signal === undefined ? {} : { signal })
  const info = await ctx.fs.stat(source, signal)
  if (info === undefined) return { status: 'absent' }
  if (info.type !== 'file') {
    throw new PersonalityStoreError(`personality legacy source ${sourcePath} is not a regular file`, 'legacy-conflict')
  }
  const sourceText = await ctx.fs.readText(source, signal)
  try {
    parsePersonalityDocument(sourceText)
    return { status: 'current' }
  } catch {
    // Not a new-format document: treat it as the pre-rewrite profile and move it.
  }
  const already = await findIdenticalLegacy(ctx, legacyDir, sourcePath, signal)
  if (already !== undefined) {
    await ctx.fs.deleteFile(source, { version: info.version }, signal)
    return { status: 'already-migrated', legacyPath: already }
  }
  const directory = await ctx.fs.resolve(legacyDir, signal === undefined ? {} : { signal })
  await ctx.fs.mkdir(directory, signal)
  const timestamp = legacyTimestamp(new Date())
  for (let suffix = 0; suffix < 10; suffix += 1) {
    const name = suffix === 0 ? `PERSONALITY.${timestamp}.md` : `PERSONALITY.${timestamp}-${String(suffix)}.md`
    const legacyPath = join(legacyDir, name)
    const destination = await ctx.fs.resolve(legacyPath, signal === undefined ? {} : { signal })
    if (await ctx.fs.stat(destination, signal) !== undefined) continue
    try {
      const moved = await ctx.fs.moveFile(source, destination, {
        expectedSource: { version: info.version },
        expectedDestination: { kind: 'createIfAbsent' },
      }, signal)
      if (moved.sourceDeleted) return { status: 'moved', legacyPath }
      throw new PersonalityStoreError(
        `moved ${sourcePath} to ${legacyPath} but could not remove the source: ${moved.sourceFailure.message}`,
        'legacy-conflict',
      )
    } catch (error: unknown) {
      if (error instanceof FsError && (error.code === 'FS_NOT_OBSERVED' || error.code === 'FS_ALREADY_EXISTS')) continue
      if (error instanceof FsError && error.code === 'FS_IO_ERROR') {
        return await copyLegacyPersonality(ctx, source, sourcePath, destination, legacyPath, info.version, signal)
      }
      throw error
    }
  }
  throw new PersonalityStoreError(`could not find a free legacy name for ${sourcePath}`, 'legacy-conflict')
}

/** Normalize one input and reject identity before any I/O. */
function normalizeInput(input: PersonalityEntryInput): PersonalityEntryInput {
  if (input.kind === 'identity') {
    throw new PersonalityStoreError(
      'identity entries are manual-only; edit PERSONALITY.md directly because the new apply path never writes identity.*',
      'identity-manual',
    )
  }
  if (!(PERSONALITY_ENTRY_KINDS as readonly string[]).includes(input.kind)) {
    throw new PersonalityStoreError(
      `unknown personality entry kind ${JSON.stringify(input.kind)}; valid kinds: ${PERSONALITY_ENTRY_KINDS.join(', ')}`,
      'unknown-kind',
    )
  }
  assertEntryName(input.name)
  return { kind: input.kind, name: input.name, text: normalizeEntryText(input.text) }
}

/** Validate one lower-kebab entry name. */
function assertEntryName(name: string): void {
  if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) return
  throw new PersonalityStoreError(
    `personality entry name ${JSON.stringify(name)} must be lower-kebab-case`,
    'invalid-name',
  )
}

/** Validate and trim one entry paragraph. */
function normalizeEntryText(text: string): string {
  const normalized = text.trim()
  if (normalized.length === 0) {
    throw new PersonalityStoreError('personality entry text must not be empty', 'invalid-document')
  }
  if (/\n[ \t]*\n/u.test(normalized)) {
    throw new PersonalityStoreError('personality entry text must be one paragraph without blank lines', 'invalid-document')
  }
  const length = Array.from(normalized).length
  if (length > PERSONALITY_MAX_ENTRY_CHARS) {
    throw new PersonalityStoreError(
      `personality entry text is ${String(length)} characters, over the ${String(PERSONALITY_MAX_ENTRY_CHARS)}-character limit`,
      'budget-exceeded',
    )
  }
  return normalized
}

/** Sort entries by the canonical kind order and then id. */
function sortEntries(entries: readonly PersonalityEntry[]): readonly PersonalityEntry[] {
  return [...entries].sort((left, right) => {
    const kind = PERSONALITY_ENTRY_KINDS.indexOf(left.kind) - PERSONALITY_ENTRY_KINDS.indexOf(right.kind)
    if (kind !== 0) return kind
    return left.id < right.id ? -1 : 1
  })
}

/** Upsert by id while preserving canonical order. */
function upsertEntry(entries: readonly PersonalityEntry[], entry: PersonalityEntry): readonly PersonalityEntry[] {
  const index = entries.findIndex(candidate => candidate.id === entry.id)
  if (index < 0) return sortEntries([...entries, entry])
  return sortEntries([...entries.slice(0, index), entry, ...entries.slice(index + 1)])
}

/** Render only the entries, for the body budget. */
function renderPersonalityBody(document: PersonalityDocument): string {
  return stringifyYaml({
    version: document.version,
    updatedAt: document.updatedAt,
    entries: sortEntries(document.entries).map(entry => ({ id: entry.id, kind: entry.kind, text: entry.text })),
  }, { lineWidth: 0 })
}

/** Reject a rendered document over the UTF-8 body budget. */
function assertDocumentBudget(text: string): void {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes <= PERSONALITY_MAX_BODY_BYTES) return
  throw new PersonalityStoreError(
    `personality document is ${String(bytes)} bytes, over the ${String(PERSONALITY_MAX_BODY_BYTES)}-byte limit`,
    'budget-exceeded',
  )
}

/** Narrow one parsed YAML value to a mapping. */
function asRecord(value: unknown, subject: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PersonalityStoreError(`${subject} must be a mapping`, 'invalid-document')
  }
  return value as Record<string, unknown>
}

/** Whether one write failure means the observed version is stale. */
function isStaleWrite(error: unknown): boolean {
  return error instanceof FsError && (error.code === 'FS_STALE_VERSION' || error.code === 'FS_NOT_OBSERVED')
}

/** UTC timestamp safe as a Windows file name. */
function legacyTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')
}

/** Find a legacy copy whose bytes equal the source, for crash recovery. */
async function findIdenticalLegacy(
  ctx: Context,
  legacyDir: string,
  sourcePath: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const directory = await ctx.fs.resolve(legacyDir, signal === undefined ? {} : { signal })
  if (await ctx.fs.stat(directory, signal) === undefined) return undefined
  const sourceText = await ctx.fs.readText(await ctx.fs.resolve(sourcePath, signal === undefined ? {} : { signal }), signal)
  for (const child of await ctx.fs.listDir(directory, signal)) {
    if (child.type !== 'file') continue
    if (!/^PERSONALITY\..+\.md$/u.test(child.name)) continue
    const text = await ctx.fs.readText(child.target, signal).catch(() => undefined)
    if (text === sourceText) return join(legacyDir, child.name)
  }
  return undefined
}

/** Copy, verify, then delete when the backend cannot move a file. */
async function copyLegacyPersonality(
  ctx: Context,
  source: FsTarget,
  sourcePath: string,
  destination: FsTarget,
  legacyPath: string,
  version: FsVersion,
  signal?: AbortSignal,
): Promise<LegacyMigration> {
  const text = await ctx.fs.readText(source, signal)
  await ctx.fs.writeText(destination, text, { kind: 'createIfAbsent' }, signal)
  const copied = await ctx.fs.readText(destination, signal)
  if (copied !== text) {
    throw new PersonalityStoreError(`legacy copy ${legacyPath} does not match ${sourcePath}`, 'legacy-conflict')
  }
  try {
    await ctx.fs.deleteFile(source, { version }, signal)
  } catch (error: unknown) {
    throw new PersonalityStoreError(
      `copied ${sourcePath} to ${legacyPath} but could not remove the source: ${String(error)}`,
      'legacy-conflict',
    )
  }
  return { status: 'moved', legacyPath }
}
