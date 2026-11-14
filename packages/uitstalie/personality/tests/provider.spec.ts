/**
 * Provider tests for the rewritten capability: all-agent analyze, root-only
 * confirmed apply, three stable prompt sections, child inheritance, legacy
 * config acceptance, unload, and the absence of any turn-end write.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import { createDshStore } from '@deepseek-ai/dsh-store-atom'
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit'
import type { AgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import Dafeiyu from '@deepseek-ai/dsh-dafeiyu'
import * as Personality from '../src/index.ts'
import {
  createPersonalityDocument,
  globalPersonalityPath,
  parsePersonalityDocument,
  renderPersonalityDocument,
} from '../src/global-store.ts'
import type { PersonalityEntry } from '../src/global-store.ts'
import { renderPersonalitySection, PROFILE_SECTION_NAME } from '../src/profile-prompt.ts'
import { applyPersonalityCandidates } from '../src/apply.ts'

const signal = new AbortController().signal

let project: string
let contexts: Context[]
let callCounter = 0

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'dsh-personality-provider-'))
  await mkdir(join(project, '.git'), { recursive: true })
  vi.stubEnv('DSH_HOME', join(project, 'home'))
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

/** One entry fixture. */
function entry(kind: PersonalityEntry['kind'], name: string, text: string): PersonalityEntry {
  return { id: `${kind}.${name}`, kind, text }
}

/** Write a new-format profile before activation. */
async function seedGlobal(entries: readonly PersonalityEntry[]): Promise<void> {
  await mkdir(join(project, 'home', 'personality'), { recursive: true })
  await writeFile(globalPersonalityPath(), renderPersonalityDocument(createPersonalityDocument(entries)), 'utf8')
}

/** Mount the real services, organizer, session query, and rewritten provider. */
async function mount(beforePersonality?: (ctx: Context) => void): Promise<Mounted> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(LocalFileSystem, { cwd: project })
  ctx.provide('dshStore', createDshStore(ctx, false))
  await ctx.plugin(Dafeiyu)
  // @ts-expect-error -- the package default export is an abstract service class; Cordis instantiates it.
  await ctx.plugin(SessionQuery, {})
  beforePersonality?.(ctx)
  const personalityFiber = await ctx.plugin(Personality, {} as never)
  const harness = await mountAgentLoopTestHarness(ctx)
  return { ctx, harness, personalityFiber }
}

/** Let activation continuations run. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
}

/** Poll until a condition becomes true. */
async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return
    await new Promise<void>((resolve) => { setTimeout(resolve, 1) })
  }
  throw new Error('condition was not met')
}

/** Invoke one tool through the real runtime. */
async function call(ctx: Context, agent: Agent, name: string, args: Record<string, unknown>) {
  const batch = await ctx.tools.execute({
    signal,
    calls: [{
      type: 'tool-call',
      id: ToolCallId(`call-${++callCounter}`),
      name,
      arguments: JSON.stringify(args),
    }],
    agent,
  })
  const result = batch.results[0]?.result
  if (result === undefined) throw new Error(`tool "${name}" settled no result`)
  return result
}

/** Text blocks of one tool result. */
function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/** Create one root agent and wait for its new analyze tool. */
async function createRoot(mounted: Mounted, sessionId = 'personality-root'): Promise<Agent> {
  const root = await mounted.harness.create(SessionId(sessionId), {}, { cwd: project })
  await until(() => mounted.ctx.tools.get('personality_analyze', root) !== undefined)
  await settle()
  return root
}

/** Resolve the profile section text for one agent. */
async function promptText(ctx: Context, agent: Agent): Promise<string> {
  const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent))
  return assembly.sections.find(section => section.name === PROFILE_SECTION_NAME)?.text ?? ''
}

