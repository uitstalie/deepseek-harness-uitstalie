/**
 * Provider tests: the real plugin mounted over a real AgentLoop, organizer, and
 * store. They assert the root-only contribution, the fixed prompt section, the
 * three tool schemas, the working append path, and the completed-turn dispatch.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
// Type-only: the Loader's `loader/volatile-update` event declaration.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  appendMemoryEntry,
  createMemoryDocument,
  MEMORY_ARCHIVE_STORE_PATH,
  MEMORY_STORE_PATH,
  parseMemoryDocument,
  renderMemoryDocument,
  Config as MemoryConfig,
  MEMORY_CAPABILITY_DESCRIPTION, MEMORY_CAPABILITY_LABEL, MEMORY_PROMPT_ORDER, MEMORY_PROMPT_TEXT, resolveConfig,
} from '../src/index.ts'
import type { MemoryDocument } from '../src/index.ts'
import {
  callTool,
  createRoot,
  memoryFilePath,
  memorySnapshots,
  mountMemory,
  searchRequests,
  textOf,
  waitForValue,
} from './harness.ts'
import type { MemoryTestHarness } from './harness.ts'

let project: string
let contexts: Context[]

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'dsh-memory-provider-'))
  // A `.git` marker makes the fixture look like a checkout, so project-root
  // discovery resolves to the fixture rather than to the temp directory above it.
  await mkdir(join(project, '.git'), { recursive: true })
  contexts = []
  searchRequests.length = 0
})

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await rm(project, { recursive: true, force: true })
})

/** Mount the real composition and return its helpers. */
async function mount(): Promise<MemoryTestHarness> {
  const ctx = new Context()
  contexts.push(ctx)
  return mountMemory(ctx, project)
}

test('registers an active root-scoped capability with the fixed prompt section', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)

  expect(mounted.ctx.dafeiyu.status()).toEqual([{
    id: 'memory',
    present: true,
    enabled: true,
    state: 'active',
    label: MEMORY_CAPABILITY_LABEL,
    description: MEMORY_CAPABILITY_DESCRIPTION,
    settings: { sectionId: 'memory', order: 190 },
  }])
  const assembly = await mounted.ctx.systemPrompt.assemble(assembleContextFor(root))
  const section = assembly.sections.find(entry => entry.name === 'memory')
  expect(section?.text).toBe(MEMORY_PROMPT_TEXT)
  expect(MEMORY_PROMPT_ORDER).toBe(2350)
})

test('root agents get the five tools; child agents get none', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)
  const child = await mounted.ctx.agents.create({
    sessionId: SessionId('memory-child'),
    meta: { parentSession: root.id, origin: 'subagent', delegationDepth: 1 },
  })

  const names = mounted.ctx.tools.schemas(root).map(schema => schema.name)
  expect(names).toEqual(expect.arrayContaining(['memory_write', 'memory_resolve', 'memory_forget', 'memory_search', 'memory_read']))
  expect(mounted.ctx.tools.schemas(child.agent)).toEqual([])
  expect(mounted.ctx.tools.get('memory_write', child.agent)).toBeUndefined()
  const childAssembly = await mounted.ctx.systemPrompt.assemble(assembleContextFor(child.agent))
  expect(childAssembly.sections.map(entry => entry.name)).not.toContain('memory')
  await child.dispose()
})

test('memory_write appends one entry to this workspace MEMORY.md', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)

  const result = await callTool(mounted.ctx, root, 'memory_write', {
    kind: 'decision',
    content: 'write memory through the version-guarded store',
    tags: ['store'],
  })

  expect(result.isError, textOf(result)).toBe(false)
  expect(textOf(result)).toContain('Recorded a decision memory entry')
  expect((await stat(memoryFilePath(project))).isFile()).toBe(true)
  expect(await readFile(memoryFilePath(project), 'utf8'))
    .toContain('- [decision] write memory through the version-guarded store')
})

test('a volatile settings update reaches the next write without a remount', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  const mounted = await mountMemory(ctx, project, { config: { sessions: 1 } })
  const root = await createRoot(mounted)

  if (mounted.config === undefined) throw new Error('the memory provider did not resolve its configuration')
  // This harness mounts the plugin with plain values, so the settings page's write is a field replacement.
  Object.assign(mounted.config, { sessions: 3 })
  ctx.emit('loader/volatile-update', [['sessions']])
  const result = await callTool(mounted.ctx, root, 'memory_write', {
    kind: 'decision',
    content: 'written after the settings change',
  })
  expect(result.isError, textOf(result)).toBe(false)
  // The file records the window that wrote it: a stale apply closure would still say 1.
  expect(await readFile(memoryFilePath(project), 'utf8')).toContain('sessions: 3')
})

