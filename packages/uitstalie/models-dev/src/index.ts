/**
 * models.dev 目录服务：启动拉取 + 磁盘缓存 TTL 兜底（对齐 opencode 的机制，
 * 见 goal/model-provider-data-source.md 第 7 节），provider/model 查询、
 * harness 形状默认值映射，以及额外请求参数的用户侧写入位置（extraParams 配置）。
 *
 * 加载语义（重要）：
 * 1. 缓存新鲜（mtime 在 TTL 内）→ 直接用缓存，零网络；
 * 2. 缓存陈旧/不存在 → 尝试拉取；拉取失败且缓存存在 → 回退陈旧缓存继续服务；
 * 3. 拉取失败且无缓存 → 以空目录（provenance='none'）服务，查询方法返回空
 *    结果而不抛错，后续 refresh() 仍可成功。
 * 即"目录缺席不阻塞系统启动"——模型目录是 advisory 的（dsh-llm 契约），
 * 空目录只是 UI 不显示模型，不影响已有配置发请求。
 *
 * @module @deepseek-ai/dsh-models-dev
 */

import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import {
  mergeExtraParams,
  modelDefaults,
  parseCatalog,
  type ExtraParams,
  type JsonValue,
  type ModelDefaults,
  type ModelsDevCatalogData,
  type ModelsDevModel,
  type ModelsDevProvider,
} from './catalog.ts'

// 类型面整体再导出，让消费方从包根一处拿全
export type * from './catalog.ts'

/** 默认数据集源；`file://` 开头的 URL 改为读磁盘（离线开发与测试夹具用）。 */
export const DEFAULT_SOURCE_URL = 'https://models.dev/api.json'
/** 载荷大小硬上限：文本完整缓冲后才解析，超限直接拒绝（实测全量约 4.4MB）。 */
export const MAX_CATALOG_BYTES = 32 * 1024 * 1024

/**
 * 用户为单个 provider 配置的额外参数（写入位置）。
 * 键用 models.dev provider id（不是 harness 路由名），经 routeAliases 解析。
 */
export interface ExtraParamsConfig {
  /** 额外 HTTP 头（当前仅暴露数据，注入缺缝——见 deepseek-extra-params.ts 头注释）。 */
  headers?: Record<string, string>
  /** 额外顶层请求体字段。 */
  body?: Record<string, JsonValue>
  /** 按模型的覆盖，与 provider 级浅合并（模型级取胜）。 */
  models?: Record<string, { headers?: Record<string, string>; body?: Record<string, JsonValue> }>
}

/** 插件配置（全部可选；缺省值由 schema 的 .default() 在 cordis 校验期物化，
 *  直接 ctx.plugin 的调用方由构造器的 ?? 兜底——两条路径产物一致）。 */
export interface Config {
  /** 数据集源 URL；file:// 读磁盘。 */
  sourceUrl?: string
  /** 磁盘缓存文件路径（默认 ~/.dsh/cache/models-dev.json）。 */
  cachePath?: string
  /** 缓存新鲜度窗口（毫秒）；窗口内零网络。 */
  cacheTtlMs?: number
  /** 单次拉取超时（毫秒）。 */
  timeoutMs?: number
  /**
   * harness provider 路由 → models.dev provider id 的映射。
   * 例子：harness 的 DeepSeek 路由叫 `deepseek-official`，数据集里叫 `deepseek`。
   * 未列出的路由原样当作 models.dev id 使用。
   */
  routeAliases?: Record<string, string>
  /** 额外请求参数写入位置，键为 models.dev provider id。 */
  extraParams?: Record<string, ExtraParamsConfig>
}

/** 当前服务的目录来自哪里。'none' 表示空目录（网络与缓存都不可用）。 */
export type CatalogProvenance = 'network' | 'cache' | 'none'

