/**
 * Tests for core/machines and core/perf (decisions 73/85/91).
 *
 * The machine registry is the place a bare `m-357504ff` becomes "workstation", and the display rule
 * (label, else the first six characters of the id) lives here so the board, the KB view and the CLI
 * cannot disagree about what to call a machine. The perf numbers are decision 85's only trigger for
 * ever building an index, so they are checked for shape and for the boundary behaviour.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { removeTree } from './testing/removeTree.ts'
import { runGit } from './git.ts'
import { type LockOwner, issueLockPath, readOwner } from './lock.ts'
import { labelMachine, listMachines, machineDisplayName, machinePath, machinesHint, renderMachines } from './machines.ts'
import { PERF_SAMPLES, SEARCH_P95_BUDGET_MS, STORE_FILE_BUDGET, countPerfFiles, measureKbSearch, perfQuery, perfReport, renderPerf } from './perf.ts'
import { scaffoldStore } from './scaffold.ts'
import { createStore } from './store.ts'
import { createKnowledge } from './kbstore.ts'

let root = ''
let store: ReturnType<typeof createStore>

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  assert.equal(result.ok, true, `expected success, got ${JSON.stringify(result)}`)
  if (!result.ok) throw new Error('unreachable')
  return result.value
}

const ACTOR = Object.freeze({ by: 'human:tester' as never, at: '2026-10-15T12:00:00Z' as never })
const ORIGIN = Object.freeze({ machineId: 'm-test', os: 'win32', tool: 'dsh' })

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-jira-machines-'))
  unwrap(await scaffoldStore(root))
  await runGit(root, ['config', '--local', 'user.name', 'tester'])
  await runGit(root, ['config', '--local', 'user.email', 'tester@example.invalid'])
  store = createStore({ root, machineId: 'm-test' })
})

after(async () => {
  if (root !== '') await removeTree(root)
})

describe('machines: the registry', () => {
  it('starts empty, says what this machine is, and points at the label (decisions 91/150)', async () => {
    const records = unwrap(await listMachines(store))
    assert.deepEqual(records, [])
    assert.match(renderMachines(records, 'm-test'), /本机：m-test/)
    // The sentence is a **value**: "only once" is machine-local state, which `core` does not keep
    // (§3.1) — the CLI owns the marker, so a pure function can be tested for both cases.
    assert.match(String(machinesHint(records, 'm-test')), /jira machines label --name/u)
  })

  it('labels this machine, and the file records the lineage fields', async () => {
    const labelled = unwrap(await labelMachine(store, ACTOR, 'm-test', { label: 'workstation', os: 'win32' }))
    assert.equal(labelled.label, 'workstation')
    assert.equal(labelled.firstSeen, '2026-10-15T12:00:00Z')

    const text = await readFile(join(root, ...machinePath('m-test').split('/')), 'utf8')
    assert.match(text, /^schema: machine\/v1$/m)
    assert.match(text, /^machine_id: m-test$/m)
    assert.match(text, /^label: workstation$/m)
    assert.match(text, /^first_seen: 2026-10-15T12:00:00Z$/m)
    assert.equal(text.includes('\r'), false)

    const listed = unwrap(await listMachines(store))
    assert.deepEqual(listed.map(record => record.label), ['workstation'])
    assert.match(renderMachines(listed, 'm-test'), /^\* m-test  workstation/m)
  })

  it('keeps first_seen across relabelling, because it is history', async () => {
    const again = unwrap(await labelMachine(store, { by: 'human:tester' as never, at: '2026-10-30T09:00:00Z' as never }, 'm-test', { label: 'desk-pc' }))
    assert.equal(again.label, 'desk-pc')
    assert.equal(again.firstSeen, '2026-10-15T12:00:00Z', 'the first sighting does not move')
    assert.equal(unwrap(await listMachines(store))[0]?.label, 'desk-pc')
  })

  it('refuses an empty label and a bad machine id', async () => {
    assert.equal((await labelMachine(store, ACTOR, 'm-test', { label: '  ' })).ok, false)
    const bad = await labelMachine(store, ACTOR, 'NOT AN ID', { label: 'x' })
    assert.equal(bad.ok, false)
    if (!bad.ok) assert.match(bad.error.message, /is not a machine id/)
  })

  it('the lock owner names the store host, never a hardcoded surface (decision 181)', async () => {
    // The owner record exists only while the lock is held, so watch for it while the label write
    // runs its commit — the same polling-with-a-deadline pattern the push tests use.
    const hosted = createStore({ root, machineId: 'm-test', host: 'box-under-test' })
    const path = issueLockPath(root, 'm-host-probe')
    let seen: LockOwner | undefined
    const deadline = Date.now() + 10_000
    const pending = labelMachine(hosted, ACTOR, 'm-host-probe', { label: 'probe' })
    while (seen === undefined && Date.now() < deadline) {
      seen = await readOwner(path)
      if (seen === undefined) await new Promise(resolve => setTimeout(resolve, 5))
    }
    unwrap(await pending)
    assert.equal(seen?.host, 'box-under-test', 'the owner must come from the store, not from a literal')
    assert.equal(seen?.machine_id, 'm-test')
  })

  it('reports a malformed entry instead of dropping it', async () => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(root, 'machines', 'm-broken.md'), '---\nlabel:\n  - [a]\n---\n', 'utf8')
    const records = unwrap(await listMachines(store))
    const broken = records.find(record => record.machineId === 'm-broken')
    assert.ok(broken !== undefined)
    assert.equal(broken.warnings.length >= 1, true, JSON.stringify(broken))
    await rm(join(root, 'machines', 'm-broken.md'))
  })
})

describe('machines: the display rule (decision 91)', () => {
  it('prefers a label, and falls back to the first six characters of the id', () => {
    const records = [{ machineId: 'm-357504ff', label: 'workstation', warnings: [] }]
    assert.equal(machineDisplayName('m-357504ff', records), 'workstation')
    assert.equal(machineDisplayName('m-abcdef12', records), 'm-abcd')
    assert.equal(machineDisplayName('m-abcdef12'), 'm-abcd')
  })

  it('uses that rule when listing, and stops hinting once the machine has a label', () => {
    const unlabelled = [{ machineId: 'm-abcdef12', warnings: [] }]
    const listing = renderMachines(unlabelled, 'm-abcdef12')
    assert.match(listing, /m-abcdef12 {2}m-abcd/u, 'the short id, not a placeholder')
    assert.equal(listing.includes('无 label'), false)
    assert.notEqual(machinesHint(unlabelled, 'm-abcdef12'), undefined, 'an unnamed machine gets the hint')

    const labelled = [{ machineId: 'm-abcdef12', label: 'workstation', warnings: [] }]
    assert.match(renderMachines(labelled, 'm-abcdef12'), /m-abcdef12 {2}workstation/u)
    assert.equal(machinesHint(labelled, 'm-abcdef12'), undefined, 'a named machine does not')
  })
})

describe('perf: decision 85s two numbers', () => {
  it('counts the library and the store, ignoring derived directories', async () => {
    const files = await countPerfFiles(store)
    assert.equal(files.knowledge, 0, 'nothing written yet')
    assert.ok(files.store >= 4, `a scaffolded store has files: ${String(files.store)}`)
  })

  it('measures a real search, and reports 0 for an empty library rather than noise', async () => {
    assert.equal(unwrap(await measureKbSearch(store, 'anything')), 0)

    unwrap(await createKnowledge(store, ACTOR, ORIGIN, {
      domain: 'locking',
      kbType: 'pitfall',
      title: 'Windows 上的锁必须用 mkdir',
      body: 'flock 在这里不是原子的。\n',
    }))
    const measured = unwrap(await measureKbSearch(store, 'mkdir', 3))
    // `assert.ok(measured >= 0)` was always true; this one can fail: the report is whole milliseconds
    // (decision 170), and a float would mean the rounding was dropped.
    assert.equal(Number.isInteger(measured), true, 'whole milliseconds')
    assert.equal((await countPerfFiles(store)).knowledge, 1)
  })

  it('picks the busiest title as the probe query, falling back to a harmless word', () => {
    assert.equal(perfQuery(['  ', 'mkdir']), 'mkdir')
    assert.equal(perfQuery([]), 'the')
  })

  it('decides with the thresholds the design fixed, not with taste', () => {
    const under = perfReport({ knowledge: 1, store: 10 }, 5, 'mkdir', PERF_SAMPLES)
    assert.equal(under.verdict, 'scan is fine')
    assert.deepEqual(under.overBudget, { search: false, files: false })

    const slow = perfReport({ knowledge: 1, store: 10 }, SEARCH_P95_BUDGET_MS + 1, 'mkdir', PERF_SAMPLES)
    assert.equal(slow.verdict, 'evaluate an index')
    assert.equal(slow.overBudget.search, true)

    const many = perfReport({ knowledge: 1, store: STORE_FILE_BUDGET + 1 }, 1, 'mkdir', PERF_SAMPLES)
    assert.equal(many.overBudget.files, true)
    assert.equal(many.verdict, 'evaluate an index')
    assert.match(renderPerf(many), /evaluate an index/)
  })
})
