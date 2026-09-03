/**
 * anthropic-messages 协议实现（Anthropic Messages API 方言）。
 *
 * 覆盖面：Claude 官方、Kimi Code 的 Anthropic 兼容端点、MiniMax 编程套餐、
 * Cloudflare/agentrouter 等网关下的 Claude 模型（models.dev 里 148 处
 * model 级协议覆盖中的大多数）。
 *
 * 请求：POST {baseURL}/v1/messages，SSE 流。
 * 与本方言的两个硬差异（相对 openai-completions）：
 * - max_tokens 是**必填**（缺省 8192，路由配置可覆盖）；
 * - 流事件用 `event:` 字段区分类型（message_start/content_block_start/
 *   content_block_delta/content_block_stop/message_delta/message_stop），
 *   且**自带 block 索引**（content_block 的 index 直接当 harness 索引用）。
 *
 * @module @deepseek-ai/dsh-llm-plus/protocols/anthropic-messages
 */

import type { GenerateOptions, LlmDiscoveredModel, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-models-dev'
import type { SseEvent } from '../sse.ts'
import { BaseTranslator, readReplayEnvelope, type Protocol, type ProtocolRequest, type RequestAssets, type StreamTranslator } from '../protocol.ts'
import type { ResolvedRoute } from '../config.ts'
import { contentToText, extractImages, extractToolCalls, extractToolResults, getJson, imagePlaceholder, parseJsonObject } from './shared.ts'

/** 默认端点；baseURL 已含 /v1 时不再重复拼。 */
function endpoint(baseURL: string): string {
  const base = baseURL.replace(/\/+$/, '')
  return base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`
}

/**
 * 消息历史序列化（异步：图片要读字节）。
 *
 * Anthropic 的约束：
 * - system 是顶层字段，不进 messages；
 * - messages 必须 user/assistant 交替——把连续同角色的消息合并成一个
 *   content 数组（harness 的上下文注入会产生连续 user 消息）；
 * - assistant 的 tool-call 块 → tool_use 块；
 * - **replay**：assistant 消息带同协议 replay envelope 时，reasoning 块
 *   恢复为带 signature 的 thinking 块（Anthropic 要求思考块原样回带，
 *   缺签名视为伪造历史）；envelope 与 content 位置对不齐则整体降级
 *   （丢弃 thinking，保留其余）；
 * - 图片 → {type:'image', source:{type:'base64',...}} 块，失败降级占位文本；
 * - tool-result → user 消息里的 tool_result 块。
 */
async function serializeMessages(options: GenerateOptions, assets: RequestAssets): Promise<JsonValue[]> {
  const out: { role: string; content: JsonValue[] }[] = []
  const push = (role: string, block: JsonValue) => {
    const last = out[out.length - 1]
    if (last && last.role === role) last.content.push(block)
    else out.push({ role, content: [block] })
  }
  for (const message of options.messages) {
    if (message.role === 'system') continue
    const toolResults = extractToolResults(message)
    if (toolResults.length > 0) {
      for (const result of toolResults) {
        push('user', { type: 'tool_result', tool_use_id: result.toolCallId, content: contentToText(result.content) })
      }
      continue
    }
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    // replay：同协议 envelope 的 blocks 与 content 按位置对齐（契约：assembler
    // 丢 block 时同位置丢 entry）；长度不等说明历史被裁剪过，整体降级
    const envelope = message.role === 'assistant'
      ? readReplayEnvelope(message.source, 'anthropic-messages')
      : undefined
    const replayable = envelope !== undefined && envelope.blocks.length === message.content.length
    // thinking 块必须先于 text/tool_use（Anthropic 的顺序约束），先扫一遍
    message.content.forEach((block, position) => {
      if (block.type !== 'reasoning') return
      if (!replayable) return // 无 envelope：丢弃（v1 前的消息没有签名）
      const meta = envelope.blocks[position]
      const signature = typeof meta?.signature === 'string' ? meta.signature : undefined
      // 有签名才回带；没有签名的 reasoning 块静默丢弃（强于伪造）
      if (signature) push(role, { type: 'thinking', thinking: block.text, signature })
    })
    const text = contentToText(message.content)
    if (text) push(role, { type: 'text', text })
    for (const block of extractImages(message)) {
      const resolved = await assets.image(block.attachment)
      push(role, resolved
        ? { type: 'image', source: { type: 'base64', media_type: resolved.mediaType, data: resolved.base64 } }
        : { type: 'text', text: imagePlaceholder(block) })
    }
    for (const call of extractToolCalls(message)) {
      // input 必须是对象；模型产出的 arguments 是 raw JSON 字符串，解析失败
      // 时给空对象（畸形的调用本来也会被执行层拒绝）
      push(role, { type: 'tool_use', id: call.id, name: call.name, input: parseJsonObject(call.arguments) })
    }
  }
  return out as JsonValue[]
}

/** 请求序列化。 */
async function buildRequest(route: ResolvedRoute, options: GenerateOptions, assets: RequestAssets): Promise<ProtocolRequest> {
  const body: Record<string, JsonValue> = {
    model: options.model,
    messages: await serializeMessages(options, assets),
    // anthropic 协议必填 max_tokens：路由配置 > 请求值 > 8192 兜底
    max_tokens: route.defaultMaxTokens ?? options.maxTokens ?? 8192,
    stream: true,
  }
  if (options.system) body.system = options.system
  if (options.temperature !== undefined) body.temperature = options.temperature
  if (options.stop) body.stop_sequences = options.stop
  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      // ToolSchema.parameters → wire 上的 input_schema（JSON Schema 对象）
      input_schema: tool.parameters as JsonValue,
    }))
  }
  // reasoningEffort 存在即开思考；v1 不做 budget 细分（数据在 models.dev
  // reasoning_options 里，细分逻辑留待 replay 一起做）
  if (options.reasoningEffort !== undefined) body.thinking = { type: 'enabled' }
  return {
    url: endpoint(route.baseURL),
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...(assets.apiKey ? { 'x-api-key': assets.apiKey } : {}),
      ...route.headers,
    },
    body,
  }
}

/**
 * 流翻译器：按 event 字段分派。
 *
 * 时序契约：message_start(usage 初值) → 若干 content_block_* →
 * message_delta(stop_reason + 最终 usage) → message_stop。
 * content_block 的 index 是 provider 给的稳定索引，直接当 harness 索引用。
 */

/** content_block_start 的 data 载荷。 */
interface ContentBlockStartFrame {
  index: number
  content_block?: { type?: string; id?: string; name?: string }
}

/** content_block_delta 的 data 载荷（四种 delta 变体摊平为可选字段，按 type 判别）。 */
interface ContentBlockDeltaFrame {
  index: number
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string; signature?: string }
}

/** message_delta 的 data 载荷（stop_reason + output 侧 usage 补全）。 */
interface MessageDeltaFrame {
  delta?: { stop_reason?: string }
  usage?: Record<string, unknown>
}

class AnthropicTranslator extends BaseTranslator {
  /** 最终 usage（message_delta 里补全 output 侧） */
  private usage: TokenUsage | undefined

  constructor() {
    super('anthropic-messages')
  }

  push(event: SseEvent): StreamChunk[] {
    const out: StreamChunk[] = []
    switch (event.event) {
      case 'message_start': {
        const message = (JSON.parse(event.data) as { message?: { usage?: Record<string, unknown> } }).message
        if (message?.usage) {
          this.usage = translateUsage(message.usage)
          out.push({ type: 'usage', usage: this.usage })
        }
        break
      }
      case 'content_block_start': {
        const data = JSON.parse(event.data) as ContentBlockStartFrame
        const block = data.content_block
        const type = block?.type === 'thinking' ? 'reasoning' : block?.type === 'tool_use' ? 'tool-call' : 'text'
        const opened = this.openBlock(type, data.index)
        out.push(opened.chunk)
        if (type === 'tool-call') {
          const record = this.blockAt(data.index)
          if (block?.id) record.toolId = block.id
          if (block?.name) record.toolName = block.name
        }
        break
      }
      case 'content_block_delta': {
        const data = JSON.parse(event.data) as ContentBlockDeltaFrame
        const delta = data.delta
        if (delta?.type === 'text_delta' && delta.text) {
          out.push(...this.appendDelta(data.index, 'text', delta.text))
        } else if (delta?.type === 'thinking_delta' && delta.thinking) {
          out.push(...this.appendDelta(data.index, 'reasoning', delta.thinking))
        } else if (delta?.type === 'signature_delta' && delta.signature) {
          // replay 核心：思考块的签名。落进 block 元数据，finish 时进 envelope；
          // 下次请求由序列化侧原样回带（Anthropic 验证签名防伪造历史）
          this.setBlockMeta(data.index, { signature: delta.signature })
        } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
          const block = this.openBlocks.get(data.index)
          if (block) {
            block.text += delta.partial_json
            out.push({
              type: 'tool-call-delta',
              index: data.index,
              id: (block.toolId ?? `call_${data.index}`) as never,
              ...(block.toolName ? { name: block.toolName } : {}),
              argumentsDelta: delta.partial_json,
            })
          }
        }
        break
      }
      case 'content_block_stop': {
        const data = JSON.parse(event.data) as { index: number }
        out.push(...this.closeBlock(data.index))
        break
      }
      case 'message_delta': {
        const data = JSON.parse(event.data) as MessageDeltaFrame
        // output_tokens 在 message_delta 的 usage 里补全，与初值合并
        if (data.usage && this.usage) {
          const output = typeof data.usage.output_tokens === 'number' ? data.usage.output_tokens : undefined
          if (output !== undefined) this.usage = { ...this.usage, outputTokens: output }
        }
        if (data.delta?.stop_reason) {
          out.push(...this.terminate(data.delta.stop_reason))
        }
        break
      }
      case 'error': {
        // anthropic 的错误事件（如 overloaded）——抛出让 runtime 归一化为 error finish
        throw new Error(`anthropic stream error: ${event.data}`)
      }
      // message_stop / ping 等无 chunk 产出
    }
    return out
  }
}

/** Anthropic usage → harness TokenUsage（cache_read/cache_creation 拆出）。 */
function translateUsage(raw: Record<string, unknown>): TokenUsage {
  const input = typeof raw.input_tokens === 'number' ? raw.input_tokens : 0
  const cacheRead = typeof raw.cache_read_input_tokens === 'number' ? raw.cache_read_input_tokens : undefined
  const cacheWrite = typeof raw.cache_creation_input_tokens === 'number' ? raw.cache_creation_input_tokens : undefined
  return {
    inputTokens: input,
    outputTokens: typeof raw.output_tokens === 'number' ? raw.output_tokens : 0,
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
  }
}

/**
 * Anthropic GET /v1/models interrogation（baseURL 已含 /v1 时不重复拼，
 * 与 endpoint() 同一规则）：响应 {data: [{id, display_name}]}。
 */
async function discoverModels(baseURL: string, apiKey: string | undefined, signal?: AbortSignal): Promise<LlmDiscoveredModel[]> {
  const base = baseURL.replace(/\/+$/, '')
  const url = base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`
  const json = await getJson(url, {
    'anthropic-version': '2023-06-01',
    ...(apiKey ? { 'x-api-key': apiKey } : {}),
  }, signal)
  const data = (json as { data?: { id?: unknown; display_name?: unknown }[] }).data ?? []
  return data.flatMap(model => typeof model.id === 'string'
    ? [{ id: model.id, ...(typeof model.display_name === 'string' ? { name: model.display_name } : {}) }]
    : [])
}

/** anthropic-messages 协议实例。 */
export const anthropicMessages: Protocol = {
  buildRequest,
  createTranslator: (): StreamTranslator => new AnthropicTranslator(),
  discoverModels,
}
