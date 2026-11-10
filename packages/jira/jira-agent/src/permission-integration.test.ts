/** Exercise superagent permission changes through real policy services and filesystem tools. */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import PermissionPresetService from '@deepseek-ai/dsh-permission-presets'
import ToolPolicyService from '@deepseek-ai/dsh-tool-policy'
import { applySessionPermission } from './superagent-permission.ts'
import { testAgent } from './testing/host.ts'

async function fixture(soft: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-superagent-permission-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const outside = join(root, 'outside.txt')
  const ctx = new Context()
  let restoreHome: (() => void) | undefined
  if (soft) {
    // The built-in guarded profile expands its fixed ~/.ssh rule from this test-owned home.
    for (const name of process.platform === 'win32' ? ['USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH'] : ['HOME']) {
      const previous = process.env[name]
      const value = name === 'HOMEDRIVE' ? '' : root
      process.env[name] = value
      const earlier = restoreHome
      const restore = (): void => {
        if (previous !== undefined) { process.env[name] = previous; return }
        if (name === 'USERPROFILE') delete process.env.USERPROFILE
        else if (name === 'HOME') delete process.env.HOME
        else if (name === 'HOMEDRIVE') delete process.env.HOMEDRIVE
        else if (name === 'HOMEPATH') delete process.env.HOMEPATH
      }
      restoreHome = () => { restore(); earlier?.() }
    }
  }
  const target = testAgent(ctx, 'permission-integration', { cwd: workspace })
  const registry = {
    list: () => [{ id: 'w1', title: 'test', path: workspace, sessionIds: [], status: async () => 'ok' }],
    create: async () => { throw new Error('not used') },
  }
  const controller = {
    list: async () => ({ items: [{ sessionId: target.id, cwd: workspace, running: false }] }),
    create: async () => ({ sessionId: target.id }),
    prompt: async () => ({ accepted: true }),
    resolveAgent: async () => ({ agent: target }),
  }
  const permissionCtx = { get: (name: string) => name === 'workspaceRegistry' || name === 'sessionController' ? name === 'workspaceRegistry' ? registry : controller : ctx.get(name) }
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(WorkingDirectory)
  ctx.agents.enter(target)
  if (soft) {
    await ctx.plugin(ToolPolicyService, { defaultProfile: 'test', profiles: { test: {} } })
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
  } else {
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: workspace })
    ctx.provide('shell', { sandboxMode: 'workspace-write' })
    ctx.provide('approval', { config: { policy: 'ask' } })
    await ctx.plugin(PermissionPresetService, { presets: {
      'read-only': { sandbox: 'read-only', approval: 'ask' },
      'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
      'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
    } })
    await ctx.plugin(SandboxedFileSystem, { cwd: workspace })
  }
  await ctx.plugin(ToolFs)
  let calls = 0
  const write = (filePath: string) => executeModelToolFixture(ctx, {
    signal: new AbortController().signal,
    callId: ToolCallId(`permission-${++calls}`),
    name: 'write',
    arguments: { file_path: filePath, content: 'probe' },
    agent: target,
  })
  return { ctx, root, outside, workspace, target, permissionCtx, controller, write, restoreHome }
}

// The soft fixture temporarily supplies its private home to the built-in credential-path policy.
void describe('superagent permission integration', { concurrency: false }, () => {
  void it('changes subsequent real filesystem calls through OS presets', async () => {
    const f = await fixture(false)
    try {
      const initial = await applySessionPermission(f.permissionCtx, f.controller, 'w1', f.target.id, 'workspace-write', 'integration setup')
      assert.equal(initial.error, undefined, initial.error)
      const inside = await f.write(join(f.workspace, 'inside.txt'))
      assert.equal(inside.isError, false)
      assert.equal(await readFile(join(f.workspace, 'inside.txt'), 'utf8'), 'probe')
      assert.equal(f.ctx.sandboxPolicy.resolve({ session: f.target.session }).mode, 'workspace-write')
      assert.deepEqual(await applySessionPermission(f.permissionCtx, f.controller, 'w1', f.target.id, 'read-only'), {
        permission: { workspace: f.workspace, session: f.target.id, kind: 'os-sandbox', preset: 'read-only', sandbox: 'read-only', approval: 'ask' },
      })
      assert.equal((await f.write(join(f.workspace, 'denied.txt'))).isError, true)
      await assert.rejects(readFile(join(f.workspace, 'denied.txt'), 'utf8'), { code: 'ENOENT' })
      assert.equal((await applySessionPermission(f.permissionCtx, f.controller, 'w1', f.target.id, 'danger-full-access', 'integration needs an outside probe')).error, undefined)
      assert.equal((await f.write(f.outside)).isError, false)
      assert.equal(await readFile(f.outside, 'utf8'), 'probe')
      const events = f.target.session.snapshotEvents().filter(event => event.type === 'permission/preset' || event.type === 'sandbox/mode')
      assert.deepEqual(events.map(event => [event.type, event.data]), [
        ['permission/preset', { preset: 'workspace-write' }],
        ['sandbox/mode', { mode: 'workspace-write' }],
        ['permission/preset', { preset: 'read-only' }],
        ['sandbox/mode', { mode: 'read-only' }],
        ['permission/preset', { preset: 'danger-full-access', reason: 'integration needs an outside probe' }],
        ['sandbox/mode', { mode: 'danger-full-access' }],
      ])
      assert.equal((await applySessionPermission(f.permissionCtx, f.controller, 'w1', f.target.id, 'soft', 'must refuse')).error?.includes('unavailable'), true)
    } finally {
      f.restoreHome?.()
      await f.ctx.fiber.dispose()
      await rm(f.root, { recursive: true, force: true })
    }
  })

  void it('applies soft through the guarded tool policy on subsequent real file reads', async () => {
    const f = await fixture(true)
    try {
      const deniedPath = join(homedir(), '.ssh', 'probe.txt')
      const before = await f.write(deniedPath)
      assert.equal(before.isError, false)
      const switched = await applySessionPermission(f.permissionCtx, f.controller, 'w1', f.target.id, 'soft', 'verify the soft blacklist')
      assert.equal(switched.error, undefined, switched.error)
      assert.equal(f.ctx.toolPolicy.profileForSession(f.target.session).name, 'guarded')
      const denied = await executeModelToolFixture(f.ctx, {
        signal: new AbortController().signal,
        callId: ToolCallId('soft-denied-read'),
        name: 'read',
        arguments: { file_path: deniedPath },
        agent: f.target,
      })
      assert.equal(denied.isError, true)
      assert.match(JSON.stringify(denied), /FS_POLICY_DENIED|tool-policy denied path/u)
      assert.equal((await f.write(join(f.workspace, 'allowed.txt'))).isError, false)
      assert.equal(await readFile(join(f.workspace, 'allowed.txt'), 'utf8'), 'probe')
      assert.deepEqual(f.target.session.snapshotEvents().at(-1)?.data, { preset: 'guarded', reason: 'verify the soft blacklist' })
    } finally {
      f.restoreHome?.()
      await f.ctx.fiber.dispose()
      await rm(f.root, { recursive: true, force: true })
    }
  })
})
