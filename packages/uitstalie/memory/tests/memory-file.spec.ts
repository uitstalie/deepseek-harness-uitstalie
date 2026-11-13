/**
 * MEMORY.md repository tests: canonical rendering, parse/render round trips,
 * hand-written text preservation, the append path against a real filesystem
 * store, the version guard, and the body budget.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createDshStore } from '@deepseek-ai/dsh-store-atom'
import type { DshStore } from '@deepseek-ai/dsh-store-atom'
import { FsError } from '@deepseek-ai/dsh-fs'
import {
  appendMemoryEntry,
  appendTurnSummary,
  assertMemoryEntryKind,
  createMemoryDocument,
  DEFAULT_MEMORY_MAX_BYTES,
  editMemorySummary,
  forgetMemoryEntries,
  MEMORY_BLOCK_BEGIN,
  MEMORY_BLOCK_END,
  MEMORY_STORE_PATH,
  parseMemoryDocument,
  pruneMemorySession,
  pruneSessionEntries,
  readMemoryDocument,
  readMemorySummaryHistory,
  renderMemoryDocument,
  revertMemorySummary,
  setMemorySummaryPaused,
  summarizeMemoryEntries,
  summaryPaused,
} from '../src/memory-file.ts'
import type { MemoryDocument, MemoryWindow } from '../src/memory-file.ts'

let project: string
let ctx: Context
let store: DshStore
let session: Session

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'dsh-memory-file-'))
  // A `.git` marker makes the fixture look like a checkout, so project-root
  // discovery resolves to the fixture rather than to the temp directory above it.
  await mkdir(join(project, '.git'), { recursive: true })
  ctx = new Context()
  await ctx.plugin(LocalFileSystem, { cwd: project })
  store = createDshStore(ctx, false)
  ctx.provide('dshStore', store)
  const id = SessionId('session-a')
  session = Session.create(id, undefined, {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 0,
    isSeeded: false,
    cwd: project,
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await ctx.fiber.dispose()
  await rm(project, { recursive: true, force: true })
})

/** Absolute path of the fixture MEMORY.md. */
function memoryFile(): string {
  return join(project, '.dsh', 'memory', 'sessions', 'MEMORY.md')
}

/** A canonical empty document with hand-written text around the managed block. */
function seedText(note: string): string {
  const empty = renderMemoryDocument(createMemoryDocument())
  return `${empty.replace(MEMORY_BLOCK_BEGIN, `${note}\n\n${MEMORY_BLOCK_BEGIN}`)}Trailing note.\n`
}

test('a canonical empty document carries the pinned frontmatter and markers', () => {
  const text = renderMemoryDocument(createMemoryDocument())
  expect(text).toBe([
    '---',
    'version: 1',
    'window: { detail: 6, brief: 16, forget: 21, sessions: 10 }',
    'sessions: []',
    '---',
    '',
    '<!-- memory:begin -->',
    '',
    '<!-- memory:end -->',
    '',
  ].join('\n'))
})

test('parse and render round-trip the file byte for byte', () => {
  const text = seedText('Hand-written note before the block.')
  expect(renderMemoryDocument(parseMemoryDocument(text))).toBe(text)
})

test('parse recovers frontmatter machine state and managed entries', () => {
  const document: MemoryDocument = {
    version: 1,
    window: { detail: 6, brief: 16, forget: 21, sessions: 10 },
    sessions: [{
      id: 'session-a',
      cwd: '/work/project',
      updatedAt: '2026-10-21T00:00:00.000Z',
      turns: [{ turn: 7, seq: [181, 240], tier: 'detail', checkpointSeq: 512 }],
      forgottenThrough: 21,
    }],
    sections: [{
      sessionId: 'session-a',
      startTurn: 7,
      endTurn: 10,
      tier: 'detail',
      entries: [
        { kind: 'decision', text: 'keep the store path relative', turn: 7, tags: ['dh-8', 'store'] },
        { kind: 'files', text: 'src/memory-file.ts', turn: 9 },
      ],
    }],
    frame: { before: '\n', after: '\n' },
  }
  expect(parseMemoryDocument(renderMemoryDocument(document))).toEqual(document)
})

test('an append creates the session record, a section, and the entry line', async () => {
  await store.writeFile(session, MEMORY_STORE_PATH, seedText('Hand-written note before the block.'))
  const written = await appendMemoryEntry(ctx, session, {
    kind: 'decision',
    text: 'write through the version-guarded store',
    turn: 3,
    seq: [10, 20],
  })

  expect(written).toMatchObject({ path: MEMORY_STORE_PATH, kind: 'decision' })
  expect(written.version).toEqual(expect.any(String))
  const text = await readFile(memoryFile(), 'utf8')
  expect(text).toContain('## session-a · turn 3–3（detail）')
  expect(text).toContain('- [decision] write through the version-guarded store')

  const parsed = parseMemoryDocument(text)
  expect(parsed.sections).toEqual([{
    sessionId: 'session-a',
    startTurn: 3,
    endTurn: 3,
    tier: 'detail',
    entries: [{ kind: 'decision', text: 'write through the version-guarded store', turn: 3 }],
  }])
  const record = parsed.sessions[0]
  expect(record?.id).toBe('session-a')
  expect(record?.cwd).toBe(project)
  expect(record?.turns).toEqual([{ turn: 3, seq: [10, 20], tier: 'detail' }])
  expect(Number.isNaN(Date.parse(record?.updatedAt ?? ''))).toBe(false)
})

test('an append records normalized labels and parses them back', async () => {
  await store.writeFile(session, MEMORY_STORE_PATH, seedText('Hand-written note before the block.'))
  await appendMemoryEntry(ctx, session, {
    kind: 'open',
    text: 'follow up',
    tags: ['dh-8', ' memory ', 'dh-8', ''],
    turn: 2,
    seq: [5, 9],
  })

  const text = await readFile(memoryFile(), 'utf8')
  expect(text).toContain('- [open] follow up <!-- turn: 2 --> <!-- tags: dh-8, memory -->')
  const entries = parseMemoryDocument(text).sections.at(-1)?.entries
  expect(entries).toEqual([{ kind: 'open', text: 'follow up', turn: 2, tags: ['dh-8', 'memory'] }])
})

