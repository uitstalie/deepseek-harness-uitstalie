/**
 * Workspace write lease coverage: classification, acquisition, conflict,
 * reclaim with fencing, release, observe mode, and the audit trail. Every test
 * owns a temporary harness home and a temporary checkout directory, so no test
 * writes into the real `$DSH_HOME`.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/types'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { defineContentToolFixture, executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import {
  LEASE_IDLE_MS,
  WORKSPACE_LEASE_HELD,
  WORKSPACE_LEASE_LOST,
  classifyLeaseTool,
  createWorkspaceLeaseGuard,
} from '../src/lease.ts'
import type { WorkspaceLeaseGuard } from '../src/lease.ts'

const signal = new AbortController().signal

let home: string
let project: string
let ctx: Context
let guard: WorkspaceLeaseGuard
let writes: string[]
let clock: number

/** One fake Agent carrying only the Session identity and cwd the guard reads. */
function agentOf(sessionId: string): Agent {
  return { session: { id: sessionId, header: { cwd: project } } } as unknown as Agent
}

/** Mount the registry, the native executor, a write tool, a read tool, and the guard. */
async function mount(options: { mode?: 'enforce' | 'observe' } = {}): Promise<void> {
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  guard = createWorkspaceLeaseGuard(ctx, {
    home,
    now: () => clock,
    hostId: 'test-host',
    pid: 4242,
    mode: options.mode ?? 'enforce',
    idleMs: LEASE_IDLE_MS,
  })
  ctx.on('tools/execute', async (exec, next) => {
    const decision = await guard.beforeTool(exec.agent === undefined
      ? { name: exec.name, arguments: exec.arguments }
      : { name: exec.name, agent: exec.agent, arguments: exec.arguments })
    if (decision !== undefined) return decision
    return next()
  })
  ctx.tools.register(defineContentToolFixture({
    name: 'write',
    description: 'records one write',
    parameters: {},
    execute(_args, exec) {
      writes.push(String(exec.agent?.session.id))
      return Promise.resolve([{ type: 'text', text: 'wrote' }])
    },
  }))
  ctx.tools.register(defineContentToolFixture({
    name: 'read',
    description: 'reads',
    parameters: {},
    execute() { return Promise.resolve([{ type: 'text', text: 'read' }]) },
  }))
}

/** Run one tool call as the given Session. */
function run(name: string, agent: Agent, id = 'c1'): Promise<{ isError: boolean; error?: { info?: { code?: string } } }> {
  return executeToolFixture(ctx, { callId: brandString<ToolCallId>(id), name, arguments: {}, signal, agent })
}

/** Read the lease record the guard wrote. */
async function record(): Promise<Record<string, unknown>> {
  const directories = await readdir(join(home, 'workspaces'))
  const key = directories.find(name => name.startsWith('lease-'))
  return JSON.parse(await readFile(join(home, 'workspaces', String(key), 'lease.json'), 'utf8'))
}

/** Read the audit lines written so far. */
async function auditLines(): Promise<Record<string, unknown>[]> {
  const text = await readFile(join(home, 'logs', 'workspace-lease.jsonl'), 'utf8')
  return text.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
}

/**
 * A process id whose process has exited, so the guard's `process.kill(pid, 0)`
 * probe reports ESRCH. A freed pid can be reused immediately, so verify it and
 * try another exited child instead.
 */
async function exitedPid(): Promise<number> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', () => { resolve() })
    })
    const pid = child.pid
    if (pid === undefined) continue
    try {
      process.kill(pid, 0)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return pid
    }
  }
  throw new Error('could not obtain an exited process id')
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-lease-home-'))
  project = await mkdtemp(join(tmpdir(), 'dsh-lease-project-'))
  writes = []
  clock = Date.now()
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
})

