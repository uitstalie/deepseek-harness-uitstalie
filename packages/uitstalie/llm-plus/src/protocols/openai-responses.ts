/**
 * openai-responses 协议实现（OpenAI Responses API 方言）。
 *
 * 覆盖面：OpenAI 官方新协议（GPT-5.x 系）、models.dev 里标
 * `shape: "responses"` 的 model 级覆盖（如 amazon-bedrock mantle）。
 *
 * 与 openai-completions 的硬差异：
 * - POST {baseURL}/responses；system 走 `instructions` 字段；
 * - 历史是 **item 数组**而非 messages：input_text/output_text 内容块、
 *   function_call / function_call_output 独立 item、reasoning 独立 item；
 * - reasoning 模型要求回带 reasoning item 的 `encrypted_content`——
 *   这是本协议 replay 的核心（store:false 时服务端不存状态，
 *   历史全靠客户端回带；include 里要显式要 reasoning.encrypted_content）；
 * - 流事件是 `response.*` 系列：response.output_item.added（item 开始）、
 *   response.output_text.delta / response.function_call_arguments.delta
 *   （增量）、response.output_item.done（item 完整）、response.completed
 *   （终帧，带 response.usage）。
 *
 * @module @deepseek-ai/dsh-llm-plus/protocols/openai-responses
 */

import type { GenerateOptions, LlmDiscoveredModel, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-models-dev'
import type { SseEvent } from '../sse.ts'
import { BaseTranslator, readReplayEnvelope, type Protocol, type ProtocolRequest, type RequestAssets, type StreamTranslator } from '../protocol.ts'
import type { ResolvedRoute } from '../config.ts'
import { contentToText, extractImages, extractToolCalls, extractToolResults, getJson, imagePlaceholder, validateEffort } from './shared.ts'

/** 端点拼接。 */
function endpoint(baseURL: string): string {
  return `${baseURL.replace(/\/+$/, '')}/responses`
}

/**
 * 历史序列化为 Responses API 的 input item 数组（异步：图片要读字节）。
 *
 * item 词汇映射：
 * - user 文本 → {role:'user', content:[{type:'input_text', text}]}；
 *   图片 → input_image 块（base64 data URL），失败降级占位文本；
 * - assistant 文本 → {role:'assistant', content:[{type:'output_text', text}]}；
 * - reasoning 块 + 同协议 envelope → reasoning item（id + encrypted_content
 *   原样回带）；对不齐/缺 encrypted_content 则丢弃（强于伪造）；
 * - tool-call → {type:'function_call', call_id, name, arguments}（独立 item）；
 * - tool-result → {type:'function_call_output', call_id, output}（独立 item）。
 */
async function serializeInput(options: GenerateOptions, assets: RequestAssets): Promise<JsonValue[]> {
  const out: JsonValue[] = []
  for (const message of options.messages) {
    if (message.role === 'system') continue // system 由 instructions 承载
    const toolResults = extractToolResults(message)
    if (toolResults.length > 0) {
      for (const result of toolResults) {
        out.push({ type: 'function_call_output', call_id: result.toolCallId, output: contentToText(result.content) })
      }
      continue
    }
    if (message.role === 'assistant') {
      const envelope = readReplayEnvelope(message.source, 'openai-responses')
      const replayable = envelope !== undefined && envelope.blocks.length === message.content.length
      if (envelope !== undefined && !replayable) {
        assets.onReplayDegrade?.('replay envelope blocks misaligned with message content; dropping reasoning items')
      }
      message.content.forEach((block, position) => {
        if (block.type !== 'reasoning' || !replayable) return
        const meta = envelope.blocks[position]
        // reasoning item 必须带 id + encrypted_content 才能回带
        if (typeof meta?.id === 'string' && typeof meta?.encrypted_content === 'string') {
          out.push({ type: 'reasoning', id: meta.id, encrypted_content: meta.encrypted_content })
        } else {
          assets.onReplayDegrade?.('reasoning item lacks id or encrypted_content; dropping it rather than forging history')
        }
      })
      const text = contentToText(message.content)
      if (text) out.push({ role: 'assistant', content: [{ type: 'output_text', text }] })
      for (const call of extractToolCalls(message)) {
        out.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments })
      }
    } else {
      const text = contentToText(message.content)
      const images = extractImages(message)
      const parts: JsonValue[] = []
      if (text) parts.push({ type: 'input_text', text })
      for (const block of images) {
        const resolved = await assets.image(block.attachment)
        parts.push(resolved
          ? { type: 'input_image', image_url: `data:${resolved.mediaType};base64,${resolved.base64}` }
          : { type: 'input_text', text: imagePlaceholder(block) })
      }
      if (parts.length > 0) out.push({ role: 'user', content: parts })
    }
  }
  return out
}

/** 请求序列化。 */
async function buildRequest(route: ResolvedRoute, options: GenerateOptions, assets: RequestAssets): Promise<ProtocolRequest> {
  const body: Record<string, JsonValue> = {
    model: options.model,
    input: await serializeInput(options, assets),
    stream: true,
    // store:false = 服务端不留状态，历史全由客户端回带（隐私与可移植性）；
    // 代价是必须 include encrypted_content 才能 replay reasoning
    store: false,
    include: ['reasoning.encrypted_content'],
  }
  if (options.system) body.instructions = options.system
  if (options.temperature !== undefined) body.temperature = options.temperature
  const maxTokens = options.maxTokens ?? route.defaultMaxTokens
  if (maxTokens !== undefined) body.max_output_tokens = maxTokens
  if (options.stop) body.stop = options.stop
  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools.map(tool => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as JsonValue,
    }))
  }
  // reasoningEffort 透传为 reasoning.effort（Responses API 的档位字段）；
  // 模型声明了档位池时先校验
  if (options.reasoningEffort !== undefined) {
    body.reasoning = { effort: validateEffort(String(options.reasoningEffort), assets.reasoning?.efforts, options.model) }
  }
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
 * 流翻译器（response.* 事件系列）。
 *
 * 簿记：item 生命周期由 response.output_item.added/done 框定；
 * output_index 是 provider 给的 item 序号，映射为 harness block 索引。
 * reasoning item 的 id + encrypted_content 在 done 帧拿全，记入 replay
 * 元数据。
 */
