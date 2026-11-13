/**
 * Global personality store tests: canonical YAML, validation, the 32 KiB
 * budget, version-guarded upserts, legacy migration (including Windows-safe
 * names and a crash-interrupted move), and first-activation defaults.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { createDshStore } from '@deepseek-ai/dsh-store-atom'
import {
  createPersonalityDocument,
  globalPersonalityPath,
  migrateLegacyPersonality,
  parsePersonalityDocument,
  PERSONALITY_LEGACY_DIR_NAME,
  PERSONALITY_MAX_BODY_BYTES,
  PERSONALITY_MAX_ENTRY_CHARS,
  PersonalityStoreError,
  readGlobalPersonality,
  renderPersonalityDocument,
  upsertGlobalPersonalityEntry,
  writeGlobalPersonality,
} from '../src/global-store.ts'
import type { PersonalityEntry, PersonalityEntryKind } from '../src/global-store.ts'
import {
  DEFAULT_OUTPUT_STYLE_TEXT,
  EMPTY_WRITING_RULES_TEXT,
  seedGlobalPersonalityFiles,
} from '../src/defaults.ts'

let project: string
let ctx: Context

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'dsh-personality-global-'))
  // A `.git` marker makes the fixture look like a checkout, so project-root
  // discovery resolves to the fixture rather than to the temp directory above it.
  await mkdir(join(project, '.git'), { recursive: true })
  vi.stubEnv('DSH_HOME', join(project, 'home'))
  ctx = new Context()
  await ctx.plugin(LocalFileSystem, { cwd: project })
  ctx.provide('dshStore', createDshStore(ctx, false))
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await ctx.fiber.dispose()
  await rm(project, { recursive: true, force: true })
})

/** One entry fixture. */
function entry(kind: PersonalityEntryKind, name: string, text: string): PersonalityEntry {
  return { id: `${kind}.${name}`, kind, text }
}

/** Absolute fixture path of the profile. */
function profilePath(): string {
  return globalPersonalityPath()
}

/** Absolute fixture path of the legacy directory. */
function legacyDirectory(): string {
  return join(dirname(profilePath()), PERSONALITY_LEGACY_DIR_NAME)
}

/** Write arbitrary profile text before a read. */
async function writeProfile(text: string): Promise<void> {
  await mkdir(dirname(profilePath()), { recursive: true })
  await writeFile(profilePath(), text, 'utf8')
}

/** Write a valid document with a fixed timestamp. */
async function seedDocument(entries: readonly PersonalityEntry[]): Promise<void> {
  await writeProfile(renderPersonalityDocument(createPersonalityDocument(entries, new Date('2026-11-13T00:00:00.000Z'))))
}

test('renders the canonical empty document', () => {
  expect(renderPersonalityDocument(createPersonalityDocument([], new Date('2026-11-13T00:00:00.000Z')))).toBe([
    '---',
    'version: 1',
    'updatedAt: 2026-11-13T00:00:00.000Z',
    'entries: []',
    '---',
    '',
  ].join('\n'))
})

test('parses and renders entries in canonical kind and id order', () => {
  const entries = [
    entry('style', 'language', '用中文回答。'),
    entry('understanding', 'role-prefix', '前缀指定执行方。'),
    entry('preference', 'scope', '只做点名对象。'),
  ]
  const document = createPersonalityDocument(entries, new Date('2026-11-13T00:00:00.000Z'))
  expect(parsePersonalityDocument(renderPersonalityDocument(document))).toEqual(document)
  expect(document.entries.map(candidate => candidate.id)).toEqual([
    'understanding.role-prefix',
    'preference.scope',
    'style.language',
  ])
})

