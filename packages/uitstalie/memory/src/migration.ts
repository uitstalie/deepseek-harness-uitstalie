/**
 * One-time migration of the per-workspace memory files to the global store.
 *
 * Every workspace can hold a legacy `.dsh/memory/sessions/MEMORY.md` and its
 * `MEMORY.archive.md`. This module scans both, classifies each entry, and
 * produces a readable report: the file, the entry, the class, the proposed
 * global topic, the reason, the byte count, and the target path. A dry run
 * writes nothing; applying requires the report's hash, backs up every file it
 * changes, appends archive records before it rewrites an active file, and can
 * restore every backup. A global candidate is migrated only because a person
 * confirmed the report that listed it.
 *
 * The active workspace files keep the same version-1 format after a rewrite, so
 * the legacy parser reads them unchanged and a code rollback can still parse
 * what this module wrote. The new global file is a separate path the old code
 * never reads.
 * @module @deepseek-ai/dsh-memory/migration
 */

import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { HarnessError } from '@deepseek-ai/dsh-error'
import { parseMemoryArchiveText, renderMemoryArchiveText } from './archive.ts'
import {
  GLOBAL_MEMORY_MAX_BYTES,
  classifyMemoryText,
  createGlobalArchiveDocument,
  createGlobalMemoryDocument,
  globalMemoryEntryId,
  parseGlobalArchiveDocument,
  parseGlobalMemoryDocument,
  renderGlobalArchiveDocument,
  renderGlobalMemoryDocument,
} from './global-memory.ts'
import type {
  GlobalMemoryArchiveDocument,
  GlobalMemoryArchiveEntry,
  GlobalMemoryDocument,
  GlobalMemoryEntry,
  GlobalMemoryTopic,
  MemoryFactClass,
} from './global-memory.ts'
import {
  MEMORY_ARCHIVE_STORE_PATH,
  MEMORY_STORE_PATH,
  memoryArchiveRecord,
  parseMemoryDocument,
  pruneEmptyMemorySessions,
  renderMemoryDocument,
} from './memory-file.ts'
import type {
  MemoryArchiveRecord,
  MemoryDocument,
  MemoryEntry,
  MemorySection,
} from './memory-file.ts'

/** Stable failure codes for the migration command. */
export type MemoryMigrationErrorCode =
  | 'MIGRATION_REPORT_STALE'
  | 'MIGRATION_RUN_NOT_FOUND'
  | 'MIGRATION_INVALID_RUN_ID'
  | 'MIGRATION_WORKSPACE_NOT_FOUND'
  | 'MIGRATION_DUPLICATE_WORKSPACE'

/** Typed migration failure with an actionable message. */
export class MemoryMigrationError extends HarnessError {
  /**
   * @param message - reason naming the report, run, or workspace that failed.
   * @param code - stable failure kind.
   */
  constructor(message: string, override readonly code: MemoryMigrationErrorCode) {
    super(message, code)
    this.name = 'MemoryMigrationError'
  }
}

/** One workspace the migration scans. */
export interface MigrationWorkspace {
  /** Stable workspace id used in the report; defaults to the directory name. */
  readonly id?: string
  /** Absolute workspace directory that owns a `.dsh` store. */
  readonly directory: string
}

/** Options shared by the dry run and the apply step. */
export interface MemoryMigrationOptions {
  /** Harness home; defaults to `$DSH_HOME` or `~/.dsh`. */
  readonly home?: string
  /** Workspaces to scan. */
  readonly workspaces: readonly MigrationWorkspace[]
  /** Clock used for report and backup timestamps; defaults to `new Date()`. */
  readonly now?: Date
  /** Cancellation for the filesystem reads. */
  readonly signal?: AbortSignal
}

/** What kind of legacy file one report row describes. */
export type MigrationFileKind = 'active' | 'archive'

/** Where one unit was found. */
export type MigrationUnitOrigin = 'active' | 'archive'

/** What the apply step does with one unit. */
export type MigrationDisposition = 'migrate' | 'discard' | 'skip'

/** One classified legacy entry. */
export interface MigrationUnit {
  /** Content-derived identity, stable across the active-to-archive move. */
  readonly id: string
  /** Absolute file the entry was read from. */
  readonly file: string
  /** Whether the entry came from the active file or its archive. */
  readonly origin: MigrationUnitOrigin
  /** Session that wrote the entry. */
  readonly sessionId: string
  /** Kind of the legacy entry. */
  readonly kind: string
  /** Turn the entry summarizes, when it carried one. */
  readonly turn?: number
  /** Full entry text. */
  readonly text: string
  /** UTF-8 byte length of the text. */
  readonly bytes: number
  /** Class the heuristic assigned. */
  readonly class: MemoryFactClass
  /** Proposed global topic for a `global` candidate. */
  readonly topic?: GlobalMemoryTopic
  /** Readable reason for the class or the skip. */
  readonly reason: string
  /** What the apply step does with the entry. */
  readonly disposition: MigrationDisposition
  /** Set only when `disposition` is `skip`; why it was skipped. */
  readonly skipReason?: string
}

