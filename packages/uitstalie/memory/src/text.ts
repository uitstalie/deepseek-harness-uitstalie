/**
 * Small text helpers shared by the memory modules.
 *
 * They live in one place because the snapshot, read, summary, checkpoint and MEMORY.md paths all
 * bound user or model text the same way: bytes for the model budget, characters for one entry, and
 * a single rendering of an unknown error. Duplicating them per module let the tiny-budget edge
 * cases drift apart.
 * @module @deepseek-ai/dsh-memory/text
 */

/**
 * UTF-8 byte length of one string.
 * @param text - the text to measure.
 * @returns its size in bytes.
 */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * Truncate text to a byte budget, appending an ellipsis when it was shortened.
 *
 * A budget too small even for the ellipsis yields the empty string rather than an over-budget
 * fragment.
 * @param text - the text to bound.
 * @param maxBytes - the maximum UTF-8 size, ellipsis included.
 * @returns the original text or a shortened copy.
 */
export function truncateToBytes(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text
  const ellipsis = '…'
  let used = byteLength(ellipsis)
  if (used > maxBytes) return ''
  const kept: string[] = []
  for (const character of text) {
    used += byteLength(character)
    if (used > maxBytes) break
    kept.push(character)
  }
  return `${kept.join('')}${ellipsis}`
}

/**
 * One error's message, for a log line or a notice.
 * @param error - the thrown value, which need not be an `Error`.
 * @returns the message or the value's string form.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
