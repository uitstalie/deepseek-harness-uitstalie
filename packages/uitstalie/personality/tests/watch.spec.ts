/**
 * Watch-refresh tests: one global watcher updates the cached prompt text for
 * live agents, an unsupported watch degrades to the per-agent read with a debug
 * log, and disposing the provider closes the watcher. The filesystem service is
 * real; only its `watch` primitive is stubbed through the service instance.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber, Message } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit'
import type { AgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import Dafeiyu from '@deepseek-ai/dsh-dafeiyu'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createDshStore } from '@deepseek-ai/dsh-store-atom'
import * as Personality from '../src/index.ts'
import {
  PERSONALITY_FILE_NAME,
  renderPersonalityDocument,
} from '../src/personality-file.ts'
import type { PersonalityDocument, PersonalityEntry } from '../src/personality-file.ts'
import { PERSONALITY_PROMPT_SECTION_NAME } from '../src/prompt.ts'

let project: string
let contexts: Context[]

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'dsh-personality-watch-'))
  // A `.git` marker makes the fixture look like a checkout, so project-root
  // discovery resolves to the fixture rather than to the temp directory above it.
  await mkdir(join(project, '.git'), { recursive: true })
  contexts = []
})

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await rm(project, { recursive: true, force: true })
})

/** Absolute path of the fixture global profile. */
function globalFile(): string {
  return join(project, 'home', 'personality', PERSONALITY_FILE_NAME)
}

/** One captured watcher registration. */
interface WatchCall {
  readonly target: FsTarget
  readonly changed: (error?: Error) => void
  readonly signal: AbortSignal
}

/** Options that change what the stubbed watch primitive does. */
interface MountOptions {
  readonly watch?: 'active' | 'unsupported'
  readonly beforePersonality?: (ctx: Context) => void
}

interface Mounted {
  readonly ctx: Context
  readonly harness: AgentLoopTestHarness
  readonly personalityFiber: Fiber
  readonly calls: readonly WatchCall[]
  /** Closures requested by the provider through its watcher's close function. */
  closeCount(): number
}

/** One entry fixture. */
function entry(kind: PersonalityEntry['kind'], name: string, text: string): PersonalityEntry {
  return { id: `${kind}.${name}`, kind, name, text }
}

/** Write the global profile before the provider activates. */
async function seedGlobal(entries: readonly PersonalityEntry[], version = 1): Promise<void> {
  const document: PersonalityDocument = {
    version,
    updatedAt: '2026-10-21T00:00:00.000Z',
    entries,
    frame: { before: '\n', after: '\n' },
  }
  await mkdir(join(project, 'home', 'personality'), { recursive: true })
  await writeFile(globalFile(), renderPersonalityDocument(document), 'utf8')
}

/** Write the workspace overlay before the provider activates. */
async function seedOverlay(entries: readonly PersonalityEntry[], version = 1): Promise<void> {
  const document: PersonalityDocument = {
    version,
    updatedAt: '2026-10-21T00:00:00.000Z',
    entries,
    frame: { before: '\n', after: '\n' },
  }
  await mkdir(join(project, '.dsh', 'memory'), { recursive: true })
  await writeFile(join(project, '.dsh', 'memory', PERSONALITY_FILE_NAME), renderPersonalityDocument(document), 'utf8')
}

/** Mount the real services and provider over a stubbed watch primitive. */
async function mount(options: MountOptions = {}): Promise<Mounted> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(LocalFileSystem, { cwd: project })
  ctx.provide('dshStore', createDshStore(ctx, false))
  const calls: WatchCall[] = []
  let closes = 0
  vi.spyOn(ctx.fs, 'watch').mockImplementation(async (target, changed, signal) => {
    if (options.watch === 'unsupported') {
      throw new FsError('Filesystem watching is not supported by this provider.', 'FS_IO_ERROR')
    }
    calls.push({ target, changed, signal })
    return async () => { closes += 1 }
  })
  options.beforePersonality?.(ctx)
  await ctx.plugin(Dafeiyu)
  const personalityFiber = await ctx.plugin(Personality, { globalPath: globalFile() })
  await settle()
  const harness = await mountAgentLoopTestHarness(ctx)
  return { ctx, harness, personalityFiber, calls, closeCount: () => closes }
}

/** Let activation and dispatch continuations run. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
}

/** Poll until a test-owned condition becomes true. */
async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (condition()) return
    await new Promise<void>((resolve) => { setTimeout(resolve, 1) })
  }
  throw new Error('condition was not met')
}

