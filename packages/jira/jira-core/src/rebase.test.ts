/**
 * Tests for core/rebase — pulling with a rebase, and marking what both machines touched
 * (decisions 4/71/84/119).
 *
 * The scenario is a real one, with real git: two clones of the same ledger push to one origin, one
 * changes the note and the other the summary, and the machine that pulls afterwards must end up with
 * **both** changes and a `conflicted` flag — because "git merged it" is not the same as "nobody has
 * to look".
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { removeTree } from './testing/removeTree.ts'
import { type GitRunner, runGit } from './git.ts'
import { pullRebase, renderRebase, REBASE_TIMEOUT_MS, keysTouchedIn } from './rebase.ts'
import { scaffoldStore } from './scaffold.ts'
import { createStore, createInStore, readComments, transact, type Store } from './store.ts'
import { applyUpdate } from './mutate.ts'
import { type Identity, type IssueKey, type Timestamp } from './entity.ts'

const MACHINE_A = 'aaaaaaaa'
const MACHINE_B = 'bbbbbbbb'
const AT = '2026-10-15T12:00:00Z' as Timestamp
const ACTOR = Object.freeze({ by: 'human:daiqc' as Identity, at: AT })

const work: string[] = []
const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  assert.equal(result.ok, true, `expected success, got ${JSON.stringify(result)}`)
  if (!result.ok) throw new Error('unreachable')
  return result.value
}

const tempdir = async (name: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), `dsh-jira-rebase-${name}-`))
  work.push(directory)
  return directory
}

const configure = async (root: string, name: string): Promise<void> => {
  await runGit(root, ['config', '--local', 'user.name', name])
  await runGit(root, ['config', '--local', 'user.email', `${name}@example.invalid`])
}

let origin = ''
let a = ''
let storeA: Store
let b = ''
let storeB: Store
let key = '' as IssueKey

before(async () => {
  origin = await tempdir('origin')
  await runGit(origin, ['init', '--bare', '--initial-branch=main'])

  // Machine A: a real store with one issue, pushed to the origin.
  a = await tempdir('a')
  unwrap(await scaffoldStore(a))
  await configure(a, 'machine-a')
  storeA = createStore({ root: a, machineId: MACHINE_A })
  const created = unwrap(await createInStore(storeA, 'DH', ACTOR, { issueType: 'task', summary: 'the shared issue', body: 'body\n' }))
  key = created.key
  await runGit(a, ['remote', 'add', 'origin', origin])
  await runGit(a, ['push', '-u', 'origin', 'main'])

  // Machine B: a clone, with its own machine id.
  b = await tempdir('b')
  await runGit(join(b, '..'), ['clone', origin, b])
  await configure(b, 'machine-b')
  storeB = createStore({ root: b, machineId: MACHINE_B })
})

after(async () => {
  for (const directory of work) await removeTree(directory)
})

describe('rebase: two machines, one issue', () => {
  it('says there is nothing to do without a divergence', async () => {
    const outcome = unwrap(await pullRebase(storeB, ACTOR))
    assert.equal(outcome.pulled, false)
    assert.equal(outcome.stopped, false)
    assert.deepEqual(outcome.marked, [])
    assert.match(renderRebase(outcome), /nothing to pull/)
  })

  it('marks an issue both sides touched, keeping both changes', async () => {
    // A changes the note, B changes the summary: different lines, so git merges cleanly — and that is
    // exactly the case that must still be marked, because the merge is not a decision.
    unwrap(await transact(storeA, key, ACTOR, (issue, ctx) => applyUpdate(issue, { note: 'changed on A' }, ctx), 'update'))
    unwrap(await transact(storeB, key, ACTOR, (issue, ctx) => applyUpdate(issue, { summary: 'changed on B' }, ctx), 'update'))
    const pushed = await runGit(b, ['push', 'origin', 'main'])
    assert.equal(pushed.code, 0, pushed.stderr)

    const outcome = unwrap(await pullRebase(storeA, ACTOR))
    assert.equal(outcome.pulled, true, JSON.stringify(outcome))
    assert.deepEqual(outcome.marked, [key])
    assert.deepEqual(outcome.failed, [])

    const text = await readFile(join(a, 'projects', 'DH', 'issues', `${key}.md`), 'utf8')
    assert.match(text, /^conflicted: true$/m, 'the flag is set by the pull path, not by a reader')
    assert.match(text, /note: changed on A/, 'A keeps its own change')
    assert.match(text, /summary: changed on B/, 'and has B\'s change too')

    const comments = unwrap(await readComments(storeA, key))
    assert.equal(comments.length, 1, 'and the conflict is recorded as a comment')
    assert.match(comments[0]?.body ?? '', /Both sides changed DH-1/)
    assert.match(renderRebase(outcome), /marked conflicted: DH-1/)
  })

  it('leaves an issue only one side touched alone', async () => {
    const other = unwrap(await createInStore(storeA, 'DH', ACTOR, { issueType: 'task', summary: 'only A touches this' }))
    await runGit(a, ['push', 'origin', 'main'])
    const outcome = unwrap(await pullRebase(storeB, ACTOR))
    assert.equal(outcome.pulled, true)
    assert.equal(outcome.marked.includes(String(other.key)), false, 'B never touched it')
    const text = await readFile(join(b, 'projects', 'DH', 'issues', `${String(other.key)}.md`), 'utf8')
    assert.equal(/^conflicted: true$/m.test(text), false, 'the flag is absent, not merely false')
  })
})

describe('rebase: reading the ranges', () => {
  it('collects the keys a range of commits mentions', async () => {
    await writeFile(join(a, 'touched.txt'), 'x\n', 'utf8')
    await runGit(a, ['add', 'touched.txt'])
    await runGit(a, ['commit', '-m', 'DH-1: one'])
    await runGit(a, ['commit', '--allow-empty', '-m', 'DH-1 and DH-2: two'])
    const keys = await keysTouchedIn(a, 'HEAD~2..HEAD')
    assert.deepEqual([...keys].sort(), ['DH-1', 'DH-2'])
  })

  it('has a bounded network step (decision 84)', () => {
    assert.equal(REBASE_TIMEOUT_MS, 15_000)
  })

  it('reports a stopped rebase instead of forcing it', async () => {
    // Two machines edit the same line; git cannot merge, and the design forbids forcing (red line 1).
    unwrap(await transact(storeA, key, ACTOR, (issue, ctx) => applyUpdate(issue, { summary: 'A wins' }, ctx), 'update'))
    unwrap(await transact(storeB, key, ACTOR, (issue, ctx) => applyUpdate(issue, { summary: 'B wins' }, ctx), 'update'))
    await runGit(b, ['push', 'origin', 'main'])

    const outcome = unwrap(await pullRebase(storeA, ACTOR))
    assert.equal(outcome.stopped, true, JSON.stringify(outcome))
    assert.equal(outcome.pulled, false)
    assert.equal(outcome.reason !== undefined && outcome.reason !== '', true)
    assert.match(renderRebase(outcome), /resolve it by hand; nothing was forced/)

    // Clean up the stopped rebase for the suite, by finishing it the way a human would: take ours.
    // (The test asserts that the *tool* refuses to do this automatically, so doing it here is fine.)
    await runGit(a, ['rebase', '--abort'])
  })
})

describe('rebase: the invocation carries an identity when the machine has none (decisions 146/148)', () => {
  it('gives `pull --rebase` the same per-invocation fallback a commit gets', async () => {
    // Found by the plugin's own CI on 2026-10-17, once decision 148 made the rebase load-bearing for
    // every write: a rebase **replays** commits and replaying creates one, so it needs a committer
    // identity. On a runner or container where git cannot guess one, `pull --rebase` stopped with
    // "Committer identity unknown", left the store mid-rebase and the push never happened. Injected
    // runner, so the assertion is about the arguments and nothing else.
    const seen: string[][] = []
    const run: GitRunner = async (_root, args) => {
      seen.push([...args])
      if (args[0] === 'remote') return { code: 0, stdout: 'origin\n', stderr: '' }
      if (args[0] === 'config') return { code: 1, stdout: '', stderr: '' }
      if (args[0] === 'rev-parse') return { code: 0, stdout: args[1] === 'HEAD' ? 'localsha\n' : 'remotesha\n', stderr: '' }
      if (args[0] === 'merge-base') return { code: 0, stdout: 'basesha\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }

    // A real directory: the network lock (decision 171) is taken around the rebase, so the store has to
    // be one — a fake root that cannot hold `.jira/network.lock` would fail before the rebase runs.
    const root = await mkdtemp(join(tmpdir(), 'dsh-jira-rebase-id-'))
    try {
      const outcome = unwrap(await pullRebase(createStore({ root, machineId: MACHINE_A }), ACTOR, { run }))
      assert.equal(outcome.pulled, true, JSON.stringify(outcome))
      const pull = seen.find(args => args.includes('pull'))
      assert.deepEqual(pull, [
        '-c', 'user.name=dsh-jira',
        '-c', 'user.email=jira@local',
        'pull', '--rebase',
      ])
    } finally {
      await removeTree(root)
    }
  })
})

describe('rebase: a refused pull is retried once (decision 171)', () => {
  it('re-runs the pull when another process fetched under it, and succeeds on the second try', async () => {
    // The exact stderr git printed while a live plugin and a CLI sync collided on one clone; the settle
    // path turns "pull stopped" into "do not push", so retrying here is what keeps the store current.
    let pulls = 0
    const run: GitRunner = async (_root, args) => {
      if (args[0] === 'remote') return { code: 0, stdout: 'origin\n', stderr: '' }
      if (args[0] === 'config') return { code: 1, stdout: '', stderr: '' }
      if (args[0] === 'rev-parse') return { code: 0, stdout: args[1] === 'HEAD' ? 'localsha\n' : 'remotesha\n', stderr: '' }
      if (args[0] === 'merge-base') return { code: 0, stdout: 'basesha\n', stderr: '' }
      if (args.includes('pull')) {
        pulls += 1
        if (pulls === 1) {
          return { code: 1, stdout: '', stderr: 'warning: fetch updated the current branch (fast-forward your working tree)\n' }
        }
        return { code: 0, stdout: '', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    }
    const root = await mkdtemp(join(tmpdir(), 'dsh-jira-rebase-retry-'))
    try {
      const outcome = unwrap(await pullRebase(createStore({ root, machineId: MACHINE_A }), ACTOR, { run }))
      assert.equal(outcome.pulled, true, JSON.stringify(outcome))
      assert.equal(pulls, 2, 'the retryable failure is retried exactly once')
    } finally {
      await removeTree(root)
    }
  })
})
