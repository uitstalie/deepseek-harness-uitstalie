/**
 * Writing-rules tests: schema and budget validation, canonical preview,
 * CRUD mutation, version-guarded reads/writes, and automatic ids.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { createDshStore } from '@deepseek-ai/dsh-store-atom'
import { stringify as stringifyYaml } from 'yaml'
import { EMPTY_WRITING_RULES_TEXT } from '../src/defaults.ts'
import {
  EMPTY_WRITING_RULES,
  mutateWritingRules,
  parseWritingRules,
  previewWritingRules,
  readWritingRules,
  renderWritingRules,
  WRITING_RULES_MAX_TEXT_BYTES,
  WRITING_RULES_MAX_TEXT_CHARS,
  writingRulesPath,
  writeWritingRules,
} from '../src/writing-rules.ts'
import type { WritingRule, WritingRulesDocument } from '../src/writing-rules.ts'

let project: string
let ctx: Context

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'dsh-personality-writing-rules-'))
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

/** Build one document. */
function documentWith(rules: readonly WritingRule[]): WritingRulesDocument {
  return { version: 1, rules }
}

/** Build raw YAML for a document. */
function raw(rules: readonly unknown[]): string {
  return stringifyYaml({ version: 1, rules }, { lineWidth: 0 })
}

test('parses the empty seed and renders it canonically', () => {
  expect(parseWritingRules(EMPTY_WRITING_RULES_TEXT)).toEqual(EMPTY_WRITING_RULES)
  expect(renderWritingRules(EMPTY_WRITING_RULES)).toBe(EMPTY_WRITING_RULES_TEXT)
})

test('rejects malformed YAML, revision, collection, entries, ids, and duplicates', () => {
  expect(() => parseWritingRules(': [bad')).toThrow(/not valid YAML/u)
  expect(() => parseWritingRules('version: 2\nrules: []\n')).toThrow(/version must be 1/u)
  expect(() => parseWritingRules('version: 1\nrules: nope\n')).toThrow(/rules must be a sequence/u)
  expect(() => parseWritingRules(raw([{ id: 'ok', text: 'x', enabled: 'yes', order: 10 }])))
    .toThrow(/needs string id\/text/u)
  expect(() => parseWritingRules(raw([{ id: 'Bad', text: 'x', enabled: true, order: 10 }])))
    .toThrow(/lower-kebab-case/u)
  expect(() => parseWritingRules(raw([rule('same', 'one', 10), rule('same', 'two', 20)])))
    .toThrow(/duplicate rule id/u)
  expect(() => parseWritingRules(raw(Array.from({ length: 33 }, (_, index) => rule(`r-${String(index)}`, 'x', index)))))
    .toThrow(/over the 32-rule limit/u)
  expect(() => parseWritingRules(raw([rule('long', 'x'.repeat(WRITING_RULES_MAX_TEXT_CHARS + 1), 10)])))
    .toThrow(/over the 240-character limit/u)
  expect(() => parseWritingRules(raw(Array.from({ length: 18 }, (_, index) => rule(`r-${String(index)}`, 'x'.repeat(240), index)))))
    .toThrow(new RegExp(`over the ${String(WRITING_RULES_MAX_TEXT_BYTES)}-byte limit`, 'u'))
  expect(() => parseWritingRules(raw([{ id: 'order', text: 'x', enabled: true, order: 1.5 }])))
    .toThrow(/order must be a safe integer/u)
})

test('previews only enabled rules in order then id', () => {
  const document = documentWith([
    rule('late', 'Late.', 20),
    rule('hidden', 'Hidden.', 10, false),
    rule('b', 'B.', 10),
    rule('a', 'A.', 10),
    rule('z', 'Z.', 10),
  ])
  expect(previewWritingRules(document)).toBe('- A.\n- B.\n- Z.\n- Late.')
  expect(previewWritingRules(EMPTY_WRITING_RULES)).toBe('')
})

test('mutates rules through add, update, enable, disable, remove, list, and preview', () => {
  let current = EMPTY_WRITING_RULES
  const added = mutateWritingRules(current, { action: 'add', text: 'Use active voice.' })
  current = added.document
  expect(current.rules).toEqual([rule('use-active-voice', 'Use active voice.', 10)])

  const second = mutateWritingRules(current, { action: 'add', id: 'no-em-dash', text: 'No em dash.', order: 20, enabled: false })
  current = second.document
  expect(current.rules).toHaveLength(2)
  expect(current.rules[1]).toEqual(rule('no-em-dash', 'No em dash.', 20, false))
  expect(() => mutateWritingRules(current, { action: 'add', id: 'no-em-dash', text: 'duplicate' }))
    .toThrow(/already exists/u)

  current = mutateWritingRules(current, { action: 'update', id: 'no-em-dash', text: 'No em dash in prose.', enabled: true }).document
  expect(current.rules[1]).toMatchObject({ id: 'no-em-dash', text: 'No em dash in prose.', enabled: true, order: 20 })
  current = mutateWritingRules(current, { action: 'disable', id: 'use-active-voice' }).document
  expect(previewWritingRules(current)).toBe('- No em dash in prose.')
  current = mutateWritingRules(current, { action: 'enable', id: 'use-active-voice' }).document
  expect(previewWritingRules(current)).toContain('Use active voice.')
  expect(mutateWritingRules(current, { action: 'list' }).promptSection).toBe(previewWritingRules(current))
  expect(mutateWritingRules(current, { action: 'preview' }).promptSection).toBe(previewWritingRules(current))
  current = mutateWritingRules(current, { action: 'remove', id: 'use-active-voice' }).document
  expect(current.rules.map(candidate => candidate.id)).toEqual(['no-em-dash'])
})

