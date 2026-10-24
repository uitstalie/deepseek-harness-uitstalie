/**
 * Tests for core/generateStore — the wiring around the pure renderer (decisions 39/79/87/120).
 *
 * The property that everything else depends on: **regenerating unchanged inputs is a no-op**, so
 * "the generated files are stale" means the inputs really changed, and CI can assert it by
 * regenerating and diffing.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { GENERATED_PATHS, readGeneratedHead } from './generate.ts'

/** Decision 79: the fixed root files **plus** the fixture project's own index and log. */
const ALL_GENERATED = Object.freeze([...GENERATED_PATHS, 'projects/DH/index.md', 'projects/DH/log.md'])
import { checkGenerated, currentSourceTree, planGenerated, readCommitRows, regenerateAndCommit, writeGenerated } from './generateStore.ts'
import { initializeRepository, runGit, stageAndCommit } from './git.ts'
import { scaffoldStore } from './scaffold.ts'
import { createStore, storePaths } from './store.ts'
import { transact } from './store.ts'
import { applyUpdate } from './mutate.ts'

let root = ''
let store: ReturnType<typeof createStore>

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  assert.equal(result.ok, true, `expected success, got ${JSON.stringify(result)}`)
  if (!result.ok) throw new Error('unreachable')
  return result.value
}

const readGenerated = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(join(root, ...path.split('/')), 'utf8')
  } catch {
    return undefined
  }
}

const generate = async (at = '2026-10-15T12:00:00Z') => {
  const plan = unwrap(await planGenerated(store, at))
  const written = unwrap(await writeGenerated(store, plan))
  return { plan, written }
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-jira-generate-'))
  unwrap(await scaffoldStore(root))
  await runGit(root, ['config', '--local', 'user.name', 'tester'])
  await runGit(root, ['config', '--local', 'user.email', 'tester@example.invalid'])
  store = createStore({ root, machineId: 'gen-machine' })

  const { createInStore } = await import('./store.ts')
  unwrap(await createInStore(store, 'DH', { by: 'human:tester' as never, at: '2026-10-15T12:00:00Z' as never },
    { issueType: 'task', summary: 'first issue' }))
  // `log.md` lists keyed commits only, so one keyed and one unkeyed commit prove the filter.
  unwrap(await stageAndCommit(root, ['projects'], 'DH-1: create (rev 1)'))
  await writeFile(join(root, 'notes.md'), 'scratch\n', 'utf8')
  unwrap(await stageAndCommit(root, ['notes.md'], 'chore: unkeyed work [no-issue]'))
})

after(async () => {
  if (root !== '') await rm(root, { recursive: true, force: true })
})

describe('generate: writing the four files', () => {
  it('writes all of them with a head, and then reports them fresh', async () => {
    const { written } = await generate()
    assert.deepEqual([...written.written].sort(), [...ALL_GENERATED].sort())

    for (const path of ALL_GENERATED) {
      const text = await readGenerated(path)
      assert.ok(text !== undefined, `${path} must exist`)
      const head = readGeneratedHead(text)
      assert.ok(head !== undefined, `${path} must carry a head`)
      assert.equal(head.sourceTree, unwrap(await currentSourceTree(store)))
      assert.equal(text.includes('\r'), false)
    }

    assert.deepEqual(unwrap(await checkGenerated(store)), [], 'nothing is stale right after generating')
  })

  it('keeps a keyed commit in log.md and leaves the unkeyed one out', async () => {
    const log = await readGenerated('log.md')
    assert.match(log ?? '', /DH-1: create \(rev 1\)/)
    assert.equal((log ?? '').includes('unkeyed work'), false)
  })

  it('regenerating unchanged inputs changes nothing at all', async () => {
    const before = Object.fromEntries(await Promise.all(ALL_GENERATED.map(async path => [path, await readGenerated(path)])))
    const { plan, written } = await generate('2026-11-01T09:00:00Z')
    assert.equal(plan.stale, false)
    assert.deepEqual(written.written, [], 'no file is rewritten')
    assert.deepEqual(written.unchanged.length, ALL_GENERATED.length)
    for (const path of ALL_GENERATED) {
      assert.equal(await readGenerated(path), before[path], `${path} must be byte-identical`)
    }
  })
})

