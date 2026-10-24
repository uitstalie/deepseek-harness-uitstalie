/**
 * Tests for core/store — the transaction, its lock, and its all-or-nothing behaviour.
 *
 * Real files in a temp directory: this is the layer where "the rules said yes" has to
 * become "the file changed", so the interesting cases are the failures (nothing written)
 * and the interleavings (two writers, two revisions).
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { encodeIssue } from './codec.ts'
import { adoptHumanChanges as adoptFromCommit, commitStoreWrite as commitFromCommit } from './commit.ts'
import { allocateKey as allocateFromCounters, highestExistingKey as highestFromCounters, readAllCounters as countersFromCounters } from './counters.ts'
import { type Identity, type Issue, type IssueKey, type Timestamp } from './entity.ts'
import { writeTextAtomic } from './io.ts'
import { acquireLock, issueLockPath, readOwner, releaseLock } from './lock.ts'
import { runGit, initializeRepository } from './git.ts'
import { applyComment, applyTransition, applyUpdate, createIssue } from './mutate.ts'
import { ioFailed } from './errors.ts'
import { err, ok } from './result.ts'
import {
  type Store,
  adoptHumanChanges,
  allocateKey,
  commitStoreWrite,
  createStore,
  highestExistingKey,
  loadTags,
  projectOf,
  readAllCounters,
  readComments,
  readIssueText,
  storePaths,
  transact,
} from './store.ts'
import { type Vocab, parseVocab } from './vocab.ts'

describe('store: the split keeps one implementation (decision 185)', () => {
  it('re-exports the very same functions commit.ts and counters.ts define', () => {
    // If somebody re-defined one of these inside store.ts, the re-export would point at the new
    // copy and this identity check would fail.
    assert.equal(commitStoreWrite, commitFromCommit)
    assert.equal(adoptHumanChanges, adoptFromCommit)
    assert.equal(allocateKey, allocateFromCounters)
    assert.equal(readAllCounters, countersFromCounters)
    assert.equal(highestExistingKey, highestFromCounters)
  })
})

const MACHINE = 'a1b2c3d4'
const SHORT = MACHINE.slice(0, 4)
const ACTOR = Object.freeze({ by: 'human:daiqc' as Identity, at: '2026-10-15T12:00:00Z' as Timestamp })
const LATER = Object.freeze({ by: 'human:daiqc' as Identity, at: '2026-10-15T13:00:00Z' as Timestamp })
const KEY = 'DH-1' as IssueKey
const DH = projectOf(KEY)

const fixtureText = await readFile(new URL('../fixtures/config.md', import.meta.url), 'utf8')

const vocab: Vocab = (() => {
  const parsed = parseVocab(fixtureText)
  if (!parsed.ok) throw new Error(`the fixture vocabulary must parse: ${JSON.stringify(parsed.error)}`)
  return parsed.value
})()

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  assert.equal(result.ok, true, `expected success, got ${JSON.stringify(result)}`)
  if (!result.ok) throw new Error('unreachable')
  return result.value
}

const buildIssue = (overrides: Partial<Parameters<typeof createIssue>[0]> = {}): Issue =>
  unwrap(createIssue(
    { key: KEY, issueType: 'task', summary: 'first', tags: ['demo'], body: 'body\n', ...overrides },
    { vocab, knownTags: [{ name: 'demo' }], at: ACTOR.at, by: ACTOR.by },
  )).issue

let root = ''
/** Temp stores individual tests make, removed in `after` (decision 170). */
const emptyRoots: string[] = []
let store: Store

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-jira-store-'))
  await mkdir(join(root, 'tags'), { recursive: true })
  await writeFile(
    join(root, 'tags', 'demo.md'),
    '---\ntype: tag\nname: demo\ndescription: demo tag\naliases: [demo-tag]\n---\n',
    'utf8',
  )
  await writeTextAtomic(storePaths.config(root), fixtureText)
  store = createStore({ root, machineId: MACHINE })
  const encoded = encodeIssue(buildIssue())
  assert.equal(encoded.ok, true)
  if (encoded.ok) await writeTextAtomic(storePaths.issue(root, DH, KEY), encoded.value)
})

