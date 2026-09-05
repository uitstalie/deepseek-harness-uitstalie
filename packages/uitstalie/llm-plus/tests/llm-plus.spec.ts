/**
 * llm-plus 组合级测试：真实 Cordis Context + 真实 LlmRuntime + 本插件，
 * fetch 用 vi.stubGlobal 罐装 SSE 响应。
 * 覆盖：四协议的请求序列化与流翻译、credentials seam 凭据解析（不读
 * process.env）、额外 params 原生注入、replay 双向（anthropic 签名 /
 * gemini thoughtSignature / openai-responses encrypted_content）、
 * HTTP 错误分类、目录集成、配置 fail loud、fiber 摘除。
 */
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createMessage, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import ModelsDevCatalog from '@deepseek-ai/dsh-models-dev'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import * as llmPlus from '@deepseek-ai/dsh-llm-plus'
import { resolveRoutes } from '../src/config.ts'

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
  // 结构化 schema 在写入点先拒绝（错误精确到配置路径），手工校验在其后兜底
  await expect(fiber).rejects.toThrow(/routes\.bad\.protocol/)
})

test('adapter routes are removed with the plugin fiber', async () => {
  const ctx = await mount()
  // listProviders 返回 LlmProviderInfo[]（{id, name}），按 id 断言
  expect(ctx.root.llm.listProviders().map(provider => provider.id)).toContain('ds-plus')
  await ctx.root.registry.delete(llmPlus)
  expect(ctx.root.llm.listProviders().map(provider => provider.id)).not.toContain('ds-plus')
})

test('every route registers a configurable-provider directory entry, removed with the fiber', async () => {
  const ctx = await mount()
  const entries = ctx.root.llm.listConfigurableProviders()
  // 每条路由一条目录条目：settingsNs/settingsPath 指向 llm-plus 命名空间的路由对象
  const dsPlus = entries.find(entry => entry.provider === 'ds-plus')
  expect(dsPlus).toMatchObject({
    displayName: 'ds-plus',
    settingsNs: 'llm-plus',
    settingsPath: ['routes', 'ds-plus'],
    declared: true,
  })
  expect(entries.filter(entry => entry.settingsNs === 'llm-plus').map(entry => entry.provider).sort())
    .toEqual(['claude-plus', 'ds-plus', 'gemini-plus', 'oa-plus'])

  await ctx.root.registry.delete(llmPlus)
  expect(ctx.root.llm.listConfigurableProviders().some(entry => entry.settingsNs === 'llm-plus')).toBe(false)
})

test('model discovery answers from adapter knowledge for an existing route, zero network', async () => {
  const ctx = await mount({ withCatalog: true })
  // request.provider 指名已有路由：目录数据直接作答，不发任何 HTTP
  const models = await ctx.root.llm.discoverModels('llm-plus', { provider: 'ds-plus' })
  expect(models.map(model => model.id).sort()).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
  expect(lastFetch).toBeUndefined()
})

test('model discovery interrogates the draft endpoint with the one-shot credential', async () => {
  const ctx = await mount()
  sseByUrl = [['http://test.local/v1/models', '{"data":[{"id":"m1"},{"id":"m2"}]}']]
  const models = await ctx.root.llm.discoverModels('llm-plus', {
    baseURL: 'http://test.local/v1',
    api: 'openai-completions',
    apiKey: 'draft-key',
  })
  expect(models).toEqual([{ id: 'm1' }, { id: 'm2' }])
  // 一次性凭据只用于这次 interrogation（harness 不存储）
  expect(lastFetch!.headers['authorization']).toBe('Bearer draft-key')
})

test('model discovery rejects an unknown draft protocol', async () => {
  const ctx = await mount()
  await expect(ctx.root.llm.discoverModels('llm-plus', { baseURL: 'http://x', api: 'nope' }))
    .rejects.toThrow(/unknown discovery protocol/)
})