test('rejects malformed frontmatter and trailing text', () => {
  expect(() => parsePersonalityDocument('not a profile')).toThrow(/must start with a YAML frontmatter/u)
  expect(() => parsePersonalityDocument('---\nversion: 1\nupdatedAt: 2026-01-01T00:00:00.000Z\nentries: []\n---\nbody\n'))
    .toThrow(/only the YAML frontmatter/u)
  expect(() => parsePersonalityDocument('---\nversion: 0\nupdatedAt: 2026-01-01T00:00:00.000Z\nentries: []\n---\n'))
    .toThrow(/version must be a positive integer/u)
  expect(() => parsePersonalityDocument('---\nversion: 1\nupdatedAt: nope\nentries: []\n---\n'))
    .toThrow(/updatedAt must be a UTC ISO-8601 string/u)
  expect(() => parsePersonalityDocument('---\nversion: 1\nupdatedAt: 2026-01-01T00:00:00.000Z\nentries: nope\n---\n'))
    .toThrow(/entries must be a sequence/u)
})

test('rejects unknown kinds, id mismatches, duplicates, and invalid names', () => {
  const unknown = renderPersonalityDocument(createPersonalityDocument([
    { id: 'bogus.thing', kind: 'bogus' as PersonalityEntryKind, text: 'text' },
  ]))
  expect(() => parsePersonalityDocument(unknown)).toThrow(/unknown personality entry kind/u)
  const mismatch = renderPersonalityDocument(createPersonalityDocument([
    { id: 'style.language', kind: 'preference', text: 'text' },
  ]))
  expect(() => parsePersonalityDocument(mismatch)).toThrow(/does not match id/u)
  const duplicate = renderPersonalityDocument(createPersonalityDocument([
    entry('style', 'language', 'one'),
    entry('style', 'language', 'two'),
  ]))
  expect(() => parsePersonalityDocument(duplicate)).toThrow(/duplicate entry id/u)
  expect(() => parsePersonalityDocument(renderPersonalityDocument(createPersonalityDocument([
    { id: 'style.Bad', kind: 'style', text: 'text' },
  ])))).toThrow(/lower-kebab-case/u)
})

test('rejects malformed ids, non-mapping entries, and invalid YAML', () => {
  expect(() => parsePersonalityDocument('---\nversion: 1\nupdatedAt: 2026-01-01T00:00:00.000Z\nentries:\n  - id: style\n    kind: style\n    text: text\n---\n'))
    .toThrow(/must be "<kind>.<lower-kebab-name>"/u)
  expect(() => parsePersonalityDocument('---\nversion: 1\nupdatedAt: 2026-01-01T00:00:00.000Z\nentries:\n  - just-a-string\n---\n'))
    .toThrow(/must be a mapping/u)
  expect(() => parsePersonalityDocument('---\n: [bad\n---\n')).toThrow(/not valid YAML/u)
  expect(() => parsePersonalityDocument('---\n- item\n---\n')).toThrow(/frontmatter must be a mapping/u)
  expect(() => parsePersonalityDocument('---\nversion: 1\nupdatedAt: 2026-01-01T00:00:00.000Z\nentries:\n  - id: 1\n    kind: style\n    text: text\n---\n'))
    .toThrow(/needs string id, kind, and text/u)
})

test('rejects empty, multi-paragraph, and oversized entries', () => {
  expect(() => parsePersonalityDocument(renderPersonalityDocument(createPersonalityDocument([
    entry('style', 'empty', '   '),
  ])))).toThrow(/must not be empty/u)
  expect(() => parsePersonalityDocument(renderPersonalityDocument(createPersonalityDocument([
    entry('style', 'paragraphs', 'one\n\ntwo'),
  ])))).toThrow(/one paragraph/u)
  expect(() => parsePersonalityDocument(renderPersonalityDocument(createPersonalityDocument([
    entry('style', 'long', 'x'.repeat(PERSONALITY_MAX_ENTRY_CHARS + 1)),
  ])))).toThrow(/over the 400-character limit/u)
})

test('rejects a document over the 32 KiB body budget', () => {
  const entries = Array.from({ length: 100 }, (_, index) => entry('style', `rule-${String(index)}`, 'x'.repeat(400)))
  expect(() => renderPersonalityDocument(createPersonalityDocument(entries))).toThrow(
    new RegExp(`over the ${String(PERSONALITY_MAX_BODY_BYTES)}-byte limit`, 'u'),
  )
})

