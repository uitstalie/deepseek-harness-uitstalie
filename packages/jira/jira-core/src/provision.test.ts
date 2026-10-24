/**
 * Tests for core/provision — how a machine joins the shared store (decision 119).
 *
 * The "remote" in these tests is a local repository, so nothing touches the network while
 * the real clone/fast-forward semantics are still exercised.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { runGit, stageAndCommit } from './git.ts'
import { currentRemote, provisionStore } from './provision.ts'

let root = ''
let origin = ''

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  assert.equal(result.ok, true, `expected success, got ${JSON.stringify(result)}`)
  if (!result.ok) throw new Error('unreachable')
  return result.value
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-jira-provision-'))
  // A stand-in for the shared data repository: a normal local repository with one commit.
  origin = join(root, 'shared-origin')
  await mkdir(origin, { recursive: true })
  await runGit(origin, ['init', '--initial-branch=main'])
  await runGit(origin, ['config', '--local', 'user.name', 'tester'])
  await runGit(origin, ['config', '--local', 'user.email', 'tester@example.invalid'])
  // The shared repository carries `.gitattributes` (decision 5), which is exactly why a
  // clone on Windows does not turn its LF files into CRLF.
  await writeFile(join(origin, '.gitattributes'), '* text=auto eol=lf\n', 'utf8')
  await writeFile(join(origin, 'config.md'), '---\ntype: config\n---\n', 'utf8')
  await stageAndCommit(origin, ['.gitattributes', 'config.md'], 'chore: skeleton [no-issue]')
})

after(async () => {
  if (root !== '') await rm(root, { recursive: true, force: true })
})

describe('provision: a new machine', () => {
  it('clones the shared repository when given a remote', async () => {
    const target = join(root, 'cloned-store')
    const result = unwrap(await provisionStore({ root: target, remote: origin }))
    assert.equal(result.action, 'cloned')
    assert.equal(result.remote, origin)
    assert.equal(await readFile(join(target, 'config.md'), 'utf8'), '---\ntype: config\n---\n')
    assert.equal(await currentRemote(target), origin, 'the clone knows where it came from')
  })

  it('scaffolds a local-only store when there is no remote', async () => {
    const target = join(root, 'local-store')
    const result = unwrap(await provisionStore({ root: target }))
    assert.equal(result.action, 'scaffolded')
    assert.equal(result.remote, undefined)
    assert.match(await readFile(join(target, 'config.md'), 'utf8'), /issue_types:/)
  })

  it('joins an existing local store to the shared repository', async () => {
    const target = join(root, 'joining-store')
    unwrap(await provisionStore({ root: target }))
    assert.equal(await currentRemote(target), undefined)

    const joined = unwrap(await provisionStore({ root: target, remote: origin }))
    assert.equal(joined.action, 'joined')
    assert.equal(await currentRemote(target), origin)
  })

  it('is idempotent: running it again changes nothing', async () => {
    const target = join(root, 'idempotent-store')
    unwrap(await provisionStore({ root: target, remote: origin }))
    const again = unwrap(await provisionStore({ root: target, remote: origin }))
    assert.equal(again.action, 'unchanged')
    assert.equal(again.remote, origin)
  })
})

describe('provision: catching up', () => {
  it('fast-forwards a clone that is behind', async () => {
    const target = join(root, 'behind-store')
    unwrap(await provisionStore({ root: target, remote: origin }))

    // Somebody else pushed.
    await writeFile(join(origin, 'config.md'), '---\ntype: config\n# changed upstream\n---\n', 'utf8')
    await stageAndCommit(origin, ['config.md'], 'chore: upstream edit [no-issue]')

    const pulled = unwrap(await provisionStore({ root: target, remote: origin, pull: true }))
    assert.equal(pulled.pulled, 'fast-forwarded')
    assert.match(await readFile(join(target, 'config.md'), 'utf8'), /changed upstream/)

    const again = unwrap(await provisionStore({ root: target, remote: origin, pull: true }))
    assert.equal(again.pulled, 'up-to-date')
  })

  it('refuses rather than forcing when the local clone has diverged', async () => {
    const target = join(root, 'diverged-store')
    unwrap(await provisionStore({ root: target, remote: origin }))
    await runGit(target, ['config', '--local', 'user.name', 'tester'])
    await runGit(target, ['config', '--local', 'user.email', 'tester@example.invalid'])
    await writeFile(join(target, 'local-only.md'), 'mine\n', 'utf8')
    await stageAndCommit(target, ['local-only.md'], 'chore: local work [no-issue]')

    await writeFile(join(origin, 'config.md'), '---\ntype: config\n# upstream again\n---\n', 'utf8')
    await stageAndCommit(origin, ['config.md'], 'chore: upstream again [no-issue]')

    const result = unwrap(await provisionStore({ root: target, remote: origin, pull: true }))
    assert.equal(result.pulled, 'refused', 'a human should look, not the plugin')
    assert.equal(await readFile(join(target, 'local-only.md'), 'utf8'), 'mine\n', 'nothing was discarded')
  })
})
