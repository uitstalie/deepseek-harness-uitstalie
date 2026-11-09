import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'

const scratch: string[] = []
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('disabled built-in Windows ACL backend', () => {
  it.each(['read-only', 'workspace-write'] as const)('refuses %s without creating a grant or temp directory', async (mode) => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-acl-disabled-')))
    scratch.push(workspace)
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSandboxProvider, {})
    const sandbox = ctx.sandbox as LocalSandboxProvider
    sandbox.internals = { platform: 'win32' }
    try {
      await expect(sandbox.confine(['true'], { mode, workspaceRoot: workspace })).rejects.toThrow(SandboxUnavailableError)
    } finally {
      await fiber.dispose()
    }
  })
})