test('an entry line written before labels existed keeps its text', async () => {
  const text = seedText('note')
    .replace('<!-- memory:end -->', [
      '## session-a · turn 1–1（detail）',
      '- [decision] a line that merely mentions <!-- tags: --> in prose',
      '- [open] an older line with no turn',
      '- [files] a malformed turn marker <!-- turn: nine -->',
      '<!-- memory:end -->',
    ].join('\n'))
  const entries = parseMemoryDocument(text).sections[0]?.entries
  expect(entries).toEqual([
    { kind: 'decision', text: 'a line that merely mentions <!-- tags: --> in prose' },
    { kind: 'open', text: 'an older line with no turn' },
    { kind: 'files', text: 'a malformed turn marker <!-- turn: nine -->' },
  ])
})

test('append preserves the hand-written text around the managed block', async () => {
  const seed = seedText('Hand-written note before the block.')
  await store.writeFile(session, MEMORY_STORE_PATH, seed)
  await appendMemoryEntry(ctx, session, { kind: 'open', text: 'follow up', turn: 2, seq: [5, 9] })

  const text = await readFile(memoryFile(), 'utf8')
  const parsed = parseMemoryDocument(text)
  expect(parsed.frame.before).toBe(parseMemoryDocument(seed).frame.before)
  expect(parsed.frame.after).toContain('Trailing note.')
  expect(text.startsWith('---\nversion: 1\n')).toBe(true)
})

test('appends in the same turn share one section; a later turn starts another', async () => {
  await appendMemoryEntry(ctx, session, { kind: 'decision', text: 'first', turn: 3, seq: [10, 20] })
  await appendMemoryEntry(ctx, session, { kind: 'open', text: 'second', turn: 3, seq: [10, 20] })
  let parsed = parseMemoryDocument(await readFile(memoryFile(), 'utf8'))
  expect(parsed.sections).toHaveLength(1)
  expect(parsed.sections[0]?.entries.map(entry => entry.kind)).toEqual(['decision', 'open'])

  await appendMemoryEntry(ctx, session, { kind: 'preference', text: 'third', turn: 4, seq: [21, 30] })
  parsed = parseMemoryDocument(await readFile(memoryFile(), 'utf8'))
  expect(parsed.sections).toHaveLength(2)
  expect(parsed.sessions[0]?.turns.map(turn => turn.turn)).toEqual([3, 4])
})

test('a turn summary appends one detail section and extends consecutive turns', async () => {
  const first = await appendTurnSummary(ctx, session, {
    turn: 3,
    seq: [10, 20],
    entries: [
      { kind: 'decision', text: 'keep the version guard' },
      { kind: 'files', text: 'src/summary.ts' },
    ],
  })
  expect(first).toMatchObject({ path: MEMORY_STORE_PATH, turn: 3, entries: 2 })
  let parsed = parseMemoryDocument(await readFile(memoryFile(), 'utf8'))
  expect(parsed.sections).toEqual([{
    sessionId: 'session-a',
    startTurn: 3,
    endTurn: 3,
    tier: 'detail',
    entries: [
      { kind: 'decision', text: 'keep the version guard', turn: 3 },
      { kind: 'files', text: 'src/summary.ts', turn: 3 },
    ],
  }])
  expect(parsed.sessions[0]?.turns).toEqual([{ turn: 3, seq: [10, 20], tier: 'detail' }])

  await appendTurnSummary(ctx, session, {
    turn: 4,
    seq: [21, 30],
    entries: [{ kind: 'open', text: 'next step' }],
  })
  parsed = parseMemoryDocument(await readFile(memoryFile(), 'utf8'))
  expect(parsed.sections).toHaveLength(1)
  expect(parsed.sections[0]).toMatchObject({ startTurn: 3, endTurn: 4 })
  expect(parsed.sections[0]?.entries.map(entry => entry.text))
    .toEqual(['keep the version guard', 'src/summary.ts', 'next step'])
  expect(parsed.sessions[0]?.turns.map(turn => [turn.turn, turn.seq]))
    .toEqual([[3, [10, 20]], [4, [21, 30]]])
})

test('a turn summary without entries is rejected before touching the file', async () => {
  await expect(appendTurnSummary(ctx, session, { turn: 1, seq: [1, 2], entries: [] }))
    .rejects.toMatchObject({ code: 'empty-summary' })
  await expect(readMemoryDocument(ctx, session)).resolves.toEqual({ path: MEMORY_STORE_PATH })
})

test('an unknown kind rejects with the registry list', () => {
  expect(() => assertMemoryEntryKind('bogus'))
    .toThrow('unknown memory entry kind "bogus"; valid kinds: decision, files, open, preference')
  const text = renderMemoryDocument(createMemoryDocument()).replace(
    MEMORY_BLOCK_END,
    `## session-a · turn 1–1（detail）\n- [bogus] not a kind\n${MEMORY_BLOCK_END}`,
  )
  expect(() => parseMemoryDocument(text)).toThrow(/valid kinds: decision, files, open, preference/)
})

test('a missing file reads as absent and the first append creates it', async () => {
  expect(await readMemoryDocument(ctx, session)).toEqual({ path: MEMORY_STORE_PATH })
  await appendMemoryEntry(ctx, session, { kind: 'decision', text: 'created', turn: 1, seq: [1, 2] })
  const read = await readMemoryDocument(ctx, session)
  expect(read.document?.sections[0]?.entries).toEqual([{ kind: 'decision', text: 'created', turn: 1 }])
  expect(read.version).toEqual(expect.any(String))
})

