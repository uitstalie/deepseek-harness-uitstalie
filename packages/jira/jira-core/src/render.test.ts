/**
 * Tests for the lease's *model-facing* half (§4.8, decisions 61/93).
 *
 * The design is explicit that an expired claim must be **told to the model** as "expired,
 * reclaimable" — a lease nobody reports is a lease that stalls an issue. These are pure functions, so
 * the clock is a parameter and the cases are the three states: none, live, lapsed.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { type Identity, type Issue, type Timestamp } from './entity.ts'
import { MODEL_TEXT_BUDGET, clampText, fromWire, leaseNote, renderIssueHuman, renderIssueJson, toWire, withLocalTime } from './render.ts'

const AT = '2026-10-15T12:00:00Z' as Timestamp

const issue = (overrides: Partial<Issue> = {}): Issue => Object.freeze({
  key: 'DH-1' as Issue['key'],
  project: 'DH',
  issueType: 'task',
  status: 'todo',
  summary: 'a leased issue',
  priority: 'S3',
  tags: Object.freeze([]),
  links: Object.freeze([]),
  revision: 1,
  createdAt: AT,
  updatedAt: AT,
  reporter: 'human:daiqc' as Identity,
  kbRefs: Object.freeze([]),
  conflicted: false,
  body: '',
  ...overrides,
})

describe('render: the lease, said out loud (decision 61)', () => {
  it('says nothing when nobody holds the issue', () => {
    assert.equal(leaseNote(issue()), undefined)
    assert.equal(leaseNote(issue({ leaseExpiresAt: AT })), undefined, 'a lease without a holder is not a claim')
  })

  it('names the holder and the expiry while the lease is live', () => {
    const leased = issue({ assignee: 'agent:one|dsh|m-a|s-1' as Identity, claimedAt: AT, leaseExpiresAt: '2026-10-15T14:00:00Z' as Timestamp })
    assert.equal(leaseNote(leased, '2026-10-15T13:00:00Z' as Timestamp), 'lease until 2026-10-15T14:00:00Z')
    assert.match(renderIssueHuman(leased, [], '2026-10-15T13:00:00Z' as Timestamp), /assignee: agent:one\|dsh\|m-a\|s-1 \(lease until 2026-10-15T14:00:00Z\)/)
  })

  it('says an expired claim is reclaimable — the sentence the design asks for', () => {
    const lapsed = issue({ assignee: 'agent:one|dsh|m-a|s-1' as Identity, claimedAt: AT, leaseExpiresAt: '2026-10-15T14:00:00Z' as Timestamp })
    assert.equal(
      leaseNote(lapsed, '2026-10-15T14:00:01Z' as Timestamp),
      'lease expired at 2026-10-15T14:00:00Z — reclaimable',
    )
    // The boundary itself counts as expired, consistently with `leaseIsActive` (decision 61).
    assert.equal(leaseNote(lapsed, '2026-10-15T14:00:00Z' as Timestamp), 'lease expired at 2026-10-15T14:00:00Z — reclaimable')
    assert.match(renderIssueHuman(lapsed, [], '2026-10-15T15:00:00Z' as Timestamp), /reclaimable/)
  })

  it('still shows the expiry when no clock was supplied', () => {
    const leased = issue({ assignee: 'agent:one|dsh|m-a|s-1' as Identity, leaseExpiresAt: '2026-10-15T14:00:00Z' as Timestamp })
    assert.equal(leaseNote(leased), 'lease until 2026-10-15T14:00:00Z')
    assert.match(renderIssueHuman(leased), /lease until 2026-10-15T14:00:00Z/)
  })
})

describe('render: the CLI gets the same facts in Chinese (decision 55)', () => {
  it('translates the labels and leaves every piece of data alone', () => {
    const leased = issue({ assignee: 'agent:one|dsh|m-a|s-1' as Identity, leaseExpiresAt: '2026-10-15T14:00:00Z' as Timestamp })
    const text = renderIssueHuman(leased, [], '2026-10-15T13:00:00Z' as Timestamp, 'zh')
    assert.match(text, /^DH-1 {2}\[todo\] {2}S3 {2}a leased issue$/m, 'the header is data')
    assert.match(text, /项目：DH {3}类型：task {3}版本：1/)
    assert.match(text, /认领：agent:one\|dsh\|m-a\|s-1（租约至 2026-10-15T14:00:00Z）/)
    assert.match(text, /报告者：human:daiqc/)
  })

  it('says an expired claim is reclaimable in Chinese too', () => {
    const lapsed = issue({ assignee: 'agent:one|dsh|m-a|s-1' as Identity, leaseExpiresAt: '2026-10-15T14:00:00Z' as Timestamp })
    assert.equal(
      leaseNote(lapsed, '2026-10-15T15:00:00Z' as Timestamp, 'zh'),
      '租约已于 2026-10-15T14:00:00Z 到期 —— 可接管',
    )
    assert.match(renderIssueHuman(lapsed, [], '2026-10-15T15:00:00Z' as Timestamp, 'zh'), /可接管/)
  })

  it('defaults to English, because the plugin renders the same issue for a model', () => {
    assert.match(renderIssueHuman(issue(), [], undefined, 'en'), /project: DH {3}type: task/)
    assert.match(renderIssueHuman(issue()), /project: DH {3}type: task/)
  })
})

describe('render: the JSON wire is snake_case (decisions 41/159)', () => {
  it('renames keys all the way down and leaves values alone', () => {
    assert.deepEqual(toWire({ issueType: 'task', kbRefs: ['KB-1'], nested: [{ createdAt: 'x' }] }), {
      issue_type: 'task',
      kb_refs: ['KB-1'],
      nested: [{ created_at: 'x' }],
    })
    // Values are never rewritten — a summary may be camelCase and must stay that way.
    assert.deepEqual(toWire({ summary: 'rename `fooBar` to `bazQux`' }), { summary: 'rename `fooBar` to `bazQux`' })
    assert.equal(toWire(42), 42)
    assert.equal(toWire(null), null)
  })

  it('renders an issue with snake_case keys, and the comments too', () => {
    const text = renderIssueJson(issue(), [{ id: 'c-a1b2-1', author: 'human:x' as Identity, revision: 1, createdAt: '2026-10-15T12:00:00Z' as Timestamp, body: 'hi' }])
    const parsed = JSON.parse(text) as Record<string, unknown>
    assert.equal(Object.hasOwn(parsed, 'issue_type'), true)
    assert.equal(Object.hasOwn(parsed, 'issueType'), false)
    assert.equal(Object.hasOwn(parsed, 'created_at'), true)
    const comments = parsed.comments as Record<string, unknown>[]
    assert.equal(Object.hasOwn(comments[0] ?? {}, 'created_at'), true, 'the comments are wire-shaped as well')
  })
})

describe('render: fromWire undoes toWire (decision 159)', () => {
  it('round-trips every shape the tools return, key for key', () => {
    // The host hands a tool's **wire** value back to `output.render`, and the renderers read
    // entity-shaped keys — `issue.kbRefs`, not `issue.kb_refs`. That mismatch crashed a live
    // `get` on 2026-10-17, so the round-trip is asserted on the four real shapes, not on toys.
    const shapes: Record<string, unknown>[] = [
      // get: an issue with its comments
      { ...issue(), comments: [{ id: 'c-a1b2-1', author: 'human:x', revision: 1, createdAt: AT, body: 'hi' }] },
      // a refusal: the failure envelope (decision 149: failures carry `me`)
      { ok: false, writable: false, me: 'agent:x|dsh|m-a|s-1', error: { code: 'STALE_REVISION', message: 'no', context: { expected: 1, actual: 2 } } },
      // list: issues plus the partial-read's rejected files
      { ok: true, issues: [issue()], rejected: [{ file: 'projects/DH/issues/DH-9.md', reason: 'bad frontmatter' }] },
      // kb: search hits
      { ok: true, hits: [{ key: 'KB-1', line: 3, snippet: 'how to' }] },
    ]
    for (const shape of shapes) assert.deepEqual(fromWire(toWire(shape)), shape)
  })

  it('leaves keys without an underscore alone, and passes scalars through', () => {
    assert.deepEqual(fromWire({ summary: 'a', ok: true }), { summary: 'a', ok: true })
    assert.equal(fromWire(42), 42)
    assert.equal(fromWire(null), null)
    assert.deepEqual(fromWire(['a_b', 1]), ['a_b', 1], 'array items are values, not keys')
  })

  it('does not invent fields a payload never had', () => {
    // A partial payload stays partial — reading `kbRefs` off a value that never had it is exactly
    // the undefined-dereference that crashed the live render, so the absence itself is asserted.
    const back = fromWire(toWire({ key: 'DH-1', issueType: 'task' })) as Record<string, unknown>
    assert.equal(back.issueType, 'task')
    assert.equal(Object.hasOwn(back, 'kbRefs'), false)
  })
})
describe('render: the model-facing budget says when it cut (decision 84)', () => {
  it('passes short text through, and a long one is cut with a note, not mid-sentence silence', () => {
    assert.equal(clampText('short'), 'short')
    assert.equal(clampText('x'.repeat(MODEL_TEXT_BUDGET)), 'x'.repeat(MODEL_TEXT_BUDGET), 'exactly at the budget is not truncated')
    const long = clampText('y'.repeat(MODEL_TEXT_BUDGET + 10))
    assert.ok(long.startsWith('y'.repeat(MODEL_TEXT_BUDGET)))
    assert.match(long, /… \(truncated: 8202 characters total\)/u, 'the reader is told the answer is partial')
  })
})
describe('render: the human surface shows local time (decision 195)', () => {
  it('keeps UTC and adds the local clock with its offset', () => {
    const rendered = withLocalTime('2026-10-19T11:37:43Z', new Date('2026-10-19T11:37:43Z'))
    assert.match(rendered, /^2026-10-19T11:37:43Z（本地 \d{4}-\d{2}-\d{2} \d{2}:\d{2} [+-]\d{2}:\d{2}）$/u)
    // The stored value is untouched — this is presentation only (decision 47).
    assert.equal(rendered.startsWith('2026-10-19T11:37:43Z'), true)
    assert.equal(withLocalTime('not a date'), 'not a date')
  })
})
