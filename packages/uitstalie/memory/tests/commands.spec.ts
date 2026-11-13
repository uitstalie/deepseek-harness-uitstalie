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
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
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

test('/memory prune with kind and turn filters deletes and records the matched entries', async () => {
  const root = await createRoot(mounted)
  await appendMemoryEntry(mounted.ctx, root.session, { kind: 'open', text: 'old open', tags: ['old'], turn: 1, seq: [0, 3] })
  await appendMemoryEntry(mounted.ctx, root.session, { kind: 'open', text: 'new open', tags: ['new'], turn: 2, seq: [4, 7] })
  await appendMemoryEntry(mounted.ctx, root.session, { kind: 'decision', text: 'kept decision', turn: 3, seq: [8, 11] })

  const result = await run(root, '/memory prune --kind open --before-turn 2')
  expect(result.kind).toBe('success')
  expect(result.text).toContain('Forgot 1 memory entry')
  expect(result.text).toContain('open 1')
  const parsed = parseMemoryDocument(await readFile(memoryFilePath(project), 'utf8'))
  expect(parsed.sections.flatMap(section => section.entries).map(entry => entry.text))
    .toEqual(['new open', 'kept decision'])
})

test('/memory forget deletes by tag and refuses malformed filters', async () => {
  const root = await createRoot(mounted)
  await appendMemoryEntry(mounted.ctx, root.session, { kind: 'files', text: 'stale file', tags: ['stale'], turn: 1, seq: [0, 3] })
  await appendMemoryEntry(mounted.ctx, root.session, { kind: 'decision', text: 'kept decision', turn: 2, seq: [4, 7] })

  const removed = await run(root, '/memory forget --tag "stale"')
  expect(removed.kind).toBe('success')
  expect(removed.text).toContain('Forgot 1 memory entry')
  const parsed = parseMemoryDocument(await readFile(memoryFilePath(project), 'utf8'))
  expect(parsed.sections.flatMap(section => section.entries).map(entry => entry.text)).toEqual(['kept decision'])

  const bare = await run(root, '/memory forget')
  expect(bare.kind).toBe('error')
  expect(bare.text).toContain('at least one filter')

  const unknownKind = await run(root, '/memory forget --kind bogus')
  expect(unknownKind.kind).toBe('error')
  expect(unknownKind.text).toContain('Unknown kind')

  const missingValue = await run(root, '/memory forget --tag')
  expect(missingValue.kind).toBe('error')
  expect(missingValue.text).toContain('needs a value')

  const unbalanced = await run(root, '/memory forget --tag "unterminated')
  expect(unbalanced.kind).toBe('error')
  expect(unbalanced.text).toContain('Unbalanced quotes')

  const bothScopes = await run(root, '/memory forget --kind open --session other --all-sessions')
  expect(bothScopes.kind).toBe('error')
  expect(bothScopes.text).toContain('either --session or --all-sessions')

  const noFilter = await run(root, '/memory prune --all-sessions')
  expect(noFilter.kind).toBe('error')
  expect(noFilter.text).toContain('at least one of --kind')

  const unknownOption = await run(root, '/memory forget --wat x')
  expect(unknownOption.kind).toBe('error')
  expect(unknownOption.text).toContain('Unknown forget option')

  const badTurn = await run(root, '/memory forget --before-turn soon')
  expect(badTurn.kind).toBe('error')
  expect(badTurn.text).toContain('non-negative integer')
})

test('/memory forget reports no matches, rejects unsafe values, and accepts single-quoted labels', async () => {
  const root = await createRoot(mounted)
  await appendMemoryEntry(mounted.ctx, root.session, { kind: 'files', text: 'kept file', tags: ['stale'], turn: 1, seq: [0, 3] })

  const noMatch = await run(root, '/memory forget --kind preference')
  expect(noMatch.kind).toBe('success')
  expect(noMatch.text).toContain('No memory entries matched')

  const emptyTag = await run(root, '/memory forget --tag ""')
  expect(emptyTag.kind).toBe('error')
  expect(emptyTag.text).toContain('tag must not be empty')

  const unsafeTurn = await run(root, '/memory forget --before-turn 99999999999999999999')
  expect(unsafeTurn.kind).toBe('error')
  expect(unsafeTurn.text).toContain('safe integer range')

  const emptySession = await run(root, '/memory forget --session ""')
  expect(emptySession.kind).toBe('error')
  expect(emptySession.text).toContain('needs a session id')

  const missing = await run(root, '/memory forget --tag')
  expect(missing.kind).toBe('error')
  expect(missing.text).toContain('needs a value')

  const removed = await run(root, '/memory forget --tag \'stale\'')
  expect(removed.kind).toBe('success')
  expect(removed.text).toContain('Forgot 1 memory entry')
  const parsed = parseMemoryDocument(await readFile(memoryFilePath(project), 'utf8'))
  expect(parsed.sections).toEqual([])
})

test('/memory forget can target another session or every session', async () => {
  const root = await createRoot(mounted)
  const otherId = SessionId('other-session')
  const other = Session.create(otherId, undefined, {
    version: SESSION_FORMAT_VERSION,
    id: otherId,
    createdAt: 0,
    isSeeded: false,
    cwd: project,
  })
  await appendMemoryEntry(mounted.ctx, root.session, { kind: 'decision', text: 'current fact', turn: 1, seq: [0, 3] })
  await appendMemoryEntry(mounted.ctx, other, { kind: 'decision', text: 'other fact', turn: 1, seq: [0, 3] })

  const targeted = await run(root, '/memory forget --kind decision --session other-session')
  expect(targeted.kind).toBe('success')
  expect(targeted.text).toContain('Forgot 1 memory entry')
  let parsed = parseMemoryDocument(await readFile(memoryFilePath(project), 'utf8'))
  expect(parsed.sections.flatMap(section => section.entries).map(entry => entry.text)).toEqual(['current fact'])

  const all = await run(root, '/memory forget --kind decision --all-sessions')
  expect(all.kind).toBe('success')
  expect(all.text).toContain('Forgot 1 memory entry')
  parsed = parseMemoryDocument(await readFile(memoryFilePath(project), 'utf8'))
  expect(parsed.sections).toEqual([])
})

test('/memory prune with no argument applies the configured cap and forget removes several entries', async () => {
  const root = await createRoot(mounted)
  await appendMemoryEntry(mounted.ctx, root.session, { kind: 'open', text: 'one', turn: 1, seq: [0, 3] })
  await appendMemoryEntry(mounted.ctx, root.session, { kind: 'open', text: 'two', turn: 2, seq: [4, 7] })

  const pruned = await run(root, '/memory prune')
  expect(pruned.kind).toBe('success')
  expect(pruned.text).toContain('Pruned')

  const removed = await run(root, '/memory  forget   --kind  open')
  expect(removed.kind).toBe('success')
  expect(removed.text).toContain('Forgot 2 memory entries')
})

test('/memory prune rejects a non-numeric cap', async () => {
  const root = await createRoot(mounted)
  const result = await run(root, '/memory prune soon')
  expect(result.kind).toBe('error')
  expect(result.text).toContain('optional positive entry cap')

  const zero = await run(root, '/memory prune 0')
  expect(zero.kind).toBe('error')
  expect(zero.text).toContain('positive integer')
})