/** Create one root agent and wait for its capability wiring. */
async function createRoot(mounted: Mounted): Promise<Agent> {
  const root = await mounted.harness.create(SessionId('personality-watch-root'), {}, { cwd: project })
  await until(() => mounted.ctx.tools.get('personality_learn', root) !== undefined)
  return root
}

/** Resolve the current personality section text for one agent. */
async function promptText(ctx: Context, agent: Agent): Promise<string> {
  const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent))
  return assembly.sections.find(section => section.name === PERSONALITY_PROMPT_SECTION_NAME)?.text ?? ''
}

/** Poll until the assembled section text contains the expected text. */
async function untilPrompt(ctx: Context, agent: Agent, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if ((await promptText(ctx, agent)).includes(expected)) return
    await new Promise<void>((resolve) => { setTimeout(resolve, 1) })
  }
  throw new Error(`prompt text never contained ${JSON.stringify(expected)}`)
}

test('one global watch refreshes the cached prompt text for live agents', async () => {
  await seedGlobal([entry('style', 'language', '旧文本。')])
  const mounted = await mount()
  const root = await createRoot(mounted)
  await until(() => mounted.calls.length === 1)
  await untilPrompt(mounted.ctx, root, '旧文本。')
  const watch = mounted.calls[0]
  expect(watch?.target.displayPath).toBe(globalFile())
  expect(mounted.closeCount()).toBe(0)

  await seedGlobal([entry('style', 'language', '新文本。')], 2)
  watch?.changed()
  await untilPrompt(mounted.ctx, root, '新文本。')

  const text = await promptText(mounted.ctx, root)
  expect(text).toContain('新文本。')
  expect(text).not.toContain('旧文本。')
  expect(mounted.calls).toHaveLength(1)
})

test('a workspace overlay edit refreshes the live agent prompt', async () => {
  await seedGlobal([entry('style', 'language', 'global text')])
  await seedOverlay([entry('style', 'language', 'overlay text')])
  const mounted = await mount()
  const root = await createRoot(mounted)
  await until(() => mounted.calls.length === 2)
  await untilPrompt(mounted.ctx, root, 'overlay text')
  const overlay = mounted.calls[1]
  expect(overlay?.target.displayPath).toBe(join(project, '.dsh', 'memory', PERSONALITY_FILE_NAME))

  await seedOverlay([entry('style', 'language', 'edited overlay text')], 2)
  overlay?.changed()
  await untilPrompt(mounted.ctx, root, 'edited overlay text')
  expect(await promptText(mounted.ctx, root)).not.toContain('global text')
})

test('an unsupported watch degrades to the per-agent read and logs at debug', async () => {
  await seedGlobal([entry('style', 'language', '预读文本。')])
  const messages: Message[] = []
  const mounted = await mount({
    watch: 'unsupported',
    beforePersonality: (ctx) => {
      ctx.logger.exporter({ levels: { default: 3 }, export: (message) => { messages.push(message) } })
    },
  })
  const root = await createRoot(mounted)

  await until(() => messages.some(message =>
    message.type === 'debug' && String(message.args[0]).includes('filesystem watch is unavailable')))
  expect(mounted.calls).toHaveLength(0)
  expect(mounted.closeCount()).toBe(0)
  expect(mounted.ctx.dafeiyu.status()).toEqual([{
    id: 'personality',
    present: true,
    enabled: true,
    state: 'active',
    label: Personality.PERSONALITY_CAPABILITY_LABEL,
    description: Personality.PERSONALITY_CAPABILITY_DESCRIPTION,
    settings: { sectionId: 'personality', order: 210 },
  }])
  expect(await promptText(mounted.ctx, root)).toContain('预读文本。')

  // A new agent still reads the file even though no watcher exists.
  await seedGlobal([entry('style', 'language', '后来写入。')], 2)
  const later = await mounted.harness.create(SessionId('personality-watch-later'), {}, { cwd: project })
  await until(() => mounted.ctx.tools.get('personality_learn', later) !== undefined)
  await untilPrompt(mounted.ctx, later, '后来写入。')
})

test('disposing the provider closes the watcher and stops refreshes', async () => {
  await seedGlobal([entry('style', 'language', '旧文本。')])
  const mounted = await mount()
  const root = await createRoot(mounted)
  await until(() => mounted.calls.length === 1)
  await untilPrompt(mounted.ctx, root, '旧文本。')
  const watch = mounted.calls[0]

  await mounted.personalityFiber.dispose()

  expect(mounted.closeCount()).toBe(1)
  expect(watch?.signal.aborted).toBe(true)
  await seedGlobal([entry('style', 'language', '关闭后写入。')], 2)
  watch?.changed()
  await settle()
  expect(mounted.closeCount()).toBe(1)
  expect(await promptText(mounted.ctx, root)).toBe('')
})