/** Append one user message to a session. */
function appendUser(agent: Agent, text: string, turn = 1): void {
  agent.session.append('turn/start', { turn })
  agent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

test('registers the all-agent analyze tool, root apply and writing tools, and three prompt sections', async () => {
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
  expect(await promptText(mounted.ctx, root)).toBe(renderPersonalitySection(entries))
  expect(mounted.ctx.tools.get('personality_analyze', root)).toBeDefined()
  expect(mounted.ctx.tools.get('personality_apply', root)).toBeDefined()
  expect(mounted.ctx.tools.get('write_like_human', root)).toBeDefined()
  const apply = mounted.ctx.tools.get('personality_apply', root)
  const applyCandidates = (apply?.parameters as {
    properties?: { candidates?: { items?: { properties?: { kind?: { enum?: readonly string[] } } } } }
  } | undefined)?.properties?.candidates
  expect(applyCandidates?.items?.properties?.kind?.enum).toEqual(['understanding', 'preference', 'style'])
  const names = (await mounted.ctx.systemPrompt.assemble(assembleContextFor(root))).sections.map(section => section.name)
  expect(names).toEqual(expect.arrayContaining(['personality', 'personality:output-style', 'personality:writing-rules']))
})

test('an empty profile contributes an empty profile section', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)
  expect(await promptText(mounted.ctx, root)).toBe('')
})

test('warns once for a pre-rewrite workspace profile and stays silent without one', async () => {
  await mkdir(join(project, '.dsh', 'memory'), { recursive: true })
  await writeFile(join(project, '.dsh', 'memory', 'PERSONALITY.md'), 'old profile', 'utf8')
  const mounted = await mount()
  const warn = vi.spyOn(mounted.ctx.logger, 'warn')
  const legacy = (): number => warn.mock.calls.filter(([message]) => String(message).includes('workspace file')).length
  await mounted.harness.create(SessionId('legacy-a'), {}, { cwd: project })
  await until(() => legacy() > 0)
  await mounted.harness.create(SessionId('legacy-b'), {}, { cwd: project })
  await settle()
  expect(legacy()).toBe(1)
  expect(String(warn.mock.calls.find(([message]) => String(message).includes('workspace file'))?.[0]))
    .toContain('only global personality')

  await rm(join(project, '.dsh', 'memory', 'PERSONALITY.md'))
  const clean = await mount()
  const silent = vi.spyOn(clean.ctx.logger, 'warn')
  await createRoot(clean, 'clean-root')
  await settle()
  expect(silent.mock.calls.filter(([message]) => String(message).includes('workspace file'))).toHaveLength(0)
})

test('keeps the capability when seeding the configuration files fails', async () => {
  const write = vi.fn(async () => { throw new Error('read-only store') })
  const mounted = await mount((ctx) => {
    vi.spyOn(ctx.dshStore, 'writeFile').mockImplementation(write)
  })
  await until(() => write.mock.calls.length > 0)
  await settle()
  expect(mounted.ctx.dafeiyu.status().some(status => status.id === 'personality')).toBe(true)
  await expect(stat(join(project, 'home', 'personality', 'OUTPUT_STYLE.yaml'))).rejects.toThrow()
})

test('child agents inherit analyze and the profile section but not apply', async () => {
  const entries = [entry('identity', 'role', '独立开发者。')]
  await seedGlobal(entries)
  const mounted = await mount()
  const root = await createRoot(mounted)
  const child = await mounted.ctx.agents.create({
    sessionId: SessionId('personality-child'),
    meta: { parentSession: root.id, origin: 'subagent', delegationDepth: 1 },
  })
  await until(() => mounted.ctx.tools.get('personality_analyze', child.agent) !== undefined)

  expect(await promptText(mounted.ctx, child.agent)).toBe(renderPersonalitySection(entries))
  expect(mounted.ctx.tools.get('personality_apply', child.agent)).toBeUndefined()
  expect(mounted.ctx.tools.get('write_like_human', child.agent)).toBeUndefined()
  await child.dispose()
})

