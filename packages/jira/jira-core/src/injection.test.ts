/**
 * Tests for core/injection — decision 78's line and its five-second cache.
 *
 * Two properties matter beyond the format: an **empty store injects nothing** (so a session with no
 * ledger pays nothing), and the scan is **reused for five seconds** (so the model loop does no IO on
 * every step).
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { removeTree } from './testing/removeTree.ts'
import { runGit } from './git.ts'
import { INJECTION_TTL_MS, STORE_CONTEXT_NAME, countStore, createStoreInjection, injectionLine } from './injection.ts'
import { scaffoldStore } from './scaffold.ts'
import { createStore } from './store.ts'
import { createKnowledge } from './kbstore.ts'
import { applyTransition } from './mutate.ts'
import { createInStore, transact } from './store.ts'
import { bindProject } from './project.ts'

let root = ''
let store: ReturnType<typeof createStore>

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  assert.equal(result.ok, true, `expected success, got ${JSON.stringify(result)}`)
  if (!result.ok) throw new Error('unreachable')
  return result.value
}

const ACTOR = Object.freeze({ by: 'human:tester' as never, at: '2026-10-15T12:00:00Z' as never })

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-jira-injection-'))
  unwrap(await scaffoldStore(root))
  await runGit(root, ['config', '--local', 'user.name', 'tester'])
  await runGit(root, ['config', '--local', 'user.email', 'tester@example.invalid'])
  store = createStore({ root, machineId: 'm-test' })
})

after(async () => {
  if (root !== '') await removeTree(root)
})

describe('injection: the line', () => {
  it('is the fixed English format, with the read-only suffix only when there is one', () => {
    assert.equal(
      injectionLine({ projects: 3, knowledge: 148, openIssues: 12, readOnlyProjects: 0 }),
      '[store] 3 projects · 148 knowledge · 12 open issues',
    )
    assert.equal(
      injectionLine({ projects: 3, knowledge: 148, openIssues: 12, readOnlyProjects: 1 }),
      '[store] 3 projects · 148 knowledge · 12 open issues | read-only: 1',
    )
  })

  it('names the ledger and the workspace when it knows them (decision 131)', () => {
    assert.equal(
      injectionLine(
        { projects: 3, knowledge: 148, openIssues: 12, readOnlyProjects: 1 },
        { storeLabel: 'jira', binding: 'workspace → DH (by remote)' },
      ),
      '[store] jira · workspace → DH (by remote) · 3 projects · 148 knowledge · 12 open issues | read-only: 1',
    )
    // A session with no checkout still gets the ledger and the counts, just no binding.
    assert.equal(
      injectionLine({ projects: 1, knowledge: 0, openIssues: 0, readOnlyProjects: 0 }, { storeLabel: 'jira' }),
      '[store] jira · 1 projects · 0 knowledge · 0 open issues',
    )
  })

  it('keeps two checkouts apart, because they must be told different things', async () => {
    const read = async (cwd: string | undefined) => ({
      counts: { projects: 1, knowledge: 0, openIssues: 0, readOnlyProjects: 0 },
      ...(cwd === undefined ? {} : { binding: `workspace → ${cwd}` }),
    })
    const injection = createStoreInjection({ read, cwdOf: scope => (scope as { cwd?: string } | undefined)?.cwd, now: () => 0 })
    await injection.refresh('/a')
    await injection.refresh('/b')
    assert.equal(injection.text({ scope: { cwd: '/a' } }), '[store] workspace → /a · 1 projects · 0 knowledge · 0 open issues')
    assert.equal(injection.text({ scope: { cwd: '/b' } }), '[store] workspace → /b · 1 projects · 0 knowledge · 0 open issues')
  })

  it('says nothing at all for an empty store (decision 78)', () => {
    assert.equal(injectionLine({ projects: 0, knowledge: 0, openIssues: 0, readOnlyProjects: 0 }), '')
    assert.equal(injectionLine({ projects: 0, knowledge: 0, openIssues: 0, readOnlyProjects: 1 }), '', 'a read-only count alone is not a store')
  })
})

describe('injection: counting a real store (§6.4 rules)', () => {
  it('counts project.md files, KB files and non-closed issues', async () => {
    const empty = unwrap(await countStore(store))
    assert.deepEqual(empty, { projects: 0, knowledge: 0, openIssues: 0, readOnlyProjects: 0 })
    assert.equal(injectionLine(empty), '', 'a scaffolded store has nothing to say yet')

    // A project with a remote is writable; one without is read-only (§4.11).
    unwrap(await bindProject(store, ACTOR, { key: 'DH', path: 'D:/a', remotes: ['git@github.com:o/r.git'] }))
    unwrap(await bindProject(store, ACTOR, { key: 'LOCAL', path: 'D:/b' }))
    unwrap(await createInStore(store, 'DH', ACTOR, { issueType: 'task', summary: 'open one', status: 'todo' }))
    // Closing needs a resolution, which is a transition's business — so the test walks the real path.
    const closed = unwrap(await createInStore(store, 'DH', ACTOR, { issueType: 'task', summary: 'closed one' }))
    unwrap(await transact(store, closed.key, ACTOR, (issue, ctx) => applyTransition(issue, 'closed', { resolution: 'fixed' }, ctx), 'close'))
    unwrap(await createKnowledge(store, ACTOR, { machineId: 'm-test', os: 'win32', tool: 'dsh' }, {
      domain: 'locking',
      kbType: 'pitfall',
      title: 'a note',
    }))
    // A generated index inside a domain is not an entry.
    await writeFile(join(root, 'knowledge', 'locking', 'index.md'), '# index\n', 'utf8')

    const counts = unwrap(await countStore(store))
    assert.deepEqual(counts, { projects: 2, knowledge: 1, openIssues: 1, readOnlyProjects: 1 })
    assert.equal(injectionLine(counts), '[store] 2 projects · 1 knowledge · 1 open issues | read-only: 1')
  })

  it('counts a project that has issues but no identity file, and not a bare directory', async () => {
    // `jira new` creates issues without ever binding a checkout, so a store can have projects with
    // no `project.md` at all. Reporting "0 projects" there would contradict what the reader sees.
    const created = unwrap(await createInStore(store, 'UNBND', ACTOR, { issueType: 'task', summary: 'no project.md' }))
    assert.equal(created.change.issue.project, 'UNBND')

    await mkdir(join(root, 'projects', 'NOFILE'), { recursive: true })
    const counts = unwrap(await countStore(store))
    assert.equal(counts.projects, 3, 'DH, LOCAL and UNBND count; an empty directory does not')
    assert.equal(counts.readOnlyProjects, 2, 'LOCAL and UNBND have no remote')
    assert.match(injectionLine(counts), /3 projects · 1 knowledge · 2 open issues \| read-only: 2/)
  })
})

describe('injection: the five-second cache (decision 78)', () => {
  it('reuses the scan inside the TTL and scans again after it', async () => {
    let clock = 1_000
    let reads = 0
    const injection = createStoreInjection({
      read: async () => {
        reads += 1
        return { counts: { projects: reads, knowledge: 0, openIssues: 0, readOnlyProjects: 0 } }
      },
      now: () => clock,
    })

    await injection.refresh()
    assert.equal(injection.text(), '[store] 1 projects · 0 knowledge · 0 open issues')

    clock += INJECTION_TTL_MS - 1
    await injection.refresh()
    assert.equal(reads, 1, 'inside the TTL the last scan is reused')
    assert.equal(injection.text(), '[store] 1 projects · 0 knowledge · 0 open issues')

    clock += 2
    await injection.refresh()
    assert.equal(reads, 2, 'after the TTL it scans again')
    assert.equal(injection.text(), '[store] 2 projects · 0 knowledge · 0 open issues')
    assert.equal(injection.scans(), 2)
  })

  it('starts empty, so the very first assembly injects nothing rather than a guess', () => {
    const counts = { projects: 9, knowledge: 9, openIssues: 9, readOnlyProjects: 0 }
    const injection = createStoreInjection({ read: async () => ({ counts }), now: () => 0 })
    assert.equal(injection.text(), '', 'not measured yet, so nothing is claimed')
  })

  it('injects nothing when the store cannot be read', async () => {
    const injection = createStoreInjection({
      read: async () => { throw new Error('no store') },
      now: () => 0,
    })
    await injection.refresh()
    assert.equal(injection.text(), '')
  })

  it('has the registration name the design fixes', () => {
    const counts = { projects: 1, knowledge: 0, openIssues: 0, readOnlyProjects: 0 }
    const injection = createStoreInjection({ read: async () => ({ counts }), now: () => 0 })
    assert.equal(injection.name, STORE_CONTEXT_NAME)
    assert.equal(injection.name, 'jira:store')
  })
})
