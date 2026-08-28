/**
 * openai-completions 协议实现（OpenAI Chat Completions 方言）。
 *
 * 覆盖面：DeepSeek 官方、GLM（zhipuai）、Kimi（moonshotai）、OpenRouter、
 * 以及 models.dev 里约 80% 标 `@ai-sdk/openai-compatible` 的 provider。
 *
 * 请求：POST {baseURL}/chat/completions，SSE 流。
 * 流事件词汇（choices[0].delta）：content（文本）、reasoning_content
 * （思考，DeepSeek 系扩展字段）、tool_calls[]（工具调用增量）。
 * usage 在 stream_options.include_usage 下随流尾的空 choices 帧到来。
 *
 * @module @deepseek-ai/dsh-llm-plus/protocols/openai-completions
 */

import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-models-dev'
import type { SseEvent } from '../sse.ts'
import { BaseTranslator, type Protocol, type ProtocolRequest, type RequestAssets, type StreamTranslator } from '../protocol.ts'
import type { ResolvedRoute } from '../config.ts'
import { contentToText, extractImages, extractToolCalls, extractToolResults, imagePlaceholder } from './shared.ts'

/** API 路径拼接：容忍 baseURL 尾部斜杠。 */
function endpoint(baseURL: string): string {
  return `${baseURL.replace(/\/+$/, '')}/chat/completions`
}

/**
 * 把 harness 消息历史序列化为 OpenAI messages 数组（异步：图片要读字节）。
 *
 * 映射规则：
 * - system 提示词走 options.system（单独字段，不混进 messages）；
 * - user 消息无图时文本拼字符串，有图时用 content 数组形态
 *   （{type:'text'} + {type:'image_url'}，data URL 内联 base64）；
 * - assistant 的 reasoning 块**丢弃**（DeepSeek 等 provider 明确要求多轮
 *   不回带 reasoning_content，回带反而 400）；
 * - assistant 的 tool-call 块 → tool_calls 数组；
 * - tool-result 块（harness 里是 role:user）→ 独立的 role:'tool' 消息。
 */
async function serializeMessages(options: GenerateOptions, assets: RequestAssets): Promise<JsonValue[]> {
  const out: JsonValue[] = []
  if (options.system) out.push({ role: 'system', content: options.system })
  for (const message of options.messages) {
    if (message.role === 'system') continue
    const toolResults = extractToolResults(message)
    if (toolResults.length > 0) {
      for (const result of toolResults) {
        out.push({ role: 'tool', tool_call_id: result.toolCallId, content: contentToText(result.content) })
      }
      continue
    }
    const text = contentToText(message.content)
    const images = extractImages(message)
    if (message.role === 'assistant') {
      const calls = extractToolCalls(message)
      out.push({
        role: 'assistant',
        content: text,
        ...(calls.length > 0
          ? { tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) }
          : {}),
      })
    } else if (images.length === 0) {
      out.push({ role: 'user', content: text })
    } else {
      // 有图：OpenAI 的 content 数组形态；解析失败的图用占位文本降级
      const parts: JsonValue[] = []
      if (text) parts.push({ type: 'text', text })
      for (const block of images) {
        const resolved = await assets.image(block.attachment)
        parts.push(resolved
          ? { type: 'image_url', image_url: { url: `data:${resolved.mediaType};base64,${resolved.base64}` } }
          : { type: 'text', text: imagePlaceholder(block) })
      }
      out.push({ role: 'user', content: parts })
    }
  }
  return out
}

/** 请求序列化：基础字段 + 可选字段按需出现（不发 undefined 键）。 */
async function buildRequest(route: ResolvedRoute, options: GenerateOptions, assets: RequestAssets): Promise<ProtocolRequest> {
  const body: Record<string, JsonValue> = {
    model: options.model,
    messages: await serializeMessages(options, assets),
    stream: true,
    // 不发这个字段很多网关不给 usage
    stream_options: { include_usage: true },
  }
  if (options.temperature !== undefined) body.temperature = options.temperature
  const maxTokens = options.maxTokens ?? route.defaultMaxTokens
  if (maxTokens !== undefined) body.max_tokens = maxTokens
  if (options.stop) body.stop = options.stop
  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools.map(tool => ({
      type: 'function',
      // ToolSchema.parameters 是 Record<string, unknown>（harness 词表），
      // wire 上它就是 JSON Schema 对象——收窄为 JsonValue
      function: { name: tool.name, description: tool.description, parameters: tool.parameters as JsonValue },
    }))
  }
  // reasoningEffort 是不透明 id，openai-compat 方言直接透传字符串
  if (options.reasoningEffort !== undefined) body.reasoning_effort = String(options.reasoningEffort)
  return {
    url: endpoint(route.baseURL),
    headers: {
      'content-type': 'application/json',
      ...(assets.apiKey ? { authorization: `Bearer ${assets.apiKey}` } : {}),
      ...route.headers,
    },
    body,
  }
}

