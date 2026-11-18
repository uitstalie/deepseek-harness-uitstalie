/**
 * One-time migration tests over a temporary `$DSH_HOME` and temporary
 * workspaces: the dry-run report and its hash, the refusal of a stale hash,
 * apply with backups, the old-format readability of a rewritten file, and a
 * rollback that makes the next dry run reproduce the first report.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderMemoryArchiveText } from '../src/archive.ts'
import { parseGlobalArchiveDocument, parseGlobalMemoryDocument } from '../src/global-memory.ts'
import {
  MEMORY_ARCHIVE_STORE_PATH,
  MEMORY_STORE_PATH,
  createMemoryDocument,
  memoryArchiveRecord,
  parseMemoryDocument,
  renderMemoryDocument,
} from '../src/memory-file.ts'
import type { MemoryDocument, MemoryEntry, MemorySection } from '../src/memory-file.ts'
import {
  MemoryMigrationError,
  applyMemoryMigration,
  dryRunMemoryMigration,
  rollbackMemoryMigration,
} from '../src/migration.ts'

/** A commit-shaped token built at runtime; maintained test sources carry no commit identifier. */
const COMMIT_LIKE = createHash('sha256').update('memory-test-fixture').digest('hex').slice(0, 10)

let root: string
let first: string
let second: string
let activeOne: string
let activeTwo: string
let archiveOne: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-memory-migration-'))
  vi.stubEnv('DSH_HOME', join(root, 'home'))
  first = join(root, 'workspace-one')
  second = join(root, 'workspace-two')
  await mkdir(join(first, '.git'), { recursive: true })
  await mkdir(join(second, '.git'), { recursive: true })
  activeOne = join(first, '.dsh', MEMORY_STORE_PATH)
  activeTwo = join(second, '.dsh', MEMORY_STORE_PATH)
  archiveOne = join(first, '.dsh', MEMORY_ARCHIVE_STORE_PATH)
  await mkdir(join(first, '.dsh', 'memory', 'sessions'), { recursive: true })
  await mkdir(join(second, '.dsh', 'memory', 'sessions'), { recursive: true })
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

/** One entry fixture. */
function entry(kind: MemoryEntry['kind'], text: string, turn?: number): MemoryEntry {
  return { kind, text, ...turn === undefined ? {} : { turn } }
}

/** One section fixture. */
function section(sessionId: string, entries: readonly MemoryEntry[]): MemorySection {
  return { sessionId, startTurn: 1, endTurn: 9, tier: 'detail', entries }
}

/** Write one legacy document. */
async function seedActive(path: string, sections: readonly MemorySection[]): Promise<void> {
  const document: MemoryDocument = {
    ...createMemoryDocument(),
    sessions: [{ id: 'session-one', cwd: first, updatedAt: '2026-01-01T00:00:00.000Z', turns: [] }],
    sections,
  }
  await writeFile(path, renderMemoryDocument(document), 'utf8')
}

/** Write one legacy archive. */
async function seedArchive(path: string, records: readonly ReturnType<typeof memoryArchiveRecord>[]): Promise<void> {
  await writeFile(path, renderMemoryArchiveText(undefined, records), 'utf8')
}

/** Seed both workspaces with the same fixture set. */
async function seedFixtures(): Promise<void> {
  await seedActive(activeOne, [section('session-one', [
    entry('decision', 'The shared build server is reachable as server alpha.', 3),
    entry('decision', 'Always run the type check before pushing a change.', 4),
    entry('decision', `The commit ${COMMIT_LIKE} fixed the workspace layout.`, 5),
    entry('open', 'Dispatched the task to session memory-worker; waiting for the receipt.', 6),
    entry('preference', 'The user prefers a calm tone of voice.', 7),
    entry('files', 'Blue is a pleasing colour.', 8),
    entry('decision', 'An entry with no source turn.', undefined),
  ])])
  const businessRecord = memoryArchiveRecord(
    entry('decision', 'The analysis found the mirror is slow.', 2),
    section('session-one', []),
    'manual-forget',
    'removed by memory_forget',
    '2026-01-02T00:00:00.000Z',
  )
  const globalRecord = memoryArchiveRecord(
    entry('decision', 'The shared package registry is the internal host address.', 5),
    section('session-one', []),
    'manual-forget',
    'removed by memory_forget',
    '2026-01-02T00:00:00.000Z',
  )
  await seedArchive(archiveOne, [businessRecord, globalRecord])
  await seedActive(activeTwo, [section('session-two', [
    entry('decision', 'Always run the type check before pushing a change.', 4),
  ])])
}

