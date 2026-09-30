/**
 * Rules discovery tests: recursive collection, path ordering, cross-file
 * deduplication by trimmed content, per-file cap, and change-detecting digest.
 */
import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { RULES_DIRECTORY, rulesScanChanged, scanWorkspaceRules } from '../src/rules.ts'

let project: string
let ctx: Context
let fs: LocalFileSystem
let fiber: Awaited<ReturnType<Context['plugin']>>

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'dsh-rules-'))
  ctx = new Context()
  fiber = await ctx.plugin(LocalFileSystem, { cwd: project })
  fs = ctx.fs as LocalFileSystem
})

afterEach(async () => {
  await fiber.dispose()
  await rm(project, { recursive: true, force: true })
})

/** Write one rule file below the project's rules directory. */
async function writeRule(relativePath: string, content: string): Promise<void> {
  const path = join(project, RULES_DIRECTORY, relativePath)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
}

async function scan(maxSourceBytes = 1024 * 1024) {
  return scanWorkspaceRules(fs, { projectRoot: project, maxSourceBytes })
}

test('an absent rules directory scans as empty', async () => {
  const scanResult = await scan()
  expect(scanResult.files).toEqual([])
  expect(scanResult.digest).toMatch(/^[0-9a-f]{40}$/u)
})

test('collects Markdown rules recursively in path order and ignores other files', async () => {
  await writeRule('b.md', 'second rule')
  await writeRule('a.md', 'first rule')
  await writeRule('nested/c.md', 'third rule')
  await writeRule('notes.txt', 'not a rule')
  const scanResult = await scan()
  expect(scanResult.files.map(file => file.displayPath)).toEqual([
    '.dsh/rules/a.md',
    '.dsh/rules/b.md',
    '.dsh/rules/nested/c.md',
  ])
  expect(scanResult.files.map(file => file.content)).toEqual(['first rule', 'second rule', 'third rule'])
})

test('collapses duplicate trimmed content to the first path', async () => {
  await writeRule('a.md', '  same rule\n')
  await writeRule('b.md', 'same rule')
  const scanResult = await scan()
  expect(scanResult.files.map(file => file.displayPath)).toEqual(['.dsh/rules/a.md'])
})

test('skips files above the per-file cap and empty files', async () => {
  await writeRule('big.md', 'x'.repeat(64))
  await writeRule('empty.md', '')
  await writeRule('small.md', 'ok')
  const scanResult = await scanWorkspaceRules(fs, { projectRoot: project, maxSourceBytes: 16 })
  expect(scanResult.files.map(file => file.displayPath)).toEqual(['.dsh/rules/small.md'])
})

test('the set digest is stable for identical scans and changes with the set', async () => {
  await writeRule('a.md', 'rule a')
  const first = await scan()
  const again = await scan()
  expect(rulesScanChanged(first, again)).toBe(false)

  await writeRule('a.md', 'rule a edited')
  const edited = await scan()
  expect(rulesScanChanged(first, edited)).toBe(true)

  await writeRule('b.md', 'rule b')
  const added = await scan()
  expect(rulesScanChanged(edited, added)).toBe(true)

  await rm(join(project, RULES_DIRECTORY, 'b.md'))
  const removed = await scan()
  expect(rulesScanChanged(added, removed)).toBe(true)
})

test('an initial scan always counts as changed', async () => {
  const scanResult = await scan()
  expect(rulesScanChanged(undefined, scanResult)).toBe(true)
})

test('honors an already-aborted signal', async () => {
  await writeRule('a.md', 'rule a')
  const controller = new AbortController()
  controller.abort()
  await expect(scanWorkspaceRules(fs, { projectRoot: project, maxSourceBytes: 1024, signal: controller.signal }))
    .rejects.toThrow()
})
