/**
 * 四个协议共用的消息内容提取与序列化小工具。
 *
 * harness 的 Message.content 是 ContentBlock[]（text/reasoning/image/
 * tool-call/tool-result），序列化成各 wire 协议前需要先拆出这些成分。
 *
 * @module @deepseek-ai/dsh-llm-plus/protocols/shared
 */

import { textOnlyImageText, type ContentBlock, type ImageBlock, type ToolCallBlock, type ToolResultBlock } from '@deepseek-ai/dsh-llm'
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
    // reasoning / tool-call / tool-result 由各自的提取器处理，文本化时忽略
  }
  return text
}

/**
 * 取出消息里的 tool-result 块（harness 里 tool result 是 role:user 的
 * 单块消息，但防御性地按"任意消息里找"来写）。
 *
 * @param message - 任意带 content 的消息。
 * @returns 全部 tool-result 块（无则空数组）。
 */
export function extractToolResults(message: { readonly content: readonly ContentBlock[] }): ToolResultBlock[] {
  return message.content.filter((block): block is ToolResultBlock => block.type === 'tool-result')
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

/** image 块的占位文本（转发 harness 的稳定词汇，协议实现统一用它）。 */
export function imagePlaceholder(block: ImageBlock): string {
  return textOnlyImageText(block.attachment)
}

/**
 * 解析模型产出的 raw JSON 字符串（tool-call arguments）为对象。
 * anthropic 的 tool_use.input 与 gemini 的 functionCall.args 都必须是对象；
 * 解析失败回退空对象（畸形的调用本来也会被执行层拒绝）。
 */
export function parseJsonObject(raw: string): JsonValue {
  try {
    const value: unknown = JSON.parse(raw)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonValue : {}
  } catch {
    return {}
  }
}
