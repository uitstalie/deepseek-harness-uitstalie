/**
 * Growth and duplication tests for the live model surface.
 *
 * The forgetting window is measured in completed turns, so these specs answer two
 * observable questions: what the model-facing surface still holds at each age, and
 * whether a summarized turn is carried twice (its raw nodes and its summary).
 * The real AgentLoop, organizer, store, session query, and local job registry are
 * mounted around a stub model adapter, exactly like `summary.spec.ts`.
 */
import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionId as SessionIdValue, SurfaceEvent, UserMessage } from '@deepseek-ai/dsh-session'
import {
  isMemoryCheckpointSource,
  parseMemoryDocument,
} from '../src/index.ts'
import type { MemoryEntry } from '../src/index.ts'
import {
  appendAssistantText,
  appendUserText,
  createRoot,
  memoryFilePath,
  memorySnapshots,
  mountMemory,
  waitForValue,
} from './harness.ts'
import type { MemoryMountOptions, MemoryTestHarness } from './harness.ts'

/** Routed model target the fixture agents carry. */
const ROUTE = { provider: 'stub', model: 'stub-model' }

let project: string
let contexts: Context[]

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'dsh-memory-growth-'))
  await mkdir(join(project, '.git'), { recursive: true })
  contexts = []
})

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await rm(project, { recursive: true, force: true })
})

/** Stub model adapter that answers every memory call with valid JSON entries. */
class SummaryAdapter extends LlmAdapter {
  /** Every request the runtime dispatched, in call order. */
  readonly requests: GenerateOptions[] = []

