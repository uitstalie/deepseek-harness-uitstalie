/**
 * Snapshot tests: the durable memory snapshot message, its declared source, the
 * window manifest and cross-session index, the append-then-replace lifecycle,
 * the restart path, and the byte budget. The composition is the same real
 * AgentLoop, organizer, and store the provider tests mount.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  createMemoryDocument,
  MEMORY_DOCUMENT_VERSION,
  MEMORY_SNAPSHOT_HINT,
  MEMORY_SNAPSHOT_MAX_BYTES,
  MEMORY_SNAPSHOT_SECTION_NAME,
  MEMORY_SNAPSHOT_TITLE,
  renderMemorySnapshot,
  syncMemorySnapshot,
} from '../src/index.ts'
import type { MemoryDocument } from '../src/index.ts'
import {
  callTool,
  createRoot,
  memorySnapshots,
  messageText,
  mountMemory,
  signal,
  textOf,
} from './harness.ts'
import type { MemoryTestHarness, ObservedSnapshot } from './harness.ts'

let project: string
let contexts: Context[]

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'dsh-memory-snapshot-'))
  // A `.git` marker makes the fixture look like a checkout, so project-root
  // discovery resolves to the fixture rather than to the temp directory above it.
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

/** Text of one snapshot message, joined from its content blocks. */
function snapshotText(snapshot: ObservedSnapshot): string {
  return messageText(snapshot.message)
}

/** Byte length of a rendered snapshot. */
function snapshotBytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** A document with compressed ranges, a forgotten pointer, and three other sessions. */
function documentFixture(): MemoryDocument {
  return {
    version: MEMORY_DOCUMENT_VERSION,
    window: { detail: 6, brief: 16, forget: 21, sessions: 10 },
    sessions: [
      {
        id: 'current',
        cwd: '/workspace',
        updatedAt: '2026-10-22T08:00:00.000Z',
        turns: [
          { turn: 7, seq: [10, 20], tier: 'detail' },
          { turn: 8, seq: [21, 30], tier: 'detail' },
          { turn: 9, seq: [31, 40], tier: 'detail' },
          { turn: 10, seq: [41, 50], tier: 'detail' },
          { turn: 17, seq: [51, 60], tier: 'brief' },
          { turn: 18, seq: [61, 70], tier: 'brief' },
          { turn: 19, seq: [71, 80], tier: 'brief' },
          { turn: 20, seq: [81, 90], tier: 'brief' },
        ],
        forgottenThrough: 20,
      },
      { id: 'session-newest', cwd: '/workspace', updatedAt: '2026-10-22T07:00:00.000Z', turns: [] },
      { id: 'session-middle', cwd: '/workspace', updatedAt: '2026-10-22T06:00:00.000Z', turns: [] },
      { id: 'session-oldest', cwd: '/workspace', updatedAt: '2026-10-22T05:00:00.000Z', turns: [] },
    ],
    sections: [
      {
        sessionId: 'current',
        startTurn: 7,
        endTurn: 10,
        tier: 'detail',
        entries: [{ kind: 'decision', text: 'current detail' }],
      },
      {
        sessionId: 'session-newest',
        startTurn: 3,
        endTurn: 3,
        tier: 'detail',
        entries: [{ kind: 'files', text: `newest ${'N'.repeat(400)}` }],
      },
      {
        sessionId: 'session-middle',
        startTurn: 2,
        endTurn: 2,
        tier: 'detail',
        entries: [{ kind: 'open', text: `middle ${'M'.repeat(400)}` }],
      },
      {
        sessionId: 'session-oldest',
        startTurn: 1,
        endTurn: 1,
        tier: 'detail',
        entries: [{ kind: 'preference', text: `oldest ${'O'.repeat(400)}` }],
      },
    ],
    frame: { before: '\n', after: '\n' },
  }
}

/** The window manifest the fixture renders for the current session. */
const FIXTURE_MANIFEST = 'Window: turns 7–10 summarized (detail), turns 17–20 (brief); '
  + 'turns through 20 are removed from context and searchable.'

