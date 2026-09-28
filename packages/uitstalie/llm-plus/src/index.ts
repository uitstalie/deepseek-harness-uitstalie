/**
 * llm-plus 插件入口：自有多协议 LLM 适配器。
 *
 * 函数插件形态（name/inject/Config/apply，无默认导出——混入默认导出会让
 * Loader 丢弃命名空间，见 docs/postmortem/0001）。
 *
 * 挂载行为：
 * - 解析路由表（结构性错误在此抛错，fiber 进入 FAILED）；
 * - 构造一个 PlusAdapter 并把全部路由注册进 `ctx.llm`（fiber 卸载自动摘除）；
 * - 原生 custom-provider 缝：每条路由注册一条 configurable-provider 目录
 *   条目（settingsNs/settingsPath 指向 profile 条目的 routes 对象），并
 *   注册该命名空间的模型发现 handler——原生 Models 设置页据此列出、编辑
 *   （ProviderEditor 按 route schema 渲染）并发现本插件的路由；
 * - 活配置：`config.routes` 是 volatile 引用，Loader 在只读变更时提交新
 *   快照并 emit `loader/volatile-update`；本插件在该事件里重新解析并原子
 *   替换注册（registration.replace + adapter.updateRoutes + directory.replace）。
 *   `internal/config` 钩子在写入点校验候选（坏路由在提交前被拒）。
 *
 * 依赖：inject ['llm', 'credentials']（凭据解析是 credentials seam 唯一
 * 路径——本插件不读 process.env，环境变量兜底是 credentials provider
 * 自己的分层职责）。modelsDev / attachments / settings 走可选 ctx.get 或
 * 内层 inject 读取。
 *
 * @module @deepseek-ai/dsh-llm-plus
 */

import { Context, type Fiber } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import {
  LlmError,
  type DirectoryRegistrationHandle,
  type LlmConfigurableProvider,
  type LlmDiscoveredModel,
  type LlmModelDiscoveryRequest,
} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import { PlusAdapter } from './adapter.ts'
import { Config, PROTOCOL_NAMES, resolveRoutes, type PlusConfig, type PlusOptions, type ProtocolName, type ResolvedRoute, type RouteConfig } from './config.ts'
import { registerOAuthFlows } from './oauth/index.ts'
import { PlusAuthRemote } from './remote.ts'
import { openAiCompletions } from './protocols/openai-completions.ts'
import { openAiResponses } from './protocols/openai-responses.ts'
import { anthropicMessages } from './protocols/anthropic-messages.ts'
import { gemini } from './protocols/gemini.ts'
import type { Protocol } from './protocol.ts'

export type * from './config.ts'
export { PlusAdapter } from './adapter.ts'

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'llm-plus'

/** 注册路由需要 llm；凭据解析的唯一路径是 credentials seam。 */
export const inject = ['llm', 'credentials']

/** 程序化挂载（没有 profile 条目）时使用的命名空间。 */
export const SETTINGS_NS = 'llm-plus'

export { Config }

/** 协议名 → 实现实例（发现模型用；与 adapter.ts 的表是同一份字面量）。 */
const PROTOCOLS: Record<ProtocolName, Protocol> = {
  'openai-completions': openAiCompletions,
  'openai-responses': openAiResponses,
  'anthropic-messages': anthropicMessages,
  'gemini': gemini,
}

/**
 * 把解析后的路由表映射为 configurable-provider 目录条目。
 * settingsPath 指向 profile 条目 config 里的路由对象——原生 ProviderEditor
 * 编辑的就是这个地址的配置（schema 见 config.ts 的 routeSchema）。
 * 本插件的路由全部来自配置（没有出厂自带的路由），declared 恒为 true。
 */
function directoryEntries(routes: readonly ResolvedRoute[], settingsNs: string): LlmConfigurableProvider[] {
  return routes.map(route => ({
    provider: route.id,
    displayName: route.displayName,
    settingsNs,
    settingsPath: ['routes', route.id],
    declared: true,
  }))
}

/**
 * 模型发现 handler（原生设置页"发现模型"按钮 → llm/discoverModels → 这里）。
 * 两个分支：
 * - 草稿指名了已有路由（request.provider）→ 用 adapter 自己的知识回答
 *   （手工 models 或 models.dev 目录），零网络——契约明确这是更好的答案；
 * - 否则按草稿的协议 + 端点 + 一次性凭据问端点（协议实现的 discoverModels）。
 */
async function discover(
  adapter: PlusAdapter,
  request: LlmModelDiscoveryRequest,
  signal?: AbortSignal,
): Promise<readonly LlmDiscoveredModel[]> {
  if (request.provider !== undefined) {
    const models = await adapter.listModels(request.provider)
    return models.map(model => ({ id: model.id, name: model.name }))
  }
  if (request.baseURL === undefined) {
    throw new LlmError('llm-plus: model discovery needs a provider route or a baseURL', 'INVALID_DISCOVERY')
  }
  if (request.api !== undefined && !(PROTOCOL_NAMES as readonly string[]).includes(request.api)) {
    throw new LlmError(`llm-plus: unknown discovery protocol ${JSON.stringify(request.api)} (expect one of ${PROTOCOL_NAMES.join(', ')})`, 'INVALID_DISCOVERY')
  }
  // 草稿没写协议时按 openai-completions 处理（models.dev 里约 80% 的方言）
  const protocol = PROTOCOLS[(request.api ?? 'openai-completions') as ProtocolName]
  if (protocol.discoverModels === undefined) {
    throw new LlmError(`llm-plus: protocol ${request.api} has no model listing endpoint`, 'INVALID_DISCOVERY')
  }
  return protocol.discoverModels(request.baseURL, request.apiKey, signal)
}