test('one stale-version write is retried after a re-read', async () => {
  await store.writeFile(session, MEMORY_STORE_PATH, seedText('Hand-written note.'))
  const writes = vi.spyOn(ctx.fs, 'writeText')
  writes.mockRejectedValueOnce(new FsError('stale version', 'FS_STALE_VERSION'))

  const written = await appendMemoryEntry(ctx, session, {
    kind: 'decision',
    text: 'retried',
    turn: 3,
    seq: [10, 20],
  })

  expect(writes).toHaveBeenCalledTimes(2)
  expect(written.kind).toBe('decision')
  expect(await readFile(memoryFile(), 'utf8')).toContain('- [decision] retried')
})

test('a second stale-version write surfaces the failure and keeps the file', async () => {
  const seed = seedText('Hand-written note.')
  await store.writeFile(session, MEMORY_STORE_PATH, seed)
  vi.spyOn(ctx.fs, 'writeText').mockRejectedValue(new FsError('stale version', 'FS_STALE_VERSION'))

  await expect(appendMemoryEntry(ctx, session, {
    kind: 'decision',
    text: 'never written',
    turn: 3,
    seq: [10, 20],
  })).rejects.toThrow('stale version')
  expect(await readFile(memoryFile(), 'utf8')).toBe(seed)
})

test('the managed-body budget rejects an append and keeps the file', async () => {
  const seed = seedText('Hand-written note.')
  await store.writeFile(session, MEMORY_STORE_PATH, seed)

  await expect(appendMemoryEntry(ctx, session, {
    kind: 'decision',
    text: 'too large for the budget',
    turn: 3,
    seq: [10, 20],
  }, undefined, { maxBytes: 8 })).rejects.toThrow(/over the 8-byte limit/)
  expect(await readFile(memoryFile(), 'utf8')).toBe(seed)
})

/** A second session over the same project, for the retention cases. */
function otherSession(id: string): Session {
  const sessionId = SessionId(id)
  return Session.create(sessionId, undefined, {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: 0,
    isSeeded: false,
    cwd: project,
  })
}

/** Sessions limit of one, so every second session write must drop the previous one. */
const ONE_SESSION: MemoryWindow = { detail: 6, brief: 16, forget: 21, sessions: 1 }

test('the sessions window applies to the persisted file, not only to the snapshot', async () => {
  const first = session
  const second = otherSession('session-b')
  await store.writeFile(first, MEMORY_STORE_PATH, seedText('Hand-written note.'))

  await appendMemoryEntry(ctx, first, {
    kind: 'decision', text: 'first session note', turn: 1, seq: [1, 2],
  }, undefined, { window: ONE_SESSION })
  await appendMemoryEntry(ctx, second, {
    kind: 'decision', text: 'second session note', turn: 1, seq: [1, 2],
  }, undefined, { window: ONE_SESSION })

  const text = await readFile(memoryFile(), 'utf8')
  const parsed = parseMemoryDocument(text)
  expect(parsed.window.sessions).toBe(1)
  expect(parsed.sessions.map(record => record.id)).toEqual(['session-b'])
  expect(parsed.sections.map(section => section.sessionId)).toEqual(['session-b'])
  expect(text).not.toContain('first session note')
  // Trimming the machine state must not touch the hand-written frame around the block.
  expect(parsed.frame.before).toBe(parseMemoryDocument(seedText('Hand-written note.')).frame.before)
  expect(parsed.frame.after).toContain('Trailing note.')
})

test('exactly the configured number of sessions is kept; one more drops the oldest', async () => {
  const window: MemoryWindow = { ...ONE_SESSION, sessions: 2 }
  const first = session
  const second = otherSession('session-b')
  const third = otherSession('session-c')

  await appendMemoryEntry(ctx, first, { kind: 'open', text: 'a', turn: 1, seq: [1, 2] }, undefined, { window })
  await appendMemoryEntry(ctx, second, { kind: 'open', text: 'b', turn: 1, seq: [1, 2] }, undefined, { window })
  let parsed = parseMemoryDocument(await readFile(memoryFile(), 'utf8'))
  expect(parsed.sessions.map(record => record.id)).toEqual(['session-a', 'session-b'])

  await appendMemoryEntry(ctx, third, { kind: 'open', text: 'c', turn: 1, seq: [1, 2] }, undefined, { window })
  parsed = parseMemoryDocument(await readFile(memoryFile(), 'utf8'))
  expect(parsed.sessions.map(record => record.id)).toEqual(['session-b', 'session-c'])
  expect(parsed.sections.map(section => section.sessionId)).toEqual(['session-b', 'session-c'])
})

test('the body budget drops the oldest retained session before failing', async () => {
  const window: MemoryWindow = { ...ONE_SESSION, sessions: 10 }
  const first = session
  const second = otherSession('session-b')
  await appendMemoryEntry(ctx, first, {
    kind: 'decision', text: 'x'.repeat(40), turn: 1, seq: [1, 2],
  }, undefined, { window, maxBytes: 4096 })

  // One section fits this budget; both do not, so the older session is dropped instead of failing.
  await appendMemoryEntry(ctx, second, {
    kind: 'decision', text: 'y'.repeat(40), turn: 1, seq: [1, 2],
  }, undefined, { window, maxBytes: 180 })

  const parsed = parseMemoryDocument(await readFile(memoryFile(), 'utf8'))
  expect(parsed.sessions.map(record => record.id)).toEqual(['session-b'])
  expect(parsed.sections.map(section => section.sessionId)).toEqual(['session-b'])
})

test('an incoming entry larger than the budget still fails loudly and keeps the file', async () => {
  const seed = seedText('Hand-written note.')
  await store.writeFile(session, MEMORY_STORE_PATH, seed)
  await expect(appendMemoryEntry(ctx, session, {
    kind: 'decision', text: 'z'.repeat(200), turn: 1, seq: [1, 2],
  }, undefined, { window: ONE_SESSION, maxBytes: 50 })).rejects.toThrow(/incoming write alone does not fit/u)
  expect(await readFile(memoryFile(), 'utf8')).toBe(seed)
})

