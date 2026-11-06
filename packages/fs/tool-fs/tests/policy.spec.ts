import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FsTargetKey } from '@deepseek-ai/dsh-fs'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolPolicyService from '@deepseek-ai/dsh-tool-policy'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { assertFilePolicy } from '../src/policy.ts'

const target: FsTarget = { targetKey: FsTargetKey('/home/u/.ssh/id_rsa'), displayPath: '/home/u/.ssh/id_rsa' }
const exec = { name: 'read', callId: 'call-1', arguments: {}, signal: new AbortController().signal } as ToolExecution

describe('assertFilePolicy', () => {
  it('forwards the process path, operation, and execution to the mounted policy', () => {
    const assertFileAccess = vi.fn()
    const ctx = {
      get: (key: string) => key === 'toolPolicy' ? { assertFileAccess } : undefined,
      fs: { processPath: () => '/home/u/.ssh/id_rsa' },
    }
    assertFilePolicy(ctx as never, exec, 'read', target)
    expect(assertFileAccess).toHaveBeenCalledWith('read', '/home/u/.ssh/id_rsa', exec)
  })

  it('is a no-op when no policy is mounted', () => {
    const ctx = {
      get: () => undefined,
      fs: { processPath: () => '/home/u/.ssh/id_rsa' },
    }
    expect(() => { assertFilePolicy(ctx as never, exec, 'read', target) }).not.toThrow()
  })
})

describe('mounted soft policy over the real tool stack', () => {
  it('rejects a denied read with FS_POLICY_DENIED and still allows an unlisted path', async () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-tool-fs-policy-mounted-')))
    const secret = join(dir, 'secret')
    mkdirSync(secret)
    writeFileSync(join(secret, 'id_rsa'), 'key')
    const allowed = join(dir, 'notes.txt')
    writeFileSync(allowed, 'ok')
    const ctx = new Context()
    try {
      provideWorkingDirectoryFixture(ctx, dir)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(NativeToolExecutor)
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(ToolPolicyService, {
        defaultProfile: 'custom',
        profiles: { custom: { paths: [{ path: secret }] } },
      })
      await ctx.plugin(LocalFileSystem, { cwd: dir })
      await ctx.plugin(ToolFs)

      const session = Session.create(SessionId('session-policy-mounted'))
      const agent = { session } as never
      const denied = await executeToolFixture(ctx, {
        signal: new AbortController().signal,
        callId: ToolCallId('call-denied'),
        name: 'read',
        arguments: { file_path: join(secret, 'id_rsa') },
        agent,
      })
      expect(denied).toMatchObject({ isError: true, error: { info: { code: 'FS_POLICY_DENIED' } } })
      expect(JSON.stringify(denied)).toContain('tool-policy denied path')

      const permitted = await executeToolFixture(ctx, {
        signal: new AbortController().signal,
        callId: ToolCallId('call-allowed'),
        name: 'read',
        arguments: { file_path: allowed },
        agent,
      })
      expect(permitted.isError).toBe(false)
      expect(JSON.stringify(permitted)).toContain('ok')
    } finally {
      await ctx.fiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
