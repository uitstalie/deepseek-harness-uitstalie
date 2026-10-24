/**
 * Tests for core/workspace — §4.10's resolution, run against real repositories.
 *
 * The design made the decision this module implements: identity is the **normalized remote**, and a
 * hit wins even when the path is somewhere else entirely (the machine-moved case). The path is only
 * a cache that helps when there is no remote, and the derived key is what a *first write* would
 * register — resolving must never write (decision 38).
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { runGit } from './git.ts'
import { bindProject } from './project.ts'
import { scaffoldStore } from './scaffold.ts'
import { createStore } from './store.ts'
import { deriveKey, describeBinding, resolveWorkspace, workspaceRemotes } from './workspace.ts'

let root = ''
let store: ReturnType<typeof createStore>
const workdirs: string[] = []

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  assert.equal(result.ok, true, `expected success, got ${JSON.stringify(result)}`)
  if (!result.ok) throw new Error('unreachable')
  return result.value
}

const ACTOR = Object.freeze({ by: 'human:tester' as never, at: '2026-10-15T12:00:00Z' as never })

/** A real git repository, so `git remote -v` is real and not a mock. */
const checkout = async (name: string, remote?: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), `dsh-jira-ws-${name}-`))
  workdirs.push(directory)
  await runGit(directory, ['init', '--initial-branch=main'])
  if (remote !== undefined) await runGit(directory, ['remote', 'add', 'origin', remote])
  return directory
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-jira-workspace-'))
  workdirs.push(root)
  unwrap(await scaffoldStore(root))
  await runGit(root, ['config', '--local', 'user.name', 'tester'])
  await runGit(root, ['config', '--local', 'user.email', 'tester@example.invalid'])
  store = createStore({ root, machineId: 'm-test' })
})

after(async () => {
  for (const directory of workdirs) await rm(directory, { recursive: true, force: true })
})

describe('workspace: the derived key (§4.10 step 4)', () => {
  it('takes the initials of the words', () => {
    assert.equal(deriveKey('/home/me/deepseek-harness'), 'DH')
    assert.equal(deriveKey('D:/work/dsh-jira'), 'DJ')
    assert.equal(deriveKey('/x/dsh-plugin-multidevice-jira'), 'DPMJ')
    assert.equal(deriveKey('/x/oneword'), 'ON', 'one word gives one initial, so take two letters')
  })

  it('always produces something usable as a key', () => {
    for (const name of ['/x/9lives', '/x/---', '/x/日本語', '/x/a', '/x/github.com/someone/other-project']) {
      const key = deriveKey(name)
      assert.match(key, /^[A-Z][A-Z0-9]{0,5}$/u, `${name} → ${key}`)
    }
  })
})

describe('workspace: reading the checkout remotes', () => {
  it('reads real remotes, preferring upstream over origin', async () => {
    const directory = await checkout('remotes', 'git@github.com:o/r.git')
    await runGit(directory, ['remote', 'add', 'upstream', 'git@github.com:them/r.git'])
    const remotes = await workspaceRemotes(directory)
    assert.deepEqual(remotes, ['git@github.com:them/r.git', 'git@github.com:o/r.git'])
  })

  it('says nothing for a checkout with no remote, or no repository at all', async () => {
    assert.deepEqual(await workspaceRemotes(await checkout('noremote')), [])
    const notARepo = await mkdtemp(join(tmpdir(), 'dsh-jira-ws-plain-'))
    workdirs.push(notARepo)
    assert.deepEqual(await workspaceRemotes(notARepo), [])
  })
})

describe('workspace: resolving against the store', () => {
  it('matches by remote, even from a completely different path', async () => {
    unwrap(await bindProject(store, ACTOR, { key: 'DH', path: 'D:/somewhere/else', remotes: ['git@github.com:uitstalie/dsh-jira.git'] }))
    // The checkout lives elsewhere and spells the URL differently: same project (§4.10 step 3).
    const moved = await checkout('moved', 'ssh://git@GitHub.com:22/uitstalie/dsh-jira.git')
    const binding = unwrap(await resolveWorkspace(store, moved))
    assert.equal(binding.project, 'DH')
    assert.equal(binding.by, 'remote')
    assert.equal(binding.remote, 'github.com/uitstalie/dsh-jira')
    assert.equal(binding.agentReadOnly, false)
    assert.match(describeBinding(binding), /workspace → DH \(by remote\)/)
  })

  it('falls back to the recorded path when the checkout has no remote', async () => {
    const local = await checkout('local')
    unwrap(await bindProject(store, ACTOR, { key: 'DH', path: local }))
    const binding = unwrap(await resolveWorkspace(store, local))
    assert.equal(binding.project, 'DH')
    assert.equal(binding.by, 'path')
    assert.match(describeBinding(binding), /by path/)
  })

  it('derives a key for an unknown remote instead of registering anything', async () => {
    const stranger = await checkout('stranger', 'git@github.com:someone/other-project.git')
    const before = unwrap(await resolveWorkspace(store, await checkout('before', 'git@github.com:someone/other-project.git')))
    const binding = unwrap(await resolveWorkspace(store, stranger))
    assert.equal(binding.by, 'derived')
    assert.equal(binding.derivedKey, 'OP')
    assert.equal(binding.project, undefined, 'resolving is read-only: nothing is created here')
    assert.match(describeBinding(binding), /workspace → new project OP on first write/)
    assert.equal(before.by, 'derived', 'and it stays that way: no project appeared')
  })

  it('marks a checkout with no remote as owner-machine, so other agents are read-only', async () => {
    const plain = await checkout('plain-no-remote')
    const binding = unwrap(await resolveWorkspace(store, plain))
    assert.equal(binding.by, 'none')
    assert.equal(binding.agentReadOnly, true)
    assert.match(describeBinding(binding), /owner-machine/)
  })

  it('describes nothing when it was given nothing', () => {
    assert.equal(describeBinding(undefined), '')
  })
})