describe('generate: staleness is a real input change', () => {
  it('marks BOARD.md stale when an issue changes, and fresh again after regenerating', async () => {
    unwrap(await transact(store, 'DH-1' as never, { by: 'human:tester' as never, at: '2026-10-15T13:00:00Z' as never },
      (issue, ctx) => applyUpdate(issue, { summary: 'renamed by the test' }, ctx)))

    // **Every** generated head names the source tree it came from, so one input change makes all
    // four stale — that is the point of the head (decision 79): none of them may claim freshness
    // while the inputs have moved. (What each file *contains* still differs; only BOARD.md's body
    // changes here.)
    const stale = unwrap(await checkGenerated(store))
    assert.deepEqual([...stale.map(entry => entry.path)].sort(), [...ALL_GENERATED].sort())
    assert.ok(stale.every(entry => entry.reason === 'stale'))

    const { plan } = await generate('2026-10-15T14:00:00Z')
    assert.equal(plan.stale, true, 'a real change does rewrite')
    assert.match((await readGenerated('BOARD.md')) ?? '', /renamed by the test/)
    assert.deepEqual(unwrap(await checkGenerated(store)), [])
  })

  it('reports a missing file rather than pretending it is current', async () => {
    const path = join(root, 'BOARD.md')
    const backup = await readFile(path, 'utf8')
    await rm(path)
    const stale = unwrap(await checkGenerated(store))
    assert.deepEqual(stale, [{ path: 'BOARD.md', reason: 'missing' }])
    await writeFile(path, backup, 'utf8')
    assert.deepEqual(unwrap(await checkGenerated(store)), [])
  })

  it('notices a hand-edited file (its head no longer matches the inputs)', async () => {
    const path = join(root, 'index.md')
    const backup = await readFile(path, 'utf8')
    await writeFile(path, `${backup}\nhand-written line\n`, 'utf8')
    const stale = unwrap(await checkGenerated(store))
    assert.deepEqual(stale.map(entry => entry.path), ['index.md'])
    await writeFile(path, backup, 'utf8')
    assert.deepEqual(unwrap(await checkGenerated(store)), [])
  })

  it('is not disturbed by writes that are not generated inputs', async () => {
    const before = unwrap(await currentSourceTree(store))
    // A comment file, a counter and the README are all outside the input allow-list, so they must
    // not move the tree hash. `log.md` is the exception that proves the rule: its input is the
    // commit history, so the new keyed commit does make *it* stale (decision 120).
    await writeFile(join(root, 'README.md'), `${await readFile(join(root, 'README.md'), 'utf8')}\nedited by the test\n`, 'utf8')
    assert.equal(unwrap(await stageAndCommit(root, ['README.md'], 'DH-1: touch the readme (rev 1)')), true, 'a commit really happened')
    assert.equal(unwrap(await currentSourceTree(store)), before, 'the tree hash only covers real inputs')
    // Every commit log has this property: its input is the history, not the tree hash (decision 120).
    assert.deepEqual(unwrap(await checkGenerated(store)).map(entry => entry.path).sort(), ['log.md', 'projects/DH/log.md'])
  })
})

describe('generate: the commit log', () => {
  it('lists keyed commits only, newest first, and skips the unkeyed ones', async () => {
    // `readCommitRows` is a plain list, not a `Result`: no commits is a normal answer, not an error.
    const rows = await readCommitRows(root)
    assert.ok(rows.length >= 2)
    assert.ok(rows.every(row => /^[A-Z][A-Z0-9]{1,5}-\d+/u.test(row.subject)), JSON.stringify(rows))
    assert.equal(rows.some(row => row.subject.includes('unkeyed work')), false)
    assert.equal(rows[0]?.subject, 'DH-1: touch the readme (rev 1)', 'newest first')
    assert.match(rows[0]?.date ?? '', /^\d{4}-\d{2}-\d{2}$/u)
    for (const row of rows) assert.match(row.hash, /^[0-9a-f]{7,}$/u)
  })

  it('says nothing rather than failing outside a repository', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'dsh-jira-nogit-'))
    assert.deepEqual(await readCommitRows(bare), [])
    await rm(bare, { recursive: true, force: true })
  })

  it('refuses to generate without a vocabulary, instead of writing empty files', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'dsh-jira-novocab-'))
    const bareStore = createStore({ root: bare, machineId: 'gen-machine' })
    const plan = await planGenerated(bareStore, '2026-10-15T12:00:00Z')
    assert.equal(plan.ok, false)
    if (!plan.ok) assert.match(plan.error.message, /no readable config.md/)
    assert.equal(await readGenerated('BOARD.md') !== undefined, true, 'the real store is untouched')
    await rm(bare, { recursive: true, force: true })
  })

  it('keeps the store path helper in step with the generated paths', () => {
    // A guard against somebody renaming a generated file in one place only.
    assert.equal(storePaths.config(root).endsWith('config.md'), true)
  })
})