/** Scan options for the fixture. */
function options(): { workspaces: readonly { directory: string }[] } {
  return { workspaces: [{ directory: first }, { directory: second }] }
}

test('the dry run reports files, entries, classes, bytes, and the target without writing data', async () => {
  await seedFixtures()
  const report = await dryRunMemoryMigration(options())

  expect(report.mode).toBe('dry-run')
  expect(report.hash).toMatch(/^[0-9a-f]{64}$/u)
  expect(report.targetPath).toBe(join(root, 'home', 'memory', 'GLOBAL.md'))
  expect(report.text).toContain('# Memory migration report')
  expect(report.text).toContain('Mode: dry run — no memory data was written')
  expect(report.text).toContain(`Report hash: ${report.hash}`)
  expect(report.text).toContain(`Global target: ${report.targetPath}`)
  expect(report.text).toContain('## Global candidates (confirm this report before applying)')
  expect(report.text).toContain('proposed topic: global-server')
  expect(report.text).toContain('proposed topic: global-convention')
  expect(report.text).toContain('## Discarded')
  expect(report.text).toContain('business: a commit hash')
  expect(report.text).toContain('dispatch: ')
  expect(report.text).toContain('persona: ')
  expect(report.text).toContain('## Skipped')
  expect(report.text).toContain('## Files')
  expect(report.text).toContain('workspace-one/.dsh/memory/sessions/MEMORY.md — active')
  expect(report.summary).toMatchObject({ entries: 10, migrate: 4, discard: 6, skip: 0 })
  expect(report.summary.classes).toMatchObject({ global: 4, dispatch: 1, business: 2, persona: 1, unclassified: 2 })
  expect(report.summary.bytes).toBeGreaterThan(report.summary.migrateBytes)
  expect(report.summary.migrateBytes).toBeGreaterThan(0)

  // The dry run wrote no global file, no journal, and no backup directory.
  await expect(access(join(root, 'home', 'memory'))).rejects.toThrow()
  expect(await readFile(activeOne, 'utf8')).toContain('The shared build server')
  expect(await readFile(activeTwo, 'utf8')).toContain('Always run the type check')
})

test('apply refuses a report hash from another scan', async () => {
  await seedFixtures()
  const error = await applyMemoryMigration({ ...options(), reportHash: 'deadbeef' }).catch((failure: unknown) => failure)
  expect(error).toBeInstanceOf(MemoryMigrationError)
  expect((error as MemoryMigrationError).code).toBe('MIGRATION_REPORT_STALE')
  await expect(access(join(root, 'home', 'memory'))).rejects.toThrow()
})

