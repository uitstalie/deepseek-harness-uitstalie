/**
 * anthropic OAuth（Claude Pro/Max 订阅）：PKCE(S256) + 固定端口 loopback
 * 回调 + 手贴 code 竞速；state 参数用 verifier 本身（Anthropic 的约定）。
 * 移植 pi-ai 的 anthropic.js。
 *
 * @module @deepseek-ai/dsh-llm-plus/oauth/providers/anthropic
 */

import { runPkceLogin } from '../pkce-login.ts'
import type { OAuthProviderDef, PlusOAuthCredential } from '../types.ts'

const CLIENT_ID = atob('OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl')
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize'
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const CALLBACK_PORT = 53692
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`
const SCOPES = 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload'
/** 过期前 5 分钟即刷新。 */
const REFRESH_SKEW_MS = 5 * 60 * 1000

/** JSON POST（Anthropic 的 token 端点吃 JSON 不吃 form）。 */
async function postJson(url: string, body: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`Anthropic OAuth request failed. status=${response.status}; url=${url}; body=${text}`)
  }
  return JSON.parse(text) as Record<string, unknown>
}

/** token 响应 → 凭据（字段缺失即抛，带 5 分钟刷新提前量）。 */
function credentialFromToken(data: Record<string, unknown>): PlusOAuthCredential {
  const refresh = data['refresh_token']
  const access = data['access_token']
  const expiresIn = data['expires_in']
  if (typeof refresh !== 'string' || typeof access !== 'string' || typeof expiresIn !== 'number') {
    throw new Error(`Anthropic token response missing fields: ${JSON.stringify(data)}`)
  }
  return { type: 'oauth', refresh, access, expires: Date.now() + expiresIn * 1000 - REFRESH_SKEW_MS }
}

/** anthropic 的 OAuth 行为定义。 */
export const anthropicOAuth: OAuthProviderDef = {
  id: 'anthropic',
  loginLabel: 'Sign in with Anthropic (Claude Pro/Max)',
  login: interaction => runPkceLogin(interaction, {
    redirectUri: REDIRECT_URI,
    authorizeUrl: (challenge, redirectUri, state) => `${AUTHORIZE_URL}?${new URLSearchParams({
      code: 'true',
      client_id: CLIENT_ID,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: SCOPES,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    }).toString()}`,
    // Anthropic 的约定：state 就是 PKCE verifier 本身
    stateFor: verifier => verifier,
    server: { port: CALLBACK_PORT, path: '/callback' },
    exchange: async (code, state, verifier, redirectUri, signal) => {
      const data = await postJson(TOKEN_URL, {
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        code,
        state,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }, signal)
      return credentialFromToken(data)
    },
    copy: {
      instructions: 'Complete login in your browser. If the browser is on another machine, paste the final redirect URL here.',
      promptMessage: 'Complete login in your browser, or paste the authorization code / redirect URL here:',
      exchanging: 'Exchanging authorization code for tokens…',
    },
  }),
  refresh: async (credential, signal) => {
    const data = await postJson(TOKEN_URL, {
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: credential.refresh,
    }, signal)
    return credentialFromToken(data)
  },
  toAuth: credential => ({ apiKey: credential.access }),
}
