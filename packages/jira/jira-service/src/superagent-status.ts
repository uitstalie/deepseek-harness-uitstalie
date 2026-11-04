/**
 * The read-only super-agent status: which issues can be taken, which proposals wait for a person,
 * and what is already in flight.
 *
 * This pure projection lives beside the Remote so the browser sees exactly the same classification
 * as the model tool `superagent_status`. The marker and the readiness rules are the ledger's
 * conventions, not service state.
 *
 * @module @deepseek-ai/dsh-jira-service/superagent-status
 */

import type { Issue, Timestamp } from '@deepseek-ai/dsh-jira-core'
import { leaseIsActive } from '@deepseek-ai/dsh-jira-core'

/** The marker the claim loop writes on a proposal comment. */
export const SUPERAGENT_PROPOSAL_MARKER = '[claim-proposal]'

/**
 * The marker a person's confirmation comment starts with.
 *
 * It must equal `jira-agent`'s `CLAIM_APPROVED_MARKER`: the service writes the credential the
 * model's `claim` consumes, and `packages/jira/tests/superagent-parity.spec.ts` fails when the two
 * strings drift (decision 210).
 */
export const SUPERAGENT_APPROVAL_MARKER = '[claim-approved]'

/** The only status that can be proposed or claimed. */
export const SUPERAGENT_CLAIMABLE_STATUS = 'todo'

/** What one human confirmation wrote to the ledger. */
export interface SuperagentConfirmView {
  /** The issue the confirmation was recorded on. */
  readonly key: string
  /** The `human:<name>` identity the ledger's `git user.name` produced. */
  readonly author: string
  /** True when the latest comment was already this person's approval, so nothing was appended. */
  readonly alreadyApproved: boolean
}

/** Where the super agent lives, as the profile and the workspace registry currently answer. */
export interface SuperagentSetupView {
  /** Whether a person has chosen a directory; false leaves the super agent off. */
  readonly configured: boolean
  /** The chosen directory, when one is configured. */
  readonly home?: string
  /** The workspace that owns the directory, when it is registered. */
  readonly workspaceId?: string
}

/** One issue row in the status view. */
export interface SuperagentStatusItem {
  readonly key: string
  readonly priority: string
  readonly summary: string
  readonly assignee?: string
  readonly reason?: string
}

/** The counts plus the rows a person may need to act on. */
export interface SuperagentStatusView {
  readonly counts: Readonly<{
    ready: number
    proposed: number
    inProgress: number
    inReview: number
    blocked: number
  }>
  readonly ready: readonly SuperagentStatusItem[]
  readonly proposed: readonly SuperagentStatusItem[]
  readonly inProgress: readonly SuperagentStatusItem[]
  readonly inReview: readonly SuperagentStatusItem[]
  readonly blocked: readonly SuperagentStatusItem[]
  readonly needsPerson: readonly SuperagentStatusItem[]
}

/** Whether an issue's `is_blocked_by` target is open or missing. */
const blockedNow = (issue: Issue, byKey: ReadonlyMap<string, Issue>, closed: readonly string[]): boolean =>
  issue.links.some((link) => {
    if (link.type !== 'is_blocked_by') return false
    const target = byKey.get(link.target)
    return target === undefined || !closed.includes(target.status)
  })

/** Whether an unstarted, unblocked, unleased issue can be taken. */
const claimableNow = (issue: Issue, blocked: boolean, at: Timestamp): boolean =>
  !blocked && issue.status === SUPERAGENT_CLAIMABLE_STATUS && !leaseIsActive(issue, at)

/** One row with the facts the panel shows. */
const itemOf = (issue: Issue, reason?: string): SuperagentStatusItem => Object.freeze({
  key: String(issue.key),
  priority: issue.priority,
  summary: issue.summary,
  ...(issue.assignee === undefined ? {} : { assignee: String(issue.assignee) }),
  ...(reason === undefined ? {} : { reason }),
})

/**
 * Project the ledger into the status view.
 * @param issues - every decoded issue.
 * @param commentsByKey - comments per issue, oldest first.
 * @param closed - the vocabulary's closed statuses.
 * @param at - the timestamp used for lease expiry.
 * @returns the counts and the rows that need a person.
 */
