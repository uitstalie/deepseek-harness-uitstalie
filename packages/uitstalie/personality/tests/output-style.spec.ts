/**
 * Output-style tests: schema validation, seed fallback, canonical rendering,
 * section text order and boundaries, and the central section-order values.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createDshStore } from '@deepseek-ai/dsh-store-atom'
import { DEFAULT_OUTPUT_STYLE, DEFAULT_OUTPUT_STYLE_TEXT } from '../src/defaults.ts'
import {
  OUTPUT_STYLE_ORDER_NAME,
  OUTPUT_STYLE_SECTION_NAME,
  outputStylePath,
  parseOutputStyle,
  readOutputStyle,
  renderOutputStyle,
  renderOutputStyleSection,
} from '../src/output-style.ts'

let project: string
let ctx: Context

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'dsh-personality-output-style-'))
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

test('parses the seeded defaults and renders them canonically', () => {
  expect(parseOutputStyle(DEFAULT_OUTPUT_STYLE_TEXT)).toEqual(DEFAULT_OUTPUT_STYLE)
  expect(renderOutputStyle(parseOutputStyle(DEFAULT_OUTPUT_STYLE_TEXT))).toBe(DEFAULT_OUTPUT_STYLE_TEXT)
})

test('rejects invalid YAML, revision, enums, and non-boolean fields', () => {
  expect(() => parseOutputStyle(': [bad')).toThrow(/not valid YAML/u)
  expect(() => parseOutputStyle('version: 2\ntone: direct\nlength: terse\nleadWithConclusion: true\nlists: comparisons\ndispatchVoice: terse\n'))
    .toThrow(/version must be 1/u)
  expect(() => parseOutputStyle('version: 1\ntone: loud\nlength: terse\nleadWithConclusion: true\nlists: comparisons\ndispatchVoice: terse\n'))
    .toThrow(/tone must be one of/u)
  expect(() => parseOutputStyle('version: 1\ntone: direct\nlength: terse\nleadWithConclusion: yes\nlists: comparisons\ndispatchVoice: terse\n'))
    .toThrow(/leadWithConclusion must be a boolean/u)
  expect(() => parseOutputStyle('[]')).toThrow(/must be a mapping/u)
})

test('reads the seed defaults when absent and the file when present', async () => {
  expect(await readOutputStyle(ctx)).toEqual({ path: outputStylePath(), config: DEFAULT_OUTPUT_STYLE })
  const custom = {
    version: 1 as const,
    tone: 'warm' as const,
    length: 'detailed' as const,
    leadWithConclusion: false,
    lists: 'steps' as const,
    dispatchVoice: 'coaching' as const,
  }
  await mkdir(dirname(outputStylePath()), { recursive: true })
  await writeFile(outputStylePath(), renderOutputStyle(custom), 'utf8')
  const read = await readOutputStyle(ctx, new AbortController().signal)
  expect(read.config).toEqual(custom)
  expect(read.version).toBeDefined()
})

test('renders the section in fixed field order with the hard boundary', () => {
  const text = renderOutputStyleSection({
    version: 1,
    tone: 'warm',
    length: 'detailed',
    leadWithConclusion: true,
    lists: 'steps',
    dispatchVoice: 'coaching',
  }, {
    styleEntries: [{ text: 'Use   one paragraph.' }],
    dispatch: false,
  })
  const positions = ['- Tone:', '- Length:', '- Lead with the conclusion:', '- Lists:']
    .map(field => text.indexOf(field))
  expect(positions.every(position => position >= 0)).toBe(true)
  expect(positions).toEqual([...positions].sort((left, right) => left - right))
  expect(text).not.toContain('- Dispatch voice:')
  expect(text).toContain('Concrete style entries take priority over these defaults:')
  expect(text).toContain('- Use one paragraph.')
  expect(text).toContain('Hard boundary:')
  expect(text).toContain('Output style never overrides safety, approval, sandbox, tool permission, or workspace rules.')
  expect(text).toContain('Status reporting discipline:')
  expect(text).toContain('report delivery unconfirmed')
})

test('omits the non-dispatch qualifier for the super agent and handles no style entries', () => {
  const text = renderOutputStyleSection(DEFAULT_OUTPUT_STYLE, { dispatch: true })
  expect(text).toContain('- Dispatch voice: terse.')
  expect(text).not.toContain('super agent only; other agents ignore it')
  expect(text).not.toContain('Concrete style entries take priority')
})

test('pins the central section-order names and values', async () => {
  const prompt = new Context()
  await prompt.plugin(SystemPrompt, {})
  try {
    expect(prompt.systemPrompt.getSectionOrder('PERSONALITY')).toBe(100)
    expect(prompt.systemPrompt.getSectionOrder(OUTPUT_STYLE_ORDER_NAME)).toBe(690)
    expect(prompt.systemPrompt.getSectionOrder('PERSONALITY_WRITING_RULES')).toBe(695)
    expect(OUTPUT_STYLE_SECTION_NAME).toBe('personality:output-style')
  } finally {
    await prompt.fiber.dispose()
  }
})

test('renders the false lead and the default option shape', () => {
  const text = renderOutputStyleSection({ ...DEFAULT_OUTPUT_STYLE, leadWithConclusion: false })
  expect(text).toContain('Lead with the conclusion: no.')
  expect(text).not.toContain('Concrete style entries take priority')
})

test('reads a file whose store version is absent', async () => {
  vi.spyOn(ctx.dshStore, 'readFile').mockResolvedValueOnce({
    path: outputStylePath(),
    text: DEFAULT_OUTPUT_STYLE_TEXT,
  })
  expect((await readOutputStyle(ctx)).version).toBeUndefined()
})