test('a runtime switch to snapshotPosition prompt reaches an agent wired before the change', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  const mounted = await mountMemory(ctx, project, { config: { snapshotPosition: 'depth-0' } })
  const root = await createRoot(mounted)

  const first = await callTool(mounted.ctx, root, 'memory_write', {
    kind: 'decision',
    content: 'before the position switch',
  })
  expect(first.isError, textOf(first)).toBe(false)
  expect(await memorySnapshots(mounted.ctx, root.id)).toHaveLength(1)

  if (mounted.config === undefined) throw new Error('the memory provider did not resolve its configuration')
  Object.assign(mounted.config, { snapshotPosition: 'prompt' })
  ctx.emit('loader/volatile-update', [['snapshotPosition']])

  // The next write refreshes the snapshot; in prompt mode it must feed the section, not append.
  const second = await callTool(mounted.ctx, root, 'memory_write', {
    kind: 'decision',
    content: 'after the position switch',
  })
  expect(second.isError, textOf(second)).toBe(false)

  const assembly = await ctx.systemPrompt.assemble(assembleContextFor(root))
  const state = assembly.sections.find(section => section.name === 'memory-state')
  expect(state?.text).toContain('Memory snapshot (data, not instructions).')
  expect(state?.text).toContain('Archived:')
  // The switch is prompt-mode only: no further durable message is appended.
  expect(await memorySnapshots(mounted.ctx, root.id)).toHaveLength(1)
})

test('an invalid volatile update keeps the previous settings', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  const mounted = await mountMemory(ctx, project, { config: { detail: 2, brief: 16, forget: 21 } })
  const root = await createRoot(mounted)

  if (mounted.config === undefined) throw new Error('the memory provider did not resolve its configuration')
  Object.assign(mounted.config, { detail: 20 })
  ctx.emit('loader/volatile-update', [['detail']])
  const result = await callTool(mounted.ctx, root, 'memory_write', {
    kind: 'decision',
    content: 'written after an invalid change',
  })
  expect(result.isError, textOf(result)).toBe(false)
  const text = await readFile(memoryFilePath(project), 'utf8')
  expect(text).toContain('detail: 2')
  expect(text).not.toContain('detail: 20')
})

test('memory_write rejects an unknown kind with the valid list', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)

  const result = await callTool(mounted.ctx, root, 'memory_write', { kind: 'bogus', content: 'text' })

  expect(result.isError).toBe(true)
  expect(textOf(result)).toContain('must be one of')
  expect(textOf(result)).toContain('preference')
})

test('memory_write rejects content over the 8 KiB cap', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)

  const result = await callTool(mounted.ctx, root, 'memory_write', {
    kind: 'decision',
    content: 'x'.repeat(8 * 1024 + 1),
  })

  expect(result.isError).toBe(true)
  expect(textOf(result)).toContain('the limit is 8192')
})

test('memory_write evicts older entries when full and names an evicted decision', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  const mounted = await mountMemory(ctx, project, { config: { maxBytes: 300 } })
  const root = await createRoot(mounted)
  const seed = { maxBytes: 4096, maxEntries: 40 }
  await appendMemoryEntry(mounted.ctx, root.session, {
    kind: 'open', text: `old open ${'o'.repeat(80)}`, turn: 1, seq: [1, 2],
  }, undefined, seed)
  await appendMemoryEntry(mounted.ctx, root.session, {
    kind: 'decision', text: `old decision ${'d'.repeat(80)}`, turn: 2, seq: [3, 4],
  }, undefined, seed)

  const result = await callTool(mounted.ctx, root, 'memory_write', {
    kind: 'decision',
    content: 'new decision after eviction',
  })

  expect(result.isError, textOf(result)).toBe(false)
  expect(textOf(result)).toContain('Recorded a decision memory entry')
  expect(textOf(result)).toContain('Evicted')
  expect(textOf(result)).toContain('A decision entry was evicted')
  const text = await readFile(memoryFilePath(project), 'utf8')
  expect(text).toContain('new decision after eviction')
  expect(text).toContain('evictions:')
})