/**
 * 挂载适配器。
 *
 * 接线说明（profile 拥有活配置）：路由表就是本条目的 Config，设置页的
 * 编辑写进 profile 的 `config`。`routes` 是 volatile 引用，Loader 只提交
 * 新快照并 emit `loader/volatile-update`，本实例不重挂——sync() 是那次
 * 提交的唯一消费点，重新解析并原子替换注册。`internal/config` 钩子在
 * 写入点校验候选：非法路由在提交前 fail loud，sync() 读到的必是合法形状。
 */
export function apply(ctx: Context, config: PlusConfig): void {
  // 本实例的页面策略：models-dev 页面自带 llm-plus 路由编辑区，抑制
  // 自动生成的表单；settings 服务缺席的组合（纯 cordis.yml）保持休眠
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })
  // 设置地址是 profile 条目 id（设置页按条目寻址）；程序化挂载退回插件名
  const settingsNs = ctx.fiber.entry?.options.id ?? SETTINGS_NS
  /**
   * 当前生效的路由表。每次现读 `config.routes.get()`——在挂接点求值会把
   * 它冻结成挂载时的旧快照，之后配置变更就永远读不到（这正是 kimi 路由
   * 不生效的 bug）。引用本身的类型是深度只读快照，解析器按可变普通数据
   * 处理它：解析过程只读字段并构造自己的对象，快照的不可变性由 Loader 保证。
   */
  const currentRoutes = (): Record<string, RouteConfig> =>
    config.routes.get() as Record<string, RouteConfig>
  const catalog = ctx.get('modelsDev', false)
  const attachments = ctx.get('attachments', false)
  const adapter = new PlusAdapter(resolveRoutes(currentRoutes()), {
    ...(catalog === undefined ? {} : { catalog }),
    credentials: ctx.credentials,
    ...(attachments === undefined ? {} : { attachments }),
    // replay 降级告警走宿主 logger（对齐 pi-ai 的 onReplayDegrade 可观测性）
    warn: message => ctx.logger.warn(message),
  })

  // 路由注册是惰性的：registerAdapter 的空初始集会抛，但注册后的
  // replace([]) 合法——所以零路由组合（纯目录/纯页面驱动）也能挂载，
  // 首个路由出现时注册，清空时留在注册表持零路由
  let registration: ReturnType<Context['llm']['registerAdapter']> | undefined
  const syncRegistration = (routes: readonly ResolvedRoute[]): void => {
    const ids = routes.map(route => route.id)
    if (registration === undefined) {
      if (ids.length === 0) return
      registration = ctx.llm.registerAdapter(ids, adapter)
    } else {
      registration.replace(ids)
    }
  }
  ctx.effect(() => () => registration?.(), 'llm-plus.registerAdapter')
  // 目录条目同样惰性：registerConfigurableProviders 空初始集抛、replace([])
  // 合法——与路由注册同一条惰性路径（两个注册都在 sync 里经同一闭包
  // ctx 调用，绑定的仍是本 fiber）
  let directory: DirectoryRegistrationHandle | undefined
  const syncDirectory = (routes: readonly ResolvedRoute[]): void => {
    const entries = directoryEntries(routes, settingsNs)
    if (directory === undefined) {
      if (entries.length === 0) return
      directory = ctx.llm.registerConfigurableProviders(entries)
    } else {
      directory.replace(entries)
    }
  }
  ctx.llm.registerModelDiscovery(settingsNs, (request, signal) => discover(adapter, request, signal))
  // OAuth 登录流：authorization 缝缺席的组合里整体休眠（纯 apiKeyRef 工作）；
  // 路由集变化时增量同步（sync 返回函数在缝缺席时为空转）
  let routesNow = adapter.resolvedRoutes()
  const syncOAuthFlows = registerOAuthFlows(
    ctx,
    routesNow.filter(route => route.oauth !== undefined).map(route => route.id),
    routeId => routesNow.find(route => route.id === routeId)?.oauth,
  )
  // OAuth 的 Remote 面（设置页的登录按钮读它）；routesNow 闭包热更新后现读
  new PlusAuthRemote(ctx, () => routesNow)

  /**
   * 把当前配置引用同步成生效状态：解析路由表并原子替换注册。
   */
  const sync = (): void => {
    const routes = resolveRoutes(currentRoutes())
    adapter.updateRoutes(routes)
    syncRegistration(routes)
    syncDirectory(routes)
    routesNow = routes
    syncOAuthFlows(routes.filter(route => route.oauth !== undefined).map(route => route.id))
  }
  sync()

  // 写入点校验：schema 之外的结构性错误（空模型 id 等）连同带路由名的
  // 精确错误一起在提交前拒绝，坏配置不会进 profile
  ctx.on('internal/config', function (this: Fiber, _raw: unknown, next: () => unknown) {
    const raw: unknown = next()
    if (this !== ctx.fiber) return raw
    const candidate = Config(raw as PlusOptions)
    resolveRoutes(candidate.routes.get() as Record<string, RouteConfig>)
    return raw
  })
  ctx.on('loader/volatile-update', () => {
    try {
      sync()
    } catch (error: unknown) {
      ctx.logger.error(`llm-plus: routing table entry ${JSON.stringify(settingsNs)} was rejected`)
      ctx.logger.error(error)
    }
  })
}
