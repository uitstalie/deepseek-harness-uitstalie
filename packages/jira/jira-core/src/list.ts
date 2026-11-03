/**
 * core/list — what `jira_list` returns, computed purely (decision 53).
 *
 * The order is the contract: **project → the vocabulary's status order → priority ascending
 * (S1 first) → `updated` descending**, and **blocked issues are lifted out into their own group
 * at the end** so "ready to work on" and "waiting on somebody" are never mixed. A limit caps
 * what is returned, and the counts still describe everything that matched — a truncated answer
 * must not look like a small store (decision 53's "只回还有 N 条").
 *
 * "Blocked" is not decided here: `core/generate` owns that judgement for the board, and the list
 * reuses it so the two views cannot disagree about what ready means.
 */

import { type Issue, type IssueKey } from './entity.ts'
import { isBlocked } from './generate.ts'
import { queryIssues, type IssueQuery } from './inspect.ts'
import { type Vocab, statusOrder } from './vocab.ts'

/** How many issues `jira_list` returns when the caller names no `limit`. */
export const DEFAULT_LIST_LIMIT = 20
/** The largest `limit` a list accepts, so one call cannot return the whole store. */
export const MAX_LIST_LIMIT = 100

/** `jira_list`'s filters: the issue query plus the caller-resolved assignee and the result cap. */
export type ListQuery = IssueQuery & Readonly<{
  /** `'me'` is resolved by the caller (only it knows who is asking). */
  assignee?: string
  limit?: number
}>

/**
 * One row of a list: the fields a caller needs to act on the issue, plus whether it is blocked.
 */
export type ListItem = Readonly<{
  key: IssueKey
  project: string
  issueType: string
  status: string
  priority: string
  summary: string
  tags: readonly string[]
  assignee?: string
  updatedAt: string
  revision: number
  /** True when an `is_blocked_by` target is still open — or cannot be found at all. */
  blocked: boolean
}>

/**
 * A group of list items: a project-and-status section, or the single blocked section that spans
 * projects.
 */
export type ListGroup = Readonly<{
  name: string
  kind: 'status' | 'blocked'
  project: string
  /** Absent on the blocked group, which deliberately spans projects. */
  status?: string
  items: readonly ListItem[]
}>

/** What a list matched and returned, including how many the limit kept out. */
export type ListCounts = Readonly<{
  /** Everything that matched the filters, before the limit. */
  matched: number
  returned: number
  /** How many matched issues the limit kept out — the number the model must be told. */
  remaining: number
  byStatus: Readonly<Record<string, number>>
  blocked: number
}>

/** What `jira_list` returns: ordered items, the blocked group last, and counts over everything matched. */
export type ListResult = Readonly<{
  items: readonly ListItem[]
  groups: readonly ListGroup[]
  counts: ListCounts
  truncated: boolean
  limit: number
}>

/**
 * Keep a caller's `limit` inside the list's bounds.
 * @param limit - the value the caller asked for, if any.
 * @returns the default when it is absent or nonsensical, otherwise the value capped at the maximum.
 */
export const clampLimit = (limit: number | undefined): number => {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return DEFAULT_LIST_LIMIT
  return Math.min(Math.floor(limit), MAX_LIST_LIMIT)
}

const priorityRank = (vocab: Vocab, priority: string): number => {
  const index = vocab.priorities.indexOf(priority)
  // An unknown priority sorts last rather than first: the vocabulary is the authority.
  return index === -1 ? vocab.priorities.length + 1 : index
}

const toItem = (issue: Issue, blocked: boolean): ListItem =>
  Object.freeze({
    key: issue.key,
    project: issue.project,
    issueType: issue.issueType,
    status: issue.status,
    priority: issue.priority,
    summary: issue.summary,
    tags: issue.tags,
    ...(issue.assignee === undefined ? {} : { assignee: issue.assignee }),
    updatedAt: issue.updatedAt,
    revision: issue.revision,
    blocked,
  })

/**
 * Order and group the issues a caller already filtered.
 *
 * Blocked items are ordered last within the whole result, so `items` and `groups` read the same
 * way: everything ready, then everything waiting.
 * @param issues - the issues to filter and order.
 * @param vocab - the vocabulary that decides the status and priority order.
 * @param query - the filters, the resolved assignee, and the limit.
 * @returns the ordered items, the groups, and the counts over everything that matched.
 */