test('route-level retryPolicy is resolved at activation and captured at registration', async () => {
  const ctx = new Context()
  ctx.root.provide('credentials', { resolve: () => Promise.resolve(undefined) })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(llmPlus, {
    routes: {
      'retry-plus': {
        protocol: 'openai-completions',
        baseURL: 'http://test.local/v1',
        retryPolicy: { mode: 'normal', maxRetries: 2, retryableCodes: ['RATE_LIMIT'] },
      },
      'default-plus': { protocol: 'openai-completions', baseURL: 'http://test.local/v1' },
    },
  })
  // 配置的策略被解析并被 registry 捕获（llm-retry 读的就是这里）
  expect(ctx.root.llm.providerRetryPolicy('retry-plus')).toMatchObject({ mode: 'normal', maxRetries: 2, retryableCodes: ['RATE_LIMIT'] })
  // 未配置的路由回落到全局默认策略（normal 模式的默认 maxRetries 不是 2）
  const fallback = ctx.root.llm.providerRetryPolicy('default-plus')
  expect(fallback.mode === 'normal' && fallback.maxRetries !== 2).toBe(true)
})

test('route requestImagePolicy projects images through the attachment seam', async () => {
  const ctx = new Context()
  ctx.root.provide('credentials', { resolve: (ref: string) => Promise.resolve({ value: `key-for-${ref}`, source: 'test' }) })
  // attachments stub：readImageRequest 返回投影后的固定字节；readImage 若被调用即记证
  const calls: string[] = []
  const ref = { attachmentId: 'att-1', mediaType: 'image/png', bytes: 9, width: 3, height: 3 } as never
  ctx.root.provide('attachments', {
    readImage: () => { calls.push('readImage'); return Promise.resolve({ ref, data: new Uint8Array([9, 9, 9]) }) },
    readImageRequest: (r: never, policy: { maxPixels: number; maxBytes: number }) => {
      calls.push(`readImageRequest:${policy.maxPixels}/${policy.maxBytes}`)
      return Promise.resolve({ variantId: 'v1', attachment: r, data: new Uint8Array([1, 2, 3]), mediaType: 'image/png', bytes: 3, width: 1, height: 1, depth: 'uchar', space: 'srgb' })
    },
  })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(llmPlus, {
    routes: {
      'vision-plus': {
        protocol: 'openai-completions',
        baseURL: 'http://test.local/v1',
        apiKeyRef: 'VISION_TEST',
        models: [{ id: 'vision-1', inputModalities: ['text', 'image'] }],
        requestImagePolicy: { maxPixels: 1_000_000, maxBytes: 50_000 },
      },
    },
  })
  sseByUrl = [['http://test.local/v1/chat/completions', 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n']]
  await collect(ctx, {
    provider: 'vision-plus',
    model: 'vision-1',
    messages: [createUserMessage({ content: [{ type: 'text', text: '看图' }, { type: 'image', attachment: ref }], source: { kind: 'user' } })],
  })
  // 走了 readImageRequest（带路由声明的预算），不是 readImage 原图
  expect(calls).toEqual(['readImageRequest:1000000/50000'])
  // 请求体里是投影后的字节（base64 of [1,2,3]）
  const messages = lastFetch!.body.messages as { content: { type: string; image_url?: { url: string } }[] }[]
  expect(messages[0]!.content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } })
})

test('anthropic maps numeric reasoning effort to clamped budget_tokens', async () => {
  // 直接调协议实现（同包内部面）：数值 effort → budget_tokens，clamp 进预算范围
  const { anthropicMessages } = await import('../src/protocols/anthropic-messages.ts')
  const route = resolveRoutes({ c: { protocol: 'anthropic-messages', baseURL: 'http://x' } })[0]!
  const build = (reasoningEffort: string) => anthropicMessages.buildRequest(route as never, {
    provider: 'c',
    model: 'm',
    messages: [userMessage('hi')],
    reasoningEffort: reasoningEffort as never,
  } as never, { image: () => Promise.resolve(undefined), reasoning: { budget: { min: 1024, max: 8192 } } })
  expect((await build('100000')).body.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 })
  expect((await build('512')).body.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 })
  expect((await build('4000')).body.thinking).toEqual({ type: 'enabled', budget_tokens: 4000 })
  // 非数值档位只开思考（Anthropic 没有档位概念）
  expect((await build('high')).body.thinking).toEqual({ type: 'enabled' })
})

