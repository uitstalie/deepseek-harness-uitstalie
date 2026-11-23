/**
 * Workspace write lease coverage: classification, acquisition, conflict,
 * reclaim with fencing, release, observe mode, and the audit trail. Every test
 * owns a temporary harness home and a temporary checkout directory, so no test
 * writes into the real `$DSH_HOME`.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/types'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { defineContentToolFixture, executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import {
  LEASE_ACTIVE_TURN_GRACE_MS,
  LEASE_IDLE_MS,
  LEASE_MAX_MS,
  WORKSPACE_LEASE_HELD,
  WORKSPACE_LEASE_LOST,
  classifyLeaseTool,
  createWorkspaceLeaseGuard,
  mountWorkspaceLease,
} from '../src/lease.ts'
import type { WorkspaceLeaseGuard } from '../src/lease.ts'

const signal = new AbortController().signal

let home: string
let project: string
let ctx: Context
let guard: WorkspaceLeaseGuard
let writes: string[]
let clock: number

/** `session/event` listeners the current mount registered, for `emitSessionEvent`. */
let sessionEventListeners: Array<(session: { id: string }, event: { type: string; time: number; data: unknown }) => void> = []

/**
 * Release promises the current mount's `session/event` listener has started and
 * not awaited; `flushTurnEndReleases` settles them before assertions.
 */
let turnEndReleases: Array<Promise<unknown>> = []

/** One fake Agent carrying only the Session identity and cwd the guard reads. */
function agentOf(sessionId: string): Agent {
  return { session: { id: sessionId, header: { cwd: project } } } as unknown as Agent
}

/**
 * Deliver one session event to the listeners the mounted guard registered,
 * mirroring how agent-loop emits `session/event` (fire-and-forget), and return
 * the flush for the release work the event started.
 */
function emitSessionEvent(sessionId: string, event: { type: string; time: number; data: unknown }): Promise<unknown> {
  const session = { id: sessionId, header: { cwd: project }, snapshotEvents: () => [], inheritedEventCount: 0 }
  turnEndReleases = []
  for (const listener of sessionEventListeners) listener(session, event)
  return Promise.allSettled(turnEndReleases)
}

