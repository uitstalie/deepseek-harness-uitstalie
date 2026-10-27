/**
 * Surface checkpoint tests: a real Agent/session, store, and session-query
 * composition around synthetic turn events. They cover raw-range replacement,
 * replacing the previous checkpoint at the forget age, refusing a range with a
 * compaction checkpoint, and leaving a memory snapshot untouched.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { compactCheckpointSource } from '@deepseek-ai/dsh-compaction/checkpoint'
import { FsError } from '@deepseek-ai/dsh-fs'
import { createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import {
  appendTurnSummary,
  isMemoryCheckpointSource,
  migrateMemoryTiers,
  parseMemoryDocument,
  refreshMemorySnapshot,
} from '../src/index.ts'
import type { MemoryCheckpointWindow, MemoryEntry, MemoryNoticeSource } from '../src/index.ts'
import { renderMemoryDocument } from '../src/memory-file.ts'
import type { MemoryDocument } from '../src/memory-file.ts'
import {
  appendAssistantText,
  appendUserText,
  memoryFilePath,
  mountMemory,
  signal,
} from './harness.ts'
import type { MemoryTestHarness } from './harness.ts'

/** Routed model target the fixture agents carry. */
const ROUTE = { provider: 'stub', model: 'stub-model' }

/** Detail entries the seeded turn stores. */
const DETAIL: readonly MemoryEntry[] = [
  { kind: 'decision', text: 'keep the version guard' },
  { kind: 'files', text: 'src/memory-file.ts' },
]

/** Brief entries the compressor returns. */
const BRIEF: readonly MemoryEntry[] = [{ kind: 'decision', text: 'keep the guard' }]

/** One checkpoint observed on a live surface. */
interface ObservedCheckpoint {
  /** Seq of the surface node carrying the checkpoint. */
  readonly seq: SessionSeq
  /** Model-facing checkpoint message. */
  readonly message: UserMessage
  /** Checkpoint source with its turn window. */
  readonly source: MemoryNoticeSource & { readonly window: MemoryCheckpointWindow }
}

let project: string
let contexts: Context[]

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'dsh-memory-checkpoint-'))
  await mkdir(join(project, '.git'), { recursive: true })
  contexts = []
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await rm(project, { recursive: true, force: true })
})

/** Mount the real composition and return its helpers. */
async function mount(): Promise<MemoryTestHarness> {
  const ctx = new Context()
  contexts.push(ctx)
  return mountMemory(ctx, project)
}

/** One seeded turn: the agent, its seq range, and the surface's last seq. */
interface SeededTurn {
  readonly mounted: MemoryTestHarness
  readonly root: Awaited<ReturnType<MemoryTestHarness['harness']['create']>>
  readonly seq: readonly [number, number]
}

/** Create one synthetic turn with a user and assistant message, then seed its detail summary. */
async function seedDetail(mounted: MemoryTestHarness): Promise<SeededTurn> {
  const root = await mounted.harness.create(SessionId('memory-root'), ROUTE, { cwd: project })
  const start = root.session.append('turn/start', { turn: 1 })
  appendUserText(root, 'turn one request')
  const callId = ToolCallId('call-1')
  root.session.append('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: '{}' })
  root.session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId,
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    }),
  }, { surfaceOp: 'append' })
  appendAssistantText(root, 1, 'turn one answer')
  const seq: readonly [number, number] = [start.seq, root.session.seq - 1]
  await appendTurnSummary(mounted.ctx, root.session, { turn: 1, seq, entries: DETAIL })
  return { mounted, root, seq }
}

/** Read every memory checkpoint from a live surface. */
async function checkpoints(mounted: MemoryTestHarness, sessionId: string): Promise<ObservedCheckpoint[]> {
  const surface = await mounted.ctx.sessionQuery.readSurface(SessionId(sessionId))
  const observed: ObservedCheckpoint[] = []
  for (const event of surface.events) {
    if (event.type !== 'user/message' || !isMemoryCheckpointSource(event.data.source)) continue
    const source = event.data.source
    if (source.kind !== 'memory' || source.form !== 'notice' || source.window === undefined) continue
    observed.push({
      seq: event.seq,
      message: event.data,
      source: source as MemoryNoticeSource & { readonly window: MemoryCheckpointWindow },
    })
  }
  return observed
}

