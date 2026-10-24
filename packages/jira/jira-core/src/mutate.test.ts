/**
 * Tests for core/mutate — the whole state-change rulebook, in pure functions.
 *
 * Everything the write path promises is here: defaults, the transition table, the
 * resolution rules (required inside the closed set, cleared on the way out, and the
 * automatic comment that records what was cleared), revision accounting, and the fact
 * that a change never touches the object it came from.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { type Identity, type Issue, type Timestamp } from './entity.ts'
import {
  type ChangeContext,
  applyAssignee,
  applyComment,
  applyTransition,
  applyUpdate,
  applyAckConflict,
  combineChanges,
  createIssue,
  initialStatus, renewAssigneeLease, leaseIsActive,
} from './mutate.ts'
import { parseVocab } from './vocab.ts'

const vocab = (() => {
  const parsed = parseVocab(readFileSync(new URL('../fixtures/config.md', import.meta.url), 'utf8'))
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error))
  return parsed.value
})()

const ctx: ChangeContext = Object.freeze({
  vocab,
  knownTags: Object.freeze([{ name: 'demo' }, { name: 'windows' }]),
  at: '2026-10-15T12:00:00Z' as Timestamp,
  by: 'human:daiqc' as Identity,
})

const later: ChangeContext = Object.freeze({ ...ctx, at: '2026-10-15T13:00:00Z' as Timestamp })

type Unwrappable<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string; context?: Record<string, unknown> } }

const unwrap = <T>(result: Unwrappable<T>): T => {
  assert.equal(result.ok, true, `expected success, got ${JSON.stringify(result)}`)
  if (!result.ok) throw new Error('unreachable')
  return result.value
}

const failure = (result: { ok: boolean; error?: { code: string; message: string; context?: Record<string, unknown> } }) => {
  assert.equal(result.ok, false, 'expected a failure')
  assert.ok(result.error !== undefined)
  return result.error
}

const freshIssue = (): Issue =>
  unwrap(createIssue({ key: 'DH-1', issueType: 'task', summary: 'first', tags: ['demo'], body: 'body\n' }, ctx)).issue

describe('mutate: create', () => {
  it('applies the defaults the vocabulary implies', () => {
    assert.equal(initialStatus(vocab), 'todo')
    const { issue, comments } = unwrap(createIssue({ key: 'DH-1', issueType: 'task', summary: 'first' }, ctx))
    assert.equal(issue.status, 'todo')
    assert.equal(issue.priority, 'S3')
    assert.equal(issue.revision, 1)
    assert.equal(issue.reporter, 'human:daiqc')
    assert.equal(issue.createdAt, ctx.at)
    assert.equal(issue.updatedAt, ctx.at)
    assert.equal(issue.conflicted, false)
    assert.deepEqual(issue.links, [])
    assert.deepEqual(comments, [])
    assert.equal(issue.project, 'DH')
  })

  it('refuses a key, summary, type, priority, status or tag the store does not accept', () => {
    const cases: readonly (readonly [Record<string, unknown>, string])[] = [
      [{ key: 'nope', issueType: 'task', summary: 'x' }, 'not an issue key'],
      [{ key: 'DH-1', issueType: 'task', summary: '' }, 'must not be empty'],
      [{ key: 'DH-1', issueType: 'task', summary: 'x'.repeat(121) }, 'at most 120'],
      [{ key: 'DH-1', issueType: 'chore', summary: 'x' }, 'issue_type "chore"'],
      [{ key: 'DH-1', issueType: 'task', summary: 'x', priority: 'P1' }, 'priority "P1"'],
      [{ key: 'DH-1', issueType: 'task', summary: 'x', status: 'done' }, 'unknown status "done"'],
      [{ key: 'DH-1', issueType: 'task', summary: 'x', tags: ['nope'] }, 'unknown tag "nope"'],
      [{ key: 'DH-1', issueType: 'task', summary: 'x', tags: ['Bad Tag'] }, 'lower-kebab'],
    ]
    for (const [input, needle] of cases) {
      const error = failure(createIssue(input as never, ctx))
      assert.match(error.message, new RegExp(needle), `for ${JSON.stringify(input)}`)
    }
  })

  it('refuses to create an issue that is already closed', () => {
    const error = failure(createIssue({ key: 'DH-1', issueType: 'task', summary: 'x', status: 'closed' }, ctx))
    assert.equal(error.code, 'RESOLUTION_REQUIRED')
  })

  it('suggests the nearest tags when one is unknown', () => {
    const error = failure(createIssue({ key: 'DH-1', issueType: 'task', summary: 'x', tags: ['windwos'] }, ctx))
    assert.equal(error.code, 'UNKNOWN_TAG')
    assert.deepEqual(error.context?.suggestions, ['windows'])
  })
})

describe('mutate: update advances revision only when something really changed', () => {
  it('bumps revision and updatedAt on a real change', () => {
    const before = freshIssue()
    const { issue } = unwrap(applyUpdate(before, { summary: 'second' }, later))
    assert.equal(issue.summary, 'second')
    assert.equal(issue.revision, before.revision + 1)
    assert.equal(issue.updatedAt, later.at)
    assert.equal(issue.createdAt, before.createdAt)
  })

  it('leaves revision alone for a no-op', () => {
    const before = freshIssue()
    const { issue } = unwrap(applyUpdate(before, { summary: before.summary, tags: ['demo'] }, later))
    assert.equal(issue.revision, before.revision)
    assert.equal(issue.updatedAt, before.updatedAt)
    assert.equal(issue, before, 'a no-op returns the very same object')
  })

  it('treats a note change as a body change (decision 51) and can clear the note', () => {
    const before = freshIssue()
    const noted = unwrap(applyUpdate(before, { note: 'remember this' }, later)).issue
    assert.equal(noted.note, 'remember this')
    assert.equal(noted.revision, before.revision + 1)
    const cleared = unwrap(applyUpdate(noted, { note: null }, later)).issue
    assert.equal('note' in cleared, false)
    assert.equal(cleared.revision, noted.revision + 1)
  })

  it('validates what it is given', () => {
    const before = freshIssue()
    assert.match(failure(applyUpdate(before, { summary: 'x'.repeat(200) }, ctx)).message, /at most 120/)
    assert.match(failure(applyUpdate(before, { tags: ['nope'] }, ctx)).message, /unknown tag/)
    assert.match(failure(applyUpdate(before, { priority: 'P9' }, ctx)).message, /priority "P9"/)
  })

  it('never edits the issue it was given', () => {
    const before = freshIssue()
    const snapshot = JSON.stringify(before)
    unwrap(applyUpdate(before, { summary: 'changed', tags: ['windows'] }, later))
    assert.equal(JSON.stringify(before), snapshot)
    assert.equal(Object.isFrozen(before), true)
  })
})

describe('mutate: switch_state follows the table and the resolution rules', () => {
  // 2026-10-19 ruling: closing must go through in_progress, so "a closed issue" in these tests
  // means todo → in_progress → closed.
  const inProgress = (): Issue => unwrap(applyTransition(freshIssue(), 'in_progress', {}, ctx)).issue

  it('moves along a declared edge and counts it as a change', () => {
    const before = freshIssue()
    const { issue, comments } = unwrap(applyTransition(before, 'in_progress', {}, later))
    assert.equal(issue.status, 'in_progress')
    assert.equal(issue.revision, before.revision + 1)
    assert.equal(issue.updatedAt, later.at)
    assert.deepEqual(comments, [])
  })

  it('refuses an edge the store does not declare, and says which ones it does', () => {
    const error = failure(applyTransition(freshIssue(), 'in_review', {}, ctx))
    assert.equal(error.code, 'INVALID_TRANSITION')
    assert.deepEqual(error.context?.allowed, ['in_progress', 'cancelled'])
  })

  it('refuses to close straight from todo — closing goes through in_progress (2026-10-19 ruling)', () => {
    const error = failure(applyTransition(freshIssue(), 'closed', { resolution: 'fixed' }, ctx))
    assert.equal(error.code, 'INVALID_TRANSITION')
    assert.deepEqual(error.context?.allowed, ['in_progress', 'cancelled'])
  })

  it('refuses a switch to the status it is already in', () => {
    assert.match(failure(applyTransition(freshIssue(), 'todo', {}, ctx)).message, /already the status/)
  })

  it('requires a resolution to enter the closed set, and one that exists', () => {
    const missing = failure(applyTransition(inProgress(), 'closed', {}, ctx))
    assert.equal(missing.code, 'RESOLUTION_REQUIRED')
    assert.deepEqual(missing.context?.resolutions, ['fixed', 'invalid', 'limitation', 'abandoned'])

    const bogus = failure(applyTransition(inProgress(), 'closed', { resolution: 'done' }, ctx))
    assert.match(bogus.message, /resolution "done"/)
  })

  it('requires an explanatory note when the resolution is "limitation"', () => {
    const error = failure(applyTransition(inProgress(), 'closed', { resolution: 'limitation' }, ctx))
    assert.match(error.message, /resolution_note is required/)
    const okCase = unwrap(applyTransition(
      inProgress(),
      'closed',
      { resolution: 'limitation', resolutionNote: 'needs a kernel patch' },
      ctx,
    )).issue
    assert.equal(okCase.resolution, 'limitation')
    assert.equal(okCase.resolutionNote, 'needs a kernel patch')
  })

  it('clears the conclusion on reopen and records what it was (decision 72)', () => {
    const closed = unwrap(applyTransition(inProgress(), 'closed', { resolution: 'limitation', resolutionNote: 'blocked' }, ctx)).issue
    assert.equal(closed.resolution, 'limitation')

    const { issue, comments } = unwrap(applyTransition(closed, 'in_progress', {}, later))
    assert.equal(issue.status, 'in_progress')
    assert.equal('resolution' in issue, false)
    assert.equal('resolutionNote' in issue, false)
    assert.equal(comments.length, 1)
    assert.match(comments[0]?.body ?? '', /reopened/)
    assert.match(comments[0]?.body ?? '', /limitation/)
    assert.equal(comments[0]?.author, 'human:daiqc')
    assert.equal(comments[0]?.createdAt, later.at)
  })

  it('refuses to carry a resolution into a status that is not closed', () => {
    const error = failure(applyTransition(freshIssue(), 'in_progress', { resolution: 'fixed' }, ctx))
    assert.match(error.message, /must not carry a resolution/)
  })

  it('accepts the reopen edges the store declares', () => {
    const cancelled = unwrap(applyTransition(freshIssue(), 'cancelled', { resolution: 'abandoned' }, ctx)).issue
    const reopened = unwrap(applyTransition(cancelled, 'todo', {}, later)).issue
    assert.equal(reopened.status, 'todo')
    assert.equal('resolution' in reopened, false)
  })
})

describe('mutate: acknowledging a conflict (decision 71)', () => {
  it('clears the flag and counts as a change', () => {
    const conflicted = Object.freeze({ ...freshIssue(), conflicted: true })
    const { issue } = unwrap(applyAckConflict(conflicted, later))
    assert.equal(issue.conflicted, false)
    assert.equal(issue.revision, conflicted.revision + 1)
    assert.equal(issue.updatedAt, later.at)
    assert.equal(conflicted.conflicted, true, 'the input is untouched')
  })

  it('is a no-op on an issue that is not conflicted', () => {
    const clean = freshIssue()
    const { issue } = unwrap(applyAckConflict(clean, later))
    assert.equal(issue, clean)
    assert.equal(issue.revision, clean.revision)
  })

  it('combines with the change the caller actually wanted', () => {
    const conflicted = Object.freeze({ ...freshIssue(), conflicted: true })
    const acked = unwrap(applyAckConflict(conflicted, later))
    const updated = unwrap(applyUpdate(acked.issue, { summary: 'after the ack' }, later))
    const combined = combineChanges(acked, updated)
    assert.equal(combined.issue.conflicted, false)
    assert.equal(combined.issue.summary, 'after the ack')
    assert.deepEqual(combined.comments, [])
  })
})
describe('mutate: kb_refs are the other side of decision 75', () => {
  it('accepts knowledge keys, and counts the change', () => {
    const before = freshIssue()
    const { issue } = unwrap(applyUpdate(before, { kbRefs: ['KB-1', 'KB-2'] }, later))
    assert.deepEqual(issue.kbRefs, ['KB-1', 'KB-2'])
    assert.equal(issue.revision, before.revision + 1)
  })

  it('refuses anything that is not a knowledge key, writing nothing', () => {
    const before = freshIssue()
    const error = failure(applyUpdate(before, { kbRefs: ['DH-1'] }, later))
    assert.match(error.message, /kb_refs entry "DH-1" is not a knowledge key/)
    assert.deepEqual(before.kbRefs, [])
  })

  it('clears them with an empty list, which is a change like any other', () => {
    const withRefs = unwrap(applyUpdate(freshIssue(), { kbRefs: ['KB-1'] }, later)).issue
    const cleared = unwrap(applyUpdate(withRefs, { kbRefs: [] }, later)).issue
    assert.deepEqual(cleared.kbRefs, [])
    assert.equal(cleared.revision, withRefs.revision + 1)
  })
})
describe('mutate: comments and assignee', () => {
  it('a comment never touches the issue (decision 44)', () => {
    const before = freshIssue()
    const { issue, comments } = unwrap(applyComment(before, 'looked at it', later))
    assert.equal(issue, before)
    assert.equal(issue.revision, before.revision)
    assert.equal(comments.length, 1)
    assert.deepEqual(comments[0], { body: 'looked at it', author: 'human:daiqc', createdAt: later.at })

    assert.match(failure(applyComment(before, '   ', ctx)).message, /must not be empty/)
  })

  it('assigns, releases, and counts both as changes', () => {
    const before = freshIssue()
    const claimed = unwrap(applyAssignee(before, 'human:daiqc' as Identity, later)).issue
    assert.equal(claimed.assignee, 'human:daiqc')
    assert.equal(claimed.revision, before.revision + 1)

    const released = unwrap(applyAssignee(claimed, null, later)).issue
    assert.equal('assignee' in released, false)
    assert.equal(released.revision, claimed.revision + 1)

    const noop = unwrap(applyAssignee(released, null, later))
    assert.equal(noop.issue.revision, released.revision)
  })
})

describe('mutate: the claim lease (decision 61, 4.8)', () => {
  const holder = 'agent:one|dsh|m-a|s-1' as Identity
  const other = 'agent:two|dsh|m-b|s-2' as Identity

  it('starts a two hour lease when claiming, and clears it when releasing', () => {
    const claimed = unwrap(applyAssignee(freshIssue(), holder, later)).issue
    assert.equal(claimed.assignee, holder)
    assert.equal(claimed.claimedAt, later.at)
    assert.equal(claimed.leaseExpiresAt, '2026-10-15T15:00:00Z', 'claimed_at + 2 h, to the second')

    const released = unwrap(applyAssignee(claimed, null, later)).issue
    assert.equal(released.assignee, undefined)
    assert.equal(released.claimedAt, undefined)
    assert.equal(released.leaseExpiresAt, undefined)
  })

  it('keeps a second agent off an issue whose lease is still live', () => {
    const claimed = unwrap(applyAssignee(freshIssue(), holder, later)).issue
    const refused = applyAssignee(claimed, other, later)
    assert.equal(refused.ok, false)
    if (!refused.ok) {
      assert.match(refused.error.message, /is claimed by agent:one\|dsh\|m-a\|s-1 until 2026-10-15T15:00:00Z/)
      assert.match(refused.error.message, /wait for the lease to lapse/)
    }
  })

  it('lets a newcomer take over a lease that lapsed, and records it as a comment', () => {
    const claimed = unwrap(applyAssignee(freshIssue(), holder, later)).issue
    const afterwards: ChangeContext = Object.freeze({ ...ctx, by: other, at: '2026-10-15T16:30:00Z' as Timestamp })
    const taken = unwrap(applyAssignee(claimed, other, afterwards))
    assert.equal(taken.issue.assignee, other)
    assert.equal(taken.issue.claimedAt, '2026-10-15T16:30:00Z')
    assert.equal(taken.issue.leaseExpiresAt, '2026-10-15T18:30:00Z')
    assert.equal(taken.comments.length, 1, 'the lapse is recorded inside the write (decision 38)')
    assert.match(taken.comments[0]?.body ?? '', /lapsed at 2026-10-15T15:00:00Z/)
  })

  it('renewing only ever extends, and never touches the revision', () => {
    const claimed = unwrap(applyAssignee(freshIssue(), holder, later)).issue
    const renewed = renewAssigneeLease(claimed, '2026-10-15T14:00:00Z' as Timestamp)
    assert.equal(renewed.leaseExpiresAt, '2026-10-15T16:00:00Z')
    assert.equal(renewed.claimedAt, claimed.claimedAt, 'when it was taken does not move')
    assert.equal(renewed.revision, claimed.revision, 'a lease is metadata, not body (decision 44)')

    // A later write that would shorten the lease is ignored: extensions are monotonic.
    const extended = renewAssigneeLease(renewed, '2026-10-15T15:00:00Z' as Timestamp)
    assert.equal(extended.leaseExpiresAt, '2026-10-15T17:00:00Z')
    const backwards = renewAssigneeLease(extended, '2026-10-15T14:30:00Z' as Timestamp)
    assert.equal(backwards.leaseExpiresAt, extended.leaseExpiresAt)

    // An unassigned issue has no lease to renew.
    assert.equal(renewAssigneeLease(freshIssue(), later.at).leaseExpiresAt, undefined)
  })

  it('reports whether a lease is live', () => {
    const claimed = unwrap(applyAssignee(freshIssue(), holder, later)).issue
    assert.equal(leaseIsActive(claimed, '2026-10-15T14:59:59Z' as Timestamp), true)
    assert.equal(leaseIsActive(claimed, '2026-10-15T15:00:00Z' as Timestamp), false, 'the boundary is expired')
    assert.equal(leaseIsActive(freshIssue(), later.at), false)
  })
})

describe('mutate: claiming a blocked issue (decision 24)', () => {
  const agent = 'agent:one|dsh|m-a|s-1' as Identity
  const human = 'human:daiqc' as Identity

  it('refuses an agent while a blocker is open, naming the blocker', () => {
    const refused = applyAssignee(freshIssue(), agent, { ...ctx, by: agent, blockers: ['DH-9'] })
    assert.equal(refused.ok, false)
    if (!refused.ok) {
      assert.equal(refused.error.code, 'BLOCKED_BY_OPEN')
      assert.match(refused.error.message, /blocked by DH-9, which is not closed/)
      assert.deepEqual(refused.error.context?.blockers, ['DH-9'])
    }
  })

  it('does not stand in a human way', () => {
    const claimed = unwrap(applyAssignee(freshIssue(), human, { ...ctx, by: human, blockers: ['DH-9'] }))
    assert.equal(claimed.issue.assignee, human)
  })

  it('lets an explicit override through, and records it as a comment', () => {
    const taken = unwrap(applyAssignee(freshIssue(), agent, { ...ctx, by: agent, blockers: ['DH-9'], override: true }))
    assert.equal(taken.issue.assignee, agent)
    assert.equal(taken.comments.length, 1)
    assert.match(taken.comments[0]?.body ?? '', /while it is still blocked by DH-9 \(explicit override, decision 24\)/)
  })

  it('says nothing when there is no blocker', () => {
    const claimed = unwrap(applyAssignee(freshIssue(), agent, { ...ctx, by: agent, blockers: [] }))
    assert.equal(claimed.issue.assignee, agent)
    assert.equal(claimed.comments.length, 0)
  })
})