test('openai effort outside the declared pool fails before any request leaves', async () => {
  const ctx = await mount({ withCatalog: true })
  const chunks = await collect(ctx, {
    provider: 'ds-plus',
    model: 'deepseek-v4-flash',
    messages: [userMessage('hi')],
    reasoningEffort: 'bogus' as never,
  })
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
  expect(lastFetch).toBeUndefined()
})

test('anthropic serializer warns on replay degrade instead of forging history', async () => {
  // 直接调协议实现（同包内部面）：envelope 与 content 位置对不齐 → 降级告警 + 丢弃
  const { anthropicMessages } = await import('../src/protocols/anthropic-messages.ts')
  const route = resolveRoutes({ 'claude-plus': { protocol: 'anthropic-messages', baseURL: 'http://test.local' } })[0]!
  const reasons: string[] = []
  const misaligned = { kind: 'llm-plus', version: 1, protocol: 'anthropic-messages', response: {}, blocks: [null] }
  await anthropicMessages.buildRequest(route as never, {
    provider: 'claude-plus',
    model: 'claude-sonnet-5',
    messages: [
      createMessage({
        role: 'assistant',
        content: [{ type: 'reasoning', text: '想一下' }, { type: 'text', text: '你好' }],
        source: { kind: 'model', provider: 'claude-plus', model: 'claude-sonnet-5', replayState: misaligned },
      }),
      userMessage('继续'),
    ],
  } as never, {
    image: () => Promise.resolve(undefined),
    onReplayDegrade: reason => reasons.push(reason),
  })
  expect(reasons.some(reason => reason.includes('misaligned'))).toBe(true)
})