/** UTF-8 bytes of the managed body, between the two markers. */
function bodyBytes(text: string): number {
  const start = text.indexOf(MEMORY_BLOCK_BEGIN) + MEMORY_BLOCK_BEGIN.length
  const end = text.indexOf(MEMORY_BLOCK_END, start)
  return Buffer.byteLength(text.slice(start, end), 'utf8')
}

test('an over-budget append evicts open then files and records each removal', async () => {
  const window: MemoryWindow = { ...ONE_SESSION, sessions: 10 }
  const options = { window, maxBytes: 4096, maxEntries: 10 }
  await appendMemoryEntry(ctx, session, {
    kind: 'open', text: `open ${'o'.repeat(150)}`, turn: 1, seq: [1, 2],
  }, undefined, options)
  await appendMemoryEntry(ctx, session, {
    kind: 'files', text: `files ${'f'.repeat(150)}`, turn: 2, seq: [3, 4],
  }, undefined, options)
  await appendMemoryEntry(ctx, session, {
    kind: 'decision', text: 'durable decision', turn: 3, seq: [5, 6],
  }, undefined, options)

  const before = await readFile(memoryFile(), 'utf8')
  // Forcing one compaction-sized eviction frees the two low-priority entries, not the decision.
  const written = await appendMemoryEntry(ctx, session, {
    kind: 'decision', text: 'new durable fact', turn: 4, seq: [7, 8],
  }, undefined, { ...options, maxBytes: bodyBytes(before) - 200 })

  expect(written.evictions.map(eviction => eviction.kind)).toEqual(['open', 'files'])
  expect(written.evictions.every(eviction => eviction.reason === 'byte-budget')).toBe(true)
  expect(written.evictions[0]?.text).toContain('open o')
  expect(written.evictions[0]?.detail).toContain('managed-body budget')

  const parsed = parseMemoryDocument(await readFile(memoryFile(), 'utf8'))
  const texts = parsed.sections.flatMap(section => section.entries).map(entry => entry.text)
  expect(texts).toContain('durable decision')
  expect(texts).toContain('new durable fact')
  expect(texts.some(text => text.startsWith('open '))).toBe(false)
  expect(texts.some(text => text.startsWith('files '))).toBe(false)
  expect(parsed.evictions).toHaveLength(2)
  expect(parsed.evictions?.map(eviction => eviction.kind)).toEqual(['open', 'files'])
  expect(parsed.evictions?.[0]?.at).toSatisfy((value: string) => !Number.isNaN(Date.parse(value)))
  expect(parsed.sessions[0]?.turns.map(turn => turn.turn)).toEqual([3, 4])
})

test('repeated writes keep succeeding when the body stays at its budget', async () => {
  const window: MemoryWindow = { ...ONE_SESSION, sessions: 10 }
  const options = { window, maxBytes: 320, maxEntries: 40 }
  let evicted = 0
  for (let turn = 1; turn <= 8; turn += 1) {
    const written = await appendMemoryEntry(ctx, session, {
      kind: 'open',
      text: `turn ${String(turn)} ${'x'.repeat(60)}`,
      turn,
      seq: [turn, turn + 1],
    }, undefined, options)
    evicted += written.evictions.length
  }
  const text = await readFile(memoryFile(), 'utf8')
  expect(bodyBytes(text)).toBeLessThanOrEqual(320)
  expect(text).toContain(`turn 8 ${'x'.repeat(60)}`)
  expect(evicted).toBeGreaterThan(0)
  const parsed = parseMemoryDocument(text)
  expect(parsed.evictions?.length).toBeGreaterThan(0)
  const entryTurns = new Set(parsed.sections.flatMap(section => section.entries
    .flatMap(entry => entry.turn === undefined ? [] : [entry.turn])))
  expect(parsed.sessions[0]?.turns.every(turn => entryTurns.has(turn.turn))).toBe(true)
})

test('budget eviction from a multi-entry section keeps the section and its turn record', async () => {
  const window: MemoryWindow = { ...ONE_SESSION, sessions: 10 }
  const options = { window, maxBytes: 4096, maxEntries: 40 }
  await appendMemoryEntry(ctx, session, { kind: 'open', text: `drop ${'d'.repeat(120)}`, turn: 1, seq: [1, 2] }, undefined, options)
  await appendMemoryEntry(ctx, session, { kind: 'files', text: `keep ${'k'.repeat(120)}`, turn: 1, seq: [1, 2] }, undefined, options)

  const written = await appendMemoryEntry(ctx, session, {
    kind: 'decision', text: 'new fact', turn: 2, seq: [3, 4],
  }, undefined, { ...options, maxBytes: 300 })
  expect(written.evictions).toHaveLength(1)
  expect(written.evictions[0]?.kind).toBe('open')
  const parsed = parseMemoryDocument(await readFile(memoryFile(), 'utf8'))
  expect(parsed.sections.flatMap(section => section.entries).map(entry => entry.kind)).toEqual(['files', 'decision'])
  expect(parsed.sessions[0]?.turns.map(turn => turn.turn)).toEqual([1, 2])
})

