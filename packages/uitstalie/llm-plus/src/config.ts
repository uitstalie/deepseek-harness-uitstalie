/**
 * llm-plus 的配置形状与解析。
 *
 * 核心设计：**路由是声明出来的**——每条路由显式写明协议、端点、凭据引用
 * （credentials seam 的键），不做任何按 URL 的猜测（pi-ai 的 compat 门禁
 * 系统就是猜测失败的代价；我们拥有协议实现，配置面只需要这几个字段）。
 *
 * Config schema 是结构化的（不是 dict(any)）：原生 Models 设置页的
 * ProviderEditor 按 schema 渲染编辑表单（参照 llm-pi-ai 的 profile 形状；
 * `role('credential-ref')` 让凭据字段渲染成凭据选择器）。resolveRoutes 的
 * 手工校验保留——它给出带路由名的精确错误，比 schema 的通用 issues 更可行动。
 *
 * @module @deepseek-ai/dsh-llm-plus/config
 */

import z from '@deepseek-ai/schemastery'
import { resolveRetryPolicy, RetryPolicySchema, type ResolvedRetryPolicy, type RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-models-dev'
import { OAUTH_FLOW_IDS } from './oauth/index.ts'

/** OAuth flow id 的封闭联合（与 schema 的 z.const 表一一对应）。 */
export type OAuthFlowId = 'anthropic' | 'openai-codex' | 'github-copilot' | 'openrouter' | 'kimi-coding' | 'xai'

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
  /** 展示名（选择器与原生设置页用）；缺省用路由 id。 */
  displayName?: string
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
  /**
   * OAuth 登录流 id（oauth/ 目录的六家：anthropic/openai-codex/github-copilot/
   * openrouter/kimi-coding/xai）。与 apiKeyRef 并列的凭据来源：
   * apiKeyRef 命中时覆盖 OAuth grant；grant 缺失/判死时报可行动的重登错误。
   */
  oauth?: OAuthFlowId
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
  /** 该路由的重试策略（llm-retry 消费；注册时被 registry 捕获，热更新随 registration.replace 重读）。 */
  retryPolicy?: RetryPolicyConfig
  /**
   * 图片请求投影策略（attachment seam 的 readImageRequest 原语）：
   * maxPixels = 像素预算（保宽高比缩放）、maxBytes = 编码字节目标
   * （质量阶梯压到目标内）。缺席 = 读原始字节不投影。
   */
  requestImagePolicy?: { maxPixels: number; maxBytes: number } | undefined
}

/** 插件配置。 */
export interface PlusConfig {
  /** 路由表：routeId → 配置。routeId 即 GenerateOptions.provider 的值。 */
  routes: Record<string, RouteConfig>
}

/**
 * 单个手工模型条目的 schema（原生设置页编辑器按此渲染字段）。
 * 缺省字段不物化（参照 pi-ai：缺席 = 未知，由目录数据兜底）。
 */
const modelEntrySchema = z.object({
  id: z.string().required(),
  name: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  inputModalities: z.array(z.string()),
  reasoningEfforts: z.array(z.string()),
})

/**
 * 单条路由的 schema。`role('credential-ref')` 是原生编辑器渲染凭据
 * 选择器的约定（与 llm-pi-ai 的 apiKeyEnv 同款）；protocol 是封闭枚举。
 */
const routeSchema = z.object({
  protocol: z.union([
    z.const('openai-completions'),
    z.const('openai-responses'),
    z.const('anthropic-messages'),
    z.const('gemini'),
  ]).required(),
  displayName: z.string(),
  baseURL: z.string(),
  apiKeyRef: z.string().role('credential-ref'),
  oauth: z.union([
    z.const('anthropic'),
    z.const('openai-codex'),
    z.const('github-copilot'),
    z.const('openrouter'),
    z.const('kimi-coding'),
    z.const('xai'),
  ]),
  modelsDevProvider: z.string(),
  models: z.array(modelEntrySchema),
  headers: z.dict(z.string()),
  body: z.dict(z.any()),
  defaultMaxTokens: z.number().step(1).min(1),
  retryPolicy: RetryPolicySchema,
  // schemastery 会把缺席的嵌套对象物化为 {} 再撞内部 required，
  // 显式 union undefined 让"缺席"合法（有值时两字段必填）
  requestImagePolicy: z.union([
    z.object({
      maxPixels: z.number().step(1).min(1).required(),
      maxBytes: z.number().step(1).min(1).required(),
    }),
    z.const(undefined),
  ]),
})

