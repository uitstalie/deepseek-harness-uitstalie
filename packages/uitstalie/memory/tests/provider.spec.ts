/**
 * Provider tests: the real plugin mounted over a real AgentLoop, organizer, and
 * store. They assert the root-only contribution, the fixed prompt section, the
 * three tool schemas, the working append path, and the completed-turn dispatch.
 */
import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
// Type-only: the Loader's `loader/volatile-update` event declaration.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  MEMORY_CAPABILITY_DESCRIPTION, MEMORY_CAPABILITY_LABEL, MEMORY_PROMPT_ORDER, MEMORY_PROMPT_TEXT, resolveConfig,
} from '../src/index.ts'
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

test('root agents get the three tools; child agents get none', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)
  const child = await mounted.ctx.agents.create({
    sessionId: SessionId('memory-child'),
    parentAgent: root,
  })

  const names = mounted.ctx.tools.schemas(root).map(schema => schema.name)
  expect(names).toEqual(expect.arrayContaining(['memory_write', 'memory_search', 'memory_read']))
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
  ;(mounted.config as unknown as { sessions: number }).sessions = 3
  ctx.emit('loader/volatile-update', [['sessions']])
  const result = await callTool(mounted.ctx, root, 'memory_write', {
    kind: 'decision',
    content: 'written after the settings change',
  })
  expect(result.isError, textOf(result)).toBe(false)
  // The file records the window that wrote it: a stale apply closure would still say 1.
  expect(await readFile(memoryFilePath(project), 'utf8')).toContain('sessions: 3')
})

test('an invalid volatile update keeps the previous settings', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  const mounted = await mountMemory(ctx, project, { config: { detail: 2, brief: 16, forget: 21 } })
  const root = await createRoot(mounted)

  if (mounted.config === undefined) throw new Error('the memory provider did not resolve its configuration')
  ;(mounted.config as unknown as { detail: number }).detail = 20
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
  expect(resolveConfig({})).toEqual({
    window: { detail: 6, brief: 16, forget: 21, sessions: 10 },
    summarizationProvider: '',
    summarizationModel: '',
    maxBytes: 4096,
    maxEntries: 40,
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