describe('lease classification', () => {
  it('reads never acquire, control-plane writes are exempt, and an unknown tool is a write', () => {
    expect(classifyLeaseTool('read', {})).toBe('read')
    expect(classifyLeaseTool('pwsh', {})).toBe('write')
    expect(classifyLeaseTool('write', {})).toBe('write')
    expect(classifyLeaseTool('memory_write', {})).toBe('exempt')
    expect(classifyLeaseTool('workspace_tasks', {})).toBe('exempt')
    expect(classifyLeaseTool('workspace_artifacts', {})).toBe('exempt')
    expect(classifyLeaseTool('workspace_sessions', { action: 'list' })).toBe('exempt')
    expect(classifyLeaseTool('workspace_sessions', { action: 'run' })).toBe('exempt')
    expect(classifyLeaseTool('workspace_sessions', {})).toBe('write')
    expect(classifyLeaseTool('some_new_tool', {})).toBe('write')
  })
})

describe('acquisition and conflict', () => {
  it('the first write acquires, the next one renews, and the record names the holder', async () => {
    await mount()
    expect((await run('write', agentOf('s1'))).isError).toBe(false)
    expect(writes).toEqual(['s1'])
    expect(await record()).toMatchObject({ sessionId: 's1', generation: 1 })
    expect((await run('write', agentOf('s1'), 'c2')).isError).toBe(false)
    const events = (await auditLines()).map(line => line.event)
    expect(events).toEqual(['acquired'])
  })

  it('refuses a second Session with WORKSPACE_LEASE_HELD and never runs its tool', async () => {
    await mount()
    await run('write', agentOf('s1'))
    const result = await run('write', agentOf('s2'), 'c2')
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe(WORKSPACE_LEASE_HELD)
    expect(writes).toEqual(['s1'])
    const denied = (await auditLines()).filter(line => line.event === 'denied')
    expect(denied).toHaveLength(1)
    expect(denied[0]).toMatchObject({ workspace: (await record()).root, sessionId: 's2', holder: 's1', generation: 1 })
  })

  it('lets another Session read while the lease is held', async () => {
    await mount()
    await run('write', agentOf('s1'))
    expect((await run('read', agentOf('s2'), 'c2')).isError).toBe(false)
    expect(writes).toEqual(['s1'])
  })

  it('observe mode audits the conflict and lets the write proceed', async () => {
    await mount({ mode: 'observe' })
    await run('write', agentOf('s1'))
    expect((await run('write', agentOf('s2'), 'c2')).isError).toBe(false)
    expect(writes).toEqual(['s1', 's2'])
    expect((await auditLines()).filter(line => line.event === 'denied')[0]).toMatchObject({ result: 'observe', holder: 's1' })
  })
})