test('eviction handles a legacy section without a session record and keeps the other legacy section', async () => {
  const document: MemoryDocument = {
    ...createMemoryDocument(),
    sessions: [],
    sections: [
      { sessionId: 'session-a', startTurn: 1, endTurn: 1, tier: 'detail', entries: [{ kind: 'open', text: 'legacy one' }] },
      { sessionId: 'session-a', startTurn: 2, endTurn: 2, tier: 'detail', entries: [{ kind: 'files', text: 'legacy two' }] },
    ],
  }
  await store.writeFile(session, MEMORY_STORE_PATH, renderMemoryDocument(document))
  const written = await appendMemoryEntry(ctx, session, {
    kind: 'decision', text: 'new fact', turn: 3, seq: [5, 6],
  }, undefined, { window: { ...ONE_SESSION, sessions: 10 }, maxBytes: 160 })
  expect(written.evictions).toHaveLength(1)
  expect(written.evictions[0]?.text).toBe('legacy one')
  const parsed = parseMemoryDocument(await readFile(memoryFile(), 'utf8'))
  expect(parsed.sections.flatMap(section => section.entries).map(entry => entry.text)).toEqual(['legacy two', 'new fact'])
})

test('forget matches a legacy entry without a turn and keeps another legacy section', async () => {
  const document: MemoryDocument = {
    ...createMemoryDocument(),
    sessions: [],
    sections: [
      { sessionId: 'session-a', startTurn: 1, endTurn: 1, tier: 'detail', entries: [{ kind: 'open', text: 'legacy open' }] },
      { sessionId: 'session-a', startTurn: 2, endTurn: 2, tier: 'detail', entries: [{ kind: 'files', text: 'legacy files' }] },
    ],
  }
  await store.writeFile(session, MEMORY_STORE_PATH, renderMemoryDocument(document))
  const result = await forgetMemoryEntries(ctx, session, { kind: 'open' })
  expect(result.removed).toBe(1)
  const parsed = parseMemoryDocument(await readFile(memoryFile(), 'utf8'))
  expect(parsed.sections.flatMap(section => section.entries).map(entry => entry.text)).toEqual(['legacy files'])
})

test('eviction records survive a parse and render round trip', () => {
  const document: MemoryDocument = {
    ...createMemoryDocument(),
    evictions: [{
      at: '2026-11-13T00:00:00.000Z',
      sessionId: 'session-a',
      kind: 'open',
      turn: 2,
      text: 'an old open question',
      reason: 'byte-budget',
      detail: 'over the 16384-byte managed-body budget while writing session session-a',
    }, {
      at: '2026-11-13T00:01:00.000Z',
      sessionId: 'session-b',
      kind: 'files',
      text: 'a legacy pointer without a turn',
      reason: 'manual-forget',
      detail: 'manual forget (kind=files)',
    }],
  }
  const text = renderMemoryDocument(document)
  expect(text).toContain('evictions:')
  expect(parseMemoryDocument(text)).toEqual(document)
})

test('a malformed eviction record is rejected with its subject', () => {
  const text = renderMemoryDocument(createMemoryDocument()).replace(
    'sessions: []',
    'sessions: []\nevictions:\n  - { at: "x", sessionId: "s", kind: open, text: "t", reason: bogus, detail: "d" }',
  )
  expect(() => parseMemoryDocument(text)).toThrow(/evictions\[0\]\.reason must be/)
  const notArray = renderMemoryDocument(createMemoryDocument()).replace('sessions: []', 'sessions: []\nevictions: nope')
  expect(() => parseMemoryDocument(notArray)).toThrow(/evictions must be an array/)
})

test('forget removes only the entries matching every filter and records the reason', async () => {
  const window: MemoryWindow = { ...ONE_SESSION, sessions: 10 }
  const options = { window, maxBytes: 4096, maxEntries: 40 }
  const other = otherSession('session-b')
  await appendMemoryEntry(ctx, session, { kind: 'open', text: 'old open', tags: ['old'], turn: 1, seq: [1, 2] }, undefined, options)
  await appendMemoryEntry(ctx, session, { kind: 'open', text: 'kept open', tags: ['keep'], turn: 2, seq: [3, 4] }, undefined, options)
  await appendMemoryEntry(ctx, session, { kind: 'files', text: 'old file', tags: ['old'], turn: 3, seq: [5, 6] }, undefined, options)
  await appendMemoryEntry(ctx, session, { kind: 'decision', text: 'durable decision', turn: 4, seq: [7, 8] }, undefined, options)
  await appendMemoryEntry(ctx, other, { kind: 'open', text: 'other old', tags: ['old'], turn: 1, seq: [1, 2] }, undefined, options)

  const result = await forgetMemoryEntries(ctx, session, { kind: 'open', tag: 'old', beforeTurn: 5 })
  expect(result).toMatchObject({ removed: 1, remaining: 3, sessions: ['session-a'] })
  expect(result.kinds).toEqual({ decision: 0, files: 0, open: 1, preference: 0 })
  expect(result.evictions[0]).toMatchObject({ kind: 'open', reason: 'manual-forget' })
  expect(result.evictions[0]?.detail).toContain('kind=open')
  let parsed = parseMemoryDocument(await readFile(memoryFile(), 'utf8'))
  let texts = parsed.sections.flatMap(section => section.entries).map(entry => entry.text)
  expect(texts).toEqual(['kept open', 'old file', 'durable decision', 'other old'])

  const all = await forgetMemoryEntries(ctx, session, { tag: 'old', allSessions: true })
  expect(all.removed).toBe(2)
  expect([...all.sessions].sort()).toEqual(['session-a', 'session-b'])
  parsed = parseMemoryDocument(await readFile(memoryFile(), 'utf8'))
  texts = parsed.sections.flatMap(section => section.entries).map(entry => entry.text)
  expect(texts).toEqual(['kept open', 'durable decision'])
  expect(parsed.sessions.map(record => record.id)).toEqual(['session-a'])
})

test('forget tolerates a store read or write that reports no version', async () => {
  await appendMemoryEntry(ctx, session, { kind: 'decision', text: 'only fact', turn: 1, seq: [1, 2] })
  const text = await readFile(memoryFile(), 'utf8')
  vi.spyOn(store, 'readFile').mockResolvedValueOnce({ path: MEMORY_STORE_PATH, text })
  const noMatch = await forgetMemoryEntries(ctx, session, { kind: 'open' })
  expect(noMatch.removed).toBe(0)
  expect(noMatch.version).toBeUndefined()

  vi.spyOn(store, 'writeFile').mockResolvedValueOnce({ path: MEMORY_STORE_PATH })
  const removed = await forgetMemoryEntries(ctx, session, { kind: 'decision' })
  expect(removed.removed).toBe(1)
  expect(removed.version).toBeUndefined()
})

