/**
 * `write_like_human` tests: every action, the global write, the readable
 * failure paths, and the one-retry stale guard.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { createDshStore } from '@deepseek-ai/dsh-store-atom'
import { renderWritingRules, readWritingRules, writingRulesPath } from '../src/writing-rules.ts'
import type { WritingRule } from '../src/writing-rules.ts'
import { renderWritingRulesResult, runWritingRuleAction } from '../src/writing-tool.ts'

const signal = new AbortController().signal

let project: string
let ctx: Context

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'dsh-personality-writing-tool-'))
  vi.stubEnv('DSH_HOME', join(project, 'home'))
  ctx = new Context()
  await ctx.plugin(LocalFileSystem, { cwd: project })
  ctx.provide('dshStore', createDshStore(ctx, false))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await ctx.fiber.dispose()
  await rm(project, { recursive: true, force: true })
})

/** Build one valid rule. */
function rule(id: string, text: string, order: number, enabled = true): WritingRule {
  return { id, text, enabled, order }
}

/** Seed the global file through the real filesystem. */
async function seed(rules: readonly WritingRule[]): Promise<void> {
  await mkdir(dirname(writingRulesPath()), { recursive: true })
  await writeFile(writingRulesPath(), renderWritingRules({ version: 1, rules }), 'utf8')
}

test('lists an absent file as empty and an existing file with its rules', async () => {
  const absent = await runWritingRuleAction(ctx, { action: 'list' }, signal)
  expect(absent).toMatchObject({ action: 'list', ok: true, rules: [], path: writingRulesPath() })
  expect(absent.version).toBeUndefined()
  expect(absent.promptSection).toBeUndefined()

  await seed([rule('no-em-dash', 'No em dash.', 10)])
  const present = await runWritingRuleAction(ctx, { action: 'list' }, signal)
  expect(present.ok).toBe(true)
  expect(present.rules).toEqual([rule('no-em-dash', 'No em dash.', 10)])
  expect(present.version).toBeDefined()
})

test('add generates a lower-kebab id, appends, and writes the global file', async () => {
  const added = await runWritingRuleAction(ctx, { action: 'add', text: 'Use active voice.' }, signal)
  expect(added.ok).toBe(true)
  expect(added.rules).toEqual([rule('use-active-voice', 'Use active voice.', 10)])
  expect(added.promptSection).toBeUndefined()
  expect(added.version).toBeDefined()

  const stored = await readWritingRules(ctx)
  expect(stored.document.rules).toEqual(added.rules)
})

test('add suffixes a generated id on collision', async () => {
  await seed([rule('use-active-voice', 'Existing rule.', 10)])
  const added = await runWritingRuleAction(ctx, { action: 'add', text: 'Use active voice.' }, signal)
  expect(added.ok).toBe(true)
  expect(added.rules.map(entry => entry.id)).toEqual(['use-active-voice', 'use-active-voice-2'])
})

test('add accepts an explicit id, order, and enabled state', async () => {
  const added = await runWritingRuleAction(ctx, {
    action: 'add',
    id: 'no-em-dash',
    text: 'No em dash.',
    order: 20,
    enabled: false,
  }, signal)
  expect(added.ok).toBe(true)
  expect(added.rules).toEqual([rule('no-em-dash', 'No em dash.', 20, false)])
})

test('update keeps the id and changes only the supplied fields', async () => {
  await seed([rule('no-em-dash', 'No em dash.', 10), rule('short', 'Short.', 20)])
  const updated = await runWritingRuleAction(ctx, {
    action: 'update',
    id: 'no-em-dash',
    text: 'No em dash in prose.',
    order: 30,
  }, signal)
  expect(updated.ok).toBe(true)
  expect(updated.rules).toEqual([
    rule('no-em-dash', 'No em dash in prose.', 30),
    rule('short', 'Short.', 20),
  ])
  const stored = await readWritingRules(ctx)
  expect(stored.document.rules).toEqual(updated.rules)
})

