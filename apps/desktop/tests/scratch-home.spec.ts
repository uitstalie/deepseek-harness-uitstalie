import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveDshHome } from '../../../packages/util/home-paths/src/index.ts'
import { afterEach, expect, it } from 'vitest'
import {
  assertScratchHome, createScratchHome, removeScratchHome, scratchHomeEnvironment, SCRATCH_HOME_PREFIX,
} from '../scripts/scratch-home.ts'

const roots: string[] = []
function disposableRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'desktop-scratch-home-spec-'))
  roots.push(root)
  return root
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('mints an owned home under the temporary directory and admits it', () => {
  const home = createScratchHome()
  roots.push(home)
  expect(home.startsWith(tmpdir())).toBe(true)
  expect(home.split(/[\\/]/u).at(-1)?.startsWith(SCRATCH_HOME_PREFIX)).toBe(true)
  expect(() => { assertScratchHome(home) }).not.toThrow()
})

it('pins every user-data pointer inside the home and drops ambient package-manager configuration', () => {
  const home = createScratchHome()
  roots.push(home)
  const environment = scratchHomeEnvironment(home, {
    PATH: 'kept', npm_config_registry: 'https://example.invalid', pnpm_home: 'dropped', DSH_HOME: 'C:\\Users\\someone\\.dsh',
  })
  expect(environment.PATH).toBe('kept')
  expect(environment.npm_config_registry).toBeUndefined()
  expect(environment.pnpm_home).toBeUndefined()
  for (const name of ['DSH_HOME', 'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'APPDATA', 'LOCALAPPDATA']) {
    expect(environment[name]).toBe(home)
  }
})

it.each([
  ['the user home', () => homedir()],
  ['the default Harness home', () => resolveDshHome()],
  ['an unprefixed temporary directory', () => disposableRoot()],
  ['a relative path', () => 'relative-home'],
])('refuses %s', (_label, path) => {
  const target = path()
  expect(() => { assertScratchHome(target) }).toThrow(/scratch home/u)
})

it('refuses to remove a directory it did not mint', () => {
  const root = disposableRoot()
  mkdirSync(join(root, 'kept'))
  expect(() => { removeScratchHome(root) }).toThrow(/scratch home/u)
  expect(existsSync(join(root, 'kept'))).toBe(true)
})

it('refuses a link that resolves outside the temporary directory', () => {
  const root = disposableRoot()
  const link = join(root, `${SCRATCH_HOME_PREFIX}link`)
  try {
    symlinkSync(homedir(), link, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    // Creating a directory link needs privileges on some hosts; the refusal still covers the resolved path.
    console.warn(`scratch home spec: skipping link case: ${(error as Error).message}`)
    return
  }
  expect(() => { assertScratchHome(link) }).toThrow(/scratch home/u)
})

it('removes the home it minted and leaves the temporary directory in place', () => {
  const home = createScratchHome()
  const nested = join(home, 'sessions', 'session-1')
  mkdirSync(nested, { recursive: true })
  removeScratchHome(home)
  expect(existsSync(home)).toBe(false)
  expect(existsSync(tmpdir())).toBe(true)
})
