/**
 * Provider tests: the real plugin mounted over a real AgentLoop, organizer, and
 * store. They assert the root-only contribution, the static global-memory prompt
 * section, the three global tools, the NOT_GLOBAL_MEMORY refusals with their
 * tool hints, global search, and the absence of any per-turn memory write.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  Config as MemoryConfig,
  GLOBAL_MEMORY_STORE_PATH,
  MEMORY_CAPABILITY_DESCRIPTION,
  MEMORY_CAPABILITY_LABEL,
  MEMORY_PROMPT_ORDER,
  MEMORY_PROMPT_TEXT,
  createMemoryDocument,
  globalMemoryPath,
  readGlobalMemory,
  renderMemoryDocument,
  resolveConfig,
} from '../src/api.ts'
import type { MemoryDocument } from '../src/api.ts'
import {
  callTool,
  createRoot,
  memoryFilePath,
  memoryMessages,
  mountMemory,
  textOf,
  settle,
} from './harness.ts'
import type { MemoryTestHarness } from './harness.ts'

let project: string
let contexts: Context[]

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'dsh-memory-provider-'))
  // A `.git` marker makes the fixture look like a checkout, so project-root
  // discovery resolves to the fixture rather than to the temp directory above it.
  await mkdir(join(project, '.git'), { recursive: true })
  // Every test's global store lives in a temporary `$DSH_HOME`, never the real one.
  vi.stubEnv('DSH_HOME', join(project, 'home'))
  contexts = []
})

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await rm(project, { recursive: true, force: true })
})

/** Mount the real composition and return its helpers. */
async function mount(): Promise<MemoryTestHarness> {
  const ctx = new Context()
  contexts.push(ctx)
  return mountMemory(ctx, project)
}

test('registers an active root-scoped capability with the static global-memory section', async () => {
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
  expect(section?.text).toContain('global-only')
  expect(MEMORY_PROMPT_ORDER).toBe(2350)
})

test('neither a legacy workspace file nor the global file is injected per turn', async () => {
  const mounted = await mount()
  const seeded: MemoryDocument = {
    ...createMemoryDocument(),
    sessions: [{
      id: 'memory-root', cwd: project, updatedAt: '2026-01-01T00:00:00.000Z',
      turns: [{ turn: 1, seq: [1, 2], tier: 'detail' }],
    }],
    sections: [{
      sessionId: 'memory-root', startTurn: 1, endTurn: 1, tier: 'detail',
      entries: [{ kind: 'decision', text: 'a legacy conclusion recorded before this process started' }],
    }],
  }
  await mkdir(dirname(memoryFilePath(project)), { recursive: true })
  await writeFile(memoryFilePath(project), renderMemoryDocument(seeded))

  const root = await createRoot(mounted)
  const written = await callTool(mounted.ctx, root, 'memory_write', {
    topic: 'global-server',
    text: 'The shared build server is reachable as server alpha.',
  })
  expect(written.isError, textOf(written)).toBe(false)

  expect(await memoryMessages(mounted.ctx, root.id)).toEqual([])
  const assembly = await mounted.ctx.systemPrompt.assemble(assembleContextFor(root))
  expect(assembly.sections.map(section => section.name)).not.toContain('memory-state')
  expect(assembly.sections.find(section => section.name === 'memory')?.text).not.toContain('server alpha')
})

test('root agents get three tools; child agents get only memory_search', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)
  const child = await mounted.ctx.agents.create({
    sessionId: SessionId('memory-child'),
    meta: { parentSession: root.id, origin: 'subagent', delegationDepth: 1 },
  })

  const names = mounted.ctx.tools.schemas(root).map(schema => schema.name)
  expect(names).toEqual(expect.arrayContaining(['memory_write', 'memory_forget', 'memory_search']))
  expect(names).not.toContain('memory_resolve')
  expect(mounted.ctx.tools.schemas(child.agent).map(schema => schema.name).sort()).toEqual(['memory_search'])
  expect(mounted.ctx.tools.get('memory_write', child.agent)).toBeUndefined()
  expect(mounted.ctx.tools.get('memory_forget', child.agent)).toBeUndefined()
  const childAssembly = await mounted.ctx.systemPrompt.assemble(assembleContextFor(child.agent))
  expect(childAssembly.sections.map(entry => entry.name)).not.toContain('memory')
  await child.dispose()
})

test('memory_write records one global entry under $DSH_HOME, not in the workspace store', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)

  const result = await callTool(mounted.ctx, root, 'memory_write', {
    topic: 'global-model',
    text: 'The harness default model is the routed model.',
  })
  expect(result.isError, textOf(result)).toBe(false)
  expect(textOf(result)).toContain('Recorded a global-model global memory entry')
  expect(globalMemoryPath()).toBe(join(project, 'home', 'memory', 'GLOBAL.md'))
  expect((await stat(globalMemoryPath())).isFile()).toBe(true)
  expect(await readFile(globalMemoryPath(), 'utf8')).toContain('The harness default model is the routed model.')
  await expect(stat(memoryFilePath(project))).rejects.toThrow()
  expect((await readGlobalMemory(mounted.ctx)).document?.entries[0]?.topic).toBe('global-model')
})

