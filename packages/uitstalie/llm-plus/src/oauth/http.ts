/**
 * OAuth 共享的 HTTP 小工具（PKCE 与 device-code 两家都用）。
 *
 * @module @deepseek-ai/dsh-llm-plus/oauth/http
 */

/** 单次请求的超时（OAuth 端点都是小 JSON，30s 足够宽）。 */
export const OAUTH_REQUEST_TIMEOUT_MS = 30_000

/**
 * 合并 flow 取消与单次请求超时为一个信号。
 * @param signal - 登录流的取消信号。
 * @returns 任一来源中止即中止的信号。
 */
export function requestSignal(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS), signal])
}

/**
 * form-urlencoded POST 并解析 JSON 响应（非对象按 null 处理）。
 * @param url - 要提交的端点。
 * @param fields - form 字段。
 * @param signal - 请求的取消信号。
 * @param headers - 额外请求头（覆盖默认值）。
 * @returns 状态码、解析出的 JSON 对象（或 null）与原始正文。
 */
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

/**
 * 验证页 URL 只信 http/https（防恶意响应让 open 打开别的东西）。
 * @param value - provider 响应里的候选 URL。
 * @returns 规范化后的 URL；非字符串、空串或非 http(s) 时为 undefined。
 */
export function trustedHttpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined
  } catch {
    return undefined
  }
}

/**
 * 从响应对象取必填字符串字段（缺失/空串即抛带字段名的错）。
 * @param body - 解析出的响应对象。
 * @param field - 要读取的字段名。
 * @param what - 出错文案里的操作名。
 * @returns 该字段的字符串值。
 * @throws {Error} 字段缺失或不是非空字符串。
 */
export function requiredString(body: Record<string, unknown> | null, field: string, what: string): string {
  const value = body?.[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${what}: response field ${field} missing or not a string`)
  }
  return value
}

/**
 * 从响应对象取正数字段（同上）。
 * @param body - 解析出的响应对象。
 * @param field - 要读取的字段名。
 * @param what - 出错文案里的操作名。
 * @returns 该字段的正数值。
 * @throws {Error} 字段缺失、非数字、非有限或不为正。
 */
export function positiveNumber(body: Record<string, unknown> | null, field: string, what: string): number {
  const value = body?.[field]
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${what}: response field ${field} missing or not a positive number`)
  }
  return value
}