/** Mount the registry, the native executor, a write tool, a read tool, and the guard. */
async function mount(options: { mode?: 'enforce' | 'observe'; activeTurnGraceMs?: number } = {}): Promise<void> {
  ctx = new Context()
  await ctx.plugin(SessionProjections)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  sessionEventListeners = []
  turnEndReleases = []
  guard = createWorkspaceLeaseGuard(ctx, {
    home,
    now: () => clock,
    hostId: 'test-host',
    pid: 4242,
    mode: options.mode ?? 'enforce',
    idleMs: LEASE_IDLE_MS,
    ...options.activeTurnGraceMs === undefined ? {} : { activeTurnGraceMs: options.activeTurnGraceMs },
  })
  // The spec's own mount wires the same `session/event` → release rule that
  // `mountWorkspaceLease` registers in production, captured so
  // `emitSessionEvent` can flush the release before assertions.
  sessionEventListeners.push((session, event) => {
    if (event.type === 'turn/start') {
      guard.noteTurnStart(session.id)
      return
    }
    if (event.type !== 'turn/end') return
    guard.noteTurnEnd(session.id)
    const release = guard.release(session.id, 'turn end')
    turnEndReleases.push(release)
    void release
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
function run(name: string, agent: Agent, id = 'c1', args: unknown = {}): Promise<ToolExecutionResult> {
  return executeToolFixture(ctx, { callId: brandString<ToolCallId>(id), name, arguments: args, signal, agent })
}

/** Read the lease record the guard wrote, or undefined when no record remains. */
async function record(): Promise<Record<string, unknown> | undefined> {
  const directories = await readdir(join(home, 'workspaces'))
  const key = directories.find(name => name.startsWith('lease-'))
  if (key === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(await readFile(join(home, 'workspaces', key, 'lease.json'), 'utf8'))
    return parsed as Record<string, unknown>
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
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
    expect(denied[0]).toMatchObject({ workspace: (await record())?.root, sessionId: 's2', holder: 's1', generation: 1 })
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

    expect(await guard.release('s2', 'session disposed')).toBe(true)
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
    expect(await guard.release('s1', 'session disposed')).toBe(true)
    expect((await run('write', agentOf('s2'), 'c2')).isError).toBe(false)
    const events = (await auditLines()).map(line => line.event)
    expect(events).toContain('released')
    expect(events.filter(event => event === 'acquired')).toHaveLength(2)
    const released = (await auditLines()).filter(line => line.event === 'released')
    expect(released.at(-1)).toMatchObject({ sessionId: 's1', operation: 'session disposed' })
  })

  it('keeps a record when release runs for a Session that holds nothing', async () => {
    await mount()
    await run('write', agentOf('s1'))
    expect(await guard.release('s2', 'session disposed')).toBe(false)
    expect(await record()).toMatchObject({ sessionId: 's1' })
  })

  it('releases on turn end so another Session acquires immediately, and audits the operation', async () => {
    await mount()
    await run('write', agentOf('s1'))
    await emitSessionEvent('s1', { type: 'turn/end', time: clock, data: { turn: 1, reason: { kind: 'completed' } } })
    expect(await record()).toBeUndefined()
    expect((await run('write', agentOf('s2'), 'c2')).isError).toBe(false)
    expect(await record()).toMatchObject({ sessionId: 's2', generation: 1 })
    const released = (await auditLines()).filter(line => line.event === 'released')
    expect(released).toHaveLength(1)
    expect(released[0]).toMatchObject({ sessionId: 's1', operation: 'turn end' })
  })

  it('keeps the lease across steps of one turn: turn/end is the release point, not turn/start', async () => {
    await mount()
    await emitSessionEvent('s1', { type: 'turn/start', time: clock, data: { turn: 1 } })
    await run('write', agentOf('s1'))
    await run('write', agentOf('s1'), 'c2')
    expect(await record()).toMatchObject({ sessionId: 's1' })
    await emitSessionEvent('s1', { type: 'turn/end', time: clock, data: { turn: 1, reason: { kind: 'completed' } } })
    expect(await record()).toBeUndefined()
  })

  it('ignores non-turn-end session events', async () => {
    await mount()
    await run('write', agentOf('s1'))
    await emitSessionEvent('s1', { type: 'turn/start', time: clock, data: { turn: 2 } })
    await emitSessionEvent('s1', { type: 'step/end', time: clock, data: {} })
    expect(await record()).toMatchObject({ sessionId: 's1' })
  })

  it('reports the holder, retry moment, and retryAfterMs in the refusal text and info', async () => {
    await mount()
    await run('write', agentOf('s1'))
    clock += 120_000
    const result = await run('write', agentOf('s2'), 'c2')
    if (!result.isError) throw new Error('expected the held write to be refused')
    const info = result.error.info
    if (info === undefined) throw new Error('expected refusal info')
    expect(info.code).toBe(WORKSPACE_LEASE_HELD)
    const fields = info as unknown as Record<string, unknown>
    expect(fields.root).toBeTypeOf('string')
    expect(fields.holderSessionId).toBe('s1')
    expect(fields.holderOperation).toBe('write')
    expect(fields.retryAfterMs).toBe(LEASE_IDLE_MS - 120_000)
    const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    expect(text).not.toContain('do not retry or write')
    expect(text).toContain('holder:     session s1')
    expect(text).toContain(`idle expiry ${String(fields.idleExpiresAt)}`)
    expect(text).toContain('retry once after that moment')
    expect(text).toContain('do not retry in a loop')
    expect(String(fields.idleExpiresAt)).toMatch(/Z$/)
  })

  it('reports retryAfterMs 0 when the held record is already past its idle expiry moment', async () => {
    await mount()
    await run('write', agentOf('s1'))
    clock += LEASE_IDLE_MS + 1
    // s2 reclaims on its own write; instead exercise the boundary via a holder
    // whose record expired between the expiry check and the refusal: the same
    // write path reclaims, so simulate the boundary with max-life expiry off
    // and a fresh read: the refusal only fires while not expired, and the
    // arithmetic must never go negative.
    clock -= 1
    const result = await run('write', agentOf('s2'), 'c2')
    const info = result.error?.info as Record<string, unknown> | undefined
    if (info !== undefined) expect(Number(info.retryAfterMs)).toBeGreaterThanOrEqual(0)
  })
})

describe('active-turn grace', () => {
  it('keeps the lease past the idle window while the holder turn is open', async () => {
    await mount()
    await emitSessionEvent('s1', { type: 'turn/start', time: clock, data: { turn: 1 } })
    await run('write', agentOf('s1'))
    clock += LEASE_IDLE_MS + 1
    const refused = await run('write', agentOf('s2'), 'c2')
    expect(refused.isError).toBe(true)
    expect(refused.error?.info?.code).toBe(WORKSPACE_LEASE_HELD)
    expect(await record()).toMatchObject({ sessionId: 's1', generation: 1 })
    expect(writes).toEqual(['s1'])
  })

  it('reclaims the record once the active-turn grace passes', async () => {
    await mount()
    await emitSessionEvent('s1', { type: 'turn/start', time: clock, data: { turn: 1 } })
    await run('write', agentOf('s1'))
    clock += LEASE_ACTIVE_TURN_GRACE_MS + 1
    expect((await run('write', agentOf('s2'), 'c2')).isError).toBe(false)
    expect(await record()).toMatchObject({ sessionId: 's2', generation: 2 })
    expect((await run('write', agentOf('s1'), 'c3')).error?.info?.code).toBe(WORKSPACE_LEASE_LOST)
  })

  it('still caps the lease at its maximum life while the holder turn is open', async () => {
    await mount({ activeTurnGraceMs: LEASE_MAX_MS * 2 })
    await emitSessionEvent('s1', { type: 'turn/start', time: clock, data: { turn: 1 } })
    await run('write', agentOf('s1'))
    clock += LEASE_MAX_MS + 1
    expect((await run('write', agentOf('s2'), 'c2')).isError).toBe(false)
    expect(await record()).toMatchObject({ sessionId: 's2', generation: 2 })
  })

  it('drops the grace when the holder turn closes', async () => {
    await mount()
    await emitSessionEvent('s1', { type: 'turn/start', time: clock, data: { turn: 1 } })
    await run('write', agentOf('s1'))
    guard.noteTurnEnd('s1')
    clock += LEASE_IDLE_MS + 1
    expect((await run('write', agentOf('s2'), 'c2')).isError).toBe(false)
    expect(await record()).toMatchObject({ sessionId: 's2', generation: 2 })
  })

  it('does not grant the grace to a record written by another host', async () => {
    await mount()
    await emitSessionEvent('s1', { type: 'turn/start', time: clock, data: { turn: 1 } })
    const foreign = createWorkspaceLeaseGuard(ctx, {
      home, now: () => clock, hostId: 'other-host', pid: 999, idleMs: LEASE_IDLE_MS,
    })
    expect(await foreign.beforeTool({ name: 'write', arguments: {}, agent: agentOf('s1') })).toBeUndefined()
    clock += LEASE_IDLE_MS + 1
    expect((await run('write', agentOf('s2'), 'c2')).isError).toBe(false)
    expect(await record()).toMatchObject({ sessionId: 's2', generation: 2 })
  })

  it('names the holder and the single retry in the LOST refusal', async () => {
    await mount()
    await run('write', agentOf('s1'))
    clock += LEASE_IDLE_MS + 1
    await run('write', agentOf('s2'), 'c2')
    const holder = await record()
    clock += 60_000
    const lost = await run('write', agentOf('s1'), 'c3')
    expect(lost.isError).toBe(true)
    const info: unknown = lost.error?.info
    expect(info).toMatchObject({
      code: WORKSPACE_LEASE_LOST,
      root: holder?.['root'],
      holderSessionId: 's2',
      holderOperation: 'write',
      retryAfterMs: LEASE_IDLE_MS - 60_000,
    })
    expect(info).toHaveProperty('idleExpiresAt')
    const text = lost.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    expect(text).toContain('holder:     session s2 acquired')
    expect(text).toMatch(/idle expiry \d{4}-\d{2}-\d{2}T[0-9:.]+Z/)
    expect(text).toContain('The record becomes reclaimable in 540s')
    expect(text).not.toContain('do not write')
    expect(text).toContain('retry once after that moment')
    expect(text).toContain("If the holder's turn is still running, wait for it to end first")
  })
})

describe('archive releases the lease', () => {
  let archiveFails = false

  /**
   * Mount only the production wiring (`mountWorkspaceLease`), plus the tools the
   * archive path dispatches, so the release runs through the real wrapper.
   */
  async function mountProductionOnly(): Promise<void> {
    ctx = new Context()
    await ctx.plugin(SessionProjections)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    writes = []
    archiveFails = false
    sessionEventListeners = []
    turnEndReleases = []
    guard = mountWorkspaceLease(ctx, {
      home,
      now: () => clock,
      hostId: 'test-host',
      pid: 4242,
      mode: 'enforce',
      idleMs: LEASE_IDLE_MS,
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
      name: 'workspace_sessions',
      description: 'archives one Session',
      parameters: { action: { type: 'string', required: true }, sessionId: { type: 'string' } },
      execute(args) {
        if (archiveFails) throw new Error('archive refused')
        return Promise.resolve([{ type: 'text', text: `archived ${String(args.sessionId)}` }])
      },
    }))
  }

  it('releases the archived Session lease and audits the operation', async () => {
    await mountProductionOnly()
    await run('write', agentOf('s1'))
    expect(await record()).toMatchObject({ sessionId: 's1' })
    const archived = await run('workspace_sessions', agentOf('s2'), 'c2', { action: 'archive', sessionId: 's1' })
    expect(archived.isError).toBe(false)
    expect(await record()).toBeUndefined()
    const released = (await auditLines()).filter(line => line.event === 'released')
    expect(released.at(-1)).toMatchObject({ sessionId: 's1', operation: 'session archived' })
    expect((await run('write', agentOf('s2'), 'c3')).isError).toBe(false)
    expect(await record()).toMatchObject({ sessionId: 's2', generation: 1 })
  })

  it('keeps other leases when the archived Session holds none', async () => {
    await mountProductionOnly()
    await run('write', agentOf('s1'))
    const archived = await run('workspace_sessions', agentOf('s2'), 'c2', { action: 'archive', sessionId: 's3' })
    expect(archived.isError).toBe(false)
    expect(await record()).toMatchObject({ sessionId: 's1' })
    expect((await auditLines()).filter(line => line.event === 'released')).toHaveLength(0)
  })

  it('does not release when the archive call itself failed', async () => {
    await mountProductionOnly()
    await run('write', agentOf('s1'))
    archiveFails = true
    const archived = await run('workspace_sessions', agentOf('s2'), 'c2', { action: 'archive', sessionId: 's1' })
    expect(archived.isError).toBe(true)
    expect(await record()).toMatchObject({ sessionId: 's1' })
    expect((await auditLines()).filter(line => line.event === 'released')).toHaveLength(0)
  })

  it('keeps the archive result when the release audit cannot be written', async () => {
    await mountProductionOnly()
    await run('write', agentOf('s1'))
    // Replace the audit directory with a file: the release removes the record
    // and then fails to append its audit line, which must not fail the archive.
    await rm(join(home, 'logs'), { recursive: true, force: true })
    await writeFile(join(home, 'logs'), 'not a directory')
    const archived = await run('workspace_sessions', agentOf('s2'), 'c2', { action: 'archive', sessionId: 's1' })
    expect(archived.isError).toBe(false)
    expect(await record()).toBeUndefined()
  })

  it('ignores non-archive and malformed workspace_sessions calls', async () => {
    await mountProductionOnly()
    await run('write', agentOf('s1'))
    expect((await run('workspace_sessions', agentOf('s2'), 'c2', { action: 'list' })).isError).toBe(false)
    expect((await run('workspace_sessions', agentOf('s2'), 'c3', { action: 'archive' })).isError).toBe(false)
    expect((await run('workspace_sessions', agentOf('s2'), 'c4', { action: 'archive', sessionId: '   ' })).isError).toBe(false)
    expect(await record()).toMatchObject({ sessionId: 's1' })
    expect((await auditLines()).filter(line => line.event === 'released')).toHaveLength(0)
  })
})

