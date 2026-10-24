/**
 * Tests for core/kbstore — creating, reading, updating and searching entries on disk.
 *
 * The properties that matter: the key comes from the store's own `KB` number space, a refused
 * entry writes nothing at all, the source quadruple is filled from the caller's context, and the
 * generated `index.md` inside a domain is never mistaken for an entry.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { removeTree } from './testing/removeTree.ts'
import { runGit, stageAndCommit } from './git.ts'
import { createKnowledge, findKnowledge, listKnowledge, originFromIdentity, searchKnowledgeIn, updateKnowledge } from './kbstore.ts'
import { scaffoldStore } from './scaffold.ts'
import { createInStore, createStore, storePaths } from './store.ts'

let root = ''
let store: ReturnType<typeof createStore>

const ORIGIN = Object.freeze({ machineId: 'm-test', os: 'linux', tool: 'dsh' })
const ACTOR = Object.freeze({ by: 'human:tester' as never, at: '2026-10-15T12:00:00Z' as never })
const LATER = Object.freeze({ by: 'human:tester' as never, at: '2026-10-15T13:00:00Z' as never })

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  assert.equal(result.ok, true, `expected success, got ${JSON.stringify(result)}`)
  if (!result.ok) throw new Error('unreachable')
  return result.value
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-jira-kb-'))
  unwrap(await scaffoldStore(root))
  await runGit(root, ['config', '--local', 'user.name', 'tester'])
  await runGit(root, ['config', '--local', 'user.email', 'tester@example.invalid'])
  store = createStore({ root, machineId: 'm-test' })
})

after(async () => {
  if (root !== '') await removeTree(root)
})

describe('kbstore: creating', () => {
  it('allocates a KB key and writes the file where the domain says', async () => {
    const created = unwrap(await createKnowledge(store, ACTOR, ORIGIN, {
      domain: 'locking',
      kbType: 'pitfall',
      title: 'Windows 上的锁必须用 mkdir',
      tags: ['windows'],
      body: 'flock 在 Windows 上不是原子的。\n',
      issues: ['DH-12' as never],
    }))
    assert.equal(created.entry.key, 'KB-1')
    assert.equal(created.committed, true, 'the write became a commit')

    const text = await readFile(join(root, 'knowledge', 'locking', 'KB-1.md'), 'utf8')
    assert.match(text, /^schema: kb\/v1$/m)
    assert.match(text, /^machine_id: m-test$/m)
    assert.match(text, /^captured_at: 2026-10-15T12:00:00Z$/m)
    assert.equal(text.includes('key:'), false, 'the file name is the key (decision 107)')
    assert.equal(text.includes('\r'), false)
  })

  it('numbers the next entry in the same space', async () => {
    const second = unwrap(await createKnowledge(store, LATER, ORIGIN, {
      domain: 'knowledge',
      kbType: 'concept',
      title: '域目录与 key 互相独立',
    }))
    assert.equal(second.entry.key, 'KB-2')
  })

  it('refuses a bad entry and writes nothing', async () => {
    const cases = [
      [{ domain: 'Bad', kbType: 'concept', title: 'x' }, /must be lower-kebab/],
      [{ domain: 'locking', kbType: 'note', title: 'x' }, /is not one of: runbook/],
      [{ domain: 'locking', kbType: 'concept', title: '  ' }, /title must not be empty/],
    ] as const
    for (const [input, needle] of cases) {
      const before = unwrap(await listKnowledge(store)).entries.length
      const result = await createKnowledge(store, LATER, ORIGIN, input as never)
      assert.equal(result.ok, false, JSON.stringify(input))
      if (!result.ok) assert.match(result.error.message, needle)
      assert.equal(unwrap(await listKnowledge(store)).entries.length, before, 'nothing was written')
    }
  })

  it('does not burn a KB number on a refused draft (decision 190)', async () => {
    // KB-1 and KB-2 exist from the tests above; a refusal must leave the counter untouched.
    const refused = await createKnowledge(store, LATER, ORIGIN, { domain: 'locking', kbType: 'note', title: 'x' } as never)
    assert.equal(refused.ok, false)
    if (!refused.ok) {
      assert.equal(
        (refused.error.context as Record<string, unknown> | undefined)?.['keyAllocated'],
        false,
        'the refusal must say the number survives',
      )
    }
    const next = unwrap(await createKnowledge(store, LATER, ORIGIN, {
      domain: 'locking',
      kbType: 'howto',
      title: '拒绝不烧号：下一个号紧跟',
    }))
    assert.equal(next.entry.key, 'KB-3', 'no gap: the refused draft consumed nothing')
  })
})

describe('kbstore: reading', () => {
  it('finds an entry by key without being told its domain', async () => {
    const found = unwrap(await findKnowledge(store, 'KB-1' as never))
    assert.equal(found.entry.domain, 'locking')
    assert.equal(found.path, 'knowledge/locking/KB-1.md')
    assert.deepEqual(found.entry.issues, ['DH-12'])
    assert.equal(found.entry.source.machineId, 'm-test')
  })

  it('reports a missing key as NOT_FOUND', async () => {
    const missing = await findKnowledge(store, 'KB-99' as never)
    assert.equal(missing.ok, false)
    if (!missing.ok) assert.equal(missing.error.code, 'NOT_FOUND')
  })

  it('never mistakes the generated index.md for an entry', async () => {
    // The same trap `tags/index.md` sprang once (decision 120): a generated file living inside a
    // directory that is otherwise a registry.
    await writeFile(join(root, 'knowledge', 'locking', 'index.md'), '# Domain index\n', 'utf8')
    const listing = unwrap(await listKnowledge(store))
    // KB-3 exists by now (the no-burn test above created it); the listing is domain-major,
    // then by file name — deterministic rather than meaningful.
    // (This assertion once lived **inside** a comment, after a literal `\n` — commented out,
    // so the test asserted nothing at all. Keep the assert on its own line.)
    assert.deepEqual([...listing.entries.map(entry => entry.key)].sort(), ['KB-1', 'KB-2', 'KB-3'], 'index.md is not listed as an entry')
    // …and it is not reported as *broken* either: dropping the filter makes the scan try to decode
    // `index.md` as a `KB-<n>` file, which lands it in `broken` while `entries` stays the same.
    assert.equal(
      listing.broken.some(entry => entry.path.includes('index.md')),
      false,
      'a generated file is skipped, not reported as unreadable',
    )
  })

  it('reports an entry in an illegal domain as broken, and one whose frontmatter does not decode', async () => {
    await mkdir(join(root, 'knowledge', 'BadDomain'), { recursive: true })
    await writeFile(join(root, 'knowledge', 'BadDomain', 'KB-9.md'), '---\ntitle: x\n---\n', 'utf8')
    const listing = unwrap(await listKnowledge(store))
    assert.equal(listing.broken.some(entry => entry.path === 'knowledge/BadDomain'), true)

    // The other "cannot read" branch: a decodable path whose frontmatter is not decodable.
    await writeFile(join(root, 'knowledge', 'locking', 'KB-10.md'), '---\nschema: [broken\n---\n', 'utf8')
    const again = unwrap(await listKnowledge(store))
    assert.equal(again.broken.some(entry => entry.path === 'knowledge/locking/KB-10.md'), true, 'a decode failure is reported, not dropped')
  })
})

describe('kbstore: updating', () => {
  it('rewrites the entry, keeping the source it was captured with', async () => {
    const updated = unwrap(await updateKnowledge(store, 'KB-1' as never, LATER, ORIGIN, {
      title: 'Windows 上的锁要用 mkdir（已修）',
      tags: ['windows', 'locking'],
    }))
    assert.equal(updated.entry.title, 'Windows 上的锁要用 mkdir（已修）')
    assert.deepEqual(updated.entry.tags, ['windows', 'locking'])
    assert.equal(updated.entry.source.capturedAt, '2026-10-15T12:00:00Z', 'the capture time is history')
    assert.equal(updated.entry.source.machineId, 'm-test')
    assert.equal(updated.committed, true)
  })

  it('refuses an update that breaks the vocabulary, leaving the file alone', async () => {
    const before = await readFile(join(root, 'knowledge', 'locking', 'KB-1.md'), 'utf8')
    const bad = await updateKnowledge(store, 'KB-1' as never, LATER, ORIGIN, { kbType: 'nope' })
    assert.equal(bad.ok, false)
    assert.equal(await readFile(join(root, 'knowledge', 'locking', 'KB-1.md'), 'utf8'), before)
  })
})

describe('kbstore: searching', () => {
  it('finds by text and returns citations rather than bodies', async () => {
    const result = unwrap(await searchKnowledgeIn(store, 'mkdir'))
    assert.ok(result.hits.length >= 1)
    const hit = result.hits[0]
    assert.equal(hit?.file, 'knowledge/locking/KB-1.md')
    assert.equal(typeof hit?.line, 'number')
    assert.ok((hit?.snippet.length ?? 0) <= 202)
    assert.equal(hit === undefined ? true : Object.hasOwn(hit, 'body'), false)
  })

  it('says nothing for a query nothing matches', async () => {
    const result = unwrap(await searchKnowledgeIn(store, 'zzzz-not-here'))
    assert.deepEqual(result.hits, [])
    assert.equal(result.matched, 0)
  })
})

describe('kbstore: the source quadruple comes from the caller', () => {
  it('derives the machine from the identity tuple (decision 48)', () => {
    assert.equal(originFromIdentity('agent:deepseek|dsh|m-abc|s-1' as never, 'fallback').machineId, 'm-abc')
    assert.equal(originFromIdentity(undefined, 'fallback').machineId, 'fallback')
    assert.equal(originFromIdentity('human:daiqc' as never, 'fallback').machineId, 'fallback', 'a human identity carries no machine')
    assert.equal(originFromIdentity('agent:x|dsh||s-1' as never, 'fallback').machineId, 'fallback', 'an empty machine slot falls back')
    assert.equal(originFromIdentity('nonsense' as never, 'fallback').machineId, 'fallback')
    assert.equal(originFromIdentity(undefined, 'm-abc', 'dsh', 'win32').os, 'win32')
  })

  it('records the git identity in the store, not in the entry', async () => {
    // A sanity check on the store side: the KB file is tracked and the tree is clean after commit.
    const status = await runGit(root, ['status', '--porcelain'])
    assert.equal(status.code, 0)
    assert.equal(status.stdout.includes('knowledge/'), false, `uncommitted knowledge: ${status.stdout}`)
  })

  it('keeps the counters file in the KB space', async () => {
    const counters = JSON.parse(await readFile(storePaths.counters(root, 'm-test'), 'utf8')) as {
      projects: Record<string, { next: number }>
    }
    assert.equal(Object.hasOwn(counters.projects, 'KB'), true, 'KB keys are allocated from the counters')
    assert.equal(unwrap(await stageAndCommit(root, ['knowledge'], 'chore: touch [no-issue]')), false, 'nothing to commit')
  })
})

describe('kbstore: the two key spaces do not get confused (decision 194)', () => {
  it('refuses an `issues` citation that is really a knowledge entry', async () => {
    // The exact shape that turned the ledger's CI red three times: KB-14 cites `[KB-12]`, and KB-12 is
    // another knowledge entry — `lint` only said so after the write had landed.
    const cited = unwrap(await createKnowledge(store, ACTOR, ORIGIN, {
      domain: 'locking', kbType: 'pitfall', title: 'a cited entry', body: 'x\n',
    }))
    const mistaken = await createKnowledge(store, ACTOR, ORIGIN, {
      domain: 'locking', kbType: 'pitfall', title: 'confused', body: 'y\n',
      issues: [cited.entry.key as never],
    })
    assert.equal(mistaken.ok, false)
    if (!mistaken.ok) {
      assert.equal(mistaken.error.code, 'INVALID_INPUT')
      assert.match(mistaken.error.message, /knowledge entry, not an issue/u)
      assert.deepEqual(mistaken.error.context?.confused, [cited.entry.key])
    }
  })

  it('still accepts a citation to an issue that has not arrived yet', async () => {
    // Two machines merge a reference before the issue exists; refusing that would break the workflow the
    // dangling check exists to *report*, not to forbid.
    const written = await createKnowledge(store, ACTOR, ORIGIN, {
      domain: 'locking', kbType: 'pitfall', title: 'future work', body: 'z\n',
      issues: ['DH-404' as never],
    })
    assert.equal(written.ok, true, JSON.stringify(written))
  })
})

describe('kbstore: a citation leaves the issue pointing back (decision 198)', () => {
  it('mirrors the knowledge key into the cited issue\'s kb_refs', async () => {
    const issue = unwrap(await createInStore(store, 'DH', LATER, { issueType: 'task', summary: 'mirrored' }))
    const created = unwrap(await createKnowledge(store, LATER, ORIGIN, {
      domain: 'locking', kbType: 'pitfall', title: 'leaves a trail', body: 'x\n',
      issues: [issue.key as never],
    }))
    assert.deepEqual(created.mirror?.updated, [issue.key], 'the cited issue was updated')

    const text = await readFile(join(root, 'projects', 'DH', 'issues', `${String(issue.key)}.md`), 'utf8')
    assert.match(text, new RegExp(`^kb_refs: \\[${String(created.entry.key)}\\]$`, 'mu'))

    // Re-running the mirror writes nothing: the same citation is already there.
    const again = unwrap(await updateKnowledge(store, created.entry.key, LATER, ORIGIN, { title: 'leaves a trail' }))
    assert.deepEqual(again.mirror?.updated, [], 'already mirrored — no second write')
  })

  it('reports a citation it could not mirror instead of hiding it', async () => {
    const created = unwrap(await createKnowledge(store, LATER, ORIGIN, {
      domain: 'locking', kbType: 'pitfall', title: 'dangling', body: 'y\n', issues: ['DH-999' as never],
    }))
    assert.deepEqual(created.mirror?.updated, [])
    assert.equal(created.mirror?.failed.length, 1)
    assert.equal(String(created.mirror?.failed[0]?.key), 'DH-999')
  })
})