/** One scanned file. */
export interface MigrationFile {
  /** Absolute path of the legacy file. */
  readonly path: string
  /** Path shown in the report (relative to the workspace when possible). */
  readonly displayPath: string
  /** Whether the file is the active file or the archive. */
  readonly kind: MigrationFileKind
  /** Whether the file exists. */
  readonly exists: boolean
  /** Number of entries the file contributed. */
  readonly entries: number
  /** UTF-8 bytes of the file. */
  readonly bytes: number
  /** Parse failure that prevented the file from being read, when any. */
  readonly parseError?: string
}

/** Per-class counts in the report summary. */
export interface MigrationClassCounts {
  /** Cross-workspace fact or convention candidates. */
  readonly global: number
  /** Dispatch or session state entries. */
  readonly dispatch: number
  /** Business facts. */
  readonly business: number
  /** Persona or style notes. */
  readonly persona: number
  /** Entries the heuristic could not own. */
  readonly unclassified: number
}

/** Summary block of one report. */
export interface MigrationSummary {
  /** Files found, including archives. */
  readonly files: number
  /** Entries found across every file. */
  readonly entries: number
  /** Entries proposed for migration. */
  readonly migrate: number
  /** Entries discarded with a recorded reason. */
  readonly discard: number
  /** Entries skipped because an earlier run handled them or a file did not parse. */
  readonly skip: number
  /** UTF-8 bytes across every entry text. */
  readonly bytes: number
  /** UTF-8 bytes of the entries proposed for migration. */
  readonly migrateBytes: number
  /** Counts per class. */
  readonly classes: MigrationClassCounts
}

/** One complete dry-run report. */
export interface MemoryMigrationReport {
  /** SHA-256 report hash the apply step must repeat. */
  readonly hash: string
  /** Markdown report a person reads and confirms. */
  readonly text: string
  /** Harness home the run addresses. */
  readonly home: string
  /** Absolute path of the global target. */
  readonly targetPath: string
  /** Absolute path of the global archive. */
  readonly archivePath: string
  /** Whether the run is an apply; the report says dry run otherwise. */
  readonly mode: 'dry-run' | 'apply'
  /** Summary counts. */
  readonly summary: MigrationSummary
  /** Scanned files, in workspace order. */
  readonly files: readonly MigrationFile[]
  /** Every unit, in scan order. */
  readonly units: readonly MigrationUnit[]
}

/** One backed-up file. */
export interface MigrationBackup {
  /** Absolute path of the file that was changed. */
  readonly path: string
  /** Absolute path of the backup copy. */
  readonly backup: string
  /** Whether the file existed before the run; `false` means rollback removes it. */
  readonly existed: boolean
}

/** Result of an applied migration. */
export interface MemoryMigrationApplyResult {
  /** Run id used by the rollback command. */
  readonly runId: string
  /** Report hash the apply step confirmed. */
  readonly reportHash: string
  /** Report that was applied. */
  readonly report: MemoryMigrationReport
  /** Entries migrated to the global store. */
  readonly migrated: number
  /** Entries discarded with archive records. */
  readonly discarded: number
  /** Entries skipped. */
  readonly skipped: number
  /** Files that were backed up and changed, in write order. */
  readonly changed: readonly string[]
  /** One backup record per changed file. */
  readonly backups: readonly MigrationBackup[]
  /** Directory holding the manifest, report copy, and backups. */
  readonly runDirectory: string
}

/** Result of a rollback. */
export interface MemoryMigrationRollbackResult {
  /** Run that was rolled back. */
  readonly runId: string
  /** Files restored from their backups, in restore order. */
  readonly restored: readonly string[]
  /** Files deleted because the run created them. */
  readonly removed: readonly string[]
  /** Whether the run had already been rolled back. */
  readonly alreadyRolledBack: boolean
}

/** Journal entry for one handled unit. */
interface JournalUnit {
  readonly runId: string
  readonly disposition: MigrationDisposition
  readonly at: string
}

/** One applied run in the journal. */
interface JournalRun {
  readonly runId: string
  readonly reportHash: string
  readonly at: string
  status: 'applied' | 'rolled-back'
}

/** Durable migration journal; it makes a second dry run converge. */
interface MigrationJournal {
  version: 1
  units: Record<string, JournalUnit>
  runs: JournalRun[]
}

/** Durable manifest of one applied run. */
interface MigrationManifest {
  version: 1
  runId: string
  reportHash: string
  at: string
  status: 'applied' | 'rolled-back'
  migrated: number
  discarded: number
  skipped: number
  changed: string[]
  backups: MigrationBackup[]
}