/**
 * 配置 schema。结构化形状既是设置写入点的校验，也是原生 ProviderEditor
 * 的渲染依据；resolveRoutes 的手工校验在其后给出带路由名的精确错误。
 */
export const Config: z<PlusConfig> = z.object({
  routes: z.dict(routeSchema).required(),
})

/**
 * 解析后的路由（构造期完成全部校验与默认值物化，请求期零判断）。
 * 注意凭据不在这里物化：每请求经 credentials seam 解析，轮换立即生效——
 * 这是 harness 凭据契约的语义。
 */
export interface ResolvedRoute {
  /** 路由 id（= provider 路由名）。 */
  id: string
  protocol: ProtocolName
  /** 展示名（缺省物化为路由 id）。 */
  displayName: string
  /** 已物化的端点（配置值或协议默认）。 */
  baseURL: string
  /** 凭据引用名（credentials seam 的键）；免认证路由缺席。 */
  apiKeyRef?: string
  /** OAuth 登录流 id（已校验在 OAUTH_PROVIDERS 表内）；缺席 = 不走 OAuth。 */
  oauth?: string
  modelsDevProvider?: string
  models?: ModelEntryConfig[]
  /** 合并后的路由级额外头（请求期只需照抄）。 */
  headers: Record<string, string>
  /** 合并前的路由级额外 body 字段（请求期还要再叠目录 extraParams）。 */
  body: Record<string, JsonValue>
  defaultMaxTokens?: number
  /** 已解析的重试策略（构造期完成解析，非法值在激活点 fail loud）。 */
  retryPolicy?: ResolvedRetryPolicy
  /** 图片投影策略（请求期经 readImageRequest 强制；缺席不投影）。 */
  requestImagePolicy?: { maxPixels: number; maxBytes: number }
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
    if (route.oauth !== undefined && !OAUTH_FLOW_IDS.includes(route.oauth)) {
      throw new Error(`llm-plus: route ${JSON.stringify(id)} has unknown oauth flow ${JSON.stringify(route.oauth)} (expect one of ${OAUTH_FLOW_IDS.join(', ')})`)
    }
    const baseURL = route.baseURL ?? PROTOCOL_DEFAULT_BASE_URL[route.protocol]
    return {
      id,
      protocol: route.protocol,
      displayName: route.displayName ?? id,
      baseURL,
      ...(route.apiKeyRef === undefined ? {} : { apiKeyRef: route.apiKeyRef }),
      ...(route.oauth === undefined ? {} : { oauth: route.oauth }),
      ...(route.modelsDevProvider === undefined ? {} : { modelsDevProvider: route.modelsDevProvider }),
      // schema 会把缺席的数组物化为 []（schemastery 的默认行为）——空数组
      // 按"未提供"归一化（与 pi-ai 同语义），否则空手工表会遮蔽目录数据
      ...(route.models === undefined || route.models.length === 0 ? {} : { models: route.models }),
      headers: { ...route.headers },
      body: { ...route.body },
      ...(route.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: route.defaultMaxTokens }),
      // 重试策略在构造期解析：非法值在激活点带路由名 fail loud（请求期零判断）
      ...(route.retryPolicy === undefined ? {} : { retryPolicy: resolveRetryPolicy(route.retryPolicy, `llm-plus: route ${JSON.stringify(id)} retryPolicy`) }),
      ...(route.requestImagePolicy === undefined ? {} : { requestImagePolicy: route.requestImagePolicy }),
    }
  })
}
