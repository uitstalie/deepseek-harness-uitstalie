import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveDshHome } from '../../../packages/util/home-paths/src/index.ts'
import { afterEach, expect, it } from 'vitest'
import { ALLOW_USER_HOME_ENV, assertIsolatedHarnessHome } from '../scripts/home-isolation.ts'
import { createScratchHome } from '../scripts/scratch-home.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('admits a minted scratch home even though the temporary directory sits below the user profile', () => {
  const home = createScratchHome()
  roots.push(home)
  expect(() => { assertIsolatedHarnessHome(home, { environment: {} }) }).not.toThrow()
})

it.each([
  ['the user profile', () => homedir()],
  ['the default Harness home', () => resolveDshHome()],
  ['a directory inside the Harness home', () => join(resolveDshHome(), 'profiles', 'desktop')],
])('refuses %s', (_label, home) => {
  expect(() => { assertIsolatedHarnessHome(home(), { environment: {} }) }).toThrow(/home isolation/u)
})

it('refuses a non-scratch directory inside the user profile', () => {
  const directory = mkdtempSync(join(tmpdir(), 'home-isolation-spec-'))
  roots.push(directory)
  const home = join(homedir(), 'dsh-probe-home')
  expect(() => { assertIsolatedHarnessHome(home, { environment: {} }) }).toThrow(/home isolation/u)
  expect(directory.startsWith(tmpdir())).toBe(true)
})

it('refuses the temporary directory itself and relative paths', () => {
  expect(() => { assertIsolatedHarnessHome(tmpdir(), { environment: {} }) }).toThrow(/home isolation/u)
  expect(() => { assertIsolatedHarnessHome('relative-home', { environment: {} }) }).toThrow(/home isolation/u)
})

it('permits the user home only through the explicit opt-in', () => {
  expect(() => { assertIsolatedHarnessHome(homedir(), { allowUserHome: true }) }).not.toThrow()
  expect(() => { assertIsolatedHarnessHome(homedir(), { environment: { [ALLOW_USER_HOME_ENV]: '1' } }) }).not.toThrow()
})