/** Message text of one user message. */
function textOf(message: UserMessage): string {
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

test('aborting while the surface read is pending publishes no checkpoint (DH-304)', async () => {
  const mounted = await mount()
  const seeded = await seedDetail(mounted)
  const gate = Promise.withResolvers<undefined>()
  const original = mounted.ctx.sessionQuery.readSurface.bind(mounted.ctx.sessionQuery)
  let readStarted = false
  vi.spyOn(mounted.ctx.sessionQuery, 'readSurface').mockImplementation(async (sessionId) => {
    readStarted = true
    await gate.promise
    return await original(sessionId)
  })
  const controller = new AbortController()

  const running = migrateMemoryTiers(mounted.ctx, seeded.root.session, 17, () => Promise.resolve(BRIEF), controller.signal, {
    window: { detail: 6, brief: 16, forget: 21, sessions: 10 },
  })
  for (let attempt = 0; attempt < 200 && !readStarted; attempt += 1) {
    await new Promise<void>((resolve) => { setTimeout(resolve, 1) })
  }
  controller.abort()
  gate.resolve(undefined)
  const result = await running

  // The document commit still records the brief tier, and the next pass may replace the
  // surface; the invariant is that no checkpoint was published after the abort.
  expect(result).toMatchObject({ briefed: 1 })
  expect(await checkpoints(mounted, 'memory-root')).toHaveLength(0)
  const document = parseMemoryDocument(await readFile(memoryFilePath(project), 'utf8'))
  expect(document.sections[0]).toMatchObject({ tier: 'brief' })
  expect(document.sessions[0]?.turns[0]?.checkpointSeq).toBeUndefined()
})

test('a brief migration replaces the raw turn range with a checkpoint', async () => {
  const mounted = await mount()
  const seeded = await seedDetail(mounted)
  const writes = vi.spyOn(mounted.ctx.fs, 'writeText')
  const compress = vi.fn(() => Promise.resolve(BRIEF))

  const result = await migrateMemoryTiers(mounted.ctx, seeded.root.session, 17, compress, signal, {
    window: { detail: 6, brief: 16, forget: 21, sessions: 10 },
  })

  expect(result).toMatchObject({ path: 'memory/sessions/MEMORY.md', briefed: 1, forgotten: 0 })
  expect(writes).toHaveBeenCalledTimes(1)
  expect(compress).toHaveBeenCalledTimes(1)
  const document = parseMemoryDocument(await readFile(memoryFilePath(project), 'utf8'))
  expect(document.sections).toEqual([{
    sessionId: 'memory-root',
    startTurn: 1,
    endTurn: 1,
    tier: 'brief',
    entries: BRIEF,
  }])
  const checkpoint = document.sessions[0]?.turns[0]
  expect(checkpoint).toMatchObject({ turn: 1, tier: 'brief' })
  expect(checkpoint?.checkpointSeq).toEqual(expect.any(Number))

  const observed = await checkpoints(mounted, 'memory-root')
  expect(observed).toHaveLength(1)
  expect(observed[0]?.seq).toBe(checkpoint?.checkpointSeq)
  expect(observed[0]?.source.window).toEqual({ from: 1, to: 1, tier: 'brief' })
  expect(textOf(observed[0]!.message)).toBe('- [decision] keep the guard')

  const surface = await mounted.ctx.sessionQuery.readSurface(SessionId('memory-root'))
  expect(surface.events.some(event =>
    event.type === 'user/message' && event.data.source.kind === 'user')).toBe(false)
  expect(surface.events.some(event => event.type === 'assistant/message')).toBe(false)
})

test('the forget age replaces the previous checkpoint with one pointer', async () => {
  const mounted = await mount()
  const seeded = await seedDetail(mounted)
  await migrateMemoryTiers(mounted.ctx, seeded.root.session, 17, () => Promise.resolve(BRIEF), signal, {
    window: { detail: 6, brief: 16, forget: 21, sessions: 10 },
  })
  const briefCheckpoint = (await checkpoints(mounted, 'memory-root'))[0]
  expect(briefCheckpoint).toBeDefined()

  const writes = vi.spyOn(mounted.ctx.fs, 'writeText')
  const result = await migrateMemoryTiers(mounted.ctx, seeded.root.session, 22, () => Promise.resolve(BRIEF), signal, {
    window: { detail: 6, brief: 16, forget: 21, sessions: 10 },
  })

  expect(result).toMatchObject({ briefed: 0, forgotten: 1 })
  expect(writes).toHaveBeenCalledTimes(1)
  const document = parseMemoryDocument(await readFile(memoryFilePath(project), 'utf8'))
  expect(document.sections).toEqual([])
  expect(document.sessions[0]?.forgottenThrough).toBe(1)
  const pointer = document.sessions[0]?.turns[0]?.checkpointSeq
  expect(pointer).toEqual(expect.any(Number))
  expect(pointer).not.toBe(briefCheckpoint?.seq)

  const observed = await checkpoints(mounted, 'memory-root')
  expect(observed).toHaveLength(1)
  expect(observed[0]?.seq).toBe(pointer)
  expect(observed[0]?.source.window).toEqual({ from: 1, to: 1, tier: 'brief' })
  expect(textOf(observed[0]!.message)).toContain('Memory pointer:')
  expect(textOf(observed[0]!.message)).toContain('left the context')
})

test('a section spanning turns splits when only the older turns cross the brief age', async () => {
  const mounted = await mount()
  const root = await mounted.harness.create(SessionId('memory-root'), ROUTE, { cwd: project })
  for (const turnNumber of [1, 2, 3]) {
    const start = root.session.append('turn/start', { turn: turnNumber })
    appendUserText(root, `turn ${turnNumber} request`)
    appendAssistantText(root, turnNumber, `turn ${turnNumber} answer`)
    await appendTurnSummary(mounted.ctx, root.session, {
      turn: turnNumber,
      seq: [start.seq, root.session.seq - 1],
      entries: [{ kind: 'decision', text: `turn ${turnNumber} conclusion` }],
    })
  }
  const compressedRanges: string[] = []
  const result = await migrateMemoryTiers(
    mounted.ctx,
    root.session,
    18,
    (range, entries) => {
      compressedRanges.push(`${String(range.startTurn)}-${String(range.endTurn)}:${entries.map(entry => entry.text).join('|')}`)
      return Promise.resolve([{ kind: 'decision', text: 'older turns compressed' }])
    },
    signal,
    { window: { detail: 6, brief: 16, forget: 21, sessions: 10 } },
  )

  expect(result).toMatchObject({ briefed: 1, forgotten: 0 })
  expect(compressedRanges).toEqual(['1-2:turn 1 conclusion|turn 2 conclusion'])
  const document = parseMemoryDocument(await readFile(memoryFilePath(project), 'utf8'))
  expect(document.sections.map(section => [section.startTurn, section.endTurn, section.tier]))
    .toEqual([[1, 2, 'brief'], [3, 3, 'detail']])
  expect(document.sections[1]?.entries.map(entry => entry.turn)).toEqual([3])
  expect(document.sessions[0]?.turns.map(turnRecord => [turnRecord.turn, turnRecord.tier]))
    .toEqual([[1, 'brief'], [2, 'brief'], [3, 'detail']])
  const observed = await checkpoints(mounted, 'memory-root')
  expect(observed).toHaveLength(1)
  expect(observed[0]?.source.window).toEqual({ from: 1, to: 2, tier: 'brief' })
})

test('the forget and brief boundaries split the same section in one pass', async () => {
  const mounted = await mount()
  const root = await mounted.harness.create(SessionId('memory-root'), ROUTE, { cwd: project })
  for (const turnNumber of [1, 2, 3]) {
    const start = root.session.append('turn/start', { turn: turnNumber })
    appendUserText(root, `turn ${turnNumber} request`)
    appendAssistantText(root, turnNumber, `turn ${turnNumber} answer`)
    await appendTurnSummary(mounted.ctx, root.session, {
      turn: turnNumber,
      seq: [start.seq, root.session.seq - 1],
      entries: [{ kind: 'open', text: `turn ${turnNumber} conclusion` }],
    })
  }

  const result = await migrateMemoryTiers(
    mounted.ctx,
    root.session,
    22,
    () => Promise.resolve([{ kind: 'open', text: 'turns two and three compressed' }]),
    signal,
    { window: { detail: 6, brief: 16, forget: 21, sessions: 10 } },
  )

  expect(result).toMatchObject({ briefed: 1, forgotten: 1, retried: 0 })
  const document = parseMemoryDocument(await readFile(memoryFilePath(project), 'utf8'))
  expect(document.sections.map(section => [section.startTurn, section.endTurn, section.tier]))
    .toEqual([[2, 3, 'brief']])
  expect(document.sessions[0]?.forgottenThrough).toBe(1)
  const observed = await checkpoints(mounted, 'memory-root')
  expect(observed.map(checkpoint => checkpoint.source.window))
    .toEqual(expect.arrayContaining([
      { from: 1, to: 1, tier: 'detail' },
      { from: 2, to: 3, tier: 'brief' },
    ]))
})

test('a compaction checkpoint landing during compression does not disturb the checkpoint', async () => {
  const mounted = await mount()
  const seeded = await seedDetail(mounted)
  const secondStart = seeded.root.session.append('turn/start', { turn: 2 })
  appendUserText(seeded.root, 'turn two request')
  appendAssistantText(seeded.root, 2, 'turn two answer')
  const secondSeq: readonly [number, number] = [secondStart.seq, seeded.root.session.seq - 1]
  await appendTurnSummary(mounted.ctx, seeded.root.session, {
    turn: 2,
    seq: secondSeq,
    entries: [{ kind: 'open', text: 'turn two conclusion' }],
  })

  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const migration = migrateMemoryTiers(
    mounted.ctx,
    seeded.root.session,
    17,
    async () => {
      await gate
      return BRIEF
    },
    signal,
    { window: { detail: 6, brief: 16, forget: 21, sessions: 10 } },
  )

  // Compaction rewrites the other turn's surface nodes while the brief compression is pending.
  const before = await mounted.ctx.sessionQuery.readSurface(SessionId('memory-root'))
  const turnTwoNodes = before.events.filter(event => event.seq >= secondSeq[0] && event.seq <= secondSeq[1])
  expect(turnTwoNodes.length).toBeGreaterThan(0)
  seeded.root.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'turn two compacted' }],
    source: compactCheckpointSource(CompactionId('compaction-2')),
  }), {
    surfaceOp: {
      op: 'replace',
      startSeq: SessionSeq(turnTwoNodes[0]!.seq),
      endSeq: SessionSeq(turnTwoNodes.at(-1)!.seq),
    },
    sourceEventSeqs: turnTwoNodes.map(event => SessionSeq(event.seq)),
  })
  release()
  const result = await migration

  expect(result).toMatchObject({ briefed: 1, forgotten: 0, retried: 0 })
  const observed = await checkpoints(mounted, 'memory-root')
  expect(observed).toHaveLength(1)
  expect(observed[0]?.source.window).toEqual({ from: 1, to: 1, tier: 'brief' })
  const document = parseMemoryDocument(await readFile(memoryFilePath(project), 'utf8'))
  expect(document.sections.map(section => [section.startTurn, section.tier])).toEqual([[1, 'brief'], [2, 'detail']])
  const surface = await mounted.ctx.sessionQuery.readSurface(SessionId('memory-root'))
  expect(surface.events.some(event =>
    event.type === 'user/message' && event.data.source.kind === 'compact-checkpoint')).toBe(true)
})

