/**
 * PKCE 登录的共享骨架：loopback 回调服务器 + 手贴 code 竞速 + code 交换。
 * anthropic/openrouter/openai-codex(browser) 三家同一形态，差异收敛为参数
 * （端口/路径/授权 URL 构造/交换体）。移植自 pi-ai 的 anthropic.js /
 * openrouter.js / openai-codex.js 的公共结构。
 *
 * @module @deepseek-ai/dsh-llm-plus/oauth/pkce-login
 */

import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { generatePKCE } from './pkce.ts'
import type { OAuthInteraction, PlusOAuthCredential } from './types.ts'

/** loopback 回调服务器参数。 */
export interface CallbackServerSpec {
  /** 固定端口（anthropic 53692 / codex 1455）；undefined = 临时端口（openrouter）。 */
  port?: number
  /** 监听地址（默认 127.0.0.1）。 */
  host?: string
  /** 回调路径；undefined = 随机 UUID 路径（openrouter 用它代替 state）。 */
  path?: string
}

/** 一次 PKCE 登录的全部参数（差异全在这张数据表上）。 */
export interface PkceLoginSpec {
  /** 注册的固定 redirect_uri（code 交换用它；授权页在服务器活着时用活地址）。 */
  redirectUri: string
  /** 授权页 URL 构造（拿到 challenge/redirectUri/state 后拼参）。 */
  authorizeUrl(challenge: string, redirectUri: string, state: string): string
  /** 由 verifier 决定 state（anthropic 用 verifier 本身；codex 用随机值）。 */
  stateFor(verifier: string): string
  /** 回调服务器参数。 */
  server: CallbackServerSpec
  /** 授权 code 交换为凭据（各家的端点与 body 不同）。 */
  exchange(
    code: string,
    state: string | undefined,
    verifier: string,
    redirectUri: string,
    signal: AbortSignal,
  ): Promise<PlusOAuthCredential>
  /** 展示文案（notice/prompt 的消息体）。 */
  copy: {
    /** 展示给用户的授权页提示。 */
    instructions: string
    /** 手贴 code 的提示。 */
    promptMessage: string
    /** 交换中的进度提示。 */
    exchanging: string
  }
}

/** 成功页 HTML（回调窗口里显示；极简内联）。 */
const SUCCESS_HTML = '<!doctype html><title>Signed in</title><p>Authentication completed. You can close this window.</p>'
/** 失败页 HTML。 */
const ERROR_HTML = '<!doctype html><title>Sign-in failed</title><p>Authentication did not complete.</p>'

/**
 * 解析用户手贴的授权输入：完整重定向 URL（取 code/state 参数）/
 * `code#state` 片段 / `code=…&state=…` 参数串 / 裸 code。
 *
 * exactOptionalPropertyTypes：返回类型的字段显式允许 undefined
 * （URL 参数缺失时值为 undefined 而非缺席）。
 */
export function parseAuthorizationInput(input: string): { code?: string | undefined; state?: string | undefined } {
  const value = input.trim()
  if (!value) return {}
  try {
    const url = new URL(value)
    return {
      code: url.searchParams.get('code') ?? undefined,
      state: url.searchParams.get('state') ?? undefined,
    }
  } catch {
    // 不是 URL，继续尝试其他形态
  }
  if (value.includes('#')) {
    const [code, state] = value.split('#', 2)
    return {
      ...(code === undefined || code === '' ? {} : { code }),
      ...(state === undefined || state === '' ? {} : { state }),
    }
  }
  if (value.includes('code=')) {
    const params = new URLSearchParams(value)
    return {
      code: params.get('code') ?? undefined,
      state: params.get('state') ?? undefined,
    }
  }
  return { code: value }
}

/** loopback 回调服务器句柄。 */
interface CallbackServer {
  /** 完整回调 URL（拼进授权页参数）。 */
  callbackUrl: string
  /** 等一次回调；取消/撤回时 resolve null。 */
  waitForCode(): Promise<{ code: string; state?: string } | null>
  /** 让 waitForCode 立刻以 null 结束（竞速的输家撤回）。 */
  cancelWait(): void
  /** 关服务器。 */
  close(): void
}

/**
 * 起 loopback 回调服务器：校验路径与 state，拿到 code 即 resolve。
 * 端口被占等 listen 错误降级为"无服务器"（waitForCode 恒 null，
 * 只剩手贴路径——codex 的 startLocalOAuthServer 同款语义）。
 */
