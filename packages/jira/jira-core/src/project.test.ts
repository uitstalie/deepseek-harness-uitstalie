/**
 * Tests for core/project — remote identity (decision 77) and checkout paths (decision 92).
 *
 * The point of the normalization is that **one repository has one identity** even though a clone URL
 * has five spellings, and that a path is only ever a cache. Both are pure enough to test exactly.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { removeTree } from './testing/removeTree.ts'
import { writeTextAtomic } from './io.ts'
import { storePaths } from './store.ts'
import { runGit } from './git.ts'
import { resolveWorkspace } from './workspace.ts'
import { assertProjectWritable, bindProject, encodeProjectFile, ensureWorkspaceProject, listProjects, normalizePath, normalizeRemote, projectRelPath, readProjectFile, rebindProject, remoteIdentity, renderProjects } from './project.ts'
import { scaffoldStore } from './scaffold.ts'
import { createStore } from './store.ts'

let root = ''
let store: ReturnType<typeof createStore>
/** Checkouts these tests create; removed in the second fter hook below. */
const tempdirs: string[] = []

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  assert.equal(result.ok, true, `expected success, got ${JSON.stringify(result)}`)
  if (!result.ok) throw new Error('unreachable')
  return result.value
}

const ACTOR = Object.freeze({ by: 'human:tester' as never, at: '2026-10-15T12:00:00Z' as never })

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-jira-project-'))
  unwrap(await scaffoldStore(root))
  await runGit(root, ['config', '--local', 'user.name', 'tester'])
  await runGit(root, ['config', '--local', 'user.email', 'tester@example.invalid'])
  store = createStore({ root, machineId: 'm-test' })
})

/**
 * Temp cleanup goes through the shared `removeTree` (src/testing): it retries the ENOTEMPTY that a
 * still-finishing git helper can cause under `.git/objects/pack` (2026-10-17, one CI job).
 */

after(async () => {
  if (root !== '') await removeTree(root)
  for (const directory of tempdirs) await removeTree(directory)
})

describe('project: one repository, one identity', () => {
  it('reduces every spelling of the same remote to the same string', () => {
    const expected = 'github.com/uitstalie/dsh-jira'
    for (const spelling of [
      'git@github.com:uitstalie/dsh-jira.git',
      'git@GitHub.com:uitstalie/dsh-jira',
      'ssh://git@github.com:22/uitstalie/dsh-jira.git',
      'https://github.com/uitstalie/dsh-jira',
      'https://user:token@github.com/uitstalie/dsh-jira/',
      '  git@github.com:uitstalie/dsh-jira.git  ',
    ]) {
      assert.equal(normalizeRemote(spelling), expected, spelling)
    }
  })

  it('keeps the host and the whole path, and only those', () => {
    assert.equal(normalizeRemote('https://example.invalid:8443/a/b/c.git'), 'example.invalid/a/b/c')
    assert.equal(normalizeRemote('git@example.invalid:a/b.git'), 'example.invalid/a/b')
    assert.equal(normalizeRemote(''), '')
  })

  it('prefers upstream, then origin, then whatever is left (decision 77)', () => {
    assert.equal(remoteIdentity(['git@github.com:them/upstream.git', 'git@github.com:them/origin.git']), 'github.com/them/upstream')
    assert.equal(remoteIdentity(['git@github.com:them/origin.git', 'git@github.com:me/fork.git']), 'github.com/them/origin')
    // No upstream, no origin: the choice is arbitrary but must be deterministic, so it is sorted.
    assert.equal(remoteIdentity(['git@github.com:me/fork.git', 'git@github.com:them/real.git']), 'github.com/me/fork')
    assert.equal(remoteIdentity([]), undefined)
  })

  it('normalizes a path for comparison, lowercased on Windows (decision 92)', () => {
    assert.equal(normalizePath('D:/Work/Repo', 'win32'), 'd:\\work\\repo')
    assert.equal(normalizePath('D:\\Work\\Repo', 'win32'), 'd:\\work\\repo', 'the same directory, however it is spelled')
    // The host's own rule, checked as a property so the suite is honest on Linux and Windows alike.
    const here = normalizePath('Work/Repo')
    assert.equal(isAbsolute(here), true, 'always absolute')
    assert.equal(normalizePath(here), here, 'idempotent')
  })
})