test('oauth route resolves the stored grant as Bearer, refreshing when near expiry', async () => {
  const ctx = new Context()
  // credentials stub：grant 记录存在内存表里，refresh 时换新 token
  let record: { kind: 'grant'; payload: unknown } | undefined = {
    kind: 'grant',
    payload: { type: 'oauth', access: 'kimi-access-1', refresh: 'kimi-refresh', expires: Date.now() + 60_000 }, // 1 分钟后过期 → 触发刷新
  }
  let refreshed = 0
  ctx.root.provide('credentials', {
    resolve: () => Promise.resolve(undefined),
    readRecord: () => Promise.resolve(record),
    modifyRecord: (_key: unknown, mutate: (current: unknown) => Promise<typeof record>) => {
      return Promise.resolve(mutate(record)).then((next) => {
        refreshed++
        if (next !== undefined) record = next
        return record
      })
    },
    deleteRecord: () => Promise.resolve(),
  })
  await ctx.plugin(LlmRuntime)
  // kimi-coding flow 的 refresh 会打 auth.kimi.com——罐装它
  const refreshTokenEndpoint = 'https://auth.kimi.com/api/oauth/token'
  sseByUrl = [['http://test.local/v1/chat/completions', 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n']]
  // fetch stub 只认 SSE 表；OAuth 刷新端点要走 fetch JSON——单独 stub
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url === refreshTokenEndpoint) {
      return new Response(JSON.stringify({ access_token: 'kimi-access-2', refresh_token: 'kimi-refresh-2', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    lastFetch = {
      url,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>,
    }
    const hit = sseByUrl.find(([prefix]) => url.includes(prefix))
    if (!hit) return new Response('no canned response for ' + url, { status: 500 })
    return sseResponse(hit[1])
  })
  await ctx.plugin(llmPlus, {
    routes: { 'kimi-plus': { protocol: 'openai-completions', baseURL: 'http://test.local/v1', oauth: 'kimi-coding' } },
  })

  await collect(ctx, { provider: 'kimi-plus', model: 'm', messages: [userMessage('hi')] })
  // 临期 grant 在请求期被刷新（modifyRecord 锁内），新 access 成为 Bearer
  expect(refreshed).toBe(1)
  expect(lastFetch!.headers['authorization']).toBe('Bearer kimi-access-2')
  expect((record as { payload: { access: string } }).payload.access).toBe('kimi-access-2')
})

test('oauth route without a stored grant fails with an actionable AUTH error, never sending the request', async () => {
  const ctx = new Context()
  ctx.root.provide('credentials', {
    resolve: () => Promise.resolve(undefined),
    readRecord: () => Promise.resolve(undefined),
    modifyRecord: () => Promise.resolve(undefined),
    deleteRecord: () => Promise.resolve(),
  })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(llmPlus, {
    routes: { 'kimi-plus': { protocol: 'openai-completions', baseURL: 'http://test.local/v1', oauth: 'kimi-coding' } },
  })
  sseByUrl = [['http://test.local', 'data: [DONE]\n']]
  const chunks = await collect(ctx, { provider: 'kimi-plus', model: 'm', messages: [userMessage('hi')] })
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH' } } })
  expect(lastFetch).toBeUndefined()
})

test('oauth route with availableModelIds lists the account-enabled set enriched from the catalog', async () => {
  const ctx = new Context()
  ctx.root.provide('credentials', {
    resolve: () => Promise.resolve(undefined),
    readRecord: () => Promise.resolve({
      kind: 'grant',
      payload: { type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + 3_600_000, availableModelIds: ['deepseek-v4-flash', 'account-only-model'] },
    }),
  })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(ModelsDevCatalog, { sourceUrl: FIXTURE_URL })
  await ctx.plugin(llmPlus, {
    routes: {
      'copilot-plus': {
        protocol: 'openai-completions',
        baseURL: 'http://test.local/v1',
        oauth: 'github-copilot',
        modelsDevProvider: 'deepseek',
      },
    },
  })
  const models = await ctx.root.llm.listModels('copilot-plus')
  // 账号可用集是权威过滤（28 个目录模型只出可用那 2 个）；目录命中的富化显示名
  expect(models.map(model => model.id)).toEqual(['deepseek-v4-flash', 'account-only-model'])
  expect(models[0]!.name).toBe('DeepSeek V4 Flash')
  expect(models[1]!.name).toBe('account-only-model')
})

test('oauth flows register with the authorization seam and leave with the fiber', async () => {
  const ctx = new Context()
  ctx.root.provide('credentials', { resolve: () => Promise.resolve(undefined) })
  const flows = new Map<string, unknown>()
  ctx.root.provide('authorization', {
    registerFlow: (flow: { key: unknown }) => {
      flows.set(String(flow.key), flow)
      return () => { flows.delete(String(flow.key)) }
    },
  })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(llmPlus, {
    routes: {
      'kimi-plus': { protocol: 'openai-completions', baseURL: 'http://test.local/v1', oauth: 'kimi-coding' },
      'plain-plus': { protocol: 'openai-completions', baseURL: 'http://test.local/v1', apiKeyRef: 'X' },
    },
  })
  // 只有声明了 oauth 的路由注册 flow；key 的 scope 段是插件注册名。
  // fiber 摘除时的移除是缝自己的契约（真实 AuthorizationService 的
  // registerFlow 内 ctx.effect 绑定调用方 fiber，有其包自身测试覆盖），
  // 这里的桩没有 fiber 感知，只断言注册面
  expect([...flows.keys()]).toEqual(['llm-plus/kimi-plus'])
})

test('oauth flow registered after settings change survives the seam mounting late', async () => {
  // 竞态回归：路由从 settings 用户层到达 早于 authorization 缝激活——
  // 曾经的实现在缝激活时只同步初始集，后到路由永远没有 flow
  const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-plus-oauth-race-'))
  try {
    const ctx = new Context()
    ctx.root.provide('credentials', { resolve: () => Promise.resolve(undefined) })
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(FileSettingsProvider, { path: join(dir, 'settings.yaml'), watch: false })
    await ctx.plugin(llmPlus, {
      routes: { 'ds-plus': { protocol: 'openai-completions', baseURL: 'http://test.local/v1', apiKeyRef: 'DEEPSEEK_TEST' } },
    })
    // 用户层变更先到（缝还不在）
    await ctx.settings.update(settingsNamespace('llm-plus'), {
      routes: { 'kimi-plus': { protocol: 'anthropic-messages', baseURL: 'http://test.local/kimi/v1', oauth: 'kimi-coding' } },
    })
    await vi.waitFor(() => {
      expect(ctx.root.llm.listProviders().map(provider => provider.id).sort()).toEqual(['ds-plus', 'kimi-plus'])
    })
    // 缝后到
    const flows = new Map<string, unknown>()
    ctx.root.provide('authorization', {
      registerFlow: (flow: { key: unknown }) => {
        flows.set(String(flow.key), flow)
        return () => { flows.delete(String(flow.key)) }
      },
    })
    await vi.waitFor(() => {
      expect([...flows.keys()]).toEqual(['llm-plus/kimi-plus'])
    })
    await ctx.fiber.dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('zero-route composition mounts dormant; the first settings route registers the adapter', async () => {
  // 纯页面驱动的起点（base 零路由）：registerAdapter 的空初始集会抛、
  // registerConfigurableProviders 同——两个注册都必须惰性到首个路由
  const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-plus-empty-'))
  try {
    const ctx = new Context()
    ctx.root.provide('credentials', { resolve: () => Promise.resolve(undefined) })
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(FileSettingsProvider, { path: join(dir, 'settings.yaml'), watch: false })
    await ctx.plugin(llmPlus, { routes: {} })
    expect(ctx.root.llm.listProviders()).toEqual([])
    expect(ctx.root.llm.listConfigurableProviders().some(entry => entry.settingsNs === 'llm-plus')).toBe(false)

    await ctx.settings.update(settingsNamespace('llm-plus'), {
      routes: { 'kimi-plus': { protocol: 'anthropic-messages', baseURL: 'http://test.local/kimi/v1', apiKeyRef: 'KIMI' } },
    })
    await vi.waitFor(() => {
      expect(ctx.root.llm.listProviders().map(provider => provider.id)).toEqual(['kimi-plus'])
    })
    expect(ctx.root.llm.listConfigurableProviders().some(entry => entry.provider === 'kimi-plus')).toBe(true)
    await ctx.fiber.dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('settings user-layer route additions take effect without a restart', async () => {
  // 真实动态组合（对齐 llm-deepseek 的 dynamic-config 夹具）：
  // settings-file 落地用户层，watch:false 走确定性的进程内写路径
  const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-plus-settings-'))
  try {
    const ctx = new Context()
    ctx.root.provide('credentials', { resolve: (ref: string) => Promise.resolve({ value: `key-for-${ref}`, source: 'test' }) })
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(FileSettingsProvider, { path: join(dir, 'settings.yaml'), watch: false })
    await ctx.plugin(llmPlus, {
      routes: { 'ds-plus': { protocol: 'openai-completions', baseURL: 'http://test.local/v1', apiKeyRef: 'DEEPSEEK_TEST' } },
    })
    expect(ctx.root.llm.listProviders().map(provider => provider.id)).toEqual(['ds-plus'])

    // 用户层写一个新路由（models.dev 设置页走的就是这条 mutate 路径）。
    // 曾经有个 bug：apply 把 setSource 的 thunk 在挂接点求值冻结，用户层
    // 变更永远读不到——这个用例钉死热更新语义
    await ctx.settings.update(settingsNamespace('llm-plus'), {
      routes: {
        'kimi-for-coding': {
          protocol: 'anthropic-messages',
          displayName: 'Kimi For Coding',
          baseURL: 'http://test.local/kimi/v1',
          apiKeyRef: 'KIMI_API_KEY',
          modelsDevProvider: 'kimi-for-coding',
        },
      },
    })

    // 不重启：settings 层是递归深合并（对象逐键、数组整体替换），base 的
    // ds-plus 不被用户层抹掉。watch 回调走串行承诺链（SettingsWatcher.tail），
    // 用 waitFor 等它跑到，而不是断言提交点的瞬时状态
    // 不重启：settings 层是递归深合并（对象逐键、数组整体替换），base 的
    // ds-plus 不被用户层抹掉。watch 回调走串行承诺链（SettingsWatcher.tail），
    // 用 waitFor 等它跑到，而不是断言提交点的瞬时状态
    await vi.waitFor(() => {
      expect(ctx.root.llm.listProviders().map(provider => provider.id).sort()).toEqual(['ds-plus', 'kimi-for-coding'])
    })
    const kimi = ctx.root.llm.listConfigurableProviders().find(entry => entry.provider === 'kimi-for-coding')
    expect(kimi).toMatchObject({
      displayName: 'Kimi For Coding',
      settingsNs: 'llm-plus',
      settingsPath: ['routes', 'kimi-for-coding'],
    })
    await ctx.fiber.dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
