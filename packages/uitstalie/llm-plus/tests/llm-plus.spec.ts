/**
 * llm-plus 组合级测试：真实 Cordis Context + 真实 LlmRuntime + 本插件，
 * fetch 用 vi.stubGlobal 罐装 SSE 响应。
 * 覆盖：四协议的请求序列化与流翻译、credentials seam 凭据解析（不读
 * process.env）、额外 params 原生注入、replay 双向（anthropic 签名 /
 * gemini thoughtSignature / openai-responses encrypted_content）、
 * HTTP 错误分类、目录集成、配置 fail loud、fiber 摘除。
 */
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createMessage, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import ModelsDevCatalog from '@deepseek-ai/dsh-models-dev'
import * as llmPlus from '@deepseek-ai/dsh-llm-plus'

// models-dev 的测试夹具（deepseek provider，两个模型）
const FIXTURE_URL = pathToFileURL(
  fileURLToPath(new URL('../../models-dev/tests/fixtures/api.json', import.meta.url)),
).href

/** 最后一次 fetch 调用的记录（断言注入用）。 */
let lastFetch: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | undefined

/** 罐装 SSE 响应表：url 子串 → SSE 文本；未匹配的 URL 返回 500。 */
let sseByUrl: [string, string][] = []

/** 把 SSE 文本包成 fetch Response。 */
function sseResponse(text: string): Response {
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

beforeEach(() => {
  lastFetch = undefined
  sseByUrl = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    lastFetch = {
      url,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    }
    const hit = sseByUrl.find(([prefix]) => url.includes(prefix))
    if (!hit) return new Response('no canned response for ' + url, { status: 500 })
    return sseResponse(hit[1])
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** 挂载 credentials stub + 四协议路由 + 可选 models-dev 目录。 */
async function mount(options?: { withCatalog?: boolean }): Promise<Context> {
  const ctx = new Context()
  // 凭据 stub：credentials seam 是本插件的唯一凭据路径（不读 process.env）
  ctx.root.provide('credentials', {
    resolve: (ref: string) => Promise.resolve({ value: `key-for-${String(ref)}`, source: 'test' }),
  })
  await ctx.plugin(LlmRuntime)
  if (options?.withCatalog) {
    await ctx.plugin(ModelsDevCatalog, {
      sourceUrl: FIXTURE_URL,
      extraParams: { deepseek: { body: { thinking: { type: 'enabled' } } } },
    })
  }
  await ctx.plugin(llmPlus, {
    routes: {
      'ds-plus': {
        protocol: 'openai-completions',
        baseURL: 'http://test.local/v1',
        apiKeyRef: 'DEEPSEEK_TEST',
        ...(options?.withCatalog ? { modelsDevProvider: 'deepseek' } : {}),
      },
      'claude-plus': { protocol: 'anthropic-messages', baseURL: 'http://test.local/anthropic/v1', apiKeyRef: 'ANTHROPIC_TEST' },
      'gemini-plus': { protocol: 'gemini', baseURL: 'http://test.local/gemini', apiKeyRef: 'GEMINI_TEST' },
      'oa-plus': { protocol: 'openai-responses', baseURL: 'http://test.local/oa/v1', apiKeyRef: 'OPENAI_TEST' },
    },
  })
  return ctx
}

/** 收集一次 stream 的全部 chunk。 */
async function collect(ctx: Context, options: GenerateOptions): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of ctx.root.llm.stream(options)) chunks.push(chunk)
  return chunks
}

/** 造一条最小 user 消息。 */
function userMessage(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** 造一条带 replayState 的 assistant 历史消息（replay 测试用）。 */
function assistantMessage(provider: string, model: string, replayState: unknown) {
  return createMessage({
    role: 'assistant',
    content: [
      { type: 'reasoning', text: '想一下' },
      { type: 'text', text: '你好' },
    ],
    source: { kind: 'model', provider, model, replayState },
  })
}

const OPENAI_SSE = [
  'data: {"choices":[{"delta":{"reasoning_content":"想一下"},"finish_reason":null}]}',
  '',
  'data: {"choices":[{"delta":{"content":"你好"},"finish_reason":null}]}',
  '',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"bash","arguments":"{\\"command\\":"}}]},"finish_reason":null}]}',
  '',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"ls\\"}"}}]},"finish_reason":null}]}',
  '',
  'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15,"prompt_tokens_details":{"cached_tokens":4}}}',
  '',
  'data: [DONE]',
  '',
].join('\n')

