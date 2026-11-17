/**
 * Global memory store tests: the canonical YAML format, the 8 KiB budget, the
 * closed topic allowlist, same-topic supersession, search, forget, and the
 * refusal of business, dispatch, and persona text.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { createDshStore } from '@deepseek-ai/dsh-store-atom/src/api.ts'
import {
  GLOBAL_MEMORY_MAX_BYTES,
  GlobalMemoryError,
  createGlobalMemoryDocument,
  forgetGlobalEntries,
  globalMemoryArchivePath,
  globalMemoryPath,
  parseGlobalArchiveDocument,
  parseGlobalMemoryDocument,
  readGlobalMemory,
  readGlobalMemoryArchive,
  renderGlobalMemoryDocument,
  searchGlobalMemory,
  writeGlobalEntry,
} from '../src/global-memory.ts'
import type { GlobalMemoryEntry } from '../src/global-memory.ts'

let root: string
let ctx: Context

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-global-memory-'))
  // `$DSH_HOME` is the only store root these tests touch; the workspace is part of the fixture.
  vi.stubEnv('DSH_HOME', join(root, 'home'))
  ctx = new Context()
  await ctx.plugin(LocalFileSystem, { cwd: root })
  ctx.provide('dshStore', createDshStore(ctx, false))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

/** One active entry fixture. */
function entry(topic: GlobalMemoryEntry['topic'], text: string): GlobalMemoryEntry {
  return { id: `gm-${topic}`, topic, sourceSessionId: 'session-1', createdAt: '2026-11-18T00:00:00.000Z', text }
}

test('renders and parses the canonical global document', () => {
  const document = { ...createGlobalMemoryDocument(new Date('2026-11-18T00:00:00.000Z')), entries: [entry('global-server', 'Server alpha is the shared build host.')] }
  const parsed = parseGlobalMemoryDocument(renderGlobalMemoryDocument(document))
  expect(parsed).toEqual(document)
})

test('rejects a document without frontmatter, an unknown topic, and a duplicate active topic', () => {
  expect(() => parseGlobalMemoryDocument('Server alpha')).toThrow(/frontmatter/u)
  expect(() => parseGlobalMemoryDocument('---\nversion: 1\nupdatedAt: 2026-11-18T00:00:00.000Z\nentries:\n  - id: gm-1\n    topic: global-workspace\n    sourceSessionId: s\n    createdAt: 2026-11-18T00:00:00.000Z\n    text: x\n---\n'))
    .toThrow(/topic must be one of/u)
  expect(() => parseGlobalMemoryDocument(renderGlobalMemoryDocument({
    ...createGlobalMemoryDocument(),
    entries: [entry('global-server', 'one'), entry('global-server', 'two')],
  }))).toThrow(/more than one active entry/u)
})

test('a write goes to $DSH_HOME/memory/GLOBAL.md and reads back', async () => {
  const written = await writeGlobalEntry(ctx, {
    topic: 'global-model',
    text: 'The harness default model is the routed model.',
    sourceSessionId: 'session-1',
  })
  expect(written.path).toBe(globalMemoryPath())
  expect(written.revision).toBe(1)
  expect((await stat(written.path)).isFile()).toBe(true)
  const read = await readGlobalMemory(ctx)
  expect(read.document?.entries.map(item => item.text)).toEqual(['The harness default model is the routed model.'])
  expect(read.document?.entries[0]?.sourceSessionId).toBe('session-1')
})

test('a newer entry with the same topic archives the previous one', async () => {
  await writeGlobalEntry(ctx, { topic: 'global-server', text: 'Server alpha is the shared build host.', sourceSessionId: 's1' })
  const second = await writeGlobalEntry(ctx, { topic: 'global-server', text: 'Server beta replaced alpha as the build host.', sourceSessionId: 's2' })
  expect(second.archived?.text).toBe('Server alpha is the shared build host.')
  const active = await readGlobalMemory(ctx)
  expect(active.document?.entries.map(item => item.text)).toEqual(['Server beta replaced alpha as the build host.'])
  const archive = await readGlobalMemoryArchive(ctx)
  expect(archive.document?.entries.map(item => item.text)).toEqual(['Server alpha is the shared build host.'])
  expect(archive.document?.entries[0]?.reason).toBe('superseded')
  expect(parseGlobalArchiveDocument(await readFile(globalMemoryArchivePath(), 'utf8')))
    .toMatchObject({ entries: [{ reason: 'superseded' }] })
})

