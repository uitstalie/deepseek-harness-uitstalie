/**
 * Tests for core/io — the filesystem boundary (decisions 5, 60, 65).
 *
 * The behaviours worth pinning: encoding rules are enforced rather than normalized, the
 * atomic write leaves nothing behind, and a file-level failure is translated into a
 * **domain** failure by the domain function (with the issue key, not a path, in context).
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { asIssueKey } from './entity.ts'
import { exists, fileStore, issuePath, listDir, listDirEntries, mkdirp, projectOfKey, readIssue, readText, writeIssue, writeTextAtomic, sourceTreeEntries } from './io.ts'
import { removeTree } from './testing/removeTree.ts'

const DH1 = asIssueKey('DH-1')
assert.ok(DH1 !== undefined)

const FILE = `---
schema: issue/v1
type: issue
project: DH
issue_type: task
status: todo
summary: short
priority: S3
created_at: 2026-10-15T08:30:00Z
updated_at: 2026-10-15T08:30:00Z
reporter: human:daiqc
---

body
`

let root = ''
let store = fileStore('')

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-jira-io-'))
  store = fileStore(root)
})

after(async () => {
  if (root !== '') await removeTree(root)
})

describe('io: paths are derived, never stored', () => {
  it('derives the project from the key and keeps the key as the file name', () => {
    assert.equal(projectOfKey(DH1), 'DH')
    assert.match(issuePath(store, 'DH', DH1), /projects[\\/]DH[\\/]issues[\\/]DH-1\.md$/)
  })
})

describe('io: reading', () => {
  it('reports a missing file as a file-level failure, not a domain one', async () => {
    const missing = await readText(join(root, 'nope.md'))
    assert.equal(missing.ok, false)
    if (!missing.ok) {
      assert.equal(missing.error.kind, 'missing')
      assert.match(missing.error.path, /nope\.md$/)
    }
  })

  it('translates a missing file into NOT_FOUND carrying the issue key', async () => {
    const result = await readIssue(store, DH1)
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.error.code, 'NOT_FOUND')
      assert.equal(result.error.context?.key, 'DH-1')
      // The path is not the identity, so it must not masquerade as one.
      assert.equal(JSON.stringify(result.error.context).includes('issues'), false)
    }
  })

  it('round-trips what the writer wrote', async () => {
    const written = await writeIssue(store, FILE, DH1)
    assert.equal(written.ok, true)
    const read = await readIssue(store, DH1)
    assert.equal(read.ok, true)
    if (read.ok) {
      assert.equal(read.value.issue.key, 'DH-1')
      assert.equal(read.value.issue.status, 'todo')
      assert.equal(read.value.issue.body, 'body\n')
    }
  })
})

describe('io: writing enforces the store rules instead of normalizing them', () => {
  it('refuses CR, so a Windows editor cannot quietly rewrite every line', async () => {
    const result = await writeTextAtomic(join(root, 'cr.md'), 'a\r\nb\n')
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.error.code, 'WRITE_FAILED')
      assert.match(result.error.message, /LF-only/)
    }
  })

  it('refuses a BOM', async () => {
    const result = await writeTextAtomic(join(root, 'bom.md'), '\uFEFFx\n')
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error.message, /BOM/)
  })

  it('creates missing directories, writes LF, and leaves no temporary file behind', async () => {
    const path = join(root, 'deep', 'er', 'file.md')
    const result = await writeTextAtomic(path, 'one\ntwo\n')
    assert.equal(result.ok, true)
    const text = await readText(path)
    assert.equal(text.ok, true)
    if (text.ok) assert.equal(text.value, 'one\ntwo\n')
    const leftovers = (await readdir(join(root, 'deep', 'er'))).filter(name => name.includes('.tmp-'))
    assert.deepEqual(leftovers, [])
  })
})

describe('io: hashing the tree refuses to hash a partial one (decision 169)', () => {
  it('reports a tree it cannot walk instead of returning what it could read', async () => {
    // A path that is a *file* cannot be read as a directory: the old version swallowed the readdir
    // failure and returned an empty list, so `source_tree` was a hash of nothing — which makes every
    // derived file look fresh.
    const dir = await mkdtemp(join(tmpdir(), 'dsh-jira-tree-'))
    try {
      const file = join(dir, 'not-a-directory')
      await writeFile(file, 'x', 'utf8')
      const entries = await sourceTreeEntries(file)
      assert.equal(entries.ok, false)
      if (!entries.ok) assert.equal(entries.error.code, 'WRITE_FAILED')
      // A missing subtree is still fine: a store does not have every directory yet.
      const missing = await sourceTreeEntries(join(dir, 'absent'))
      assert.equal(missing.ok, true)
    } finally {
      await removeTree(dir)
    }
  })
})

describe('io: the atomic write retries, then reports (decision 170)', () => {
  it('tries writeAttempts times and leaves no temporary behind', async () => {
    // A rename onto an existing **directory** always fails, which is the one portable way to make the
    // loop exhaust: the Windows EPERM/EBUSY path had no test at all before this.
    const dir = await mkdtemp(join(tmpdir(), 'dsh-jira-retry-'))
    try {
      const target = join(dir, 'occupied')
      await mkdir(target)
      const written = await writeTextAtomic(target, 'x')
      assert.equal(written.ok, false)
      if (!written.ok) {
        assert.match(written.error.message, /atomic write failed after \d+ attempts/u)
        assert.equal(written.error.code, 'WRITE_FAILED')
      }
      const leftovers = (await readdir(dir)).filter(name => name.includes('.tmp-'))
      assert.deepEqual(leftovers, [], 'every attempt cleaned its own temporary')
    } finally {
      await removeTree(dir)
    }
  })
})

describe('io: the directory primitives every other module shares (decision 180)', () => {
  it('exists reports a fact, never a failure', async () => {
    const path = join(root, 'exists.md')
    assert.equal(await exists(path), false)
    assert.equal((await writeTextAtomic(path, 'x\n')).ok, true)
    assert.equal(await exists(path), true)
    assert.equal(await exists(join(root, 'absent-parent', 'x.md')), false, 'a missing parent is still just "absent"')
  })

  it('listDir names a directory, and a missing one answers `missing`', async () => {
    const dir = join(root, 'listing')
    assert.equal((await mkdirp(dir)).ok, true)
    const empty = await listDir(dir)
    assert.equal(empty.ok, true)
    if (empty.ok) assert.deepEqual(empty.value, [])

    assert.equal((await writeTextAtomic(join(dir, 'a.md'), 'a\n')).ok, true)
    assert.equal((await writeTextAtomic(join(dir, 'b.md'), 'b\n')).ok, true)
    const names = await listDir(dir)
    assert.equal(names.ok, true)
    if (names.ok) assert.deepEqual([...names.value].sort(), ['a.md', 'b.md'])

    const missing = await listDir(join(root, 'no-such-dir'))
    assert.equal(missing.ok, false)
    if (!missing.ok) assert.equal(missing.error.kind, 'missing', 'the caller decides missing means empty')

    const notADir = await listDir(join(root, 'exists.md'))
    assert.equal(notADir.ok, false)
    if (!notADir.ok) assert.equal(notADir.error.kind, 'unreadable', 'a file is not a directory')
  })

  it('listDirEntries carries the kind flags as frozen data, not Dirents', async () => {
    const dir = join(root, 'entries')
    assert.equal((await mkdirp(join(dir, 'sub'))).ok, true)
    assert.equal((await writeTextAtomic(join(dir, 'file.md'), 'x\n')).ok, true)
    const listed = await listDirEntries(dir)
    assert.equal(listed.ok, true)
    if (!listed.ok) return
    const byName = new Map(listed.value.map(entry => [entry.name, entry]))
    const sub = byName.get('sub')
    const file = byName.get('file.md')
    assert.ok(sub !== undefined && file !== undefined)
    assert.deepEqual({ ...sub }, { name: 'sub', isFile: false, isDirectory: true })
    assert.deepEqual({ ...file }, { name: 'file.md', isFile: true, isDirectory: false })
    assert.ok(Object.isFrozen(sub), 'a frozen data point, not a Dirent')
  })

  it('mkdirp is recursive and idempotent, and reports a path blocked by a file', async () => {
    const nested = join(root, 'mkdirp', 'a', 'b', 'c')
    assert.equal((await mkdirp(nested)).ok, true)
    assert.equal((await mkdirp(nested)).ok, true, 'mkdir -p again is success')
    assert.equal(await exists(nested), true)

    const blocked = join(root, 'exists.md', 'child')
    const refused = await mkdirp(blocked)
    assert.equal(refused.ok, false)
    if (!refused.ok) assert.equal(refused.error.code, 'WRITE_FAILED')
  })
})