/** A unit plus the parsed coordinates the apply step needs to rewrite a file. */
interface ScannedUnit extends MigrationUnit {
  /** Section index in the parsed document, for an active unit. */
  readonly sectionIndex?: number
  /** Entry index inside the section, for an active unit. */
  readonly entryIndex?: number
  /** Parsed entry and section, for building an archive record. */
  readonly entry?: MemoryEntry
  readonly section?: MemorySection
}

/** One file's scan result shared by the report and the apply step. */
interface ScannedFile extends MigrationFile {
  readonly units: readonly ScannedUnit[]
  readonly document?: MemoryDocument
  readonly archiveRecords?: readonly MemoryArchiveRecord[]
}

/** Apply options: the report hash is the explicit confirmation. */
export interface MemoryMigrationApplyOptions extends MemoryMigrationOptions {
  /** Hash printed by the dry run being confirmed. */
  readonly reportHash: string
}

/** Rollback options. */
export interface MemoryMigrationRollbackOptions {
  /** Harness home that holds the migration journal and runs. */
  readonly home?: string
  /** Run id returned by the apply step. */
  readonly runId: string
  /** Clock used for the journal update; defaults to `new Date()`. */
  readonly now?: Date
  /** Cancellation for the filesystem reads. */
  readonly signal?: AbortSignal
}

/** Hash payload version; bump only with a report-format change. */
const REPORT_HASH_VERSION = 1

/** Maximum characters of a discarded entry's text shown in the report. */
const REPORT_TEXT_MAX_CHARS = 200

/** Run id shape; the rollback command refuses anything else so a path cannot escape. */
const RUN_ID_PATTERN = /^[0-9A-Za-z-]+$/u

/** Absolute harness home for one options object. */
function homeOf(options: { readonly home?: string }): string {
  return resolve(options.home ?? resolveDshHome())
}

/** Absolute global memory paths for one home. */
function globalPaths(home: string): {
  readonly memoryDirectory: string
  readonly targetPath: string
  readonly archivePath: string
  readonly journalPath: string
  readonly runsDirectory: string
} {
  const memoryDirectory = join(home, 'memory')
  return {
    memoryDirectory,
    targetPath: join(memoryDirectory, 'GLOBAL.md'),
    archivePath: join(memoryDirectory, 'GLOBAL.archive.md'),
    journalPath: join(memoryDirectory, 'migration', 'journal.json'),
    runsDirectory: join(memoryDirectory, 'migration', 'runs'),
  }
}

/** Read a UTF-8 file, returning undefined when it does not exist. */
async function readText(path: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    return await readFile(path, { encoding: 'utf8', ...signal === undefined ? {} : { signal } })
  } catch (error: unknown) {
    if (isErrno(error, 'ENOENT')) return undefined
    throw error
  }
}

/** Whether one caught error is the named filesystem errno. */
function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === code
}

/** Resolve and validate the workspace list; duplicates and missing directories fail loudly. */
async function resolveWorkspaces(
  workspaces: readonly MigrationWorkspace[],
): Promise<readonly { readonly id: string; readonly directory: string }[]> {
  const seen = new Set<string>()
  const resolved: { id: string; directory: string }[] = []
  for (const workspace of workspaces) {
    const directory = resolve(workspace.directory)
    if (seen.has(directory)) {
      throw new MemoryMigrationError(`workspace ${JSON.stringify(directory)} is listed twice`, 'MIGRATION_DUPLICATE_WORKSPACE')
    }
    seen.add(directory)
    let info: Awaited<ReturnType<typeof stat>>
    try {
      info = await stat(directory)
    } catch (error: unknown) {
      if (isErrno(error, 'ENOENT')) {
        throw new MemoryMigrationError(`workspace ${JSON.stringify(directory)} does not exist`, 'MIGRATION_WORKSPACE_NOT_FOUND')
      }
      throw error
    }
    if (!info.isDirectory()) {
      throw new MemoryMigrationError(`workspace ${JSON.stringify(directory)} is not a directory`, 'MIGRATION_WORKSPACE_NOT_FOUND')
    }
    resolved.push({ id: workspace.id ?? basename(directory), directory })
  }
  return resolved.sort((left, right) => left.directory.localeCompare(right.directory))
}

/** Content identity shared by the active and archive copies of one entry. */
function unitId(sessionId: string, kind: string, turn: number | undefined, text: string): string {
  return createHash('sha256')
    .update([sessionId, kind, turn === undefined ? '' : String(turn), text].join('\u0000'))
    .digest('hex')
    .slice(0, 16)
}

