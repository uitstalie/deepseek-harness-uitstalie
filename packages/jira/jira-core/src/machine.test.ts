/**
 * Tests for core/machine — the identity that must be stable and unique (decision 73).
 *
 * Now that a store is a clone of a shared repository, an id kept inside the store would
 * travel to the other machine; and two machines sharing an id would claim the same number
 * block. Both are tested here: the id lives outside, is created once, and is reused.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { generateMachineId, isMachineId, machineIdFile, resolveMachineId } from './machine.ts'

let root = ''

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-jira-machine-'))
})

after(async () => {
  if (root !== '') await rm(root, { recursive: true, force: true })
})

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  assert.equal(result.ok, true, `expected success, got ${JSON.stringify(result)}`)
  if (!result.ok) throw new Error('unreachable')
  return result.value
}

describe('machine: the id shape', () => {
  it('accepts lowercase short ids and refuses the rest', () => {
    for (const good of ['m-1a2b3c4d', 'workstation', 'a1b']) assert.equal(isMachineId(good), true, good)
    for (const bad of ['M-1', 'ab', 'with space', 'with:colon', 'agent|tool', 'a'.repeat(33)]) {
      assert.equal(isMachineId(bad), false, bad)
    }
  })

  it('generates ids that look like ids, and does not repeat itself', () => {
    const first = generateMachineId()
    const second = generateMachineId()
    assert.equal(isMachineId(first), true)
    assert.notEqual(first, second)
  })

  it('lives outside the store, under DSH_HOME (or the user profile)', () => {
    assert.equal(machineIdFile({ DSH_HOME: '/home/x/.dsh' })?.replaceAll('\\', '/'), '/home/x/.dsh/dsh-jira/machine-id')
    assert.match(String(machineIdFile({ HOME: '/home/x' })).replaceAll('\\', '/'), /\/home\/x\/\.dsh\/dsh-jira\/machine-id$/)
  })

  it('falls back inside the store only when told where the store is, and never guesses', () => {
    // `.jira/machine-id` is ignored by the store's own .gitignore, so this fallback cannot
    // travel with a clone; a path relative to the working directory could — which is how a
    // stray `.dsh/` once appeared inside the plugin repository.
    assert.equal(machineIdFile({}), undefined, 'nowhere known means no file, not ./')
    assert.equal(machineIdFile({}, '/store')?.replaceAll('\\', '/'), '/store/.jira/machine-id')
  })

  it('refuses to invent an identity when it cannot locate a home', async () => {
    const value = await resolveMachineId({ env: {} })
    assert.equal(value.ok, false)
    if (!value.ok) assert.match(value.error.message, /cannot locate the machine id/)
  })
})

describe('machine: resolution order', () => {
  it('prefers configuration, and refuses a malformed one loudly', async () => {
    const value = unwrap(await resolveMachineId({ configured: 'pinned-machine', env: {}, file: join(root, 'a') }))
    assert.equal(value.id, 'pinned-machine')
    assert.equal(value.source, 'configured')
    assert.equal(await readFile(join(root, 'a'), 'utf8').catch(() => undefined), undefined, 'nothing written')

    const bad = await resolveMachineId({ configured: 'Bad Id', env: {}, file: join(root, 'a') })
    assert.equal(bad.ok, false)
    if (!bad.ok) assert.match(bad.error.message, /must be lowercase letters/)
  })

  it('accepts the environment next', async () => {
    const value = unwrap(await resolveMachineId({ env: { DSH_MACHINE_ID: 'from-env' }, file: join(root, 'b') }))
    assert.equal(value.id, 'from-env')
    assert.equal(value.source, 'environment')
  })

  it('creates the file on first use and reuses it forever after', async () => {
    const file = join(root, 'nested', 'machine-id')
    const first = unwrap(await resolveMachineId({ env: {}, file }))
    assert.equal(first.source, 'generated')
    assert.equal(isMachineId(first.id), true)
    assert.equal((await readFile(file, 'utf8')).trim(), first.id, 'the id is written down')

    const second = unwrap(await resolveMachineId({ env: {}, file }))
    assert.equal(second.id, first.id, 'the same machine must keep its id')
    assert.equal(second.source, 'file')
  })

  it('replaces a malformed file rather than trusting it', async () => {
    const file = join(root, 'bad-machine-id')
    await writeFile(file, 'Not An Id\n', 'utf8')
    const value = unwrap(await resolveMachineId({ env: {}, file }))
    assert.equal(isMachineId(value.id), true)
    assert.equal(value.source, 'generated')
    assert.equal((await readFile(file, 'utf8')).trim(), value.id)
  })

  it('reports a file it cannot write instead of inventing an id', async () => {
    const value = await resolveMachineId({
      env: {},
      file: join(root, 'whatever'),
      create: async () => ({ ok: false, error: { code: 'WRITE_FAILED' as const, message: 'disk full' } }),
    })
    assert.equal(value.ok, false)
    if (!value.ok) assert.equal(value.error.code, 'WRITE_FAILED')
  })
})