describe('expiry, reclaim, fencing, and release', () => {
  it('reclaims an idle lease, fences the old holder, and audits both events', async () => {
    await mount()
    await run('write', agentOf('s1'))
    clock += LEASE_IDLE_MS + 1
    expect((await run('write', agentOf('s2'), 'c2')).isError).toBe(false)
    expect(await record()).toMatchObject({ sessionId: 's2', generation: 2 })
    const lost = await run('write', agentOf('s1'), 'c3')
    expect(lost.isError).toBe(true)
    expect(lost.error?.info?.code).toBe(WORKSPACE_LEASE_LOST)
    const events = (await auditLines()).map(line => line.event)
    expect(events).toContain('reclaimed')
    expect(events).toContain('lost')
  })

  it('recovers a fenced Session after the new holder releases', async () => {
    await mount()
    await run('write', agentOf('s1'))
    clock += LEASE_IDLE_MS + 1
    await run('write', agentOf('s2'), 'c2')
    expect((await run('write', agentOf('s1'), 'c3')).error?.info?.code).toBe(WORKSPACE_LEASE_LOST)

    expect(await guard.release('s2')).toBe(true)
    expect((await run('write', agentOf('s1'), 'c4')).isError).toBe(false)
    expect(await record()).toMatchObject({ sessionId: 's1', generation: 2 })
    const reclaimed = (await auditLines()).filter(line => line.event === 'reclaimed').at(-1)
    expect(reclaimed).toMatchObject({ sessionId: 's1', holder: 'unknown', generation: 2 })
    expect(writes).toEqual(['s1', 's2', 's1'])
  })

  it('recovers a fenced Session after the new holder idle-expires', async () => {
    await mount()
    await run('write', agentOf('s1'))
    clock += LEASE_IDLE_MS + 1
    await run('write', agentOf('s2'), 'c2')
    expect((await run('write', agentOf('s1'), 'c3')).error?.info?.code).toBe(WORKSPACE_LEASE_LOST)

    clock += LEASE_IDLE_MS + 1
    expect((await run('write', agentOf('s1'), 'c4')).isError).toBe(false)
    expect(await record()).toMatchObject({ sessionId: 's1', generation: 3 })
    const reclaimed = (await auditLines()).filter(line => line.event === 'reclaimed').at(-1)
    expect(reclaimed).toMatchObject({ sessionId: 's1', holder: 's2', generation: 3 })
  })

  it('recovers a fenced Session after the holding process dies', async () => {
    const deadPid = await exitedPid()
    await mount()
    await run('write', agentOf('s1'))
    clock += LEASE_IDLE_MS + 1
    const foreign = createWorkspaceLeaseGuard(ctx, {
      home, now: () => clock, hostId: 'test-host', pid: deadPid, idleMs: LEASE_IDLE_MS,
    })
    expect(await foreign.beforeTool({ name: 'write', arguments: {}, agent: agentOf('s2') })).toBeUndefined()
    expect(await record()).toMatchObject({ sessionId: 's2', generation: 2, pid: deadPid, hostId: 'test-host' })

    expect((await run('write', agentOf('s1'), 'c2')).isError).toBe(false)
    expect(await record()).toMatchObject({ sessionId: 's1', generation: 3 })
    const reclaimed = (await auditLines()).filter(line => line.event === 'reclaimed').at(-1)
    expect(reclaimed).toMatchObject({ sessionId: 's1', holder: 's2', generation: 3 })
  })

  it('still refuses a fenced Session while the new holder is active', async () => {
    await mount()
    await run('write', agentOf('s1'))
    clock += LEASE_IDLE_MS + 1
    await run('write', agentOf('s2'), 'c2')
    const before = await record()

    const refused = await run('write', agentOf('s1'), 'c3')
    expect(refused.isError).toBe(true)
    expect(refused.error?.info?.code).toBe(WORKSPACE_LEASE_LOST)
    expect(writes).toEqual(['s1', 's2'])
    expect(await record()).toEqual(before)
    const lost = (await auditLines()).filter(line => line.event === 'lost')
    expect(lost.at(-1)).toMatchObject({ sessionId: 's1', generation: 1 })
  })

  it('observe mode recovers a fenced Session without refusing and reclaims the stale record', async () => {
    await mount({ mode: 'observe' })
    await run('write', agentOf('s1'))
    clock += LEASE_IDLE_MS + 1
    await run('write', agentOf('s2'), 'c2')
    clock += LEASE_IDLE_MS + 1
    expect((await run('write', agentOf('s1'), 'c3')).isError).toBe(false)
    expect(await record()).toMatchObject({ sessionId: 's1', generation: 3 })
    const reclaimed = (await auditLines()).filter(line => line.event === 'reclaimed').at(-1)
    expect(reclaimed).toMatchObject({ sessionId: 's1', holder: 's2', generation: 3 })
  })

  it('releases a disposed Session lease so another Session can acquire', async () => {
    await mount()
    await run('write', agentOf('s1'))
    expect(await guard.release('s1')).toBe(true)
    expect((await run('write', agentOf('s2'), 'c2')).isError).toBe(false)
    const events = (await auditLines()).map(line => line.event)
    expect(events).toContain('released')
    expect(events.filter(event => event === 'acquired')).toHaveLength(2)
  })

  it('keeps a record when release runs for a Session that holds nothing', async () => {
    await mount()
    await run('write', agentOf('s1'))
    expect(await guard.release('s2')).toBe(false)
    expect(await record()).toMatchObject({ sessionId: 's1' })
  })
})