test('upserts by id, creates the first document, and bumps the revision', async () => {
  expect(await readGlobalPersonality(ctx)).toEqual({ path: profilePath() })
  const first = await upsertGlobalPersonalityEntry(ctx, {
    kind: 'understanding',
    name: 'role-prefix',
    text: '前缀指定执行方。',
  })
  expect(first).toMatchObject({ revision: 1, entry: { id: 'understanding.role-prefix' } })
  const second = await upsertGlobalPersonalityEntry(ctx, {
    kind: 'understanding',
    name: 'role-prefix',
    text: '前缀只指定执行方。',
  })
  expect(second.revision).toBe(2)
  const read = await readGlobalPersonality(ctx)
  expect(read.document?.entries).toEqual([
    { id: 'understanding.role-prefix', kind: 'understanding', text: '前缀只指定执行方。' },
  ])
})

test('refuses identity before any write', async () => {
  const write = vi.spyOn(ctx.dshStore, 'writeFile')
  await expect(upsertGlobalPersonalityEntry(ctx, {
    kind: 'identity',
    name: 'role',
    text: '独立开发者。',
  })).rejects.toMatchObject({ code: 'identity-manual' })
  expect(write).not.toHaveBeenCalled()
})

test('rejects an unknown input kind before any read', async () => {
  await expect(upsertGlobalPersonalityEntry(ctx, {
    kind: 'bogus' as PersonalityEntryKind,
    name: 'role',
    text: 'text',
  })).rejects.toMatchObject({ code: 'unknown-kind' })
})

test('surfaces a non-stale write failure without retrying', async () => {
  await seedDocument([entry('style', 'language', '旧文本。')])
  const write = vi.spyOn(ctx.dshStore, 'writeFile').mockRejectedValue(new FsError('io', 'FS_IO_ERROR'))
  await expect(upsertGlobalPersonalityEntry(ctx, {
    kind: 'style',
    name: 'language',
    text: '新文本。',
  })).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
  expect(write).toHaveBeenCalledTimes(1)
})

test('retries one stale write after a re-read', async () => {
  await seedDocument([entry('style', 'language', '旧文本。')])
  const original = ctx.dshStore.writeFile.bind(ctx.dshStore)
  const write = vi.spyOn(ctx.dshStore, 'writeFile')
    .mockRejectedValueOnce(new FsError('stale', 'FS_STALE_VERSION'))
    .mockImplementation(original as never)
  const result = await upsertGlobalPersonalityEntry(ctx, {
    kind: 'style',
    name: 'language',
    text: '新文本。',
  })
  expect(result.revision).toBe(2)
  expect(write).toHaveBeenCalledTimes(2)
})

test('migrates the old profile to a Windows-safe legacy name', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-13T21:49:40.000Z'))
  await writeProfile('old profile')
  const result = await migrateLegacyPersonality(ctx)
  expect(result).toEqual({
    status: 'moved',
    legacyPath: join(legacyDirectory(), 'PERSONALITY.20261113T214940Z.md'),
  })
  if (result.status !== 'moved') throw new Error('expected a move')
  expect(await readFile(result.legacyPath, 'utf8')).toBe('old profile')
  await expect(stat(profilePath())).rejects.toThrow()
})

test('adds a suffix when the legacy name is occupied', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-13T21:49:40.000Z'))
  await mkdir(legacyDirectory(), { recursive: true })
  await writeFile(join(legacyDirectory(), 'PERSONALITY.20261113T214940Z.md'), 'occupied', 'utf8')
  await writeProfile('old profile')
  const result = await migrateLegacyPersonality(ctx)
  expect(result.status).toBe('moved')
  if (result.status !== 'moved') throw new Error('expected a move')
  expect(basename(result.legacyPath)).toBe('PERSONALITY.20261113T214940Z-1.md')
})

test('finishes a crash-interrupted move when a legacy copy is identical', async () => {
  await mkdir(legacyDirectory(), { recursive: true })
  await writeFile(join(legacyDirectory(), 'PERSONALITY.20260101T000000Z.md'), 'old profile', 'utf8')
  await writeProfile('old profile')
  const result = await migrateLegacyPersonality(ctx)
  expect(result).toEqual({
    status: 'already-migrated',
    legacyPath: join(legacyDirectory(), 'PERSONALITY.20260101T000000Z.md'),
  })
  await expect(stat(profilePath())).rejects.toThrow()
})