/** Classify and place one legacy entry. */
function classifyUnit(input: {
  readonly file: string
  readonly origin: MigrationUnitOrigin
  readonly sessionId: string
  readonly kind: string
  readonly turn: number | undefined
  readonly text: string
  readonly entry?: MemoryEntry
  readonly section?: MemorySection
  readonly sectionIndex?: number
  readonly entryIndex?: number
}): ScannedUnit {
  const bytes = Buffer.byteLength(input.text, 'utf8')
  const id = unitId(input.sessionId, input.kind, input.turn, input.text)
  const base = {
    id,
    file: input.file,
    origin: input.origin,
    sessionId: input.sessionId,
    kind: input.kind,
    bytes,
    text: input.text,
    ...input.turn === undefined ? {} : { turn: input.turn },
    ...input.entry === undefined ? {} : { entry: input.entry },
    ...input.section === undefined ? {} : { section: input.section },
    ...input.sectionIndex === undefined ? {} : { sectionIndex: input.sectionIndex },
    ...input.entryIndex === undefined ? {} : { entryIndex: input.entryIndex },
  } as const
  if (input.turn === undefined) {
    return {
      ...base,
      class: 'unclassified',
      reason: 'no source turn; ownership cannot be determined',
      disposition: 'discard',
    }
  }
  const classification = classifyMemoryText(input.text)
  if (classification.class !== 'global') {
    return {
      ...base,
      class: classification.class,
      reason: classification.reason,
      disposition: 'discard',
    }
  }
  return {
    ...base,
    class: 'global',
    ...classification.topic === undefined ? {} : { topic: classification.topic },
    reason: classification.reason,
    disposition: 'migrate',
  }
}

/** Scan one legacy file; a parse failure is reported, not thrown. */
async function scanFile(
  workspace: { readonly id: string; readonly directory: string },
  relative: string,
  kind: MigrationFileKind,
  signal: AbortSignal | undefined,
): Promise<ScannedFile> {
  const path = join(workspace.directory, '.dsh', relative)
  const displayPath = `${workspace.id}/.dsh/${relative}`
  const text = await readText(path, signal)
  if (text === undefined) {
    return { path, displayPath, kind, exists: false, entries: 0, bytes: 0, units: [] }
  }
  const bytes = Buffer.byteLength(text, 'utf8')
  if (kind === 'active') {
    let document: MemoryDocument
    try {
      document = parseMemoryDocument(text)
    } catch (error: unknown) {
      if (error instanceof HarnessError) {
        return { path, displayPath, kind, exists: true, entries: 0, bytes, units: [], parseError: error.message }
      }
      throw error
    }
    const units: ScannedUnit[] = []
    for (const [sectionIndex, section] of document.sections.entries()) {
      for (const [entryIndex, entry] of section.entries.entries()) {
        units.push(classifyUnit({
          file: displayPath,
          origin: 'active',
          sessionId: section.sessionId,
          kind: entry.kind,
          turn: entry.turn,
          text: entry.text,
          entry,
          section,
          sectionIndex,
          entryIndex,
        }))
      }
    }
    return { path, displayPath, kind, exists: true, entries: units.length, bytes, units, document }
  }
  let records: readonly MemoryArchiveRecord[]
  try {
    records = parseMemoryArchiveText(text)
  } catch (error: unknown) {
    if (error instanceof HarnessError) {
      return { path, displayPath, kind, exists: true, entries: 0, bytes, units: [], parseError: error.message }
    }
    throw error
  }
  const units = records.map(record => classifyUnit({
    file: displayPath,
    origin: 'archive',
    sessionId: record.sessionId,
    kind: record.kind,
    turn: record.turn,
    text: record.text,
  }))
  return { path, displayPath, kind, exists: true, entries: units.length, bytes, units, archiveRecords: records }
}

/** Count one class. */
function countClass(counts: MigrationClassCounts, unit: ScannedUnit): MigrationClassCounts {
  switch (unit.class) {
    case 'global': return { ...counts, global: counts.global + 1 }
    case 'dispatch': return { ...counts, dispatch: counts.dispatch + 1 }
    case 'business': return { ...counts, business: counts.business + 1 }
    case 'persona': return { ...counts, persona: counts.persona + 1 }
    case 'unclassified': return { ...counts, unclassified: counts.unclassified + 1 }
  }
}

/** Read the journal; a missing or malformed file is an empty journal. */
async function readJournal(path: string): Promise<MigrationJournal> {
  const text = await readText(path)
  if (text === undefined) return { version: 1, units: {}, runs: [] }
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object')
    const record = parsed as Record<string, unknown>
    const units = typeof record['units'] === 'object' && record['units'] !== null
      ? record['units'] as Record<string, JournalUnit>
      : {}
    const runs = Array.isArray(record['runs']) ? record['runs'] as JournalRun[] : []
    return { version: 1, units, runs }
  } catch {
    return { version: 1, units: {}, runs: [] }
  }
}