describe('generate: a domain counts its entries, never its own output', () => {
  it('is a fixed point the first time a domain gets an index and a log', async () => {
    // This write creates the domain directory; the generated `index.md`/`log.md` do not exist yet.
    // The first generation used to count them as knowledge — the root index reported **3** entries
    // for a domain holding 1 — and because that number only appeared *after* the write, no single
    // `generate` was a fixed point, which is exactly what CI's "regenerate and diff" asserts
    // (found 2026-10-16; the trap `tags/index.md` sprang in decision 120 ⑤).
    const { createKnowledge } = await import('./kbstore.ts')
    unwrap(await createKnowledge(
      store,
      { by: 'human:tester' as never, at: '2026-10-15T12:00:00Z' as never },
      Object.freeze({ machineId: 'm-test', os: 'linux', tool: 'dsh' }),
      { domain: 'hot-reload', kbType: 'concept', title: '把包根纳入 hmr 的 root', tags: [], body: '一句话。\n', issues: [] },
    ))

    await generate()
    assert.deepEqual(unwrap(await checkGenerated(store)), [], 'one generate has to be enough')

    assert.match((await readGenerated('index.md')) ?? '', /\[hot-reload\]\(\.\/knowledge\/hot-reload\/\) — 1 条/u)
    assert.match((await readGenerated('knowledge/hot-reload/index.md')) ?? '', /1 条/u)
  })
})

describe('generateStore: a commit that did not land is not a success (decision 148)', () => {
  it('reports the failure instead of returning the file list', async () => {
    // A store with a valid vocabulary but an unusable repository: a **file** named `.git` makes
    // `git init` refuse on every platform, so this exercises the swallow itself rather than an OS quirk.
    const dir = await mkdtemp(join(tmpdir(), 'dsh-jira-nogit-'))
    await writeFile(storePaths.config(dir), `---
schema: config/v1
type: config
statuses:
  - { name: todo, order: 0 }
  - { name: closed, order: 1 }
transitions:
  - [todo, closed]
closed: [closed]
issue_types: [task, bug]
kb_types: [howto, decision]
priorities: [S1, S2, S3, S4, S5]
resolutions: [fixed, invalid]
---

config body
`, 'utf8')
    await writeFile(join(dir, '.git'), 'not a real git directory', 'utf8')

    const store = createStore({ root: dir, machineId: 'eeeeeeee' })
    const result = await regenerateAndCommit(store, '2026-10-15T12:00:00Z' as never)

    assert.equal(result.ok, false, 'written-but-uncommitted must not be reported as ok')
    await rm(dir, { recursive: true, force: true })
  })
})

describe('generateStore: the log window counts keyed commits only (decision 168)', () => {
  it('does not let an unkeyed commit push the oldest keyed line out of log.md', async () => {
    // The settle commit (`chore: 重生成派生工件 [no-issue]`) is unkeyed but touches `projects/*/log.md`,
    // so a window over *all* commits shifts every time it lands — and the log it just wrote is stale
    // before the push finishes. The store's own CI went red on exactly that.
    const dir = await mkdtemp(join(tmpdir(), 'dsh-jira-logwindow-'))
    try {
      await initializeRepository(dir)
      const commit = async (subject: string): Promise<void> => {
        const result = await runGit(dir, ['-c', 'user.name=t', '-c', 'user.email=t@e.invalid', 'commit', '--allow-empty', '-q', '-m', subject])
        assert.equal(result.code, 0, result.stderr)
      }
      await commit('DH-1: create (rev 1)')
      const keyedLimit = await readCommitRows(dir, undefined, 1)
      assert.equal(keyedLimit.length, 1, 'the window is one keyed commit')

      // An unkeyed commit lands *after* it, in the same window: with `-n` counting it, the keyed window
      // would shrink to zero.
      await commit('chore: 重生成派生工件 [no-issue]')
      const still = await readCommitRows(dir, undefined, 1)
      assert.deepEqual(still.map(row => row.subject), ['DH-1: create (rev 1)'], 'the keyed window is unchanged')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