test('a business write is refused with the workspace tool hints', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)

  const result = await callTool(mounted.ctx, root, 'memory_write', {
    topic: 'global-tooling',
    text: 'The commit 548dc157ba changed the workspace layout.',
  })
  expect(result.isError).toBe(true)
  expect(textOf(result)).toContain('NOT_GLOBAL_MEMORY')
  expect(textOf(result)).toContain('workspace_tasks')
  expect(textOf(result)).toContain('workspace_intents')
  expect(textOf(result)).toContain('session_search')
  await expect(stat(globalMemoryPath())).rejects.toThrow()
})

test('a dispatch write points at workspace_sessions and a persona write at personality_apply', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)

  const dispatch = await callTool(mounted.ctx, root, 'memory_write', {
    topic: 'global-convention',
    text: 'Dispatched the task to session memory-worker; waiting for the receipt.',
  })
  expect(dispatch.isError).toBe(true)
  expect(textOf(dispatch)).toContain('NOT_GLOBAL_MEMORY')
  expect(textOf(dispatch)).toContain('workspace_sessions')

  const persona = await callTool(mounted.ctx, root, 'memory_write', {
    topic: 'global-convention',
    text: 'The user prefers a calm tone of voice.',
  })
  expect(persona.isError).toBe(true)
  expect(textOf(persona)).toContain('NOT_GLOBAL_MEMORY')
  expect(textOf(persona)).toContain('personality_apply')
})

test('memory_search reads the global store only, never a workspace MEMORY.md', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)
  const legacy: MemoryDocument = {
    ...createMemoryDocument(),
    sessions: [{ id: 'memory-root', cwd: project, updatedAt: '2026-01-01T00:00:00.000Z', turns: [] }],
    sections: [{ sessionId: 'memory-root', startTurn: 1, endTurn: 1, tier: 'detail', entries: [{ kind: 'decision', text: 'workspace secret alpha' }] }],
  }
  await mkdir(dirname(memoryFilePath(project)), { recursive: true })
  await writeFile(memoryFilePath(project), renderMemoryDocument(legacy))
  await callTool(mounted.ctx, root, 'memory_write', {
    topic: 'global-server',
    text: 'The shared build server is reachable as server alpha.',
  })

  const global = await callTool(mounted.ctx, root, 'memory_search', { query: 'alpha' })
  expect(global.isError).toBe(false)
  expect(textOf(global)).toContain('[global-server]')
  expect(textOf(global)).toContain('The shared build server')

  const legacyHit = await callTool(mounted.ctx, root, 'memory_search', { query: 'workspace secret' })
  expect(textOf(legacyHit)).toContain('No global memory matches')
})

test('memory_forget has no session filters and archives by topic', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)
  await callTool(mounted.ctx, root, 'memory_write', { topic: 'global-server', text: 'Server alpha is the shared build host.' })
  await callTool(mounted.ctx, root, 'memory_write', { topic: 'global-model', text: 'The harness default model is the routed model.' })

  const parameters = mounted.ctx.tools.get('memory_forget', root)?.parameters as {
    readonly properties?: Record<string, unknown>
  }
  expect(Object.keys(parameters.properties ?? {}).sort()).toEqual(['entryId', 'topic'])
  expect(JSON.stringify(parameters)).not.toContain('sessionId')

  const forgotten = await callTool(mounted.ctx, root, 'memory_forget', { topic: 'global-server' })
  expect(forgotten.isError, textOf(forgotten)).toBe(false)
  expect(textOf(forgotten)).toContain('Forgot 1 global memory entry')
  expect((await readGlobalMemory(mounted.ctx)).document?.entries.map(entry => entry.topic)).toEqual(['global-model'])

  const bare = await callTool(mounted.ctx, root, 'memory_forget', {})
  expect(bare.isError).toBe(true)
  expect(textOf(bare)).toContain('one of `topic` or `entryId` is required')
})

test('a completed turn writes no memory job, no MEMORY.md, and no memory message', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)
  root.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle()

  expect(await memoryMessages(mounted.ctx, root.id)).toEqual([])
  await expect(stat(memoryFilePath(project))).rejects.toThrow()
  expect(mounted.ctx.dafeiyu.status()[0]?.lastTurnAt).toBeUndefined()
})

test('unloading the provider removes the capability and its tools', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)
  expect(mounted.ctx.tools.get('memory_write', root)).toBeDefined()

  await mounted.memoryFiber.dispose()

  expect(mounted.ctx.dafeiyu.status()).toEqual([])
  expect(mounted.ctx.tools.get('memory_write', root)).toBeUndefined()
})

test('the legacy settings row still fails loudly when its window is invalid', () => {
  expect(() => resolveConfig({ detail: 6, brief: 16, forget: 16 })).toThrow(/must increase/u)
  expect(() => resolveConfig({ summarizationProvider: 'deepseek' }))
    .toThrow(/both be set or both be empty/u)
  expect(() => new MemoryConfig({ summarizeEveryTurns: 0 })).toThrow()
  expect(resolveConfig({})).toMatchObject({
    window: { detail: 6, brief: 16, forget: 21, sessions: 10 },
    maxBytes: 16384,
    maxEntries: 40,
    openTtlDays: 3,
    filesTtlDays: 14,
  })
})

test('the global store is reachable through the same contract as the tools', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)
  await mounted.ctx.dshStore.writeFile(undefined, GLOBAL_MEMORY_STORE_PATH, 'not a document', { scope: 'global' })
  const result = await callTool(mounted.ctx, root, 'memory_search', { query: 'anything' })
  expect(result.isError).toBe(true)
  expect(textOf(result)).toContain('frontmatter')
})
