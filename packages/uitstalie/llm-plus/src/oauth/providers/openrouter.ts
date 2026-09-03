/**
 * openrouter OAuth：PKCE(S256) + 临时端口 loopback 回调（随机 UUID 路径
 * 代替 state）+ 手贴 code 竞速；交换得到的是**长期 API key**（不是
 * 会过期的 token 对），refresh 因此是恒等。
 * 移植 pi-ai 的 openrouter.js。
 *
 * @module @deepseek-ai/dsh-llm-plus/oauth/providers/openrouter
 */

import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { runPkceLogin } from '../pkce-login.ts'
import type { OAuthProviderDef, PlusOAuthCredential } from '../types.ts'

const AUTHORIZE_URL = 'https://openrouter.ai/auth'
const TOKEN_URL = 'https://openrouter.ai/api/v1/auth/keys'
const EXCHANGE_TIMEOUT_MS = 30_000

/** 交换：code → 长期 API key（OpenRouter 的 keys 端点）。 */
async function exchangeAuthorizationCode(code: string, verifier: string, signal: AbortSignal): Promise<PlusOAuthCredential> {
  const controller = new AbortController()
  const onAbort = (): void => controller.abort(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  const timeout = setTimeout(() => controller.abort(new Error('OpenRouter OAuth token exchange timed out')), EXCHANGE_TIMEOUT_MS)
  try {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
      signal: controller.signal,
    })
    const body = await response.json().catch(() => ({})) as Record<string, unknown>
    if (!response.ok) {
      const detail = typeof body['error'] === 'string' ? `: ${body['error']}` : ''
      throw new Error(`OpenRouter OAuth key exchange failed (HTTP ${response.status})${detail}`)
    }
    if (typeof body['key'] !== 'string' || body['key'].length === 0) {
      throw new Error('OpenRouter OAuth response carries no "key"')
    }
    return { type: 'oauth', access: body['key'], refresh: '', expires: Number.MAX_SAFE_INTEGER }
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', onAbort)
  }
}

/** openrouter 的 OAuth 行为定义。 */
export const openrouterOAuth: OAuthProviderDef = {
  id: 'openrouter',
  loginLabel: 'Sign in with OpenRouter',
  // 临时端口 + 随机回调路径：callback_url 用活地址（骨架在服务器活着时传活地址）
  login: interaction => runPkceLogin(interaction, {
    redirectUri: '',
    authorizeUrl: (challenge, callbackUrl) => {
      const url = new URL(AUTHORIZE_URL)
      url.search = new URLSearchParams({
        callback_url: callbackUrl,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString()
      return url.toString()
    },
    // 随机回调路径已承担防混淆职责；state 仅满足骨架的校验位
    stateFor: () => randomUUID(),
    server: {},
    exchange: (code, _state, verifier, _redirectUri, signal) => exchangeAuthorizationCode(code, verifier, signal),
    copy: {
      instructions: 'Complete sign-in in your browser. If the browser is on another machine, paste the final redirect URL here.',
      promptMessage: 'Complete sign-in in your browser, or paste the authorization code / redirect URL here:',
      exchanging: 'Exchanging authorization code for an API key…',
    },
  }),
  refresh: credential => Promise.resolve(credential),
  toAuth: credential => ({ apiKey: credential.access }),
}
