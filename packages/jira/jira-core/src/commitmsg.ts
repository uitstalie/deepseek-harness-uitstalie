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

/** The global pattern that finds every issue key in a commit message; group 1 is the key. */
export const KEY_PATTERN = /\b([A-Z][A-Z0-9]{1,5}-\d+)\b/gu
/** The first-line marker that deliberately opts a commit out of naming an issue. */
export const NO_ISSUE_MARKER = '[no-issue]'

/** Messages git wrote itself, which must not fail the check (decision 67). */
const EXEMPT_SUBJECT = /^(Merge |Revert "|Revert |fixup! |squash! )/u

/** The branch shape that carries a key: `DH-12-fix-the-thing`. */
const BRANCH_KEY = /^([A-Z][A-Z0-9]{1,5}-\d+)(?:[-/]|$)/u

/**
 * Find every issue key the message names, in order and without duplicates.
 * @param message - the commit message text.
 * @returns the distinct keys found, frozen; empty when the message names none.
 */
export const keysIn = (message: string): readonly IssueKey[] => {
  const found: IssueKey[] = []
  for (const match of message.matchAll(KEY_PATTERN)) {
    const key = asIssueKey(match[1] ?? '')
    if (key !== undefined && !found.includes(key)) found.push(key)
  }
  return Object.freeze(found)
}

/**
 * Take the subject line, which is where a key or `[no-issue]` must appear.
 * @param message - the commit message text.
 * @returns the text up to the first newline, or the empty string for an empty message.
 */
export const firstLine = (message: string): string => message.split('\n')[0] ?? ''

/**
 * Git leaves advice in comment lines (`# …`); they are not part of the message the author wrote
 * (decision 187: this rule used to live inline in the CLI's verify-commit-msg handler).
 * @param text - the raw contents of the commit message file.
 * @returns the message the author actually wrote, with git's `#` comment lines dropped.
 */
export const uncommentGitMessage = (text: string): string =>
  text.split('\n').filter(line => !line.startsWith('#')).join('\n')

/**
 * Decide whether git wrote the subject itself, in which case the author must not be asked to
 * rewrite it.
 * @param message - the commit message text.
 * @returns true for a `Merge`, `Revert`, `fixup!` or `squash!` subject.
 */
export const isExempt = (message: string): boolean => EXEMPT_SUBJECT.test(firstLine(message))

/**
 * Decide whether the message deliberately declares that it belongs to no issue.
 * @param message - the commit message text.
 * @returns true when the first line carries the `[no-issue]` marker.
 */
export const hasNoIssueMarker = (message: string): boolean => firstLine(message).includes(NO_ISSUE_MARKER)

/**
 * The key a branch name carries, for `prepare-commit-msg` to prefix (decision 67).
 * @param branch - the branch name to read.
 * @returns the key the name starts with, or undefined when it starts with none.
 */
export const branchKeyFrom = (branch: string): IssueKey | undefined =>
  asIssueKey(BRANCH_KEY.exec(branch.trim())?.[1] ?? '')

/**
 * Prefix the branch's key when the message has none. A message that already names a key — or that
 * carries `[no-issue]` — is left exactly as the author wrote it.
 * @param message - the message the author wrote.
 * @param branch - the branch being committed on.
 * @returns the message unchanged when it already names a key or opts out, else prefixed with the
 *   branch's key.
 */
export const applyBranchPrefix = (message: string, branch: string): string => {
  const key = branchKeyFrom(branch)
  if (key === undefined) return message
  if (keysIn(message).length > 0 || message.includes(NO_ISSUE_MARKER)) return message
  return `${key}: ${message}`
}

/**
 * The outcome of checking a message: accepted (keyed, deliberately issue-free, or exempt because
 * git wrote it), or refused with the reason and the keys involved.
 */
export type CommitVerdict =
  | Readonly<{ ok: true; kind: 'keyed'; keys: readonly IssueKey[] }>
  | Readonly<{ ok: true; kind: 'no-issue' }>
  | Readonly<{ ok: true; kind: 'exempt'; subject: string }>
  | Readonly<{ ok: false; reason: string; keys: readonly IssueKey[]; missing: readonly string[] }>

/**
 * What the caller knows beyond the message itself: the keys that exist, the branch it was
 * committed on, and git's own account of where the message came from.
 */
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
 * @param message - the commit message text to decide.
 * @param options - what the caller knows about existing keys, the branch, and the message source.
 * @returns the verdict, carrying the keys found or the reason the commit is refused.
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

/**
 * The message a human sees when the hook refuses, so the fix is obvious without a manual.
 * @param verdict - the verdict to render.
 * @param message - the message that was checked, shown back by its subject line.
 * @returns a one-line acceptance, or the refusal with the rule and an example.
 */
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