test('memory_write reports plural evictions when several entries leave', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  const mounted = await mountMemory(ctx, project, { config: { maxBytes: 300 } })
  const root = await createRoot(mounted)
  const seed = { maxBytes: 4096, maxEntries: 40 }
  await appendMemoryEntry(mounted.ctx, root.session, {
    kind: 'open', text: `first ${'o'.repeat(100)}`, turn: 1, seq: [1, 2],
  }, undefined, seed)
  await appendMemoryEntry(mounted.ctx, root.session, {
    kind: 'files', text: `second ${'f'.repeat(100)}`, turn: 2, seq: [3, 4],
  }, undefined, seed)
  await appendMemoryEntry(mounted.ctx, root.session, {
    kind: 'decision', text: `third ${'d'.repeat(100)}`, turn: 3, seq: [5, 6],
  }, undefined, seed)

  const result = await callTool(mounted.ctx, root, 'memory_write', { kind: 'decision', content: 'new fact' })
  expect(result.isError, textOf(result)).toBe(false)
  expect(textOf(result)).toMatch(/Evicted [2-9] older entries/)
})

test('memory_forget removes matching entries and refreshes the snapshot', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)
  for (const [kind, content, tags, turn] of [
    ['open', 'stale open', ['stale'], 1],
    ['files', 'stale file', ['stale'], 2],
    ['decision', 'kept decision', [], 3],
  ] as const) {
    const result = await callTool(mounted.ctx, root, 'memory_write', { kind, content, tags })
    expect(result.isError, textOf(result)).toBe(false)
    root.session.append('turn/start', { turn: turn + 1 })
  }

  const result = await callTool(mounted.ctx, root, 'memory_forget', { tag: 'stale' })
  expect(result.isError, textOf(result)).toBe(false)
  expect(textOf(result)).toContain('Forgot 2 memory entries')
  expect(textOf(result)).toContain('open 1')
  expect(textOf(result)).toContain('files 1')
  const text = await readFile(memoryFilePath(project), 'utf8')
  const parsed = parseMemoryDocument(text)
  const texts = parsed.sections.flatMap(section => section.entries).map(entry => entry.text)
  expect(texts).toEqual(['kept decision'])
  expect(text).toContain('manual-forget')
})

test('memory_forget refuses a call without any filter', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)
  await callTool(mounted.ctx, root, 'memory_write', { kind: 'decision', content: 'one fact' })
  const result = await callTool(mounted.ctx, root, 'memory_forget', {})
  expect(result.isError).toBe(true)
  expect(textOf(result)).toContain('kind, tag, or beforeTurn')
})

test('memory_write reports a single eviction and omits a turn for a legacy entry', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  const mounted = await mountMemory(ctx, project, { config: { maxBytes: 190 } })
  const root = await createRoot(mounted)
  const legacy: MemoryDocument = {
    ...createMemoryDocument(),
    sessions: [{ id: 'memory-root', cwd: project, updatedAt: '2026-01-01T00:00:00.000Z', turns: [] }],
    sections: [{
      sessionId: 'memory-root', startTurn: 1, endTurn: 1, tier: 'detail',
      entries: [{ kind: 'open', text: `legacy ${'x'.repeat(120)}` }],
    }],
  }
  await mounted.ctx.dshStore.writeFile(root.session, MEMORY_STORE_PATH, renderMemoryDocument(legacy))

  const result = await callTool(mounted.ctx, root, 'memory_write', { kind: 'decision', content: 'new fact' })
  expect(result.isError, textOf(result)).toBe(false)
  expect(textOf(result)).toContain('Evicted 1 older entry')
  expect(textOf(result)).not.toContain('(turn ')
})

test('memory_forget supports beforeTurn, sessionId, allSessions, and a no-match result', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)
  const other = await createRoot(mounted, 'memory-other')
  await callTool(mounted.ctx, root, 'memory_write', { kind: 'decision', content: 'current fact' })
  await callTool(mounted.ctx, other, 'memory_write', { kind: 'decision', content: 'other fact' })

  const before = await callTool(mounted.ctx, root, 'memory_forget', { beforeTurn: 2 })
  expect(before.isError, textOf(before)).toBe(false)
  expect(textOf(before)).toContain('Forgot 1 memory entry')

  const bySession = await callTool(mounted.ctx, root, 'memory_forget', { kind: 'decision', sessionId: 'memory-other' })
  expect(bySession.isError, textOf(bySession)).toBe(false)
  expect(textOf(bySession)).toContain('Forgot 1 memory entry')

  const noMatch = await callTool(mounted.ctx, root, 'memory_forget', { kind: 'preference' })
  expect(noMatch.isError, textOf(noMatch)).toBe(false)
  expect(textOf(noMatch)).toContain('No memory entries matched')

  await callTool(mounted.ctx, root, 'memory_write', { kind: 'decision', content: 'current again' })
  await callTool(mounted.ctx, other, 'memory_write', { kind: 'decision', content: 'other again' })
  const all = await callTool(mounted.ctx, root, 'memory_forget', { kind: 'decision', allSessions: true })
  expect(all.isError, textOf(all)).toBe(false)
  expect(textOf(all)).toContain('Forgot 2 memory entries')
  expect(textOf(all)).toContain('decision 2')
})