after(async () => {
  if (root !== '') await rm(root, { recursive: true, force: true })
  // Decision 170: the throwaway stores a single test makes are removed too.
  for (const dir of emptyRoots) await rm(dir, { recursive: true, force: true })
})

describe('store: reading', () => {
  it('loads the vocabulary and the tag registry', async () => {
    assert.deepEqual(unwrap(await loadTags(store)), [{ name: 'demo', description: 'demo tag', aliases: ['demo-tag'] }])
  })

  it('has no comments until one is written', async () => {
    assert.deepEqual(unwrap(await readComments(store, KEY)), [])
  })

  it('says so when the store has no vocabulary', async () => {
    const emptyRoot = await mkdtemp(join(tmpdir(), 'dsh-jira-empty-'))
    emptyRoots.push(emptyRoot)
    const empty = createStore({ root: emptyRoot, machineId: MACHINE })
    const result = await transact(empty, KEY, ACTOR, (issue, ctx) => applyUpdate(issue, { summary: 'x' }, ctx))
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error.message, /no readable config.md/)
  })

  it('honours the lock options the store was built with — including the injected clock (decision 181)', async () => {
    // Hold DH-1's lock, then give the store a 37 ms budget on a fake clock. If `transact` dropped
    // `env` (the realistic drift of an inline options copy), the fake clock would never move and
    // the exact `current` assertion below would fail.
    const path = issueLockPath(root, KEY)
    const held = await acquireLock(path, { pid: 1, host: 'other-host', machine_id: 'm-x', at: ACTOR.at })
    assert.equal(held.ok, true)
    const start = Date.parse('2026-10-15T12:00:00Z')
    let current = start
    const env = {
      now: () => current,
      sleep: async (ms: number) => { current += ms },
      random: () => 0,
    }
    const timed = createStore({ root, machineId: MACHINE, lock: { timeoutMs: 37, staleMs: 60_000 }, env })
    const result = await transact(timed, KEY, ACTOR, (issue, ctx) => applyUpdate(issue, { summary: 'x' }, ctx))
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error.code, 'LOCK_TIMEOUT')
    assert.equal(current, start + 100, 'one 100 ms backoff spent the 37 ms budget — the injected clock really ran')
    if (held.ok) await releaseLock(held.value)
  })
})

describe('store: a successful transaction lands on disk', () => {
  it('writes the new issue and reports that it did', async () => {
    const before = unwrap(await readIssueText(store, KEY))
    const result = unwrap(await transact(store, KEY, LATER, (issue, ctx) =>
      applyUpdate(issue, { summary: 'second' }, ctx)))

    assert.equal(result.issueWritten, true)
    assert.equal(result.change.issue.summary, 'second')
    assert.equal(result.change.issue.revision, 2)

    const after = unwrap(await readIssueText(store, KEY))
    assert.notEqual(after, before)
    assert.match(after, /^summary: second$/m)
    assert.match(after, /^revision: 2$/m)
    assert.match(after, /^updated_at: 2026-10-15T13:00:00Z$/m)
    assert.equal(after.includes('\r'), false)
  })

  it('releases the lock on the way out', async () => {
    assert.equal(await readOwner(issueLockPath(root, KEY)), undefined)
  })

  it('a comment-only change does not rewrite the issue file', async () => {
    const before = unwrap(await readIssueText(store, KEY))
    const result = unwrap(await transact(store, KEY, LATER, (issue, ctx) => applyComment(issue, 'a remark', ctx)))
    assert.equal(result.issueWritten, false)
    assert.equal(unwrap(await readIssueText(store, KEY)), before)

    const comments = unwrap(await readComments(store, KEY))
    assert.equal(comments.length, 1)
    assert.equal(comments[0]?.id, `c-${SHORT}-1`)
    assert.equal(comments[0]?.body, 'a remark')
  })
})

describe('store: a refused transaction writes nothing at all', () => {
  it('leaves the file byte-identical when the rules say no', async () => {
    const before = unwrap(await readIssueText(store, KEY))
    const result = await transact(store, KEY, LATER, (issue, ctx) => applyTransition(issue, 'in_review', {}, ctx))
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error.code, 'INVALID_TRANSITION')
    assert.equal(unwrap(await readIssueText(store, KEY)), before)
    assert.equal(await readOwner(issueLockPath(root, KEY)), undefined, 'and it still unlocks')
  })
})

