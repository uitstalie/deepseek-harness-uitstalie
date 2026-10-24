/**
 * Tests for core/config — where the store lives (decisions 57/153) and how long that path may be
 * (decision 60).
 *
 * The file had no tests at all before this one, while being the single place both surfaces resolve a
 * root: the precedence is easy to break and impossible to notice, because every command still works
 * against *some* directory.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { resolveStoreRoot } from './config.ts'
import { PATH_LENGTH_WARN, longPathLimitOf } from './system/paths.ts'

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  assert.equal(result.ok, true, `expected success, got ${JSON.stringify(result)}`)
  if (!result.ok) throw new Error('unreachable')
  return result.value
}

describe('config: a root is trimmed before it becomes a path (decision 169)', () => {
  it('drops the spaces a person leaves around a --root value', () => {
    const clean = resolveStoreRoot({ configured: '  /srv/jira  ', env: {} , platform: 'linux' })
    assert.equal(clean.ok, true)
    if (clean.ok) assert.equal(clean.value, '/srv/jira')
    const fromEnv = resolveStoreRoot({ env: { JIRA_ROOT: '  /srv/env  ' }, platform: 'linux' })
    if (fromEnv.ok) assert.equal(fromEnv.value, '/srv/env')
  })
})

describe('config: the precedence (decisions 57/153)', () => {
  it('takes the configured root first, then JIRA_ROOT, then the home default', () => {
    assert.equal(unwrap(resolveStoreRoot({ configured: '/a/store', env: { JIRA_ROOT: '/b/store' }, platform: 'linux' })), '/a/store')
    assert.equal(unwrap(resolveStoreRoot({ env: { JIRA_ROOT: '/b/store' }, platform: 'linux' })), '/b/store')

    // The host does not export DSH_HOME; `~/.dsh` is what it uses itself (decision 123).
    const home = unwrap(resolveStoreRoot({ env: { HOME: '/home/x' }, platform: 'linux' }))
    assert.match(home.replaceAll('\\', '/'), /\/\.dsh\/jira$/u)
  })

  it('lets DSH_HOME place the default store, and JIRA_ROOT still beats it', () => {
    // DSH_HOME is the host's own home; the store default hangs under it (decisions 57/123/153).
    assert.equal(unwrap(resolveStoreRoot({ env: { DSH_HOME: '/x/dsh', HOME: '/home/y' }, platform: 'linux' })), '/x/dsh/jira')
    assert.equal(
      unwrap(resolveStoreRoot({ env: { DSH_HOME: '/x/dsh', JIRA_ROOT: '/b/store' }, platform: 'linux' })),
      '/b/store',
      'an explicit JIRA_ROOT outranks the DSH_HOME default',
    )
  })

  it('says so, rather than guessing, when nothing is configured', () => {
    const failed = resolveStoreRoot({ env: {}, platform: 'linux' })
    assert.equal(failed.ok, false)
    if (!failed.ok) assert.match(failed.error.message, /cannot resolve the store root/u)
  })
})

describe('config: the path may not be longer than the platform allows (decision 60)', () => {
  it('refuses a root past the limit, naming the length and the platform', () => {
    // A root that fits is not enough: the store appends `projects/<P>/comments/<KEY>.md` to it, so
    // the failure would surface as a puzzling ENOENT inside a write, not as a path problem.
    const limit = longPathLimitOf('win32')
    const tooLong = `C:\\${'d'.repeat(limit)}`
    const failed = resolveStoreRoot({ configured: tooLong, env: {}, platform: 'win32' })
    assert.equal(failed.ok, false, 'a root past MAX_PATH must be refused, not warned about')
    if (!failed.ok) {
      assert.match(failed.error.message, new RegExp(`past the ${String(limit)}-character limit of win32`, 'u'))
      assert.equal(failed.error.context?.length, tooLong.length)
    }

    // The same string is fine where the platform allows it — the rule is not a fixed number.
    assert.equal(unwrap(resolveStoreRoot({ configured: tooLong, env: {}, platform: 'linux' })), tooLong)
  })

  it('accepts a root that merely approaches the limit, because that one still works', () => {
    const near = `C:\\${'d'.repeat(PATH_LENGTH_WARN)}`
    assert.equal(near.length > PATH_LENGTH_WARN, true)
    assert.equal(near.length < longPathLimitOf('win32'), true)
    assert.equal(unwrap(resolveStoreRoot({ configured: near, env: {}, platform: 'win32' })), near)
  })
})