test('apply migrates only confirmed global entries, backs up every changed file, and keeps old files parseable', async () => {
  await seedFixtures()
  const firstReport = await dryRunMemoryMigration(options())
  const originalActiveOne = await readFile(activeOne, 'utf8')
  const originalArchiveOne = await readFile(archiveOne, 'utf8')
  const originalActiveTwo = await readFile(activeTwo, 'utf8')

  const applied = await applyMemoryMigration({ ...options(), reportHash: firstReport.hash })
  expect(applied.migrated).toBe(4)
  expect(applied.discarded).toBe(6)
  expect(applied.skipped).toBe(0)
  expect(applied.runId).not.toBe('')

  // The global file holds exactly the latest confirmed entry per topic and no discarded text.
  const globalPath = join(root, 'home', 'memory', 'GLOBAL.md')
  const globalArchivePath = join(root, 'home', 'memory', 'GLOBAL.archive.md')
  const globalText = await readFile(globalPath, 'utf8')
  expect(parseGlobalMemoryDocument(globalText).entries).toMatchObject([
    { topic: 'global-server', text: 'The shared package registry is the internal host address.' },
    { topic: 'global-convention', text: 'Always run the type check before pushing a change.' },
  ])
  expect(parseGlobalArchiveDocument(await readFile(globalArchivePath, 'utf8')).entries
    .map(item => item.text).sort()).toEqual([
    'Always run the type check before pushing a change.',
    'The shared build server is reachable as server alpha.',
  ])
  expect(globalText).not.toContain(`The commit ${COMMIT_LIKE}`)
  expect(globalText).not.toContain('Dispatched the task')
  expect(globalText).not.toContain('calm tone of voice')
  expect(globalText).not.toContain('Blue is a pleasing colour')
  expect(globalText).not.toContain('no source turn')
  expect(globalText).not.toContain('The analysis found the mirror')

  // Every changed file has a backup equal to its pre-apply bytes.
  expect(applied.backups.length).toBe(applied.changed.length)
  const archiveTwo = join(second, '.dsh', MEMORY_ARCHIVE_STORE_PATH)
  expect(applied.backups.map(backup => backup.path).sort())
    .toEqual([activeOne, archiveOne, activeTwo, archiveTwo, globalPath, globalArchivePath].sort())
  const originals = new Map([
    [activeOne, originalActiveOne],
    [archiveOne, originalArchiveOne],
    [activeTwo, originalActiveTwo],
  ])
  for (const backup of applied.backups) {
    expect(backup.existed).toBe(originals.has(backup.path))
    if (backup.existed) {
      expect(await readFile(backup.backup, 'utf8')).toBe(originals.get(backup.path))
    }
  }

  // The rewritten legacy file keeps the version-1 shape and parses with the same parser.
  const rewrittenActive = await readFile(activeOne, 'utf8')
  const parsedActive = parseMemoryDocument(rewrittenActive)
  expect(parsedActive.version).toBe(1)
  expect(parsedActive.sections.flatMap(item => item.entries)).toEqual([])
  expect(rewrittenActive).toContain('<!-- memory:begin -->')

  // Discarded entries are archived with the migration reason before the active file is rewritten.
  const rewrittenArchive = await readFile(archiveOne, 'utf8')
  expect(rewrittenArchive).toContain(`The commit ${COMMIT_LIKE}`)
  expect(rewrittenArchive).toContain('"reason":"migration"')
  expect(rewrittenArchive).toContain('The shared build server')

  // A second dry run converges: every surviving unit is skipped by the journal.
  const after = await dryRunMemoryMigration(options())
  expect(after.summary.migrate).toBe(0)
  expect(after.summary.discard).toBe(0)
  expect(after.summary.skip).toBeGreaterThan(0)
  expect(after.hash).not.toBe(firstReport.hash)
})

test('rollback restores the exact original bytes and makes the first report reproducible', async () => {
  await seedFixtures()
  const firstReport = await dryRunMemoryMigration(options())
  const originalActiveOne = await readFile(activeOne, 'utf8')
  const originalArchiveOne = await readFile(archiveOne, 'utf8')
  const originalActiveTwo = await readFile(activeTwo, 'utf8')
  const applied = await applyMemoryMigration({ ...options(), reportHash: firstReport.hash })

  const rolled = await rollbackMemoryMigration({ runId: applied.runId })
  expect(rolled.alreadyRolledBack).toBe(false)
  expect([...rolled.restored].sort()).toEqual([activeOne, archiveOne, activeTwo].sort())
  expect(rolled.removed).toContain(join(root, 'home', 'memory', 'GLOBAL.md'))
  expect(rolled.removed).toContain(join(root, 'home', 'memory', 'GLOBAL.archive.md'))
  expect(rolled.removed).toContain(join(second, '.dsh', MEMORY_ARCHIVE_STORE_PATH))
  expect(await readFile(activeOne, 'utf8')).toBe(originalActiveOne)
  expect(await readFile(archiveOne, 'utf8')).toBe(originalArchiveOne)
  expect(await readFile(activeTwo, 'utf8')).toBe(originalActiveTwo)
  expect(parseMemoryDocument(await readFile(activeOne, 'utf8')).sections
    .flatMap(item => item.entries).map(item => item.text)).toContain('The shared build server is reachable as server alpha.')

  const again = await dryRunMemoryMigration(options())
  expect(again.hash).toBe(firstReport.hash)
  expect(again.summary).toMatchObject({ migrate: 4, discard: 6, skip: 0 })

  // A second rollback is an idempotent report, not a second restore.
  const twice = await rollbackMemoryMigration({ runId: applied.runId })
  expect(twice.alreadyRolledBack).toBe(true)
  expect(await stat(join(root, 'home', 'memory', 'migration', 'journal.json'))).toBeDefined()
})

test('an unreadable legacy file is reported and left untouched', async () => {
  await writeFile(activeOne, 'not a memory document', 'utf8')
  const report = await dryRunMemoryMigration(options())
  expect(report.text).toContain('unreadable:')
  expect(report.summary.entries).toBe(0)
  const applied = await applyMemoryMigration({ ...options(), reportHash: report.hash })
  expect(applied.runId).toBe('')
  expect(applied.changed).toEqual([])
  await expect(access(join(root, 'home', 'memory'))).rejects.toThrow()
  expect(await readFile(activeOne, 'utf8')).toBe('not a memory document')
})