// Remote 边界类型从 ./types 子路径公开（Typert 契约），包根再导出方便消费方
import type { CatalogModelSummary, CatalogProviderSummary } from './types.ts'
export type { CatalogModelSummary, CatalogProviderSummary } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    modelsDev: ModelsDevCatalog
  }

  interface Events {
    /**
     * 服务的目录被替换（启动加载或 refresh() 成功后）。
     * 消费方（如未来的 UI）据此刷新模型列表。
     * @param provenance - 新目录的来源。
     * @mode emit
     */
    'models-dev/updated'(this: ModelsDevCatalog, provenance: CatalogProvenance): void
  }
}

/** 物化后的生效配置（全部字段有值）。 */
interface ResolvedConfig {
  sourceUrl: string
  cachePath: string
  cacheTtlMs: number
  timeoutMs: number
  routeAliases: Record<string, string>
  extraParams?: Record<string, ExtraParamsConfig>
}

/** 校验正整数配置字段（毫秒数/字节数这类），不合法即构造期 fail loud。 */
function assertPositiveInteger(label: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`models-dev: ${label} must be a positive integer`)
  }
}

/**
 * 校验 extraParams 的结构（用户配置边界）。
 * schemastery 只能把它声明为 dict(any)（键与嵌套形状是运行时数据），
 * 所以嵌套层级在这里手工校验，错误信息精确到配置路径。
 */
function assertExtraParamsShape(extraParams: Record<string, ExtraParamsConfig>): void {
  for (const [providerId, entry] of Object.entries(extraParams)) {
    if (entry === null || typeof entry !== 'object') {
      throw new Error(`models-dev: extraParams.${providerId} must be an object`)
    }
    for (const [modelId, modelEntry] of Object.entries(entry.models ?? {})) {
      if (modelEntry === null || typeof modelEntry !== 'object') {
        throw new Error(`models-dev: extraParams.${providerId}.models.${modelId} must be an object`)
      }
    }
  }
}

/**
 * models.dev 目录服务（Service 类插件形态：默认导出服务类即插件，
 * Loader 以 `new ModelsDevCatalog(ctx, config)` 挂载；构造即向 ctx 注册
 * `modelsDev` 服务，fiber 卸载时自动摘除）。
 *
 * 内部状态三个一组：data（当前服务的目录）+ provenance（来源）+ fetchedAt
 * （时间戳），只在 adopt() 里一起换，保证读者永远看到自洽的一组。
 */
export default class ModelsDevCatalog extends TypertRemoteService {
  static Config: z<Config> = z.object({
    sourceUrl: z.string().default(DEFAULT_SOURCE_URL),
    cachePath: z.string().default(dshHomePath('cache', 'models-dev.json')),
    cacheTtlMs: z.number().step(1).min(1).default(3_600_000),
    timeoutMs: z.number().step(1).min(1).default(10_000),
    routeAliases: z.dict(z.string()).default({ 'deepseek-official': 'deepseek' }),
    // extraParams 的键与嵌套是运行时数据，schema 层只能声明为 dict(any)，
    // 结构校验在构造器里（assertExtraParamsShape）
    extraParams: z.dict(z.any()),
  })

  /** 冻结后的生效配置（物化 + 校验都通过后的值）。 */
  private readonly config: ResolvedConfig
  /** 当前服务的目录数据；空表 + provenance='none' 表示"不可用"。 */
  private data: ModelsDevCatalogData = Object.create(null)
  private provenance: CatalogProvenance = 'none'
  /** 当前目录的取得时间（epoch 毫秒）；空目录为 0。 */
  private fetchedAt = 0
  /** 首次加载的 settle promise；whenReady() 暴露给依赖方。 */
  private readonly ready: Promise<void>
  /** 服务级生命周期开关：dispose 时中止在途拉取。 */
  private readonly lifetime = new AbortController()
  /** 在途的 refresh()；并发 refresh 共享同一个 promise（防抖）。 */
  private refreshing: Promise<void> | undefined