/**
 * 流翻译器。
 *
 * 簿记要点：
 * - reasoning/text 在此方言里**不携带 block 索引**——走基座的 appendLazy
 *   惰性 block（首次出现时发 block-start），DeepSeek 系实际行为是先
 *   reasoning 后 content，同帧交错时按字段处理顺序；
 * - tool_calls 增量帧带 provider 侧 `index`（第几个工具调用），它与
 *   harness block index 是两回事——维护 toolCallIndex → blockIndex 映射。
 */
class OpenAiCompletionsTranslator extends BaseTranslator {
  /** provider tool-call index → harness block index */
  private readonly toolBlocks = new Map<number, number>()

  constructor() {
    super('openai-completions')
  }

  push(event: SseEvent): StreamChunk[] {
    // [DONE] 是流终止哨兵，不是数据帧
    if (event.data === '[DONE]') return []
    const chunk = JSON.parse(event.data) as {
      choices?: { delta?: Record<string, unknown>; finish_reason?: string | null }[]
      usage?: Record<string, unknown>
    }
    const out: StreamChunk[] = []
    // usage 帧与 finish 帧可能分开到（include_usage 下 usage 单独一帧）
    if (chunk.usage) out.push({ type: 'usage', usage: translateUsage(chunk.usage) })
    const choice = chunk.choices?.[0]
    const delta = choice?.delta
    if (delta) {
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        out.push(...this.appendLazy('reasoning', delta.reasoning_content).chunks)
      }
      if (typeof delta.content === 'string' && delta.content) {
        out.push(...this.appendLazy('text', delta.content).chunks)
      }
      const toolCalls = delta.tool_calls as { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] | undefined
      for (const call of toolCalls ?? []) {
        out.push(...this.pushToolCall(call))
      }
    }
    if (choice?.finish_reason) out.push(...this.terminate(choice.finish_reason))
    return out
  }

  /** 工具调用增量：首帧开 block（记下 id/name），后续帧累积参数 JSON。 */
  private pushToolCall(call: { index?: number; id?: string; function?: { name?: string; arguments?: string } }): StreamChunk[] {
    const toolIndex = call.index ?? 0
    let blockIndex = this.toolBlocks.get(toolIndex)
    const chunks: StreamChunk[] = []
    if (blockIndex === undefined) {
      const opened = this.openBlock('tool-call')
      blockIndex = opened.index
      this.toolBlocks.set(toolIndex, blockIndex)
      chunks.push(opened.chunk)
    }
    const block = this.blockAt(blockIndex)
    if (call.id) block.toolId = call.id
    if (call.function?.name) block.toolName = call.function.name
    const argsDelta = call.function?.arguments
    if (argsDelta) {
      block.text += argsDelta
      chunks.push({
        type: 'tool-call-delta',
        index: blockIndex,
        id: (block.toolId ?? `call_${blockIndex}`) as never,
        ...(block.toolName ? { name: block.toolName } : {}),
        argumentsDelta: argsDelta,
      })
    }
    return chunks
  }
}

/** OpenAI usage 对象 → harness TokenUsage（cached 从 input 拆出，保持 DISJOINT 契约）。 */
function translateUsage(raw: Record<string, unknown>): TokenUsage {
  const prompt = typeof raw.prompt_tokens === 'number' ? raw.prompt_tokens : 0
  const completion = typeof raw.completion_tokens === 'number' ? raw.completion_tokens : 0
  const promptDetails = raw.prompt_tokens_details as Record<string, unknown> | undefined
  const cached = typeof promptDetails?.cached_tokens === 'number' ? promptDetails.cached_tokens : undefined
  const completionDetails = raw.completion_tokens_details as Record<string, unknown> | undefined
  const reasoning = typeof completionDetails?.reasoning_tokens === 'number' ? completionDetails.reasoning_tokens : undefined
  return {
    inputTokens: prompt - (cached ?? 0),
    outputTokens: completion,
    ...(typeof raw.total_tokens === 'number' ? { totalTokens: raw.total_tokens } : {}),
    ...(cached === undefined ? {} : { cacheReadTokens: cached }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  }
}

/** openai-completions 协议实例。 */
export const openAiCompletions: Protocol = {
  buildRequest,
  createTranslator: (): StreamTranslator => new OpenAiCompletionsTranslator(),
}
