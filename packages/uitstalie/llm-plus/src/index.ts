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
 *   条目（settingsNs/settingsPath 指向 llm-plus 命名空间的路由对象），并
 *   注册该命名空间的模型发现 handler——原生 Models 设置页据此列出、编辑
 *   （ProviderEditor 按 route schema 渲染）并发现本插件的路由；
 * - settings 动态化：经 installSettingsSection 把 cordis.yml 的 config 作为
 *   base 层注册进 `llm-plus` 命名空间，用户层变更时重新解析路由并
 *   原子替换注册（registration.replace + adapter.updateRoutes +
 *   directory.replace）；settings 服务缺席时该接线保持休眠，路由表就等于
 *   cordis.yml 配置。
 *
 * 依赖：inject ['llm', 'credentials']（凭据解析是 credentials seam 唯一
 * 路径——本插件不读 process.env，环境变量兜底是 credentials provider
 * 自己的分层职责）。modelsDev / attachments 走可选 ctx.get 读取。
 *
 * @module @deepseek-ai/dsh-llm-plus
 */

import { Context } from '@deepseek-ai/cordis'
import {
  LlmError,
  type LlmConfigurableProvider,
  type LlmDiscoveredModel,
  type LlmModelDiscoveryRequest,
} from '@deepseek-ai/dsh-llm'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { PlusAdapter } from './adapter.ts'
import { Config, PROTOCOL_NAMES, resolveRoutes, type PlusConfig, type ProtocolName, type ResolvedRoute } from './config.ts'
import { registerOAuthFlows } from './oauth/index.ts'
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

/** settings 命名空间（用户层覆盖 cordis.yml 的 routes 表）。 */
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
 * settingsPath 指向 llm-plus 命名空间里的路由对象——原生 ProviderEditor
 * 编辑的就是这个地址的配置（schema 见 config.ts 的 routeSchema）。
 * 本插件的路由全部来自配置（没有出厂自带的路由），declared 恒为 true。
 */
function directoryEntries(routes: readonly ResolvedRoute[]): LlmConfigurableProvider[] {
  return routes.map(route => ({
    provider: route.id,
    displayName: route.displayName,
    settingsNs: SETTINGS_NS,
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
 * 接线说明：installSettingsSection 内部用 ctx.inject(['settings'], …)，
 * settings 服务不存在时整个接线休眠（组合里没有 settings 的 composition
 * 即纯 cordis.yml 配置）。onChange 在 attach/变更/detach 时都会触发，
 * 每次重新解析当前生效源并原子替换；非法配置由 installSettingsSection
 * 的 validate 在写入点拒绝，onChange 读到的必是合法形状。
 */
export function apply(ctx: Context, config: PlusConfig): void {
  const catalog = ctx.get('modelsDev', false)
  const attachments = ctx.get('attachments', false)
  const adapter = new PlusAdapter(resolveRoutes(config.routes), {
    ...(catalog === undefined ? {} : { catalog }),
    credentials: ctx.credentials,
    ...(attachments === undefined ? {} : { attachments }),
    // replay 降级告警走宿主 logger（对齐 pi-ai 的 onReplayDegrade 可观测性）
    warn: message => ctx.logger.warn(message),
  })

  // 注册 handle 持有当前路由集；replace 在同一 adapter 实例上原子换路由。
  // 三个注册都经服务代理绑到本 fiber（参照 llm-deepseek 的裸调），fiber
  // 卸载时自动摘除
  const registration = ctx.llm.registerAdapter(adapter.routeIds(), adapter)
  ctx.effect(() => registration, 'llm-plus.registerAdapter')
  const directory = ctx.llm.registerConfigurableProviders(directoryEntries(adapter.resolvedRoutes()))
  ctx.llm.registerModelDiscovery(SETTINGS_NS, (request, signal) => discover(adapter, request, signal))
  // OAuth 登录流：authorization 缝缺席的组合里整体休眠（纯 apiKeyRef 工作）；
  // 路由集变化时增量同步（sync 返回函数在缝缺席时为空转）
  let routesNow = adapter.resolvedRoutes()
  const syncOAuthFlows = registerOAuthFlows(
    ctx,
    routesNow.filter(route => route.oauth !== undefined).map(route => route.id),
    routeId => routesNow.find(route => route.id === routeId)?.oauth,
  )

  // 当前生效的路由表来源（settings 层或 cordis.yml 配置）。
  // 契约（对齐 llm-deepseek）：setSource 给的是** thunk**——存起来在
  // onChange 里现取；在 setSource 调用点求值会把它冻结成 attach 时的
  // 旧值，之后用户层变更就永远读不到（这正是 kimi 路由不生效的 bug）
  let current: () => PlusConfig = () => config
  installSettingsSection(ctx, settingsNamespace(SETTINGS_NS), Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: () => {
      const routes = resolveRoutes(current().routes)
      adapter.updateRoutes(routes)
      registration.replace(routes.map(route => route.id))
      directory.replace(directoryEntries(routes))
      routesNow = routes
      syncOAuthFlows(routes.filter(route => route.oauth !== undefined).map(route => route.id))
    },
  })
}