/** Write the journal after creating its directory. */
async function writeJournal(path: string, journal: MigrationJournal, signal?: AbortSignal): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(journal, null, 2)}\n`, { encoding: 'utf8', ...signal === undefined ? {} : { signal } })
}

/** Mark already-handled units as skipped so a repeated dry run converges. */
function applyJournal(units: readonly ScannedUnit[], journal: MigrationJournal): ScannedUnit[] {
  const seen = new Map<string, ScannedUnit>()
  return units.map((unit) => {
    const handled = journal.units[unit.id]
    if (handled !== undefined) {
      return { ...unit, disposition: 'skip', reason: unit.reason, skipReason: `already handled in run ${handled.runId}` }
    }
    const duplicate = seen.get(unit.id)
    if (duplicate !== undefined) {
      return { ...unit, disposition: 'skip', reason: unit.reason, skipReason: `duplicate of the entry in ${duplicate.file}` }
    }
    seen.set(unit.id, unit)
    return unit
  })
}

/** Hash the canonical plan: no timestamps, no report prose. */
function reportHashOf(input: {
  readonly targetPath: string
  readonly archivePath: string
  readonly files: readonly MigrationFile[]
  readonly units: readonly ScannedUnit[]
}): string {
  const payload = {
    version: REPORT_HASH_VERSION,
    targetPath: input.targetPath,
    archivePath: input.archivePath,
    files: input.files.map(file => ({
      path: file.displayPath,
      kind: file.kind,
      exists: file.exists,
      parseError: file.parseError ?? null,
    })),
    units: input.units.map(unit => ({
      id: unit.id,
      file: unit.file,
      origin: unit.origin,
      sessionId: unit.sessionId,
      kind: unit.kind,
      turn: unit.turn ?? null,
      text: unit.text,
      class: unit.class,
      topic: unit.topic ?? null,
      disposition: unit.disposition,
      reason: unit.reason,
      skipReason: unit.skipReason ?? null,
    })),
  }
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

/** Truncate one report text to the display bound. */
function reportText(text: string): string {
  return text.length <= REPORT_TEXT_MAX_CHARS ? text : `${text.slice(0, REPORT_TEXT_MAX_CHARS - 1)}…`
}

/** Render the human-readable report. */
function renderReport(input: {
  readonly mode: 'dry-run' | 'apply'
  readonly hash: string
  readonly home: string
  readonly targetPath: string
  readonly archivePath: string
  readonly units: readonly MigrationUnit[]
  readonly generatedAt: Date
  readonly summary: MigrationSummary
  readonly files: readonly MigrationFile[]
}): string {
  const lines: string[] = [
    '# Memory migration report',
    '',
    `Mode: ${input.mode === 'dry-run' ? 'dry run — no memory data was written' : 'apply — the report was confirmed and applied'}`,
    `Generated: ${input.generatedAt.toISOString()}`,
    `Report hash: ${input.hash}`,
    `Harness home: ${input.home}`,
    `Global target: ${input.targetPath} (whole-file limit ${String(GLOBAL_MEMORY_MAX_BYTES)} B)`,
    `Global archive: ${input.archivePath}`,
    '',
    '## Summary',
    '',
    `- files: ${String(input.summary.files)}`,
    `- entries: ${String(input.summary.entries)} (${String(input.summary.bytes)} B)`,
    `- migrate: ${String(input.summary.migrate)} (${String(input.summary.migrateBytes)} B)`,
    `- discard: ${String(input.summary.discard)}`,
    `- skip: ${String(input.summary.skip)}`,
    `- classes: global ${String(input.summary.classes.global)}, dispatch ${String(input.summary.classes.dispatch)}, `
    + `business ${String(input.summary.classes.business)}, persona ${String(input.summary.classes.persona)}, `
    + `unclassified ${String(input.summary.classes.unclassified)}`,
    '',
  ]
  const candidates = input.units.filter(unit => unit.disposition === 'migrate')
  lines.push('## Global candidates (confirm this report before applying)', '')
  if (candidates.length === 0) lines.push('(none)', '')
  for (const [index, unit] of candidates.entries()) {
    lines.push(
      `### ${String(index + 1)}. ${unit.file} · ${unit.sessionId} · turn ${String(unit.turn ?? '?')} · ${unit.kind} · ${String(unit.bytes)} B`,
      `- proposed topic: ${unit.topic ?? 'unassigned'}`,
      `- reason: ${unit.reason}`,
      `- text: ${unit.text}`,
      '',
    )
  }
  const discarded = input.units.filter(unit => unit.disposition === 'discard')
  lines.push('## Discarded', '')
  if (discarded.length === 0) lines.push('(none)', '')
  for (const unit of discarded) {
    lines.push(
      `- ${unit.file} · ${unit.sessionId} · turn ${String(unit.turn ?? '?')} · ${unit.kind} · ${String(unit.bytes)} B`
      + ` — ${unit.class}: ${unit.reason}; text: ${reportText(unit.text)}`,
    )
  }
  lines.push('')
  const skipped = input.units.filter(unit => unit.disposition === 'skip')
  lines.push('## Skipped', '')
  if (skipped.length === 0) lines.push('(none)', '')
  for (const unit of skipped) {
    lines.push(`- ${unit.file} · ${unit.id} — ${unit.skipReason ?? 'skipped'}`)
  }
  lines.push('', '## Files', '')
  if (input.files.length === 0) lines.push('(none)', '')
  for (const file of input.files) {
    const state = !file.exists ? 'missing' : file.parseError === undefined ? `${String(file.entries)} entries, ${String(file.bytes)} B` : `unreadable: ${file.parseError}`
    lines.push(`- ${file.displayPath} — ${file.kind}, ${state}`)
  }
  lines.push('')
  return `${lines.join('\n')}\n`
}