  constructor(ctx: Context, config: Config) {
    // super() 即完成 ctx.modelsDev 注册（Service 基类契约），后续行注册失败会留下
    // 半注册状态——所以所有可能抛错的校验都放在 super 之后、异步加载开始之前
    super(ctx, 'modelsDev')
    if (config === null || typeof config !== 'object') {
      throw new Error('models-dev: configuration is required')
    }
    // 物化默认值：cordis 校验路径由 schema 的 .default() 完成；直接
    // ctx.plugin 的调用方绕过 schema，由这里的 ?? 兜底（两条路径产物一致）
    const resolved: ResolvedConfig = {
      sourceUrl: config.sourceUrl ?? DEFAULT_SOURCE_URL,
      cachePath: config.cachePath ?? dshHomePath('cache', 'models-dev.json'),
      cacheTtlMs: config.cacheTtlMs ?? 3_600_000,
      timeoutMs: config.timeoutMs ?? 10_000,
      routeAliases: config.routeAliases ?? { 'deepseek-official': 'deepseek' },
      ...(config.extraParams === undefined ? {} : { extraParams: config.extraParams }),
    }
    assertPositiveInteger('cacheTtlMs', resolved.cacheTtlMs)
    assertPositiveInteger('timeoutMs', resolved.timeoutMs)
    assertExtraParamsShape(resolved.extraParams ?? {})
    this.config = Object.freeze(resolved)
    // 启动加载不阻塞构造（插件激活不等网络）；依赖方用 whenReady() 对齐
    this.ready = this.load()
    ctx.effect(() => () => {
      this.lifetime.abort(new Error('models-dev service disposed'))
    }, 'models-dev.dispose')
  }

  /** 等首次加载（网络或缓存兜底）结束；失败路径也在内部消化，不会 reject。 */
  whenReady(): Promise<void> {
    return this.ready
  }

  /** 当前目录的来源（network/cache/none）。 */
  get source(): CatalogProvenance {
    return this.provenance
  }

  /** 当前目录的取得时间（epoch 毫秒）；空目录为 0。 */
  get catalogFetchedAt(): number {
    return this.fetchedAt
  }

  /** 目录里全部 provider id。 */
  listProviders(): string[] {
    return Object.keys(this.data)
  }

