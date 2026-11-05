/**
 * `home-write`'s platform roots and its exclusion syntax: the home plus every
 * non-system fixed drive on Windows, the workspace exception, `excludePaths`
 * with a documented prefix syntax, and the folded-mode compatibility alias.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  SandboxHomeWriteUnavailableError,
  SandboxInvalidExcludeError,
  excludePrefix,
  expandConfiguredPath,
  homeWriteRoots,
  isPathAtOrUnder,
  matchingExclude,
  normalizeSandboxMode,
  resolvedExcludePaths,
  windowsNonSystemDrives,
} from '../src/index.ts'

const scratch: string[] = []
function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(dir)
  return realpathSync.native(dir)
}
afterAll(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('homeWriteRoots', () => {
  it('grants the home directory on Linux and macOS', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      expect(homeWriteRoots({ platform, home: '/home/dev' })).toEqual([realpathOrSelf('/home/dev')])
    }
  })

  it('refuses a home directory that IS the filesystem root', () => {
    expect(() => homeWriteRoots({ platform: 'linux', home: '/' })).toThrow(SandboxHomeWriteUnavailableError)
  })

  it('grants the home plus every non-system fixed drive on Windows', () => {
    const roots = homeWriteRoots({ platform: 'win32', home: 'C:\\Users\\dev', systemDrive: 'C:' })
    expect(roots.map(root => root.toUpperCase())).toContain('C:\\USERS\\DEV')
    for (const root of roots) {
      // Either the user's home, or a non-system drive root — never C:\ itself.
      expect(root.toUpperCase() === 'C:\\USERS\\DEV' || /^[D-Z]:\\$/u.test(root)).toBe(true)
    }
    if (process.platform === 'win32') {
      expect(windowsNonSystemDrives('C:').map(path => path[0]?.toUpperCase())).not.toContain('C')
    }
  })

  it('never grants a configured root on the Windows system drive outside the user home', () => {
    expect(homeWriteRoots({ platform: 'win32', home: 'C:\\Users\\dev', systemDrive: 'C:', configured: ['C:\\Windows'] })).toEqual([])
  })

  it('lets a configured override replace the platform default and expand ~', () => {
    const home = scratchDir('dsh-home-home-')
    const data = join(home, 'data')
    mkdirSync(data)
    expect(homeWriteRoots({ platform: 'win32', home, configured: [data, '~/x'] }))
      .toEqual([realpathSync.native(data)])
    expect(homeWriteRoots({ platform: 'win32', home, configured: ['~/data'] }))
      .toEqual([realpathSync.native(data)])
  })

  it('drops configured roots that do not exist instead of granting an unresolved spelling', () => {
    expect(homeWriteRoots({ platform: 'linux', home: '/home/dev', configured: ['/definitely/missing-tree'] })).toEqual([])
  })

  it('maps the folded mode name onto home-write', () => {
    expect(normalizeSandboxMode('non-critical-write')).toBe('home-write')
    expect(normalizeSandboxMode('home-write')).toBe('home-write')
  })
})

describe('excludePaths syntax', () => {
  it('expands ~ and a trailing glob prefix', () => {
    expect(excludePrefix('~/.ssh', '/home/dev', 'linux')).toBe('/home/dev/.ssh')
    expect(excludePrefix('~/.dsh/**', '/home/dev', 'linux')).toBe('/home/dev/.dsh')
    expect(excludePrefix('/data/protected/*', '/home/dev', 'linux')).toBe('/data/protected')
  })

  it('rejects relative paths and non-trailing glob syntax', () => {
    expect(() => expandConfiguredPath('relative/path', '/home/dev', 'linux')).toThrow(SandboxInvalidExcludeError)
    expect(() => excludePrefix('~/*/secrets', '/home/dev', 'linux')).toThrow(/only a trailing/)
    expect(() => excludePrefix('/data/{a,b}', '/home/dev', 'linux')).toThrow(SandboxInvalidExcludeError)
  })

  it('matches a subtree case-insensitively on Windows only', () => {
    expect(isPathAtOrUnder('/home/dev/.ssh/id', '/home/dev/.ssh', 'linux')).toBe(true)
    expect(isPathAtOrUnder('/home/dev/.ssh2/id', '/home/dev/.ssh', 'linux')).toBe(false)
    expect(isPathAtOrUnder('C:\\Data\\Protected\\x', 'c:\\data\\protected', 'win32')).toBe(true)
    expect(isPathAtOrUnder('/Data/Protected/x', '/data/protected', 'linux')).toBe(false)
    expect(matchingExclude('/home/dev/.ssh/id', ['/home/dev/.ssh'], 'linux')).toBe('/home/dev/.ssh')
  })

  it('requires an excluded path to exist before a confined call resolves it', () => {
    const base = scratchDir('dsh-exclude-')
    const missing = join(base, 'missing')
    const policy = {
      mode: 'home-write' as const,
      workspaceRoot: base,
      homeWriteRoots: [base],
      excludePaths: [missing],
    }
    expect(() => resolvedExcludePaths(policy)).toThrow(/does not exist/u)
    mkdirSync(missing)
    expect(resolvedExcludePaths(policy)).toEqual([missing])
  })

  it('returns no exclusions for other modes', () => {
    expect(resolvedExcludePaths({ mode: 'workspace-write', workspaceRoot: '/ws', excludePaths: ['/x'] })).toEqual([])
  })
})

/** Resolve a path when it exists, else keep the spelling (Linux paths on a Windows test host). */
function realpathOrSelf(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}