describe('store: closing and reopening, end to end on disk', () => {
  it('records the conclusion, then clears it and appends the reason', async () => {
    // 2026-10-19 ruling: closing must go through in_progress (no direct todo→closed edge).
    unwrap(await transact(store, KEY, LATER, (issue, ctx) => applyTransition(issue, 'in_progress', {}, ctx)))
    const closed = unwrap(await transact(store, KEY, LATER, (issue, ctx) =>
      applyTransition(issue, 'closed', { resolution: 'limitation', resolutionNote: 'blocked by X' }, ctx)))
    assert.equal(closed.change.issue.resolution, 'limitation')
    const closedText = unwrap(await readIssueText(store, KEY))
    assert.match(closedText, /^resolution: limitation$/m)
    assert.match(closedText, /^resolution_note: blocked by X$/m)

    const reopened = unwrap(await transact(store, KEY, LATER, (issue, ctx) =>
      applyTransition(issue, 'in_progress', {}, ctx)))
    assert.equal('resolution' in reopened.change.issue, false)
    assert.equal(reopened.appended.length, 1)

    const reopenedText = unwrap(await readIssueText(store, KEY))
    assert.equal(/^resolution/m.test(reopenedText), false, 'the conclusion is gone from the file')

    const comments = unwrap(await readComments(store, KEY))
    assert.equal(comments.length, 2)
    assert.match(comments[1]?.body ?? '', /reopened/)
    assert.match(comments[1]?.body ?? '', /limitation/)
    assert.equal(comments[1]?.id, `c-${SHORT}-2`, 'ids continue this machine\'s own sequence')

    const raw = await readFile(storePaths.comments(root, DH, KEY), 'utf8')
    assert.match(raw, /<!-- c-a1b2-2 \| author=human:daiqc \| created_at=2026-10-15T13:00:00Z \| revision=1 -->/)
    assert.equal(raw.includes('\r'), false)
  })
})

describe('store: two writers on one issue do not lose an update', () => {
  it('serialises them and advances the revision twice', async () => {
    const before = unwrap(await readIssueText(store, KEY))
    const revision = Number(/^revision: (\d+)$/m.exec(before)?.[1] ?? '0')

    const [first, second] = await Promise.all([
      transact(store, KEY, LATER, (issue, ctx) => applyUpdate(issue, { priority: 'S1' }, ctx)),
      transact(store, KEY, LATER, (issue, ctx) => applyUpdate(issue, { priority: 'S5' }, ctx)),
    ])
    assert.equal(first.ok && second.ok, true)

    const text = unwrap(await readIssueText(store, KEY))
    assert.equal(Number(/^revision: (\d+)$/m.exec(text)?.[1] ?? '0'), revision + 2, 'both writers counted')
    assert.match(text, /^priority: S[15]$/m)
  })
})

