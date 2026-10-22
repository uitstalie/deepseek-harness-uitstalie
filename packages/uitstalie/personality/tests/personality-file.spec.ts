/**
 * PERSONALITY.md repository tests: canonical rendering, parse/render round
 * trips, hand-written text preservation, the merge by entry id, the overlay
 * kind restriction, version-guarded writes with history lines, and the body
 * budget.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createDshStore } from '@deepseek-ai/dsh-tool-dsh-store'
import { resolveConfig } from '../src/config.ts'
import type { PersonalitySettings } from '../src/config.ts'
import {
  createPersonalityDocument,
  mergePersonalityEntries,
  parsePersonalityDocument,
  PERSONALITY_BLOCK_BEGIN,
  PERSONALITY_BLOCK_END,
  PERSONALITY_FILE_NAME,
  PERSONALITY_HISTORY_FILE_NAME,
  PERSONALITY_STORE_PATH,
  readPersonality,
  renderPersonalityBlock,
  renderPersonalityDocument,
  writePersonalityEntry,
} from '../src/personality-file.ts'
import type { PersonalityDocument, PersonalityEntry, PersonalityEntryKind } from '../src/personality-file.ts'

let project: string
let ctx: Context
let session: Session
let settings: PersonalitySettings

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'dsh-personality-file-'))
  // A `.git` marker makes the fixture look like a checkout, so project-root
  // discovery resolves to the fixture rather than to the temp directory above it.
  await mkdir(join(project, '.git'), { recursive: true })
  ctx = new Context()
  await ctx.plugin(LocalFileSystem, { cwd: project })
  ctx.provide('dshStore', createDshStore(ctx, false))
  const id = SessionId('session-a')
  session = Session.create(id, undefined, {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 0,
    isSeeded: false,
    cwd: project,
  })
  settings = resolveConfig({ globalPath: join(project, 'home', 'personality', PERSONALITY_FILE_NAME) })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await ctx.fiber.dispose()
  await rm(project, { recursive: true, force: true })
})

/** Build one entry from its parts. */
function entry(kind: PersonalityEntryKind, name: string, text: string): PersonalityEntry {
  return { id: `${kind}.${name}`, kind, name, text }
}

/** Build a document with fixed update time so round trips are comparable. */
function documentWith(entries: readonly PersonalityEntry[], version = 2): PersonalityDocument {
  return {
    version,
    updatedAt: '2026-10-21T00:00:00.000Z',
    entries,
    frame: { before: '\n', after: '\n' },
  }
}

/** Write the global profile before a read. */
async function seedGlobal(entries: readonly PersonalityEntry[]): Promise<string> {
  const text = renderPersonalityDocument(documentWith(entries))
  await mkdir(dirname(settings.globalPath), { recursive: true })
  await writeFile(settings.globalPath, text, 'utf8')
  return text
}

/** Write the workspace overlay before a read. */
async function seedWorkspace(entries: readonly PersonalityEntry[]): Promise<void> {
  await ctx.dshStore.writeFile(session, PERSONALITY_STORE_PATH, renderPersonalityDocument(documentWith(entries)))
}

/** Text of one inserted entry, so parse-only cases share the same fixture. */
function withEntry(id: string, text = 'text'): string {
  const empty = renderPersonalityDocument(createPersonalityDocument())
  return empty.replace(PERSONALITY_BLOCK_END, `\n\n## ${id}\n${text}\n\n${PERSONALITY_BLOCK_END}`)
}

test('a canonical empty document carries the pinned frontmatter and markers', () => {
  const document = createPersonalityDocument()
  expect(renderPersonalityDocument(document)).toBe([
    '---',
    'version: 1',
    `updatedAt: ${document.updatedAt}`,
    'entries: 0',
    '---',
    '',
    PERSONALITY_BLOCK_BEGIN,
    '',
    PERSONALITY_BLOCK_END,
    '',
  ].join('\n'))
})

test('parse and render round-trip the file byte for byte and preserve outside text', () => {
  const document = documentWith([
    entry('style', 'language', '用中文回答；代码、命令、路径保持英文原文。'),
    entry('preference', 'workflow', '改代码前先读现有实现。'),
  ])
  const block = renderPersonalityBlock(document.entries)
  const text = `${renderPersonalityDocument(document).replace(block, `Hand-written lead.\n\n${block}`)}Trailing note.\n`

  const parsed = parsePersonalityDocument(text)
  expect(parsed.entries).toEqual(document.entries)
  expect(parsed.frame.before).toContain('Hand-written lead.')
  expect(parsed.frame.after).toBe('\nTrailing note.\n')
  expect(renderPersonalityDocument(parsed)).toBe(text)
})