export const buildIssueList = (
  issues: readonly Issue[],
  vocab: Vocab,
  query: ListQuery = {},
): ListResult => {
  const matched = queryIssues(issues, query, vocab)
  const byKey = new Map(matched.map(issue => [String(issue.key), issue]))
  const limit = clampLimit(query.limit)

  const compare = (left: Issue, right: Issue): number => {
    const project = left.project.localeCompare(right.project)
    if (project !== 0) return project
    const status = statusOrder(vocab, left.status) - statusOrder(vocab, right.status)
    if (status !== 0) return status
    const priority = priorityRank(vocab, left.priority) - priorityRank(vocab, right.priority)
    if (priority !== 0) return priority
    // Same rank: the most recently touched first. Ties by key so the order is total (a list that
    // reorders itself at random is worse than one that is merely arbitrary).
    const updated = right.updatedAt.localeCompare(left.updatedAt)
    return updated !== 0 ? updated : String(left.key).localeCompare(String(right.key))
  }

  const ready = matched.filter(issue => !isBlocked(issue, byKey, vocab)).sort(compare)
  const waiting = matched.filter(issue => isBlocked(issue, byKey, vocab)).sort(compare)
  const ordered = [...ready, ...waiting]
  const kept = ordered.slice(0, limit)

  const items = kept.map(issue => toItem(issue, isBlocked(issue, byKey, vocab)))

  const groups: ListGroup[] = []
  for (const issue of kept) {
    if (isBlocked(issue, byKey, vocab)) continue
    const name = `${issue.project} · ${issue.status}`
    const existing = groups.find(group => group.name === name)
    const item = toItem(issue, false)
    if (existing === undefined) {
      groups.push(Object.freeze({ name, kind: 'status', project: issue.project, status: issue.status, items: Object.freeze([item]) }))
    } else {
      const index = groups.indexOf(existing)
      groups[index] = Object.freeze({ ...existing, items: Object.freeze([...existing.items, item]) })
    }
  }
  const blockedItems = items.filter(item => item.blocked)
  if (blockedItems.length > 0) {
    groups.push(Object.freeze({
      name: 'blocked (not ready)',
      kind: 'blocked',
      project: '*',
      items: Object.freeze(blockedItems),
    }))
  }

  const byStatus: Record<string, number> = {}
  for (const issue of matched) byStatus[issue.status] = (byStatus[issue.status] ?? 0) + 1

  return Object.freeze({
    items: Object.freeze(items),
    groups: Object.freeze(groups),
    counts: Object.freeze({
      matched: matched.length,
      returned: items.length,
      remaining: Math.max(0, matched.length - items.length),
      byStatus: Object.freeze(byStatus),
      blocked: waiting.length,
    }),
    truncated: matched.length > items.length,
    limit,
  })
}

/**
 * Decision 195 (trial feedback P2-4): a list shows a **short** identity, not the whole one.
 *
 * `agent:unknown|dsh|m-357504ff|session-…` on every row crowds out the summary; what a reader needs at a
 * glance is "which machine, which session". The full identity stays in `jira_issue get` (where it is the
 * subject, not decoration).
 * @param identity - the full identity string.
 * @returns the short form, or the identity unchanged when it does not parse.
 */
export const shortIdentity = (identity: string): string => {
  if (!identity.startsWith('agent:') && !identity.startsWith('human:')) return identity
  const parts = identity.split('|')
  if (parts.length < 4) return identity
  const machine = (parts[2] ?? '').replace(/^m-/u, '').slice(0, 8)
  const session = (parts[3] ?? '').replace(/^session-/u, '').slice(0, 8)
  const kind = identity.startsWith('human:') ? 'human' : 'agent'
  return `${kind}:${machine}${session === '' ? '' : `/${session}`}`
}

/**
 * The model-facing rendering: what is ready, what is waiting, and what the limit hid.
 * @param result - the list result to render.
 * @returns the grouped lines, or the sentence saying nothing matched.
 */
export const renderIssueListForModel = (result: ListResult): string => {
  if (result.items.length === 0) {
    return result.counts.matched === 0
      ? 'no issues match (0 matched)'
      : `no issues shown (${String(result.counts.matched)} matched but the limit is 0)`
  }
  const lines: string[] = []
  for (const group of result.groups) {
    lines.push(`${group.name} (${String(group.items.length)})`)
    for (const item of group.items) {
      const flags = [
        item.priority,
        item.assignee === undefined ? 'unassigned' : shortIdentity(item.assignee),
        ...(item.blocked ? ['blocked'] : []),
      ]
      lines.push(`  ${item.key}  ${flags.join('  ')}  ${item.summary}`)
    }
  }
  if (result.truncated) {
    lines.push(`… ${String(result.counts.remaining)} more match; raise \`limit\` (max ${String(MAX_LIST_LIMIT)}) or narrow the filters`)
  }
  return lines.join('\n')
}
