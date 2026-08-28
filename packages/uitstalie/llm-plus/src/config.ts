/**
 * llm-plus 的配置形状与解析。
 *
 * 核心设计：**路由是声明出来的**——每条路由显式写明协议、端点、凭据引用
 * （credentials seam 的键），不做任何按 URL 的猜测（pi-ai 的 compat 门禁
 * 系统就是猜测失败的代价；我们拥有协议实现，配置面只需要这几个字段）。
 *
 * @module @deepseek-ai/dsh-llm-plus/config
 */

import type { JsonValue } from '@deepseek-ai/dsh-models-dev'

/** 支持的 wire 协议名（与 protocols/ 下的实现一一对应）。 */
export type ProtocolName = 'openai-completions' | 'openai-responses' | 'anthropic-messages' | 'gemini'

/** 协议名集合（配置校验用）。 */
export const PROTOCOL_NAMES: readonly ProtocolName[] = ['openai-completions', 'openai-responses', 'anthropic-messages', 'gemini']

/** 协议级默认端点（route 不写 baseURL 时用）。 */
export const PROTOCOL_DEFAULT_BASE_URL: Record<ProtocolName, string> = {
  'openai-completions': 'https://api.openai.com/v1',
  'openai-responses': 'https://api.openai.com/v1',
  'anthropic-messages': 'https://api.anthropic.com',
  'gemini': 'https://generativelanguage.googleapis.com',
}

/** 手工声明的一个模型条目（不开 models-dev 目录时的最小形态）。 */
export interface ModelEntryConfig {
  /** 模型 id（请求里的 model 字段值）。 */
  id: string
  /** 显示名；缺省用 id。 */
  name?: string
  /** 上下文窗口（token）。 */
  contextWindow?: number
  /** 默认最大输出 token。 */
  maxTokens?: number
  /** 输入模态（如 ["text","image"]）。 */
  inputModalities?: string[]
  /** reasoning effort 档位枚举（UI 选择器用）。 */
  reasoningEfforts?: string[]
}

/** 单条路由的用户配置。 */
export interface RouteConfig {
  /** wire 协议（必填，显式选择）。 */
  protocol: ProtocolName
  /** API 端点；缺省用协议默认端点。 */
  baseURL?: string
  /**
   * API key 的凭据引用名（POSIX 标识符形状，如 DEEPSEEK_API_KEY）。
   * **唯一**解析路径是 credentials seam（ctx.credentials.resolve）——
   * 环境变量/`.env` 的兜底是 credentials provider 自己的分层职责
   * （credentials-local 的启动快照 > 存储文件 > .env），本插件不直接
   * 读 process.env。凭据缺失在请求点以可行动的 AUTH 错误报出。
   * OAuth（PKCE 登录流）按协议/provider 后续加入。
   */
  apiKeyRef?: string
  /** models.dev 的 provider id：给出即接入动态目录（模型列表/容量/价格）。 */
  modelsDevProvider?: string
  /** 手工模型表；与 modelsDevProvider 并存时**整体覆盖**目录数据。 */
  models?: ModelEntryConfig[]
  /** 路由级额外请求头（对每个请求生效；与 modelsDev extraParams 合并，本表取胜）。 */
  headers?: Record<string, string>
  /** 路由级额外请求体顶层字段（同上）。 */
  body?: Record<string, JsonValue>
  /** 该路由的默认最大输出 token（请求未指定时用）。 */
  defaultMaxTokens?: number
}

/** 插件配置。 */
export interface PlusConfig {
  /** 路由表：routeId → 配置。routeId 即 GenerateOptions.provider 的值。 */
  routes: Record<string, RouteConfig>
}

/**
 * 解析后的路由（构造期完成全部校验与默认值物化，请求期零判断）。
 * 注意凭据不在这里物化：每请求经 credentials seam 解析，轮换立即生效——
 * 这是 harness 凭据契约的语义。
 */
export interface ResolvedRoute {
  /** 路由 id（= provider 路由名）。 */
  id: string
  protocol: ProtocolName
  /** 已物化的端点（配置值或协议默认）。 */
  baseURL: string
  /** 凭据引用名（credentials seam 的键）；免认证路由缺席。 */
  apiKeyRef?: string
  modelsDevProvider?: string
  models?: ModelEntryConfig[]
  /** 合并后的路由级额外头（请求期只需照抄）。 */
  headers: Record<string, string>
  /** 合并前的路由级额外 body 字段（请求期还要再叠目录 extraParams）。 */
  body: Record<string, JsonValue>
  defaultMaxTokens?: number
}

/**
 * 校验并物化路由表。
 *
 * fail loud 策略：结构性错误（未知协议名、routes 非对象表、models 条目
 * 缺 id）在插件激活时抛出，fiber 进入 FAILED。apiKeyRef 指向的凭据缺失
 * **不在**激活期检查——凭据是请求期解析的（可能由 credentials seam 在
 * 运行中补写），缺失时以可行动的 AUTH 错误在请求点报出（与 llm-deepseek
 * 的语义一致）。
 *
 * @param routes - 用户配置的路由表。
 * @returns 解析后的路由数组（序稳定，按配置键序）。
 * @throws {Error} 任一路由配置结构性非法。
 */
export function resolveRoutes(routes: Record<string, RouteConfig>): ResolvedRoute[] {
  if (routes === null || typeof routes !== 'object' || Array.isArray(routes)) {
    throw new Error('llm-plus: routes must be an object keyed by route id')
  }
  return Object.entries(routes).map(([id, route]) => {
    if (route === null || typeof route !== 'object') {
      throw new Error(`llm-plus: route ${JSON.stringify(id)} must be an object`)
    }
    if (!PROTOCOL_NAMES.includes(route.protocol)) {
      throw new Error(`llm-plus: route ${JSON.stringify(id)} has unknown protocol ${JSON.stringify(route.protocol)} (expect one of ${PROTOCOL_NAMES.join(', ')})`)
    }
    // cordis.yml 是解析边界：models 条目缺 id 会让 listModels 产出坏数据，
    // 在激活点 fail loud（与未知协议同级）
    if (route.models !== undefined) {
      const valid = Array.isArray(route.models)
        && route.models.every(model => model !== null && typeof model === 'object' && typeof model.id === 'string' && model.id.length > 0)
      if (!valid) {
        throw new Error(`llm-plus: route ${JSON.stringify(id)} models must be an array of objects with a non-empty string id`)
      }
    }
    const baseURL = route.baseURL ?? PROTOCOL_DEFAULT_BASE_URL[route.protocol]
    return {
      id,
      protocol: route.protocol,
      baseURL,
      ...(route.apiKeyRef === undefined ? {} : { apiKeyRef: route.apiKeyRef }),
      ...(route.modelsDevProvider === undefined ? {} : { modelsDevProvider: route.modelsDevProvider }),
      ...(route.models === undefined ? {} : { models: route.models }),
      headers: { ...route.headers },
      body: { ...route.body },
      ...(route.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: route.defaultMaxTokens }),
    }
  })
}
