import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canonicalizeTarget, defaultCaseSensitive, isWithin } from '../src/canonicalize.ts'

const WIN = { platform: 'win32' as const, resolvePhysical: false }
const POSIX = { platform: 'linux' as const, cwd: '/work/ws', home: '/home/u', resolvePhysical: false }

describe('canonicalizeTarget (Win32 grammar)', () => {
  it.each([
    ['c:\\Users\\TS\\..\\TS\\.ssh', 'C:\\Users\\TS\\.ssh'],
    ['C:/Users/TS/.SSH', 'C:\\Users\\TS\\.SSH'],
    ['C:\\a\\b.txt:stream', 'C:\\a\\b.txt'],
    ['C:\\a\\b.txt:$DATA', 'C:\\a\\b.txt'],
    ['C:\\a\\b. ', 'C:\\a\\b'],
    ['\\\\?\\C:\\Users\\TS', 'C:\\Users\\TS'],
    ['\\\\?\\UNC\\Server\\Share\\x', '\\\\Server\\Share\\x'],
    ['\\\\Server\\Share\\a\\..\\b', '\\\\Server\\Share\\b'],
  ])('normalizes %j to %j', (input, expected) => {
    expect(canonicalizeTarget(input, WIN).lexical).toBe(expected)
  })

  it('rejects drive-relative and device-namespace paths', () => {
    expect(() => canonicalizeTarget('C:foo', WIN)).toThrow(/drive-relative/)
    expect(() => canonicalizeTarget('\\\\.\\PhysicalDrive0', WIN)).toThrow(/device-namespace/)
    expect(() => canonicalizeTarget('\\\\?\\GLOBALROOT\\Device\\X', WIN)).toThrow(/device-namespace/)
  })

  it('resolves a relative path against the session cwd', () => {
    expect(canonicalizeTarget('a\\b', { ...WIN, cwd: 'C:\\work' }).lexical).toBe('C:\\work\\a\\b')
  })

  it('treats Windows paths case-insensitively while preserving display case', () => {
    expect(defaultCaseSensitive('win32')).toBe(false)
    expect(isWithin('C:\\Users\\TS\\.ssh', 'c:\\users\\ts\\.SSH\\id_rsa', 'win32', false)).toBe(true)
    expect(isWithin('C:\\Users\\TS\\.ssh', 'C:\\Users\\TS\\.ssh2\\x', 'win32', false)).toBe(false)
  })
})

describe('canonicalizeTarget (POSIX grammar)', () => {
  it.each([
    ['~/.ssh', '/home/u/.ssh'],
    ['~/x', '/home/u/x'],
    ['../../etc/passwd', '/etc/passwd'],
    ['./a/./b', '/work/ws/a/b'],
    ['/tmp/../var/log', '/var/log'],
  ])('normalizes %j to %j', (input, expected) => {
    expect(canonicalizeTarget(input, POSIX).lexical).toBe(expected)
  })

  it('is case-sensitive on Linux and case-insensitive by default on macOS', () => {
    expect(defaultCaseSensitive('linux')).toBe(true)
    expect(defaultCaseSensitive('darwin')).toBe(false)
    expect(isWithin('/home/u/.ssh', '/home/u/.SSH/x', 'linux', true)).toBe(false)
    expect(isWithin('/Users/U/.ssh', '/users/u/.SSH/x', 'darwin', false)).toBe(true)
  })

  it('matches the root itself but not a look-alike sibling', () => {
    expect(isWithin('/home/u/.ssh', '/home/u/.ssh', 'linux', true)).toBe(true)
    expect(isWithin('/home/u/.ssh', '/home/u/.ssh2', 'linux', true)).toBe(false)
    expect(isWithin('/home/u/.ssh', '/home/u/.ssh/nested/key', 'linux', true)).toBe(true)
  })

  it('resolves a missing target through its nearest existing ancestor', () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-tool-policy-canon-')))
    try {
      const target = canonicalizeTarget(join(root, 'missing', 'deep', 'file.txt'))
      expect(target.physical).toBe(join(realpathSync.native(root), 'missing', 'deep', 'file.txt'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('tracks a symlink to its physical target, and keeps the lexical spelling', () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-tool-policy-link-')))
    try {
      const real = join(root, 'real')
      mkdirSync(real)
      const link = join(root, 'link')
      try {
        symlinkSync(real, link, 'dir')
      } catch {
        return // symlink creation needs a privilege this Windows host may not grant
      }
      const target = canonicalizeTarget(join(link, 'file.txt'))
      expect(target.lexical).toBe(join(link, 'file.txt'))
      expect(target.physical).toBe(join(realpathSync.native(real), 'file.txt'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolves /tmp to /private/tmp on macOS', () => {
    if (process.platform !== 'darwin') return
    expect(canonicalizeTarget('/tmp').physical).toBe('/private/tmp')
  })
})
