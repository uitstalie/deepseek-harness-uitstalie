/**
 * xai OAuth：xAI device-code 流（auth.x.ai，OpenID 设备授权）。
 * 移植 pi-ai 的 xai.js（refresh 不轮换 refresh_token 时沿用旧值的语义保留）。
 *
 * @module @deepseek-ai/dsh-llm-plus/oauth/providers/xai
 */

import { pollDeviceCode } from '../device-code.ts'
import { positiveNumber, postForm, requiredString, trustedHttpUrl } from '../http.ts'
import type { DeviceAuthorization, OAuthInteraction, OAuthProviderDef, PlusOAuthCredential } from '../types.ts'

const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
const SCOPE = 'openid profile email offline_access grok-cli:access api:access'
const DEVICE_CODE_URL = 'https://auth.x.ai/oauth2/device/code'
const TOKEN_URL = 'https://auth.x.ai/oauth2/token'
/** 过期前 5 分钟即刷新，避免 token 死在请求中途。 */
const REFRESH_SKEW_MS = 5 * 60 * 1000
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600

/** xAI 的验证页只信 https。 */
function trustedHttpsUrl(raw: unknown, what: string): string {
  const value = trustedHttpUrl(raw)
  if (value === undefined || !value.startsWith('https:')) {
    throw new Error(`Untrusted verification URI in ${what} response`)
  }
  return value
}

/** 起点：申请设备码。 */
async function requestDeviceCode(signal: AbortSignal): Promise<DeviceAuthorization> {
  const response = await postForm(DEVICE_CODE_URL, { client_id: CLIENT_ID, scope: SCOPE, referrer: 'llm-plus' }, signal)
  if (!response.ok) throw new Error(`xAI OAuth device authorization failed (HTTP ${response.status})`)
  const body = response.json
  const verificationUriComplete = typeof body?.['verification_uri_complete'] === 'string' && body['verification_uri_complete'].length > 0
    ? trustedHttpsUrl(body['verification_uri_complete'], 'xAI OAuth')
    : undefined
  // RFC 8628 允许 interval 0（无最小等待）；非法值回落轮询器默认
  const interval = body?.['interval']
  return {
    deviceCode: requiredString(body, 'device_code', 'xAI OAuth'),
    userCode: requiredString(body, 'user_code', 'xAI OAuth'),
    verificationUri: trustedHttpsUrl(body?.['verification_uri'], 'xAI OAuth'),
    ...(verificationUriComplete === undefined ? {} : { verificationUriComplete }),
    ...(typeof interval === 'number' && Number.isFinite(interval) && interval > 0 ? { intervalSeconds: interval } : {}),
    expiresInSeconds: positiveNumber(body, 'expires_in', 'xAI OAuth'),
  }
}

/** token 响应 → 凭据（refresh 缺席时沿用旧值——xAI 刷新不轮换）。 */
function credentialsFromTokenResponse(body: Record<string, unknown> | null, previousRefresh?: string): PlusOAuthCredential {
  const access = requiredString(body, 'access_token', 'xAI OAuth')
  const refresh = body?.['refresh_token'] === undefined && previousRefresh !== undefined
    ? previousRefresh
    : requiredString(body, 'refresh_token', 'xAI OAuth')
  const expiresIn = body?.['expires_in'] === undefined
    ? DEFAULT_TOKEN_LIFETIME_SECONDS
    : positiveNumber(body, 'expires_in', 'xAI OAuth')
  return { type: 'oauth', access, refresh, expires: Date.now() + expiresIn * 1000 - REFRESH_SKEW_MS }
}

/** 轮询换 token。 */
async function pollForTokens(device: DeviceAuthorization, signal: AbortSignal): Promise<PlusOAuthCredential> {
  return pollDeviceCode({
    device,
    signal,
    waitBeforeFirstPoll: true,
    poll: async () => {
      const response = await postForm(TOKEN_URL, {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: CLIENT_ID,
        device_code: device.deviceCode,
      }, signal)
      if (response.ok) return { status: 'complete', value: credentialsFromTokenResponse(response.json) }
      const error = response.json?.['error']
      if (error === 'authorization_pending') return { status: 'pending' }
      if (error === 'slow_down') {
        const interval = response.json?.['interval']
        return { status: 'slow_down', ...(typeof interval === 'number' ? { intervalSeconds: interval } : {}) }
      }
      if (error === 'access_denied' || error === 'authorization_denied') return { status: 'failed', message: 'xAI device authorization was denied' }
      if (error === 'expired_token') return { status: 'failed', message: 'xAI device code expired' }
      return { status: 'failed', message: `xAI OAuth device token polling failed (HTTP ${response.status})` }
    },
  })
}

/** xai 的 OAuth 行为定义。 */
export const xaiOAuth: OAuthProviderDef = {
  id: 'xai',
  loginLabel: 'Sign in with SuperGrok or X Premium',
  login: async (interaction: OAuthInteraction) => {
    const device = await requestDeviceCode(interaction.signal)
    interaction.notify({
      message: 'Open the verification page and enter the code to sign in to xAI.',
      url: device.verificationUriComplete ?? device.verificationUri,
      code: device.userCode,
    })
    return pollForTokens(device, interaction.signal)
  },
  refresh: async (credential, signal) => {
    const response = await postForm(TOKEN_URL, {
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: credential.refresh,
    }, signal)
    if (!response.ok) throw new Error(`xAI OAuth token refresh failed (HTTP ${response.status})`)
    return credentialsFromTokenResponse(response.json, credential.refresh)
  },
  toAuth: credential => ({ apiKey: credential.access }),
}
