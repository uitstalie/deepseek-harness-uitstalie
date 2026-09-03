/**
 * kimi-coding OAuth（Kimi Code 订阅）：RFC 8628 device authorization，
 * auth.kimi.com，JSON 响应。移植 pi-ai 的 kimi-coding.js（端点/client_id/
 * 刷新重试语义逐条对齐；env 覆盖端点不支持——llm-plus 不读 process.env）。
 *
 * access token 以 Authorization: Bearer 认证 https://api.kimi.com/coding。
 *
 * @module @deepseek-ai/dsh-llm-plus/oauth/providers/kimi-coding
 */

import { pollDeviceCode } from '../device-code.ts'
import { postForm, requiredString, requestSignal, trustedHttpUrl } from '../http.ts'
import type { DeviceAuthorization, OAuthInteraction, OAuthProviderDef, PlusOAuthCredential } from '../types.ts'

const CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098'
const OAUTH_HOST = 'https://auth.kimi.com'
const DEVICE_CODE_TIMEOUT_SECONDS = 15 * 60
const DEFAULT_POLL_INTERVAL_SECONDS = 5
const REFRESH_MAX_RETRIES = 3

/** 起点：申请设备码（响应字段不齐/URL 不可信即抛）。 */
async function startDeviceAuthorization(signal: AbortSignal): Promise<DeviceAuthorization> {
  const response = await postForm(`${OAUTH_HOST}/api/oauth/device_authorization`, { client_id: CLIENT_ID }, requestSignal(signal))
  if (!response.ok) {
    throw new Error(`Kimi Code device authorization failed with status ${response.status}${response.text ? `: ${response.text}` : ''}`)
  }
  const json = response.json
  const verificationUri = trustedHttpUrl(json?.['verification_uri'])
  const verificationUriComplete = trustedHttpUrl(json?.['verification_uri_complete'])
  if (verificationUri === undefined || verificationUriComplete === undefined) {
    throw new Error(`Invalid Kimi Code device authorization response: ${response.text}`)
  }
  return {
    deviceCode: requiredString(json, 'device_code', 'Kimi Code device authorization'),
    userCode: requiredString(json, 'user_code', 'Kimi Code device authorization'),
    verificationUri,
    verificationUriComplete,
    intervalSeconds: typeof json?.['interval'] === 'number' && json['interval'] > 0 ? json['interval'] : DEFAULT_POLL_INTERVAL_SECONDS,
    expiresInSeconds: typeof json?.['expires_in'] === 'number' && json['expires_in'] > 0 ? json['expires_in'] : DEVICE_CODE_TIMEOUT_SECONDS,
  }
}

/** token 响应 → 凭据（三个字段缺一即抛）。 */
function parseTokenResponse(json: Record<string, unknown> | null, operation: string, previousRefresh?: string): PlusOAuthCredential {
  const access = json?.['access_token']
  const refreshValue = json?.['refresh_token'] === undefined && previousRefresh !== undefined ? previousRefresh : json?.['refresh_token']
  const expiresIn = json?.['expires_in']
  if (typeof access !== 'string' || access === ''
    || typeof refreshValue !== 'string' || refreshValue === ''
    || typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error(`Kimi Code token ${operation} response missing fields: ${JSON.stringify(json)}`)
  }
  return { type: 'oauth', access, refresh: refreshValue, expires: Date.now() + expiresIn * 1000 }
}

/** 轮询换取 token（pending/slow_down/expired/denied 逐态映射）。 */
async function pollForToken(device: DeviceAuthorization, signal: AbortSignal): Promise<PlusOAuthCredential> {
  return pollDeviceCode({
    device,
    signal,
    waitBeforeFirstPoll: true,
    poll: async () => {
      const response = await postForm(`${OAUTH_HOST}/api/oauth/token`, {
        client_id: CLIENT_ID,
        device_code: device.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }, requestSignal(signal))
      if (response.status >= 500) {
        return { status: 'failed', message: `Kimi Code device token request failed with status ${response.status}${response.text ? `: ${response.text}` : ''}` }
      }
      const json = response.json
      if (response.ok && typeof json?.['access_token'] === 'string') {
        return { status: 'complete', value: parseTokenResponse(json, 'poll') }
      }
      const error = json?.['error']
      const description = typeof json?.['error_description'] === 'string' ? `: ${json['error_description']}` : ''
      if (error === 'authorization_pending') return { status: 'pending' }
      if (error === 'slow_down') {
        const interval = json?.['interval']
        return { status: 'slow_down', ...(typeof interval === 'number' && interval > 0 ? { intervalSeconds: interval } : {}) }
      }
      if (error === 'expired_token') return { status: 'failed', message: 'Kimi Code device authorization expired. Please restart login.' }
      if (error === 'access_denied') return { status: 'failed', message: 'Kimi Code login was denied.' }
      return { status: 'failed', message: `Kimi Code device token request failed (status ${response.status})${typeof error === 'string' ? `: ${error}${description}` : ''}` }
    },
  })
}

/** 可重试的刷新故障：429/5xx。 */
function isRetryableRefreshFailure(status: number): boolean {
  return status === 429 || status >= 500
}

/** 可中止的退避睡眠。 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const onAbort = (): void => {
      clearTimeout(timeout)
      reject(signal.reason)
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** 刷新（指数退避 1s/2s/4s，429/5xx 重试 3 次；401/403/invalid_grant = 凭据已死）。 */
async function refreshToken(refreshTokenValue: string, signal: AbortSignal): Promise<PlusOAuthCredential> {
  let lastError: Error | undefined
  for (let attempt = 0; attempt <= REFRESH_MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1), signal)
    if (signal.aborted) throw new Error('Kimi Code token refresh aborted')
    let response
    try {
      response = await postForm(`${OAUTH_HOST}/api/oauth/token`, {
        client_id: CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: refreshTokenValue,
      }, requestSignal(signal))
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      continue
    }
    if (response.ok) return parseTokenResponse(response.json, 'refresh')
    const json = response.json
    if (response.status === 401 || response.status === 403 || json?.['error'] === 'invalid_grant') {
      const description = typeof json?.['error_description'] === 'string' ? `: ${json['error_description']}` : ''
      throw new Error(`Kimi Code token refresh unauthorized (status ${response.status})${description}`)
    }
    if (isRetryableRefreshFailure(response.status) && attempt < REFRESH_MAX_RETRIES) {
      lastError = new Error(`Kimi Code token refresh failed with status ${response.status}`)
      continue
    }
    throw new Error(`Kimi Code token refresh failed with status ${response.status}: ${JSON.stringify(json)}`)
  }
  throw lastError ?? new Error('Kimi Code token refresh failed')
}

/** kimi-coding 的 OAuth 行为定义。 */
export const kimiCodingOAuth: OAuthProviderDef = {
  id: 'kimi-coding',
  loginLabel: 'Sign in with Kimi Code',
  login: async (interaction: OAuthInteraction) => {
    const device = await startDeviceAuthorization(interaction.signal)
    interaction.notify({
      message: 'Open the verification page and enter the code to sign in to Kimi Code.',
      ...(device.verificationUriComplete === undefined ? {} : { url: device.verificationUriComplete }),
      code: device.userCode,
    })
    return pollForToken(device, interaction.signal)
  },
  refresh: (credential, signal) => refreshToken(credential.refresh, signal),
  toAuth: credential => ({ apiKey: credential.access }),
}
