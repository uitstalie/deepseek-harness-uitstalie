import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onTestFinished, afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import ToolPolicyService, {
  applyVisibilityForAgent,
  renderToolPolicyPrompt,
  restrictableDeny,
} from '../src/index.ts'
import { installToolGuard } from '../src/guard.ts'

type PluginConfig = NonNullable<Parameters<typeof ToolPolicyService.Config>[0]>

async function mounted(config: PluginConfig = {}): Promise<Context> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(ToolPolicyService, config)
  return ctx
}

function freshSession(id: string): Session {
  return Session.create(SessionId(id))
}

describe('ToolPolicyService profiles', () => {
  it('starts from guarded and resolves the session selection', async () => {
    const ctx = await mounted()
    const session = freshSession('sess-profile')
    expect(ctx.toolPolicy.defaultProfile).toBe('guarded')
    expect(ctx.toolPolicy.profileForSession(session).name).toBe('guarded')
    ctx.toolPolicy.select(session, 'unrestricted')
    expect(ctx.toolPolicy.profileForSession(session).name).toBe('unrestricted')
    expect(session.snapshotEvents().filter(event => event.type === 'permission/preset')).toHaveLength(1)
  })

  it('falls back to the default for a retired permission preset name', async () => {
    const ctx = await mounted()
    const session = freshSession('sess-legacy')
    session.append('permission/preset', { preset: 'workspace-write' })
    expect(ctx.toolPolicy.profileForSession(session).name).toBe('guarded')
  })

  it('rejects an unknown default, a relative rule path, and a duplicate tool', async () => {
    await expect(mounted({ defaultProfile: 'missing' })).rejects.toThrow(/not a defined profile/)
    await expect(mounted({ defaultProfile: 'custom', profiles: { custom: { paths: [{ path: 'relative' }] } } }))
      .rejects.toThrow(/must be absolute or start with "~"/)
    await expect(mounted({
      defaultProfile: 'custom',
      profiles: { custom: { tools: [{ name: 'bash' }, { name: 'bash' }] } },
    })).rejects.toThrow(/more than once/)
  })

  it('lists every built-in profile', async () => {
    const ctx = await mounted()
    expect(ctx.toolPolicy.names).toEqual(['unrestricted', 'guarded', 'guarded-no-shell', 'files-read-only'])
    expect(ctx.toolPolicy.has('guarded-no-shell')).toBe(true)
    expect(ctx.toolPolicy.has('read-only')).toBe(false)
  })
})

describe('legacy DSH_PERMISSION_MODE alias', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  it('maps danger-full-access to unrestricted and announces the mapping', async () => {
    vi.stubEnv('DSH_PERMISSION_MODE', 'danger-full-access')
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    const warn = vi.spyOn(ctx.logger, 'warn')
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(ToolPolicyService)
    expect(ctx.toolPolicy.defaultProfile).toBe('unrestricted')
    expect(warn.mock.calls.flat().join(' ')).toContain('DSH_PERMISSION_MODE is deprecated')
  })

  it.each(['read-only', 'workspace-write', 'home-write', 'unexpected'])('maps %s to guarded', async (value) => {
    vi.stubEnv('DSH_PERMISSION_MODE', value)
    const ctx = await mounted()
    expect(ctx.toolPolicy.defaultProfile).toBe('guarded')
  })

  it('leaves the configured default alone without the variable', async () => {
    const ctx = await mounted({ defaultProfile: 'files-read-only' })
    expect(ctx.toolPolicy.defaultProfile).toBe('files-read-only')
  })
})