test('eviction ranks a section without a session record by an empty timestamp', async () => {
  const document: MemoryDocument = {
    ...createMemoryDocument(),
    sessions: [{ id: 'session-a', cwd: project, updatedAt: '2026-06-01T00:00:00.000Z', turns: [] }],
    sections: [
      { sessionId: 'ghost', startTurn: 1, endTurn: 1, tier: 'detail', entries: [{ kind: 'open', text: `ghost ${'g'.repeat(80)}` }] },
      { sessionId: 'session-a', startTurn: 1, endTurn: 1, tier: 'detail', entries: [{ kind: 'open', text: `current ${'c'.repeat(80)}` }] },
    ],
  }
  await store.writeFile(session, MEMORY_STORE_PATH, renderMemoryDocument(document))
  const written = await appendMemoryEntry(ctx, session, {
    kind: 'decision', text: 'new fact', turn: 2, seq: [3, 4],
  }, undefined, { window: { ...ONE_SESSION, sessions: 10 }, maxBytes: 300 })
  expect(written.evictions[0]?.sessionId).toBe('ghost')
})

test('forget on a missing file is refused', async () => {
  await expect(forgetMemoryEntries(ctx, session, { kind: 'open' })).rejects.toThrow(/does not exist yet/u)
})

test('forget keeps a partially matched section and removes it once empty', async () => {
  await appendMemoryEntry(ctx, session, { kind: 'open', text: 'drop me', turn: 1, seq: [1, 2] })
  await appendMemoryEntry(ctx, session, { kind: 'files', text: 'keep me', turn: 1, seq: [1, 2] })

  const partial = await forgetMemoryEntries(ctx, session, { kind: 'open' })
  expect(partial.removed).toBe(1)
  let parsed = parseMemoryDocument(await readFile(memoryFile(), 'utf8'))
  expect(parsed.sections.flatMap(section => section.entries).map(entry => entry.text)).toEqual(['keep me'])
  expect(parsed.sessions[0]?.turns.map(turn => turn.turn)).toEqual([1])

  const full = await forgetMemoryEntries(ctx, session, { kind: 'files' })
  expect(full.removed).toBe(1)
  parsed = parseMemoryDocument(await readFile(memoryFile(), 'utf8'))
  expect(parsed.sections).toEqual([])
  expect(parsed.sessions).toEqual([])
})

test('a legacy entry without a turn can be forgotten and evicted with a bounded record', async () => {
  const document: MemoryDocument = {
    ...createMemoryDocument(),
    sessions: [{
      id: 'session-a', cwd: project, updatedAt: '2026-01-01T00:00:00.000Z',
      turns: [{ turn: 1, seq: [1, 2], tier: 'detail' }],
    }],
    sections: [{
      sessionId: 'session-a', startTurn: 1, endTurn: 1, tier: 'detail',
      entries: [{ kind: 'open', text: `legacy ${'x'.repeat(250)}` }],
    }],
  }
  await store.writeFile(session, MEMORY_STORE_PATH, renderMemoryDocument(document))

  // Force the budget path: the new turn is protected, so the legacy entry is evicted.
  const written = await appendMemoryEntry(ctx, session, {
    kind: 'decision', text: 'new fact', turn: 2, seq: [3, 4],
  }, undefined, { window: ONE_SESSION, maxBytes: 300 })
  expect(written.evictions).toHaveLength(1)
  expect(written.evictions[0]?.turn).toBeUndefined()
  expect(written.evictions[0]?.text).toHaveLength(200)
  expect(written.evictions[0]?.text.endsWith('…')).toBe(true)
  const parsed = parseMemoryDocument(await readFile(memoryFile(), 'utf8'))
  expect(parsed.sections.flatMap(section => section.entries).map(entry => entry.text)).toEqual(['new fact'])
})

test('eviction prefers the older session and the automatic entry over a manual edit', async () => {
  const document: MemoryDocument = {
    ...createMemoryDocument(),
    sessions: [
      { id: 'session-a', cwd: project, updatedAt: '2026-01-01T00:00:00.000Z', turns: [{ turn: 1, seq: [1, 2], tier: 'detail' }] },
      { id: 'session-b', cwd: project, updatedAt: '2026-06-01T00:00:00.000Z', turns: [{ turn: 1, seq: [1, 2], tier: 'detail' }] },
    ],
    sections: [
      { sessionId: 'session-a', startTurn: 1, endTurn: 1, tier: 'detail', entries: [{ kind: 'open', text: `older session ${'o'.repeat(100)}` }] },
      { sessionId: 'session-b', startTurn: 1, endTurn: 1, tier: 'detail', entries: [
        { kind: 'open', text: `manual same turn ${'m'.repeat(100)}`, turn: 1, source: 'manual', version: 1 },
        { kind: 'open', text: `auto same turn ${'a'.repeat(100)}`, turn: 1 },
      ] },
    ],
  }
  await store.writeFile(session, MEMORY_STORE_PATH, renderMemoryDocument(document))
  const other = otherSession('session-b')
  const written = await appendMemoryEntry(ctx, other, {
    kind: 'decision', text: 'newest fact', turn: 2, seq: [3, 4],
  }, undefined, { window: { ...ONE_SESSION, sessions: 10 }, maxBytes: 320 })
  expect(written.evictions.map(eviction => eviction.text.slice(0, 13))).toEqual(['older session', 'auto same tur'])
  const parsed = parseMemoryDocument(await readFile(memoryFile(), 'utf8'))
  expect(parsed.sections.flatMap(section => section.entries).map(entry => entry.text.slice(0, 16)))
    .toEqual(['manual same turn', 'newest fact'])
})

