/**
 * Draft shape and pure mapping functions for editing "my routes" (data/logic separation).
 * RouteDraft carries everything in the edit form; draftToRoute materializes it back into
 * the llm-plus route configuration (empty strings are always absent — schema defaults and
 * protocol default endpoints take over).
 *
 * @module @deepseek-ai/dsh-client-ui-models-dev/route-edit
 */

import type { JsonValue } from '@deepseek-ai/dsh-models-dev'
import type { OAuthFlowId, ProtocolName, RouteConfig } from '@deepseek-ai/dsh-llm-plus'
import { parseJsonObjectField } from './draft.ts'

/** Route edit draft (the complete carrier of the edit form; empty text field = absent). */
export interface RouteDraft {
  /** Display name. */
  displayName: string
  /** Wire protocol. */
  protocol: ProtocolName
  /** baseURL (empty = the protocol default endpoint). */
  baseURL: string
  /** Credential reference name (empty = no apiKeyRef). */
  apiKeyRef: string
  /** OAuth flow id (empty = no OAuth). */
  oauth: OAuthFlowId | ''
  /** Extra request headers (JSON object text). */
  headersText: string
  /** Extra top-level request body fields (JSON object text). */
  bodyText: string
  /** Default max output tokens (empty = absent). */
  defaultMaxTokensText: string
}

/** OAuth flow options (matching the six in llm-plus; '' = no OAuth). */
export const OAUTH_FLOW_CHOICES: readonly OAuthFlowId[] = ['anthropic', 'openai-codex', 'github-copilot', 'openrouter', 'kimi-coding', 'xai']

/**
 * Route configuration → edit draft (models/modelsDevProvider are outside the v1 edit surface and are kept as-is, not lost).
 * @param route - the current effective route configuration.
 * @returns the edit draft for that route.
 */
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

/**
 * Draft validation: returns the location key of the first error; undefined when valid.
 * @param draft - the route draft being saved.
 * @returns the location key of the first invalid field; undefined when all fields are valid.
 */
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
 * Materialize the draft into a route configuration. Fields outside the edit surface (models/modelsDevProvider/
 * retryPolicy/requestImagePolicy) are carried back as-is from the original route by the caller (see the call site).
 * @param draft - the route draft in the edit form.
 * @returns the route value written into the llm-plus namespace.
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