test('falls back to copy, verify, and delete when move is unsupported', async () => {
  vi.spyOn(ctx.fs, 'moveFile').mockRejectedValue(new FsError('move unsupported', 'FS_IO_ERROR'))
  await writeProfile('old profile')
  const result = await migrateLegacyPersonality(ctx)
  expect(result.status).toBe('moved')
  await expect(stat(profilePath())).rejects.toThrow()
})

test('reports a move that published the destination but retained the source', async () => {
  vi.spyOn(ctx.fs, 'moveFile').mockResolvedValue({
    sourceBefore: null,
    destination: { operation: 'create', version: 'v1', before: null, after: 'old profile' },
    sourceDeleted: false,
    sourceFailure: { code: 'FS_IO_ERROR', message: 'remove failed' },
  } as never)
  await writeProfile('old profile')
  await expect(migrateLegacyPersonality(ctx)).rejects.toMatchObject({ code: 'legacy-conflict' })
})

test('rethrows a non-filesystem move failure', async () => {
  vi.spyOn(ctx.fs, 'moveFile').mockRejectedValue(new Error('boom'))
  await writeProfile('old profile')
  await expect(migrateLegacyPersonality(ctx)).rejects.toThrow(/boom/u)
})

test('reports a full set of legacy names', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-13T21:49:40.000Z'))
  await mkdir(legacyDirectory(), { recursive: true })
  for (let suffix = 0; suffix < 10; suffix += 1) {
    const name = suffix === 0 ? 'PERSONALITY.20261113T214940Z.md' : `PERSONALITY.20261113T214940Z-${String(suffix)}.md`
    await writeFile(join(legacyDirectory(), name), `occupied-${String(suffix)}`, 'utf8')
  }
  await writeProfile('old profile')
  await expect(migrateLegacyPersonality(ctx)).rejects.toMatchObject({ code: 'legacy-conflict' })
})

test('reports a copy verification mismatch and a retained source after copy', async () => {
  vi.spyOn(ctx.fs, 'moveFile').mockRejectedValue(new FsError('move unsupported', 'FS_IO_ERROR'))
  const readText = vi.spyOn(ctx.fs, 'readText')
    .mockResolvedValueOnce('old profile')
    .mockResolvedValueOnce('old profile')
    .mockResolvedValueOnce('different')
  await writeProfile('old profile')
  await expect(migrateLegacyPersonality(ctx)).rejects.toMatchObject({ code: 'legacy-conflict' })
  readText.mockRestore()
  await rm(legacyDirectory(), { recursive: true, force: true })

  vi.spyOn(ctx.fs, 'deleteFile').mockRejectedValue(new FsError('delete failed', 'FS_IO_ERROR'))
  await expect(migrateLegacyPersonality(ctx)).rejects.toMatchObject({ code: 'legacy-conflict' })
})

test('reports absent and non-file legacy sources', async () => {
  expect(await migrateLegacyPersonality(ctx)).toEqual({ status: 'absent' })
  await mkdir(profilePath(), { recursive: true })
  await expect(migrateLegacyPersonality(ctx)).rejects.toBeInstanceOf(PersonalityStoreError)
})

test('seeds the two configuration files once and never overwrites them', async () => {
  const first = await seedGlobalPersonalityFiles(ctx, new AbortController().signal)
  expect(first.created).toEqual(['personality/OUTPUT_STYLE.yaml', 'personality/WRITING_RULES.yaml'])
  expect(await readFile(join(dirname(profilePath()), 'OUTPUT_STYLE.yaml'), 'utf8')).toBe(DEFAULT_OUTPUT_STYLE_TEXT)
  expect(await readFile(join(dirname(profilePath()), 'WRITING_RULES.yaml'), 'utf8')).toBe(EMPTY_WRITING_RULES_TEXT)
  const second = await seedGlobalPersonalityFiles(ctx)
  expect(second.created).toEqual([])
})

