/**
 * OAuth 共享的 HTTP 小工具（PKCE 与 device-code 两家都用）。
 *
 * @module @deepseek-ai/dsh-llm-plus/oauth/http
 */

/** 单次请求的超时（OAuth 端点都是小 JSON，30s 足够宽）。 */
export const OAUTH_REQUEST_TIMEOUT_MS = 30_000

/** 合并 flow 取消与单次请求超时为一个信号。 */
export function requestSignal(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS), signal])
}

/** form-urlencoded POST 并解析 JSON 响应（非对象按 null 处理）。 */
export async function postForm(
  url: string,
  fields: Record<string, string>,
  signal: AbortSignal,
  headers?: Record<string, string>,
): Promise<{ ok: boolean; status: number; json: Record<string, unknown> | null; text: string }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      ...headers,
    },
    body: new URLSearchParams(fields).toString(),
    signal,
  })
  const text = await response.text()
  let json: Record<string, unknown> | null = null
  try {
    const parsed: unknown = JSON.parse(text)
    json = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    // 非 JSON 响应：json 保持 null，text 里有原文
  }
  return { ok: response.ok, status: response.status, json, text }
}

/** 验证页 URL 只信 http/https（防恶意响应让 open 打开别的东西）。 */
export function trustedHttpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined
  } catch {
    return undefined
  }
}

/** 从响应对象取必填字符串字段（缺失/空串即抛带字段名的错）。 */
export function requiredString(body: Record<string, unknown> | null, field: string, what: string): string {
  const value = body?.[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${what}: response field ${field} missing or not a string`)
  }
  return value
}

/** 从响应对象取正数字段（同上）。 */
export function positiveNumber(body: Record<string, unknown> | null, field: string, what: string): number {
  const value = body?.[field]
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${what}: response field ${field} missing or not a positive number`)
  }
  return value
}
