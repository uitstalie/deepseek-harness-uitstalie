/**
 * Provider tests: the real plugin mounted over a real AgentLoop, organizer, and
 * store. They assert the all-agent contribution, the stable prompt section, the
 * auto-learning tool with its refusals and budget, the workspace overlay write,
 * and the deferred surfaces.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createDshStore } from '@deepseek-ai/dsh-tool-dsh-store'
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit'
import type { AgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import Dafeiyu from '@deepseek-ai/dsh-dafeiyu'
import * as Personality from '../src/index.ts'
import type { Config } from '../src/config.ts'
import { resolveConfig } from '../src/config.ts'
import {
  PERSONALITY_FILE_NAME,
  PERSONALITY_HISTORY_FILE_NAME,
  PERSONALITY_STORE_PATH,
  parsePersonalityDocument,
  renderPersonalityDocument,
} from '../src/personality-file.ts'
import type { PersonalityDocument, PersonalityEntry } from '../src/personality-file.ts'
import { PERSONALITY_PROMPT_ORDER, PERSONALITY_PROMPT_SECTION_NAME, renderPersonalityPrompt } from '../src/prompt.ts'

const signal = new AbortController().signal

let project: string
let contexts: Context[]
let callCounter = 0

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'dsh-personality-provider-'))
  // A `.git` marker makes the fixture look like a checkout, so project-root
  // discovery resolves to the fixture rather than to the temp directory above it.
  await mkdir(join(project, '.git'), { recursive: true })
  contexts = []
  callCounter = 0
})

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await rm(project, { recursive: true, force: true })
})

interface Mounted {
  readonly ctx: Context
  readonly harness: AgentLoopTestHarness
  readonly personalityFiber: Fiber
}

/** Configuration that keeps the global profile inside the fixture. */
function settingsConfig(overrides: Config = {}): Config {
  return {
    globalPath: overrides.globalPath ?? globalFile(),
    ...overrides.workspaceOverlay === undefined ? {} : { workspaceOverlay: overrides.workspaceOverlay },
    ...overrides.maxBytes === undefined ? {} : { maxBytes: overrides.maxBytes },
    ...overrides.autoLearn === undefined ? {} : { autoLearn: overrides.autoLearn },
  }
}

/** Absolute path of the fixture global profile. */
function globalFile(): string {
  return join(project, 'home', 'personality', PERSONALITY_FILE_NAME)
}

/** Absolute path of the fixture workspace overlay. */
function workspaceFile(): string {
  return join(project, '.dsh', 'memory', PERSONALITY_FILE_NAME)
}

/** One entry fixture. */
function entry(kind: PersonalityEntry['kind'], name: string, text: string): PersonalityEntry {
  return { id: `${kind}.${name}`, kind, name, text }
}

/** Render and write the global profile before the provider activates. */
async function seedGlobal(entries: readonly PersonalityEntry[]): Promise<void> {
  const document: PersonalityDocument = {
    version: 1,
    updatedAt: '2026-10-21T00:00:00.000Z',
    entries,
    frame: { before: '\n', after: '\n' },
  }
  await mkdir(join(project, 'home', 'personality'), { recursive: true })
  await writeFile(globalFile(), renderPersonalityDocument(document), 'utf8')
}

/** Mount the real services and the personality provider, then the agent loop harness. */
async function mount(config: Config = settingsConfig()): Promise<Mounted> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(LocalFileSystem, { cwd: project })
  ctx.provide('dshStore', createDshStore(ctx, false))
  await ctx.plugin(Dafeiyu)
  const personalityFiber = await ctx.plugin(Personality, config)
  await settle()
  const harness = await mountAgentLoopTestHarness(ctx)
  return { ctx, harness, personalityFiber }
}

/** Let activation and dispatch continuations run. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
}

/** Poll until a test-owned condition becomes true. */
async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return
    await new Promise<void>((resolve) => { setTimeout(resolve, 1) })
  }
  throw new Error('condition was not met')
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

/** Create one root agent, wait for its wiring, and return it. */
async function createRoot(mounted: Mounted, sessionId = 'personality-root'): Promise<Agent> {
  const root = await mounted.harness.create(SessionId(sessionId), {}, { cwd: project })
  await until(() => mounted.ctx.tools.get('personality_learn', root) !== undefined)
  return root
}

/** Resolve the current personality section text for one agent. */
async function promptText(ctx: Context, agent: Agent): Promise<string> {
  const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent))
  return assembly.sections.find(section => section.name === PERSONALITY_PROMPT_SECTION_NAME)?.text ?? ''
}

test('registers an active all-agent capability with the stable prompt section', async () => {
  const entries = [entry('style', 'language', '用中文回答；代码保持英文原文。')]
  await seedGlobal(entries)
  const mounted = await mount()
  const root = await createRoot(mounted)

  expect(mounted.ctx.dafeiyu.status()).toEqual([{
    id: 'personality',
    present: true,
    enabled: true,
    state: 'active',
    label: Personality.PERSONALITY_CAPABILITY_LABEL,
    description: Personality.PERSONALITY_CAPABILITY_DESCRIPTION,
  }])
  expect(await promptText(mounted.ctx, root)).toBe(renderPersonalityPrompt(entries))
  expect(PERSONALITY_PROMPT_ORDER).toBe(100)
  expect(PERSONALITY_PROMPT_SECTION_NAME).toBe('personality')
})

test('an empty profile contributes an empty section text', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)
  await settle()

  expect(await promptText(mounted.ctx, root)).toBe('')
})