test('remove deletes one rule from the file', async () => {
  await seed([rule('no-em-dash', 'No em dash.', 10), rule('short', 'Short.', 20)])
  const removed = await runWritingRuleAction(ctx, { action: 'remove', id: 'no-em-dash' }, signal)
  expect(removed.ok).toBe(true)
  expect(removed.rules).toEqual([rule('short', 'Short.', 20)])
  expect((await readWritingRules(ctx)).document.rules).toEqual(removed.rules)
})

test('enable and disable toggle the injected set', async () => {
  await seed([rule('short', 'Short.', 10, false)])
  const enabled = await runWritingRuleAction(ctx, { action: 'enable', id: 'short' }, signal)
  expect(enabled.ok).toBe(true)
  expect(enabled.rules).toEqual([rule('short', 'Short.', 10, true)])

  const disabled = await runWritingRuleAction(ctx, { action: 'disable', id: 'short' }, signal)
  expect(disabled.ok).toBe(true)
  expect(disabled.rules).toEqual([rule('short', 'Short.', 10, false)])
})

test('preview returns only the enabled rules as injected text', async () => {
  await seed([rule('no-em-dash', 'No em dash.', 10), rule('short', 'Short.', 20, false)])
  const preview = await runWritingRuleAction(ctx, { action: 'preview' }, signal)
  expect(preview.ok).toBe(true)
  expect(preview.rules).toHaveLength(2)
  expect(preview.promptSection).toBe('- No em dash.')
})

test('rejects a write that would exceed the rule limit without changing the file', async () => {
  const existing = Array.from({ length: 100 }, (_, index) => rule(`rule-${String(index)}`, 'Text.', index))
  await seed(existing)
  const added = await runWritingRuleAction(ctx, { action: 'add', text: 'One more.' }, signal)
  expect(added.ok).toBe(false)
  expect(added.error).toMatch(/over the 100-rule limit/u)
  expect(added.rules).toHaveLength(100)
  expect((await readWritingRules(ctx)).document.rules).toHaveLength(100)
})

test('reports invalid YAML as a readable error instead of throwing', async () => {
  await mkdir(dirname(writingRulesPath()), { recursive: true })
  await writeFile(writingRulesPath(), 'version: 1\nrules: nope\n', 'utf8')
  const listed = await runWritingRuleAction(ctx, { action: 'list' }, signal)
  expect(listed.ok).toBe(false)
  expect(listed.error).toMatch(/rules must be a sequence/u)
  expect(listed.rules).toEqual([])
  expect(listed.version).toBeUndefined()
})

test('rejects a duplicate id and an unknown id', async () => {
  await seed([rule('no-em-dash', 'No em dash.', 10)])
  const duplicate = await runWritingRuleAction(ctx, { action: 'add', id: 'no-em-dash', text: 'Again.' }, signal)
  expect(duplicate.ok).toBe(false)
  expect(duplicate.error).toMatch(/already exists/u)
  expect(duplicate.rules).toEqual([rule('no-em-dash', 'No em dash.', 10)])

  const unknown = await runWritingRuleAction(ctx, { action: 'remove', id: 'missing' }, signal)
  expect(unknown.ok).toBe(false)
  expect(unknown.error).toMatch(/does not exist/u)
})

test('retries one stale write after a fresh read and then succeeds', async () => {
  await seed([rule('no-em-dash', 'No em dash.', 10)])
  const original = ctx.dshStore.writeFile.bind(ctx.dshStore)
  const write = vi.spyOn(ctx.dshStore, 'writeFile')
    .mockRejectedValueOnce(new FsError('stale', 'FS_STALE_VERSION'))
    .mockImplementation(original)

  const added = await runWritingRuleAction(ctx, { action: 'add', text: 'Use active voice.' }, signal)
  expect(write).toHaveBeenCalledTimes(2)
  expect(added.ok).toBe(true)
  expect(added.rules.map(entry => entry.id)).toEqual(['no-em-dash', 'use-active-voice'])
  expect((await readWritingRules(ctx)).document.rules.map(entry => entry.id)).toEqual(['no-em-dash', 'use-active-voice'])
})