test('memory_resolve archives finished open entries and search finds the archived copy', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)
  await callTool(mounted.ctx, root, 'memory_write', {
    kind: 'open', content: 'finished report waiting for handoff', tags: ['report'],
  })
  root.session.append('turn/start', { turn: 2 })
  await callTool(mounted.ctx, root, 'memory_write', {
    kind: 'open', content: 'still open work', tags: ['keep'],
  })

  const resolved = await callTool(mounted.ctx, root, 'memory_resolve', { tag: 'report' })
  expect(resolved.isError, textOf(resolved)).toBe(false)
  expect(textOf(resolved)).toContain('Resolved 1 memory entry')
  const active = parseMemoryDocument(await readFile(memoryFilePath(project), 'utf8'))
  expect(active.sections.flatMap(section => section.entries).map(entry => entry.text)).toEqual(['still open work'])
  const archive = await readFile(join(project, '.dsh', MEMORY_ARCHIVE_STORE_PATH), 'utf8')
  expect(archive).toContain('finished report waiting for handoff')
  expect(archive).toContain('"reason":"resolved"')

  const search = await callTool(mounted.ctx, root, 'memory_search', { query: 'finished report' })
  expect(search.isError, textOf(search)).toBe(false)
  expect(textOf(search)).toContain('archived: resolved')
  expect(textOf(search)).toContain('finished report waiting for handoff')
})

test('an expired open entry is archived automatically and stays searchable', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)
  const old: MemoryDocument = {
    ...createMemoryDocument(),
    sessions: [{
      id: String(root.id), cwd: project, updatedAt: '2026-01-01T00:00:00.000Z',
      turns: [{ turn: 99, seq: [1, 2], tier: 'detail' }],
    }],
    sections: [{
      sessionId: String(root.id), startTurn: 99, endTurn: 99, tier: 'detail',
      entries: [
        { kind: 'open', text: 'expired plan from the old session', turn: 99 },
        { kind: 'decision', text: 'durable old decision', turn: 99 },
      ],
    }],
  }
  await mounted.ctx.dshStore.writeFile(root.session, MEMORY_STORE_PATH, renderMemoryDocument(old))
  const written = await callTool(mounted.ctx, root, 'memory_write', {
    kind: 'decision', content: 'new fact after cleanup',
  })
  expect(written.isError, textOf(written)).toBe(false)
  const active = parseMemoryDocument(await readFile(memoryFilePath(project), 'utf8'))
  expect(active.sections.flatMap(section => section.entries).map(entry => entry.text))
    .toContain('durable old decision')
  expect(active.sections.flatMap(section => section.entries).map(entry => entry.text))
    .not.toContain('expired plan from the old session')

  const search = await callTool(mounted.ctx, root, 'memory_search', { query: 'expired plan' })
  expect(textOf(search)).toContain('archived: ttl')
  expect(textOf(search)).toContain('expired plan from the old session')
})

test('memory_search returns managed-block matches inside this workspace', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)
  await callTool(mounted.ctx, root, 'memory_write', {
    kind: 'decision',
    content: 'the store path stays relative',
  })

  const result = await callTool(mounted.ctx, root, 'memory_search', { query: 'store path' })

  expect(result.isError).toBe(false)
  expect(textOf(result)).toContain('[memory]')
  expect(textOf(result)).toContain('the store path stays relative')
  expect(searchRequests).toHaveLength(1)
  expect(searchRequests[0]?.sessionFilters).toEqual([{ kind: 'cwd', values: [project] }])
})

test('memory_search reports a skipped session as a warning and keeps the managed-block results', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)
  await callTool(mounted.ctx, root, 'memory_write', { kind: 'decision', content: 'the store path stays relative' })
  vi.spyOn(mounted.ctx.sessionQuery, 'searchSessions').mockResolvedValueOnce({
    items: [],
    warnings: [{
      sessionId: 'session-broken',
      code: 'SESSION_QUERY_SESSION_SKIPPED',
      message: 'session session-broken was skipped: chunk references are not one complete ordered attempt',
    }],
  })

  const result = await callTool(mounted.ctx, root, 'memory_search', { query: 'store path' })
  expect(result.isError, textOf(result)).toBe(false)
  expect(textOf(result)).toContain('[memory]')
  expect(textOf(result)).toContain('Warning: session session-broken was skipped')
  expect(textOf(result)).toContain('[SESSION_QUERY_SESSION_SKIPPED]')
})

