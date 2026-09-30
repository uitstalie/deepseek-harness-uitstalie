/**
 * Composition tests for the plus loader: the reused native chain and the
 * workspace rules land in ONE `agent-instructions` message, the AGENTS portion
 * stays byte-identical to what the native loader alone produces, and a rules
 * edit after the baseline produces a replacement baseline.
 */
import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, type UserMessage } from '@deepseek-ai/dsh-session'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import * as AgentInstructions from '@deepseek-ai/dsh-agent-instructions'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
  type AgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit'
import * as Plus from '../src/index.ts'

const MAX_BYTES = 64 * 1024
const signal = new AbortController().signal

let project: string
let contexts: Context[]

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'dsh-plus-'))
  contexts = []
})

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await rm(project, { recursive: true, force: true })
})

/** Write one file below the project, creating parents. */
async function write(relativePath: string, content: string): Promise<void> {
  const path = join(project, relativePath)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
}

/** Mount a context owning the loader under test plus its loop prerequisites. */
async function mountLoader(plugin: Parameters<Context['plugin']>[0], config: object): Promise<{ ctx: Context; harness: AgentLoopTestHarness }> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(LocalFileSystem, { cwd: project })
  const harness = await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(plugin, config)
  return { ctx, harness }
}

/** Create one agent whose session cwd is the fixture project. */
async function createAgent(harness: AgentLoopTestHarness, id: string): Promise<Agent> {
  return harness.create(SessionId(id), {}, { cwd: project })
}

/** Drive one pre-step through the scoped waterfall; the context stays pending on an empty batch. */
async function drivePreStep(ctx: Context, agent: Agent): Promise<void> {
  await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [], turn: 1, step: 1, signal },
    async () => ({ kind: 'enter' as const, messages: [] }),
  )
}

/** Text of every text block in one message. */
function messageText(message: UserMessage): string {
  return message.content.map(block => block.type === 'text' ? block.text : '').join('\n')
}

/** The pending instruction messages this plugin put in the inbox. */
function pendingInstructions(agent: Agent): UserMessage[] {
  return agent.inbox.nextStep.filter(message => message.source.kind === 'agent-instructions')
}

/** Admit the pending instruction messages into the session surface, as a turn would. */
function admitPending(ctx: Context, agent: Agent): void {
  for (const message of agent.inbox.nextStep.slice()) {
    const event = agent.session.append('user/message', message, { surfaceOp: 'append' })
    ctx.emit('session/event', agent.session, event)
    agent.inbox.remove(message.id)
  }
}

test('composes the native chain and the rules into one message', async () => {
  await write('AGENTS.md', '# Repo rules\n\nBe careful.')
  await write('.dsh/rules/api.md', 'Always document public APIs.')
  await write('.dsh/rules/nested/style.md', 'Two-space indentation.')

  const { ctx, harness } = await mountLoader(Plus, {
    agentInstructions: { maxBytes: MAX_BYTES },
    rules: { maxBytes: 4096 },
  })
  const native = await mountLoader(AgentInstructions, { maxBytes: MAX_BYTES })

  const agent = await createAgent(harness, 'plus-1')
  const nativeAgent = await createAgent(native.harness, 'native-1')
  await drivePreStep(ctx, agent)
  await drivePreStep(native.ctx, nativeAgent)

  const plus = pendingInstructions(agent)
  expect(plus).toHaveLength(1)
  const text = messageText(plus[0]!)
  expect(text).toContain('Instructions from: AGENTS.md')
  expect(text).toContain('Instructions from: .dsh/rules/api.md')
  expect(text).toContain('Instructions from: .dsh/rules/nested/style.md')
  expect(text).toContain('Always document public APIs.')

  // The reused chain's own rendering is untouched: the AGENTS portion is a
  // byte-identical prefix of what the native loader alone produces.
  const nativeText = messageText(pendingInstructions(nativeAgent)[0]!)
  expect(text.startsWith(nativeText)).toBe(true)
})

test('an absent rules directory leaves the native text unchanged', async () => {
  await write('AGENTS.md', '# Repo rules')
  const { ctx, harness } = await mountLoader(Plus, { agentInstructions: { maxBytes: MAX_BYTES } })
  const native = await mountLoader(AgentInstructions, { maxBytes: MAX_BYTES })
  const agent = await createAgent(harness, 'plus-2')
  const nativeAgent = await createAgent(native.harness, 'native-2')
  await drivePreStep(ctx, agent)
  await drivePreStep(native.ctx, nativeAgent)
  expect(messageText(pendingInstructions(agent)[0]!))
    .toBe(messageText(pendingInstructions(nativeAgent)[0]!))
})

test('a rules edit after the baseline emits a replacement baseline', async () => {
  await write('AGENTS.md', '# Repo rules')
  await write('.dsh/rules/api.md', 'First rule text.')
  const { ctx, harness } = await mountLoader(Plus, {
    agentInstructions: { maxBytes: MAX_BYTES },
    rules: { maxBytes: 4096 },
  })
  const agent = await createAgent(harness, 'plus-3')
  await drivePreStep(ctx, agent)
  const first = pendingInstructions(agent)
  expect(first).toHaveLength(1)
  expect(messageText(first[0]!)).toContain('First rule text.')
  admitPending(ctx, agent)

  await write('.dsh/rules/api.md', 'Second rule text.')
  await drivePreStep(ctx, agent)

  const replacement = pendingInstructions(agent)
  expect(replacement).toHaveLength(1)
  const text = messageText(replacement[0]!)
  expect(text).toContain('Second rule text.')
  expect(text).not.toContain('First rule text.')
  expect(replacement[0]!.source.kind === 'agent-instructions' && replacement[0]!.source.baseline).toBe(true)
})