test('a forget with no match leaves the file and version untouched', async () => {
  await appendMemoryEntry(ctx, session, { kind: 'decision', text: 'only fact', turn: 1, seq: [1, 2] })
  const before = await readFile(memoryFile(), 'utf8')
  const result = await forgetMemoryEntries(ctx, session, { kind: 'open' })
  expect(result).toMatchObject({ removed: 0, remaining: 1 })
  expect(await readFile(memoryFile(), 'utf8')).toBe(before)
})

test('an empty or contradictory forget filter is refused', async () => {
  await appendMemoryEntry(ctx, session, { kind: 'decision', text: 'only fact', turn: 1, seq: [1, 2] })
  await expect(forgetMemoryEntries(ctx, session, {})).rejects.toThrow(/kind, tag, or beforeTurn/u)
  await expect(forgetMemoryEntries(ctx, session, { kind: 'open', allSessions: true, sessionId: 'session-b' }))
    .rejects.toThrow(/allSessions with sessionId/u)
  await expect(forgetMemoryEntries(ctx, session, { tag: '  ' })).rejects.toThrow(/must not be empty/u)
  await expect(forgetMemoryEntries(ctx, session, { beforeTurn: -1 })).rejects.toThrow(/non-negative integer/u)
})

test('the default body budget admits more than the former 4 KiB before refusing', async () => {
  expect(DEFAULT_MEMORY_MAX_BYTES).toBe(16 * 1024)
  const seed = seedText('Hand-written note.')
  await store.writeFile(session, MEMORY_STORE_PATH, seed)
  // Six ~1 KiB entries: over the former 4 KiB default and under the 16 KiB default.
  for (let index = 0; index < 6; index += 1) {
    await appendMemoryEntry(ctx, session, {
      kind: 'files',
      text: `${String(index)}:${'x'.repeat(1000)}`,
      turn: index + 1,
      seq: [index * 10, index * 10 + 5],
    })
  }
  const text = await readFile(memoryFile(), 'utf8')
  expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(4096)
  const parsed = parseMemoryDocument(text)
  expect(parsed.sections.flatMap(section => section.entries)).toHaveLength(6)
})

test('a manual edit marks the entry manual, records history, and a revert restores it', async () => {
  await appendTurnSummary(ctx, session, {
    turn: 3,
    seq: [10, 20],
    entries: [{ kind: 'decision', text: 'auto text' }],
  })

  const edited = await editMemorySummary(ctx, session, { turn: 3 }, 'human text')
  expect(edited).toMatchObject({ turn: 3, action: 'edit', before: 'auto text', after: 'human text' })
  let parsed = parseMemoryDocument(await readFile(memoryFile(), 'utf8'))
  expect(parsed.sections[0]?.entries[0]).toMatchObject({
    text: 'human text',
    source: 'manual',
    version: 1,
  })
  expect(parsed.sections[0]?.entries[0]?.tags).toBeUndefined()

  const history = await readMemorySummaryHistory(ctx, session)
  expect(history).toHaveLength(1)
  expect(history[0]).toMatchObject({ action: 'edit', turn: 3, before: 'auto text', after: 'human text' })

  const reverted = await revertMemorySummary(ctx, session, { turn: 3 })
  expect(reverted).toMatchObject({ action: 'revert', before: 'human text', after: 'auto text' })
  parsed = parseMemoryDocument(await readFile(memoryFile(), 'utf8'))
  expect(parsed.sections[0]?.entries[0]).toMatchObject({
    text: 'auto text',
    source: 'manual',
    version: 2,
  })
})

test('pause and resume round-trip through the frontmatter', async () => {
  await setMemorySummaryPaused(ctx, session, true)
  let parsed = parseMemoryDocument(await readFile(memoryFile(), 'utf8'))
  expect(summaryPaused(parsed)).toBe(true)

  await setMemorySummaryPaused(ctx, session, false)
  parsed = parseMemoryDocument(await readFile(memoryFile(), 'utf8'))
  expect(summaryPaused(parsed)).toBe(false)
  expect(await readFile(memoryFile(), 'utf8')).not.toContain('summaryPaused')
})

test('an edit names the known turns and refuses empty text', async () => {
  await appendTurnSummary(ctx, session, {
    turn: 3,
    seq: [10, 20],
    entries: [{ kind: 'decision', text: 'auto text' }],
  })

  await expect(editMemorySummary(ctx, session, { turn: 9 }, 'x')).rejects.toThrow(/known turns: 3/u)
  await expect(editMemorySummary(ctx, session, { turn: 3 }, '   ')).rejects.toMatchObject({ code: 'empty-summary' })
})

test('a revert without a recorded edit is refused', async () => {
  await appendTurnSummary(ctx, session, {
    turn: 3,
    seq: [10, 20],
    entries: [{ kind: 'decision', text: 'auto text' }],
  })
  await expect(revertMemorySummary(ctx, session, { turn: 3 })).rejects.toThrow(/no recorded edit/u)
})

test('the new suffixes appear only after an edit and survive a parse/render round trip', async () => {
  await appendTurnSummary(ctx, session, {
    turn: 3,
    seq: [10, 20],
    entries: [{ kind: 'decision', text: 'auto text' }],
  })
  const autoText = await readFile(memoryFile(), 'utf8')
  expect(autoText).not.toContain('<!-- source:')
  expect(autoText).not.toContain('<!-- version:')

  await editMemorySummary(ctx, session, { turn: 3 }, 'human text')
  const editedText = await readFile(memoryFile(), 'utf8')
  expect(editedText).toContain('<!-- source: manual -->')
  expect(editedText).toContain('<!-- version: 1 -->')
  expect(renderMemoryDocument(parseMemoryDocument(editedText))).toBe(editedText)
})

