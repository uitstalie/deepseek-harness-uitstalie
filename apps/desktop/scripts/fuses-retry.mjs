/** Flip Electron fuses with bounded retries for a transient file lock. */
import { flipFuses, FuseV1Options, FuseVersion } from '@electron/fuses'

/** Retry attempts for one fuse flip; the lock a scanner takes on a freshly written binary is short-lived. */
export const FUSES_RETRY_ATTEMPTS = 12

/** Pause between attempts; twelve one-second pauses outlast an observed scan window. */
export const FUSES_RETRY_DELAY_MS = 1_000

/** Fuses this product requires: the executable must also run as plain Node for the Host. */
export const HARNESS_FUSES = Object.freeze({
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: true,
})

/**
 * Flip the configured fuses, retrying while another process holds the executable.
 *
 * electron-builder's own fuse step opens the just-written binary once and fails the whole packaging run when a
 * scanner holds it; retrying converts that transient window into a longer packaging run instead of a failure.
 * @param {string} executablePath - absolute path to the built Electron executable.
 * @param {object} [options] - retry policy and progress reporting.
 * @param {number} [options.attempts] - total attempts, at least one.
 * @param {number} [options.delayMs] - pause between failed attempts.
 * @param {typeof HARNESS_FUSES} [options.fuses] - fuse configuration to apply.
 * @param {(attempt: number, error: Error) => void} [options.onRetry] - called after each failed attempt.
 * @returns {Promise<number>} the fuse wire's resulting state from the successful flip.
 * @throws {Error} when every attempt failed, carrying the last error's message.
 */
export async function flipFusesWithRetry(executablePath, options = {}) {
  const attempts = options.attempts ?? FUSES_RETRY_ATTEMPTS
  const delayMs = options.delayMs ?? FUSES_RETRY_DELAY_MS
  const fuses = options.fuses ?? HARNESS_FUSES
  const onRetry = options.onRetry ?? (() => {})
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error('electron fuses: attempts must be a positive integer')
  if (!Number.isInteger(delayMs) || delayMs < 0) throw new Error('electron fuses: delayMs must be a non-negative integer')
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await flipFuses(executablePath, fuses)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      onRetry(attempt, lastError)
      if (attempt < attempts) await new Promise(resolve => { setTimeout(resolve, delayMs) })
    }
  }
  throw new Error(`electron fuses: failed after ${String(attempts)} attempt(s): ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}
