/**
 * models.dev 设置页的草稿数据形状与物化纯函数。
 *
 * 数据/逻辑分离：本文件只放有名字的纯数据接口和纯函数——
 * ProviderDraft（用户在页面上编辑的一切）→ materializeRoutes（写成
 * llm-plus 命名空间 routes 的成品配置）。组件与 store 只读写这些数据。
 *
 * @module @deepseek-ai/dsh-client-ui-models-dev/draft
 */

import type { CatalogModelSummary, CatalogProviderSummary } from '@deepseek-ai/dsh-models-dev/types'
import type { JsonValue } from '@deepseek-ai/dsh-models-dev'
import type { OAuthFlowId, ProtocolName } from '@deepseek-ai/dsh-llm-plus'

/**
 * 目录 provider id → llm-plus OAuth flow 的映射（显式数据表）。
 * 只有"目录 id 与 flow id 指向同一订阅产品"的才进表——openai 不映射
 * （models.dev 的 openai 是 API 平台，openai-codex 是 ChatGPT 订阅，两家产品）。
 */
export const OAUTH_BY_CATALOG_ID: Readonly<Record<string, OAuthFlowId>> = {
  anthropic: 'anthropic',
  'kimi-for-coding': 'kimi-coding',
  'github-copilot': 'github-copilot',
  openrouter: 'openrouter',
  xai: 'xai',
}

/** 模型子集模式：all = 路由跟随目录（不写 models 手工表）；subset = 物化勾选子集。 */
export type ModelMode = 'all' | 'subset'

/**
 * 一个提供商的物化草稿（页面编辑状态的完整载体）。
 * 字符串字段允许为空——空在物化时按"缺席"处理（schema 缺省值接管）。
 */
export interface ProviderDraft {
  /** 路由 id（GenerateOptions.provider 的值）；默认 provider id 净化。 */
  routeId: string
  /** 展示名；默认目录 name ?? id。 */
  displayName: string
  /** wire 协议；'' = 未选（目录方言无法映射时由用户手选）。 */
  protocol: ProtocolName | ''
  /** baseURL；默认目录 api 字段；空 = 用协议默认端点。 */
  baseURL: string
  /** 凭据引用名；默认目录 env[0]；空 = 免认证路由。 */
  apiKeyRef: string
  /** OAuth 登录流 id；默认目录映射表（OAUTH_BY_CATALOG_ID），'' = 不走 OAuth。 */
  oauth: OAuthFlowId | ''
  /** 一次性密钥：确认时经 credentials.set 写入凭据库，本字段不持久化。 */
  apiKey: string
  /** 额外请求头（JSON 对象文本；'' = 无）。 */
  headersText: string
  /** 额外请求体顶层字段（JSON 对象文本；'' = 无）。 */
  bodyText: string
  /** 模型子集模式。 */
  modelMode: ModelMode
  /** subset 模式下勾选的模型 id 集（默认全选）。 */
  modelIds: readonly string[]
}

/** models.dev 的 npm 方言 → llm-plus 协议（映射不上的返回 '' 由用户手选）。 */
export function defaultProtocol(npm: string | undefined): ProtocolName | '' {
  if (npm === undefined) return ''
  if (npm.includes('anthropic')) return 'anthropic-messages'
  if (npm.includes('google')) return 'gemini'
  // openai-compatible（约 80%）与 openai 都按 Chat Completions 方言
  if (npm.includes('openai')) return 'openai-completions'
  return ''
}

/** 路由 id 净化：小写字母/数字/连字符，其余折叠为连字符（POSIX 标识符风格）。 */
export function sanitizeRouteId(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/** 为一个提供商生成初始草稿（全部默认值就位，用户只需勾选+填密钥）。 */
export function defaultDraft(provider: CatalogProviderSummary): ProviderDraft {
  return {
    routeId: sanitizeRouteId(provider.id),
    displayName: provider.name ?? provider.id,
    protocol: defaultProtocol(provider.npm),
    baseURL: provider.api ?? '',
    apiKeyRef: provider.env?.[0] ?? '',
    oauth: OAUTH_BY_CATALOG_ID[provider.id] ?? '',
    apiKey: '',
    headersText: '',
    bodyText: '',
    modelMode: 'all',
    modelIds: [],
  }
}

/** 解析 JSON 对象文本字段；空文本返回 undefined，非对象抛错（由调用方归一化文案）。 */
export function parseJsonObjectField(text: string): Record<string, JsonValue> | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  const value: unknown = JSON.parse(trimmed)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('not an object')
  }
  return value as Record<string, JsonValue>
}

/**
 * 物化一条路由配置（写进 llm-plus 命名空间 routes.<routeId> 的值）。
 * 空字符串字段一律缺席——由 route schema 的缺省与协议默认端点接管；
 * subset 模式把勾选的目录模型物化为手工 models 表（整体覆盖目录数据）。
 * @param providerId - 目录 provider id（modelsDevProvider 字段：路由与目录的链接）。
 */
export function materializeRoute(
  providerId: string,
  draft: ProviderDraft,
  models: readonly CatalogModelSummary[],
): JsonValue {
  const route: Record<string, JsonValue> = {
    protocol: draft.protocol,
    modelsDevProvider: providerId,
  }
  if (draft.displayName.trim() !== '') route.displayName = draft.displayName.trim()
  if (draft.baseURL.trim() !== '') route.baseURL = draft.baseURL.trim()
  if (draft.apiKeyRef.trim() !== '') route.apiKeyRef = draft.apiKeyRef.trim()
  if (draft.oauth !== '') route.oauth = draft.oauth
  const headers = parseJsonObjectField(draft.headersText)
  if (headers !== undefined) route.headers = headers
  const body = parseJsonObjectField(draft.bodyText)
  if (body !== undefined) route.body = body
  if (draft.modelMode === 'subset' && draft.modelIds.length > 0) {
    route.models = models
      .filter(model => draft.modelIds.includes(model.id))
      .map(model => ({
        id: model.id,
        ...(model.name === undefined ? {} : { name: model.name }),
        ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
        ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
        ...(model.inputModalities === undefined ? {} : { inputModalities: model.inputModalities }),
      }))
  }
  return route
}

/** 草稿校验：返回首个错误的定位键（由调用方映射文案）；通过返回 undefined。 */
export function draftError(draft: ProviderDraft): 'protocol' | 'headers' | 'body' | undefined {
  if (draft.protocol === '') return 'protocol'
  try {
    parseJsonObjectField(draft.headersText)
  } catch {
    return 'headers'
  }
  try {
    parseJsonObjectField(draft.bodyText)
  } catch {
    return 'body'
  }
  return undefined
}