export const superagentStatusOf = (
  issues: readonly Issue[],
  commentsByKey: ReadonlyMap<string, readonly { readonly body: string }[]>,
  closed: readonly string[],
  at: Timestamp,
): SuperagentStatusView => {
  const byKey = new Map<string, Issue>(issues.map(issue => [String(issue.key), issue]))
  const ready: SuperagentStatusItem[] = []
  const proposed: SuperagentStatusItem[] = []
  const inProgress: SuperagentStatusItem[] = []
  const inReview: SuperagentStatusItem[] = []
  const blocked: SuperagentStatusItem[] = []
  for (const issue of issues) {
    if (closed.includes(issue.status)) continue
    const blockedFlag = blockedNow(issue, byKey, closed)
    const key = String(issue.key)
    if (claimableNow(issue, blockedFlag, at)) ready.push(itemOf(issue))
    if (issue.status === 'in_progress') inProgress.push(itemOf(issue))
    if (issue.status === 'in_review') inReview.push(itemOf(issue, 'review the delivery'))
    if (blockedFlag) blocked.push(itemOf(issue, 'an `is_blocked_by` target is still open or missing'))
    const latest = commentsByKey.get(key)?.at(-1)
    if (latest !== undefined && latest.body.trimStart().startsWith(SUPERAGENT_PROPOSAL_MARKER)) {
      proposed.push(itemOf(issue, 'confirm the proposal'))
    }
  }
  const needsPerson = Object.freeze([...proposed, ...inReview])
  return Object.freeze({
    counts: Object.freeze({
      ready: ready.length,
      proposed: proposed.length,
      inProgress: inProgress.length,
      inReview: inReview.length,
      blocked: blocked.length,
    }),
    ready: Object.freeze(ready),
    proposed: Object.freeze(proposed),
    inProgress: Object.freeze(inProgress),
    inReview: Object.freeze(inReview),
    blocked: Object.freeze(blocked),
    needsPerson,
  })
}

/** One recent ledger commit as the browser reads it. */
export interface SuperagentHistoryEntry {
  readonly sha: string
  readonly at: string
  readonly author: string
  readonly subject: string
}

/** Recent ledger commits, newest first. */
export interface SuperagentHistoryView {
  readonly entries: readonly SuperagentHistoryEntry[]
  /** True when older commits exist beyond the returned page. */
  readonly hasMore: boolean
}

/** One proposal comment: the event that asked a person to claim an issue. */
export interface SuperagentTrigger {
  readonly key: string
  readonly summary: string
  readonly author: string
  readonly at: string
  readonly body: string
  /** True when this is still the latest comment on the issue. */
  readonly active: boolean
}

/** Recent proposals, newest first. */
export interface SuperagentTriggersView {
  readonly entries: readonly SuperagentTrigger[]
  /** True when older proposals exist beyond the returned page. */
  readonly hasMore: boolean
}

type TriggerComment = Readonly<{
  id: string
  author: unknown
  createdAt: string
  body: string
}>

/**
 * Project the proposal comments into the trigger view.
 * @param issues - every decoded issue.
 * @param commentsByKey - comments per issue, oldest first.
 * @param limit - how many entries to keep.
 * @param before - only proposals older than this timestamp are returned; the page's cursor.
 * @returns the proposals, newest first.
 */
export const superagentTriggersOf = (
  issues: readonly Issue[],
  commentsByKey: ReadonlyMap<string, readonly TriggerComment[]>,
  limit: number,
  before?: string,
): SuperagentTriggersView => {
  const entries: SuperagentTrigger[] = []
  for (const issue of issues) {
    const comments = commentsByKey.get(String(issue.key)) ?? []
    for (const [index, comment] of comments.entries()) {
      if (!comment.body.trimStart().startsWith(SUPERAGENT_PROPOSAL_MARKER)) continue
      if (before !== undefined && comment.createdAt >= before) continue
      entries.push(Object.freeze({
        key: String(issue.key),
        summary: issue.summary,
        author: String(comment.author),
        at: comment.createdAt,
        body: comment.body,
        active: index === comments.length - 1,
      }))
    }
  }
  entries.sort((left, right) => left.at < right.at ? 1 : left.at > right.at ? -1 : 0)
  const size = Math.max(1, Math.min(50, limit))
  return Object.freeze({ entries: Object.freeze(entries.slice(0, size)), hasMore: entries.length > size })
}