test('reports a second stale write without overwriting the file', async () => {
  await seed([rule('no-em-dash', 'No em dash.', 10)])
  const write = vi.spyOn(ctx.dshStore, 'writeFile')
    .mockRejectedValue(new FsError('stale', 'FS_STALE_VERSION'))

  const added = await runWritingRuleAction(ctx, { action: 'add', text: 'Use active voice.' }, signal)
  expect(write).toHaveBeenCalledTimes(2)
  expect(added.ok).toBe(false)
  expect(added.error).toMatch(/stale/u)
  expect(added.rules).toEqual([rule('no-em-dash', 'No em dash.', 10)])
})

test('reports a non-Error write failure as its string form', async () => {
  vi.spyOn(ctx.dshStore, 'writeFile').mockRejectedValue('store offline')
  const added = await runWritingRuleAction(ctx, { action: 'add', text: 'Use active voice.' }, signal)
  expect(added.ok).toBe(false)
  expect(added.error).toBe('store offline')
})

test('retries FS_NOT_OBSERVED once like a stale version', async () => {
  await seed([rule('no-em-dash', 'No em dash.', 10)])
  const original = ctx.dshStore.writeFile.bind(ctx.dshStore)
  const write = vi.spyOn(ctx.dshStore, 'writeFile')
    .mockRejectedValueOnce(new FsError('not observed', 'FS_NOT_OBSERVED'))
    .mockImplementation(original)
  const added = await runWritingRuleAction(ctx, { action: 'add', text: 'Use active voice.' }, signal)
  expect(write).toHaveBeenCalledTimes(2)
  expect(added.ok).toBe(true)
})

test('reports a different FsError code without retrying', async () => {
  const write = vi.spyOn(ctx.dshStore, 'writeFile').mockRejectedValueOnce(new FsError('missing', 'FS_NOT_FOUND'))
  const added = await runWritingRuleAction(ctx, { action: 'add', text: 'Use active voice.' }, signal)
  expect(write).toHaveBeenCalledTimes(1)
  expect(added.ok).toBe(false)
  expect(added.error).toMatch(/missing/u)
})

test('renders success, preview, and failure reports', () => {
  const rules = [rule('on', 'On.', 10), rule('off', 'Off.', 20, false)]
  const listed = renderWritingRulesResult({ action: 'list', ok: true, rules, path: '/rules.yaml' })
  expect(listed).toContain('2 rule(s) in /rules.yaml')
  expect(listed).toContain('[on, order 10] On.')
  expect(listed).toContain('[off, order 20] Off.')

  expect(renderWritingRulesResult({ action: 'preview', ok: true, rules: [], path: '/rules.yaml', promptSection: '' })).toContain('(empty)')
  expect(renderWritingRulesResult({ action: 'preview', ok: true, rules: [], path: '/rules.yaml', promptSection: '- On.' })).toContain('- On.')
  expect(renderWritingRulesResult({ action: 'add', ok: false, error: 'nope', rules: [], path: '/rules.yaml' }))
    .toBe('write_like_human failed (add): nope')
  const many = Array.from({ length: 41 }, (_, index) => rule(`r-${String(index)}`, 'On.', index))
  expect(renderWritingRulesResult({ action: 'list', ok: true, rules: many, path: '/rules.yaml' }))
    .toContain('1 rule(s) not injected: resident limit is 40.')
})

test('omits the version when the store reports none after a write', async () => {
  vi.spyOn(ctx.dshStore, 'writeFile').mockResolvedValueOnce({ path: 'personality/WRITING_RULES.yaml' })
  const added = await runWritingRuleAction(ctx, { action: 'add', text: 'Use active voice.' }, signal)
  expect(added.ok).toBe(true)
  expect(added.version).toBeUndefined()
})