class OpenAiResponsesTranslator extends BaseTranslator {
  /** output_index → harness block index */
  private readonly itemBlocks = new Map<number, number>()

  constructor() {
    super('openai-responses')
  }

  push(event: SseEvent): StreamChunk[] {
    const frame = JSON.parse(event.data) as Record<string, unknown>
    const type = typeof frame.type === 'string' ? frame.type : ''
    const out: StreamChunk[] = []
    switch (type) {
      case 'response.output_item.added': {
        const item = frame.item as { type?: string } | undefined
        const outputIndex = typeof frame.output_index === 'number' ? frame.output_index : 0
        const blockType = item?.type === 'reasoning' ? 'reasoning' : item?.type === 'function_call' ? 'tool-call' : 'text'
        // message item 与 reasoning item 都走这里；function_call 的参数增量随后到
        if (item?.type === 'message' || item?.type === 'reasoning' || item?.type === 'function_call') {
          const opened = this.openBlock(blockType)
          this.itemBlocks.set(outputIndex, opened.index)
          out.push(opened.chunk)
        }
        break
      }
      case 'response.output_text.delta': {
        const index = this.itemBlocks.get(typeof frame.output_index === 'number' ? frame.output_index : 0)
        const text = typeof frame.delta === 'string' ? frame.delta : ''
        if (index !== undefined && text) out.push(...this.appendDelta(index, 'text', text))
        break
      }
      case 'response.function_call_arguments.delta': {
        const index = this.itemBlocks.get(typeof frame.output_index === 'number' ? frame.output_index : 0)
        const delta = typeof frame.delta === 'string' ? frame.delta : ''
        if (index !== undefined && delta) {
          const block = this.openBlocks.get(index)
          if (block) {
            block.text += delta
            out.push({
              type: 'tool-call-delta',
              index,
              id: (block.toolId ?? `call_${index}`) as never,
              ...(block.toolName ? { name: block.toolName } : {}),
              argumentsDelta: delta,
            })
          }
        }
        break
      }
      case 'response.output_item.done': {
        const item = frame.item as {
          type?: string
          id?: string
          encrypted_content?: string
          call_id?: string
          name?: string
        } | undefined
        const outputIndex = typeof frame.output_index === 'number' ? frame.output_index : 0
        const index = this.itemBlocks.get(outputIndex)
        if (index !== undefined) {
          const block = this.openBlocks.get(index)
          if (block && item?.type === 'function_call') {
            if (item.call_id) block.toolId = item.call_id
            if (item.name) block.toolName = item.name
          }
          // replay：reasoning item 的加密内容在 done 帧拿全
          if (item?.type === 'reasoning' && item.id && item.encrypted_content) {
            this.setBlockMeta(index, { id: item.id, encrypted_content: item.encrypted_content })
          }
          out.push(...this.closeBlock(index))
        }
        break
      }
      case 'response.completed': {
        const response = frame.response as { usage?: Record<string, unknown> } | undefined
        if (response?.usage) out.push({ type: 'usage', usage: translateUsage(response.usage) })
        out.push(...this.terminate('stop'))
        break
      }
      case 'response.failed':
      case 'error': {
        throw new Error(`openai-responses stream error: ${event.data}`)
      }
      // response.created / in_progress / content_part.* 等无 chunk 产出
    }
    return out
  }
}

/** Responses API usage → harness TokenUsage（cached/reasoning 拆出）。 */
function translateUsage(raw: Record<string, unknown>): TokenUsage {
  const input = typeof raw.input_tokens === 'number' ? raw.input_tokens : 0
  const output = typeof raw.output_tokens === 'number' ? raw.output_tokens : 0
  const inputDetails = raw.input_tokens_details as Record<string, unknown> | undefined
  const cached = typeof inputDetails?.cached_tokens === 'number' ? inputDetails.cached_tokens : undefined
  const outputDetails = raw.output_tokens_details as Record<string, unknown> | undefined
  const reasoning = typeof outputDetails?.reasoning_tokens === 'number' ? outputDetails.reasoning_tokens : undefined
  return {
    inputTokens: input - (cached ?? 0),
    outputTokens: output,
    ...(typeof raw.total_tokens === 'number' ? { totalTokens: raw.total_tokens } : {}),
    ...(cached === undefined ? {} : { cacheReadTokens: cached }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  }
}

/** Responses API 与 Chat Completions 共用 GET /models 列表端点。 */
async function discoverModels(baseURL: string, apiKey: string | undefined, signal?: AbortSignal): Promise<LlmDiscoveredModel[]> {
  const json = await getJson(
    `${baseURL.replace(/\/+$/, '')}/models`,
    { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    signal,
  )
  const data = (json as { data?: { id?: unknown }[] }).data ?? []
  return data.flatMap(model => typeof model.id === 'string' ? [{ id: model.id }] : [])
}

/** openai-responses 协议实例。 */
export const openAiResponses: Protocol = {
  buildRequest,
  createTranslator: (): StreamTranslator => new OpenAiResponsesTranslator(),
  discoverModels,
}