test('an empty document produces no snapshot and no message', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)

  expect(renderMemorySnapshot(createMemoryDocument(), root.session.id)).toBeUndefined()
  await syncMemorySnapshot(mounted.ctx, root, signal)

  expect(await memorySnapshots(mounted.ctx, root.session.id)).toEqual([])
})

test('a write appends exactly one snapshot with the window manifest and the hint', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)
  expect(await memorySnapshots(mounted.ctx, root.session.id)).toEqual([])

  const result = await callTool(mounted.ctx, root, 'memory_write', {
    kind: 'decision',
    content: 'record a durable conclusion',
  })

  expect(result.isError, textOf(result)).toBe(false)
  const snapshots = await memorySnapshots(mounted.ctx, root.session.id)
  expect(snapshots).toHaveLength(1)
  const [snapshot] = snapshots
  expect(snapshot?.source.kind).toBe('memory')
  expect(snapshot?.source.form).toBe('snapshot')
  expect(snapshot?.source.sections.map(section => section.name)).toEqual([MEMORY_SNAPSHOT_SECTION_NAME])
  const text = snapshot === undefined ? '' : snapshotText(snapshot)
  expect(snapshot?.source.sections[0]?.text).toBe(text)
  expect(text).toContain(MEMORY_SNAPSHOT_TITLE)
  expect(text).toContain('Window: turn 1 summarized (detail).')
  expect(text).toContain(MEMORY_SNAPSHOT_HINT)
  expect(snapshotBytes(text)).toBeLessThanOrEqual(MEMORY_SNAPSHOT_MAX_BYTES)
})

test('a second write replaces the existing snapshot instead of appending another', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)

  await callTool(mounted.ctx, root, 'memory_write', { kind: 'decision', content: 'first conclusion' })
  const [first] = await memorySnapshots(mounted.ctx, root.session.id)

  await callTool(mounted.ctx, root, 'memory_write', { kind: 'open', content: 'second conclusion' })
  const snapshots = await memorySnapshots(mounted.ctx, root.session.id)

  expect(first).toBeDefined()
  expect(snapshots).toHaveLength(1)
  expect(snapshots[0]?.seq).toBeGreaterThan(first?.seq ?? SessionSeq(0))
  expect(snapshots[0]?.source.form).toBe('snapshot')
})

