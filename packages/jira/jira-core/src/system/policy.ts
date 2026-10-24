/**
 * Filesystem policies that are not identical everywhere (decision 153).
 *
 * Both numbers exist because of something that actually happened, not because a platform "usually"
 * needs them:
 *
 *   - **Atomic write**: a rename over a file another process has open fails on Windows. Three attempts
 *     with a growing backoff is what makes `writeTextAtomic` honest on both platforms.
 *   - **Directory removal**: a git helper can still be writing `objects/pack` when a test finishes. One
 *     CI job saw ENOTEMPTY while every assertion had passed, so cleanup retries with a backoff.
 *
 * They live here so both platforms retry the same way, and so a test clock can be injected later
 * without hunting for literals.
 */

/** Atomic-write attempts before reporting failure. */
export const WRITE_ATTEMPTS = 3

/** Backoff between those attempts: 50 ms, 100 ms, 200 ms, … */
export const writeDelayMs = (attempt: number): number => 50 * 2 ** (attempt - 1)

/** Directory-removal attempts while a writer may still be finishing. */
export const REMOVE_RETRIES = 5

/** Backoff between those removal attempts. */
export const removeDelayMs = (attempt: number): number => 40 * (attempt + 1)