test('parse recovers the revision, update time, and every entry', () => {
  const document = documentWith([
    entry('identity', 'role', '独立开发者。'),
    entry('understanding', 'terse', '常用短句表达。'),
    entry('style', 'language', '用中文回答。'),
    entry('preference', 'workflow', '先读现有实现。'),
  ], 7)
  expect(parsePersonalityDocument(renderPersonalityDocument(document))).toEqual(document)
})

test('an unknown kind rejects with the valid list and a bad name rejects as malformed', () => {
  expect(() => parsePersonalityDocument(withEntry('bogus.thing')))
    .toThrow(/valid kinds: understanding, style, preference, identity/)
  expect(() => parsePersonalityDocument(withEntry('style.Bad-Name')))
    .toThrow(/"<kind>.<lower-kebab-name>"/)
  expect(() => parsePersonalityDocument(withEntry('style.answer--shape')))
    .toThrow(/"<kind>.<lower-kebab-name>"/)
})

test('the frontmatter entry count is informational and re-rendered from the entries', () => {
  const text = renderPersonalityDocument(documentWith([entry('style', 'language', '用中文回答。')]))
    .replace('entries: 1', 'entries: 9')
  const parsed = parsePersonalityDocument(text)
  expect(parsed.entries).toHaveLength(1)
  expect(renderPersonalityDocument(parsed)).toContain('entries: 1\n')
})

test('merge replaces a global entry by id and appends a new overlay entry', () => {
  const merged = mergePersonalityEntries(
    [entry('style', 'language', '旧文本。'), entry('preference', 'workflow', '先读现有实现。')],
    [entry('style', 'language', '新文本。'), entry('preference', 'extra', '只在项目里使用的偏好。')],
  )
  expect(merged.map(candidate => [candidate.id, candidate.text])).toEqual([
    ['style.language', '新文本。'],
    ['preference.workflow', '先读现有实现。'],
    ['preference.extra', '只在项目里使用的偏好。'],
  ])
})

test('the workspace overlay rejects identity entries and merges the allowed kinds', async () => {
  await seedGlobal([entry('style', 'language', '全局文本。'), entry('preference', 'workflow', '全局工作习惯。')])
  await seedWorkspace([entry('style', 'language', '工作区文本。'), entry('preference', 'extra', '工作区偏好。')])

  const read = await readPersonality(ctx, session, settings)
  expect(read.entries.map(candidate => [candidate.id, candidate.text])).toEqual([
    ['style.language', '工作区文本。'],
    ['preference.workflow', '全局工作习惯。'],
    ['preference.extra', '工作区偏好。'],
  ])

  await seedWorkspace([entry('identity', 'role', '不应出现在工作区。')])
  await expect(readPersonality(ctx, session, settings)).rejects.toMatchObject({
    code: 'workspace-kind-not-allowed',
  })
})

test('an identity write is rejected before any filesystem call', async () => {
  const resolve = vi.spyOn(ctx.fs, 'resolve')
  const write = vi.spyOn(ctx.fs, 'writeText')

  await expect(writePersonalityEntry(ctx, session, entry('identity', 'role', '开发者。'), {
    settings,
    source: 'user',
  })).rejects.toMatchObject({ code: 'identity-manual' })

  expect(resolve).not.toHaveBeenCalled()
  expect(write).not.toHaveBeenCalled()
})

test('a global write replaces only the managed block and appends one history line', async () => {
  const seed = await seedGlobal([entry('style', 'language', '旧文本。')])
  const seeded = seed.replace(PERSONALITY_BLOCK_BEGIN, `Hand-written lead.\n\n${PERSONALITY_BLOCK_BEGIN}`)
  await writeFile(settings.globalPath, seeded, 'utf8')

  const written = await writePersonalityEntry(ctx, session, entry('understanding', 'terse', '用户常用短句。'), {
    settings,
    source: 'user',
  })

  expect(written).toMatchObject({ path: settings.globalPath, revision: 3 })
  expect(written.entry).toEqual(entry('understanding', 'terse', '用户常用短句。'))
  const text = await readFile(settings.globalPath, 'utf8')
  expect(text).toContain('Hand-written lead.')
  expect(text).toContain('## style.language\n旧文本。')
  expect(text).toContain('## understanding.terse\n用户常用短句。')
  expect(text.startsWith('---\nversion: 3\n')).toBe(true)
  expect(parsePersonalityDocument(text).entries.map(candidate => candidate.id))
    .toEqual(['style.language', 'understanding.terse'])

  const history = await readFile(join(dirname(settings.globalPath), PERSONALITY_HISTORY_FILE_NAME), 'utf8')
  const lines = history.trimEnd().split('\n')
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('"version":3')
  expect(lines[0]).toContain('"source":"user"')
  expect(lines[0]).toContain('"session":"session-a"')
  expect(lines[0]).toContain('"id":"understanding.terse"')
  expect(lines[0]).toContain('"change":"added"')
  expect(lines[0]).toContain('## understanding.terse')
})