describe('project: the file', () => {
  it('never stores the key, because the directory is the key (decisions 77/107)', () => {
    const text = encodeProjectFile({ key: 'DH', name: 'ledger', remotes: ['github.com/o/r'], paths: ['d:\\x'], agentWritePolicy: 'shared' })
    assert.match(text, /^schema: project\/v1$/m)
    assert.equal(/^key:/m.test(text), false)
    assert.match(text, /^remotes: \[github\.com\/o\/r\]$/m)
  })

  it('reads a hand-edited file tolerantly', () => {
    const decoded = unwrap(readProjectFile('---\nschema: project/v1\nfuture: 1\nremotes: [github.com/o/r]\n---\n', 'DH'))
    assert.deepEqual(decoded.remotes, ['github.com/o/r'])
    assert.deepEqual(decoded.paths, [])
  })
})

describe('project: binding a checkout', () => {
  /**
   * Host-absolute, so this suite means the same thing on Linux and on Windows.
   *
   * The Windows spelling rules belong to the `normalizePath` unit test above: a checkout bound at
   * runtime is always a path on the machine doing the binding, never a path another machine wrote
   * down. Feeding Windows literals to `bindProject` made these cases pass only where the host's own
   * path rules happened to agree (found by CI, 2026-10-16).
   */
  const dh = resolve('work', 'dh')
  const dhAgain = resolve('work', '.', 'dh')
  const other = resolve('work', 'other')

  it('binds, is idempotent, and records the normalized remote', async () => {
    const first = unwrap(await bindProject(store, ACTOR, {
      key: 'DH',
      path: dh,
      remotes: ['git@github.com:uitstalie/dsh-jira.git'],
      name: 'the ledger',
    }))
    assert.equal(first.addedPath, true)
    assert.deepEqual(first.project.remotes, ['github.com/uitstalie/dsh-jira'])

    const again = unwrap(await bindProject(store, ACTOR, { key: 'DH', path: dhAgain }))
    assert.equal(again.addedPath, false, 'the same path in another spelling is the same path')
    assert.deepEqual(again.project.paths, [normalizePath(dh)])
    assert.equal(again.project.name, 'the ledger', 'an omitted name keeps the recorded one')

    const text = await readFile(join(root, ...projectRelPath('DH').split('/')), 'utf8')
    assert.match(text, /^name: the ledger$/m)
  })

  it('lists what it has, marking the checkout you are standing in', async () => {
    const projects = unwrap(await listProjects(store))
    assert.deepEqual(projects.map(project => project.key), ['DH'])
    assert.equal(remoteIdentity(projects[0]?.remotes ?? []), 'github.com/uitstalie/dsh-jira')
    assert.match(renderProjects(projects, dh), /^\* DH {2}the ledger$/m)
    assert.match(renderProjects(projects, resolve('work', 'elsewhere')), /^ {2}DH {2}the ledger$/m)
  })

  it('refuses a key that is not a project key', async () => {
    const bad = await bindProject(store, ACTOR, { key: 'nope', path: '.' })
    assert.equal(bad.ok, false)
    if (!bad.ok) assert.match(bad.error.message, /is not a project key/)
  })

  it('moves a checkout between projects without touching issue data (decision 92)', async () => {
    unwrap(await bindProject(store, ACTOR, { key: 'OTHER', path: other }))
    const rebound = unwrap(await rebindProject(store, ACTOR, { from: 'DH', to: 'OTHER', path: dh }))
    assert.equal(rebound.moved, true)
    assert.deepEqual(rebound.from.paths, [])
    assert.deepEqual(rebound.to.paths, [normalizePath(dh), normalizePath(other)].sort())

    const same = await rebindProject(store, ACTOR, { from: 'OTHER', to: 'OTHER', path: '.' })
    assert.equal(same.ok, false)

    const missing = unwrap(await rebindProject(store, ACTOR, { from: 'OTHER', to: 'DH', path: resolve('never', 'bound') }))
    assert.equal(missing.moved, false, 'a path that was not bound is simply added to the target')
    assert.deepEqual(missing.from.paths, [normalizePath(dh), normalizePath(other)].sort())
  })
})