test('business, dispatch, and persona writes are refused with the owning tool', async () => {
  const business = await writeGlobalEntry(ctx, {
    topic: 'global-tooling',
    text: 'The commit 548dc157ba changed the workspace layout.',
    sourceSessionId: 's1',
  }).catch((error: unknown) => error)
  expect(business).toBeInstanceOf(GlobalMemoryError)
  expect((business as GlobalMemoryError).code).toBe('NOT_GLOBAL_MEMORY')
  expect((business as Error).message).toContain('workspace_intents')
  expect((business as Error).message).toContain('workspace_tasks')

  const dispatch = await writeGlobalEntry(ctx, {
    topic: 'global-convention',
    text: 'Dispatched the task to session memory-worker; waiting for the receipt.',
    sourceSessionId: 's1',
  }).catch((error: unknown) => error)
  expect((dispatch as GlobalMemoryError).code).toBe('NOT_GLOBAL_MEMORY')
  expect((dispatch as Error).message).toContain('workspace_sessions')

  const persona = await writeGlobalEntry(ctx, {
    topic: 'global-convention',
    text: 'The user prefers a calm tone of voice.',
    sourceSessionId: 's1',
  }).catch((error: unknown) => error)
  expect((persona as GlobalMemoryError).code).toBe('NOT_GLOBAL_MEMORY')
  expect((persona as Error).message).toContain('personality_apply')
  expect((await readGlobalMemory(ctx)).document).toBeUndefined()
})

test('search returns active hits, and archived hits only when requested', async () => {
  await writeGlobalEntry(ctx, { topic: 'global-server', text: 'Server alpha is the shared build host.', sourceSessionId: 's1' })
  await writeGlobalEntry(ctx, { topic: 'global-server', text: 'Server beta replaced alpha.', sourceSessionId: 's2' })

  const active = await searchGlobalMemory(ctx, 'alpha')
  expect(active.items).toHaveLength(1)
  expect(active.items[0]?.text).toBe('Server beta replaced alpha.')
  expect(active.items[0]?.archived).toBeUndefined()

  const all = await searchGlobalMemory(ctx, 'alpha', { includeArchived: true })
  expect(all.items.map(item => item.text)).toEqual([
    'Server beta replaced alpha.',
    'Server alpha is the shared build host.',
  ])
  expect(all.items[1]?.archived).toBe(true)
  expect(all.items[1]?.reason).toBe('superseded')

  const limited = await searchGlobalMemory(ctx, 'server', { limit: 1, includeArchived: true })
  expect(limited.items).toHaveLength(1)
  expect(limited.truncated).toBe(true)
})

test('forget archives by topic, deletes an archived id, and requires a filter', async () => {
  await writeGlobalEntry(ctx, { topic: 'global-server', text: 'Server alpha is the shared build host.', sourceSessionId: 's1' })
  await writeGlobalEntry(ctx, { topic: 'global-model', text: 'The harness default model is the routed model.', sourceSessionId: 's1' })

  const byTopic = await forgetGlobalEntries(ctx, { topic: 'global-server' })
  expect(byTopic.removed).toBe(1)
  expect(byTopic.remaining).toBe(1)
  expect((await readGlobalMemory(ctx)).document?.entries.map(item => item.topic)).toEqual(['global-model'])
  expect((await readGlobalMemoryArchive(ctx)).document?.entries[0]?.reason).toBe('manual-forget')

  const archivedId = (await readGlobalMemoryArchive(ctx)).document?.entries[0]?.id as string
  const byId = await forgetGlobalEntries(ctx, { entryId: archivedId })
  expect(byId.removed).toBe(1)
  expect((await readGlobalMemoryArchive(ctx)).document?.entries).toEqual([])

  await expect(forgetGlobalEntries(ctx, {})).rejects.toThrow(/requires `topic` or `entryId`/u)
})

test('the active file is capped at 8 KiB and a full write names memory_forget', async () => {
  await writeGlobalEntry(ctx, {
    topic: 'global-convention',
    text: `Always keep this convention: ${'c'.repeat(GLOBAL_MEMORY_MAX_BYTES - 300)}`,
    sourceSessionId: 's1',
  })
  const full = await writeGlobalEntry(ctx, {
    topic: 'global-tooling',
    text: 'Always run the type check before pushing a change.',
    sourceSessionId: 's1',
  }).catch((error: unknown) => error)
  expect(full).toBeInstanceOf(GlobalMemoryError)
  expect((full as GlobalMemoryError).code).toBe('GLOBAL_MEMORY_FULL')
  expect((full as Error).message).toContain('memory_forget')
})