describe('store: the write half of decisions 49/46, 44 and 48', () => {
  const path = (): string => storePaths.issue(root, DH, KEY)
  const restore = async (): Promise<void> => {
    const encoded = encodeIssue(buildIssue())
    assert.equal(encoded.ok, true)
    if (encoded.ok) await writeTextAtomic(path(), encoded.value)
  }
  const write = async (text: string): Promise<void> => { await writeTextAtomic(path(), text) }

  it('refuses to write a file carrying an unknown frontmatter key (49)', async () => {
    await restore()
    const text = unwrap(await readIssueText(store, KEY))
    await write(text.replace('---\n', '---\nfuture_field: 1\n'))
    const result = await transact(store, KEY, LATER, (issue, ctx) => applyUpdate(issue, { summary: 'x' }, ctx), 'update')
    assert.equal(result.ok, false, 'a write must not silently drop the key')
    if (!result.ok) {
      assert.equal(result.error.code, 'INVALID_INPUT')
      assert.match(result.error.message, /unknown frontmatter key\(s\) "future_field" would be dropped/)
    }
    assert.match(unwrap(await readIssueText(store, KEY)), /future_field: 1/, 'and the file is untouched')
  })

  it('refuses to write a file from a version this build does not write (46)', async () => {
    await restore()
    await write(unwrap(await readIssueText(store, KEY)).replace('schema: issue/v1', 'schema: issue/v2'))
    const result = await transact(store, KEY, LATER, (issue, ctx) => applyUpdate(issue, { summary: 'x' }, ctx), 'update')
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error.message, /the file is issue\/v2/)
  })

  it('refuses a stale compare-and-swap with the typed error, and accepts the current one (44/52)', async () => {
    await restore()
    const stale = await transact(store, KEY, LATER, (issue, ctx) => applyUpdate(issue, { summary: 'x' }, ctx), 'update', { expectedRevision: 99 })
    assert.equal(stale.ok, false)
    if (!stale.ok) {
      assert.equal(stale.error.code, 'STALE_REVISION')
      assert.deepEqual(stale.error.context, { expected: 99, actual: 1 })
    }
    const fresh = await transact(store, KEY, LATER, (issue, ctx) => applyUpdate(issue, { summary: 'renamed' }, ctx), 'update', { expectedRevision: 1 })
    assert.equal(fresh.ok, true, JSON.stringify(fresh))
  })

  it('refuses an acting identity that would make the audit tuple ambiguous (48/69)', async () => {
    await restore()
    for (const bad of ['human:a|b', 'agent:only|two', 'agent:a|b|c|', 'nonsense']) {
      const result = await transact(store, KEY, { by: bad as Identity, at: LATER.at }, (issue, ctx) => applyUpdate(issue, { summary: 'x' }, ctx), 'update')
      assert.equal(result.ok, false, bad)
      if (!result.ok) assert.match(result.error.message, /acting identity/)
    }
    const good = await transact(store, KEY, LATER, (issue, ctx) => applyUpdate(issue, { summary: 'ok' }, ctx), 'update')
    assert.equal(good.ok, true)
  })
})