test('propagates an abort signal through read and upsert', async () => {
  const signal = new AbortController().signal
  expect(await readGlobalPersonality(ctx, signal)).toEqual({ path: profilePath() })
  const result = await upsertGlobalPersonalityEntry(ctx, {
    kind: 'preference',
    name: 'scope',
    text: '只做点名对象。',
  }, signal)
  expect(result.revision).toBe(1)
})

test('returns a write result without a store version', async () => {
  vi.spyOn(ctx.dshStore, 'writeFile').mockResolvedValueOnce({ path: 'unused', version: undefined } as never)
  const written = await writeGlobalPersonality(ctx, createPersonalityDocument(), undefined, new AbortController().signal)
  expect(written.version).toBeUndefined()
})

test('continues after a create-if-absent race on the legacy destination', async () => {
  const original = ctx.fs.moveFile.bind(ctx.fs)
  vi.spyOn(ctx.fs, 'moveFile')
    .mockRejectedValueOnce(new FsError('destination appeared', 'FS_NOT_OBSERVED'))
    .mockImplementation(original as never)
  await writeProfile('old profile')
  const result = await migrateLegacyPersonality(ctx, new AbortController().signal)
  expect(result.status).toBe('moved')
  if (result.status !== 'moved') throw new Error('expected a move')
  expect(basename(result.legacyPath)).toMatch(/-1\.md$/u)
})

test('ignores non-matching and non-file entries while finding an identical legacy copy', async () => {
  await mkdir(legacyDirectory(), { recursive: true })
  await mkdir(join(legacyDirectory(), 'a-directory'), { recursive: true })
  await writeFile(join(legacyDirectory(), 'notes.txt'), 'not a legacy profile', 'utf8')
  await writeFile(join(legacyDirectory(), 'PERSONALITY.20260101T000000Z.md'), 'old profile', 'utf8')
  await writeProfile('old profile')
  expect((await migrateLegacyPersonality(ctx, new AbortController().signal)).status).toBe('already-migrated')
})

test('reads a profile whose store version is absent', async () => {
  await seedDocument([entry('style', 'language', '用中文回答。')])
  vi.spyOn(ctx.dshStore, 'readFile').mockResolvedValueOnce({
    path: profilePath(),
    text: renderPersonalityDocument(createPersonalityDocument([])),
  } as never)
  expect((await readGlobalPersonality(ctx)).version).toBeUndefined()
})

test('upserts when the store returns no version', async () => {
  vi.spyOn(ctx.dshStore, 'writeFile').mockResolvedValueOnce({ path: 'unused', version: undefined } as never)
  const result = await upsertGlobalPersonalityEntry(ctx, {
    kind: 'style',
    name: 'language',
    text: '用中文回答。',
  })
  expect(result.version).toBeUndefined()
})

test('seeds a missing file without a signal', async () => {
  await rm(join(dirname(profilePath()), 'OUTPUT_STYLE.yaml'), { force: true })
  const result = await seedGlobalPersonalityFiles(ctx)
  expect(result.created).toEqual(['personality/OUTPUT_STYLE.yaml', 'personality/WRITING_RULES.yaml'])
})

test('skips an unreadable legacy candidate when a later copy matches', async () => {
  await mkdir(legacyDirectory(), { recursive: true })
  await writeFile(join(legacyDirectory(), 'PERSONALITY.000.bad.md'), 'unreadable', 'utf8')
  await writeFile(join(legacyDirectory(), 'PERSONALITY.20260101T000000Z.md'), 'old profile', 'utf8')
  const original = ctx.fs.readText.bind(ctx.fs)
  vi.spyOn(ctx.fs, 'readText').mockImplementation(async (target, signal) => {
    if (target.displayPath.endsWith('PERSONALITY.000.bad.md')) throw new FsError('unreadable', 'FS_IO_ERROR')
    return await original(target, signal)
  })
  await writeProfile('old profile')
  expect((await migrateLegacyPersonality(ctx)).status).toBe('already-migrated')
})
