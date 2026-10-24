/**
 * Tests for core/keyset (decision 94) and core/boardHtml (decision 87).
 *
 * The key inventory exists for one moment: standing in front of two independent instances, deciding
 * what merges into what. So the tests are the three answers a merge needs — only here, only there,
 * and **both** (which splits into "same summary, probably one issue" and "different summary, a real
 * clash").
 *
 * The HTML board's tests are mostly about what it must **not** contain: no scripts, no network, and
 * no unescaped store text.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { boardSections, escapeHtml, renderBoardHtml } from './boardHtml.ts'
import { type Issue, type IssueKey, type Timestamp } from './entity.ts'
import { compareKeyInventories, keyInventory, renderKeyComparison, renderKeyInventory } from './keyset.ts'
import { type Vocab, parseVocab } from './vocab.ts'

const vocab: Vocab = (() => {
  const parsed = parseVocab(readFileSync(new URL('../fixtures/config.md', import.meta.url), 'utf8'))
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error))
  return parsed.value
})()

const issue = (over: Readonly<{
  key: string
  summary?: string
  status?: string
  tags?: readonly string[]
  assignee?: string
  updatedAt?: string
  links?: readonly { type: 'is_blocked_by'; target: string }[]
}>): Issue => Object.freeze({
  key: over.key as IssueKey,
  project: over.key.slice(0, over.key.lastIndexOf('-')),
  issueType: 'task',
  status: over.status ?? 'todo',
  summary: over.summary ?? `summary of ${over.key}`,
  priority: 'S3',
  tags: Object.freeze([...(over.tags ?? [])]),
  links: Object.freeze((over.links ?? []).map(link => Object.freeze({ type: link.type, target: link.target as IssueKey }))),
  ...(over.assignee === undefined ? {} : { assignee: over.assignee as never }),
  kbRefs: Object.freeze([]),
  reporter: 'human:me' as never,
  revision: 1,
  createdAt: (over.updatedAt ?? '2026-10-15T12:00:00Z') as Timestamp,
  updatedAt: (over.updatedAt ?? '2026-10-15T12:00:00Z') as Timestamp,
  conflicted: false,
  body: '',
})

describe('keyset: the inventory', () => {
  it('groups by project and sorts by key, so two inventories line up', () => {
    const inventory = keyInventory([
      issue({ key: 'OTHER-2' }),
      issue({ key: 'DH-2' }),
      issue({ key: 'DH-1' }),
      issue({ key: 'DH-10' }),
    ])
    assert.deepEqual(inventory.rows.map(row => row.key), ['DH-1', 'DH-10', 'DH-2', 'OTHER-2'])
    assert.deepEqual(inventory.byProject.map(group => [group.project, group.rows.length]), [['DH', 3], ['OTHER', 1]])
    assert.equal(inventory.total, 4)
    assert.match(renderKeyInventory(inventory), /DH（3）：/)
    assert.match(renderKeyInventory(inventory, 'the other store'), /the other store：4 个 key/)
  })

  it('says so when there is nothing', () => {
    assert.match(renderKeyInventory(keyInventory([])), /（没有 issue）/)
  })
})

describe('keyset: the comparison', () => {
  const left = keyInventory([
    issue({ key: 'DH-1', summary: 'the same issue' }),
    issue({ key: 'DH-2', summary: 'only on the left' }),
    issue({ key: 'DH-9', summary: 'a real clash here' }),
  ])
  const right = keyInventory([
    issue({ key: 'DH-1', summary: 'the same issue' }),
    issue({ key: 'DH-3', summary: 'only on the right' }),
    issue({ key: 'DH-9', summary: 'a different thing entirely' }),
  ])

  it('splits collisions by whether the summary agrees', () => {
    const comparison = compareKeyInventories(left, right)
    assert.deepEqual(comparison.onlyLeft.map(row => row.key), ['DH-2'])
    assert.deepEqual(comparison.onlyRight.map(row => row.key), ['DH-3'])
    assert.deepEqual(comparison.collisions.map(collision => [collision.key, collision.sameSummary]), [
      ['DH-1', true],
      ['DH-9', false],
    ])
  })

  it('renders the real clashes first, because those need a human', () => {
    const text = renderKeyComparison(compareKeyInventories(left, right), 'here', 'there')
    assert.match(text, /同 key 但 summary 不同（1）—— 这些是真冲突：/)
    assert.match(text, /DH-9\n {4}here：a real clash here\n {4}there：a different thing entirely/)
    assert.match(text, /同 key 且 summary 相同（1）/)
    assert.match(text, /只在 here（1）/)
    assert.match(text, /只在 there（1）/)
    assert.match(text, /映射表写到 _merge\/<UTC>-from-<machine_id>\.md/u)
  })

  it('is symmetric in what it counts', () => {
    const forward = compareKeyInventories(left, right)
    const backward = compareKeyInventories(right, left)
    assert.equal(forward.collisions.length, backward.collisions.length)
    assert.deepEqual(backward.onlyLeft.map(row => row.key), ['DH-3'])
  })
})

describe('boardHtml: the sections mirror the Markdown board', () => {
  const issues = [
    issue({ key: 'DH-1', status: 'todo' }),
    issue({ key: 'DH-2', status: 'in_progress' }),
    issue({ key: 'DH-3', status: 'todo', links: [{ type: 'is_blocked_by', target: 'DH-1' }] }),
    issue({ key: 'DH-4', status: 'closed' }),
  ]

  it('lifts the blocked out of their status and keeps closed last', () => {
    const sections = boardSections(issues, vocab)
    // One section per open status (decision 87), so an unused status shows up empty on purpose.
    const openCount = vocab.statuses.filter(status => !vocab.closed.includes(status.name)).length
    assert.deepEqual(sections.map(section => section.kind), [...Array.from({ length: openCount }, () => 'open'), 'blocked', 'closed'])
    assert.deepEqual(sections[0]?.issues.map(entry => entry.key), ['DH-1'])
    assert.equal(sections.slice(0, openCount).some(section => section.issues.length === 0), true, 'an unused status renders as an empty section')

    const blocked = sections.find(section => section.kind === 'blocked')
    assert.deepEqual(blocked?.issues.map(entry => entry.key), ['DH-3'])
    assert.deepEqual(sections[sections.length - 1]?.issues.map(entry => entry.key), ['DH-4'])
  })

  it('keeps every issue exactly once', () => {
    const sections = boardSections(issues, vocab)
    const keys = sections.flatMap(section => section.issues.map(entry => entry.key))
    assert.deepEqual([...keys].sort(), ['DH-1', 'DH-2', 'DH-3', 'DH-4'])
  })
})

describe('boardHtml: a file that opens anywhere', () => {
  const html = renderBoardHtml(
    [issue({ key: 'DH-1', tags: ['windows'], assignee: 'human:me' }), issue({ key: 'DH-2', status: 'closed' })],
    vocab,
    { title: 'DH board', generatedAt: '2026-10-16T00:00:00Z' },
  )

  it('is a complete document with no scripts and no network', () => {
    assert.match(html, /^<!doctype html>/)
    assert.match(html, /<meta charset="utf-8">/)
    assert.equal(html.includes('<script'), false)
    assert.equal(/https?:\/\//u.test(html), false, 'no external assets: it must open offline')
    assert.match(html, /<title>DH board<\/title>/)
    assert.match(html, /生成于 2026-10-16T00:00:00Z/)
  })

  it('shows the fields a human scans for, per section with a count', () => {
    assert.match(html, /<h2>todo <span class="count">1<\/span><\/h2>/)
    assert.match(html, /<h2>已关闭 <span class="count">1<\/span><\/h2>/)
    assert.match(html, /<td class="key"><a href="#DH-1">DH-1<\/a><\/td>/)
    assert.match(html, /<td class="tags">windows<\/td>/)
    assert.match(html, /human:me/)
  })

  it('escapes everything that came from the store', () => {
    const nasty = renderBoardHtml([issue({ key: 'DH-1', summary: '<script>alert("x")</script> & more' })], vocab)
    assert.equal(nasty.includes('<script>alert'), false, 'a summary must never become markup')
    assert.match(nasty, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; more/)
    assert.equal(escapeHtml('<>&"\''), '&lt;&gt;&amp;&quot;&#39;')
  })
})
