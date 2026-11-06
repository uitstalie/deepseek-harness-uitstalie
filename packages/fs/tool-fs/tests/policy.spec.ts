import { describe, expect, it, vi } from 'vitest'
import { FsTargetKey } from '@deepseek-ai/dsh-fs'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
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