test('child agents inherit the prompt section and the learn tool', async () => {
  const entries = [entry('identity', 'role', '独立开发者。')]
  await seedGlobal(entries)
  const mounted = await mount()
  const root = await createRoot(mounted)
  const child = await mounted.ctx.agents.create({ sessionId: SessionId('personality-child'), parentAgent: root })
  await until(() => mounted.ctx.tools.get('personality_learn', child.agent) !== undefined)

  expect(await promptText(mounted.ctx, child.agent)).toBe(renderPersonalityPrompt(entries))
  expect(mounted.ctx.tools.get('personality_learn', child.agent)).toBeDefined()
  await child.dispose()
})

test('personality_learn writes a style entry to the overlay and refreshes the prompt', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)

  const result = await call(mounted.ctx, root, 'personality_learn', {
    kind: 'style',
    content: '先给结论，再给步骤。',
    evidence: 'seq 7',
  })

  expect(result.isError, text(result)).toBe(false)
  expect(text(result)).toContain('Recorded an auto-learned style entry')
  const stored = parsePersonalityDocument(await readFile(workspaceFile(), 'utf8'))
  expect(stored.entries).toHaveLength(1)
  expect(stored.entries[0]?.kind).toBe('style')
  expect(stored.entries[0]?.text).toBe('先给结论，再给步骤。')
  const history = await readFile(join(project, '.dsh', 'memory', PERSONALITY_HISTORY_FILE_NAME), 'utf8')
  expect(history).toContain('"source":"auto"')
  expect(history).toContain('"session":"personality-root"')

  expect(await promptText(mounted.ctx, root)).toContain('先给结论，再给步骤。')
  expect(PERSONALITY_STORE_PATH).toBe('memory/PERSONALITY.md')
})

test('personality_learn refuses identity entries without writing and without failing the call', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)

  const result = await call(mounted.ctx, root, 'personality_learn', {
    kind: 'identity',
    content: '用户是独立开发者。',
    evidence: 'seq 3',
  })

  expect(result.isError, text(result)).toBe(false)
  expect(text(result)).toContain('edit PERSONALITY.md directly')
  await expect(stat(workspaceFile())).rejects.toThrow()
  await expect(stat(globalFile())).rejects.toThrow()
})

test('personality_learn refuses an unknown kind with the valid list', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)

  const result = await call(mounted.ctx, root, 'personality_learn', {
    kind: 'bogus',
    content: 'something',
    evidence: 'seq 1',
  })

  expect(result.isError, text(result)).toBe(false)
  expect(text(result)).toContain('valid kinds: understanding, style, preference, identity')
})

test('personality_learn requires evidence naming a positive session event seq', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)

  const result = await call(mounted.ctx, root, 'personality_learn', {
    kind: 'preference',
    content: '提交信息用 conventional commits。',
    evidence: 'turn 3',
  })

  expect(result.isError, text(result)).toBe(false)
  expect(text(result)).toContain('positive session event seq')
  expect(await readFile(workspaceFile(), 'utf8').catch(() => '')).toBe('')
})

test('the auto-learn budget refuses an entry past the per-session limit', async () => {
  const mounted = await mount(settingsConfig({ autoLearn: { entries: 1, bytes: 512 } }))
  const root = await createRoot(mounted)

  const first = await call(mounted.ctx, root, 'personality_learn', {
    kind: 'understanding',
    content: '用户常用短句表达。',
    evidence: 'seq 1',
  })
  const second = await call(mounted.ctx, root, 'personality_learn', {
    kind: 'preference',
    content: '先读现有实现再改代码。',
    evidence: 'seq 2',
  })

  expect(first.isError, text(first)).toBe(false)
  expect(text(first)).toContain('Recorded an auto-learned understanding entry')
  expect(second.isError, text(second)).toBe(false)
  expect(text(second)).toContain('auto-learn budget is exhausted')
  expect(text(second)).toContain('0 of 1 entries')
  expect(parsePersonalityDocument(await readFile(globalFile(), 'utf8')).entries).toHaveLength(1)
})

test('unloading the provider removes the capability, the tool, and the section', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)
  expect(mounted.ctx.tools.get('personality_learn', root)).toBeDefined()

  await mounted.personalityFiber.dispose()

  expect(mounted.ctx.dafeiyu.status()).toEqual([])
  expect(mounted.ctx.tools.get('personality_learn', root)).toBeUndefined()
  expect(await promptText(mounted.ctx, root)).toBe('')
})

test('a completed turn is dispatched but leaves PERSONALITY.md absent', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)
  root.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await until(() => mounted.ctx.dafeiyu.status()[0]?.lastTurnAt !== undefined)

  expect(mounted.ctx.dafeiyu.status()[0]?.lastTurnAt).toEqual(expect.any(Number))
  await expect(stat(workspaceFile())).rejects.toThrow()
})

test('resolveConfig defaults the global path under DSH_HOME and keeps both budgets', () => {
  vi.stubEnv('DSH_HOME', join(project, 'home'))
  const settings = resolveConfig({})

  expect(settings.globalPath).toBe(join(project, 'home', 'personality', PERSONALITY_FILE_NAME))
  expect(settings.globalHistoryPath).toBe(join(project, 'home', 'personality', PERSONALITY_HISTORY_FILE_NAME))
  expect(settings.workspaceOverlay).toBe(true)
  expect(settings.maxBytes).toBe(2048)
  expect(settings.autoLearn).toEqual({ entries: 3, bytes: 512 })
  expect(settings.workspaceStorePath).toBe(PERSONALITY_STORE_PATH)
})