test('write_like_human writes the global file and refreshes the injected section', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)

  const added = await call(mounted.ctx, root, 'write_like_human', {
    action: 'add',
    id: 'no-em-dash',
    text: 'Prefer no em dash.',
  })
  expect(text(added)).toContain('no-em-dash')
  expect(text(added)).toContain('1 rule(s)')
  const stored = await readFile(join(project, 'home', 'personality', 'WRITING_RULES.yaml'), 'utf8')
  expect(stored).toContain('no-em-dash')

  const assembly = await mounted.ctx.systemPrompt.assemble(assembleContextFor(root))
  const section = assembly.sections.find(candidate => candidate.name === 'personality:writing-rules')
  expect(section?.text).toBe('- Prefer no em dash.')

  const preview = await call(mounted.ctx, root, 'write_like_human', { action: 'preview' })
  expect(text(preview)).toContain('Injected text:')

  const duplicate = await call(mounted.ctx, root, 'write_like_human', {
    action: 'add',
    id: 'no-em-dash',
    text: 'Again.',
  })
  expect(text(duplicate)).toContain('write_like_human failed')
  expect(text(duplicate)).toContain('already exists')
})

test('accepts the legacy config shape without adding settings metadata', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)
  expect(mounted.ctx.dafeiyu.status()[0]?.settings).toBeUndefined()
  expect(mounted.ctx.tools.get('personality_analyze', root)).toBeDefined()
})

test('personality_analyze reads the current session and returns evidence candidates', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)
  appendUser(root, '以后回复请用中文。')

  const result = await call(mounted.ctx, root, 'personality_analyze', { scope: { kind: 'current' } })
  expect(result.isError, text(result)).toBe(false)
  expect(text(result)).toContain('style.reply-style')
  expect(text(result)).toContain('personality-root#')
  expect(text(result)).toContain('以后回复请用中文。')
  expect(await readFile(globalPersonalityPath(), 'utf8').catch(() => '')).toBe('')
})

test('personality_apply writes only after confirm:true and refreshes the caller section', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)
  const candidate = {
    kind: 'style',
    name: 'language',
    text: '用中文回答。',
    evidence: [{ sessionId: 'personality-root', seq: 1, quote: '用中文回答。' }],
  }

  const result = await call(mounted.ctx, root, 'personality_apply', { candidates: [candidate], confirm: true })
  expect(result.isError, text(result)).toBe(false)
  expect(text(result)).toContain('Applied 1 personality entry')
  const stored = parsePersonalityDocument(await readFile(globalPersonalityPath(), 'utf8'))
  expect(stored.entries).toEqual([{ id: 'style.language', kind: 'style', text: '用中文回答。' }])
  expect(await promptText(mounted.ctx, root)).toContain('用中文回答。')
})

test('personality_apply rejects confirm:false without writing', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)
  const result = await call(mounted.ctx, root, 'personality_apply', {
    candidates: [{
      kind: 'style',
      name: 'language',
      text: '用中文回答。',
      evidence: [{ sessionId: 'personality-root', seq: 1, quote: '用中文回答。' }],
    }],
    confirm: false,
  })
  expect(result.isError).toBe(false)
  expect(text(result)).toContain('confirm must be the literal true')
  await expect(stat(globalPersonalityPath())).rejects.toThrow()
})

test('unloading the provider removes the capability, tools, and sections', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)
  expect(mounted.ctx.tools.get('personality_analyze', root)).toBeDefined()

  await mounted.personalityFiber.dispose()

  expect(mounted.ctx.dafeiyu.status()).toEqual([])
  expect(mounted.ctx.tools.get('personality_analyze', root)).toBeUndefined()
  expect(await promptText(mounted.ctx, root)).toBe('')
})

test('a completed turn leaves PERSONALITY.md absent and records no turn-end write', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)
  root.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle()

  expect(mounted.ctx.dafeiyu.status()[0]?.lastTurnAt).toBeUndefined()
  await expect(stat(globalPersonalityPath())).rejects.toThrow()
})

