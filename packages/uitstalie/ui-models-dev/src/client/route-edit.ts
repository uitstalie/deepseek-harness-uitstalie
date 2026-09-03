/**
 * "我的路由"编辑的草稿形状与映射纯函数（数据/逻辑分离）。
 * RouteDraft 承载编辑表单的一切；draftToRoute 物化回 llm-plus 路由配置
 * （空串一律缺席——schema 缺省与协议默认端点接管）。
 *
 * @module @deepseek-ai/dsh-client-ui-models-dev/route-edit
 */

import type { JsonValue } from '@deepseek-ai/dsh-models-dev'
import type { OAuthFlowId, ProtocolName, RouteConfig } from '@deepseek-ai/dsh-llm-plus'
import { parseJsonObjectField } from './draft.ts'

/** 路由编辑草稿（编辑表单的完整载体；文本字段空串 = 缺席）。 */
export interface RouteDraft {
  /** 展示名。 */
  displayName: string
  /** wire 协议。 */
  protocol: ProtocolName
  /** baseURL（空 = 协议默认端点）。 */
  baseURL: string
  /** 凭据引用名（空 = 不走 apiKeyRef）。 */
  apiKeyRef: string
  /** OAuth flow id（空 = 不走 OAuth）。 */
  oauth: OAuthFlowId | ''
  /** 额外请求头（JSON 对象文本）。 */
  headersText: string
  /** 额外请求体顶层字段（JSON 对象文本）。 */
  bodyText: string
  /** 默认最大输出 token（空 = 缺席）。 */
  defaultMaxTokensText: string
}

/** OAuth flow 选项（与 llm-plus 的六家一致；'' = 不走 OAuth）。 */
export const OAUTH_FLOW_CHOICES: readonly OAuthFlowId[] = ['anthropic', 'openai-codex', 'github-copilot', 'openrouter', 'kimi-coding', 'xai']

/** 路由配置 → 编辑草稿（models/modelsDevProvider 不在 v1 编辑面内，原样保留不丢）。 */
export function routeToDraft(route: RouteConfig): RouteDraft {
  return {
    displayName: route.displayName ?? '',
    protocol: route.protocol,
    baseURL: route.baseURL ?? '',
    apiKeyRef: route.apiKeyRef ?? '',
    oauth: route.oauth ?? '',
    headersText: route.headers === undefined || Object.keys(route.headers).length === 0 ? '' : JSON.stringify(route.headers, null, 2),
    bodyText: route.body === undefined || Object.keys(route.body).length === 0 ? '' : JSON.stringify(route.body, null, 2),
    defaultMaxTokensText: route.defaultMaxTokens === undefined ? '' : String(route.defaultMaxTokens),
  }
}

/** 草稿校验：返回首个错误的定位键；通过返回 undefined。 */
export function routeDraftError(draft: RouteDraft): 'headers' | 'body' | 'maxTokens' | undefined {
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
  if (draft.defaultMaxTokensText.trim() !== '') {
    const value = Number(draft.defaultMaxTokensText)
    if (!Number.isInteger(value) || value <= 0) return 'maxTokens'
  }
  return undefined
}

/**
 * 草稿物化为路由配置。不在编辑面内的字段（models/modelsDevProvider/
 * retryPolicy/requestImagePolicy）由调用方从原路由原样带回（见调用点）。
 */
export function draftToRoute(draft: RouteDraft): Record<string, JsonValue> {
  const route: Record<string, JsonValue> = { protocol: draft.protocol }
  if (draft.displayName.trim() !== '') route.displayName = draft.displayName.trim()
  if (draft.baseURL.trim() !== '') route.baseURL = draft.baseURL.trim()
  if (draft.apiKeyRef.trim() !== '') route.apiKeyRef = draft.apiKeyRef.trim()
  if (draft.oauth !== '') route.oauth = draft.oauth
  const headers = parseJsonObjectField(draft.headersText)
  if (headers !== undefined) route.headers = headers
  const body = parseJsonObjectField(draft.bodyText)
  if (body !== undefined) route.body = body
  if (draft.defaultMaxTokensText.trim() !== '') route.defaultMaxTokens = Number(draft.defaultMaxTokensText)
  return route
}