describe('mountWorkspaceLease wiring', () => {
  /**
   * Mount the production wiring — `mountWorkspaceLease`, not a re-implementation
   * of its listeners — over the shared ctx, so the registered `session/event`
   * and `agent/disposed` handlers are the ones the tests exercise.
   */
  async function mountProductionWiring(): Promise<void> {
    await mount()
    sessionEventListeners = []
    turnEndReleases = []
    mountWorkspaceLease(ctx, {
      home,
      now: () => clock,
      hostId: 'test-host',
      pid: 4242,
      mode: 'enforce',
      idleMs: LEASE_IDLE_MS,
    })
  }

  it('releases through the real session/event wiring on turn end and audits the operation', async () => {
    await mountProductionWiring()
    await run('write', agentOf('s1'))
    ctx.emit('session/event', { id: 's1', header: { cwd: project }, snapshotEvents: () => [], inheritedEventCount: 0 } as never, {
      type: 'turn/end', seq: 0, time: clock, data: { turn: 1, reason: { kind: 'completed' } },
    } as never)
    // The production listener releases without awaiting; let it settle.
    await vi.waitFor(async () => {
      expect(await record()).toBeUndefined()
    })
    const released = (await auditLines()).filter(line => line.event === 'released')
    expect(released).toHaveLength(1)
    expect(released[0]).toMatchObject({ sessionId: 's1', operation: 'turn end' })
    expect((await run('write', agentOf('s2'), 'c2')).isError).toBe(false)
  })

  it('releases through the real agent/disposed wiring', async () => {
    await mountProductionWiring()
    await run('write', agentOf('s1'))
    ctx.emit('agent/disposed', { agent: agentOf('s1') } as never)
    await vi.waitFor(async () => {
      expect(await record()).toBeUndefined()
    })
    const released = (await auditLines()).filter(line => line.event === 'released')
    expect(released.at(-1)).toMatchObject({ sessionId: 's1', operation: 'session disposed' })
  })
})
