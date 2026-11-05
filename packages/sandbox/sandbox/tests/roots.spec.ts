/**
 * Tests for the writable-root derivation: the mode's meaning as a canonical
 * allow-list. Pinned here so the fs fence and the Seatbelt profile — both
 * deriving from `writableRoots` — cannot drift, and so the workspace-plus-
 * additional set stays one shared derivation across backend dialects.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalPath, fsWritableRoots, homeWriteReadOnlyRoots, homeWriteWritableRoots, isHomeWriteAllowed, workspaceWritableRoots, writableRoots } from '@deepseek-ai/dsh-sandbox'

/** Every temp root created by this file, removed after each test. */
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('canonicalPath', () => {
  it('resolves symlinks (an existing path realpaths)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-roots-'))
    roots.push(dir)
    expect(canonicalPath(dir)).toBe(realpathSync.native(dir))
  })

  it('returns the spelling as-is when the path cannot be resolved (conservative — matches nothing until it exists)', () => {
    expect(canonicalPath('/does/not/exist/anywhere-xyz')).toBe('/does/not/exist/anywhere-xyz')
  })
})

describe('fsWritableRoots', () => {
  it('adds existing physical fs-only roots and skips missing, non-directory and symlinked ones', () => {
    const ws = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-ws-')))
    const extra = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-extra-')))
    const missing = join(tmpdir(), 'dsh-fs-root-missing-xyz')
    const file = join(ws, 'file.txt')
    writeFileSync(file, 'file')
    roots.push(ws, extra)
    const grants = fsWritableRoots({
      mode: 'workspace-write',
      workspaceRoot: ws,
      fsAdditionalWritableRoots: [extra, extra, missing, file],
    })
    expect(grants).toContain(realpathSync.native(extra))
    expect(grants).not.toContain(missing)
    expect(grants).not.toContain(realpathSync.native(file))
    expect(fsWritableRoots({ mode: 'read-only', workspaceRoot: ws, fsAdditionalWritableRoots: [extra] })).toEqual([])
  })
})

describe('workspaceWritableRoots', () => {
  it('workspace-write grants only the workspace when no extra root is configured', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-ws-'))
    roots.push(ws)
    expect(workspaceWritableRoots({ mode: 'workspace-write', workspaceRoot: ws })).toEqual([realpathSync.native(ws)])
  })

  it('workspace-write deduplicates physical extra directories and rejects symlink aliases', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-ws-'))
    const extra = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-extra-')))
    const alias = join(ws, 'alias')
    symlinkSync(extra, alias, 'dir')
    roots.push(ws, extra)
    const grants = workspaceWritableRoots({
      mode: 'workspace-write',
      workspaceRoot: ws,
      additionalWritableRoots: [extra, extra],
    })
    expect(grants).toEqual([realpathSync.native(ws), realpathSync.native(extra)])
    expect(() => workspaceWritableRoots({ mode: 'workspace-write', workspaceRoot: ws, additionalWritableRoots: [alias] }))
      .toThrow('use the physical directory path')
  })

  it('rejects missing and non-directory extra roots before granting access', () => {
    const ws = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-roots-')))
    roots.push(ws)
    const file = join(ws, 'file.txt')
    writeFileSync(file, 'file')
    expect(() => workspaceWritableRoots({ mode: 'workspace-write', workspaceRoot: ws, additionalWritableRoots: [file] }))
      .toThrow('expected an existing directory')
    expect(() => workspaceWritableRoots({ mode: 'workspace-write', workspaceRoot: ws, additionalWritableRoots: [join(ws, 'missing')] }))
      .toThrow('cannot read the directory')
  })

  it('read-only grants nothing even when extra roots are carried on the policy', () => {
    expect(workspaceWritableRoots({ mode: 'read-only', workspaceRoot: '/ws', additionalWritableRoots: ['/extra'] })).toEqual([])
    expect(writableRoots({ mode: 'read-only', workspaceRoot: '/ws', additionalWritableRoots: ['/extra'] })).toEqual([])
  })
})

describe('writableRoots', () => {
  it('read-only grants nothing', () => {
    expect(writableRoots({ mode: 'read-only', workspaceRoot: process.cwd() })).toEqual([])
  })

  it('workspace-write grants the workspace root plus the platform temp areas, canonical and deduplicated', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-ws-'))
    roots.push(ws)
    const writable = writableRoots({ mode: 'workspace-write', workspaceRoot: ws })
    expect(writable).toContain(realpathSync.native(ws))
    expect(writable).toContain(canonicalPath('/tmp'))
    expect(writable).toContain(realpathSync.native(tmpdir()))
    // Deduplicated after canonicalization (/tmp and os.tmpdir() may coincide).
    expect(new Set(writable).size).toBe(writable.length)
  })

  it('workspace-write includes an explicit extra directory beside the temp areas', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-ws-'))
    const extra = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-extra-')))
    roots.push(ws, extra)
    expect(writableRoots({
      mode: 'workspace-write',
      workspaceRoot: ws,
      additionalWritableRoots: [extra],
    })).toContain(realpathSync.native(extra))
  })
})

describe('homeWrite', () => {
  it('allows the home, temp exceptions and the workspace; exclusions win over all of them', () => {
    const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-home-')))
    const temp = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-temp-')))
    const workspace = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-ws-')))
    const secret = join(home, '.ssh')
    const nested = join(secret, 'keys')
    mkdirSync(nested, { recursive: true })
    roots.push(home, temp, workspace)
    const policy = {
      mode: 'home-write' as const,
      workspaceRoot: workspace,
      homeWriteRoots: [home],
      homeWriteTempRoots: [temp],
      excludePaths: [realpathSync.native(secret)],
    }
    expect(homeWriteWritableRoots(policy)).toEqual([home, workspace, temp])
    expect(homeWriteReadOnlyRoots(policy)).toEqual([realpathSync.native(secret)])
    expect(isHomeWriteAllowed(policy, join(home, 'notes.txt'))).toBe(true)
    expect(isHomeWriteAllowed(policy, join(temp, 'build'))).toBe(true)
    expect(isHomeWriteAllowed(policy, join(workspace, 'file'))).toBe(true)
    expect(isHomeWriteAllowed(policy, '/etc/passwd')).toBe(false)
    expect(isHomeWriteAllowed(policy, join(secret, 'config'))).toBe(false)
    expect(isHomeWriteAllowed(policy, join(nested, 'id'))).toBe(false)
  })

  it('ignores workspace-write extras: home-write is a different authorization model', () => {
    const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-home-')))
    const workspace = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-ws-')))
    const extra = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-extra-')))
    roots.push(home, workspace, extra)
    const policy = {
      mode: 'home-write' as const,
      workspaceRoot: workspace,
      homeWriteRoots: [home],
      homeWriteTempRoots: [],
      additionalWritableRoots: [extra],
      fsAdditionalWritableRoots: [workspace],
    }
    expect(homeWriteWritableRoots(policy)).toEqual([home, workspace])
    expect(isHomeWriteAllowed(policy, join(workspace, 'file'))).toBe(true)
    expect(isHomeWriteAllowed(policy, join(extra, 'file'))).toBe(false)
  })
})