async function startCallbackServer(spec: CallbackServerSpec, expectedState: string, signal: AbortSignal): Promise<CallbackServer> {
  const { createServer } = await import('node:http')
  const path = spec.path ?? `/oauth/callback/${randomUUID()}`
  const host = spec.host ?? '127.0.0.1'
  return new Promise((resolve) => {
    let settle: (value: { code: string; state?: string } | null) => void
    const waiting = new Promise<{ code: string; state?: string } | null>((resolveWait) => {
      let settled = false
      settle = (value) => {
        if (settled) return
        settled = true
        resolveWait(value)
      }
    })
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? '', 'http://localhost')
        if (url.pathname !== path) {
          res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(ERROR_HTML)
          return
        }
        const code = url.searchParams.get('code')
        const state = url.searchParams.get('state')
        if (url.searchParams.get('error') || !code || (state !== null && state !== expectedState)) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(ERROR_HTML)
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(SUCCESS_HTML)
        settle({ code, ...(state === null ? {} : { state }) })
      } catch {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('Internal error')
      }
    })
    server.on('error', () => {
      // 端口被占等错误：降级为无服务器（只剩手贴路径）
      settle(null)
      resolve({
        callbackUrl: '',
        waitForCode: () => Promise.resolve(null),
        cancelWait: () => {},
        close: () => {},
      })
    })
    const onAbort = (): void => settle(null)
    signal.addEventListener('abort', onAbort, { once: true })
    server.listen(spec.port ?? 0, host, () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : (spec.port ?? 0)
      resolve({
        callbackUrl: `http://localhost:${port}${path}`,
        waitForCode: () => waiting,
        cancelWait: () => settle(null),
        close: () => server.close(),
      })
    })
  })
}

/**
 * 执行一次 PKCE 登录：起回调服务器 → 展示授权 URL → 浏览器回调与手贴
 * code 竞速（赢家取消输家）→ 交换凭据。取消/摘除经 signal 全程可中止。
 */
export async function runPkceLogin(interaction: OAuthInteraction, spec: PkceLoginSpec): Promise<PlusOAuthCredential> {
  const { verifier, challenge } = await generatePKCE()
  const expectedState = spec.stateFor(verifier)
  const server = await startCallbackServer(spec.server, expectedState, interaction.signal)
  const manualAbort = new AbortController()
  const onAbort = (): void => server.cancelWait()
  interaction.signal.addEventListener('abort', onAbort, { once: true })
  if (interaction.signal.aborted) onAbort()
  try {
    // 授权页用活回调地址（服务器活着时）；固定端口流的活地址与注册地址相同，
    // 临时端口流（openrouter）只能靠活地址。服务器没起来时退回注册地址
    const authorizeTarget = server.callbackUrl === '' ? spec.redirectUri : server.callbackUrl
    interaction.notify({
      message: spec.copy.instructions,
      url: spec.authorizeUrl(challenge, authorizeTarget, expectedState),
    })
    // 手贴 prompt 的占位符用活地址（服务器没起来时用注册地址）
    const manualPlaceholder = server.callbackUrl === '' ? spec.redirectUri : server.callbackUrl
    let manualInput: string | undefined
    let manualError: Error | undefined
    const manualPromise = interaction.prompt({
      kind: 'text',
      message: spec.copy.promptMessage,
      placeholder: manualPlaceholder,
      signal: manualAbort.signal,
    }).then((input) => {
      manualInput = input
      server.cancelWait()
    }).catch((error: unknown) => {
      manualError = error instanceof Error ? error : new Error(String(error))
      server.cancelWait()
    })
    const result = await server.waitForCode()
    if (manualError) throw manualError
    let code = result?.code
    let state = result?.state
    if (code === undefined) {
      await manualPromise
      if (manualError) throw manualError
      if (manualInput !== undefined) {
        const parsed = parseAuthorizationInput(manualInput)
        if (parsed.state !== undefined && parsed.state !== expectedState) throw new Error('OAuth state mismatch')
        code = parsed.code
        state = parsed.state ?? expectedState
      }
    }
    if (code === undefined) throw new Error('Missing authorization code')
    interaction.notify({ message: spec.copy.exchanging })
    return await spec.exchange(code, state, verifier, spec.redirectUri === '' ? server.callbackUrl : spec.redirectUri, interaction.signal)
  } finally {
    interaction.signal.removeEventListener('abort', onAbort)
    manualAbort.abort()
    server.close()
  }
}