/** Build the report by scanning every workspace and applying the journal. */
async function buildReport(options: MemoryMigrationOptions, mode: 'dry-run' | 'apply'): Promise<{
  readonly report: MemoryMigrationReport
  readonly scanned: readonly ScannedFile[]
  readonly journal: MigrationJournal
  readonly journalPath: string
}> {
  const home = homeOf(options)
  const paths = globalPaths(home)
  const now = options.now ?? new Date()
  const workspaces = await resolveWorkspaces(options.workspaces)
  const journal = await readJournal(paths.journalPath)
  const scanned: ScannedFile[] = []
  const allUnits: ScannedUnit[] = []
  for (const workspace of workspaces) {
    for (const [relative, kind] of [[MEMORY_STORE_PATH, 'active'], [MEMORY_ARCHIVE_STORE_PATH, 'archive']] as const) {
      const file = await scanFile(workspace, relative, kind, options.signal)
      const units = applyJournal(file.units, journal)
      scanned.push({ ...file, units })
      allUnits.push(...units)
    }
  }
  const files: MigrationFile[] = scanned.map(file => ({
    path: file.path,
    displayPath: file.displayPath,
    kind: file.kind,
    exists: file.exists,
    entries: file.units.length,
    bytes: file.bytes,
    ...file.parseError === undefined ? {} : { parseError: file.parseError },
  }))
  const counts = allUnits.reduce<MigrationClassCounts>(
    (current, unit) => countClass(current, unit),
    { global: 0, dispatch: 0, business: 0, persona: 0, unclassified: 0 },
  )
  const summary: MigrationSummary = {
    files: files.filter(file => file.exists).length,
    entries: allUnits.length,
    migrate: allUnits.filter(unit => unit.disposition === 'migrate').length,
    discard: allUnits.filter(unit => unit.disposition === 'discard').length,
    skip: allUnits.filter(unit => unit.disposition === 'skip').length,
    bytes: allUnits.reduce((total, unit) => total + unit.bytes, 0),
    migrateBytes: allUnits.filter(unit => unit.disposition === 'migrate').reduce((total, unit) => total + unit.bytes, 0),
    classes: counts,
  }
  const hash = reportHashOf({ targetPath: paths.targetPath, archivePath: paths.archivePath, files, units: allUnits })
  const text = renderReport({
    mode,
    hash,
    home,
    targetPath: paths.targetPath,
    archivePath: paths.archivePath,
    units: allUnits,
    generatedAt: now,
    summary,
    files,
  })
  return {
    report: {
      hash,
      text,
      home,
      targetPath: paths.targetPath,
      archivePath: paths.archivePath,
      mode,
      summary,
      files,
      units: allUnits,
    },
    scanned,
    journal,
    journalPath: paths.journalPath,
  }
}

/**
 * Scan every workspace memory file and produce the dry-run report.
 *
 * Nothing below the harness home or inside a workspace is written: no global
 * file, no archive, no journal, and no backup.
 * @param options - home, workspaces, clock, and cancellation.
 * @returns the report text, its hash, the summary, and every classified unit.
 */
export async function dryRunMemoryMigration(options: MemoryMigrationOptions): Promise<MemoryMigrationReport> {
  const { report } = await buildReport(options, 'dry-run')
  return report
}

/** Build the next active global document from the current one plus confirmed candidates. */
function mergeGlobalCandidates(
  current: GlobalMemoryDocument,
  candidates: readonly ScannedUnit[],
  now: Date,
): { readonly document: GlobalMemoryDocument; readonly archived: readonly GlobalMemoryArchiveEntry[] } {
  const entries = [...current.entries]
  const archived: GlobalMemoryArchiveEntry[] = []
  for (const unit of candidates) {
    const topic = unit.topic
    if (topic === undefined) continue
    const previous = entries.find(entry => entry.topic === topic)
    if (previous !== undefined) {
      archived.push({
        ...previous,
        archivedAt: now.toISOString(),
        reason: 'superseded',
        detail: `a migrated ${topic} entry replaced this one`,
      })
      entries.splice(entries.indexOf(previous), 1)
    }
    const entry: GlobalMemoryEntry = {
      id: globalMemoryEntryId(topic, now.toISOString(), unit.text),
      topic,
      sourceSessionId: unit.sessionId,
      createdAt: now.toISOString(),
      text: unit.text,
    }
    entries.push(entry)
  }
  return { document: { version: current.version + 1, updatedAt: now.toISOString(), entries }, archived }
}

/** Read the active global document, or an empty first revision. */
async function readGlobalDocument(path: string, now: Date, signal?: AbortSignal): Promise<GlobalMemoryDocument> {
  const text = await readText(path, signal)
  return text === undefined ? createGlobalMemoryDocument(now) : parseGlobalMemoryDocument(text)
}

