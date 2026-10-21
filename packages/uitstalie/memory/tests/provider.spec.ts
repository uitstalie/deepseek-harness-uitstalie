/**
 * Provider tests: the real plugin mounted over a real AgentLoop, organizer, and
 * store. They assert the root-only contribution, the fixed prompt section, the
 * three tool schemas, the working append path, and the deferred surfaces.
 */
import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import type {
  SessionEventSearchPage,
  SessionEventSearchRequest,
  SessionSearchExecContext,
  SessionSearchHit,
  SessionSearchPage,
  SessionSearchRequest,
} from '@deepseek-ai/dsh-session-query'
import { createDshStore } from '@deepseek-ai/dsh-tool-dsh-store'
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit'
import type { AgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import Dafeiyu from '@deepseek-ai/dsh-dafeiyu'
import * as Memory from '../src/index.ts'
import { MEMORY_PROMPT_ORDER, MEMORY_PROMPT_TEXT, resolveConfig } from '../src/index.ts'

const signal = new AbortController().signal

/** Requests the search tool sent to the query service in the current test. */
const searchRequests: SessionSearchRequest[] = []

/** Minimal concrete query service: no backend index, so session search is empty. */
class TestSessionQueryEngine extends SessionQueryEngine {
  override searchSessions(
    request: SessionSearchRequest,
    _exec?: SessionSearchExecContext,
  ): Promise<SessionSearchPage<SessionSearchHit>> {
    searchRequests.push(request)
    return Promise.resolve({ items: [] })
  }

  override async searchEvents(
    request: SessionEventSearchRequest,
    _exec?: SessionSearchExecContext,
  ): Promise<SessionEventSearchPage> {
    return { session: (await this.readSurface(request.sessionId)).session, items: [] }
  }
}

let project: string
let contexts: Context[]
let callCounter = 0

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'dsh-memory-provider-'))
  // A `.git` marker makes the fixture look like a checkout, so project-root
  // discovery resolves to the fixture rather than to the temp directory above it.
  await mkdir(join(project, '.git'), { recursive: true })
  contexts = []
  searchRequests.length = 0
  callCounter = 0
})

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await rm(project, { recursive: true, force: true })
})

interface Mounted {
  readonly ctx: Context
  readonly harness: AgentLoopTestHarness
  readonly memoryFiber: Fiber
}

/** Mount the real services and the memory provider, then the agent loop harness. */
async function mount(): Promise<Mounted> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(LocalFileSystem, { cwd: project })
  await ctx.plugin(TestSessionQueryEngine)
  ctx.provide('dshStore', createDshStore(ctx, false))
  await ctx.plugin(Dafeiyu)
  const memoryFiber = await ctx.plugin(Memory, {})
  await settle()
  const harness = await mountAgentLoopTestHarness(ctx)
  return { ctx, harness, memoryFiber }
}

/** Let activation and dispatch continuations run. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
}

/** Absolute path of the fixture MEMORY.md. */
function memoryFile(): string {
  return join(project, '.dsh', 'memory', 'sessions', 'MEMORY.md')
}

/** Invoke one registered tool through the real tool runtime. */
function call(ctx: Context, agent: Agent, name: string, args: Record<string, unknown>) {
  return ctx.tools.execute({
    signal,
    callId: ToolCallId(`call-${++callCounter}`),
    name,
    arguments: args,
    agent,
  })
}

/** Text blocks of one tool result. */
function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/** Create one root agent and open its first turn. */
async function createRoot(mounted: Mounted, turn = 1): Promise<Agent> {
  const root = await mounted.harness.create(SessionId('memory-root'), {}, { cwd: project })
  root.session.append('turn/start', { turn })
  return root
}

test('registers an active root-scoped capability with the fixed prompt section', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)

  expect(mounted.ctx.dafeiyu.status()).toEqual([
    { id: 'memory', present: true, enabled: true, state: 'active' },
  ])
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

  const result = await call(mounted.ctx, root, 'memory_write', {
    kind: 'decision',
    content: 'write memory through the version-guarded store',
    tags: ['store'],
  })

  expect(result.isError, text(result)).toBe(false)
  expect(text(result)).toContain('Recorded a decision memory entry')
  expect((await stat(memoryFile())).isFile()).toBe(true)
  expect(await readFile(memoryFile(), 'utf8'))
    .toContain('- [decision] write memory through the version-guarded store')
})

test('memory_write rejects an unknown kind with the valid list', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)

  const result = await call(mounted.ctx, root, 'memory_write', { kind: 'bogus', content: 'text' })

  expect(result.isError).toBe(true)
  expect(text(result)).toContain('must be one of')
  expect(text(result)).toContain('preference')
})

test('memory_write rejects content over the 8 KiB cap', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)

  const result = await call(mounted.ctx, root, 'memory_write', {
    kind: 'decision',
    content: 'x'.repeat(8 * 1024 + 1),
  })

  expect(result.isError).toBe(true)
  expect(text(result)).toContain('the limit is 8192')
})

test('memory_search returns managed-block matches inside this workspace', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)
  await call(mounted.ctx, root, 'memory_write', {
    kind: 'decision',
    content: 'the store path stays relative',
  })

  const result = await call(mounted.ctx, root, 'memory_search', { query: 'store path' })

  expect(result.isError).toBe(false)
  expect(text(result)).toContain('[memory]')
  expect(text(result)).toContain('the store path stays relative')
  expect(searchRequests).toHaveLength(1)
  expect(searchRequests[0]?.sessionFilters).toEqual([{ kind: 'cwd', values: [project] }])
})

test('memory_read returns a not-implemented message without failing', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)

  const result = await call(mounted.ctx, root, 'memory_read', { turn: 1 })

  expect(result.isError).toBe(false)
  expect(text(result)).toContain('not implemented in this step')
})

test('unloading the provider removes the capability and its tools', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)
  expect(mounted.ctx.tools.get('memory_write', root)).toBeDefined()

  await mounted.memoryFiber.dispose()

  expect(mounted.ctx.dafeiyu.status()).toEqual([])
  expect(mounted.ctx.tools.get('memory_write', root)).toBeUndefined()
})

test('a completed turn is dispatched but leaves MEMORY.md absent', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)
  root.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle()

  expect(mounted.ctx.dafeiyu.status()[0]?.lastTurnAt).toEqual(expect.any(Number))
  await expect(stat(memoryFile())).rejects.toThrow()
})

test('configuration rejects a non-increasing window and a half summary pair', () => {
  expect(() => resolveConfig({ detail: 6, brief: 16, forget: 16 })).toThrow(/must increase/)
  expect(() => resolveConfig({ summarizationProvider: 'deepseek' }))
    .toThrow(/both be set or both be empty/)
  expect(resolveConfig({})).toEqual({
    window: { detail: 6, brief: 16, forget: 21, sessions: 10 },
    summarizationProvider: '',
    summarizationModel: '',
    maxBytes: 4096,
  })
})
