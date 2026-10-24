/**
 * Tests for core/list — the ordering and grouping contract of `jira_list` (decision 53).
 *
 * Synthetic issues, because the contract is about *order*: project → the vocabulary's status
 * order → priority ascending (S1 first) → most recently updated, with blocked work lifted into
 * its own group at the end. Every assertion here is a promise the tool makes to a model that
 * cannot see the store.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { type Identity, type Issue, type IssueKey, type Timestamp } from './entity.ts'
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, buildIssueList, clampLimit, shortIdentity, renderIssueListForModel } from './list.ts'
import { type Vocab, parseVocab } from './vocab.ts'

const vocab: Vocab = (() => {
  const parsed = parseVocab(readFileSync(new URL('../fixtures/config.md', import.meta.url), 'utf8'))
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error))
  return parsed.value
})()

/** A fixture issue with only the fields the ordering cares about spelled out. */
const issue = (over: Readonly<{
  key: string
  project?: string
  status?: string
  priority?: string
  updatedAt?: string
  tags?: readonly string[]
  assignee?: string
  blockedBy?: string
}>): Issue => Object.freeze({
  key: over.key as IssueKey,
  project: over.project ?? over.key.slice(0, over.key.lastIndexOf('-')),
  issueType: 'task',
  status: over.status ?? 'todo',
  summary: `summary of ${over.key}`,
  priority: over.priority ?? 'S3',
  tags: Object.freeze([...(over.tags ?? [])]),
  links: Object.freeze(over.blockedBy === undefined
    ? []
    : [Object.freeze({ type: 'is_blocked_by' as const, target: over.blockedBy as IssueKey })]),
  ...(over.assignee === undefined ? {} : { assignee: over.assignee as Identity }),
  revision: 1,
  createdAt: (over.updatedAt ?? '2026-10-15T12:00:00Z') as Timestamp,
  updatedAt: (over.updatedAt ?? '2026-10-15T12:00:00Z') as Timestamp,
  reporter: 'human:me' as Identity,
  kbRefs: Object.freeze([]),
  conflicted: false,
  body: '',
})

const keysOf = (result: ReturnType<typeof buildIssueList>): readonly string[] =>
  result.items.map(item => item.key)

describe('list: the order the contract promises', () => {
  it('sorts by project, then status order, then priority, then most recently updated', () => {
    const result = buildIssueList([
      issue({ key: 'ZZ-1', priority: 'S1' }),                                    // project last
      issue({ key: 'DH-1', status: 'in_review' }),                               // later status
      issue({ key: 'DH-2', priority: 'S5', updatedAt: '2026-10-15T18:00:00Z' }),
      issue({ key: 'DH-3', priority: 'S1', updatedAt: '2026-10-15T09:00:00Z' }),
      issue({ key: 'DH-4', priority: 'S1', updatedAt: '2026-10-15T17:00:00Z' }),
    ], vocab)

    // `todo` (order 10) before `in_review` (30); inside `todo`, S1 before S5; the two S1s by
    // newest `updatedAt` first. `ZZ` is a different project, so it comes after all of `DH`.
    assert.deepEqual(keysOf(result), ['DH-4', 'DH-3', 'DH-2', 'DH-1', 'ZZ-1'])
  })

  it('puts blocked work in its own group at the very end', () => {
    const result = buildIssueList([
      issue({ key: 'DH-1' }),
      issue({ key: 'DH-2', blockedBy: 'DH-1' }),   // blocked by an open issue
      issue({ key: 'DH-3', blockedBy: 'DH-9' }),   // blocked by one that does not exist
    ], vocab)

    // Ready first, then blocked — and inside each part the same comparator applies, so the two
    // blocked issues (identical status, priority and update time) fall back to their keys.
    assert.deepEqual(keysOf(result), ['DH-1', 'DH-2', 'DH-3'], 'blocked last, and a missing blocker counts')
    assert.deepEqual(result.items.map(item => item.blocked), [false, true, true])
    assert.equal(result.groups.at(-1)?.kind, 'blocked')
    assert.deepEqual(result.groups.at(-1)?.items.map(item => item.key), ['DH-2', 'DH-3'])
    assert.equal(result.counts.blocked, 2)
  })

  it('releases an issue once its blocker is closed', () => {
    const result = buildIssueList([
      issue({ key: 'DH-1', status: 'closed' }),
      issue({ key: 'DH-2', blockedBy: 'DH-1' }),
    ], vocab, { includeClosed: true })
    assert.deepEqual(keysOf(result), ['DH-2', 'DH-1'], 'the blocker is not blocking any more')
    assert.equal(result.items[0]?.blocked, false)
    assert.equal(result.groups.some(group => group.kind === 'blocked'), false)
  })

  it('groups by project and status, and every item appears in exactly one group', () => {
    const result = buildIssueList([
      issue({ key: 'DH-1' }),
      issue({ key: 'DH-2' }),
      issue({ key: 'KB-1', project: 'KB', status: 'in_progress' }),
    ], vocab)
    assert.deepEqual(result.groups.map(group => group.name), ['DH · todo', 'KB · in_progress'])
    for (const group of result.groups) {
      assert.equal(group.items.every(item => item.blocked === false), true)
    }
    const grouped = result.groups.flatMap(group => group.items.map(item => item.key))
    assert.deepEqual([...grouped].sort(), keysOf(result).slice().sort())
  })
})