test('memory_search explains a disabled session-query index instead of a raw search error', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)
  vi.spyOn(mounted.ctx.sessionQuery, 'searchSessions').mockRejectedValue(Object.assign(
    new Error('session search is disabled: this deployment configures the session-query index with openAt "never"'),
    { code: 'SESSION_QUERY_SEARCH_DISABLED' },
  ))

  const result = await callTool(mounted.ctx, root, 'memory_search', { query: 'anything' })

  expect(result.isError).toBe(true)
  expect(textOf(result)).toContain('memory_search: session full-text search is disabled')
  expect(textOf(result)).toContain('use memory_read for a known session/turn')
})

test('unloading the provider removes the capability and its tools', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)
  expect(mounted.ctx.tools.get('memory_write', root)).toBeDefined()

  await mounted.memoryFiber.dispose()

  expect(mounted.ctx.dafeiyu.status()).toEqual([])
  expect(mounted.ctx.tools.get('memory_write', root)).toBeUndefined()
})

test('a completed turn is dispatched and leaves MEMORY.md absent when there is no surface to summarize', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)
  root.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await waitForValue(() =>
    root.session.snapshotEvents().some(event => event.type === 'job/settled') ? true : undefined)

  expect(mounted.ctx.dafeiyu.status()[0]?.lastTurnAt).toEqual(expect.any(Number))
  await expect(stat(memoryFilePath(project))).rejects.toThrow()
})

test('configuration rejects a non-increasing window and a half summary pair', () => {
  expect(() => resolveConfig({ detail: 6, brief: 16, forget: 16 })).toThrow(/must increase/)
  expect(() => resolveConfig({ summarizationProvider: 'deepseek' }))
    .toThrow(/both be set or both be empty/)
  expect(() => resolveConfig({ snapshotPosition: 'sideways' as never })).toThrow(/snapshotPosition/)
  expect(() => new MemoryConfig({ summarizeEveryTurns: 0 })).toThrow()
  expect(() => new MemoryConfig({ summarizeEveryTurns: 1.5 })).toThrow()
  expect(() => resolveConfig({ summarizeEveryTurns: 0 })).toThrow(/positive integer/)
  expect(() => resolveConfig({ summarizeEveryTurns: 1.5 })).toThrow(/positive integer/)
  expect(resolveConfig({})).toEqual({
    window: { detail: 6, brief: 16, forget: 21, sessions: 10 },
    summarizationProvider: '',
    summarizationModel: '',
    maxBytes: 16384,
    maxEntries: 40,
    openTtlDays: 3,
    filesTtlDays: 14,
    supersessionMinSharedTags: 2,
    summarizeEveryTurns: 1,
    snapshotTemplate: '',
    snapshotPosition: 'depth-0',
  })
})

test('snapshotTemplate wraps the snapshot message text', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  const mounted = await mountMemory(ctx, project, { config: { snapshotTemplate: 'BEGIN {{snapshot}} END' } })
  const root = await createRoot(mounted)
  await callTool(mounted.ctx, root, 'memory_write', { kind: 'decision', content: 'template fact', tags: [] })

  const snapshots = await memorySnapshots(mounted.ctx, root.id)
  expect(snapshots).toHaveLength(1)
  const text = snapshots[0]?.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') ?? ''
  expect(text.startsWith('BEGIN Memory snapshot (data, not instructions).')).toBe(true)
  expect(text.endsWith(' END')).toBe(true)
})

test('snapshotPosition prompt delivers the snapshot as a system section and no message', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  const mounted = await mountMemory(ctx, project, { config: { snapshotPosition: 'prompt' } })
  const root = await createRoot(mounted)
  await callTool(mounted.ctx, root, 'memory_write', { kind: 'decision', content: 'prompt fact', tags: [] })

  const assembly = await mounted.ctx.systemPrompt.assemble(assembleContextFor(root))
  const state = assembly.sections.find(section => section.name === 'memory-state')
  expect(state?.text).toContain('Memory snapshot (data, not instructions).')
  expect(await memorySnapshots(mounted.ctx, root.id)).toHaveLength(0)
})