test('a provider mounted over a session that already has a snapshot replaces it once', async () => {
  const mounted = await mount()
  const first = await createRoot(mounted, 'memory-first')
  await callTool(mounted.ctx, first, 'memory_write', {
    kind: 'decision',
    content: 'keep the store path relative',
  })

  const staleText = 'stale snapshot from a previous process'
  const stale = createUserMessage({
    content: [{ type: 'text', text: staleText }],
    source: {
      kind: 'memory',
      form: 'snapshot',
      sections: [{ name: MEMORY_SNAPSHOT_SECTION_NAME, text: staleText }],
    },
  })
  const seed: SessionEvent[] = [
    { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    { type: 'user/message', seq: SessionSeq(1), time: 2, data: stale, surfaceOp: 'append' },
  ]
  const handle = await mounted.ctx.agents.create({
    sessionId: SessionId('memory-restart'),
    seed,
    meta: { cwd: project },
  })

  await vi.waitFor(async () => {
    const observed = await memorySnapshots(mounted.ctx, handle.agent.session.id)
    expect(observed.at(-1)?.seq).toBeGreaterThan(SessionSeq(1))
  })
  const restored = await memorySnapshots(mounted.ctx, handle.agent.session.id)
  expect(restored).toHaveLength(1)
  expect(snapshotText(restored[0]!)).toContain('- memory-first · [decision] keep the store path relative')
  expect(restored[0]?.source.sections[0]?.text).toBe(snapshotText(restored[0]!))

  await vi.waitFor(() => {
    expect(mounted.ctx.tools.get('memory_write', handle.agent)).toBeDefined()
  })
  const before = restored[0]?.seq ?? SessionSeq(0)
  const result = await callTool(mounted.ctx, handle.agent, 'memory_write', {
    kind: 'open',
    content: 'the restart path writes again',
  })
  expect(result.isError, textOf(result)).toBe(false)
  const written = await memorySnapshots(mounted.ctx, handle.agent.session.id)
  expect(written).toHaveLength(1)
  expect(written[0]?.seq).toBeGreaterThan(before)
  await handle.dispose()
})

test('the snapshot indexes other sessions of this workspace', async () => {
  const mounted = await mount()
  const other = await createRoot(mounted, 'memory-other')
  await callTool(mounted.ctx, other, 'memory_write', {
    kind: 'files',
    content: 'touched packages/uitstalie/memory/src/snapshot.ts',
  })
  const writer = await createRoot(mounted, 'memory-writer')
  // A brand-new session has no surface, so the startup hook does not inject
  // ahead of the system prompt; the first write supplies the snapshot.
  expect(await memorySnapshots(mounted.ctx, writer.session.id)).toEqual([])
  await callTool(mounted.ctx, writer, 'memory_write', {
    kind: 'decision',
    content: 'the writer records its own conclusion',
  })

  const [snapshot] = await memorySnapshots(mounted.ctx, writer.session.id)
  const text = snapshot === undefined ? '' : snapshotText(snapshot)
  expect(text).toContain('Window: turn 1 summarized (detail).')
  expect(text).toContain('- memory-other · [files] touched packages/uitstalie/memory/src/snapshot.ts')
  expect(snapshotBytes(text)).toBeLessThanOrEqual(MEMORY_SNAPSHOT_MAX_BYTES)
})

test('the index is truncated before the window manifest under a byte budget', () => {
  const document = documentFixture()
  const full = renderMemorySnapshot(document, 'current')
  expect(full).toBeDefined()
  expect(full).toContain(FIXTURE_MANIFEST)
  expect(full).toContain('- session-newest · [files] newest')
  expect(full).toContain('- session-middle · [open] middle')
  expect(full).toContain('- session-oldest · [preference] oldest')
  expect(snapshotBytes(full ?? '')).toBeLessThanOrEqual(MEMORY_SNAPSHOT_MAX_BYTES)

  const oneLine = renderMemorySnapshot(document, 'current', 800)
  expect(oneLine).toContain(FIXTURE_MANIFEST)
  expect(snapshotBytes(oneLine ?? '')).toBeLessThanOrEqual(800)
  expect(indexLines(oneLine ?? '')).toHaveLength(1)

  const noLines = renderMemorySnapshot(document, 'current', 300)
  expect(noLines).toContain(FIXTURE_MANIFEST)
  expect(snapshotBytes(noLines ?? '')).toBeLessThanOrEqual(300)
  expect(indexLines(noLines ?? '')).toHaveLength(0)
})

test('the index prefers a session title and falls back to the session id', () => {
  const document = documentFixture()
  const text = renderMemorySnapshot(document, 'current', MEMORY_SNAPSHOT_MAX_BYTES, new Map([
    ['session-newest', 'Fix the memory budget'],
  ]))
  expect(text).toContain('- Fix the memory budget · [files] newest')
  expect(text).toContain('- session-middle · [open] middle')
})

test('a snapshot failure never fails the committed write', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)
  const readSurface = vi.spyOn(mounted.ctx.sessionQuery, 'readSurface')
    .mockRejectedValue(new Error('surface unavailable'))
  const warn = vi.spyOn(mounted.ctx.logger, 'warn')

  const result = await callTool(mounted.ctx, root, 'memory_write', {
    kind: 'decision',
    content: 'the write must stay committed',
  })

  expect(result.isError, textOf(result)).toBe(false)
  expect(textOf(result)).toContain('Recorded a decision memory entry')
  expect(warn).toHaveBeenCalledWith(
    'memory: could not update the memory snapshot: %s',
    'surface unavailable',
  )
  readSurface.mockRestore()
  expect(await memorySnapshots(mounted.ctx, root.session.id)).toEqual([])
})

/** Lines of one rendered text that start a cross-session index entry. */
function indexLines(text: string): readonly string[] {
  return text.split('\n').filter(line => line.startsWith('- '))
}
