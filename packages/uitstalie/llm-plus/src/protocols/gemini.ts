/**
 * gemini 协议实现（Google Generative Language API 原生方言）。
 *
 * 覆盖面：models.dev 里 `npm: @ai-sdk/google` 的 google provider（39 个模型）。
 *
 * 请求：POST {baseURL}/v1beta/models/{model}:streamGenerateContent?alt=sse。
 * 与另两种方言的硬差异：
 * - 角色词汇是 user/model（不是 user/assistant）；
 * - 内容是 parts 数组：{text} / {functionCall} / {functionResponse}；
 * - 工具结果是 functionResponse，需要**函数名**而不是 call id——
 *   harness 的 ToolResultBlock 只有 toolCallId，所以序列化时先扫一遍历史
 *   建 toolCallId → name 映射；
 * - 思考内容在同一个 part 里用 thought: true 标记（不是独立事件类型）；
 * - functionCall 是**完整帧**（不流式），一帧一个完整调用。
 *
 * @module @deepseek-ai/dsh-llm-plus/protocols/gemini
 */

import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-models-dev'
import type { SseEvent } from '../sse.ts'
import { BaseTranslator, readReplayEnvelope, type Protocol, type ProtocolRequest, type RequestAssets, type StreamTranslator } from '../protocol.ts'
import type { ResolvedRoute } from '../config.ts'
import { contentToText, extractImages, extractToolCalls, extractToolResults, imagePlaceholder, parseJsonObject } from './shared.ts'

/** 端点拼接：模型 id 进路径，SSE 走 ?alt=sse 查询参数。 */
function endpoint(baseURL: string, model: string): string {
  return `${baseURL.replace(/\/+$/, '')}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`
}

/**
 * 消息历史序列化（异步：图片要读字节）。
 *
 * 注意三点：
 * - 先扫一遍历史建 toolCallId → 函数名映射（functionResponse 需要 name）；
 * - 连续同角色 contents 合并（Gemini 要求 user/model 交替）；
 * - **replay**：assistant 消息带同协议 envelope 时，reasoning 块恢复为
 *   {text, thought:true, thoughtSignature} part（Gemini 2.5+ 的函数调用
 *   轮次要求回带思考签名）；对不齐或缺签名则丢弃 reasoning（强于伪造）。
 */
async function serializeContents(options: GenerateOptions, assets: RequestAssets): Promise<JsonValue[]> {
  // 第一遍：toolCallId → name（assistant 的 tool-call 块提供）
  const callNames = new Map<string, string>()
  for (const message of options.messages) {
    for (const call of extractToolCalls(message)) callNames.set(call.id, call.name)
  }
  const out: { role: string; parts: JsonValue[] }[] = []
  const push = (role: string, part: JsonValue) => {
    const last = out[out.length - 1]
    if (last && last.role === role) last.parts.push(part)
    else out.push({ role, parts: [part] })
  }
  for (const message of options.messages) {
    if (message.role === 'system') continue
    const toolResults = extractToolResults(message)
    if (toolResults.length > 0) {
      for (const result of toolResults) {
        push('user', {
          functionResponse: {
            name: callNames.get(result.toolCallId) ?? 'unknown_tool',
            response: { result: contentToText(result.content) },
          },
        })
      }
      continue
    }
    const role = message.role === 'assistant' ? 'model' : 'user'
    const envelope = message.role === 'assistant'
      ? readReplayEnvelope(message.source, 'gemini')
      : undefined
    const replayable = envelope !== undefined && envelope.blocks.length === message.content.length
    message.content.forEach((block, position) => {
      if (block.type !== 'reasoning' || !replayable) return
      const meta = envelope.blocks[position]
      const signature = typeof meta?.thoughtSignature === 'string' ? meta.thoughtSignature : undefined
      if (signature) push(role, { text: block.text, thought: true, thoughtSignature: signature })
    })
    const text = contentToText(message.content)
    if (text) push(role, { text })
    for (const block of extractImages(message)) {
      const resolved = await assets.image(block.attachment)
      push(role, resolved
        ? { inlineData: { mimeType: resolved.mediaType, data: resolved.base64 } }
        : { text: imagePlaceholder(block) })
    }
    for (const call of extractToolCalls(message)) {
      push(role, { functionCall: { name: call.name, args: parseJsonObject(call.arguments) } })
    }
  }
  return out as JsonValue[]
}