describe('project: the first write registers the workspace (decision 133, §4.10)', () => {
  it('grants a new project from the repository name, with its remote and this path', async () => {
    const checkout = await mkdtemp(join(tmpdir(), 'dsh-jira-ws-reg-'))
    tempdirs.push(checkout)
    await runGit(checkout, ['init', '--initial-branch=main'])
    await runGit(checkout, ['remote', 'add', 'origin', 'git@github.com:uitstalie/brand-new.git'])

    const binding = unwrap(await resolveWorkspace(store, checkout))
    assert.equal(binding.by, 'derived')
    const registered = unwrap(await ensureWorkspaceProject(store, ACTOR, binding, 'm-test'))
    assert.equal(registered.registered, true)
    assert.equal(registered.key, 'BN', 'brand-new → BN')
    assert.equal(registered.project.agentWritePolicy, 'shared', 'a remote makes it writable from anywhere')
    assert.deepEqual(registered.project.remotes, ['github.com/uitstalie/brand-new'])
    assert.deepEqual(registered.project.paths, [normalizePath(checkout)])

    // It is now recognisable, and a second write does not register anything again.
    const again = unwrap(await resolveWorkspace(store, checkout))
    assert.equal(again.project, 'BN')
    assert.equal(again.by, 'remote')
    const second = unwrap(await ensureWorkspaceProject(store, ACTOR, again, 'm-test'))
    assert.equal(second.registered, false)
  })

  it('marks a checkout with no remote as owner-machine, owned by this machine', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'dsh-jira-ws-own-'))
    tempdirs.push(plain)
    await runGit(plain, ['init', '--initial-branch=main'])
    const registered = unwrap(await ensureWorkspaceProject(store, ACTOR, unwrap(await resolveWorkspace(store, plain)), 'm-test'))
    assert.equal(registered.project.agentWritePolicy, 'owner-machine')
    assert.equal(registered.project.ownerMachine, 'm-test')
  })

  it('appends digits when two repositories derive the same key', async () => {
    const first = await mkdtemp(join(tmpdir(), 'dsh-jira-ws-bn2-'))
    tempdirs.push(first)
    await runGit(first, ['init', '--initial-branch=main'])
    await runGit(first, ['remote', 'add', 'origin', 'git@github.com:someone/brand-new.git'])
    const registered = unwrap(await ensureWorkspaceProject(store, ACTOR, unwrap(await resolveWorkspace(store, first)), 'm-test'))
    assert.equal(registered.key, 'BN2', 'BN is taken by another repository')
  })
})

describe('project: who may write it (§4.11, decision 133)', () => {
  it('lets anyone write a shared project, and blocks other machines only for agents', async () => {
    assert.equal((await assertProjectWritable(store, 'DH', 'agent:x|dsh|m-other|s')).ok, true, 'DH has a remote')

    const local = await mkdtemp(join(tmpdir(), 'dsh-jira-ws-policy-'))
    tempdirs.push(local)
    await runGit(local, ['init', '--initial-branch=main'])
    // Registered on **another** machine: that is what makes this store's agents foreign to it.
    const registered = unwrap(await ensureWorkspaceProject(store, ACTOR, unwrap(await resolveWorkspace(store, local)), 'm-other'))
    const key = registered.key
    assert.equal(registered.project.ownerMachine, 'm-other')

    assert.equal((await assertProjectWritable(store, key, 'human:daiqc')).ok, true, 'humans always may')
    const foreign = await assertProjectWritable(store, key, 'agent:x|dsh|m-test|s')
    assert.equal(foreign.ok, false)
    if (!foreign.ok) {
      assert.equal(foreign.error.code, 'FOREIGN_MACHINE_READ_ONLY')
      assert.match(foreign.error.message, /belongs to machine m-other/)
    }
  })
})
describe('project: KB is the knowledge key space, so a new project cannot claim it (decision 194)', () => {
  it('refuses to register a new project named KB, and leaves an existing one alone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-jira-reserved-'))
    try {
      await writeTextAtomic(storePaths.config(dir), readFileSync(new URL('../fixtures/config.md', import.meta.url), 'utf8'))
      const store = createStore({ root: dir, machineId: 'abcd1234' })
      const refused = await bindProject(store, ACTOR, { key: 'KB' })
      assert.equal(refused.ok, false)
      if (!refused.ok) {
        assert.equal(refused.error.code, 'INVALID_INPUT')
        assert.match(refused.error.message, /knowledge key space/u)
      }
      // An existing KB project (this ledger has one) keeps working — the rule is about *creating* it.
      await mkdir(join(dir, 'projects', 'KB'), { recursive: true })
      const existing = await bindProject(store, ACTOR, { key: 'KB' })
      assert.equal(existing.ok, true, JSON.stringify(existing))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