describe('path rules', () => {
  it('denies a path and its subtree but not a look-alike sibling', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-tool-policy-rule-')))
    try {
      const secret = join(root, '.ssh')
      mkdirSync(secret)
      writeFileSync(join(secret, 'id_rsa'), 'key')
      const ctx = await mounted({ defaultProfile: 'custom', profiles: { custom: { paths: [{ path: secret }] } } })

      expect(() => { ctx.toolPolicy.assertFileAccess('read', join(secret, 'id_rsa')) })
        .toThrow(/tool-policy denied path/)
      expect(() => { ctx.toolPolicy.assertFileAccess('write', join(secret, 'new_key')) })
        .toThrow(/tool-policy denied path/)
      expect(() => { ctx.toolPolicy.assertFileAccess('read', join(root, '.ssh2', 'id_rsa')) })
        .not.toThrow()
      expect(ctx.toolPolicy.checkFileAccess('read', join(secret, 'id_rsa'))?.rule.displayPath).toBe(secret)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('throws the structured FS_POLICY_DENIED code with the matched rule', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-tool-policy-code-')))
    try {
      const ctx = await mounted({ defaultProfile: 'custom', profiles: { custom: { paths: [{ path: root, reason: 'test root' }] } } })
      try {
        ctx.toolPolicy.assertFileAccess('write', join(root, 'x'))
        throw new Error('expected a denial')
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(FsError)
        expect((error as FsError).code).toBe('FS_POLICY_DENIED')
        expect((error as FsError).message).toContain('not an OS sandbox')
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('honors per-operation rules', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-tool-policy-ops-')))
    try {
      const ctx = await mounted({
        defaultProfile: 'custom',
        profiles: { custom: { paths: [{ path: root, operations: ['write'] }] } },
      })
      expect(() => { ctx.toolPolicy.assertFileAccess('write', join(root, 'x')) }).toThrow(/denied path/)
      expect(() => { ctx.toolPolicy.assertFileAccess('read', join(root, 'x')) }).not.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('prompt', () => {
  it('states the soft policy, the denials, and the bypass surface', async () => {
    const ctx = await mounted()
    const text = renderToolPolicyPrompt(ctx.toolPolicy.profile('guarded'))
    expect(text).toContain('Current DSH tool policy: guarded')
    expect(text).toContain('NOT OS-confined')
    expect(text).toContain('~/.ssh (read/write/list)')
    expect(text).toContain('run_code')
    expect(text).toContain('not path-checked')
    expect(text).not.toContain('Current DSH file policy')
  })

  it('renders unrestricted without claiming denials', async () => {
    const ctx = await mounted()
    const text = renderToolPolicyPrompt(ctx.toolPolicy.profile('unrestricted'))
    expect(text).toContain('No file-tool path denials')
    expect(text).not.toContain('File-tool access is denied')
  })
})

describe('tool gate and visibility', () => {
  it('the guard denies run_code in guarded and allows bash', async () => {
    const ctx = await mounted()
    let guard: ((exec: ToolExecution) => string | undefined) | undefined
    const dispose = vi.fn()
    const fake = { tools: { guard: (fn: (exec: ToolExecution) => string | undefined) => { guard = fn; return dispose } } }
    installToolGuard(fake as never, ctx.toolPolicy)
    expect(guard?.({ name: 'run_code' } as ToolExecution)).toMatch(/denied by DSH tool policy "guarded"/)
    expect(guard?.({ name: 'bash' } as ToolExecution)).toBeUndefined()
  })

  it('guarded-no-shell hides bash/pwsh but leaves run_code to the guard', async () => {
    const ctx = await mounted()
    const session = freshSession('sess-vis')
    ctx.toolPolicy.select(session, 'guarded-no-shell')
    const profile = ctx.toolPolicy.profile('guarded-no-shell')
    expect(restrictableDeny(profile, new Set(['bash', 'pwsh', 'run_code', 'write']))).toEqual(['bash', 'pwsh'])

    const restrict = vi.fn(() => vi.fn())
    const agent = { id: 'a', session, ctx: { tools: { restrict } } }
    const applied = applyVisibilityForAgent(ctx.toolPolicy, agent as never, new Set(['bash', 'pwsh', 'run_code']))
    expect(restrict).toHaveBeenCalledWith({ deny: ['bash', 'pwsh'] })
    expect(applied?.deny).toEqual(['bash', 'pwsh'])
  })

  it('does not restrict run_code through the registry', async () => {
    const ctx = await mounted()
    const session = freshSession('sess-run-code')
    const restrict = vi.fn(() => vi.fn())
    const agent = { id: 'b', session, ctx: { tools: { restrict } } }
    expect(applyVisibilityForAgent(ctx.toolPolicy, agent as never, new Set(['run_code']))).toBeUndefined()
    expect(restrict).not.toHaveBeenCalled()
  })
})
