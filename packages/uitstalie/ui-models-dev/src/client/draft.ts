/**
 * Draft data shapes and pure materialization functions for the models.dev settings page.
 *
 * Data/logic separation: this file holds only named pure data interfaces and pure functions —
 * ProviderDraft (everything the user edits on the page) → materializeRoutes (produces the
 * finished configuration written to the llm-plus namespace routes). Components and the store only read and write this data.
 *
 * @module @deepseek-ai/dsh-client-ui-models-dev/draft
 */

import type { CatalogModelSummary, CatalogProviderSummary } from '@deepseek-ai/dsh-models-dev/types'
import type { JsonValue } from '@deepseek-ai/dsh-models-dev'
import type { OAuthFlowId, ProtocolName } from '@deepseek-ai/dsh-llm-plus'

/**
 * Catalog provider id → llm-plus OAuth flow mapping (an explicit data table).
 * Only entries where the catalog id and the flow id point at the same subscription product belong here — openai is
 * not mapped (models.dev's openai is the API platform, openai-codex is the ChatGPT subscription; two products).
 */
export const OAUTH_BY_CATALOG_ID: Readonly<Record<string, OAuthFlowId>> = {
  anthropic: 'anthropic',
  'kimi-for-coding': 'kimi-coding',
  'github-copilot': 'github-copilot',
  openrouter: 'openrouter',
  xai: 'xai',
}

/** Model subset mode: all = routes follow the catalog (no manual models table); subset = materialize the checked subset. */
export type ModelMode = 'all' | 'subset'

/**
 * The materialized draft for one provider (the complete carrier of the page editing state).
 * String fields may be empty — an empty value is treated as "absent" during materialization (schema defaults take over).
 */
export interface ProviderDraft {
  /** Route id (the value of GenerateOptions.provider); sanitized from the provider id by default. */
  routeId: string
  /** Display name; defaults to the catalog name ?? id. */
  displayName: string
  /** Wire protocol; '' = not selected (the user picks it manually when the catalog dialect cannot be mapped). */
  protocol: ProtocolName | ''
  /** baseURL; defaults to the catalog api field; empty = use the protocol default endpoint. */
  baseURL: string
  /** Credential reference name; defaults to the catalog env[0]; empty = an unauthenticated route. */
  apiKeyRef: string
  /** OAuth login flow id; defaults from the catalog mapping table (OAUTH_BY_CATALOG_ID); '' = no OAuth. */
  oauth: OAuthFlowId | ''
  /** One-time secret: written to the credentials store via credentials.set on confirm; this field is not persisted. */
  apiKey: string
  /** Extra request headers (JSON object text; '' = none). */
  headersText: string
  /** Extra top-level request body fields (JSON object text; '' = none). */
  bodyText: string
  /** Model subset mode. */
  modelMode: ModelMode
  /** Model ids checked in subset mode (all selected by default). */
  modelIds: readonly string[]
}

/**
 * models.dev npm dialect → llm-plus protocol (returns '' when it cannot be mapped, so the user picks).
 * @param npm - the provider's npm package name in the catalog.
 * @returns the recognized wire protocol; '' when it cannot be mapped.
 */
export function defaultProtocol(npm: string | undefined): ProtocolName | '' {
  if (npm === undefined) return ''
  if (npm.includes('anthropic')) return 'anthropic-messages'
  if (npm.includes('google')) return 'gemini'
  // openai-compatible (about 80%) and openai both follow the Chat Completions dialect
  if (npm.includes('openai')) return 'openai-completions'
  return ''
}

/**
 * Route id sanitization: lowercase letters/digits/hyphens, everything else collapsed to a hyphen (POSIX identifier style).
 * @param raw - candidate route id (usually the catalog provider id).
 * @returns the sanitized route id.
 */
export function sanitizeRouteId(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/**
 * Build the initial draft for one provider (all defaults in place; the user only checks it and fills in the key).
 * @param provider - the provider summary from the catalog.
 * @returns the complete initial draft for that provider.
 */
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

/**
 * Parse a JSON object text field; empty text returns undefined, a non-object throws (the caller normalizes the copy).
 * @param text - the user-entered JSON object text.
 * @returns the parsed object; undefined for empty text.
 * @throws {Error} the text is not JSON or is not an object.
 */
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
 * Materialize one route configuration (the value written into the llm-plus namespace routes.<routeId>).
 * Empty string fields are always absent — the route schema defaults and protocol default endpoints take over;
 * subset mode materializes the checked catalog models into a manual models table (fully overriding catalog data).
 * @param providerId - catalog provider id (the modelsDevProvider field: the link between route and catalog).
 * @param draft - the provider draft on the page.
 * @param models - the catalog models materializable for this provider.
 * @returns the route value written into the llm-plus namespace.
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

/**
 * Draft validation: returns the location key of the first error (the caller maps it to copy); undefined when valid.
 * @param draft - the provider draft being submitted.
 * @returns the location key of the first invalid field; undefined when all fields are valid.
 */
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
