/**
 * PlusAdapter：把四种协议实现接到 dsh-llm 的 LlmAdapter 契约上。
 *
 * 职责边界：
 * - 目录查询（listModels/resolveModel）：手工 models 优先，否则问
 *   modelsDev 目录（可选依赖，缺席时退回空目录——catalog 是 advisory 的，
 *   不在目录里的模型照样能发请求）；
 * - stream：路由查找 → 每请求解析凭据（credentials seam 唯一路径）→
 *   协议 buildRequest（异步：图片字节）→ 合并额外 params（目录垫底、
 *   路由取胜）→ fetch → SSE → 协议翻译器 → StreamChunk；
 * - 路由表可经 updateRoutes 整体替换（settings 热更新的落点），
 *   替换是同步原子的，在途请求持旧快照不受影响。
 *
 * @module @deepseek-ai/dsh-llm-plus/adapter
 */

import {
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type ModelsDevCatalog from '@deepseek-ai/dsh-models-dev'
import { parseSse } from './sse.ts'
import type { ImageWireResolver, Protocol, StreamTranslator } from './protocol.ts'
import { openAiCompletions } from './protocols/openai-completions.ts'
import { openAiResponses } from './protocols/openai-responses.ts'
import { anthropicMessages } from './protocols/anthropic-messages.ts'
import { gemini } from './protocols/gemini.ts'
import type { ProtocolName, ResolvedRoute } from './config.ts'

/** 协议名 → 实现实例（无状态，全局共享）。 */
const PROTOCOLS: Record<ProtocolName, Protocol> = {
  'openai-completions': openAiCompletions,
  'openai-responses': openAiResponses,
  'anthropic-messages': anthropicMessages,
  'gemini': gemini,
}

/** 错误响应体截断上限（4KB 足够装下任何错误详情，防恶意网关撑爆日志）。 */
const MAX_ERROR_BODY_CHARS = 4096

/**
 * 把 HTTP 状态码映射为 harness 的稳定错误码。
 * 这个分类决定上层（llm-retry）是否重试：429/5xx 可恢复，4xx 多数是配置错。
 */
function classifyHttpStatus(status: number): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400 || status === 404 || status === 422) return 'INVALID_REQUEST'
  if (status === 408) return 'TIMEOUT'
  if (status >= 500) return 'SERVER'
  return 'UNKNOWN'
}

/** Uint8Array → base64（分块防栈溢出，图片可到数 MB）。 */
function toBase64(data: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    binary += String.fromCharCode(...data.subarray(offset, offset + CHUNK))
  }
  return btoa(binary)
}

/**
 * 多协议适配器。一个实例持有一组路由，注册到 ctx.llm。
 * 注册/替换经 registerAdapter 的 handle 管理，fiber 卸载自动摘除。
 */
export class PlusAdapter extends LlmAdapter {
  /**
   * @param routes - 解析后的路由表（构造期已校验）。
   * @param deps - 可选依赖集：modelsDev 目录 / credentials 凭据 /
   *   attachments 图片字节；缺席各自退化（空目录 / 请求期 AUTH 错 / 图片占位符）。
   */
  constructor(
    private routes: readonly ResolvedRoute[],
    private readonly deps: {
      catalog?: ModelsDevCatalog
      credentials?: CredentialProvider
      attachments?: AttachmentStore
      /** replay 降级告警出口（插件入口绑定 ctx.logger.warn）。 */
      warn?: (message: string) => void
    },
  ) {
    super()
  }

  /**
   * 整体替换路由表（settings 热更新落点）。
   * 同步赋值即完成：在途请求已在 buildRequest 时固化了自己的路由对象。
   * @param routes - 新的完整路由表。
   */
  updateRoutes(routes: readonly ResolvedRoute[]): void {
    this.routes = routes
  }

  /** 当前路由 id 集（初始注册与诊断用）。 */
  routeIds(): string[] {
    return this.routes.map(route => route.id)
  }

  /** 当前解析后的路由表（目录条目映射用；与 routeIds 同一来源）。 */
  resolvedRoutes(): readonly ResolvedRoute[] {
    return this.routes
  }

  /** 查路由；未注册的 route 是上层契约错误（LlmRuntime 已按注册表路由，到这里不该发生）。 */
  private route(provider: string): ResolvedRoute {
    const route = this.routes.find(candidate => candidate.id === provider)
    if (!route) throw new LlmError(`llm-plus: no route named ${JSON.stringify(provider)}`, 'NO_ADAPTER')
    return route
  }

