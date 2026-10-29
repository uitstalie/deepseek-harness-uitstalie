/**
 * Token calculator tests: the offline DeepSeek V4 tokenizer against reference counts from the
 * HuggingFace `tokenizers` implementation, the `count_tokens` tool, the capability gate, and the
 * `/tokens` command.
 */
import { afterEach, beforeEach, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import Dafeiyu from '@deepseek-ai/dsh-dafeiyu'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as TokenCalculator from '../src/index.ts'
import { countTokens } from '../src/tokenizer.ts'

let contexts: Context[]

beforeEach(() => {
  contexts = []
})

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** Mount the capability, organizer, command registry, and one root agent. */
async function mount(enabled = true): Promise<{ ctx: Context; agent: Agent }> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(Dafeiyu, { capabilities: { tokens: { enabled } } })
  await ctx.plugin(TokenCalculator as never, {} as never)
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('token-calculator'))
  return { ctx, agent }
}

let callCounter = 0
/** Execute one tool through the real runtime and return its result. */
async function callTool(ctx: Context, agent: Agent, args: Record<string, unknown>): Promise<ToolExecutionResult> {
  const batch = await ctx.tools.execute({
    signal: new AbortController().signal,
    calls: [{
      type: 'tool-call',
      id: ToolCallId(`token-call-${String(++callCounter)}`),
      name: 'count_tokens',
      arguments: JSON.stringify(args),
    }],
    agent,
  })
  const result = batch.results[0]?.result
  if (result === undefined) throw new Error('count_tokens settled no result')
  return result
}

/** Text blocks of one tool result. */
function textOf(result: ToolExecutionResult): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/** Execute one slash command and return its settled result. */
async function runCommand(ctx: Context, agent: Agent, line: string): Promise<{ kind: string; text?: string }> {
  const execution = await ctx.commands.execute(agent, line, [], new AbortController().signal)
  if (execution === undefined) throw new Error(`command "${line}" did not resolve`)
  return execution.result
}

test('the bundled tokenizer matches the reference DeepSeek V4 counts', () => {
  // Reference values produced by the HuggingFace tokenizers (0.22.2) implementation with the same tokenizer.json.
  const samples: readonly (readonly [string, number])[] = [
    ['Hello!', 2],
    ['你好，世界！', 4],
    ['DeepSeek V4 tokenizer 测试 12345', 12],
    ['const x = await fetch("https://example.com");\n', 11],
    ['🐳🌊 hello 👨‍👩‍👧‍👦', 16],
    ['1234567890 3.14159 2026-10-29', 16],
    ['a   b\n\nc\t\t d', 7],
    ['<｜begin▁of▁sentence｜>hi', 2],
  ]
  for (const [text, expected] of samples) expect(countTokens(text).tokens, text).toBe(expected)
  expect(countTokens('')).toEqual({ tokens: 0, characters: 0, bytes: 0 })
  expect(countTokens('Hello!', { addSpecialTokens: true }).tokens).toBe(3)
})

test('count_tokens measures text and adds BOS only on request', async () => {
  const { ctx, agent } = await mount()

  const plain = await callTool(ctx, agent, { text: 'Hello!' })
  expect(textOf(plain)).toContain('2 tokens')
  expect(textOf(plain)).toContain('6 characters')
  expect(textOf(plain)).toContain('6 bytes')

  const withBos = await callTool(ctx, agent, { text: 'Hello!', addSpecialTokens: true })
  expect(textOf(withBos)).toContain('3 tokens')
})

test('count_tokens refuses text over the byte cap', async () => {
  const { ctx, agent } = await mount()
  const result = await callTool(ctx, agent, { text: 'x'.repeat(TokenCalculator.TOKEN_TEXT_MAX_BYTES + 1) })
  expect(textOf(result)).toContain('refuses')
})

test('the capability gate removes the tool but keeps the command', async () => {
  const { ctx, agent } = await mount(false)
  expect(ctx.tools.schemas(agent).map(schema => schema.name)).not.toContain('count_tokens')

  const command = await runCommand(ctx, agent, '/tokens Hello!')
  expect(command.kind).toBe('success')
  expect(command.text).toContain('2 tokens')
})

test('/tokens counts text and accepts --bos', async () => {
  const { ctx, agent } = await mount()
  expect((await runCommand(ctx, agent, '/tokens 你好，世界！')).text).toContain('4 tokens')
  expect((await runCommand(ctx, agent, '/tokens --bos Hello!')).text).toContain('3 tokens')
})

test('/tokens reports usage for empty input and refuses over-cap input', async () => {
  const { ctx, agent } = await mount()
  expect((await runCommand(ctx, agent, '/tokens')).text).toContain('Usage: /tokens')
  const long = await runCommand(ctx, agent, `/tokens ${'x'.repeat(TokenCalculator.TOKEN_TEXT_MAX_BYTES + 1)}`)
  expect(long.kind).toBe('error')
  expect(long.text).toContain('at most')
})
