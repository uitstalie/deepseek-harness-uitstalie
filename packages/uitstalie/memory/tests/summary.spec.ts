/**
 * Summary job tests: the real AgentLoop, organizer, store, session query, and
 * local job registry around a stub model adapter. They assert the completed-turn
 * trigger, the detail section and snapshot it writes, the one-pending-pass
 * dedupe, defensive JSON parsing, the one-notice failure path, cancellation, and
 * the unavailable-registry guard.
 */
import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createToolResultMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import {
  appendMemoryEntry,
  appendTurnSummary,
  isMemoryCheckpointSource,
  MEMORY_SUMMARY_FAILURE_NOTICE,
  MEMORY_SUMMARY_JOB_KIND,
  MEMORY_SUMMARY_JOB_LABEL,
  parseBriefEntries,
  parseMemoryDocument,
  parseSummaryEntries,
} from '../src/index.ts'
import type { MemoryEntry } from '../src/index.ts'
import {
  appendAssistantText,
  appendUserText,
  createRoot,
  memoryFilePath,
  memoryNotices,
  memorySnapshots,
  mountMemory,
  settle,
  waitForValue,
} from './harness.ts'
import type { MemoryMountOptions, MemoryTestHarness } from './harness.ts'

/** Routed model target the fixture agents carry. */
const ROUTE = { provider: 'stub', model: 'stub-model' }

/** A model reply produced for one call, or the error the call throws. */
type Reply = string | Error

let project: string
let contexts: Context[]

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'dsh-memory-summary-'))
  // A `.git` marker makes the fixture look like a checkout, so project-root
  // discovery resolves to the fixture rather than to the temp directory above it.
  await mkdir(join(project, '.git'), { recursive: true })
  contexts = []
})

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await rm(project, { recursive: true, force: true })
})

/** Stub model adapter that records every request and can block on a gate. */
class SummaryAdapter extends LlmAdapter {
  /** Every request the runtime dispatched, in call order. */
  readonly requests: GenerateOptions[] = []
  /** Highest number of streams that ran at the same time. */
  maxInFlight = 0
  private inFlight = 0

  constructor(
    private readonly reply: (call: number) => Reply,
    private readonly gate?: Promise<void>,
  ) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    this.inFlight += 1
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    try {
      await waitForGate(this.gate, options.signal)
      const reply = this.reply(this.requests.length)
      if (reply instanceof Error) throw reply
      yield { type: 'text-delta', index: 0, text: reply }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } finally {
      this.inFlight -= 1
    }
  }
}

/** Await an optional gate, releasing early when the request is cancelled. */
async function waitForGate(gate: Promise<void> | undefined, signal: AbortSignal | undefined): Promise<void> {
  if (gate === undefined) return
  if (signal === undefined) {
    await gate
    return
  }
  await new Promise<void>((resolve) => {
    const done = (): void => {
      signal.removeEventListener('abort', done)
      resolve()
    }
    if (signal.aborted) {
      done()
      return
    }
    signal.addEventListener('abort', done, { once: true })
    void gate.then(done, done)
  })
}