test('a range carrying a compaction checkpoint is refused and stays untouched', async () => {
  const mounted = await mount()
  const root = await mounted.harness.create(SessionId('memory-root'), ROUTE, { cwd: project })
  const start = root.session.append('turn/start', { turn: 1 })
  appendUserText(root, 'turn one request')
  root.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'compaction summary' }],
    source: compactCheckpointSource(CompactionId('compaction-1')),
  }), { surfaceOp: 'append' })
  appendAssistantText(root, 1, 'turn one answer')
  const seq: readonly [number, number] = [start.seq, root.session.seq - 1]
  await appendTurnSummary(mounted.ctx, root.session, { turn: 1, seq, entries: DETAIL })

  const result = await migrateMemoryTiers(mounted.ctx, root.session, 17, () => Promise.resolve(BRIEF), signal, {
    window: { detail: 6, brief: 16, forget: 21, sessions: 10 },
  })

  expect(result).toMatchObject({ briefed: 1, forgotten: 0 })
  expect(await checkpoints(mounted, 'memory-root')).toEqual([])
  const surface = await mounted.ctx.sessionQuery.readSurface(SessionId('memory-root'))
  expect(surface.events.some(event =>
    event.type === 'user/message' && event.data.source.kind === 'compact-checkpoint')).toBe(true)
  expect(parseMemoryDocument(await readFile(memoryFilePath(project), 'utf8')).sections[0]?.tier).toBe('brief')
})

