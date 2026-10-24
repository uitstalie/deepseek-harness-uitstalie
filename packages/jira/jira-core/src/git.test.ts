/**
 * Tests for core/git — a real repository in a temp directory.
 *
 * The behaviours that matter: `.gitattributes` exists before anything else (decision 5),
 * the two settings are filled in idempotently and never overwritten (decision 81), an
 * empty change makes no commit, a failing commit keeps the file that was written, and an
 * old store's `.gitignore` learns new patterns (decision 175's migration).
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { removeTree } from './testing/removeTree.ts'
import { writeTextAtomic } from './io.ts'
import {
  GITATTRIBUTES,
  type GitRunner,
  commitSubject,
  gitUserName,
  hasRemote,
  humanAuthorOf,
  initializeRepository,
  isRepository,
  runGit,
  stageAllAndCommit,
  stageAndCommit,
} from './git.ts'

let root = ''

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-jira-git-'))
})

after(async () => {
  if (root !== '') await removeTree(root)
})

describe('git: the repository starts with its attributes', () => {
  it('initialises once, and reports that it did', async () => {
    assert.equal(await isRepository(root), false)
    const created = await initializeRepository(root)
    assert.equal(created.ok, true)
    if (created.ok) assert.equal(created.value, true)
    assert.equal(await isRepository(root), true)

    const again = await initializeRepository(root)
    assert.equal(again.ok, true)
    if (again.ok) assert.equal(again.value, false, 'a second call is a no-op')
  })

  it('writes .gitattributes exactly as decision 5 requires, and .gitignore with it', async () => {
    assert.equal(await readFile(join(root, '.gitattributes'), 'utf8'), GITATTRIBUTES)
    const ignore = await readFile(join(root, '.gitignore'), 'utf8')
    assert.match(ignore, /^\.jira\/$/m)
    assert.match(ignore, /^var\/$/m)
    // Real git agrees the attribute applies to a comment file…
    const check = await runGit(root, ['check-attr', 'merge', '--', 'projects/DH/comments/DH-1.md'])
    assert.match(check.stdout, /merge: union/)
    // …and **only** to comment files (decision 154). `merge=union` on an issue file would concatenate
    // two machines' edits into one unreadable frontmatter — the opposite of decision 5's intent — so
    // the pattern is asserted from both sides rather than trusted to stay narrow.
    for (const path of ['projects/DH/issues/DH-1.md', 'config.md', 'BOARD.md']) {
      const other = await runGit(root, ['check-attr', 'merge', '--', path])
      assert.match(other.stdout, /merge: unspecified/u, `${path} must merge normally`)
    }
  })

  it('fills in the settings decision 81 owns, without overwriting what is set', async () => {
    // The backfill only runs on a real initialisation (`initializeRepository` returns early on an
    // existing repository), so the two halves take a repository each. Both drive the state they
    // need through the runner seam, because `git init` itself writes `core.fileMode` on a
    // filesystem with the exec bit (Fedora's) and leaves it unset on one without (Windows) —
    // the assertions must not depend on what the platform's git happened to write.
    const afterInit = (...commands: readonly (readonly string[])[]): GitRunner => async (dir, args) => {
      const result = await runGit(dir, args)
      if (args[0] === 'init') for (const command of commands) await runGit(dir, [...command])
      return result
    }

    const filled = await mkdtemp(join(tmpdir(), 'dsh-jira-git-fill-'))
    const kept = await mkdtemp(join(tmpdir(), 'dsh-jira-git-kept-'))
    try {
      // Half one: an absent key is filled in.
      const absent = afterInit(['config', '--local', '--unset', 'core.fileMode'])
      assert.equal((await initializeRepository(filled, absent)).ok, true)
      assert.equal((await runGit(filled, ['config', '--local', '--get', 'core.fileMode'])).stdout, 'false')
      assert.equal((await runGit(filled, ['config', '--local', '--get', 'i18n.commitEncoding'])).stdout, 'utf-8')

      // Half two: a value that is already there when we initialise survives.
      const present = afterInit(['config', '--local', 'core.fileMode', 'true'])
      assert.equal((await initializeRepository(kept, present)).ok, true)
      assert.equal(
        (await runGit(kept, ['config', '--local', '--get', 'core.fileMode'])).stdout,
        'true',
        'a value the user set stays',
      )
    } finally {
      await removeTree(filled)
      await removeTree(kept)
    }
  })

  it('migrates an old .gitignore forward, and only that (decision 175)', async () => {
    // A store created before a pattern existed never learns it — that is how `.jira/network.lock/`
    // ended up committable in a live store. The second initialise is where the migration runs.
    const dir = await mkdtemp(join(tmpdir(), 'dsh-jira-git-migrate-'))
    try {
      assert.equal((await initializeRepository(dir)).ok, true)

      // Age the store: drop the newest pattern, as a pre-decision-165 store would look.
      const aged = (await readFile(join(dir, '.gitignore'), 'utf8')).replace('*.tmp-*\n', '')
      assert.equal(aged.includes('*.tmp-*'), false, 'fixture: the pattern is really gone')
      await writeFile(join(dir, '.gitignore'), aged, 'utf8')

      const seen: string[][] = []
      const recording: GitRunner = async (d, args) => {
        seen.push([...args])
        return runGit(d, args)
      }
      const again = await initializeRepository(dir, recording)
      assert.equal(again.ok, true)
      if (again.ok) assert.equal(again.value, false, 'still the same repository — no re-init')

      const migrated = await readFile(join(dir, '.gitignore'), 'utf8')
      assert.match(migrated, /^\*\.tmp-\*$/m, 'the missing pattern is appended')
      assert.match(migrated, /^# added by dsh-jira \d{4}-\d{2}-\d{2}$/m, 'under a dated marker comment')
      assert.ok(migrated.startsWith(aged), 'nothing the store already had is rewritten')
      assert.ok(seen.some(args => args.join(' ') === 'add -- .gitignore'), 'the migration is staged')

      // And a complete .gitignore is a byte-exact no-op.
      const before = await readFile(join(dir, '.gitignore'), 'utf8')
      assert.equal((await initializeRepository(dir)).ok, true)
      assert.equal(await readFile(join(dir, '.gitignore'), 'utf8'), before, 'nothing missing, nothing touched')
    } finally {
      await removeTree(dir)
    }
  })

  it('does not create a .gitignore for a repository that has none', async () => {
    // Migration appends to an existing file; creating one is initializeRepository's job, and it
    // only does that on a real init — a foreign repository is left exactly as it was found.
    const dir = await mkdtemp(join(tmpdir(), 'dsh-jira-git-foreign-'))
    try {
      assert.equal((await runGit(dir, ['init', '--initial-branch=main'])).code, 0)
      const result = await initializeRepository(dir)
      assert.equal(result.ok, true)
      if (result.ok) assert.equal(result.value, false)
      await assert.rejects(readFile(join(dir, '.gitignore'), 'utf8'), 'no .gitignore is invented')
    } finally {
      await removeTree(dir)
    }
  })

  it('can read the name a commit would be attributed to', async () => {
    await runGit(root, ['config', '--local', 'user.name', 'daiqc'])
    await runGit(root, ['config', '--local', 'user.email', 'daiqc@example.invalid'])
    assert.equal(await gitUserName(root), 'daiqc')
  })
})

describe('git: commits', () => {
  it('commits exactly the paths it is given, and no-op changes make no commit', async () => {
    // The store commits the skeleton together with its first write; here we do the same,
    // so `.gitattributes` is in history before any data file (decision 5).
    const skeleton = await stageAndCommit(root, ['.gitattributes', '.gitignore'], 'chore: store skeleton [no-issue]')
    assert.equal(skeleton.ok, true)
    assert.match((await runGit(root, ['log', '--reverse', '--pretty=%s'])).stdout.split('\n')[0] ?? '', /skeleton/)

    const file = join(root, 'first.md')
    const written = await writeTextAtomic(file, 'one\n')
    assert.equal(written.ok, true)

    const committed = await stageAndCommit(root, ['first.md'], commitSubject({ key: 'DH-1', what: 'create' }))
    assert.equal(committed.ok, true)
    if (committed.ok) assert.equal(committed.value, true)

    const subject = (await runGit(root, ['log', '-1', '--pretty=%s'])).stdout
    assert.equal(subject, 'DH-1: create')

    const again = await stageAndCommit(root, ['first.md'], commitSubject({ key: 'DH-1', what: 'create' }))
    assert.equal(again.ok, true)
    if (again.ok) assert.equal(again.value, false, 'nothing changed, so there is nothing to commit')

    await writeTextAtomic(file, 'two\n')
    const second = await stageAndCommit(root, ['first.md'], commitSubject({ key: 'DH-1', what: 'update', revision: 2 }))
    assert.equal(second.ok, true)
    if (second.ok) assert.equal(second.value, true)
    assert.equal((await runGit(root, ['log', '-1', '--pretty=%s'])).stdout, 'DH-1: update (rev 2)')

    const other = await runGit(root, ['status', '--porcelain'])
    assert.equal(other.stdout, '', 'the working tree is clean afterwards')
  })

  it('keeps the commit when a path in the list is an empty directory', async () => {
    // `git add` tolerates an empty directory, `git commit -- <dir>` refuses it; committing
    // the list git itself staged is what keeps the commit from being silently lost.
    await mkdir(join(root, 'empty-dir'), { recursive: true })
    const written = await writeTextAtomic(join(root, 'second.md'), 'content\n')
    assert.equal(written.ok, true)
    const result = await stageAndCommit(root, ['empty-dir', 'second.md'], 'DH-1: update (rev 3)')
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.value, true)
    assert.equal((await runGit(root, ['log', '-1', '--pretty=%s'])).stdout, 'DH-1: update (rev 3)')
  })
  it('says what git said when the commit cannot happen, and keeps the file it wrote', async () => {
    // The write already happened when the commit fails, and the file must still be there
    // afterwards — otherwise the ledger would lose data silently (the header's promise).
    const broken = await mkdtemp(join(tmpdir(), 'dsh-jira-nogit-'))
    try {
      assert.equal((await writeTextAtomic(join(broken, 'whatever.md'), 'still here\n')).ok, true)
      const result = await stageAndCommit(broken, ['whatever.md'], 'DH-1: update')
      assert.equal(result.ok, false)
      if (!result.ok) assert.match(result.error.message, /git add failed/)
      assert.equal(await readFile(join(broken, 'whatever.md'), 'utf8'), 'still here\n', 'the file survives the failed commit')
    } finally {
      await removeTree(broken)
    }
  })

  it('reports a store with no remote instead of pretending to push', async () => {
    assert.equal(await hasRemote(root), false)
  })

  it('gives a commit an identity when the machine has none (decision 146)', async () => {
    // A CI runner has no `user.name`/`user.email`, and `git commit` then fails with "Author
    // identity unknown" — while the file write succeeded, so the ledger looks healthy and
    // **nothing is versioned**. The plugin's own CI caught it (2026-10-16).
    const seen: string[][] = []
    const noIdentity: GitRunner = async (_dir, args) => {
      seen.push([...args])
      if (args[0] === 'diff') return { code: 0, stdout: 'a.md\n', stderr: '' }
      if (args[0] === 'config') return { code: 1, stdout: '', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
    const result = await stageAndCommit('/store', ['a.md'], 'DH-1: create', noIdentity)
    assert.equal(result.ok, true)
    const commit = seen.find(args => args.includes('commit'))
    assert.ok(commit !== undefined, 'the commit still has to run')
    assert.deepEqual(commit.slice(0, 4), ['-c', 'user.name=dsh-jira', '-c', 'user.email=jira@local'])
  })

  it('leaves the machine alone when it already has an identity', async () => {
    // A developer's own name has to land on their commits, and `user.name` is what `human:<name>`
    // reads (§4.9) — so the fallback must never be written into the repository's config.
    const seen: string[][] = []
    const withIdentity: GitRunner = async (_dir, args) => {
      seen.push([...args])
      if (args[0] === 'diff') return { code: 0, stdout: 'a.md\n', stderr: '' }
      if (args[0] === 'config') return { code: 0, stdout: 'Ada\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
    await stageAndCommit('/store', ['a.md'], 'DH-1: create', withIdentity)
    const commit = seen.find(args => args.includes('commit'))
    assert.equal(commit?.[0], 'commit', 'no -c once the identity is configured')
  })

  it('names the human only when the machine has both halves (decision 147)', async () => {
    const both: GitRunner = async (_dir, args) => ({
      code: 0,
      stdout: args[2] === 'user.name' ? 'Ada\n' : 'ada@example.invalid\n',
      stderr: '',
    })
    assert.equal(await humanAuthorOf('/store', both), 'Ada <ada@example.invalid>')

    // Half an identity is no identity: `--author` needs a complete `Name <email>`, and inventing the
    // missing half would put a made-up address in the audit trail.
    const noEmail: GitRunner = async (_dir, args) => (args[1] === 'user.name'
      ? { code: 0, stdout: 'Ada\n', stderr: '' }
      : { code: 1, stdout: '', stderr: '' })
    assert.equal(await humanAuthorOf('/store', noEmail), undefined)
  })

  it('takes everything uncommitted and passes the author through (decision 147)', async () => {
    const seen: string[][] = []
    const fake: GitRunner = async (_dir, args) => {
      seen.push([...args])
      if (args[0] === 'diff') return { code: 0, stdout: 'a.md\u0000projects/DH/issues/DH-1.md\u0000', stderr: '' }
      if (args[0] === 'config') return { code: 0, stdout: 'Ada\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
    const result = await stageAllAndCommit('/store', 'chore: 收编 [no-issue]', fake, 'Ada <ada@example.invalid>')
    assert.equal(result.ok, true, JSON.stringify(result))
    if (result.ok) assert.deepEqual([...result.value], ['a.md', 'projects/DH/issues/DH-1.md'])
    assert.deepEqual(seen[0], ['add', '-A'], 'it stages what nobody listed')
    const commit = seen.find(args => args.includes('commit'))
    assert.ok(commit !== undefined)
    assert.ok(commit.includes('--author=Ada <ada@example.invalid>'), 'the human keeps authorship')
    assert.ok(commit.includes('a.md') && commit.includes('projects/DH/issues/DH-1.md'))
  })

  it('has nothing to adopt when the tree is already clean (decision 147)', async () => {
    const fake: GitRunner = async () => ({ code: 0, stdout: '', stderr: '' })
    const result = await stageAllAndCommit('/store', 'chore: 收编 [no-issue]', fake)
    assert.equal(result.ok, true, JSON.stringify(result))
    if (result.ok) assert.deepEqual([...result.value], [], 'a clean tree commits nothing')
  })
})