  /**
   * 目录提供商摘要列表（models.dev 设置页的列表数据源）。
   * 按 id 排序，输出稳定；空目录返回空数组（provenance='none' 时
   * 页面显示空态而不是报错——目录是 advisory 的）。
   * @returns 全部提供商的摘要（含协议方言/端点/凭据变量名/模型数）。
   */
  @Remote
  listCatalogProviders(): CatalogProviderSummary[] {
    return Object.entries(this.data)
      .map(([id, provider]) => ({
        id,
        ...(provider.name === undefined ? {} : { name: provider.name }),
        ...(provider.npm === undefined ? {} : { npm: provider.npm }),
        ...(provider.api === undefined ? {} : { api: provider.api }),
        ...(provider.env === undefined ? {} : { env: [...provider.env] }),
        modelCount: Object.keys(provider.models).length,
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
  }

  /**
   * 一个提供商的目录模型摘要列表（设置页的模型子集勾选数据源）。
   * @param providerId - models.dev provider id。
   * @returns 模型摘要（按 id 排序）；未知 provider 返回空数组。
   */
  @Remote
  listCatalogModels(providerId: string): CatalogModelSummary[] {
    const provider = this.data[providerId]
    if (provider === undefined) return []
    return Object.values(provider.models)
      .map(model => ({
        id: model.id,
        ...(model.name === undefined ? {} : { name: model.name }),
        ...(model.limit?.context === undefined ? {} : { contextWindow: model.limit.context }),
        ...(model.limit?.output === undefined ? {} : { maxTokens: model.limit.output }),
        ...(model.modalities?.input === undefined ? {} : { inputModalities: [...model.modalities.input] }),
        ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
  }

  /**
   * 查一个 provider 条目。
   * @param providerId - models.dev provider id（如 "deepseek"）。
   * @returns provider 条目；不存在返回 undefined。
   */
  getProvider(providerId: string): ModelsDevProvider | undefined {
    return this.data[providerId]
  }

  /**
   * 查一个模型条目。
   * @param providerId - models.dev provider id。
   * @param modelId - 该 provider 下的模型 id。
   * @returns 模型条目；不存在返回 undefined。
   */
  getModel(providerId: string, modelId: string): ModelsDevModel | undefined {
    return this.data[providerId]?.models[modelId]
  }

  /**
   * 把 harness provider 路由解析为 models.dev provider id。
   * @param route - harness 路由（如 "deepseek-official"）。
   * @returns 别名命中返回映射值，否则原样返回 route。
   */
  resolveRoute(route: string): string {
    return this.config.routeAliases[route] ?? route
  }

  /**
   * 把一个模型映射为 harness 形状默认值（上下文窗口、模态、reasoning 档位、
   * 价格、协议方言提示）。
   * @param route - harness 路由或 models.dev provider id。
   * @param modelId - 模型 id。
   * @returns 映射结果；模型未知返回 undefined（不是空对象）。
   */
  resolveModelDefaults(route: string, modelId: string): ModelDefaults | undefined {
    const providerId = this.resolveRoute(route)
    const model = this.getModel(providerId, modelId)
    if (!model) return undefined
    return modelDefaults(model, this.getProvider(providerId)?.npm)
  }

  /**
   * 解析一个路由/模型的额外请求参数。
   *
   * 合并顺序（后者按 key 取胜）：
   * 1. 数据集 experimental.modes[mode].provider（仅当调用方给了 mode）；
   * 2. 用户配置 provider 级 extraParams；
   * 3. 用户配置 model 级 extraParams。
   * 用户配置优先于数据集——数据集是公共默认值，本地配置是部署意图。
   *
   * @param route - harness 路由或 models.dev provider id。
   * @param modelId - 模型 id。
   * @param mode - 可选的 models.dev 实验模式名（如 "fast"）。
   * @returns 合并后的 headers/body；无命中返回空对象。
   */
  resolveExtraParams(route: string, modelId: string, mode?: string): ExtraParams {
    const providerId = this.resolveRoute(route)
    const model = this.getModel(providerId, modelId)
    let result: ExtraParams = {}
    if (mode !== undefined) {
      const modeProvider = model?.experimental?.modes?.[mode]?.provider
      if (modeProvider) result = mergeExtraParams(result, modeProvider as ExtraParams)
    }
    const userProvider = this.config.extraParams?.[providerId]
    if (userProvider) {
      // exactOptionalPropertyTypes：undefined 字段不能直接塞进 ExtraParams
      result = mergeExtraParams(result, {
        ...(userProvider.headers === undefined ? {} : { headers: userProvider.headers }),
        ...(userProvider.body === undefined ? {} : { body: userProvider.body }),
      })
      const userModel = userProvider.models?.[modelId]
      if (userModel) result = mergeExtraParams(result, userModel)
    }
    return result
  }

  /**
   * 列出一个路由配置过的全部 body 键（provider 级 + 所有 model 级的并集）。
   * 写入方（deepseek-extra-params 插件）据此在启动时为每个键注册一个
   * 顶层字段槽——注册必须在请求到来前完成，所以键集是启动时静态确定的，
   * 只有用户配置贡献键（数据集的 mode 级 body 不参与自动注入）。
   *
   * @param route - harness 路由或 models.dev provider id。
   * @returns 去重排序后的键列表。
   */
  configuredBodyKeys(route: string): string[] {
    const providerId = this.resolveRoute(route)
    const entry = this.config.extraParams?.[providerId]
    if (!entry) return []
    const keys = new Set(Object.keys(entry.body ?? {}))
    for (const modelEntry of Object.values(entry.models ?? {})) {
      for (const key of Object.keys(modelEntry.body ?? {})) keys.add(key)
    }
    return [...keys].sort()
  }

  /**
   * 强制重拉（无视缓存 TTL）。并发调用共享同一次拉取；失败只记日志、
   * 保留当前目录，不抛给调用方。
   * @returns 拉取（或失败消化）完成后 settle。
   */
  refresh(): Promise<void> {
    this.refreshing ??= this.fetchAndAdopt()
      .catch((error: unknown) => {
        this.ctx.logger('models-dev').warn('models-dev: refresh failed, keeping current catalog', error)
      })
      .finally(() => {
        this.refreshing = undefined
      })
    return this.refreshing
  }

  /**
   * 原子替换当前服务的目录并广播 `models-dev/updated`。
   * data/provenance/fetchedAt 三个字段只在这里一起换，是唯一的提交点。
   */
  private adopt(text: string, provenance: CatalogProvenance, fetchedAt: number): void {
    this.data = parseCatalog(text, (entry, reason) => {
      this.ctx.logger('models-dev').warn(`models-dev: dropped ${entry}: ${reason}`)
    })
    this.provenance = provenance
    this.fetchedAt = fetchedAt
    this.ctx.emit(this, 'models-dev/updated', provenance)
  }

  /**
   * 首次加载的完整决策链：缓存新鲜 → 直接用；否则拉取，失败回退陈旧缓存，
   * 无缓存则以空目录服务。所有失败路径都在这里消化，ready 永不 reject。
   */
  private async load(): Promise<void> {
    const cached = await this.readCache()
    const fresh = cached !== undefined && Date.now() - cached.mtimeMs < this.config.cacheTtlMs
    if (fresh) {
      this.adopt(cached.text, 'cache', cached.mtimeMs)
      return
    }
    try {
      await this.fetchAndAdopt()
    } catch (error) {
      if (cached !== undefined) {
        this.adopt(cached.text, 'cache', cached.mtimeMs)
        this.ctx.logger('models-dev').warn('models-dev: fetch failed, serving stale cache', error)
      } else {
        this.ctx.logger('models-dev').error('models-dev: fetch failed and no cache exists; catalog is empty', error)
      }
    }
  }

  /** 拉取 → 采用 → 写缓存（缓存写失败只告警，不影响目录服务）。 */
  private async fetchAndAdopt(): Promise<void> {
    const text = await this.fetchSource()
    this.adopt(text, 'network', Date.now())
    // file:// 源的"缓存"就是源文件本身，写缓存无意义且可能写坏夹具
    if (!this.config.sourceUrl.startsWith('file://')) {
      try {
        await writeFileAtomic(this.config.cachePath, text, { mode: 0o600 })
      } catch (error) {
        this.ctx.logger('models-dev').warn('models-dev: cache write failed', error)
      }
    }
  }

  /**
   * 从配置的源取原始文本。file:// 走磁盘；http(s) 走 fetch，
   * 超时与服务 dispose 合并为一个 AbortSignal（任一触发即中止）。
   * 响应非 2xx 与超限都在这里变成 throw，由调用方决定回退策略。
   */
  private async fetchSource(): Promise<string> {
    if (this.config.sourceUrl.startsWith('file://')) {
      return readFile(fileURLToPath(this.config.sourceUrl), 'utf8')
    }
    const signal = AbortSignal.any([
      this.lifetime.signal,
      AbortSignal.timeout(this.config.timeoutMs),
    ])
    const response = await fetch(this.config.sourceUrl, { signal })
    if (!response.ok) {
      throw new Error(`models-dev: ${this.config.sourceUrl} responded ${response.status}`)
    }
    const text = await response.text()
    if (text.length > MAX_CATALOG_BYTES) {
      throw new Error(`models-dev: payload exceeds ${MAX_CATALOG_BYTES} bytes`)
    }
    return text
  }

  /**
   * 读缓存文件与 mtime。任何失败（不存在、不可读）都返回 undefined——
   * 对调用方而言"没有缓存"和"缓存坏了"走同一条回退路径，无需区分。
   * file:// 源没有缓存概念，直接 undefined。
   */
  private async readCache(): Promise<{ text: string; mtimeMs: number } | undefined> {
    if (this.config.sourceUrl.startsWith('file://')) return undefined
    try {
      const [text, info] = await Promise.all([
        readFile(this.config.cachePath, 'utf8'),
        stat(this.config.cachePath),
      ])
      return { text, mtimeMs: info.mtimeMs }
    } catch {
      // ENOENT（尚无缓存）与读取失败共用同一路径：回退去拉取源
      return undefined
    }
  }
}
