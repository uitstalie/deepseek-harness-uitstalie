/**
 * Rule matching for the soft tool policy: a target is denied when its lexical
 * or physical spelling sits at/under a rule's lexical or physical root.
 *
 * @module @deepseek-ai/dsh-tool-policy/match
 */

import { compareKey, isWithin } from './canonicalize.ts'
import type { CanonicalTarget, FileAccessOperation, PreparedPathRule, PreparedProfile } from './types.ts'

/** One path denial, carrying the matched rule for diagnostics. */
export interface PathDenial {
  /** The rule that matched. */
  readonly rule: PreparedPathRule
  /** The canonical target that matched it. */
  readonly target: CanonicalTarget
}

function samePath(left: string, right: string, target: CanonicalTarget): boolean {
  return compareKey(left, target.platform, target.caseSensitive) === compareKey(right, target.platform, target.caseSensitive)
}

function matchesRule(rule: PreparedPathRule, target: CanonicalTarget): boolean {
  const roots = [rule.lexical, rule.physical].filter((root): root is string => root !== undefined)
  const targets = [target.lexical, target.physical].filter((path): path is string => path !== undefined)
  for (const root of roots) {
    for (const candidate of targets) {
      if (!isWithin(root, candidate, target.platform, target.caseSensitive)) continue
      if (!rule.includeSelf && samePath(root, candidate, target)) continue
      return true
    }
  }
  return false
}

/**
 * Find the first path rule denying `operation` for `target`.
 * @param profile - the prepared profile in force.
 * @param operation - the file operation about to run.
 * @param target - the canonical target.
 * @returns the matching rule, or undefined when allowed.
 */
export function findDeniedPath(
  profile: PreparedProfile,
  operation: FileAccessOperation,
  target: CanonicalTarget,
): PathDenial | undefined {
  for (const rule of profile.paths) {
    if (!rule.operations.has(operation)) continue
    if (matchesRule(rule, target)) return { rule, target }
  }
  return undefined
}
