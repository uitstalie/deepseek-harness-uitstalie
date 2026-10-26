/**
 * `.dsh/` 存储操作的单测：真实 LocalFileSystem + 临时工作区，逐项钉住可观察结果。
 */
import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import {
  createStoreFile,
  createStoreFolder,
  ensureStoreRoot,
  queryStoreTarget,
  removeStoreTarget,
} from '../src/store-ops.ts'

let project: string
let ctx: Context
let fs: LocalFileSystem
let fiber: Awaited<ReturnType<Context['plugin']>>

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'dsh-store-'))
  ctx = new Context()
  fiber = await ctx.plugin(LocalFileSystem, { cwd: project })
  fs = ctx.fs as LocalFileSystem
})

afterEach(async () => {
  await fiber.dispose()
  await rm(project, { recursive: true, force: true })
})

/** The absolute `.dsh` root inside the fixture workspace. */
function root(): string {
  return join(project, '.dsh')
}

test('ensureStoreRoot creates the root once and reports later calls', async () => {
  expect(await ensureStoreRoot(fs, root())).toBe(true)
  expect(await ensureStoreRoot(fs, root())).toBe(false)
  expect((await queryStoreTarget(fs, root(), '')).kind).toBe('directory')
})

test('createStoreFolder creates nested folders', async () => {
  const target = join(root(), 'rules', 'nested')
  const result = await createStoreFolder(fs, target, 'rules/nested')
  expect(result).toEqual({ path: 'rules/nested', kind: 'directory' })
  expect((await queryStoreTarget(fs, target, 'rules/nested')).kind).toBe('directory')
})

test('createStoreFile writes text that query reads back', async () => {
  const target = join(root(), 'rules', 'api.md')
  const created = await createStoreFile(fs, target, 'rules/api.md', 'Always document public APIs.')
  expect(created).toEqual({ path: 'rules/api.md', kind: 'file' })
  const queried = await queryStoreTarget(fs, target, 'rules/api.md', { readText: true })
  expect(queried.kind).toBe('file')
  expect(queried.text).toBe('Always document public APIs.')
  expect(queried.entries).toEqual([])
})

test('query lists children sorted by path with kinds and sizes', async () => {
  await createStoreFile(fs, join(root(), 'rules', 'b.md'), 'rules/b.md', 'b')
  await createStoreFile(fs, join(root(), 'rules', 'a.md'), 'rules/a.md', 'aa')
  await createStoreFolder(fs, join(root(), 'rules', 'nested'), 'rules/nested')
  const queried = await queryStoreTarget(fs, join(root(), 'rules'), 'rules')
  expect(queried.kind).toBe('directory')
  expect(queried.entries.map(entry => entry.path)).toEqual(['rules/a.md', 'rules/b.md', 'rules/nested'])
  expect(queried.entries.map(entry => entry.kind)).toEqual(['file', 'file', 'directory'])
  expect(queried.entries[0]?.size).toBe(2)
  expect(queried.entries[2]?.size).toBeUndefined()
})

test('query reports a missing target instead of failing', async () => {
  const queried = await queryStoreTarget(fs, join(root(), 'rules', 'absent.md'), 'rules/absent.md')
  expect(queried).toEqual({ path: 'rules/absent.md', kind: 'missing', entries: [] })
})

test('remove deletes a file', async () => {
  const target = join(root(), 'rules', 'api.md')
  await createStoreFile(fs, target, 'rules/api.md', 'text')
  expect(await removeStoreTarget(fs, target, 'rules/api.md', false)).toEqual({ path: 'rules/api.md', kind: 'file' })
  expect((await queryStoreTarget(fs, target, 'rules/api.md')).kind).toBe('missing')
})

test('remove refuses a populated directory without recursive and accepts it with recursive', async () => {
  const target = join(root(), 'rules')
  await createStoreFile(fs, join(target, 'api.md'), 'rules/api.md', 'text')
  await expect(removeStoreTarget(fs, target, 'rules', false)).rejects.toThrow()
  expect(await removeStoreTarget(fs, target, 'rules', true)).toEqual({ path: 'rules', kind: 'directory' })
  expect((await queryStoreTarget(fs, target, 'rules')).kind).toBe('missing')
})

test('an empty directory removes without the recursive switch', async () => {
  const target = join(root(), 'empty')
  await mkdir(target, { recursive: true })
  expect(await removeStoreTarget(fs, target, 'empty', false)).toEqual({ path: 'empty', kind: 'directory' })
})

test('query reads a pre-existing file written outside the plugin', async () => {
  await mkdir(join(root(), 'rules'), { recursive: true })
  await writeFile(join(root(), 'rules', 'external.md'), 'written by another writer')
  const queried = await queryStoreTarget(fs, join(root(), 'rules', 'external.md'), 'rules/external.md', { readText: true })
  expect(queried.text).toBe('written by another writer')
})