test('personality_analyze can scan a named session in the same workspace', async () => {
  const mounted = await mount()
  await createRoot(mounted)
  const other = await createRoot(mounted, 'personality-other')
  appendUser(other, '以后回复请用英文。')
  const result = await call(mounted.ctx, other, 'personality_analyze', {
    scope: { kind: 'session', sessionId: 'personality-other' },
  })
  expect(result.isError, text(result)).toBe(false)
  expect(text(result)).toContain('personality-other#')
  expect(text(result)).toContain('以后回复请用英文。')
})

test('personality_analyze rejects identity as a candidate kind', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)
  const result = await call(mounted.ctx, root, 'personality_analyze', {
    scope: { kind: 'current' },
    kinds: ['identity'],
  })
  expect(result.isError).toBe(true)
  expect(text(result)).toContain('identity is manual-only')
})

test('personality_apply rejects identity and missing evidence per candidate', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)
  const result = await call(mounted.ctx, root, 'personality_apply', {
    confirm: true,
    candidates: [
      { kind: 'style', name: 'language', text: '用中文回答。', evidence: [] },
    ],
  })
  expect(result.isError).toBe(false)
  expect(text(result)).toContain('rejected language:')
  const identityResult = await applyPersonalityCandidates(mounted.ctx, {
    confirm: true,
    candidates: [
      { kind: 'identity', name: 'role', text: '开发者。', evidence: [{ sessionId: 'personality-root', seq: 1, quote: '开发者。' }] },
    ],
  } as never, signal)
  expect(identityResult.applied).toEqual([])
  expect(identityResult.rejected[0]?.reason).toContain('identity entries are manual-only')
  await expect(stat(globalPersonalityPath())).rejects.toThrow()
})

test('personality_analyze scans the current session by its own id', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)
  appendUser(root, '不是这个意思，我是说保留原文。')
  const result = await call(mounted.ctx, root, 'personality_analyze', {
    scope: { kind: 'session', sessionId: 'personality-root' },
  })
  expect(result.isError, text(result)).toBe(false)
  expect(text(result)).toContain('understanding.explicit-correction')
})

test('personality_analyze scans the recent workspace sessions', async () => {
  const mounted = await mount()
  const first = await createRoot(mounted)
  const second = await createRoot(mounted, 'personality-recent-2')
  appendUser(first, '以后回复请用中文。')
  appendUser(second, '以后回复请用英文。')
  const result = await call(mounted.ctx, second, 'personality_analyze', {
    scope: { kind: 'recent', limit: 2 },
  })
  expect(result.isError, text(result)).toBe(false)
  expect(text(result)).toContain('Scanned 2 session(s)')
})

test('personality_analyze warns for an unreadable or out-of-workspace session', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)
  const otherDir = join(project, 'other')
  await mkdir(join(otherDir, '.git'), { recursive: true })
  const other = await mounted.harness.create(SessionId('outside-workspace'), {}, { cwd: otherDir })
  await until(() => mounted.ctx.tools.get('personality_analyze', other) !== undefined)
  const result = await call(mounted.ctx, root, 'personality_analyze', {
    scope: { kind: 'session', sessionId: 'outside-workspace' },
  })
  expect(result.isError, text(result)).toBe(false)
  expect(text(result)).toContain('not readable in this workspace')
})

test('personality_analyze rejects invalid candidate bounds', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)
  const zero = await call(mounted.ctx, root, 'personality_analyze', {
    scope: { kind: 'recent', limit: 0 },
  })
  expect(zero.isError).toBe(true)
  const many = await call(mounted.ctx, root, 'personality_analyze', {
    scope: { kind: 'current' },
    maxCandidates: 21,
  })
  expect(many.isError).toBe(true)
})

test('personality_apply rejects an empty candidate list', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)
  const result = await call(mounted.ctx, root, 'personality_apply', { candidates: [], confirm: true })
  expect(result.isError).toBe(false)
  expect(text(result)).toContain('candidates must contain 1 to 20 entries')
})

