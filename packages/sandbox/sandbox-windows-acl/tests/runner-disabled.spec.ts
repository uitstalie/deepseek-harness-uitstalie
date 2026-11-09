import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const runnerEntry = fileURLToPath(new URL('../src/runner.ts', import.meta.url))
const scratch: string[] = []
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('disabled Windows ACL runner', () => {
  it.each(['read-only', 'workspace-write'])('refuses %s before granting or spawning', (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-acl-test-'))
    scratch.push(root)
    const workspace = join(root, 'workspace')
    const temp = join(root, 'temp')
    const marker = join(workspace, 'command-ran')
    const result = spawnSync(process.execPath, [
      '--import', 'tsx/esm', runnerEntry,
      '--workspace', workspace, '--temp', temp, '--mode', mode,
      '--', process.execPath, '-e', "require('node:fs').writeFileSync(process.argv[1], 'ran')", marker,
    ], { encoding: 'utf8', timeout: 30_000 })
    expect(result.status, result.stderr).toBe(127)
    expect(result.error).toBeUndefined()
    expect(result.stderr).toContain('windows-acl-run: Windows ACL sandboxing is disabled')
    expect(existsSync(workspace)).toBe(false)
    expect(existsSync(temp)).toBe(false)
    expect(existsSync(marker)).toBe(false)
  })
})