/** Read the global archive, or an empty first revision. */
async function readGlobalArchiveDocument(path: string, now: Date, signal?: AbortSignal): Promise<GlobalMemoryArchiveDocument> {
  const text = await readText(path, signal)
  return text === undefined ? createGlobalArchiveDocument(now) : parseGlobalArchiveDocument(text)
}

/** Copy one existing file to its backup path, creating the parent directory. */
async function backupFile(path: string, backup: string, signal?: AbortSignal): Promise<MigrationBackup> {
  const exists = await readText(path, signal) !== undefined
  if (exists) {
    await mkdir(dirname(backup), { recursive: true })
    await copyFile(path, backup)
  }
  return { path, backup, existed: exists }
}

/** A planned write of one file. */
interface PlannedWrite {
  readonly path: string
  readonly text: string
}

/**
 * Apply a confirmed dry-run report.
 *
 * The report hash is the explicit confirmation: it must equal a fresh scan, so
 * an apply cannot run against files that changed after the person read the
 * report. Every changed file is backed up before the first write, workspace
 * archives are appended before their active file is rewritten, and the run
 * manifest names the backups the rollback restores.
 * @param options - workspaces, home, and the confirmed report hash.
 * @returns the run id, counts, changed files, and backups.
 * @throws MemoryMigrationError `MIGRATION_REPORT_STALE` when the hash does not match a fresh scan.
 */