  constructor(private readonly reply: (call: number) => string) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'text-delta', index: 0, text: this.reply(this.requests.length) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Mount the real composition and return its helpers. */
async function mount(options: MemoryMountOptions = {}): Promise<MemoryTestHarness> {
  const ctx = new Context()
  contexts.push(ctx)
  return mountMemory(ctx, project, options)
}

/** Register the stub adapter on a mounted composition. */
function registerAdapter(mounted: MemoryTestHarness, adapter: SummaryAdapter): void {
  mounted.ctx.llm.registerAdapter(['stub'], adapter)
}

/** Append one completed turn's user and assistant text, then close the turn. */
function completeTurn(agent: Agent, turn: number, user: string, answer: string): void {
  appendUserText(agent, user)
  appendAssistantText(agent, turn, answer)
  agent.session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** Wait until the session log holds the expected number of settled memory jobs. */
async function waitForSettledJobs(agent: Agent, count: number): Promise<void> {
  await waitForValue(() => {
    const settled = agent.session.snapshotEvents().filter(event => event.type === 'job/settled')
    return settled.length >= count ? true : undefined
  })
}

/** Wait until MEMORY.md exists and return its text. */
async function waitForMemoryFile(): Promise<string> {
  return waitForValue(async () => {
    try {
      return await readFile(memoryFilePath(project), 'utf8')
    } catch {
      return undefined
    }
  })
}

/** The JSON reply that carries one decision entry. */
function decisionReply(text: string): string {
  const entries: MemoryEntry[] = [{ kind: 'decision', text }]
  return JSON.stringify({ entries })
}

/** Text blocks of one user or assistant message. */
function contentText(message: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string {
  return message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

/** Model-facing text of one live surface: user and assistant text nodes only. */
function surfaceText(events: readonly SurfaceEvent[]): string {
  const parts: string[] = []
  for (const event of events) {
    if (event.type === 'user/message') parts.push(contentText(event.data))
    else if (event.type === 'assistant/message') parts.push(contentText(event.data.message))
  }
  return parts.join('\n')
}

/** Number of times one needle appears in the model-facing text. */
function occurrences(events: readonly SurfaceEvent[], needle: string): number {
  return surfaceText(events).split(needle).length - 1
}

/** The memory checkpoints on one live surface. */
function checkpoints(events: readonly SurfaceEvent[]): UserMessage[] {
  return events.flatMap(event =>
    event.type === 'user/message' && isMemoryCheckpointSource(event.data.source) ? [event.data] : [])
}

/** The single snapshot text on one live surface. */
async function snapshotText(mounted: MemoryTestHarness, sessionId: SessionIdValue): Promise<string> {
  const snapshots = await memorySnapshots(mounted.ctx, sessionId)
  return snapshots.map(observation => contentText(observation.message)).join('\n')
}

test('the default window replaces the raw turn with a detail checkpoint at age 6', async () => {
  const mounted = await mount()
  const adapter = new SummaryAdapter(call => decisionReply(`detail ${String(call)}`))
  registerAdapter(mounted, adapter)
  const root = await createRoot(mounted, 'memory-root', 1, ROUTE)

  completeTurn(root, 1, 'request one', 'answer one')
  await waitForSettledJobs(root, 1)

  // Age 0: the detail summary is in MEMORY.md, but the raw turn is still the only context copy.
  const fileText = await waitForMemoryFile()
  expect(fileText).toContain('## memory-root · turn 1–1（detail）')
  expect(fileText).toContain('- [decision] detail 1')
  let surface = (await mounted.ctx.sessionQuery.readSurface(root.id)).events
  expect(occurrences(surface, 'request one')).toBe(1)
  expect(occurrences(surface, 'answer one')).toBe(1)
  expect(checkpoints(surface)).toHaveLength(0)

  // Advance to age 6: the raw turn becomes one detail checkpoint.
  root.session.append('turn/start', { turn: 7 })
  completeTurn(root, 7, 'request seven', 'answer seven')
  await waitForSettledJobs(root, 2)

  surface = (await mounted.ctx.sessionQuery.readSurface(root.id)).events
  expect(occurrences(surface, 'request one')).toBe(0)
  expect(occurrences(surface, 'answer one')).toBe(0)
  expect(occurrences(surface, 'request seven')).toBe(1)
  expect(checkpoints(surface)).toHaveLength(1)
  const [checkpoint] = checkpoints(surface)
  if (checkpoint === undefined) throw new Error('expected one memory checkpoint')
  expect(checkpoint.source).toMatchObject({ kind: 'memory', form: 'notice', window: { from: 1, to: 1, tier: 'detail' } })
  expect(contentText(checkpoint)).toBe('- [decision] detail 1')
  const document = parseMemoryDocument(await readFile(memoryFilePath(project), 'utf8'))
  expect(document.sessions[0]?.turns[0]).toMatchObject({ turn: 1, tier: 'detail' })
  expect(document.sessions[0]?.turns[0]?.checkpointSeq).toEqual(expect.any(Number))
  // Snapshots are append-only now: the trunk snapshot from session start stays, and each
  // summary pass may append a newer one; the latest describes the current window.
  expect((await memorySnapshots(mounted.ctx, root.id)).length).toBeGreaterThanOrEqual(1)
  const snapshot = await snapshotText(mounted, root.id)
  expect(snapshot).toContain('turn 1 summarized (detail)')
  expect(snapshot).not.toContain('request one')
})

test('a brief checkpoint replaces the detail checkpoint node instead of appending a second copy', async () => {
  const mounted = await mount({ config: { detail: 2, brief: 3, forget: 5 } })
  const adapter = new SummaryAdapter(call => decisionReply(`summary ${String(call)}`))
  registerAdapter(mounted, adapter)
  const root = await createRoot(mounted, 'memory-root', 1, ROUTE)

  completeTurn(root, 1, 'request one', 'answer one')
  await waitForSettledJobs(root, 1)
  root.session.append('turn/start', { turn: 3 })
  completeTurn(root, 3, 'request three', 'answer three')
  await waitForSettledJobs(root, 2)

  // Age 2: the raw turn is one detail checkpoint.
  let surface = (await mounted.ctx.sessionQuery.readSurface(root.id)).events
  expect(occurrences(surface, 'request one')).toBe(0)
  expect(checkpoints(surface)).toHaveLength(1)
  expect(checkpoints(surface)[0]?.source).toMatchObject({ window: { from: 1, to: 1, tier: 'detail' } })

  // Age 4: the detail checkpoint node becomes the brief checkpoint, and the raw turn 3
  // becomes its own detail checkpoint in the same pass.
  root.session.append('turn/start', { turn: 5 })
  completeTurn(root, 5, 'request five', 'answer five')
  await waitForSettledJobs(root, 3)

  surface = (await mounted.ctx.sessionQuery.readSurface(root.id)).events
  expect(occurrences(surface, 'request one')).toBe(0)
  expect(occurrences(surface, 'answer one')).toBe(0)
  expect(occurrences(surface, 'request three')).toBe(0)
  expect(occurrences(surface, 'request five')).toBe(1)
  const observed = checkpoints(surface)
  expect(observed.map(checkpoint => checkpoint.source)).toEqual([
    expect.objectContaining({ window: { from: 1, to: 1, tier: 'brief' } }),
    expect.objectContaining({ window: { from: 3, to: 3, tier: 'detail' } }),
  ])
  // The fourth model call compresses the turn-1 detail entries.
  expect(contentText(observed[0]!)).toBe('- [decision] summary 4')
  expect(contentText(observed[1]!)).toBe('- [decision] summary 2')
  const document = parseMemoryDocument(await readFile(memoryFilePath(project), 'utf8'))
  expect(document.sections.map(section => [section.startTurn, section.tier]))
    .toEqual([[1, 'brief'], [3, 'detail'], [5, 'detail']])
  expect(await snapshotText(mounted, root.id)).toContain('turn 1 summarized (brief)')
})