/** Build one deferred promise and its resolver. */
function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
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
function completeTurn(agent: Agent, turn: number, user = `request ${String(turn)}`, answer = `answer ${String(turn)}`): void {
  appendUserText(agent, user)
  appendAssistantText(agent, turn, answer)
  agent.session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** Wait until the session log holds the expected number of settled memory jobs. */
async function waitForSettledJobs(agent: Agent, count: number) {
  return waitForValue(() => {
    const settled = agent.session.snapshotEvents()
      .filter(event => event.type === 'job/settled')
      .map(event => event.data)
    return settled.length >= count ? settled : undefined
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

/** The JSON reply that carries the given entries. */
function jsonReply(entries: readonly MemoryEntry[]): string {
  return JSON.stringify({ entries })
}

test('a completed turn runs one memory job that appends a detail section and refreshes the snapshot', async () => {
  const mounted = await mount()
  const adapter = new SummaryAdapter(() => jsonReply([
    { kind: 'decision', text: 'keep the version-guarded write' },
    { kind: 'files', text: 'packages/uitstalie/memory/src/summary.ts' },
  ]))
  registerAdapter(mounted, adapter)
  const root = await createRoot(mounted, 'memory-root', 1, ROUTE)

  completeTurn(root, 1, 'summarize this turn', 'the job wrote a section')
  const jobs = await waitForSettledJobs(root, 1)

  expect(jobs).toHaveLength(1)
  expect(jobs[0]).toMatchObject({ kind: MEMORY_SUMMARY_JOB_KIND, label: MEMORY_SUMMARY_JOB_LABEL, status: 'completed' })
  await waitForValue(() => mounted.ctx.jobs.list(root.id).length === 0 ? true : undefined)
  const text = await waitForMemoryFile()
  expect(text).toContain('## memory-root · turn 1–1（detail）')
  expect(text).toContain('- [decision] keep the version-guarded write')
  expect(text).toContain('- [files] packages/uitstalie/memory/src/summary.ts')
  const document = parseMemoryDocument(text)
  expect(document.sessions).toHaveLength(1)
  expect(document.sessions[0]?.id).toBe('memory-root')
  expect(document.sessions[0]?.turns).toEqual([
    { turn: 1, seq: [expect.any(Number), expect.any(Number)], tier: 'detail' },
  ])
  expect(document.sections[0]).toMatchObject({ sessionId: 'memory-root', startTurn: 1, endTurn: 1, tier: 'detail' })
  expect(adapter.requests).toHaveLength(1)
  const prompt = adapter.requests[0]?.messages.at(-1)?.content
  expect(prompt).toHaveLength(1)
  const block = prompt?.[0]
  expect(block?.type).toBe('text')
  const promptText = block?.type === 'text' ? block.text : ''
  expect(promptText).toContain('[user] summarize this turn')
  expect(promptText).toContain('[assistant] the job wrote a section')

  const snapshots = await memorySnapshots(mounted.ctx, root.id)
  expect(snapshots).toHaveLength(1)
  expect(snapshots[0]?.source.form).toBe('snapshot')
  const snapshotText = snapshots[0]?.message.content
    .flatMap(block => block.type === 'text' ? [block.text] : []).join('') ?? ''
  expect(snapshotText).toContain('turn 1 summarized (detail)')
})

test('an aborted turn does not start a summary job', async () => {
  const mounted = await mount()
  const adapter = new SummaryAdapter(() => jsonReply([{ kind: 'decision', text: 'never written' }]))
  registerAdapter(mounted, adapter)
  const root = await createRoot(mounted, 'memory-root', 1, ROUTE)

  appendUserText(root, 'cancelled request')
  appendAssistantText(root, 1, 'cancelled answer')
  root.session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  await settle()
  await settle()

  expect(adapter.requests).toHaveLength(0)
  expect(mounted.ctx.jobs.list(root.id)).toHaveLength(0)
  await expect(stat(memoryFilePath(project))).rejects.toThrow()
})

test('two rapid completed turns keep one pending pass and never overlap', async () => {
  const mounted = await mount()
  const gate = deferred()
  const adapter = new SummaryAdapter(
    call => jsonReply([{ kind: 'open', text: `summarized call ${String(call)}` }]),
    gate.promise,
  )
  registerAdapter(mounted, adapter)
  const root = await createRoot(mounted, 'memory-root', 1, ROUTE)

  completeTurn(root, 1)
  await waitForValue(() => adapter.requests.length === 1 ? true : undefined)
  expect(mounted.ctx.jobs.list(root.id)).toHaveLength(1)

  root.session.append('turn/start', { turn: 2 })
  completeTurn(root, 2)
  await settle()
  expect(adapter.requests).toHaveLength(1)

  gate.resolve()
  const jobs = await waitForSettledJobs(root, 2)
  expect(jobs).toHaveLength(2)
  expect(adapter.requests).toHaveLength(2)
  expect(adapter.maxInFlight).toBe(1)

  const document = parseMemoryDocument(await waitForMemoryFile())
  expect(document.sections).toHaveLength(1)
  expect(document.sections[0]).toMatchObject({ startTurn: 1, endTurn: 2, tier: 'detail' })
  expect(document.sections[0]?.entries.map(entry => entry.text)).toEqual([
    'summarized call 1',
    'summarized call 2',
  ])
  expect(document.sessions[0]?.turns.map(turn => turn.turn)).toEqual([1, 2])
})

test('invalid JSON falls back to one decision entry with the raw output', async () => {
  const mounted = await mount()
  const adapter = new SummaryAdapter(() => 'the model ignored the JSON instruction')
  registerAdapter(mounted, adapter)
  const root = await createRoot(mounted, 'memory-root', 1, ROUTE)

  completeTurn(root, 1)
  await waitForSettledJobs(root, 1)

  const text = await waitForMemoryFile()
  expect(text).toContain('- [decision] the model ignored the JSON instruction')
  expect(parseMemoryDocument(text).sections[0]?.entries).toEqual([
    { kind: 'decision', text: 'the model ignored the JSON instruction' },
  ])
  expect(await memoryNotices(mounted.ctx, root.id)).toHaveLength(0)
})

test('a model failure appends one notice, leaves MEMORY.md unchanged, and never duplicates the notice', async () => {
  const mounted = await mount()
  const adapter = new SummaryAdapter(() => new Error('stub model exploded'))
  registerAdapter(mounted, adapter)
  const root = await createRoot(mounted, 'memory-root', 1, ROUTE)

  await appendMemoryEntry(mounted.ctx, root.session, {
    kind: 'decision',
    text: 'the previous memory survives',
    turn: 1,
    seq: [0, 0],
  })
  const before = await readFile(memoryFilePath(project), 'utf8')

  completeTurn(root, 1)
  const first = await waitForSettledJobs(root, 1)
  expect(first[0]?.status).toBe('failed')
  await waitForValue(async () => (await memoryNotices(mounted.ctx, root.id)).length === 1 ? true : undefined)

  const afterFirst = await readFile(memoryFilePath(project), 'utf8')
  expect(afterFirst).toBe(before)
  const notices = await memoryNotices(mounted.ctx, root.id)
  expect(notices).toHaveLength(1)
  expect(notices[0]?.source).toMatchObject({ kind: 'memory', form: 'notice' })
  expect(notices[0]?.content).toEqual([{ type: 'text', text: MEMORY_SUMMARY_FAILURE_NOTICE }])

  root.session.append('turn/start', { turn: 2 })
  completeTurn(root, 2)
  const second = await waitForSettledJobs(root, 2)
  expect(second.map(job => job.status)).toEqual(['failed', 'failed'])
  expect(adapter.requests).toHaveLength(2)
  expect(await memoryNotices(mounted.ctx, root.id)).toHaveLength(1)
  expect(await readFile(memoryFilePath(project), 'utf8')).toBe(before)
})

test('the configured summary pair wins over the routed target', async () => {
  const mounted = await mount({
    config: { summarizationProvider: 'stub', summarizationModel: 'stub-model' },
  })
  const adapter = new SummaryAdapter(() => jsonReply([{ kind: 'decision', text: 'configured target' }]))
  registerAdapter(mounted, adapter)
  // This route has no adapter; only the configured pair can complete the call.
  const root = await createRoot(mounted, 'memory-root', 1, { provider: 'unregistered', model: 'missing' })

  completeTurn(root, 1)
  await waitForSettledJobs(root, 1)

  expect(await waitForMemoryFile()).toContain('- [decision] configured target')
  expect(adapter.requests[0]).toMatchObject({ provider: 'stub', model: 'stub-model' })
})

test('a cancelled job writes nothing and appends no notice', async () => {
  const mounted = await mount()
  const gate = deferred()
  const adapter = new SummaryAdapter(
    () => jsonReply([{ kind: 'decision', text: 'cancelled summary' }]),
    gate.promise,
  )
  registerAdapter(mounted, adapter)
  const root = await createRoot(mounted, 'memory-root', 1, ROUTE)

  completeTurn(root, 1)
  await waitForValue(() => adapter.requests.length === 1 ? true : undefined)
  const [job] = mounted.ctx.jobs.list(root.id)
  expect(job).toBeDefined()
  if (job === undefined) throw new Error('expected a running memory job')
  expect(mounted.ctx.jobs.kill(job.id, root.id)).toBe('requested')

  gate.resolve()
  const jobs = await waitForSettledJobs(root, 1)
  expect(jobs[0]?.status).toBe('killed')
  await expect(stat(memoryFilePath(project))).rejects.toThrow()
  expect(await memoryNotices(mounted.ctx, root.id)).toHaveLength(0)
})

test('a composition without a job registry does not throw or write', async () => {
  const mounted = await mount({ jobs: false })
  const adapter = new SummaryAdapter(() => jsonReply([{ kind: 'decision', text: 'never written' }]))
  registerAdapter(mounted, adapter)
  const root = await createRoot(mounted, 'memory-root', 1, ROUTE)

  completeTurn(root, 1)
  await settle()
  await settle()

  expect(mounted.ctx.get('jobs')).toBeUndefined()
  expect(mounted.ctx.dafeiyu.status()).toEqual([])
  expect(adapter.requests).toHaveLength(0)
  await expect(stat(memoryFilePath(project))).rejects.toThrow()
})

test('a registry without an attached controller skips the turn without a notice', async () => {
  const mounted = await mount({ controller: false })
  const adapter = new SummaryAdapter(() => jsonReply([{ kind: 'decision', text: 'never written' }]))
  registerAdapter(mounted, adapter)
  const root = await createRoot(mounted, 'memory-root', 1, ROUTE)

  completeTurn(root, 1)
  await settle()
  await settle()

  expect(mounted.ctx.jobs.list(root.id)).toHaveLength(0)
  expect(adapter.requests).toHaveLength(0)
  expect(await memoryNotices(mounted.ctx, root.id)).toHaveLength(0)
  await expect(stat(memoryFilePath(project))).rejects.toThrow()
})

test('the model input keeps the conversation surface and bounds every text', async () => {
  const mounted = await mount()
  const adapter = new SummaryAdapter(() => jsonReply([{ kind: 'decision', text: 'bounded input' }]))
  registerAdapter(mounted, adapter)
  const root = await createRoot(mounted, 'memory-root', 1, ROUTE)

  appendUserText(root, 'U'.repeat(5000))
  const callId = ToolCallId('call-1')
  root.session.append('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: '{}' })
  root.session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId,
      content: [{ type: 'text', text: 'tool-output-secret' }],
      isError: false,
    }),
  }, { surfaceOp: 'append' })
  appendAssistantText(root, 1, 'the tool finished')
  for (let index = 0; index < 12; index += 1) {
    appendUserText(root, `${String(index)}:${'x'.repeat(3000)}`)
  }
  root.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await waitForSettledJobs(root, 1)

  const block = adapter.requests[0]?.messages.at(-1)?.content[0]
  const prompt = block?.type === 'text' ? block.text : ''
  const transcript = prompt.slice(prompt.indexOf('Turn transcript:'))
  expect(transcript).toContain('[tool] bash: ok')
  expect(transcript).not.toContain('tool-output-secret')
  expect(transcript).toContain('[input truncated to 24 KiB]')
  expect(Buffer.byteLength(transcript, 'utf8')).toBeLessThanOrEqual(24 * 1024 + 'Turn transcript:\n\n'.length)
  const keptUpper = (transcript.match(/U/gu) ?? []).length
  expect(keptUpper).toBeLessThanOrEqual(2 * 1024)
})

test('the internal summary settlement never reaches the model as a job notice', async () => {
  const mounted = await mount()
  await mounted.ctx.plugin(ToolJobs, {})
  const adapter = new SummaryAdapter(() => jsonReply([{ kind: 'decision', text: 'stay internal' }]))
  registerAdapter(mounted, adapter)
  const root = await createRoot(mounted, 'memory-root', 1, ROUTE)

  completeTurn(root, 1)
  await waitForSettledJobs(root, 1)
  await settle()
  await settle()

  const surface = await mounted.ctx.sessionQuery.readSurface(root.id)
  const jobNotices = surface.events.filter(event =>
    event.type === 'user/message' && event.data.source.kind === 'tool-jobs')
  expect(jobNotices).toEqual([])
  expect(await memoryNotices(mounted.ctx, root.id)).toEqual([])
})

test('a later completed turn compresses an old detail section into a brief checkpoint', async () => {
  const mounted = await mount()
  const adapter = new SummaryAdapter(call => call === 1
    ? jsonReply([{ kind: 'decision', text: 'turn seventeen detail' }])
    : jsonReply([{ kind: 'decision', text: 'brief turn one' }]))
  registerAdapter(mounted, adapter)
  const root = await createRoot(mounted, 'memory-root', 1, ROUTE)
  const start = root.session.snapshotEvents().find(event => event.type === 'turn/start')
  expect(start).toBeDefined()
  if (start === undefined) throw new Error('expected a turn start event')
  appendUserText(root, 'turn one request')
  appendAssistantText(root, 1, 'turn one answer')
  await appendTurnSummary(mounted.ctx, root.session, {
    turn: 1,
    seq: [start.seq, root.session.seq - 1],
    entries: [{ kind: 'decision', text: 'old detail' }],
  })

  root.session.append('turn/start', { turn: 17 })
  completeTurn(root, 17)
  await waitForSettledJobs(root, 1)

  const text = await readFile(memoryFilePath(project), 'utf8')
  const document = parseMemoryDocument(text)
  expect(document.sections).toHaveLength(2)
  expect(document.sections[0]).toMatchObject({ startTurn: 1, endTurn: 1, tier: 'brief' })
  expect(document.sections[0]?.entries).toEqual([{ kind: 'decision', text: 'brief turn one' }])
  expect(document.sections[1]).toMatchObject({ startTurn: 17, endTurn: 17, tier: 'detail' })
  expect(document.sessions[0]?.turns[0]).toMatchObject({ turn: 1, tier: 'brief' })
  expect(document.sessions[0]?.turns[0]?.checkpointSeq).toEqual(expect.any(Number))
  expect(adapter.requests).toHaveLength(2)
  const briefPrompt = adapter.requests[1]?.messages.at(-1)?.content[0]
  expect(briefPrompt?.type === 'text' ? briefPrompt.text : '').toContain('- [decision] old detail')

  const surface = await mounted.ctx.sessionQuery.readSurface(root.id)
  const checkpoint = surface.events.find(event =>
    event.type === 'user/message' && isMemoryCheckpointSource(event.data.source))
  expect(checkpoint).toBeDefined()
  expect(await memorySnapshots(mounted.ctx, root.id)).toHaveLength(1)
})

test('parseBriefEntries keeps two entries and the 160-character budget', () => {
  const entries = parseBriefEntries(JSON.stringify({
    entries: [
      { kind: 'decision', text: 'a'.repeat(120) },
      { kind: 'open', text: 'b'.repeat(120) },
      { kind: 'files', text: 'dropped' },
    ],
  }))
  expect(entries).toHaveLength(2)
  expect(entries.map(entry => entry.kind)).toEqual(['decision', 'open'])
  expect(entries.reduce((total, entry) => total + entry.text.length, 0)).toBe(160)
  expect(() => parseBriefEntries('no json here')).toThrow(/no valid entries/)
})

test('parseSummaryEntries accepts fenced JSON, drops invalid entries, and bounds the count', () => {
  const fenced = '```json\n{"entries":['
    + '{"kind":"decision","text":"one"},'
    + '{"kind":"bogus","text":"two"},'
    + '{"kind":"files","text":""},'
    + '{"kind":"open","text":"three"},'
    + '{"kind":"preference","text":"four"},'
    + '{"kind":"files","text":"five"}'
    + ']}\n```'
  expect(parseSummaryEntries(fenced)).toEqual([
    { kind: 'decision', text: 'one' },
    { kind: 'open', text: 'three' },
    { kind: 'preference', text: 'four' },
    { kind: 'files', text: 'five' },
  ])
  expect(parseSummaryEntries('no json here')).toEqual([
    { kind: 'decision', text: 'no json here' },
  ])
  expect(parseSummaryEntries(JSON.stringify({ entries: [{ kind: 'decision', text: 'x'.repeat(400) }] }))[0]?.text)
    .toHaveLength(300)
})
