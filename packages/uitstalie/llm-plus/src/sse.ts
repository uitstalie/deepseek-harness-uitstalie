/**
 * SSE（Server-Sent Events）解析器与协议实现共享的接口定义。
 *
 * 四种 wire 协议都是"POST 一个 JSON，回一条 text/event-stream"，差别
 * 只在请求体形状与事件词汇。因此公共骨架是：buildRequest（序列化）
 * → fetch → parseSse（分帧）→ 每协议的 translator（有状态地把事件
 * 翻成 harness StreamChunk）。
 *
 * @module @deepseek-ai/dsh-llm-plus/sse
 */

/**
 * 一个 SSE 事件帧。
 * openai-completions / openai-responses / gemini 只用 data 字段；
 * anthropic-messages 用 event 字段区分 message_start / content_block_delta
 * 等事件类型。
 */
export interface SseEvent {
  /** `event:` 字段值；协议不发送时为 undefined。 */
  event?: string
  /** `data:` 字段值（多行 data 已按 SSE 规范用 \n 连接）。 */
  data: string
}

/**
 * 把响应体流解析为 SSE 事件序列。
 *
 * 实现要点：
 * - 按行缓冲，兼容 \n 与 \r\n 两种行尾；
 * - 空行 = 一帧结束（SSE 规范的分帧边界）；
 * - 以 ":" 开头的是注释行（保活心跳），跳过；
 * - 同一帧的多行 data 用 \n 连接（规范要求）；
 * - 流尾若还有没有空行收尾的残帧，补发一次（部分网关会这样截断）。
 *
 * @param body - fetch 响应的 ReadableStream。
 * @yields 解析出的事件帧，按到达顺序。
 */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  // lineBuf：还没遇到换行符的残行；dataBuf：当前帧已收集的 data 行；
  // eventField：当前帧的 event 字段
  let lineBuf = ''
  let dataBuf: string[] = []
  let eventField: string | undefined
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      lineBuf += decoder.decode(value, { stream: true })
      let newline: number
      // 逐行切出完整行处理，残行留在 lineBuf 等下一块
      while ((newline = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, newline).replace(/\r$/, '')
        lineBuf = lineBuf.slice(newline + 1)
        if (line === '') {
          // 空行分帧：有数据才发帧（连续空行不产生空帧）
          if (dataBuf.length > 0) {
            yield { ...(eventField === undefined ? {} : { event: eventField }), data: dataBuf.join('\n') }
            dataBuf = []
            eventField = undefined
          }
        } else if (line.startsWith(':')) {
          // 注释/心跳行，忽略
        } else if (line.startsWith('data:')) {
          dataBuf.push(line.slice(5).replace(/^ /, ''))
        } else if (line.startsWith('event:')) {
          eventField = line.slice(6).replace(/^ /, '')
        }
        // 其余字段（id:/retry:）四种协议都不用，忽略
      }
    }
    // 流尾残帧补发
    if (dataBuf.length > 0) {
      yield { ...(eventField === undefined ? {} : { event: eventField }), data: dataBuf.join('\n') }
    }
  } finally {
    reader.releaseLock()
  }
}
