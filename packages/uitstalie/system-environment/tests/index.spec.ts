/**
 * The environment atom's two rule sets: the same path spelled two ways, env names in the
 * platform's case, and the two home directories. Every case pins the platform so both rule sets
 * are exercised on any host.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { createSystemEnvironment } from '../src/index.ts'
import * as SystemEnvironmentPlugin from '../src/index.ts'

const POSIX = createSystemEnvironment({ platform: 'posix', env: { HOME: '/home/tester' } })

const WINDOWS = createSystemEnvironment({
  platform: 'win32',
  env: { USERPROFILE: 'C:\\Users\\Tester', ProgramFiles: 'C:\\Program Files' },
})

describe('system environment: platform facts', () => {
  it('exposes the separators and PATH delimiter of each dialect', () => {
    expect(POSIX.separator).toBe('/')
    expect(POSIX.delimiter).toBe(':')
    expect(POSIX.caseInsensitive).toBe(false)
    expect(WINDOWS.separator).toBe('\\')
    expect(WINDOWS.delimiter).toBe(';')
    expect(WINDOWS.caseInsensitive).toBe(true)
  })

  it('joins with the platform dialect', () => {
    expect(POSIX.join('/a', 'b')).toBe('/a/b')
    expect(WINDOWS.join('C:\\a', 'b')).toBe('C:\\a\\b')
  })
})

describe('system environment: path comparison', () => {
  it('is case-sensitive on POSIX and case-insensitive on Windows', () => {
    expect(POSIX.samePath('/srv/Ledger', '/srv/ledger')).toBe(false)
    expect(WINDOWS.samePath('C:\\Data\\Ledger', 'c:/data/ledger')).toBe(true)
  })

  it('treats the directory itself and descendants as under, and a sibling prefix as outside', () => {
    expect(POSIX.isUnder('/a/b', '/a/b')).toBe(true)
    expect(POSIX.isUnder('/a/b', '/a/b/c/d')).toBe(true)
    expect(POSIX.isUnder('/a/b', '/a/bc')).toBe(false)
    expect(POSIX.isUnder('/', '/anything')).toBe(true)
    expect(WINDOWS.isUnder('C:\\A', 'c:\\a\\b')).toBe(true)
    expect(WINDOWS.isUnder('C:\\A', 'C:\\AB')).toBe(false)
  })

  it('drops a trailing separator in the comparison spelling', () => {
    expect(POSIX.normalizePath('/a/b/')).toBe('/a/b')
    expect(POSIX.samePath('/a/b/', '/a/b')).toBe(true)
    expect(WINDOWS.normalizePath('C:\\A\\B\\')).toBe('c:\\a\\b')
  })
})

describe('system environment: names and homes', () => {
  it('looks environment names up in the platform case', () => {
    expect(POSIX.env('HOME')).toBe('/home/tester')
    expect(POSIX.env('home')).toBeUndefined()
    expect(WINDOWS.env('programfiles')).toBe('C:\\Program Files')
    expect(WINDOWS.env('PROGRAMFILES')).toBe('C:\\Program Files')
  })

  it('resolves the user home and the Harness home', () => {
    expect(POSIX.homeDir()).toBe('/home/tester')
    expect(WINDOWS.homeDir()).toBe('C:\\Users\\Tester')
    // `dshHome` delegates to the shared resolution on the **host** path rules: the pinned
    // platform seam governs comparison, not the OS home this process actually runs on.
    const configured = process.platform === 'win32' ? 'C:\\tmp\\dsh' : '/tmp/dsh'
    const withHome = createSystemEnvironment({ env: { DSH_HOME: configured } })
    expect(withHome.dshHome()).toBe(resolveDshHome(undefined, { DSH_HOME: configured }))
    const fallback = createSystemEnvironment({ env: { HOME: '/home/t' } })
    expect(fallback.dshHome()).toBe(resolveDshHome(undefined, { HOME: '/home/t' }))
  })
})

describe('system environment: the row', () => {
  it('registers ctx.systemEnvironment with the configured platform', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemEnvironmentPlugin, { platform: 'win32', env: { USERPROFILE: 'C:\\Users\\T' } })
    expect(ctx.systemEnvironment.platform).toBe('win32')
    expect(ctx.systemEnvironment.homeDir()).toBe('C:\\Users\\T')
    await ctx.fiber.dispose()
  })
})