test('openai-completions: request shape and full chunk sequence', async () => {
  // reasoningEffort 需要目录提供档位元数据（runtime 在派发前校验），挂目录
  const ctx = await mount({ withCatalog: true })
  sseByUrl = [['http://test.local/v1/chat/completions', OPENAI_SSE]]

  const chunks = await collect(ctx, {
    provider: 'ds-plus',
    model: 'deepseek-v4-flash',
    system: '你是助手',
    messages: [userMessage('hi')],
    reasoningEffort: 'high' as never,
  })

  // 凭据经 credentials seam 解析（stub 的命名规则 key-for-<ref>）
  expect(lastFetch!.headers['authorization']).toBe('Bearer key-for-DEEPSEEK_TEST')
  expect(lastFetch!.body.model).toBe('deepseek-v4-flash')
  expect(lastFetch!.body.reasoning_effort).toBe('high')
  expect(lastFetch!.body.stream).toBe(true)
  const messages = lastFetch!.body.messages as { role: string; content: string }[]
  expect(messages[0]).toEqual({ role: 'system', content: '你是助手' })
  expect(messages[1]).toEqual({ role: 'user', content: 'hi' })

  // 流翻译：reasoning block 0 → text block 1 → tool-call block 2
  const types = chunks.map(chunk => chunk.type)
  expect(types).toEqual([
    'block-start', 'reasoning-delta',
    'block-start', 'text-delta',
    'block-start', 'tool-call-delta', 'tool-call-delta',
    'usage',
    'block-end', 'block-end', 'block-end',
    'finish',
  ])
  const toolEnd = chunks.find(chunk => chunk.type === 'block-end' && chunk.index === 2)
  expect(toolEnd).toMatchObject({ block: { type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{"command":"ls"}' } })
  // cached 从 input 拆出（DISJOINT 契约）
  expect(chunks.find(chunk => chunk.type === 'usage')).toMatchObject({ usage: { inputTokens: 6, cacheReadTokens: 4, outputTokens: 5 } })
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
})

const ANTHROPIC_SSE = [
  'event: message_start',
  'data: {"message":{"usage":{"input_tokens":12,"output_tokens":1,"cache_read_input_tokens":3}}}',
  '',
  'event: content_block_start',
  'data: {"index":0,"content_block":{"type":"thinking","thinking":""}}',
  '',
  'event: content_block_delta',
  'data: {"index":0,"delta":{"type":"thinking_delta","thinking":"想一下"}}',
  '',
  'event: content_block_delta',
  'data: {"index":0,"delta":{"type":"signature_delta","signature":"sig-abc"}}',
  '',
  'event: content_block_stop',
  'data: {"index":0}',
  '',
  'event: content_block_start',
  'data: {"index":1,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"index":1,"delta":{"type":"text_delta","text":"好的"}}',
  '',
  'event: content_block_stop',
  'data: {"index":1}',
  '',
  'event: message_delta',
  'data: {"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}',
  '',
  'event: message_stop',
  'data: {}',
  '',
].join('\n')

test('anthropic-messages: signature captured into replayState and replayed into history', async () => {
  const ctx = await mount()
  sseByUrl = [['http://test.local/anthropic/v1/messages', ANTHROPIC_SSE]]

  const chunks = await collect(ctx, {
    provider: 'claude-plus',
    model: 'claude-sonnet-5',
    messages: [userMessage('hi')],
    maxTokens: 1024,
  })

  expect(lastFetch!.headers['x-api-key']).toBe('key-for-ANTHROPIC_TEST')
  expect(lastFetch!.body.max_tokens).toBe(1024)
  const types = chunks.map(chunk => chunk.type)
  expect(types).toEqual([
    'usage', 'block-start', 'reasoning-delta', 'block-end',
    'block-start', 'text-delta', 'block-end', 'finish',
  ])

  // replay 采集：finish 的 replayState 里 reasoning block 带签名
  const finish = chunks.at(-1)
  const replay = (finish as { replayState?: { protocol: string; blocks: unknown[] } }).replayState
  expect(replay).toMatchObject({ kind: 'llm-plus', version: 1, protocol: 'anthropic-messages' })
  expect(replay!.blocks).toEqual([{ signature: 'sig-abc' }, null])

  // replay 回带：同一模型再次请求时，历史里的 reasoning 恢复为带签名的 thinking 块
  const history = assistantMessage('claude-plus', 'claude-sonnet-5', replay)
  await collect(ctx, { provider: 'claude-plus', model: 'claude-sonnet-5', messages: [history, userMessage('继续')] })
  const sent = lastFetch!.body.messages as { role: string; content: { type: string }[] }[]
  expect(sent[0]!.content[0]).toEqual({ type: 'thinking', thinking: '想一下', signature: 'sig-abc' })
  expect(sent[0]!.content[1]).toEqual({ type: 'text', text: '你好' })

  // 降级路径：协议不匹配的 envelope 不回带（reasoning 块被丢弃而不是伪造）。
  // 消息声称来自 oa-plus 路由，replayState 也是 openai-responses 协议的
  const foreignEnvelope = { kind: 'llm-plus', version: 1, protocol: 'openai-responses', blocks: [null, null] }
  await collect(ctx, { provider: 'claude-plus', model: 'claude-sonnet-5', messages: [assistantMessage('oa-plus', 'm', foreignEnvelope), userMessage('继续')] })
  const degraded = lastFetch!.body.messages as { role: string; content: { type: string }[] }[]
  expect(degraded[0]!.content.some(block => block.type === 'thinking')).toBe(false)
})

const GEMINI_SSE = [
  'data: {"candidates":[{"content":{"parts":[{"text":"想一下","thought":true,"thoughtSignature":"sig-g1"}],"role":"model"}}]}',
  '',
  'data: {"candidates":[{"content":{"parts":[{"text":"你好"}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":4,"thoughtsTokenCount":2,"totalTokenCount":15}}',
  '',
].join('\n')

test('gemini: thoughtSignature replay round trip', async () => {
  const ctx = await mount()
  sseByUrl = [['http://test.local/gemini/v1beta/models/gemini-3.6-flash:streamGenerateContent', GEMINI_SSE]]

  const chunks = await collect(ctx, { provider: 'gemini-plus', model: 'gemini-3.6-flash', messages: [userMessage('hi')] })
  expect(lastFetch!.headers['x-goog-api-key']).toBe('key-for-GEMINI_TEST')

  const finish = chunks.at(-1)
  const replay = (finish as { replayState?: { protocol: string; blocks: unknown[] } }).replayState
  expect(replay).toMatchObject({ kind: 'llm-plus', protocol: 'gemini' })
  expect(replay!.blocks).toEqual([{ thoughtSignature: 'sig-g1' }, null])

  // 回带：reasoning 恢复为带 thoughtSignature 的 part
  await collect(ctx, {
    provider: 'gemini-plus',
    model: 'gemini-3.6-flash',
    messages: [assistantMessage('gemini-plus', 'gemini-3.6-flash', replay), userMessage('继续')],
  })
  const contents = lastFetch!.body.contents as { role: string; parts: Record<string, unknown>[] }[]
  expect(contents[0]!.parts[0]).toEqual({ text: '想一下', thought: true, thoughtSignature: 'sig-g1' })
})

const OPENAI_RESPONSES_SSE = [
  'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs_1"}}',
  '',
  'data: {"type":"response.output_item.added","output_index":1,"item":{"type":"message"}}',
  '',
  'data: {"type":"response.output_text.delta","output_index":1,"delta":"你好"}',
  '',
  'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"rs_1","encrypted_content":"enc-xyz"}}',
  '',
  'data: {"type":"response.output_item.done","output_index":1,"item":{"type":"message"}}',
  '',
  'data: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":8,"output_tokens":3,"total_tokens":11,"output_tokens_details":{"reasoning_tokens":2}}}}',
  '',
].join('\n')

test('openai-responses: item vocabulary and encrypted_content replay round trip', async () => {
  const ctx = await mount()
  sseByUrl = [['http://test.local/oa/v1/responses', OPENAI_RESPONSES_SSE]]

  const chunks = await collect(ctx, { provider: 'oa-plus', model: 'gpt-5.6-luna', messages: [userMessage('hi')] })

  expect(lastFetch!.headers['authorization']).toBe('Bearer key-for-OPENAI_TEST')
  // store:false + include encrypted_content 是 replay 的前提
  expect(lastFetch!.body.store).toBe(false)
  expect(lastFetch!.body.include).toEqual(['reasoning.encrypted_content'])

  const types = chunks.map(chunk => chunk.type)
  expect(types).toEqual([
    'block-start', 'block-start', 'text-delta', 'block-end', 'block-end',
    'usage', 'finish',
  ])
  const finish = chunks.at(-1)
  const replay = (finish as { replayState?: { blocks: unknown[] } }).replayState
  expect(replay).toMatchObject({ kind: 'llm-plus', protocol: 'openai-responses' })
  expect(replay!.blocks).toEqual([{ id: 'rs_1', encrypted_content: 'enc-xyz' }, null])

  // 回带：reasoning item 原样进 input
  await collect(ctx, {
    provider: 'oa-plus',
    model: 'gpt-5.6-luna',
    messages: [assistantMessage('oa-plus', 'gpt-5.6-luna', replay), userMessage('继续')],
  })
  const input = lastFetch!.body.input as Record<string, unknown>[]
  expect(input[0]).toEqual({ type: 'reasoning', id: 'rs_1', encrypted_content: 'enc-xyz' })
  expect(input[1]).toEqual({ role: 'assistant', content: [{ type: 'output_text', text: '你好' }] })
})

test('extra params: catalog-level body merges into the request natively', async () => {
  const ctx = await mount({ withCatalog: true })
  sseByUrl = [['http://test.local/v1/chat/completions', 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n']]

  await collect(ctx, { provider: 'ds-plus', model: 'deepseek-v4-flash', messages: [userMessage('hi')] })

  // models-dev 插件配置的 thinking 字段被原生写进请求体（无 api-extensions 绕道）
  expect(lastFetch!.body.thinking).toEqual({ type: 'enabled' })

  // 目录数据驱动 listModels
  const models = await ctx.root.llm.listModels('ds-plus')
  expect(models.map(model => model.id).sort()).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
  const resolved = await ctx.root.llm.resolveModelInfo('ds-plus', 'deepseek-v4-flash')
  expect(resolved.context?.contextWindow).toBe(1_000_000)
  expect(resolved.reasoning?.efforts.map(effort => effort.id)).toEqual(['low', 'high', 'max'])
})

test('HTTP errors become LlmError with status-based classification', async () => {
  const ctx = await mount()
  vi.stubGlobal('fetch', async () => new Response('rate limited', { status: 429, headers: { 'retry-after': '2' } }))

  const chunks = await collect(ctx, { provider: 'ds-plus', model: 'm', messages: [userMessage('hi')] })
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', status: 429, providerRetryAfterMs: 2000 } } })
})

test('missing credential fails with actionable AUTH error, never reading process.env', async () => {
  const ctx = new Context()
  // 凭据 stub 返回 undefined（未配置）
  ctx.root.provide('credentials', { resolve: () => Promise.resolve(undefined) })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(llmPlus, {
    routes: { 'no-key': { protocol: 'openai-completions', baseURL: 'http://test.local', apiKeyRef: 'MISSING_KEY' } },
  })
  sseByUrl = [['http://test.local', 'data: [DONE]\n']]
  const chunks = await collect(ctx, { provider: 'no-key', model: 'm', messages: [userMessage('hi')] })
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH' } } })
  // fetch 绝不应被调用
  expect(lastFetch).toBeUndefined()
})

test('invalid route config fails loud at activation', async () => {
  const ctx = new Context()
  ctx.root.provide('credentials', { resolve: () => Promise.resolve(undefined) })
  await ctx.plugin(LlmRuntime)
  const fiber = ctx.plugin(llmPlus, { routes: { bad: { protocol: 'no-such-protocol' as never } } })
  await expect(fiber).rejects.toThrow(/unknown protocol/)
})

test('adapter routes are removed with the plugin fiber', async () => {
  const ctx = await mount()
  // listProviders 返回 LlmProviderInfo[]（{id, name}），按 id 断言
  expect(ctx.root.llm.listProviders().map(provider => provider.id)).toContain('ds-plus')
  await ctx.root.registry.delete(llmPlus)
  expect(ctx.root.llm.listProviders().map(provider => provider.id)).not.toContain('ds-plus')
})
