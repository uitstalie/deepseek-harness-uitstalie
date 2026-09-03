/**
 * llm-plus 的 OAuth 装配：provider 行为表 + 凭据生命周期 + flow 注册。
 *
 * 凭据模型：grant 记录存 credentials seam（key = credentialKey('llm-plus',
 * routeId)，{kind:'grant', payload: PlusOAuthCredential}）；请求期解析时
 * 距过期 <5min 即在 `modifyRecord` 的跨进程锁内刷新并持久化（对齐 pi-ai
 * 的 resolveStoredOAuth 语义）；刷新被判死（401/403/invalid_grant）→
 * 删记录 + 可行动的重登错误。
 *
 * @module @deepseek-ai/dsh-llm-plus/oauth
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AuthorizationFlow } from '@deepseek-ai/dsh-authorization'
import { credentialKey, type CredentialProvider, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { anthropicOAuth } from './providers/anthropic.ts'
import { githubCopilotOAuth } from './providers/github-copilot.ts'
import { kimiCodingOAuth } from './providers/kimi-coding.ts'
import { openaiCodexOAuth } from './providers/openai-codex.ts'
import { openrouterOAuth } from './providers/openrouter.ts'
import { xaiOAuth } from './providers/xai.ts'
import type { OAuthProviderDef, OAuthRequestAuth, PlusOAuthCredential } from './types.ts'

export type { OAuthInteraction, OAuthProviderDef, OAuthRequestAuth, PlusOAuthCredential } from './types.ts'

/** flow id → provider 行为定义（路由 oauth 字段的合法值域）。 */
export const OAUTH_PROVIDERS: Record<string, OAuthProviderDef> = {
  anthropic: anthropicOAuth,
  'openai-codex': openaiCodexOAuth,
  'github-copilot': githubCopilotOAuth,
  openrouter: openrouterOAuth,
  'kimi-coding': kimiCodingOAuth,
  xai: xaiOAuth,
}

/** flow id 集合（配置校验用）。 */
export const OAUTH_FLOW_IDS: readonly string[] = Object.keys(OAUTH_PROVIDERS)

/** 路由的 grant 记录地址（scope 段是插件注册名——seam 的所有权约束）。 */
export function grantKeyFor(routeId: string) {
  return credentialKey('llm-plus', routeId)
}

/** 距过期不足 5 分钟即刷新（pi-ai 的窗口语义）。 */
const REFRESH_WINDOW_MS = 5 * 60 * 1000

/** 读出记录里的 grant 凭据；形状不符按无凭据处理（别家写的记录不抢）。 */
function readGrantPayload(record: CredentialRecord | undefined): PlusOAuthCredential | undefined {
  if (record === undefined || record.kind !== 'grant') return undefined
  const payload = record.payload as Partial<PlusOAuthCredential> | null
  if (payload === null || typeof payload !== 'object') return undefined
  if (payload.type !== 'oauth' || typeof payload.access !== 'string' || typeof payload.refresh !== 'string' || typeof payload.expires !== 'number') {
    return undefined
  }
  return payload as PlusOAuthCredential
}

/**
 * 请求期解析一个 OAuth 路由的认证：读记录 → 临期在锁内刷新 → 推导 Bearer。
 * @returns undefined = 没有已登录凭据（调用方报可行动的重登错误）。
 */
export async function resolveOAuthAuth(
  credentials: CredentialProvider,
  def: OAuthProviderDef,
  routeId: string,
  signal?: AbortSignal,
): Promise<OAuthRequestAuth | undefined> {
  const key = grantKeyFor(routeId)
  let credential = readGrantPayload(await credentials.readRecord(key))
  if (credential === undefined) return undefined
  if (credential.expires - Date.now() >= REFRESH_WINDOW_MS) return def.toAuth(credential)
  // 临期：modifyRecord 的跨进程锁内复查再刷新（并发轮换只会有一个真正执行）
  const updated = await credentials.modifyRecord(key, async (current) => {
    const standing = readGrantPayload(current)
    if (standing === undefined) return undefined // 记录消失了，不动
    if (standing.expires - Date.now() >= REFRESH_WINDOW_MS) return undefined // 别的进程刚刷新过
    const refreshed = await def.refresh(standing, signal ?? new AbortController().signal)
    return { kind: 'grant', payload: refreshed }
  })
  credential = readGrantPayload(updated) ?? credential
  return def.toAuth(credential)
}

/** 刷新失败（凭据被判死）：删记录 + 抛可行动的重登错误。 */
export async function dropDeadGrant(credentials: CredentialProvider, routeId: string): Promise<void> {
  await credentials.deleteRecord(grantKeyFor(routeId))
}

/**
 * 为一组路由注册 OAuth 登录流（authorization seam 缺席的组合整体休眠）。
 * @returns 同步函数：路由集变化时增量注册/摘除（onChange 调用）。
 */
export function registerOAuthFlows(
  ctx: Context,
  initialRouteIds: readonly string[],
  flowIdOf: (routeId: string) => string | undefined,
): (routeIds: readonly string[]) => void {
  /** 已注册：routeId → 摘除器。 */
  const registered = new Map<string, () => void>()
  // 缝缺席时 sync 是空转（无 authorization 的组合纯凭 apiKeyRef 工作）
  const syncRef: { current: (routeIds: readonly string[]) => void } = { current: () => {} }
  ctx.inject(['authorization'], (scoped) => {
    const sync = (routeIds: readonly string[]): void => {
      for (const routeId of routeIds) {
        if (registered.has(routeId)) continue
        const flowId = flowIdOf(routeId)
        if (flowId === undefined) continue
        const def = OAUTH_PROVIDERS[flowId]
        if (def === undefined) continue
        const key = grantKeyFor(routeId)
        const flow: AuthorizationFlow = {
          key,
          label: def.loginLabel,
          methods: [{ id: 'oauth', label: def.loginLabel }],
          run: async (session) => {
            // session 的形状即 OAuthInteraction（词汇在 types.ts 对齐过）
            const credential = await def.login(session)
            // flow 自己写库（seam 的 NOT_COMMITTED 防护靠它）；用外层 ctx 的
            // credentials（模块级 inject 声明过）——scoped 里没声明它
            await ctx.credentials.modifyRecord(key, () => Promise.resolve({ kind: 'grant', payload: credential }))
          },
        }
        registered.set(routeId, scoped.authorization.registerFlow(flow))
      }
      for (const [routeId, dispose] of [...registered]) {
        if (routeIds.includes(routeId)) continue
        registered.delete(routeId)
        dispose()
      }
    }
    sync(initialRouteIds)
    syncRef.current = sync
  })
  return routeIds => syncRef.current(routeIds)
}