test('a replacement skipped by an earlier pass is retried without re-compressing', async () => {
  const mounted = await mount()
  const seeded = await seedDetail(mounted)
  const before = parseMemoryDocument(await readFile(memoryFilePath(project), 'utf8'))
  // Simulate the earlier pass: the body is already brief, but the surface replacement was
  // refused, so the turn records carry no checkpoint seq.
  const downgraded: MemoryDocument = {
    ...before,
    sections: before.sections.map(section => section.sessionId === 'memory-root'
      ? { ...section, tier: 'brief' as const, entries: BRIEF }
      : section),
    sessions: before.sessions.map(record => record.id === 'memory-root'
      ? { ...record, turns: record.turns.map(turnRecord => ({ ...turnRecord, tier: 'brief' as const })) }
      : record),
  }
  await writeFile(memoryFilePath(project), renderMemoryDocument(downgraded))
  const writes = vi.spyOn(mounted.ctx.fs, 'writeText')

  const result = await migrateMemoryTiers(
    mounted.ctx,
    seeded.root.session,
    17,
    () => Promise.reject(new Error('a retry must not compress again')),
    signal,
    { window: { detail: 6, brief: 16, forget: 21, sessions: 10 } },
  )

  expect(result).toMatchObject({ briefed: 0, forgotten: 0, retried: 1 })
  expect(writes).toHaveBeenCalledTimes(1)
  const observed = await checkpoints(mounted, 'memory-root')
  expect(observed).toHaveLength(1)
  expect(textOf(observed[0]!.message)).toContain('keep the guard')
  const after = parseMemoryDocument(await readFile(memoryFilePath(project), 'utf8'))
  expect(after.sessions[0]?.turns[0]?.checkpointSeq).toBe(observed[0]?.seq)

  const again = await migrateMemoryTiers(
    mounted.ctx,
    seeded.root.session,
    17,
    () => Promise.reject(new Error('a settled retry is not attempted again')),
    signal,
    { window: { detail: 6, brief: 16, forget: 21, sessions: 10 } },
  )
  expect(again).toBeUndefined()
})

