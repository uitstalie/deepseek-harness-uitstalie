/**
 * 四个协议共用的消息内容提取与序列化小工具。
 *
 * harness 的 Message.content 是 ContentBlock[]（text/reasoning/image/
 * tool-call/tool-addition/tool-removal），序列化成各 wire 协议前需要先拆出
 * 这些成分；工具结果不是内容块，而是独立的 role:'tool' 消息
 * （toolCallId + isError），协议实现各自把它翻成自己的 wire 形态。
 *
 * @module @deepseek-ai/dsh-llm-plus/protocols/shared
 */

import { textOnlyImageText, type ContentBlock, type ImageBlock, type ToolCallBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-models-dev'

/**
 * 把 content 块数组压成纯文本（仅用于**工具结果**这类不该含图的载荷）。
 *
 * 规则：text 块原样拼接；reasoning 块跳过（历史不回带思考）；
 * image 块替换为 textOnlyImageText 占位符（harness 提供的稳定词汇——
 * 静默丢图会让模型对着空气回答，占位符至少让它知道图的存在）。
 * 工具调用参数里出现图片是病态输入，占位符是刻意的降级而非完整支持。
 *
 * @param content - 一条消息的 content 块。
 * @returns 拼接后的纯文本。
 */
export function contentToText(content: readonly ContentBlock[]): string {
  let text = ''
  for (const block of content) {
    if (block.type === 'text') text += block.text
    else if (block.type === 'image') text += textOnlyImageText(block.attachment)
    // reasoning / tool-call 由各自的提取器处理，文本化时忽略
  }
  return text
}

/**
 * 取出消息里的 tool-call 块（assistant 消息的函数调用请求）。
 *
 * @param message - 任意带 content 的消息。
 * @returns 全部 tool-call 块（无则空数组）。
 */
export function extractToolCalls(message: { readonly content: readonly ContentBlock[] }): ToolCallBlock[] {
  return message.content.filter((block): block is ToolCallBlock => block.type === 'tool-call')
}

/**
 * 取出消息里的 image 块。
 *
 * @param message - 任意带 content 的消息。
 * @returns 全部 image 块（无则空数组）。
 */
export function extractImages(message: { readonly content: readonly ContentBlock[] }): ImageBlock[] {
  return message.content.filter((block): block is ImageBlock => block.type === 'image')
}

/**
 * image 块的占位文本（转发 harness 的稳定词汇，协议实现统一用它）。
 * @param block - 被文本化的 image 块。
 * @returns harness 的稳定占位文本。
 */
export function imagePlaceholder(block: ImageBlock): string {
  return textOnlyImageText(block.attachment)
}

/**
 * 解析模型产出的 raw JSON 字符串（tool-call arguments）为对象。
 * anthropic 的 tool_use.input 与 gemini 的 functionCall.args 都必须是对象；
 * 解析失败回退空对象（畸形的调用本来也会被执行层拒绝）。
 * @param raw - 模型产出的 JSON 字符串。
 * @returns 解析出的对象；非对象或解析失败时为空对象。
 */
export function parseJsonObject(raw: string): JsonValue {
  try {
    const value: unknown = JSON.parse(raw)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonValue : {}
  } catch {
    return {}
  }
}

/** 端点错误响应体的截断上限（发现模型的失败诊断用，防恶意网关撑爆日志）。 */
const MAX_ERROR_BODY_CHARS = 4096

/**
 * 模型列表 interrogation 的共享 GET：JSON 响应原样返回，非 2xx 抛带
 * 状态码与截断正文的 Error（由 llm 的 discoverModels 归一化为
 * model-discovery-failed 报给设置页）。
 * @param url - 要读取的端点。
 * @param headers - 随请求发送的头（含认证）。
 * @param signal - 调用方的取消信号。
 * @returns 端点返回的 JSON 值。
 * @throws {Error} 响应状态非 2xx。
 */
export async function getJson(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { headers, signal: signal ?? null })
  if (!response.ok) {
    const detail = (await response.text()).slice(0, MAX_ERROR_BODY_CHARS)
    throw new Error(`llm-plus: ${url} responded ${response.status}: ${detail}`)
  }
  return response.json()
}

/**
 * 把数值 reasoning 预算 clamp 进目录声明的范围（无范围原样通过——
 * 端点是最终仲裁者，clamp 只纠正目录已知的越界）。
 * @param value - 目录外传入的预算值。
 * @param budget - 目录声明的可选上下界。
 * @returns 落在声明范围内的值。
 */
export function clampBudget(value: number, budget?: { min?: number; max?: number }): number {
  if (budget?.min !== undefined && value < budget.min) return budget.min
  if (budget?.max !== undefined && value > budget.max) return budget.max
  return value
}

/**
 * openai 系 reasoning effort 透传前的档位校验：模型声明了档位池时，
 * 池外的值 fail loud（比 provider 400 更可行动；池未知则放行透传）。
 * @param effort - 请求的 reasoning effort 档位。
 * @param pool - 模型声明的档位池；缺席表示目录未给出。
 * @param model - 用于失败文案的模型名。
 * @returns 可透传的 effort 字符串。
 * @throws {Error} effort 不在声明的档位池内。
 */
export function validateEffort(effort: string, pool: string[] | undefined, model: string): string {
  if (pool !== undefined && pool.length > 0 && !pool.includes(effort)) {
    throw new Error(`llm-plus: reasoning effort ${JSON.stringify(effort)} is not valid for model ${JSON.stringify(model)} (expect one of ${pool.join(', ')})`)
  }
  return effort
}
