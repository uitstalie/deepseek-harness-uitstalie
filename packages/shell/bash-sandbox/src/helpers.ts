/** Shell-result projection over shared sandbox diagnostics. */
import type { ShellRunResult } from '@deepseek-ai/dsh-shell'
import { classifyDenial as sharedClassifyDenial } from '@deepseek-ai/dsh-sandbox'
export { isRunnerSpawnFailure, classifyRunnerFailure, matchesSignature } from '@deepseek-ai/dsh-sandbox'

/**
 * Classify a failed run against the selected backend's denial dialect.
 * @param result - settled foreground run.
 * @param signatures - case-insensitive denial substrings from the active wrap.
 * @param writableRoots - the call's granted write roots; a denial phrase must
 *   name a path these roots cannot explain (see `dsh-sandbox`'s `classifyDenial`).
 * @returns whether the failed run matches that denial dialect.
 */
export function classifyDenial(
  result: ShellRunResult,
  signatures: readonly string[],
  writableRoots: readonly string[],
): boolean {
  return sharedClassifyDenial(result.exitCode, result.stderr.text, signatures, writableRoots)
}
