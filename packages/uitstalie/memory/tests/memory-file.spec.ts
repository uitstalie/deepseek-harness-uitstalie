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
  MEMORY_BLOCK_BEGIN,
  MEMORY_BLOCK_END,
  MEMORY_STORE_PATH,
  parseMemoryDocument,
  readMemoryDocument,
  renderMemoryDocument,
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

test('a current session over the budget on its own still fails loudly', async () => {
  const seed = seedText('Hand-written note.')
  await store.writeFile(session, MEMORY_STORE_PATH, seed)
  await expect(appendMemoryEntry(ctx, session, {
    kind: 'decision', text: 'z'.repeat(200), turn: 1, seq: [1, 2],
  }, undefined, { window: ONE_SESSION, maxBytes: 50 })).rejects.toThrow(/after dropping older sessions/u)
  expect(await readFile(memoryFile(), 'utf8')).toBe(seed)
})
