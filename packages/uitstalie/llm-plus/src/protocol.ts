/**
 * 协议实现共享的接口与公共工具（v2：加入图片解析与 replay 基座）。
 *
 * 每个协议实现两件事：
 * 1. buildRequest —— 把 harness 的 GenerateOptions 序列化为 wire 请求
 *    （异步：图片字节要读 attachments 服务）；
 * 2. createTranslator —— 有状态翻译器，SSE 事件 → harness StreamChunk，
 *    并顺带采集 replay 元数据（签名/加密思考项，见 BaseTranslator 说明）。
 *
 * @module @deepseek-ai/dsh-llm-plus/protocol
 */

import { ToolCallId, type GenerateOptions, type LlmDiscoveredModel, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { JsonValue } from '@deepseek-ai/dsh-models-dev'
import type { ResolvedRoute } from './config.ts'
import type { SseEvent } from './sse.ts'

/** StreamChunk 的 finish 变体（finishChunk 组装 replayState 时保持判别）。 */
export type FinishChunk = Extract<StreamChunk, { type: 'finish' }>

/**
 * 打开中的 block 簿记（纯数据：类型 + 累积文本 + tool-call 元数据）。
 * 逻辑（开/追加/关）全在 BaseTranslator 的方法上，这里只承载状态。
 */
export interface OpenBlockState {
  /** block 类型（决定 closeBlock 时组装成哪种完整 block）。 */
  type: 'text' | 'reasoning' | 'tool-call'
  /** 累积的文本/参数 JSON 缓冲。 */
  text: string
  /** provider 给的 tool-call id；缺席时 closeBlock 合成 `call_<index>`。 */
  toolId?: string
  /** 工具名。 */
  toolName?: string
}

/** 一次 wire 请求的全部材料（fetch 直接可用）。 */
export interface ProtocolRequest {
  /** 完整 URL（含路径，协议实现拼好）。 */
  url: string
  /** 请求头（已含认证头与合并后的额外头）。 */
  headers: Record<string, string>
  /** 请求体对象（调用方 JSON.stringify）。 */
  body: Record<string, JsonValue>
}

/**
 * 图片字节解析器（adapter 注入给协议）。
 * 入参是 durable 附件引用；返回 base64 与媒体类型；返回 undefined 表示
 * 该图片不能进请求（模型不收图 / attachments 服务缺席），协议实现应替换为
 * `textOnlyImageText(ref)` 占位文本而不是丢图。
 */
export type ImageWireResolver = (ref: ImageAttachmentRef) => Promise<{ base64: string; mediaType: string } | undefined>

/**
 * buildRequest 的第三参：adapter 在请求期解析好的公共材料。
 * 协议实现只管用，不管怎么来（credentials seam / 环境变量 / attachments）。
 */
export interface RequestAssets {
  /** 本请求解析出的 API key；路由免认证时缺席。 */
  apiKey?: string
  /** 图片字节解析器。 */
  image: ImageWireResolver
}

/**
 * 协议实现。四种协议各有一个实例，注册在 PROTOCOLS 表里；
 * 路由配置用协议名显式选择，不做任何按 URL 的猜测（那是 pi-ai 的做法，
 * 也是它 compat 门禁系统的根源——我们拥有实现，就没有上游可漂移）。
 */
export interface Protocol {
  /**
   * 序列化请求（异步：历史里的图片要读字节）。
   * @param route - 解析后的路由配置。
   * @param options - harness 组装好的完整请求。
   * @param assets - adapter 解析好的请求期材料（key / 图片解析器）。
   * @returns fetch 直接可用的请求材料。
   */
  buildRequest(route: ResolvedRoute, options: GenerateOptions, assets: RequestAssets): Promise<ProtocolRequest>
  /**
   * 创建本请求的流翻译器。
   * @param route - 同一路由。
   * @param options - 同一请求。
   * @returns 有状态翻译器。
   */
  createTranslator(route: ResolvedRoute, options: GenerateOptions): StreamTranslator
  /**
   * 端点模型列表 interrogation：原生设置页"发现模型"按钮的落点——
   * 用户在编辑一个还没有路由的草稿，直接拿端点 + 一次性凭据问端点
   * （目录数据由 adapter 的 listModels 分支回答，不走这里）。
   * @param baseURL - 草稿上的端点。
   * @param apiKey - 一次性凭据（harness 不存储）；免认证端点缺席。
   * @param signal - 调用方取消。
   * @returns 端点自报的模型（多数只披露 id）。
   */
  discoverModels?(baseURL: string, apiKey: string | undefined, signal?: AbortSignal): Promise<LlmDiscoveredModel[]>
}

/**
 * 有状态的 SSE → StreamChunk 翻译器。
 * 一个请求创建一个实例；事件按序喂入 push()，流结束时调用 end()
 * 补齐未闭合的 block 与 finish（provider 正常收尾时 end() 多为空）。
 */
export interface StreamTranslator {
  /**
   * 处理一个 SSE 事件。
   * @param event - 解析好的事件帧。
   * @returns 本事件产生的 0..n 个 StreamChunk，按发出顺序。
   */
  push(event: SseEvent): StreamChunk[]
  /**
   * 流结束收尾：闭合未关的 block、补 finish（携带 replayState 若有）。
   * @returns 收尾产生的 chunk；正常情况下为空数组。
   */
  end(): StreamChunk[]
}

/**
 * llm-plus 自有 replay envelope 形状（存进 finish chunk 的 replayState，
 * 随 assistant 消息持久化，下次请求由同协议 adapter 原样回带）。
 *
 * harness 契约（ReplayEnvelope）：`response` 是**必填**的响应级元数据槽
 * （llm-plus 目前没有响应级消费者，恒发 `{}`）；blocks 与发出的 block 按
 * **首次出现顺序**一一对齐——assembler 丢 block 时同位置丢 entry，长度
 * 不一致则整个 envelope 作废。因此每个 block 都必须有 entry（无元数据
 * 的填 null），不能只记有签名的。
 */
export interface PlusReplayEnvelope {
  /** 品牌字段：识别这是 llm-plus 产的 envelope。 */
  kind: 'llm-plus'
  /** 形状版本；不匹配即降级（不强行读旧格式）。 */
  version: 1
  /** 产出该响应的协议名；跨协议的消息绝不回带。 */
  protocol: string
  /** 响应级元数据槽（harness ReplayEnvelope 必填；当前恒为空对象）。 */
  response: Record<string, JsonValue>
  /** 逐 block 元数据（null = 该 block 无 replay 数据）。 */
  blocks: (Record<string, JsonValue> | null)[]
}

/**
 * 翻译器的公共基座：block 生命周期簿记 + replay 元数据收集 + 收尾。
 *
 * harness 契约要求：block-start(index, blockType) → 若干 delta(index) →
 * block-end(index, 组装好的完整 block)；finish 是终帧，之后不能再有
 * chunk。四个协议的差异只在"什么事件开什么 block、delta 是什么、
 * replay 元数据是什么"，收尾与簿记全部收在这里：
 * - openBlock/appendDelta/closeBlock：单个 block 的生命周期；
 * - appendLazy：provider 不给索引的协议（openai-completions/gemini）的
 *   reasoning/text 惰性 block，返回 index 供调用方挂 replay 元数据；
 * - closeAll/terminate/end：收尾三件套——terminate 幂等（多余的 finish
 *   帧返回空），end() 是断流兜底，子类只需实现 push()。
 */
export abstract class BaseTranslator implements StreamTranslator {
  /** @param protocol - 协议名（replay envelope 的 protocol 字段用它）。 */
  protected constructor(private readonly protocol: string) {}

  /** 下一个 block 的索引（provider 不给索引的协议用它自增）。 */
  protected nextIndex = 0
  /** index → 打开中的 block 簿记。 */
  protected readonly openBlocks = new Map<number, OpenBlockState>()
  /**
   * 全部 block（含已关闭）的首次出现顺序表：replay envelope 的 blocks
   * 与它对齐。entry 初始为 null，协议在拿到签名/加密项时经 setBlockMeta 写入。
   */
  protected readonly blockOrder: number[] = []
  /** index → replay 元数据（undefined = 该 block 无数据）。 */
  protected readonly blockMeta = new Map<number, Record<string, JsonValue>>()
  /** reasoning/text 惰性 block 的索引（appendLazy 用）。 */
  private readonly lazyBlocks: Partial<Record<'text' | 'reasoning', number>> = {}
  /** 是否已收尾（terminate 幂等的依据）。 */
  private finished = false

  abstract push(event: SseEvent): StreamChunk[]

  /**
   * 打开一个 block（发 block-start），返回其索引。
   * @param type - block 类型。
   * @param fixedIndex - provider 给了索引时用它（anthropic）；否则自增。
   */
  protected openBlock(type: 'text' | 'reasoning' | 'tool-call', fixedIndex?: number): { index: number; chunk: StreamChunk } {
    const index = fixedIndex ?? this.nextIndex++
    this.nextIndex = Math.max(this.nextIndex, index + 1)
    this.openBlocks.set(index, { type, text: '' })
    this.blockOrder.push(index)
    return { index, chunk: { type: 'block-start', index, blockType: type } }
  }

  /**
   * 取一个确定打开的 block 的簿记。
   * 不存在说明调用方的簿记序列错了（如 delta 先于 start 且未经
   * appendDelta/appendLazy 的自动开块），属内部逻辑错误，直接抛。
   */
  protected blockAt(index: number): OpenBlockState {
    const block = this.openBlocks.get(index)
    if (!block) throw new Error(`llm-plus: block ${index} is not open`)
    return block
  }

  /**
   * 向打开的 block 追加文本 delta；未打开时先打开（容错：部分网关省略 start）。
   * @returns 需要发出的 chunk 列表（可能含隐式的 block-start）。
   */
  protected appendDelta(index: number, type: 'text' | 'reasoning', text: string): StreamChunk[] {
    const chunks: StreamChunk[] = []
    if (!this.openBlocks.has(index)) chunks.push(this.openBlock(type, index).chunk)
    const block = this.blockAt(index)
    block.text += text
    chunks.push(type === 'text'
      ? { type: 'text-delta', index, text }
      : { type: 'reasoning-delta', index, text })
    return chunks
  }

  /**
   * 向 reasoning/text 的惰性 block 追加 delta；首次出现时先开 block
   * （返回的 chunks 里含 block-start）。返回 index 供调用方给同一块
   * 挂 replay 元数据（如 gemini 的 thoughtSignature）。
   */
  protected appendLazy(type: 'text' | 'reasoning', text: string): { index: number; chunks: StreamChunk[] } {
    const chunks: StreamChunk[] = []
    let index = this.lazyBlocks[type]
    if (index === undefined) {
      const opened = this.openBlock(type)
      index = opened.index
      this.lazyBlocks[type] = index
      chunks.push(opened.chunk)
    }
    chunks.push(...this.appendDelta(index, type, text))
    return { index, chunks }
  }

  /**
   * 关闭一个 block（发 block-end，附组装好的完整 block）。
   * @returns block-end chunk；block 不存在（重复关闭）时返回空。
   */
  protected closeBlock(index: number): StreamChunk[] {
    const block = this.openBlocks.get(index)
    if (!block) return []
    this.openBlocks.delete(index)
    const assembled = block.type === 'tool-call'
      // provider 没发 id 时合成一个（tool-call 关联靠它，绝不能丢）
      ? { type: 'tool-call' as const, id: ToolCallId(block.toolId ?? `call_${index}`), name: block.toolName ?? '', arguments: block.text }
      : { type: block.type, text: block.text } as const
    return [{ type: 'block-end', index, block: assembled }]
  }

  /** 关闭全部未关 block（按索引升序，保持发出顺序稳定）。 */
  protected closeAll(): StreamChunk[] {
    const chunks: StreamChunk[] = []
    for (const index of [...this.openBlocks.keys()].sort((a, b) => a - b)) {
      chunks.push(...this.closeBlock(index))
    }
    return chunks
  }

  /**
   * 记录一个 block 的 replay 元数据（多次写入浅合并，后写覆盖同名字段）。
   * @param index - block 索引。
   * @param meta - 元数据字段（如 anthropic 的 {signature}）。
   */
  protected setBlockMeta(index: number, meta: Record<string, JsonValue>): void {
    this.blockMeta.set(index, { ...this.blockMeta.get(index), ...meta })
  }

  /**
   * 正常收尾：先关全部 block 再发 finish（契约：finish 是终帧，之后不能
   * 再有 chunk）。幂等——重复的 finish 帧返回空，不再产出 chunk。
   * @param rawReason - provider 的原始 stop 原因（缺省按 stop 处理）。
   * @returns block-end 序列 + finish（携带 replay envelope 若有）。
   */
  protected terminate(rawReason?: string | null): StreamChunk[] {
    if (this.finished) return []
    this.finished = true
    return [...this.closeAll(), this.finishChunk(rawReason)]
  }

  /** finish chunk：携带 replay envelope（有元数据时）。 */
  private finishChunk(rawReason: string | undefined | null): StreamChunk {
    const base = mapFinishReason(rawReason)
    const replay = this.buildReplay()
    return replay === undefined ? base : { ...base, replayState: replay }
  }

  /**
   * 组装 replay envelope：blocks 与 blockOrder 对齐，无元数据的 block
   * 填 null；response 槽恒为 {}（harness 必填，llm-plus 暂无响应级
   * 元数据消费者）。全部 block 都无元数据时返回 undefined（契约：
   * 无 replay 数据的响应不带 envelope）。
   */
  private buildReplay(): PlusReplayEnvelope | undefined {
    const blocks = this.blockOrder.map(index => this.blockMeta.get(index) ?? null)
    if (blocks.every(entry => entry === null)) return undefined
    return { kind: 'llm-plus', version: 1, protocol: this.protocol, response: {}, blocks }
  }

  /** 断流收尾：provider 没发 finish 帧时，terminate 补一个 stop。 */
  end(): StreamChunk[] {
    return this.terminate()
  }
}

/** 把 provider 的原始 stop 原因映射为 harness finish chunk 的公共查表。 */
export function mapFinishReason(raw: string | undefined | null): FinishChunk {
  const kind = raw === 'length' || raw === 'max_tokens' || raw === 'MAX_TOKENS'
    ? 'max-tokens'
    : raw === 'tool_calls' || raw === 'function_call' || raw === 'tool_use'
      ? 'tool-calls'
      : 'stop'
  return { type: 'finish', reason: { kind } }
}

/**
 * 读取 assistant 历史消息上的 llm-plus replay envelope 并校验。
 *
 * 校验规则（任一不过即降级为 undefined，绝不强行读）：
 * kind/version 匹配；envelope.protocol 等于当前路由协议；blocks 是数组。
 * blocks 与消息 content 的位置对齐由调用方在使用时核对（长度不等即降级）。
 *
 * @param source - 历史消息的 source（kind≠'model' 或无 replayState 直接 undefined）。
 * @param protocol - 当前路由的协议名。
 * @returns 校验通过的 envelope，或 undefined（降级为无 replay 序列化）。
 */
export function readReplayEnvelope(source: unknown, protocol: string): PlusReplayEnvelope | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const replay = (source as { replayState?: unknown }).replayState
  if (typeof replay !== 'object' || replay === null) return undefined
  const envelope = replay as Partial<PlusReplayEnvelope>
  if (envelope.kind !== 'llm-plus' || envelope.version !== 1) return undefined
  if (envelope.protocol !== protocol) return undefined
  if (!Array.isArray(envelope.blocks)) return undefined
  return envelope as PlusReplayEnvelope
}