test('duplicate entries are dropped on append and the first occurrence survives', async () => {
  await appendMemoryEntry(ctx, session, { kind: 'decision', text: 'Keep the version guard', turn: 1, seq: [1, 2] })
  await appendMemoryEntry(ctx, session, { kind: 'decision', text: 'keep   the version guard', turn: 2, seq: [3, 4] })

  const parsed = parseMemoryDocument(await readFile(memoryFile(), 'utf8'))
  const entries = parsed.sections.flatMap(section => section.entries)
  expect(entries).toHaveLength(1)
  expect(entries[0]?.text).toBe('Keep the version guard')
  expect(parsed.sessions[0]?.turns.map(turn => turn.turn)).toEqual([1])
})

test('the per-session cap keeps the newest sections and drops their turn records', async () => {
  const window: MemoryWindow = { ...ONE_SESSION, sessions: 10 }
  for (const turn of [1, 2, 3]) {
    await appendMemoryEntry(ctx, session, {
      kind: 'decision', text: `turn ${String(turn)} fact`, turn, seq: [turn, turn + 1],
    }, undefined, { window, maxEntries: 2 })
  }

  const parsed = parseMemoryDocument(await readFile(memoryFile(), 'utf8'))
  const entries = parsed.sections.flatMap(section => section.entries)
  expect(entries.map(entry => entry.text)).toEqual(['turn 2 fact', 'turn 3 fact'])
  expect(parsed.sessions[0]?.turns.map(turn => turn.turn)).toEqual([2, 3])
})

test('summarizeMemoryEntries counts sources, kinds, bytes, and the turn span', async () => {
  await appendTurnSummary(ctx, session, {
    turn: 3,
    seq: [10, 20],
    entries: [
      { kind: 'decision', text: 'auto one' },
      { kind: 'files', text: 'auto two' },
    ],
  })
  await editMemorySummary(ctx, session, { turn: 3 }, 'human one')

  const parsed = parseMemoryDocument(await readFile(memoryFile(), 'utf8'))
  const stats = summarizeMemoryEntries(parsed, String(session.id))
  expect(stats).toMatchObject({
    sessionId: 'session-a',
    entries: 2,
    auto: 1,
    manual: 1,
    turns: [3, 3],
  })
  expect(stats.kinds).toEqual({ decision: 1, files: 1, open: 0, preference: 0 })
  expect(stats.bytes).toBeGreaterThan(0)
})

test('pruneSessionEntries removes duplicates and over-cap sections in one pass', () => {
  const document = parseMemoryDocument(renderMemoryDocument(createMemoryDocument()))
  const seeded: MemoryDocument = {
    ...document,
    sessions: [{
      id: 'session-a', cwd: '/w', updatedAt: '2026-01-01T00:00:00Z',
      turns: [
        { turn: 1, seq: [1, 2], tier: 'detail' },
        { turn: 2, seq: [3, 4], tier: 'detail' },
        { turn: 3, seq: [5, 6], tier: 'detail' },
      ],
    }],
    sections: [
      { sessionId: 'session-a', startTurn: 1, endTurn: 1, tier: 'detail', entries: [{ kind: 'decision', text: 'same', turn: 1 }] },
      { sessionId: 'session-a', startTurn: 2, endTurn: 2, tier: 'detail', entries: [{ kind: 'decision', text: 'same', turn: 2 }, { kind: 'open', text: 'b', turn: 2 }] },
      { sessionId: 'session-a', startTurn: 3, endTurn: 3, tier: 'detail', entries: [{ kind: 'open', text: 'c', turn: 3 }] },
    ],
  }
  const pruned = pruneSessionEntries(seeded, 'session-a', 1)
  expect(pruned.duplicates).toBe(1)
  expect(pruned.overCap).toBeGreaterThan(0)
  const remaining = pruned.document.sections.flatMap(section => section.entries)
  expect(remaining).toHaveLength(1)
  expect(remaining[0]?.text).toBe('c')
  expect(pruned.document.sessions[0]?.turns.map(turn => turn.turn)).toEqual([3])
})

test('pruneMemorySession writes the compacted document and reports the counts', async () => {
  const base = parseMemoryDocument(renderMemoryDocument(createMemoryDocument()))
  const seeded = renderMemoryDocument({
    ...base,
    sessions: [{
      id: 'session-a', cwd: '/w', updatedAt: '2026-01-01T00:00:00Z',
      turns: [
        { turn: 1, seq: [1, 2], tier: 'detail' },
        { turn: 2, seq: [3, 4], tier: 'detail' },
        { turn: 3, seq: [5, 6], tier: 'detail' },
      ],
    }],
    sections: [
      { sessionId: 'session-a', startTurn: 1, endTurn: 1, tier: 'detail', entries: [{ kind: 'open', text: 'a', turn: 1 }] },
      { sessionId: 'session-a', startTurn: 2, endTurn: 2, tier: 'detail', entries: [{ kind: 'open', text: 'a', turn: 2 }] },
      { sessionId: 'session-a', startTurn: 3, endTurn: 3, tier: 'detail', entries: [{ kind: 'open', text: 'b', turn: 3 }] },
    ],
  })
  await store.writeFile(session, MEMORY_STORE_PATH, seeded)

  const result = await pruneMemorySession(ctx, session, { keep: 1 }, undefined, { window: ONE_SESSION, maxEntries: 10 })
  expect(result).toMatchObject({ sessionId: 'session-a', duplicates: 1, remaining: 1, keep: 1 })
  const parsed = parseMemoryDocument(await readFile(memoryFile(), 'utf8'))
  expect(parsed.sections.flatMap(section => section.entries).map(entry => entry.text)).toEqual(['b'])

  const noop = await pruneMemorySession(ctx, session, { keep: 1 }, undefined, { window: ONE_SESSION, maxEntries: 10 })
  expect(noop).toMatchObject({ duplicates: 0, overCap: 0, remaining: 1 })
})
