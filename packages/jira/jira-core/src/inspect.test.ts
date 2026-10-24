/**
 * The query surface, tested directly (decision 170).
 *
 * `queryIssues` and `blockersOf` were only exercised through the CLI and the tool, so a filter branch
 * could be wrong and still look green: the caller would have narrowed the list for its own reason.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { encodeIssue } from './codec.ts'
import { type Identity, type Issue, type IssueKey, type Timestamp } from './entity.ts'
import { blockersOf, listIssues, queryIssues } from './inspect.ts'
import { createStore, storePaths } from './store.ts'
import { parseVocab } from './vocab.ts'
import { removeTree } from './testing/removeTree.ts'

const fixture = readFileSync(new URL('../fixtures/config.md', import.meta.url), 'utf8')
const vocab = (() => {
  const parsed = parseVocab(fixture)
  assert.equal(parsed.ok, true)
  return parsed.ok ? parsed.value : (undefined as never)
})()

const AT = '2026-10-15T08:30:00Z' as Timestamp
const BY = 'human:daiqc' as Identity
const OPEN = vocab.statuses.map(entry => entry.name).find(name => !vocab.closed.includes(name)) ?? ''
const CLOSED = vocab.closed[0] ?? ''

const row = (key: string, extra: Partial<Issue> = {}): Issue => Object.freeze({
  key: key as IssueKey,
  project: key.split('-')[0] ?? 'DH',
  issueType: 'task',
  summary: 'a summary',
  status: OPEN,
  priority: 'S3',
  tags: Object.freeze([]),
  links: Object.freeze([]),
  // The real shape: `encodeIssue` dereferences every required field, so a fake that skips one throws
  // instead of producing a bad file (which is how this test first failed).
  revision: 1,
  createdAt: AT,
  updatedAt: AT,
  reporter: BY,
  kbRefs: Object.freeze([]),
  conflicted: false,
  body: '',
  ...extra,
} as Issue)

const rows = [
  row('DH-1', { tags: ['a', 'b'], assignee: BY }),
  row('DH-2', { tags: ['a'], status: CLOSED }),
  row('KB-1', { project: 'KB', links: [{ type: 'is_blocked_by', target: 'DH-1' as IssueKey }] }),
]

describe('inspect: queryIssues narrows one filter at a time (decision 170)', () => {
  it('filters by project, tag, assignee and link', () => {
    assert.deepEqual(queryIssues(rows, {}, vocab).map(entry => entry.key), ['DH-1', 'KB-1'], 'closed is hidden by default')
    assert.deepEqual(queryIssues(rows, { includeClosed: true }, vocab).map(entry => entry.key), ['DH-1', 'DH-2', 'KB-1'])
    assert.deepEqual(queryIssues(rows, { project: 'kb', includeClosed: true }, vocab).map(entry => entry.key), ['KB-1'], 'the project is upper-cased')
    assert.deepEqual(queryIssues(rows, { tag: 'a', includeClosed: true }, vocab).map(entry => entry.key), ['DH-1', 'DH-2'])
    assert.deepEqual(queryIssues(rows, { tags: ['a', 'b'], includeClosed: true }, vocab).map(entry => entry.key), ['DH-1'], 'every tag must match')
    assert.deepEqual(queryIssues(rows, { assignee: BY, includeClosed: true }, vocab).map(entry => entry.key), ['DH-1'])
    assert.deepEqual(queryIssues(rows, { link: { type: 'is_blocked_by', target: 'DH-1' }, includeClosed: true }, vocab).map(entry => entry.key), ['KB-1'])
    assert.deepEqual(queryIssues(rows, { status: CLOSED, includeClosed: true }, vocab).map(entry => entry.key), ['DH-2'])
  })

  it('does not hide by a closed set it does not have', () => {
    // No vocabulary means no closed set: hiding by it would hide everything (the "no config.md" store).
    assert.deepEqual(queryIssues(rows, {}, undefined).map(entry => entry.key), ['DH-1', 'DH-2', 'KB-1'])
  })

  it('applies several filters together', () => {
    assert.deepEqual(queryIssues(rows, { project: 'DH', tag: 'a', tags: ['a', 'b'] }, vocab).map(entry => entry.key), ['DH-1'])
    assert.deepEqual(queryIssues(rows, { project: 'KB', tag: 'a' }, vocab).map(entry => entry.key), [])
  })
})

describe('inspect: a broken file is reported structured (DPMJ-211)', () => {
  it('carries path and reason as fields, not a "<path>: <reason>" string to be split back apart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-jira-broken-'))
    try {
      await mkdir(join(dir, 'projects', 'DH', 'issues'), { recursive: true })
      const good = encodeIssue(row('DH-1'))
      assert.equal(good.ok, true)
      if (good.ok) await writeFile(storePaths.issue(dir, 'DH', 'DH-1' as IssueKey), good.value, 'utf8')
      await writeFile(storePaths.issue(dir, 'DH', 'DH-9' as IssueKey), '---\nschema: [broken\n---\n', 'utf8')

      const listed = await listIssues(dir)
      assert.deepEqual(listed.issues.map(issue => issue.key), ['DH-1'])
      assert.equal(listed.broken.length, 1)
      const broken = listed.broken[0]
      assert.equal(typeof broken, 'object', 'structured from birth, not a string')
      assert.equal(broken?.path.endsWith('DH-9.md'), true)
      assert.match(broken?.reason ?? '', /.+/, 'the decode failure is the reason')
    } finally {
      await removeTree(dir)
    }
  })
})

describe('inspect: blockersOf counts only open blockers (decision 170)', () => {
  let dir = ''
  let store: ReturnType<typeof createStore> | undefined

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-jira-blockers-'))
    await mkdir(join(dir, 'projects', 'DH', 'issues'), { recursive: true })
    await writeFile(storePaths.config(dir), fixture, 'utf8')
    const make = (key: string, links: readonly { type: 'is_blocked_by'; target: IssueKey }[], status: string): Issue =>
      row(key, { links: Object.freeze(links.map(link => Object.freeze(link))), status })
    for (const issue of [
      make('DH-1', [{ type: 'is_blocked_by', target: 'DH-2' as IssueKey }], OPEN),
      make('DH-2', [], OPEN), // an open blocker
      make('DH-3', [{ type: 'is_blocked_by', target: 'DH-2' as IssueKey }, { type: 'is_blocked_by', target: 'DH-4' as IssueKey }], OPEN),
      make('DH-4', [], CLOSED), // a closed blocker does not block
      make('DH-5', [{ type: 'is_blocked_by', target: 'DH-9' as IssueKey }], OPEN), // a missing target does not block
    ]) {
      const encoded = encodeIssue(issue)
      assert.equal(encoded.ok, true)
      if (encoded.ok) await writeFile(storePaths.issue(dir, 'DH', issue.key), encoded.value, 'utf8')
    }
    store = createStore({ root: dir, machineId: 'a1b2c3d4' })
  })

  after(async () => {
    if (dir !== '') await rm(dir, { recursive: true, force: true })
  })

  it('lists the open ones, ignores closed and missing targets, and answers [] for an unknown key', async () => {
    assert.ok(store !== undefined)
    const one = await blockersOf(store, 'DH-1' as IssueKey)
    assert.equal(one.ok, true)
    if (one.ok) assert.deepEqual(one.value, ['DH-2'])
    const mixed = await blockersOf(store, 'DH-3' as IssueKey)
    if (mixed.ok) assert.deepEqual(mixed.value, ['DH-2'], 'the closed blocker is dropped')
    const none = await blockersOf(store, 'DH-2' as IssueKey)
    if (none.ok) assert.deepEqual(none.value, [])
    const missing = await blockersOf(store, 'DH-9' as IssueKey)
    assert.equal(missing.ok, true)
    if (missing.ok) assert.deepEqual(missing.value, [])
  })
})
