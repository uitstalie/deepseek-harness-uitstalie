/**
 * Surface checkpoint tests: a real Agent/session, store, and session-query
 * composition around synthetic turn events. They cover raw-range replacement,
 * replacing the previous checkpoint at the forget age, refusing a range with a
 * compaction checkpoint, and leaving a memory snapshot untouched.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { compactCheckpointSource } from '@deepseek-ai/dsh-compaction/checkpoint'
import { FsError } from '@deepseek-ai/dsh-fs'
import { createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import {
  appendTurnSummary,
  isMemoryCheckpointSource,
  migrateMemoryTiers,
  parseMemoryDocument,
  refreshMemorySnapshot,
} from '../src/index.ts'
import type { MemoryCheckpointWindow, MemoryEntry, MemoryNoticeSource } from '../src/index.ts'
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