test('a style write goes to the workspace overlay, which owns its own history', async () => {
  const written = await writePersonalityEntry(ctx, session, entry('style', 'language', '用中文回答。'), {
    settings,
    source: 'auto',
  })

  expect(written.path).toBe(PERSONALITY_STORE_PATH)
  const text = await readFile(join(project, '.dsh', 'memory', PERSONALITY_FILE_NAME), 'utf8')
  expect(text).toContain('## style.language\n用中文回答。')
  const history = await readFile(join(project, '.dsh', 'memory', PERSONALITY_HISTORY_FILE_NAME), 'utf8')
  expect(history).toContain('"source":"auto"')
  await expect(stat(settings.globalPath)).rejects.toThrow()
})

test('a disabled overlay sends style writes to the global file', async () => {
  const globalOnly = resolveConfig({
    globalPath: settings.globalPath,
    workspaceOverlay: false,
  })
  const written = await writePersonalityEntry(ctx, session, entry('preference', 'workflow', '先读现有实现。'), {
    settings: globalOnly,
    source: 'user',
  })

  expect(written.path).toBe(settings.globalPath)
  expect(await readFile(settings.globalPath, 'utf8')).toContain('## preference.workflow')
  await expect(stat(join(project, '.dsh', 'memory', PERSONALITY_FILE_NAME))).rejects.toThrow()
})

test('one stale-version write is retried after a re-read', async () => {
  await seedGlobal([entry('style', 'language', '旧文本。')])
  const writes = vi.spyOn(ctx.fs, 'writeText')
  writes.mockRejectedValueOnce(new FsError('stale version', 'FS_STALE_VERSION'))

  const written = await writePersonalityEntry(ctx, session, entry('understanding', 'terse', '用户常用短句。'), {
    settings,
    source: 'user',
  })

  // The profile write is retried once; the successful write is followed by the
  // history append, so the spy sees three calls.
  expect(writes).toHaveBeenCalledTimes(3)
  expect(written.revision).toBe(3)
  expect(await readFile(settings.globalPath, 'utf8')).toContain('## understanding.terse')
})

test('a second stale-version write surfaces the failure and keeps the file', async () => {
  const seed = await seedGlobal([entry('style', 'language', '旧文本。')])
  vi.spyOn(ctx.fs, 'writeText').mockRejectedValue(new FsError('stale version', 'FS_STALE_VERSION'))

  await expect(writePersonalityEntry(ctx, session, entry('understanding', 'terse', '用户常用短句。'), {
    settings,
    source: 'user',
  })).rejects.toThrow('stale version')
  expect(await readFile(settings.globalPath, 'utf8')).toBe(seed)
})

test('the body budget rejects a write and keeps the file', async () => {
  const seed = await seedGlobal([entry('style', 'language', '旧文本。')])
  const small = resolveConfig({ globalPath: settings.globalPath, maxBytes: 32 })

  await expect(writePersonalityEntry(ctx, session, entry('understanding', 'terse', '这是一段超过预算的条目文本。'), {
    settings: small,
    source: 'user',
  })).rejects.toMatchObject({ code: 'budget-exceeded' })
  expect(await readFile(settings.globalPath, 'utf8')).toBe(seed)
})

test('a hand-edited body over the budget is rejected on read', async () => {
  const small = resolveConfig({ globalPath: settings.globalPath, maxBytes: 32 })
  await seedGlobal([entry('style', 'language', '这是一段超过预算的条目文本。')])

  await expect(readPersonality(ctx, session, small)).rejects.toThrow(/over the 32-byte limit/)
})

test('both writes append history lines in revision order', async () => {
  await writePersonalityEntry(ctx, session, entry('understanding', 'terse', '第一条。'), { settings, source: 'user' })
  await writePersonalityEntry(ctx, session, entry('understanding', 'detailed', '第二条。'), { settings, source: 'user' })

  const history = await readFile(join(dirname(settings.globalPath), PERSONALITY_HISTORY_FILE_NAME), 'utf8')
  const lines = history.trimEnd().split('\n')
  expect(lines).toHaveLength(2)
  expect(lines[0]).toContain('"version":1')
  expect(lines[1]).toContain('"version":2')
})
