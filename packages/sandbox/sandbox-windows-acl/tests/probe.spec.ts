/** The retired direct API refuses before creating a token, changing grants, or spawning a child. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AclSandbox, AclSandboxUnavailableError } from '../src/index.ts'

const scratch: string[] = []
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('AclSandbox disabled direct API', () => {
  it('rejects construction instead of allowing an escape write', () => {
    const writable = mkdtempSync(join(tmpdir(), 'dsh-acl-disabled-direct-'))
    scratch.push(writable)
    expect(() => new AclSandbox({
      writableDirs: [writable], tempDir: null, writeSid: 'S-1-4-9000-4', mode: 'workspace-write',
    })).toThrow(AclSandboxUnavailableError)
  })

  it('rejects init and spawn without executing the former write probe', async () => {
    const writable = mkdtempSync(join(tmpdir(), 'dsh-acl-disabled-direct-'))
    scratch.push(writable)
    let sandbox: AclSandbox
    try {
      sandbox = new AclSandbox({ writableDirs: [writable], tempDir: null, mode: 'read-only' })
    } catch (error) {
      expect(error).toBeInstanceOf(AclSandboxUnavailableError)
      return
    }
    await expect(sandbox.init()).rejects.toThrow(AclSandboxUnavailableError)
    expect(() => sandbox.spawn({ command: 'pwsh', args: ['-Command', 'write-escape'] })).toThrow(AclSandboxUnavailableError)
  })
})