  /** 路由级重试策略（registry 在注册/replace 时捕获；undefined = 用全局默认）。 */
  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.routes.find(candidate => candidate.id === provider)?.retryPolicy
  }

  /**
   * 每请求解析凭据。**唯一**路径是 credentials seam（环境变量与 .env 的
   * 兜底是 credentials provider 自己的分层职责，本插件不读 process.env）。
   * 缺失时报可行动的 AUTH 错误（消息点名引用名，绝不回显任何密钥内容）。
   */
  private async resolveApiKey(route: ResolvedRoute): Promise<string | undefined> {
    if (route.apiKeyRef === undefined) return undefined
    const resolved = this.deps.credentials
      ? await this.deps.credentials.resolve(credentialRef(route.apiKeyRef))
      : undefined
    const value = resolved?.value?.trim()
    if (value) return value
    throw new LlmError(
      `llm-plus: route ${JSON.stringify(route.id)} needs credential ${route.apiKeyRef};`
      + ' set it in the Models settings page or the credentials store',
      'AUTH',
    )
  }

  /**
   * reasoning 控制面材料：efforts 档位池（手工表或目录）+ budget 预算范围
   * （仅目录的 reasoning_options 提供）。都没有时缺席（协议不做校验/钳制）。
   */
  private reasoningAssets(
    route: ResolvedRoute,
    model: string,
    info: LlmResolvedModelInfo,
  ): { reasoning?: { efforts?: string[]; budget?: { min?: number; max?: number } } } {
    const efforts = info.reasoning?.efforts.map(effort => effort.id as string)
    const budget = route.modelsDevProvider !== undefined && this.deps.catalog !== undefined
      ? this.deps.catalog.resolveModelDefaults(route.modelsDevProvider, model)?.reasoningBudget
      : undefined
    const hasBudget = budget !== undefined && (budget.min !== undefined || budget.max !== undefined)
    if ((efforts === undefined || efforts.length === 0) && !hasBudget) return {}
    // exactOptionalPropertyTypes：逐字段条件展开，不带 undefined 键
    const budgetOut = hasBudget
      ? { ...(budget.min === undefined ? {} : { min: budget.min }), ...(budget.max === undefined ? {} : { max: budget.max }) }
      : undefined
    return {
      reasoning: {
        ...(efforts === undefined || efforts.length === 0 ? {} : { efforts }),
        ...(budgetOut === undefined ? {} : { budget: budgetOut }),
      },
    }
  }

  /**
   * 构造图片字节解析器。模型不收图（inputModalities 无 image）或
   * attachments 服务缺席时，解析器恒返回 undefined（协议实现换占位文本）。
   * 路由声明了 requestImagePolicy 时经 attachment seam 的 readImageRequest
   * 投影（像素预算 + 字节目标在 seam 内强制）；投影失败（provider 不支持）
   * 直接抛——路由显式声明的预算不能静默绕过。
   */
  private imageResolverFor(route: ResolvedRoute, info: LlmResolvedModelInfo): ImageWireResolver {
    const attachments = this.deps.attachments
    const acceptsImage = info.inputModalities?.includes('image') ?? false
    if (!attachments || !acceptsImage) return () => Promise.resolve(undefined)
    const policy = route.requestImagePolicy
    if (policy !== undefined) {
      return async (ref) => {
        const variant = await attachments.readImageRequest(ref, policy)
        return { base64: toBase64(variant.data), mediaType: variant.mediaType }
      }
    }
    return async (ref) => {
      const stored = await attachments.readImage(ref)
      return { base64: toBase64(stored.data), mediaType: ref.mediaType }
    }
  }

  /**
   * 列出路由的模型（advisory 目录）。
   * 手工 models 整体覆盖目录数据；都没有时给空表（契约允许）。
   */
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const route = this.route(provider)
    if (route.models) {
      return route.models.map(model => ({
        provider,
        id: model.id,
        name: model.name ?? model.id,
        ...(model.inputModalities === undefined ? {} : { inputModalities: model.inputModalities as never }),
      }))
    }
    if (!route.modelsDevProvider || !this.deps.catalog) return []
    // 目录是启动时异步加载的，等它 settle 再答（UI 打开选择器时目录已就绪）
    await this.deps.catalog.whenReady()
    const entry = this.deps.catalog.getProvider(route.modelsDevProvider)
    return Object.values(entry?.models ?? {}).map(model => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
      ...(model.modalities?.input === undefined ? {} : { inputModalities: model.modalities.input as never }),
    }))
  }

  /**
   * 解析一个模型的精确元数据（容量/默认 maxTokens/reasoning 档位）。
   * 手工 models 优先；其次目录；都未知时退回 id 回显（契约允许 advisory）。
   */
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const route = this.route(provider)
    const manual = route.models?.find(candidate => candidate.id === model)
    if (manual) {
      // schema 物化的空数组按"未知"归一化（空 efforts 会被 runtime 以 INVALID_MODEL_REASONING 拒绝）
      const reasoning = manual.reasoningEfforts === undefined || manual.reasoningEfforts.length === 0
        ? {}
        : { reasoning: { efforts: manual.reasoningEfforts.map(id => ({ id: ReasoningEffortId(id), name: id })) } }
      const modalities = manual.inputModalities === undefined || manual.inputModalities.length === 0
        ? {}
        : { inputModalities: manual.inputModalities as never }
      return {
        provider,
        id: manual.id,
        name: manual.name ?? manual.id,
        ...modalities,
        ...(manual.contextWindow === undefined ? {} : { context: { contextWindow: manual.contextWindow } }),
        ...(manual.maxTokens === undefined ? {} : { defaultMaxTokens: manual.maxTokens }),
        ...reasoning,
      }
    }
    if (route.modelsDevProvider && this.deps.catalog) {
      await this.deps.catalog.whenReady()
      const defaults = this.deps.catalog.resolveModelDefaults(route.modelsDevProvider, model)
      if (defaults) {
        return {
          provider,
          id: model,
          name: this.deps.catalog.getModel(route.modelsDevProvider, model)?.name ?? model,
          ...(defaults.inputModalities === undefined ? {} : { inputModalities: defaults.inputModalities as never }),
          ...(defaults.contextWindow === undefined ? {} : { context: { contextWindow: defaults.contextWindow } }),
          ...(defaults.maxTokens === undefined ? {} : { defaultMaxTokens: defaults.maxTokens }),
          ...(defaults.reasoningEfforts === undefined ? {} : {
            reasoning: { efforts: defaults.reasoningEfforts.map(id => ({ id: ReasoningEffortId(id), name: id })) },
          }),
        }
      }
    }
    // 未知模型：回显 id（advisory 契约——不拒绝请求）
    return { provider, id: model, name: model }
  }

  /**
   * 流式调用一个模型。失败分两路：HTTP 层错误抛 LlmError（runtime 归一化
   * 为 error finish chunk）；流内的协议错误由翻译器抛出同归一化。
   */
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const route = this.route(options.provider)
    const protocol = PROTOCOLS[route.protocol]
    // 请求期材料：凭据 + 图片解析器 + reasoning 控制面（协议实现只管用不管来源）。
    // 模型元数据解析一次，图片与 reasoning 共享（避免 resolveModel 双跑）
    const apiKey = await this.resolveApiKey(route)
    const info = await this.resolveModel(route.id, options.model)
    const warn = this.deps.warn
    const assets = {
      ...(apiKey === undefined ? {} : { apiKey }),
      image: this.imageResolverFor(route, info),
      ...(warn === undefined ? {} : {
        onReplayDegrade: (reason: string) => warn(`llm-plus: ${route.id}/${options.model}: ${reason}`),
      }),
      ...this.reasoningAssets(route, options.model, info),
    }
    const request = await protocol.buildRequest(route, options, assets)

    // 额外 params 原生注入（adapter 自有，无需任何缝）：
    // 目录 extraParams（models.dev 数据 + models-dev 插件配置）垫底，
    // 路由配置的 headers/body 取胜。目录查询键是路由声明的
    // modelsDevProvider（如 deepseek），不是路由 id 本身
    const extras = this.deps.catalog?.resolveExtraParams(route.modelsDevProvider ?? route.id, options.model)
    // request.headers 已含 route.headers（协议实现铺在最后）；这里把
    // extras 垫在中间、route.headers 再铺一遍，保证"路由取胜"对头也成立
    const headers = { ...request.headers, ...extras?.headers, ...route.headers }
    const body = { ...request.body, ...extras?.body, ...route.body }

    const response = await fetch(request.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: options.signal ?? null,
    })
    if (!response.ok) {
      // 错误体截断进 message（状态码进 status 字段，重试分类靠它）
      const detail = (await response.text()).slice(0, MAX_ERROR_BODY_CHARS)
      const retryAfter = Number(response.headers.get('retry-after'))
      throw new LlmError(
        `llm-plus: ${route.id}/${options.model} responded ${response.status}: ${detail}`,
        classifyHttpStatus(response.status),
        {
          status: response.status,
          ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { providerRetryAfterMs: retryAfter * 1000 } : {}),
        },
      )
    }
    if (!response.body) {
      throw new LlmError(`llm-plus: ${route.id}/${options.model} responded without a body`, 'UNKNOWN', { status: response.status })
    }

    const translator: StreamTranslator = protocol.createTranslator(route, options)
    for await (const event of parseSse(response.body)) {
      yield* translator.push(event)
    }
    yield* translator.end()
  }
}