test('personality_analyze reads a named session from a root caller', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)
  const other = await createRoot(mounted, 'personality-other-root')
  appendUser(other, '以后回复请用英文。')
  const result = await call(mounted.ctx, root, 'personality_analyze', {
    scope: { kind: 'session', sessionId: 'personality-other-root' },
  })
  expect(result.isError, text(result)).toBe(false)
  expect(text(result)).toContain('personality-other-root#')
})

test('personality_analyze handles a caller without cwd and a recent scan', async () => {
  const mounted = await mount()
  const noCwd = await mounted.harness.create(SessionId('personality-no-cwd'), {}, {})
  await until(() => mounted.ctx.tools.get('personality_analyze', noCwd) !== undefined)
  const named = await call(mounted.ctx, noCwd, 'personality_analyze', {
    scope: { kind: 'session', sessionId: 'personality-root' },
  })
  expect(named.isError, text(named)).toBe(false)
  expect(text(named)).toContain('no cwd')

  const recent = await call(mounted.ctx, noCwd, 'personality_analyze', {
    scope: { kind: 'recent', limit: 2 },
  })
  expect(recent.isError, text(recent)).toBe(false)
  expect(text(recent)).toContain('only the current session')
})

test('personality_analyze reports an unreadable authorized session', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)
  vi.spyOn(mounted.ctx.sessionQuery, 'observeSession').mockRejectedValueOnce(new Error('unreadable log'))
  const result = await call(mounted.ctx, root, 'personality_analyze', { scope: { kind: 'current' } })
  expect(result.isError, text(result)).toBe(false)
  expect(text(result)).toContain('unreadable log')
})

test('personality_analyze aggregates repeated evidence and truncates candidates', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)
  appendUser(root, '以后回复请用中文。', 1)
  appendUser(root, '以后回复请用中文。', 2)
  appendUser(root, '以后回复请用中文。', 3)
  appendUser(root, '以后回复请用中文。', 4)
  appendUser(root, '以后回复请用英文。', 5)
  const repeated = await call(mounted.ctx, root, 'personality_analyze', { scope: { kind: 'current' } })
  expect(text(repeated)).toContain('[high, 4x]')

  const truncated = await call(mounted.ctx, root, 'personality_analyze', {
    scope: { kind: 'current' },
    maxCandidates: 1,
  })
  expect(text(truncated)).toContain('(truncated)')
})

test('personality_analyze handles a user message without a turn and a non-user event', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)
  root.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '以后回复请用中文。' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const noTurn = await call(mounted.ctx, root, 'personality_analyze', { scope: { kind: 'current' } })
  expect(text(noTurn)).toContain('reply-style')
  expect(text(noTurn)).not.toContain('(turn ')

  root.session.append('turn/start', { turn: 7 })
  root.session.append('turn/end', { turn: 7, reason: { kind: 'completed' } })
  const ended = await call(mounted.ctx, root, 'personality_analyze', { scope: { kind: 'current' } })
  expect(ended.isError).toBe(false)
})

test('personality_analyze ignores non-user, ordinary, and overlong messages', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted)
  root.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'ordinary instruction' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const ordinary = await call(mounted.ctx, root, 'personality_analyze', { scope: { kind: 'current' } })
  expect(text(ordinary)).toContain('0 candidate(s)')

  root.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `以后${'x'.repeat(400)}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const overlong = await call(mounted.ctx, root, 'personality_analyze', { scope: { kind: 'current' } })
  expect(text(overlong)).toContain('0 candidate(s)')
})

test('activation fails when the legacy source is not a file', async () => {
  await mkdir(globalPersonalityPath(), { recursive: true })
  const mounted = await mount()
  await until(() => mounted.ctx.dafeiyu.status()[0]?.state === 'failed')
  expect(mounted.ctx.dafeiyu.status()[0]?.failure).toMatch(/not a regular file/u)
})
