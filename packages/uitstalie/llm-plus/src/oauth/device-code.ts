/**
 * RFC 8628 device-code 轮询器（移植 pi-ai 的 pollOAuthDeviceCodeFlow，
 * 语义逐条保留：interval 下限 1s、缺席默认 5s、slow_down 递增 5s、
 * 服务端给的 interval 优先、WSL/VM 时钟漂移的专门报错、可中止睡眠）。
 *
 * @module @deepseek-ai/dsh-llm-plus/oauth/device-code
 */

import type { DeviceAuthorization } from './types.ts'

/** 轮询一次的结果（provider 的 poll 回调返回）。 */
export type DevicePollResult =
  | { status: 'complete'; value: PlusOAuthCredentialLike }
  | { status: 'pending' }
  | { status: 'slow_down'; intervalSeconds?: number }
  | { status: 'failed'; message: string }

/** 轮询器泛型凭据（避免循环引用 types.ts 的完整形状）。 */
type PlusOAuthCredentialLike = unknown

const CANCEL_MESSAGE = 'Login cancelled'
const TIMEOUT_MESSAGE = 'Device flow timed out'
const SLOW_DOWN_TIMEOUT_MESSAGE = 'Device flow timed out after one or more slow_down responses. This is often caused by clock drift in WSL or VM environments. Please sync or restart the VM clock and try again.'
const MINIMUM_INTERVAL_MS = 1000
/** RFC 8628 §3.2：服务端省略 interval 时客户端必须用 5 秒。 */
const DEFAULT_POLL_INTERVAL_SECONDS = 5
/** RFC 8628 §3.5：slow_down 时轮询间隔必须增加 5 秒。 */
const SLOW_DOWN_INCREMENT_MS = 5000

/** 可中止的睡眠（取消时以固定文案 reject）。 */
function abortableSleep(ms: number, signal: AbortSignal, cancelMessage: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error(cancelMessage))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timeout)
      reject(new Error(cancelMessage))
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** 轮询参数。 */
export interface DevicePollOptions<T> {
  /** 设备码起点响应（间隔/有效期取自它）。 */
  device: DeviceAuthorization
  /** 取消信号。 */
  signal: AbortSignal
  /** 第一次轮询前先等一个间隔（用户读码需要时间）。 */
  waitBeforeFirstPoll?: boolean
  /** 一次轮询（provider 的 token 端点调用）。 */
  poll(): Promise<DevicePollResult & { value?: T }>
}

/**
 * 驱动 device-code 轮询直到 complete/failed/超时。
 * @returns complete 的 value。
 * @throws 取消（固定文案）、失败（provider 消息）、超时（含时钟漂移变体）。
 */
export async function pollDeviceCode<T>(options: DevicePollOptions<T>): Promise<T> {
  const deadline = typeof options.device.expiresInSeconds === 'number'
    ? Date.now() + options.device.expiresInSeconds * 1000
    : Number.POSITIVE_INFINITY
  let intervalMs = Math.max(MINIMUM_INTERVAL_MS, Math.floor((options.device.intervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS) * 1000))
  let slowDowns = 0
  if (options.waitBeforeFirstPoll) {
    const remaining = deadline - Date.now()
    if (remaining > 0) await abortableSleep(Math.min(intervalMs, remaining), options.signal, CANCEL_MESSAGE)
  }
  while (Date.now() < deadline) {
    if (options.signal.aborted) throw new Error(CANCEL_MESSAGE)
    const result = await options.poll()
    if (result.status === 'complete') return result.value as T
    if (result.status === 'failed') throw new Error(result.message)
    if (result.status === 'slow_down') {
      slowDowns += 1
      // 服务端报了新的最小间隔就用它的（GitHub 会在 slow_down 里带
      // interval）；只信客户端自增会在 WSL/VM 时钟漂移下永远提前轮询
      intervalMs = typeof result.intervalSeconds === 'number' && Number.isFinite(result.intervalSeconds) && result.intervalSeconds > 0
        ? Math.max(MINIMUM_INTERVAL_MS, Math.floor(result.intervalSeconds * 1000))
        : Math.max(MINIMUM_INTERVAL_MS, intervalMs + SLOW_DOWN_INCREMENT_MS)
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await abortableSleep(Math.min(intervalMs, remaining), options.signal, CANCEL_MESSAGE)
  }
  throw new Error(slowDowns > 0 ? SLOW_DOWN_TIMEOUT_MESSAGE : TIMEOUT_MESSAGE)
}
