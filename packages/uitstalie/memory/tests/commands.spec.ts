/**
 * `/memory` command tests over the real memory composition: the summary list, pause/resume, a manual
 * edit, and its revert through the command registry.
 */
import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { appendMemoryEntry, appendTurnSummary, parseMemoryDocument, summaryPaused } from '../src/index.ts'
import { createRoot, memoryFilePath, mountMemory } from './harness.ts'
import type { MemoryTestHarness } from './harness.ts'

let project: string
let contexts: Context[]
let mounted: MemoryTestHarness

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'dsh-memory-command-'))
  // A `.git` marker makes the fixture look like a checkout for project-root discovery.
  await mkdir(join(project, '.git'), { recursive: true })
  contexts = []
  const ctx = new Context()
  contexts.push(ctx)
  mounted = await mountMemory(ctx, project, { commands: true })
})

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await rm(project, { recursive: true, force: true })
})

/** Seed one summarized turn for the fixture root session. */
async function seed(root: Agent, text = 'auto text'): Promise<void> {
  await appendTurnSummary(mounted.ctx, root.session, {
    turn: 1,
    seq: [0, 5],
    entries: [{ kind: 'decision', text }],
  })
}

/** Execute one slash command and return its settled result. */
async function run(root: Agent, line: string): Promise<{ readonly kind: string; readonly text?: string }> {
  const execution = await mounted.ctx.commands.execute(root, line, [], new AbortController().signal)
  if (execution === undefined) throw new Error(`command "${line}" did not resolve`)
  return execution.result
}

test('/memory summaries lists the current session and the job state', async () => {
  const root = await createRoot(mounted)
  await seed(root)

  const result = await run(root, '/memory summaries')
  expect(result.kind).toBe('success')
  expect(result.text).toContain('automatic job: running')
  expect(result.text).toContain('turns 1–1 (detail)')
  expect(result.text).toContain('auto text')

  const bare = await run(root, '/memory')
  expect(bare.text).toBe(result.text)
})

test('/memory pause and resume round-trip through MEMORY.md', async () => {
  const root = await createRoot(mounted)
  await seed(root)

  expect((await run(root, '/memory pause')).kind).toBe('success')
  expect(summaryPaused(parseMemoryDocument(await readFile(memoryFilePath(project), 'utf8')))).toBe(true)
  expect((await run(root, '/memory summaries')).text).toContain('automatic job: paused')

  expect((await run(root, '/memory resume')).kind).toBe('success')
  expect(summaryPaused(parseMemoryDocument(await readFile(memoryFilePath(project), 'utf8')))).toBe(false)
})

test('/memory edit replaces the entry and /memory revert restores it', async () => {
  const root = await createRoot(mounted)
  await seed(root)

  const edited = await run(root, '/memory edit 1 a human correction')
  expect(edited.kind).toBe('success')
  let parsed = parseMemoryDocument(await readFile(memoryFilePath(project), 'utf8'))
  expect(parsed.sections[0]?.entries[0]).toMatchObject({
    text: 'a human correction',
    source: 'manual',
    version: 1,
  })

  const reverted = await run(root, '/memory revert 1')
  expect(reverted.kind).toBe('success')
  parsed = parseMemoryDocument(await readFile(memoryFilePath(project), 'utf8'))
  expect(parsed.sections[0]?.entries[0]).toMatchObject({ text: 'auto text', source: 'manual', version: 2 })
})

test('/memory reports grammar failures and unknown turns', async () => {
  const root = await createRoot(mounted)
  await seed(root)

  const unknown = await run(root, '/memory fly')
  expect(unknown.kind).toBe('error')
  expect(unknown.text).toContain('Unknown /memory form')

  const noTurn = await run(root, '/memory edit words only')
  expect(noTurn.kind).toBe('error')
  expect(noTurn.text).toContain('needs a turn number')

  const missing = await run(root, '/memory edit 9 nothing here')
  expect(missing.kind).toBe('error')
  expect(missing.text).toContain('known turns: 1')
})

test('/memory stats reports entries, sources, kinds and the cap', async () => {
  const root = await createRoot(mounted)
  await seed(root)
  await appendMemoryEntry(mounted.ctx, root.session, { kind: 'open', text: 'next thing', turn: 2, seq: [6, 9] })

  const result = await run(root, '/memory stats')
  expect(result.kind).toBe('success')
  expect(result.text).toContain('Total: 2 (auto 2, manual 0)')
  expect(result.text).toContain('decision 1')
  expect(result.text).toContain('open 1')
  expect(result.text).toContain('Turns: 1–2')
  expect(result.text).toContain('cap 40 per session')
})

test('/memory prune drops duplicates and old sections down to the requested cap', async () => {
  const root = await createRoot(mounted)
  await appendMemoryEntry(mounted.ctx, root.session, { kind: 'open', text: 'first', turn: 1, seq: [0, 3] })
  await appendMemoryEntry(mounted.ctx, root.session, { kind: 'open', text: 'second', turn: 2, seq: [4, 7] })
  await appendMemoryEntry(mounted.ctx, root.session, { kind: 'open', text: 'third', turn: 3, seq: [8, 11] })

  const result = await run(root, '/memory prune 1')
  expect(result.kind).toBe('success')
  expect(result.text).toContain('over-cap entries')
  expect(result.text).toContain('1 remain')

  const parsed = parseMemoryDocument(await readFile(memoryFilePath(project), 'utf8'))
  expect(parsed.sections.flatMap(section => section.entries).map(entry => entry.text)).toEqual(['third'])
})

test('/memory prune rejects a non-numeric cap', async () => {
  const root = await createRoot(mounted)
  const result = await run(root, '/memory prune soon')
  expect(result.kind).toBe('error')
  expect(result.text).toContain('optional positive entry cap')
})
