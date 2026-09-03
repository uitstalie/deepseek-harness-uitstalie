/**
 * openai-codex OAuth（ChatGPT Plus/Pro 订阅）：select 二选一——
 * 浏览器 PKCE（固定 1455 端口回调）或 device-code（headless，device auth
 * 换授权 code + code_verifier 再走标准交换）。凭据带 accountId（从 access
 * token 的 JWT 解析 chatgpt_account_id）。
 * 移植 pi-ai 的 openai-codex.js。
 *
 * @module @deepseek-ai/dsh-llm-plus/oauth/providers/openai-codex
 */

import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { pollDeviceCode } from '../device-code.ts'
import { runPkceLogin } from '../pkce-login.ts'
import type { OAuthInteraction, OAuthProviderDef, PlusOAuthCredential } from '../types.ts'

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const AUTH_BASE_URL = 'https://auth.openai.com'
const AUTHORIZE_URL = `${AUTH_BASE_URL}/oauth/authorize`
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`
const REDIRECT_URI = 'http://localhost:1455/auth/callback'
const DEVICE_USER_CODE_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`
const DEVICE_TOKEN_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/token`
const DEVICE_REDIRECT_URI = `${AUTH_BASE_URL}/deviceauth/callback`
const SCOPE = 'openid profile email offline_access'
const JWT_CLAIM_PATH = 'https://api.openai.com/auth'
const DEVICE_CODE_TIMEOUT_SECONDS = 15 * 60

/** 浏览器登录（PKCE）。 */
const BROWSER_METHOD = 'browser'
/** 设备码登录（headless）。 */
const DEVICE_METHOD = 'device-code'

/** form POST 拿 token 响应（字段缺失即抛）。 */
async function postTokenForm(
  fields: Record<string, string>,
  signal: AbortSignal,
  operation: string,
): Promise<{ access: string; refresh: string; expires: number }> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    signal,
  })
  const json = await response.json().catch(() => null) as Record<string, unknown> | null
  const access = json?.['access_token']
  const refresh = json?.['refresh_token']
  const expiresIn = json?.['expires_in']
  if (typeof access !== 'string' || access === ''
    || typeof refresh !== 'string' || refresh === ''
    || typeof expiresIn !== 'number') {
    throw new Error(`OpenAI Codex token ${operation} response missing fields: ${JSON.stringify(json)}`)
  }
  return { access, refresh, expires: Date.now() + expiresIn * 1000 }
}

/** 解 JWT payload（不验签——只读 claim）。 */
function decodeJwt(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1]
  if (part === undefined) return null
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/** 从 access token 提取 chatgpt_account_id（缺即抛——Codex 请求要用）。 */
function accountIdOf(accessToken: string): string {
  const payload = decodeJwt(accessToken)
  const auth = payload?.[JWT_CLAIM_PATH] as Record<string, unknown> | undefined
  const accountId = auth?.['chatgpt_account_id']
  if (typeof accountId !== 'string' || accountId.length === 0) {
    throw new Error('Failed to extract accountId from token')
  }
  return accountId
}

/** token → 凭据（accountId 解析不出来即抛）。 */
function credentialsFromToken(token: { access: string; refresh: string; expires: number }): PlusOAuthCredential {
  return { type: 'oauth', access: token.access, refresh: token.refresh, expires: token.expires, accountId: accountIdOf(token.access) }
}

/** 起点：device auth 申请 user code。 */
async function startDeviceAuth(signal: AbortSignal): Promise<{ deviceAuthId: string; userCode: string; intervalSeconds: number }> {
  const response = await fetch(DEVICE_USER_CODE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID }),
    signal,
  })
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error('OpenAI Codex device code login is not enabled for this server. Use browser login or verify the server URL.')
    }
    const text = await response.text().catch(() => '')
    throw new Error(`OpenAI Codex device code request failed with status ${response.status}${text ? `: ${text}` : ''}`)
  }
  const json = await response.json() as Record<string, unknown>
  const rawInterval = json['interval']
  const intervalSeconds = typeof rawInterval === 'string' ? Number(rawInterval.trim()) : rawInterval
  const deviceAuthId = json['device_auth_id']
  const userCode = json['user_code']
  if (typeof deviceAuthId !== 'string' || deviceAuthId === ''
    || typeof userCode !== 'string' || userCode === ''
    || typeof intervalSeconds !== 'number' || !Number.isFinite(intervalSeconds) || intervalSeconds < 0) {
    throw new Error(`Invalid OpenAI Codex device code response: ${JSON.stringify(json)}`)
  }
  return { deviceAuthId, userCode, intervalSeconds }
}

/** device auth 起点响应的形状。 */
interface CodexDeviceAuth {
  deviceAuthId: string
  userCode: string
  intervalSeconds: number
}

/** 轮询 device auth：拿到授权 code + code_verifier 后走标准交换。 */
async function pollDeviceAuth(device: CodexDeviceAuth, signal: AbortSignal): Promise<PlusOAuthCredential> {
  const granted = await pollDeviceCode<{ authorizationCode: string; codeVerifier: string }>({
    device: {
      deviceCode: device.deviceAuthId,
      userCode: device.userCode,
      verificationUri: DEVICE_REDIRECT_URI,
      intervalSeconds: device.intervalSeconds,
      expiresInSeconds: DEVICE_CODE_TIMEOUT_SECONDS,
    },
    signal,
    poll: async () => {
      const response = await fetch(DEVICE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_auth_id: device.deviceAuthId, user_code: device.userCode }),
        signal,
      })
      if (response.ok) {
        const json = await response.json() as Record<string, unknown>
        if (typeof json['authorization_code'] !== 'string' || typeof json['code_verifier'] !== 'string') {
          return { status: 'failed', message: `Invalid OpenAI Codex device auth token response: ${JSON.stringify(json)}` }
        }
        return { status: 'complete', value: { authorizationCode: json['authorization_code'], codeVerifier: json['code_verifier'] } }
      }
      if (response.status === 403 || response.status === 404) return { status: 'pending' }
      const text = await response.text().catch(() => '')
      let errorCode: unknown
      try {
        const parsed = JSON.parse(text) as { error?: { code?: unknown } | unknown }
        errorCode = typeof parsed?.error === 'object' ? (parsed.error as { code?: unknown })?.code : parsed?.error
      } catch {
        // 非 JSON 错误体：errorCode 保持 undefined，走通用失败
      }
      if (errorCode === 'deviceauth_authorization_pending') return { status: 'pending' }
      if (errorCode === 'slow_down') return { status: 'slow_down' }
      return { status: 'failed', message: `OpenAI Codex device auth failed with status ${response.status}${text ? `: ${text}` : ''}` }
    },
  })
  // device auth 给的是授权 code + verifier，走标准授权码交换拿 token
  const token = await postTokenForm({
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    code: granted.authorizationCode,
    code_verifier: granted.codeVerifier,
    redirect_uri: DEVICE_REDIRECT_URI,
  }, signal, 'device exchange')
  return credentialsFromToken(token)
}

/** 浏览器 PKCE 登录。 */
async function loginBrowser(interaction: OAuthInteraction): Promise<PlusOAuthCredential> {
  return runPkceLogin(interaction, {
    redirectUri: REDIRECT_URI,
    authorizeUrl: (challenge, redirectUri, state) => {
      const url = new URL(AUTHORIZE_URL)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('client_id', CLIENT_ID)
      url.searchParams.set('redirect_uri', redirectUri)
      url.searchParams.set('scope', SCOPE)
      url.searchParams.set('code_challenge', challenge)
      url.searchParams.set('code_challenge_method', 'S256')
      url.searchParams.set('state', state)
      url.searchParams.set('id_token_add_organizations', 'true')
      url.searchParams.set('codex_cli_simplified_flow', 'true')
      url.searchParams.set('originator', 'llm-plus')
      return url.toString()
    },
    stateFor: () => randomUUID(),
    server: { port: 1455, path: '/auth/callback' },
    exchange: async (code, _state, verifier, redirectUri, signal) => {
      const token = await postTokenForm({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }, signal, 'exchange')
      return credentialsFromToken(token)
    },
    copy: {
      instructions: 'Complete sign-in in your browser. If the browser is on another machine, paste the final redirect URL here.',
      promptMessage: 'Complete sign-in in your browser, or paste the authorization code / redirect URL here:',
      exchanging: 'Exchanging authorization code for tokens…',
    },
  })
}

/** openai-codex 的 OAuth 行为定义。 */
export const openaiCodexOAuth: OAuthProviderDef = {
  id: 'openai-codex',
  loginLabel: 'Sign in with OpenAI (ChatGPT Plus/Pro)',
  login: async (interaction) => {
    const method = await interaction.prompt({
      kind: 'select',
      message: 'Select OpenAI Codex login method:',
      options: [
        { id: BROWSER_METHOD, label: 'Browser login (default)' },
        { id: DEVICE_METHOD, label: 'Device code login (headless)' },
      ],
    })
    if (method === DEVICE_METHOD) {
      const device = await startDeviceAuth(interaction.signal)
      interaction.notify({
        message: 'Open the verification page and enter the code to sign in to OpenAI.',
        url: DEVICE_REDIRECT_URI,
        code: device.userCode,
      })
      return pollDeviceAuth(device, interaction.signal)
    }
    return loginBrowser(interaction)
  },
  refresh: async (credential, signal) => {
    const token = await postTokenForm({
      grant_type: 'refresh_token',
      refresh_token: credential.refresh,
      client_id: CLIENT_ID,
    }, signal, 'refresh')
    return credentialsFromToken(token)
  },
  toAuth: credential => ({ apiKey: credential.access }),
}