test('a range carrying a memory snapshot is refused and the snapshot remains', async () => {
  const mounted = await mount()
  const seeded = await seedDetail(mounted)
  await refreshMemorySnapshot(mounted.ctx, seeded.root, signal)
  appendAssistantText(seeded.root, 1, 'more turn one work')
  const metadata = parseMemoryDocument(await readFile(memoryFilePath(project), 'utf8'))
  const snapshotSeq = (await mounted.ctx.sessionQuery.readSurface(SessionId('memory-root'))).events
    .filter(event => event.type === 'user/message'
      && event.data.source.kind === 'memory'
      && event.data.source.form === 'snapshot')
    .at(-1)?.seq
  expect(snapshotSeq).toEqual(expect.any(Number))
  const turnRecord = metadata.sessions[0]?.turns[0]
  expect(turnRecord).toBeDefined()
  if (turnRecord !== undefined) {
    await appendTurnSummary(mounted.ctx, seeded.root.session, {
      turn: 1,
      seq: [turnRecord.seq[0], seeded.root.session.seq - 1],
      entries: DETAIL,
    })
  }

  const result = await migrateMemoryTiers(mounted.ctx, seeded.root.session, 17, () => Promise.resolve(BRIEF), signal, {
    window: { detail: 6, brief: 16, forget: 21, sessions: 10 },
  })

  expect(result).toMatchObject({ briefed: 1, forgotten: 0 })
  expect(await checkpoints(mounted, 'memory-root')).toEqual([])
  const surface = await mounted.ctx.sessionQuery.readSurface(SessionId('memory-root'))
  expect(surface.events.some(event =>
    event.type === 'user/message'
      && event.data.source.kind === 'memory'
      && event.data.source.form === 'snapshot')).toBe(true)
})

test('one stale write retries without appending a second checkpoint', async () => {
  const mounted = await mount()
  const seeded = await seedDetail(mounted)
  const writes = vi.spyOn(mounted.ctx.fs, 'writeText')
  writes.mockRejectedValueOnce(new FsError('stale version', 'FS_STALE_VERSION'))

  const result = await migrateMemoryTiers(mounted.ctx, seeded.root.session, 17, () => Promise.resolve(BRIEF), signal, {
    window: { detail: 6, brief: 16, forget: 21, sessions: 10 },
  })

  expect(result).toMatchObject({ briefed: 1, forgotten: 0 })
  expect(writes).toHaveBeenCalledTimes(2)
  const observed = await checkpoints(mounted, 'memory-root')
  expect(observed).toHaveLength(1)
  const document = parseMemoryDocument(await readFile(memoryFilePath(project), 'utf8'))
  expect(document.sessions[0]?.turns[0]?.checkpointSeq).toBe(observed[0]?.seq)
})

test('a failed brief compression keeps the detail section and writes nothing', async () => {
  const mounted = await mount()
  const seeded = await seedDetail(mounted)
  const before = await readFile(memoryFilePath(project), 'utf8')
  const writes = vi.spyOn(mounted.ctx.fs, 'writeText')

  const result = await migrateMemoryTiers(
    mounted.ctx,
    seeded.root.session,
    17,
    () => Promise.reject(new Error('stub compression failed')),
    signal,
    { window: { detail: 6, brief: 16, forget: 21, sessions: 10 } },
  )

  expect(result).toBeUndefined()
  expect(writes).not.toHaveBeenCalled()
  expect(await readFile(memoryFilePath(project), 'utf8')).toBe(before)
  expect(await checkpoints(mounted, 'memory-root')).toEqual([])
})
