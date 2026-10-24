/**
 * Tests for the path-record rules across **both** platforms (decisions 151/152).
 *
 * The point is not that "Windows dedupes and POSIX does not" is interesting on its own — it is that
 * `paths[]` is a **cache written on one machine and compared on another**, and plain string equality
 * got that wrong in both directions: a Windows checkout recorded as `d:\work\repo` did not match the
 * same checkout spelled `D:/Work/Repo`, and two distinct POSIX directories did match if they differed
 * only in case.
 *
 * `bothPlatforms` runs one body per platform, on whichever machine is already open — which is what
 * stops the "fix one OS, break the other" round trip.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'

import { type Identity, type Timestamp } from './entity.ts'
import { bindProject, normalizePath } from './project.ts'
import { createStore } from './store.ts'
import { bothPlatforms } from './testing/bothPlatforms.ts'

const AT = '2026-10-15T12:00:00Z' as Timestamp
const ACTOR = Object.freeze({ by: 'human:daiqc' as Identity, at: AT })

const created: string[] = []

/** A fresh store per run: the two platforms must not see each other's `paths[]`. */
const freshStore = async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jira-paths-'))
  created.push(root)
  return createStore({ root, machineId: 'ffffffff' })
}

after(async () => {
  for (const root of created) await rm(root, { recursive: true, force: true })
})

/** Per platform: one working copy, written the way each machine writes it. */
const SPELLINGS = Object.freeze({
  win32: Object.freeze({ first: 'D:/Work/Repo', again: 'd:\\work\\repo', other: 'D:\\Work\\Other' }),
  linux: Object.freeze({ first: '/work/Repo', again: '/work/repo', other: '/work/other' }),
})

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
  assert.equal(result.ok, true, `expected success, got ${JSON.stringify(result)}`)
  if (!result.ok) throw new Error('unreachable')
  return result.value
}

bothPlatforms('project: paths[] is compared with the platform the path was recorded on', async (system, platform) => {
  const store = await freshStore()
  const spellings = SPELLINGS[platform]

  const first = unwrap(await bindProject(store, ACTOR, { key: 'DH', path: spellings.first, platform }))
  assert.equal(first.addedPath, true, 'the first binding records the checkout')

  // The same working copy, spelled the way the other machine spells it.
  const again = unwrap(await bindProject(store, ACTOR, { key: 'DH', path: spellings.again, platform }))
  assert.equal(
    again.addedPath,
    !system.facts.isWindows,
    system.facts.isWindows
      ? 'Windows has one working copy however it is spelled (case-insensitive)'
      : 'POSIX keeps /work/Repo and /work/repo apart',
  )
  assert.equal(again.project.paths.length, system.facts.isWindows ? 1 : 2)

  // A genuinely different directory is always a new entry, on both platforms.
  const other = unwrap(await bindProject(store, ACTOR, { key: 'DH', path: spellings.other, platform }))
  assert.equal(other.addedPath, true)
  assert.equal(other.project.paths.includes(normalizePath(spellings.other, platform)), true)
})

bothPlatforms('project: normalizePath and samePath agree with each other', (system, platform) => {
  const spellings = SPELLINGS[platform]
  assert.equal(system.samePath(spellings.first, spellings.again), system.facts.isWindows)
  if (system.facts.isWindows) {
    assert.equal(normalizePath(spellings.first, platform), normalizePath(spellings.again, platform), 'both spellings collapse to one recorded path')
  } else {
    assert.notEqual(normalizePath(spellings.first, platform), normalizePath(spellings.again, platform), 'POSIX keeps case, so the spellings stay distinct')
  }
})