/** 请求序列化。 */
async function buildRequest(route: ResolvedRoute, options: GenerateOptions, assets: RequestAssets): Promise<ProtocolRequest> {
  const generationConfig: Record<string, JsonValue> = {}
  if (options.temperature !== undefined) generationConfig.temperature = options.temperature
  const maxTokens = options.maxTokens ?? route.defaultMaxTokens
  if (maxTokens !== undefined) generationConfig.maxOutputTokens = maxTokens
  if (options.stop) generationConfig.stopSequences = options.stop
  // reasoningEffort 存在即要求思考回显；数值形式（budget）解析得出时带上
  if (options.reasoningEffort !== undefined) {
    const budget = Number(options.reasoningEffort)
    generationConfig.thinkingConfig = Number.isFinite(budget)
      ? { includeThoughts: true, thinkingBudget: budget }
      : { includeThoughts: true }
  }
  const body: Record<string, JsonValue> = {
    contents: await serializeContents(options, assets),
    ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
  }
  if (options.system) body.systemInstruction = { parts: [{ text: options.system }] }
  if (options.tools && options.tools.length > 0) {
    body.tools = [{
      functionDeclarations: options.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        // ToolSchema.parameters → wire 上的 parameters（JSON Schema 对象）
        parameters: tool.parameters as JsonValue,
      })),
    }]
  }
  return {
    url: endpoint(route.baseURL, options.model),
    headers: {
      'content-type': 'application/json',
      ...(assets.apiKey ? { 'x-goog-api-key': assets.apiKey } : {}),
      ...route.headers,
    },
    body,
  }
}

/**
 * 流翻译器。
 *
 * Gemini 的 SSE 每帧是一个 GenerateContentResponse：candidates[0].content.parts
 * 是本帧的全部增量。part 形态：{text}（thought:true 时是思考）/
 * {functionCall}（完整一帧）。usageMetadata 与 finishReason 在最后一帧。
 */
class GeminiTranslator extends BaseTranslator {
  constructor() {
    super('gemini')
  }

  push(event: SseEvent): StreamChunk[] {
    const frame = JSON.parse(event.data) as {
      candidates?: { content?: { parts?: Record<string, unknown>[] }; finishReason?: string }[]
      usageMetadata?: Record<string, unknown>
    }
    const out: StreamChunk[] = []
    const candidate = frame.candidates?.[0]
    for (const part of candidate?.content?.parts ?? []) {
      if (typeof part.text === 'string') {
        // thought:true 的 text part 是思考内容，其余是正文
        const kind = part.thought === true ? 'reasoning' as const : 'text' as const
        const { index, chunks } = this.appendLazy(kind, part.text)
        out.push(...chunks)
        // replay：thoughtSignature 挂在 part 上，记进所属 block 的元数据
        if (typeof part.thoughtSignature === 'string') {
          this.setBlockMeta(index, { thoughtSignature: part.thoughtSignature })
        }
      } else if (part.functionCall) {
        // 完整帧：开 block → 一次性 tool-call-delta → 关 block
        const call = part.functionCall as { name?: string; args?: unknown }
        const opened = this.openBlock('tool-call')
        out.push(opened.chunk)
        const args = JSON.stringify(call.args ?? {})
        const block = this.blockAt(opened.index)
        block.text = args
        if (call.name) block.toolName = call.name
        // gemini 不发 call id，用函数名 + 序号合成稳定 id
        block.toolId = `gemini_${call.name ?? 'call'}_${opened.index}`
        // 函数调用 part 也可能带 thoughtSignature（工具轮次的签名回带要求）
        if (typeof part.thoughtSignature === 'string') {
          this.setBlockMeta(opened.index, { thoughtSignature: part.thoughtSignature })
        }
        out.push({ type: 'tool-call-delta', index: opened.index, id: block.toolId as never, ...(call.name ? { name: call.name } : {}), argumentsDelta: args })
        out.push(...this.closeBlock(opened.index))
      }
    }
    if (frame.usageMetadata) out.push({ type: 'usage', usage: translateUsage(frame.usageMetadata) })
    if (candidate?.finishReason) out.push(...this.terminate(candidate.finishReason))
    return out
  }
}

/** Gemini usageMetadata → harness TokenUsage（thoughts 单独列出）。 */
function translateUsage(raw: Record<string, unknown>): TokenUsage {
  const thoughts = typeof raw.thoughtsTokenCount === 'number' ? raw.thoughtsTokenCount : undefined
  return {
    inputTokens: typeof raw.promptTokenCount === 'number' ? raw.promptTokenCount : 0,
    outputTokens: typeof raw.candidatesTokenCount === 'number' ? raw.candidatesTokenCount : 0,
    ...(typeof raw.totalTokenCount === 'number' ? { totalTokens: raw.totalTokenCount } : {}),
    ...(thoughts === undefined ? {} : { reasoningTokens: thoughts }),
  }
}

/** gemini 协议实例。 */
export const gemini: Protocol = {
  buildRequest,
  createTranslator: (): StreamTranslator => new GeminiTranslator(),
}
