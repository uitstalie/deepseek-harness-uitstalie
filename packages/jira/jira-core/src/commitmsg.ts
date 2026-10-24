/**
 * core/commitmsg — the commit binding rules (decision 67).
 *
 * The design makes git the audit log, which only works if commits say **which issue they belong
 * to**. That is enforced by a `commit-msg` hook, and the rules are small enough to state exactly:
 *
 *   - a key is `\b([A-Z][A-Z0-9]{1,5}-\d+)\b`, and **every** key in the message must exist;
 *   - `[no-issue]` is the deliberate escape hatch, and it must be on the **first line** (so it is
 *     visible in `git log --oneline`, not buried in a body nobody reads);
 *   - `Merge` / `Revert` / `fixup!` / `squash!` are exempt, because git writes those messages and
 *     rewriting them is not the author's job;
 *   - `prepare-commit-msg` prefixes the key taken from a branch named `DH-12-something`, so the
 *     common case needs no typing.
 *
 * Pure: the caller supplies the message and (when it wants existence checked) the set of keys that
 * exist. Nothing here reads the store or the repository.
 */

import { type IssueKey, asIssueKey } from './entity.ts'

export const KEY_PATTERN = /\b([A-Z][A-Z0-9]{1,5}-\d+)\b/gu
export const NO_ISSUE_MARKER = '[no-issue]'

/** Messages git wrote itself, which must not fail the check (decision 67). */
const EXEMPT_SUBJECT = /^(Merge |Revert "|Revert |fixup! |squash! )/u

/** The branch shape that carries a key: `DH-12-fix-the-thing`. */
const BRANCH_KEY = /^([A-Z][A-Z0-9]{1,5}-\d+)(?:[-/]|$)/u

export const keysIn = (message: string): readonly IssueKey[] => {
  const found: IssueKey[] = []
  for (const match of message.matchAll(KEY_PATTERN)) {
    const key = asIssueKey(match[1] ?? '')
    if (key !== undefined && !found.includes(key)) found.push(key)
  }
  return Object.freeze(found)
}

export const firstLine = (message: string): string => message.split('\n')[0] ?? ''

/**
 * Git leaves advice in comment lines (`# …`); they are not part of the message the author wrote
 * (decision 187: this rule used to live inline in the CLI's verify-commit-msg handler).
 */
export const uncommentGitMessage = (text: string): string =>
  text.split('\n').filter(line => !line.startsWith('#')).join('\n')

export const isExempt = (message: string): boolean => EXEMPT_SUBJECT.test(firstLine(message))

export const hasNoIssueMarker = (message: string): boolean => firstLine(message).includes(NO_ISSUE_MARKER)

/** The key a branch name carries, for `prepare-commit-msg` to prefix (decision 67). */
export const branchKeyFrom = (branch: string): IssueKey | undefined =>
  asIssueKey(BRANCH_KEY.exec(branch.trim())?.[1] ?? '')

/**
 * Prefix the branch's key when the message has none. A message that already names a key — or that
 * carries `[no-issue]` — is left exactly as the author wrote it.
 */
export const applyBranchPrefix = (message: string, branch: string): string => {
  const key = branchKeyFrom(branch)
  if (key === undefined) return message
  if (keysIn(message).length > 0 || message.includes(NO_ISSUE_MARKER)) return message
  return `${key}: ${message}`
}

export type CommitVerdict =
  | Readonly<{ ok: true; kind: 'keyed'; keys: readonly IssueKey[] }>
  | Readonly<{ ok: true; kind: 'no-issue' }>
  | Readonly<{ ok: true; kind: 'exempt'; subject: string }>
  | Readonly<{ ok: false; reason: string; keys: readonly IssueKey[]; missing: readonly string[] }>

export type CheckOptions = Readonly<{
  /** Every issue key that exists; when omitted, existence is not checked. */
  knownKeys?: ReadonlySet<string>
  /** The branch, so a key the author relied on being prefixed is still found. */
  branch?: string
  /** git's commit source (`message`, `template`, `merge`, `squash`, `commit`), when it says. */
  source?: string
}>

/**
 * Decide a commit message's fate.
 *
 * Existence is checked for **every** key in the message (decision 67): a message that mentions
 * `DH-12` and `DH-99` must not pass on the strength of the first one.
 */
export const checkCommitMessage = (message: string, options: CheckOptions = {}): CommitVerdict => {
  // git tells us where the message came from; a merge or a squash message is not the author's to fix
  // (decision 67). `commit` (i.e. `-C`/`-c`) is deliberately **not** exempt: the reused message is
  // still validated, which is what caught nothing at all until the argument count was fixed.
  if (options.source === 'merge' || options.source === 'squash') {
    return Object.freeze({ ok: true, kind: 'exempt', subject: firstLine(message) })
  }
  if (isExempt(message)) return Object.freeze({ ok: true, kind: 'exempt', subject: firstLine(message) })

  const keys = keysIn(message)
  if (hasNoIssueMarker(message)) return Object.freeze({ ok: true, kind: 'no-issue' })
  if (keys.length === 0) {
    const fromBranch = options.branch === undefined ? undefined : branchKeyFrom(options.branch)
    return Object.freeze({
      ok: false,
      reason: fromBranch === undefined
        ? 'no issue key in the first line and no [no-issue] marker'
        : `no issue key; the branch is ${fromBranch}, so it should have been prefixed`,
      keys: Object.freeze([]),
      missing: Object.freeze([]),
    })
  }

  const known = options.knownKeys
  const missing = known === undefined ? [] : keys.filter(key => !known.has(key))
  if (missing.length > 0) {
    return Object.freeze({
      ok: false,
      reason: `these keys do not exist: ${missing.join(', ')}`,
      keys,
      missing: Object.freeze([...missing]),
    })
  }

  return Object.freeze({ ok: true, kind: 'keyed', keys })
}

/** The message a human sees when the hook refuses, so the fix is obvious without a manual. */
export const renderVerdict = (verdict: CommitVerdict, message: string): string => {
  if (verdict.ok) return `ok (${verdict.kind})`
  return [
    `commit refused: ${verdict.reason}`,
    '',
    'Every commit must name the issue it belongs to, or say [no-issue] on the first line.',
    '  DH-12: fix the wake lock',
    '  chore: bump the toolchain [no-issue]',
    '',
    `subject: ${firstLine(message)}`,
  ].join('\n')
}