export async function applyMemoryMigration(options: MemoryMigrationApplyOptions): Promise<MemoryMigrationApplyResult> {
  const home = homeOf(options)
  const paths = globalPaths(home)
  const now = options.now ?? new Date()
  const { report, scanned, journal } = await buildReport(options, 'apply')
  if (report.hash !== options.reportHash) {
    throw new MemoryMigrationError(
      `MIGRATION_REPORT_STALE: the confirmed hash ${JSON.stringify(options.reportHash)} does not match the current report ${JSON.stringify(report.hash)}. `
      + 'Run the dry run again, review the new report, and apply its hash.',
      'MIGRATION_REPORT_STALE',
    )
  }
  if (report.summary.migrate === 0 && report.summary.discard === 0) {
    return {
      runId: '',
      reportHash: report.hash,
      report,
      migrated: 0,
      discarded: 0,
      skipped: report.summary.skip,
      changed: [],
      backups: [],
      runDirectory: '',
    }
  }
  const runId = `${now.toISOString().replaceAll(/[-:.]/gu, '').slice(0, 15)}-${report.hash.slice(0, 8)}`
  const runDirectory = join(paths.runsDirectory, runId)
  const writes: PlannedWrite[] = []
  const handled = scanned.flatMap(file => file.units)
    .filter(unit => unit.disposition === 'migrate' || unit.disposition === 'discard')
  const candidates = handled.filter(unit => unit.disposition === 'migrate')

  // 1. Append archive records to each workspace's archive before rewriting its active file.
  for (const file of scanned) {
    if (file.kind !== 'active' || file.document === undefined) continue
    const removed = handled.filter(unit => unit.origin === 'active' && unit.file === file.displayPath)
    if (removed.length === 0) continue
    const archivePath = join(dirname(file.path), basename(MEMORY_ARCHIVE_STORE_PATH))
    const previous = await readText(archivePath, options.signal)
    const existing = previous === undefined ? [] : parseMemoryArchiveText(previous)
    const records = removed.map(unit => memoryArchiveRecord(
      unit.entry as MemoryEntry,
      unit.section as MemorySection,
      'migration',
      unit.disposition === 'migrate'
        ? `migrated to global memory (${unit.topic ?? 'global'})`
        : `discarded by migration (${unit.class}: ${unit.reason})`,
      now.toISOString(),
    ))
    writes.push({ path: archivePath, text: renderMemoryArchiveText(previous, [...existing, ...records]) })
  }

  // 2. Merge confirmed candidates into the global store; archive entries it replaces.
  if (candidates.length > 0) {
    const currentGlobal = await readGlobalDocument(paths.targetPath, now, options.signal)
    const merged = mergeGlobalCandidates(currentGlobal, candidates, now)
    writes.push({ path: paths.targetPath, text: renderGlobalMemoryDocument(merged.document) })
    if (merged.archived.length > 0) {
      const currentArchive = await readGlobalArchiveDocument(paths.archivePath, now, options.signal)
      writes.push({
        path: paths.archivePath,
        text: renderGlobalArchiveDocument({
          version: currentArchive.version + 1,
          updatedAt: now.toISOString(),
          entries: [...currentArchive.entries, ...merged.archived],
        }),
      })
    }
  }

  // 3. Rewrite each active workspace file with the handled entries removed.
  for (const file of scanned) {
    if (file.kind !== 'active' || file.document === undefined) continue
    const removed = handled.filter(unit => unit.origin === 'active' && unit.file === file.displayPath)
    if (removed.length === 0) continue
    const drop = new Set(removed.map(unit => `${String(unit.sectionIndex)}:${String(unit.entryIndex)}`))
    const sections = file.document.sections.map((section, sectionIndex) => ({
      ...section,
      entries: section.entries.filter((_entry, entryIndex) => !drop.has(`${String(sectionIndex)}:${String(entryIndex)}`)),
    })).filter(section => section.entries.length > 0)
    writes.push({ path: file.path, text: renderMemoryDocument(pruneEmptyMemorySessions({ ...file.document, sections })) })
  }

  // 4. Back up every changed file before the first write; then write.
  const changed = [...new Set(writes.map(write => write.path))]
  const backups: MigrationBackup[] = []
  for (const [index, path] of changed.entries()) {
    backups.push(await backupFile(path, join(runDirectory, 'backups', `${String(index)}-${basename(path)}`), options.signal))
  }
  await mkdir(runDirectory, { recursive: true })
  for (const write of writes) {
    await mkdir(dirname(write.path), { recursive: true })
    await writeFile(write.path, write.text, { encoding: 'utf8' })
  }

  // 5. Record the run and mark each handled unit, so the next dry run converges.
  const at = now.toISOString()
  for (const unit of handled) {
    if (unit.disposition === 'skip') continue
    journal.units[unit.id] = { runId, disposition: unit.disposition, at }
  }
  journal.runs.push({ runId, reportHash: report.hash, at, status: 'applied' })
  await writeJournal(paths.journalPath, journal, options.signal)
  const manifest: MigrationManifest = {
    version: 1,
    runId,
    reportHash: report.hash,
    at,
    status: 'applied',
    migrated: report.summary.migrate,
    discarded: report.summary.discard,
    skipped: report.summary.skip,
    changed,
    backups,
  }
  await writeFile(join(runDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8' })
  await writeFile(join(runDirectory, 'report.md'), report.text, { encoding: 'utf8' })
  return {
    runId,
    reportHash: report.hash,
    report,
    migrated: report.summary.migrate,
    discarded: report.summary.discard,
    skipped: report.summary.skip,
    changed,
    backups,
    runDirectory,
  }
}

/** Read and validate one run manifest. */
async function readManifest(home: string, runId: string): Promise<MigrationManifest> {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new MemoryMigrationError(`run id ${JSON.stringify(runId)} is not a migration run id`, 'MIGRATION_INVALID_RUN_ID')
  }
  const path = join(globalPaths(home).runsDirectory, runId, 'manifest.json')
  const text = await readText(path)
  if (text === undefined) {
    throw new MemoryMigrationError(`migration run ${JSON.stringify(runId)} has no manifest at ${path}`, 'MIGRATION_RUN_NOT_FOUND')
  }
  return JSON.parse(text) as MigrationManifest
}

/**
 * Restore every backup of one applied run.
 *
 * Files the run created are removed; files the run changed are restored byte for
 * byte from their backup. The journal forgets the run's units and marks the run
 * rolled back, so a later dry run reports the original entries again.
 * @param options - home and run id.
 * @returns the restored and removed paths.
 * @throws MemoryMigrationError when the run id is malformed or its manifest is missing.
 */
export async function rollbackMemoryMigration(options: MemoryMigrationRollbackOptions): Promise<MemoryMigrationRollbackResult> {
  const home = homeOf(options)
  const paths = globalPaths(home)
  const manifest = await readManifest(home, options.runId)
  if (manifest.status === 'rolled-back') {
    return { runId: manifest.runId, restored: [], removed: [], alreadyRolledBack: true }
  }
  const restored: string[] = []
  const removed: string[] = []
  for (const backup of [...manifest.backups].reverse()) {
    const bytes = await readText(backup.backup)
    if (backup.existed) {
      if (bytes === undefined) {
        throw new MemoryMigrationError(`backup ${JSON.stringify(backup.backup)} is missing; the run cannot be rolled back`, 'MIGRATION_RUN_NOT_FOUND')
      }
      await mkdir(dirname(backup.path), { recursive: true })
      await writeFile(backup.path, bytes, { encoding: 'utf8' })
      restored.push(backup.path)
    } else {
      await rm(backup.path, { force: true })
      removed.push(backup.path)
    }
  }
  const journal = await readJournal(paths.journalPath)
  journal.units = Object.fromEntries(
    Object.entries(journal.units).filter(([, unit]) => unit.runId !== manifest.runId),
  )
  const run = journal.runs.find(candidate => candidate.runId === manifest.runId)
  if (run !== undefined) run.status = 'rolled-back'
  await writeJournal(paths.journalPath, journal, options.signal)
  manifest.status = 'rolled-back'
  await writeFile(join(paths.runsDirectory, manifest.runId, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8' })
  return { runId: manifest.runId, restored, removed, alreadyRolledBack: false }
}