describe("store: §4.13 rule 1 adopts the human's uncommitted work", () => {
  /**
   * Its own store, with a **known** git identity set locally.
   *
   * The shared fixture above deliberately has none, so `human:<name>` falls back there; asserting an
   * author against whatever the host happens to have configured globally is exactly the
   * machine-dependent test that broke CI twice (2026-10-16/17), so this one pins it.
   */
  let own = ''
  let ownStore: Store

  before(async () => {
    own = await mkdtemp(join(tmpdir(), 'dsh-jira-adopt-'))
    await mkdir(join(own, 'tags'), { recursive: true })
    await writeFile(join(own, 'tags', 'demo.md'), '---\ntype: tag\nname: demo\ndescription: demo tag\n---\n', 'utf8')
    await writeTextAtomic(storePaths.config(own), fixtureText)
    ownStore = createStore({ root: own, machineId: MACHINE })
    const encoded = encodeIssue(buildIssue())
    assert.equal(encoded.ok, true)
    if (encoded.ok) await writeTextAtomic(storePaths.issue(own, DH, KEY), encoded.value)
    const initialized = await initializeRepository(own)
    assert.equal(initialized.ok, true, JSON.stringify(initialized))
    await runGit(own, ['add', '-A'])
    await runGit(own, ['-c', 'user.name=setup', '-c', 'user.email=setup@example.invalid', 'commit', '-q', '-m', 'DH-1: create (rev 1)'])
    // The human's own identity, the way a real machine has it.
    await runGit(own, ['config', '--local', 'user.name', 'Ada'])
    await runGit(own, ['config', '--local', 'user.email', 'ada@example.invalid'])
  })

  after(async () => {
    if (own !== '') await rm(own, { recursive: true, force: true })
  })

  it('leaves another transaction\'s in-flight write alone (decision 165)', async () => {
    // Another agent holds DH-2's lock and has written the file; its commit has not landed yet. The
    // adoption used to sweep that up under "the human's uncommitted work" — which both mislabelled it
    // and made the other transaction's own commit find nothing to stage.
    const otherPath = storePaths.issue(own, DH, 'DH-2' as IssueKey)
    await mkdir(join(own, 'projects', DH, 'issues'), { recursive: true })
    const held = await acquireLock(issueLockPath(own, 'DH-2'), {
      pid: process.pid,
      host: 'test-host',
      machine_id: 'm-test',
      at: LATER.at,
    })
    assert.equal(held.ok, true, 'the other transaction holds its lock')
    await writeFile(otherPath, 'in flight, not committed\n', 'utf8')
    // …and a human edit elsewhere, which the adoption *is* supposed to pick up.
    await writeFile(join(own, 'README.md'), 'a human note\n', 'utf8')

    const result = unwrap(await transact(ownStore, KEY, LATER, (issue, ctx) => applyUpdate(issue, { note: 'mine' }, ctx), 'update'))
    assert.equal(result.committed, true, JSON.stringify(result))

    const adoption = (await runGit(own, ['log', '--pretty=%s', '--name-only', '-1', '--skip=1'])).stdout
    assert.match(adoption, /收编工作区里未提交的人工改动/u)
    assert.match(adoption, /README\.md/u, 'the human edit is adopted')
    assert.equal(adoption.includes('DH-2.md'), false, 'the in-flight write is not')
    assert.match((await runGit(own, ['status', '--porcelain'])).stdout, /DH-2\.md/u, 'it is still uncommitted')
    if (held.ok) await releaseLock(held.value)
  })

  it('commits the hand edit first, keeps the human as author, then writes its own change', async () => {
    const path = storePaths.issue(own, DH, KEY)
    const human = await readFile(path, 'utf8')
    await writeFile(path, human.replace(/^summary: .*$/mu, 'summary: 人手改的，还没提交'), 'utf8')
    assert.notEqual((await runGit(own, ['status', '--porcelain'])).stdout, '', 'the tree starts dirty')

    const result = await transact(ownStore, KEY, LATER, (issue, ctx) => applyUpdate(issue, { priority: 'S1' }, ctx), 'update')
    assert.equal(result.ok, true, JSON.stringify(result))

    const [head = '', adopted = ''] = (await runGit(own, ['log', '--pretty=%s%x1f%an <%ae>', '-2'])).stdout.split('\n')
    assert.match(adopted, /收编工作区里未提交的人工改动.*\[no-issue\]/u, 'the adoption is its own commit')
    assert.match(adopted, /Ada <ada@example\.invalid>/u, 'and the human stays the author of it')
    assert.match(head, /^DH-1: update/u, 'this write is a separate commit')
    assert.equal((await runGit(own, ['status', '--porcelain'])).stdout, '', 'nothing is left uncommitted')
    assert.match(await readFile(path, 'utf8'), /人手改的，还没提交/u, "the human's text survived")
  })
})
describe('store: the commit hook runs inside the lock (decision 165)', () => {
  it('commits whatever the hook prepared, together with the write', async () => {
    // This is how `regenerateAndCommit` closes its plan→write race: it re-checks its tree snapshot
    // inside the lock and re-renders there. The hook is the seam, so it gets its own test.
    const dir = await mkdtemp(join(tmpdir(), 'dsh-jira-hook-'))
    try {
      await initializeRepository(dir)
      const store = createStore({ root: dir, machineId: 'feed1234' })
      let ran = false
      const committed = unwrap(await commitStoreWrite(store, LATER.at, [], 'DH-9: hook [no-issue]', async () => {
        ran = true
        await writeFile(join(dir, 'prepared.md'), 'written inside the lock\n', 'utf8')
        return ok(Object.freeze(['prepared.md']))
      }))
      assert.equal(committed.committed, true, JSON.stringify(committed))
      assert.equal(ran, true)
      assert.match((await runGit(dir, ['show', '--name-only', '--pretty=%s', '-1'])).stdout, /prepared\.md/u)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reports a hook failure instead of committing half of it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-jira-hookfail-'))
    try {
      await initializeRepository(dir)
      const store = createStore({ root: dir, machineId: 'feed1234' })
      const committed = unwrap(await commitStoreWrite(store, LATER.at, [], 'DH-9: hook [no-issue]', async () =>
        err(ioFailed('the re-render failed', {})))) as Readonly<{ committed: boolean; error?: { message: string } }>
      assert.equal(committed.committed, false)
      assert.match(committed.error?.message ?? '', /re-render failed/u)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
