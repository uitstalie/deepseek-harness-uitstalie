/**
 * Cross-package parity for the claim loop's classification (DH-515).
 *
 * The readiness rules exist in two places by accident of layering: `jira-agent` decides what the
 * model's `superagent_scan` / `superagent_claim` act on, and `jira-service` decides what the page
 * renders as ready. They are one external contract, and the two packages cannot depend on each
 * other, so this group-level suite reads both and fails when they disagree.
 *
 * @module @deepseek-ai/dsh-jira/tests/superagent-parity
 */

import { describe, expect, it } from 'vitest'
import type { Issue, IssueKey, Timestamp } from '../jira-core/src/index.ts'
import { CLAIMABLE_STATUS, PROPOSAL_MARKER, claimability, isBlocked } from '../jira-agent/src/index.ts'
import { SUPERAGENT_CLAIMABLE_STATUS, SUPERAGENT_PROPOSAL_MARKER, superagentStatusOf } from '../jira-service/src/index.ts'

/** The instant every lease is judged against. */
const AT = '2026-11-02T09:00:00Z' as Timestamp

/** A `todo` issue with no links, no claim and an empty body. */
const issue = (
  overrides: Partial<Omit<Issue, 'assignee'>> & { readonly assignee?: Issue['assignee'] } = {},
): Issue => {
  const { assignee, ...rest } = overrides
  return {
    key: 'DH-1' as IssueKey,
    project: 'DH',
    issueType: 'task',
    status: 'todo',
    summary: 'an issue',
    priority: 'S3',
    tags: [],
    links: [],
    revision: 1,
    createdAt: AT,
    updatedAt: AT,
    reporter: 'human:daiqc' as Issue['reporter'],
    kbRefs: [],
    conflicted: false,
    body: '',
    ...rest,
    ...(assignee === undefined ? {} : { assignee }),
  }
}

/** The cases the two implementations must classify the same way. */
const CASES: readonly Readonly<{ name: string; issue: Issue }>[] = [
  { name: 'a free todo issue', issue: issue({ key: 'DH-1' as IssueKey }) },
  { name: 'an issue already in progress', issue: issue({ key: 'DH-2' as IssueKey, status: 'in_progress' }) },
  { name: 'an issue waiting for review', issue: issue({ key: 'DH-3' as IssueKey, status: 'in_review' }) },
  {
    name: 'an issue blocked by an open one',
    issue: issue({ key: 'DH-4' as IssueKey, links: [{ type: 'is_blocked_by', target: 'DH-1' as IssueKey }] }),
  },
  {
    name: 'an issue whose blocker is closed',
    issue: issue({ key: 'DH-5' as IssueKey, links: [{ type: 'is_blocked_by', target: 'DH-9' as IssueKey }] }),
  },
  {
    name: 'a held issue',
    issue: issue({ key: 'DH-6' as IssueKey, assignee: 'agent:m|dsh|a1b2c3d4|s' as Issue['assignee'], leaseExpiresAt: '2026-11-02T10:00:00Z' as Timestamp }),
  },
  {
    name: 'a claim whose lease expired',
    issue: issue({ key: 'DH-7' as IssueKey, assignee: 'agent:m|dsh|a1b2c3d4|s' as Issue['assignee'], leaseExpiresAt: '2026-11-02T08:00:00Z' as Timestamp }),
  },
  { name: 'a closed issue', issue: issue({ key: 'DH-8' as IssueKey, status: 'closed', resolution: 'fixed' }) },
]

/** Every issue the cases reference, including the blocker target. */
const ISSUES: readonly Issue[] = Object.freeze([
  ...CASES.map(entry => entry.issue),
  issue({ key: 'DH-9' as IssueKey, status: 'closed', resolution: 'fixed' }),
])

/** The vocabulary's closed statuses, as every surface reads them. */
const CLOSED: readonly string[] = Object.freeze(['closed', 'cancelled'])

describe('superagent classification parity', () => {
  it('agrees on the marker and the claimable status', () => {
    expect(PROPOSAL_MARKER).toBe(SUPERAGENT_PROPOSAL_MARKER)
    expect(CLAIMABLE_STATUS).toBe(SUPERAGENT_CLAIMABLE_STATUS)
  })

  it.each(CASES.map(entry => [entry.name, entry] as const))('classifies %s the same way', (_name, entry) => {
    const byKey = new Map<string, Issue>(ISSUES.map(candidate => [String(candidate.key), candidate]))
    const agentReady = claimability(entry.issue, isBlocked(entry.issue, byKey, CLOSED), AT).ready
    const view = superagentStatusOf(ISSUES, new Map(), CLOSED, AT)
    const serviceReady = view.ready.some(row => row.key === String(entry.issue.key))
    expect(agentReady).toBe(serviceReady)
  })
})