describe('list: the limit and the counts', () => {
  const many = Array.from({ length: 25 }, (_, index) => issue({
    key: `DH-${String(index + 1)}`,
    updatedAt: `2026-10-15T${String(index % 24).padStart(2, '0')}:00:00Z`,
  }))

  it('defaults to 20, caps at 100, and refuses nonsense', () => {
    assert.equal(DEFAULT_LIST_LIMIT, 20)
    assert.equal(MAX_LIST_LIMIT, 100)
    assert.equal(clampLimit(undefined), 20)
    assert.equal(clampLimit(0), 20)
    assert.equal(clampLimit(-5), 20)
    assert.equal(clampLimit(3), 3)
    assert.equal(clampLimit(1000), 100)
    assert.equal(clampLimit(7.9), 7)
  })

  it('returns at most the limit and still counts everything that matched', () => {
    const result = buildIssueList(many, vocab)
    assert.equal(result.items.length, 20)
    assert.equal(result.truncated, true)
    assert.equal(result.counts.matched, 25)
    assert.equal(result.counts.returned, 20)
    assert.equal(result.counts.remaining, 5, 'the model must be told what it did not see')

    const all = buildIssueList(many, vocab, { limit: MAX_LIST_LIMIT })
    assert.equal(all.items.length, 25)
    assert.equal(all.truncated, false)
    assert.equal(all.counts.remaining, 0)
  })

  it('counts by status over everything that matched, not just what it returned', () => {
    const result = buildIssueList([
      issue({ key: 'DH-1' }),
      issue({ key: 'DH-2', status: 'in_progress' }),
      issue({ key: 'DH-3', status: 'closed' }),
    ], vocab, { includeClosed: true, limit: 1 })
    assert.deepEqual(result.counts.byStatus, { todo: 1, in_progress: 1, closed: 1 })
    assert.equal(result.counts.returned, 1)
  })
})

describe('list: the filters', () => {
  const issues = [
    issue({ key: 'DH-1', tags: ['windows', 'build'], assignee: 'human:daiqc' }),
    issue({ key: 'DH-2', tags: ['windows'] }),
    issue({ key: 'DH-3', status: 'closed' }),
    issue({ key: 'KB-1', project: 'KB', tags: ['windows'] }),
    // A separate issue for the link filter, so blocking does not colour the other expectations.
    issue({ key: 'DH-4', blockedBy: 'DH-1' }),
  ]

  it('narrows by project, status, tag and assignee', () => {
    assert.deepEqual(keysOf(buildIssueList(issues, vocab, { project: 'KB' })), ['KB-1'])
    assert.deepEqual(keysOf(buildIssueList(issues, vocab, { status: 'closed', includeClosed: true })), ['DH-3'])
    assert.deepEqual(keysOf(buildIssueList(issues, vocab, { tag: 'build' })), ['DH-1'])
    assert.deepEqual(keysOf(buildIssueList(issues, vocab, { assignee: 'human:daiqc' })), ['DH-1'])
    assert.deepEqual(keysOf(buildIssueList(issues, vocab, { assignee: 'human:nobody' })), [])
  })

  it('requires every listed tag, because that is what narrowing means', () => {
    assert.deepEqual(keysOf(buildIssueList(issues, vocab, { tags: ['windows'] })), ['DH-1', 'DH-2', 'KB-1'])
    assert.deepEqual(keysOf(buildIssueList(issues, vocab, { tags: ['windows', 'build'] })), ['DH-1'])
    assert.deepEqual(keysOf(buildIssueList(issues, vocab, { tags: ['windows', 'nope'] })), [])
  })

  it('filters by link type and target, and hides closed by default', () => {
    assert.deepEqual(
      keysOf(buildIssueList(issues, vocab, { link: { type: 'is_blocked_by', target: 'DH-1' } })),
      ['DH-4'],
    )
    // The default view: closed hidden, and the blocked issue last (decision 53).
    assert.deepEqual(keysOf(buildIssueList(issues, vocab, {})), ['DH-1', 'DH-2', 'KB-1', 'DH-4'])
    assert.equal(keysOf(buildIssueList(issues, vocab, { includeClosed: true })).includes('DH-3'), true)
  })

  it('says nothing rather than failing when nothing matches', () => {
    const result = buildIssueList(issues, vocab, { project: 'NOPE' })
    assert.deepEqual(result.items, [])
    assert.deepEqual(result.groups, [])
    assert.equal(result.counts.matched, 0)
    assert.equal(result.truncated, false)
  })
})

describe('list: the trial-feedback ergonomics (decision 195)', () => {
  it('shows a short identity, and keeps the full one for `get`', async () => {
    // P2-4: a full identity on every row crowds out the summary.
    assert.equal(shortIdentity('agent:unknown|dsh|m-357504ff|session-a9beb0bc'), 'agent:357504ff/a9beb0bc')
    assert.equal(shortIdentity('human:daiqc'), 'human:daiqc', 'a human identity has nothing to shorten')
    assert.equal(shortIdentity('agent:broken'), 'agent:broken', 'a malformed identity is printed as given')
  })

  it('says "0 matched" so an empty answer is distinguishable from a broken one', () => {
    // P3-1: the JSON already had `matched: 0`; the human/model text said only `no issues match`.
    const empty = renderIssueListForModel({
      items: [],
      groups: [],
      counts: { matched: 0, returned: 0, remaining: 0, byStatus: {}, blocked: 0 },
      truncated: false,
      limit: 20,
    })
    assert.equal(empty, 'no issues match (0 matched)')
  })
})
