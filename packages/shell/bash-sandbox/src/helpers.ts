/** Shell-result projection over shared sandbox diagnostics. */
import type { ShellRunResult } from '@deepseek-ai/dsh-shell'
// BEGIN uitstalie-k3, 2026/10/12, task26, 追溯补标记：task12 让 bash 的分类也走共享分类器并携带可写根
import { classifyDenial as sharedClassifyDenial } from '@deepseek-ai/dsh-sandbox'
// END uitstalie-k3
export { isRunnerSpawnFailure, classifyRunnerFailure, matchesSignature } from '@deepseek-ai/dsh-sandbox'

// BEGIN uitstalie-k3, 2026/10/12, task26, 追溯补标记：task12 增 writableRoots 形参，短语之外还要求路径证据
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
// END uitstalie-k3