test('rejects unknown rules, missing fields, and invalid ids', () => {
  expect(() => mutateWritingRules(EMPTY_WRITING_RULES, { action: 'update', id: 'missing', text: 'x' }))
    .toThrow(/does not exist/u)
  expect(() => mutateWritingRules(EMPTY_WRITING_RULES, { action: 'remove', id: 'missing' }))
    .toThrow(/does not exist/u)
  expect(() => mutateWritingRules(EMPTY_WRITING_RULES, { action: 'enable', id: 'missing' }))
    .toThrow(/does not exist/u)
  expect(() => mutateWritingRules(EMPTY_WRITING_RULES, { action: 'add' })).toThrow(/text is required/u)
  expect(() => mutateWritingRules(EMPTY_WRITING_RULES, { action: 'update' })).toThrow(/id is required/u)
  expect(() => mutateWritingRules(EMPTY_WRITING_RULES, { action: 'add', id: 'Bad', text: 'x' }))
    .toThrow(/lower-kebab-case/u)
})

test('generates a stable fallback id for non-Latin text and respects the rule count', () => {
  const added = mutateWritingRules(EMPTY_WRITING_RULES, { action: 'add', text: '先说结论。' })
  expect(added.document.rules[0]?.id).toMatch(/^rule-[0-9a-f]{8}$/u)
  let current = EMPTY_WRITING_RULES
  for (let index = 0; index < 32; index += 1) {
    current = mutateWritingRules(current, { action: 'add', id: `rule-${String(index)}`, text: 'x' }).document
  }
  expect(() => mutateWritingRules(current, { action: 'add', id: 'overflow', text: 'x' }))
    .toThrow(/over the 32-rule limit/u)
})

test('reads an empty file and a populated one, and enforces the version guard', async () => {
  expect(await readWritingRules(ctx)).toEqual({ path: writingRulesPath(), document: EMPTY_WRITING_RULES })
  const document = documentWith([rule('no-em-dash', 'No em dash in prose.', 10)])
  await mkdir(dirname(writingRulesPath()), { recursive: true })
  await writeFile(writingRulesPath(), renderWritingRules(document), 'utf8')
  const read = await readWritingRules(ctx, new AbortController().signal)
  expect(read.document).toEqual(document)
  expect(read.version).toBeDefined()

  await expect(writeWritingRules(ctx, document, 'stale')).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
  const written = await writeWritingRules(ctx, document)
  expect(written.version).toBeDefined()
})

test('rejects writes that violate the rule budget', () => {
  const tooMany = Array.from({ length: 33 }, (_, index) => rule(`r-${String(index)}`, 'x', index))
  expect(() => renderWritingRules(documentWith(tooMany))).toThrow(/over the 32-rule limit/u)
  expect(() => renderWritingRules(documentWith([rule('long', 'x'.repeat(241), 10)]))).toThrow(/over the 240-character limit/u)
})

test('updates only the supplied fields and rejects an empty rule', () => {
  const current = documentWith([rule('keep', 'Keep this.', 10)])
  const updated = mutateWritingRules(current, { action: 'update', id: 'keep', enabled: false }).document
  expect(updated.rules[0]).toEqual(rule('keep', 'Keep this.', 10, false))
  const reordered = mutateWritingRules(current, { action: 'update', id: 'keep', order: 30 }).document
  expect(reordered.rules[0]?.order).toBe(30)
  expect(() => mutateWritingRules(current, { action: 'update', id: 'keep', text: '   ' }))
    .toThrow(/must not be empty/u)
  expect(() => mutateWritingRules(EMPTY_WRITING_RULES, { action: 'add', text: '   ' }))
    .toThrow(/must not be empty/u)
})

test('rejects a non-mapping document and a non-boolean enabled value', () => {
  expect(() => parseWritingRules('[]')).toThrow(/must be a mapping/u)
  expect(() => renderWritingRules(documentWith([{
    id: 'enabled',
    text: 'x',
    enabled: 'yes' as never,
    order: 10,
  }]))).toThrow(/enabled must be a boolean/u)
})

test('suffixes an auto-generated id when the same text already exists', () => {
  const first = mutateWritingRules(EMPTY_WRITING_RULES, { action: 'add', text: 'Use active voice.' }).document
  const second = mutateWritingRules(first, { action: 'add', text: 'Use active voice.' }).document
  expect(second.rules.map(candidate => candidate.id)).toEqual(['use-active-voice', 'use-active-voice-2'])
})

test('reads without a store version and writes with a signal and no returned version', async () => {
  vi.spyOn(ctx.dshStore, 'readFile').mockResolvedValueOnce({
    path: writingRulesPath(),
    text: EMPTY_WRITING_RULES_TEXT,
  } as never)
  expect((await readWritingRules(ctx)).version).toBeUndefined()

  vi.spyOn(ctx.dshStore, 'writeFile').mockResolvedValueOnce({ path: 'unused', version: undefined } as never)
  const written = await writeWritingRules(ctx, EMPTY_WRITING_RULES, undefined, new AbortController().signal)
  expect(written.version).toBeUndefined()
})

test('updates with no supplied fields as a no-op', () => {
  const current = documentWith([rule('keep', 'Keep this.', 10)])
  const updated = mutateWritingRules(current, { action: 'update', id: 'keep' }).document
  expect(updated).toEqual(current)
})
