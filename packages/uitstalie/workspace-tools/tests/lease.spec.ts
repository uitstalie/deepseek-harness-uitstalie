/**
 * Workspace write lease coverage: classification, tool-level acquisition and
 * release, the FIFO queue, wait timeout, cancellation, reclaim, re-entry, and
 * the audit trail. Every test owns a temporary harness home and a temporary
 * checkout directory, so no test writes into the real `$DSH_HOME`.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
  LEASE_IDLE_MS,
  LEASE_MAX_MS,
  WORKSPACE_LEASE_HELD,
  WORKSPACE_LEASE_LOST,
  WORKSPACE_LEASE_QUEUE_TIMEOUT,
  classifyLeaseTool,
  createWorkspaceLeaseGuard,
  hasExplicitLeaseClass,
  mountWorkspaceLease,
} from '../src/lease.ts'
import type { LeaseGuardOptions } from '../src/lease.ts'

const defaultSignal = new AbortController().signal

let home: string
let project: string
let ctx: Context
/** Session ids whose tool body started, in the order they entered the body. */
let entered: string[]
/** Bodies currently running, and the highest number that ever ran at once. */
let running: number
let maxRunning: number
/** Bodies waiting on a hold, keyed by Session id. */
let holds: Map<string, { promise: Promise<void>; release: () => void }>
/** Resolvers waiting for the next body to start. */
let enterWaiters: Array<() => void>

/** Wake every waiter that is polling for the next body start. */
function notifyEnter(): void {
  for (const waiter of enterWaiters.splice(0)) waiter()
}

/**
 * Block one Session's tool body until {@link releaseBody}, so a test can hold
 * the lease while it exercises the queue.
 * @param sessionId - Session whose next body waits.
 */
function holdBody(sessionId: string): void {
  let release!: () => void
  const promise = new Promise<void>((resolveHold) => { release = () => { resolveHold() } })
  holds.set(sessionId, { promise, release })
}

/**
 * Let a held body finish.
 * @param sessionId - Session whose body is waiting.
 */
function releaseBody(sessionId: string): void {
  holds.get(sessionId)?.release()
  holds.delete(sessionId)
}

/**
 * Wait until at least `count` tool bodies have started.
 * @param count - number of started bodies to observe.
 */
async function waitForEnter(count: number): Promise<void> {
  while (entered.length < count) {
    await new Promise<void>((resolveWait) => { enterWaiters.push(resolveWait) })
  }
}

/** Whether the archive fixture fails its call. */
let archiveFails = false

/** One fake Agent carrying only the Session identity and cwd the guard reads. */
function agentOf(sessionId: string): Agent {
  return { session: { id: sessionId, header: { cwd: project } } } as unknown as Agent
}

/** The Session-shaped object the `session/event` listeners receive. */
function sessionOf(sessionId: string): never {
  return { id: sessionId, header: { cwd: project }, snapshotEvents: () => [], inheritedEventCount: 0 } as never
}

/**
 * Mount the registry, the native executor, a write tool, a read tool, a shell
 * tool, the archive tool, and the production lease wiring.
 * @param options - lease mode, queue window, poll interval, and clock.
 */
async function mount(options: {
  mode?: 'enforce' | 'observe'
  queueTimeoutMs?: number
  pollMs?: number
  now?: () => number
  idleMs?: number
  maxMs?: number
} = {}): Promise<void> {
  ctx = new Context()
  await ctx.plugin(SessionProjections)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  holds = new Map()
  enterWaiters = []
  const leaseOptions: LeaseGuardOptions = {
    home,
    hostId: 'test-host',
    pid: 4242,
    mode: options.mode ?? 'enforce',
    idleMs: options.idleMs ?? LEASE_IDLE_MS,
    queueTimeoutMs: options.queueTimeoutMs ?? 5000,
    pollMs: options.pollMs ?? 50,
    heartbeatMs: 0,
    ...(options.maxMs === undefined ? {} : { maxMs: options.maxMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
  }
  mountWorkspaceLease(ctx, leaseOptions)
  const record = (sessionId: string): void => {
    entered.push(sessionId)
    running += 1
    maxRunning = Math.max(maxRunning, running)
    notifyEnter()
  }
  const settle = (): void => {
    running -= 1
  }
  const body = async (sessionId: string, args: { file?: string }): Promise<void> => {
    record(sessionId)
    const hold = holds.get(sessionId)
    if (hold !== undefined) await hold.promise
    if (args.file !== undefined) await writeFile(join(project, args.file), sessionId)
    settle()
  }
  ctx.tools.register(defineContentToolFixture({
    name: 'write',
    description: 'records one write',
    parameters: { file: { type: 'string' } },
    async execute(args, exec) {
      await body(String(exec.agent?.session.id), args)
      return [{ type: 'text', text: 'wrote' }]
    },
  }))
  ctx.tools.register(defineContentToolFixture({
    name: 'pwsh',
    description: 'runs one command',
    parameters: { file: { type: 'string' } },
    async execute(args, exec) {
      await body(String(exec.agent?.session.id), args)
      return [{ type: 'text', text: 'ran' }]
    },
  }))
  ctx.tools.register(defineContentToolFixture({
    name: 'read',
    description: 'reads',
    parameters: {},
    execute() { return Promise.resolve([{ type: 'text', text: 'read' }]) },
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

/** Run one tool call as the given Session. */
function run(
  name: string,
  agent: Agent,
  id = 'c1',
  args: unknown = {},
  signal: AbortSignal = defaultSignal,
): Promise<ToolExecutionResult> {
  return executeToolFixture(ctx, { callId: brandString<ToolCallId>(id), name, arguments: args, signal, agent })
}

/** The key of the checkout the guard resolved, discovered from the records it wrote. */
async function leaseKey(): Promise<string | undefined> {
  const directories = await readdir(join(home, 'workspaces')).catch(() => [] as string[])
  return directories.find(name => name.startsWith('lease-'))
}

/** Read the lease record the guard wrote, or undefined when no record remains. */
async function record(): Promise<Record<string, unknown> | undefined> {
  const key = await leaseKey()
  if (key === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(await readFile(join(home, 'workspaces', key, 'lease.json'), 'utf8'))
    return parsed as Record<string, unknown>
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Read the queue file's entries, or an empty list when no queue exists. */
async function queueEntries(): Promise<Record<string, unknown>[]> {
  const key = await leaseKey()
  if (key === undefined) return []
  try {
    const parsed = JSON.parse(await readFile(join(home, 'workspaces', key, 'lease-queue.json'), 'utf8')) as {
      entries?: Record<string, unknown>[]
    }
    return parsed.entries ?? []
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/**
 * Wait until the queue holds exactly `depth` entries.
 * @param depth - expected queue depth.
 */
async function waitForQueueDepth(depth: number): Promise<void> {
  await vi.waitFor(async () => {
    expect(await queueEntries()).toHaveLength(depth)
  }, { timeout: 20000, interval: 10 })
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
  entered = []
  running = 0
  maxRunning = 0
  archiveFails = false
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  await rm(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
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

  it('keeps the read-only tools that used to default to write out of the lease', () => {
    for (const name of [
      'read_image', 'job_list', 'job_output', 'cordis_inspect',
      'load_workspace_dependencies', 'get_goal', 'personality_analyze',
    ]) {
      expect(classifyLeaseTool(name, {})).toBe('read')
    }
  })

  it('exempts control-plane writes that never touch checkout content', () => {
    for (const name of ['job_kill', 'create_goal', 'update_goal', 'personality_apply']) {
      expect(classifyLeaseTool(name, {})).toBe('exempt')
    }
  })

  it('classifies action-scoped tools by their action and defaults to write', () => {
    expect(classifyLeaseTool('persona_state', { action: 'show' })).toBe('read')
    expect(classifyLeaseTool('persona_state', { action: 'patch' })).toBe('write')
    expect(classifyLeaseTool('persona_state', {})).toBe('write')
    expect(classifyLeaseTool('plugin_manager', { action: 'list_plugins' })).toBe('read')
    expect(classifyLeaseTool('plugin_manager', { action: 'list_bundles' })).toBe('read')
    expect(classifyLeaseTool('plugin_manager', { action: 'list_version_exemptions' })).toBe('read')
    expect(classifyLeaseTool('plugin_manager', { action: 'install_bundle' })).toBe('exempt')
    expect(classifyLeaseTool('plugin_manager', { action: 'set_plugin' })).toBe('exempt')
    expect(classifyLeaseTool('plugin_manager', { action: 'remove_bundle' })).toBe('exempt')
    expect(classifyLeaseTool('plugin_manager', { action: 'unknown_action' })).toBe('write')
    expect(classifyLeaseTool('plugin_manager', {})).toBe('write')
  })
})

/** Repository root, so the coverage test can read the generated tool catalog. */
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url))

/**
 * Model-visible tool names from the `docs/tool-catalog.md` package map table.
 * That page is generated by booting the shipped tool plugins and is verified
 * fresh by `verify-tool-catalog`, so a tool that lands without a lease decision
 * reaches this list instead of silently taking the write default.
 */
function catalogToolNames(markdown: string): string[] {
  const names = new Set<string>()
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('| `@deepseek-ai/')) continue
    const cell = line.split('|')[2] ?? ''
    for (const match of cell.matchAll(/`([a-z0-9_-]+)`/g)) {
      const name = match[1]
      if (name !== undefined) names.add(name)
    }
  }
  return [...names].sort()
}

/**
 * Registered names this change still classifies as write. Most genuinely mutate
 * a checkout; the read-only entries here (terminal and MCP-resource reads,
 * session and workspace lists, browser inspection) are left at the restrictive
 * default on purpose, so a later change decides them instead of this one. The
 * coverage assertions fail when a name leaves this list without gaining an
 * explicit read or exempt entry.
 */
const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'apply_patch', 'bash', 'edit', 'enter_worktree', 'exit_plan_mode', 'exit_worktree',
  'interrupt_agent', 'list_mcp_resource_templates', 'list_mcp_resources', 'list_session', 'list_workspace',
  'lsp', 'office_convert', 'office_recalculate', 'office_render', 'plugin_market', 'pwsh', 'ralph',
  'read_mcp_resource', 'run_code', 'session_send_message',
  'stagehand_act', 'stagehand_extract', 'stagehand_navigate', 'stagehand_observe', 'stagehand_screenshot', 'stagehand_tabs',
  'str_replace_editor', 'subagent_oar',
  'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  'terminal_close', 'terminal_list', 'terminal_open', 'terminal_read', 'terminal_send', 'terminal_signal',
  'tool-dsh-store', 'user_terminal_list', 'user_terminal_read', 'write',
])

/**
 * Model-visible tools of the installed build that the catalog's tool-package
 * scope does not cover: workspace records, global memory, persona and
 * personality, goals, jobs, and the forked-subagent tool.
 */
const DEPLOYMENT_TOOLS: readonly string[] = [
  'ask_user_question_plus', 'count_tokens',
  'memory_forget', 'memory_search', 'memory_write',
  'persona_state', 'personality_analyze', 'personality_apply',
  'subagent_fork',
  'workspace_artifacts', 'workspace_intents', 'workspace_message', 'workspace_sessions', 'workspace_tasks',
]

/** Names that reached the classification without a decision. */
function undecidedLeaseTools(names: readonly string[]): string[] {
  return names.filter(name => !hasExplicitLeaseClass(name) && !WRITE_TOOLS.has(name))
}

describe('lease classification coverage', () => {
  it('gives every tool the generated catalog registers an explicit class', async () => {
    const catalog = await readFile(join(repositoryRoot, 'docs', 'tool-catalog.md'), 'utf8')
    const names = catalogToolNames(catalog)
    expect(names.length).toBeGreaterThan(60)
    expect(undecidedLeaseTools(names)).toEqual([])
  })

  it('gives every tool this build exposes an explicit class', () => {
    expect(undecidedLeaseTools(DEPLOYMENT_TOOLS)).toEqual([])
  })
})

describe('tool-level acquisition and release', () => {
  it('holds the lease only while the tool body runs', async () => {
    await mount()
    expect((await run('write', agentOf('s1'))).isError).toBe(false)
    expect(entered).toEqual(['s1'])
    expect(await record()).toBeUndefined()
    const events = (await auditLines()).map(line => line.event)
    expect(events).toEqual(['acquired', 'released'])
    const released = (await auditLines()).find(line => line.event === 'released')
    expect(released).toMatchObject({ sessionId: 's1', operation: 'tool end', generation: 1 })
  })

  it('makes the second Session wait in the queue instead of refusing it', async () => {
    await mount()
    holdBody('s1')
    const first = run('write', agentOf('s1'), 'c1')
    await waitForEnter(1)
    expect(await record()).toMatchObject({ sessionId: 's1' })

    const second = run('write', agentOf('s2'), 'c2')
    await waitForQueueDepth(1)
    expect(entered).toEqual(['s1'])

    releaseBody('s1')
    expect((await first).isError).toBe(false)
    expect((await second).isError).toBe(false)
    expect(entered).toEqual(['s1', 's2'])
    expect(maxRunning).toBe(1)
    const lines = await auditLines()
    expect(lines.filter(line => line.event === 'denied')).toEqual([])
    expect(lines.filter(line => line.event === 'queued')[0]).toMatchObject({ sessionId: 's2', position: 1 })
    const acquired = lines.filter(line => line.event === 'acquired')
    expect(acquired.at(-1)).toMatchObject({ sessionId: 's2' })
    expect(acquired.at(-1)?.['waitMs']).toBeTypeOf('number')
  })

  it('never makes a read wait for a writer', async () => {
    await mount()
    holdBody('s1')
    const first = run('write', agentOf('s1'), 'c1')
    await waitForEnter(1)
    const read = await run('read', agentOf('s2'), 'c2')
    expect(read.isError).toBe(false)
    releaseBody('s1')
    await first
    expect(await auditLines()).toHaveLength(2)
  })

  it('refuses with WORKSPACE_LEASE_HELD when queueing is off', async () => {
    await mount({ queueTimeoutMs: 0 })
    holdBody('s1')
    const first = run('write', agentOf('s1'), 'c1')
    await waitForEnter(1)
    const refused = await run('write', agentOf('s2'), 'c2')
    expect(refused.isError).toBe(true)
    expect(refused.error?.info?.code).toBe(WORKSPACE_LEASE_HELD)
    const text = refused.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    expect(text).toContain('WORKSPACE_LEASE_HELD')
    expect(text).toContain('holder:     session s1')
    releaseBody('s1')
    await first
    expect(entered).toEqual(['s1'])
  })

  it('observe mode audits the conflict and runs the write', async () => {
    await mount({ mode: 'observe' })
    holdBody('s1')
    const first = run('write', agentOf('s1'), 'c1')
    await waitForEnter(1)
    expect((await run('write', agentOf('s2'), 'c2')).isError).toBe(false)
    expect((await auditLines()).filter(line => line.event === 'denied')[0]).toMatchObject({
      result: 'observe', holder: 's1',
    })
    releaseBody('s1')
    await first
  })
})

describe('FIFO queue order', () => {
  it('grants eight concurrent Sessions in arrival order with no refusal', { timeout: 20_000 }, async () => {
    await mount()
    holdBody('s1')
    const calls = [run('write', agentOf('s1'), 'c1', { file: 's1.txt' })]
    await waitForEnter(1)
    for (let index = 2; index <= 8; index += 1) {
      const sessionId = `s${String(index)}`
      calls.push(run('write', agentOf(sessionId), `c${String(index)}`, { file: `${sessionId}.txt` }))
      await waitForQueueDepth(index - 1)
    }
    expect(await queueEntries()).toHaveLength(7)

    releaseBody('s1')
    const results = await Promise.all(calls)
    expect(results.map(result => result.isError)).toEqual([false, false, false, false, false, false, false, false])
    expect(entered).toEqual(['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'])
    expect(maxRunning).toBe(1)
    for (let index = 1; index <= 8; index += 1) {
      expect(await readFile(join(project, `s${String(index)}.txt`), 'utf8')).toBe(`s${String(index)}`)
    }
    const lines = await auditLines()
    expect(lines.filter(line => line.event === 'denied')).toEqual([])
    expect(lines.filter(line => line.event === 'acquired').map(line => line.sessionId))
      .toEqual(['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'])
    expect(await record()).toBeUndefined()
    expect(await queueEntries()).toEqual([])
  })

  it('serializes concurrent pwsh calls one body at a time in arrival order', { timeout: 20_000 }, async () => {
    await mount()
    holdBody('s1')
    const calls = [run('pwsh', agentOf('s1'), 'c1', { file: 's1.sh' })]
    await waitForEnter(1)
    for (let index = 2; index <= 4; index += 1) {
      const sessionId = `s${String(index)}`
      calls.push(run('pwsh', agentOf(sessionId), `c${String(index)}`, { file: `${sessionId}.sh` }))
      await waitForQueueDepth(index - 1)
    }
    releaseBody('s1')
    await Promise.all(calls)
    expect(entered).toEqual(['s1', 's2', 's3', 's4'])
    expect(maxRunning).toBe(1)
    const lines = await auditLines()
    expect(lines.filter(line => line.event === 'denied')).toEqual([])
    expect(lines.filter(line => line.event === 'acquired').map(line => line.operation))
      .toEqual(['pwsh', 'pwsh', 'pwsh', 'pwsh'])
  })
})

describe('wait timeout, cancellation, and recovery', () => {
  it('fails with WORKSPACE_LEASE_QUEUE_TIMEOUT and leaves the queue', { timeout: 20_000 }, async () => {
    await mount({ queueTimeoutMs: 300, pollMs: 20 })
    holdBody('s1')
    const first = run('write', agentOf('s1'), 'c1')
    await waitForEnter(1)
    const refused = await run('write', agentOf('s2'), 'c2')
    expect(refused.isError).toBe(true)
    expect(refused.error?.info?.code).toBe(WORKSPACE_LEASE_QUEUE_TIMEOUT)
    const info = refused.error?.info as unknown as Record<string, unknown>
    expect(Number(info.waitMs)).toBeGreaterThanOrEqual(300)
    expect(info.queuePosition).toBe(1)
    const text = refused.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    expect(text).toContain('WORKSPACE_LEASE_QUEUE_TIMEOUT')
    expect(text).toContain('did not run and left the queue')
    expect(await queueEntries()).toEqual([])
    expect((await auditLines()).filter(line => line.event === 'queue_timeout')).toHaveLength(1)
    expect(entered).toEqual(['s1'])

    // The queue is empty again: the next call takes the lease as soon as the
    // holder releases it, with no stale entry in front.
    releaseBody('s1')
    await first
    expect((await run('write', agentOf('s3'), 'c3')).isError).toBe(false)
    expect(entered).toEqual(['s1', 's3'])
  })

  it('lets a cancelled waiter leave the queue so the next call proceeds', { timeout: 20_000 }, async () => {
    await mount({ queueTimeoutMs: 5000, pollMs: 25 })
    holdBody('s1')
    const first = run('write', agentOf('s1'), 'c1')
    await waitForEnter(1)
    const cancelled = new AbortController()
    const waiting = run('write', agentOf('s2'), 'c2', {}, cancelled.signal)
    await waitForQueueDepth(1)
    cancelled.abort(new Error('turn cancelled'))
    const settled = await waiting.then(
      value => value,
      () => ({ isError: true }) as ToolExecutionResult,
    )
    expect(settled.isError).toBe(true)
    expect((await auditLines()).filter(line => line.event === 'queue_cancelled')).toHaveLength(1)
    expect(await queueEntries()).toEqual([])

    const next = run('write', agentOf('s3'), 'c3')
    await waitForQueueDepth(1)
    releaseBody('s1')
    await first
    expect((await next).isError).toBe(false)
    expect(entered).toEqual(['s1', 's3'])
  })

  it('takes a queued Session out of the queue when its turn ends', { timeout: 20_000 }, async () => {
    await mount({ queueTimeoutMs: 5000, pollMs: 25 })
    holdBody('s1')
    const first = run('write', agentOf('s1'), 'c1')
    await waitForEnter(1)
    const cancelled = new AbortController()
    const waiting = run('write', agentOf('s2'), 'c2', {}, cancelled.signal)
    await waitForQueueDepth(1)

    ctx.emit('session/event', sessionOf('s2'), {
      type: 'turn/end', seq: 0, time: Date.now(), data: { turn: 1, reason: { kind: 'cancelled' } },
    } as never)
    await vi.waitFor(async () => { expect(await queueEntries()).toEqual([]) }, { timeout: 10000, interval: 10 })

    cancelled.abort(new Error('turn ended'))
    const settled = await waiting.then(
      value => value,
      () => ({ isError: true }) as ToolExecutionResult,
    )
    expect(settled.isError).toBe(true)
    releaseBody('s1')
    await first
    expect(entered).toEqual(['s1'])
  })

  it('re-enters the lease for a parallel call of the same Session', async () => {
    await mount()
    holdBody('s1')
    const first = run('write', agentOf('s1'), 'c1')
    await waitForEnter(1)
    const second = run('write', agentOf('s1'), 'c2')
    await waitForEnter(2)
    expect(await queueEntries()).toEqual([])
    expect(await record()).toMatchObject({ sessionId: 's1', generation: 1 })
    releaseBody('s1')
    expect((await first).isError).toBe(false)
    expect((await second).isError).toBe(false)
    expect(await record()).toBeUndefined()
    expect((await auditLines()).filter(line => line.event === 'acquired')).toHaveLength(1)
  })

  it('reclaims the lease of a dead holder instead of waiting for it', async () => {
    const deadPid = await exitedPid()
    await mount()
    const deceased = createWorkspaceLeaseGuard(ctx, {
      home, hostId: 'test-host', pid: deadPid, idleMs: LEASE_IDLE_MS,
    })
    expect(await deceased.beforeTool({ name: 'write', arguments: {}, agent: agentOf('s1') })).toEqual({ held: true })
    expect(await record()).toMatchObject({ sessionId: 's1', pid: deadPid, generation: 1 })

    expect((await run('write', agentOf('s2'), 'c2')).isError).toBe(false)
    expect(entered).toEqual(['s2'])
    expect(await record()).toBeUndefined()
    const reclaimed = (await auditLines()).filter(line => line.event === 'reclaimed').at(-1)
    expect(reclaimed).toMatchObject({ sessionId: 's2', holder: 's1', generation: 2 })
  })

  it('drops a queue entry left by a dead process', async () => {
    const deadPid = await exitedPid()
    await mount()
    // One write before the queue exists, so the guard resolves the checkout key.
    await run('write', agentOf('s0'), 'c0')
    const key = await leaseKey()
    if (key === undefined) throw new Error('expected a lease directory')
    const now = new Date().toISOString()
    await writeFile(join(home, 'workspaces', key, 'lease-queue.json'), `${JSON.stringify({
      version: 1,
      nextSeq: 2,
      entries: [{
        seq: 1, sessionId: 'ghost', operation: 'write', pid: deadPid, hostId: 'test-host',
        enqueuedAt: now, heartbeatAt: now,
      }],
    })}\n`, 'utf8')

    expect((await run('write', agentOf('s2'), 'c2')).isError).toBe(false)
    expect(entered).toEqual(['s0', 's2'])
    expect(await queueEntries()).toEqual([])
  })

  it('waits behind a version-1 record written by the previous build', async () => {
    await mount({ queueTimeoutMs: 150, pollMs: 20 })
    // A record with exactly the fields the turn-level build wrote: no queue,
    // no call id, just the durable v1 lease record.
    await run('write', agentOf('s0'), 'c0')
    const key = await leaseKey()
    if (key === undefined) throw new Error('expected a lease directory')
    const now = Date.now()
    await writeFile(join(home, 'workspaces', key, 'lease.json'), `${JSON.stringify({
      version: 1,
      root: project,
      sessionId: 'legacy',
      generation: 7,
      acquiredAt: new Date(now).toISOString(),
      renewedAt: new Date(now).toISOString(),
      lastOperation: 'edit',
      idleExpiresAt: new Date(now + 60_000).toISOString(),
      maxExpiresAt: new Date(now + LEASE_MAX_MS).toISOString(),
      hostId: 'test-host',
      pid: 4242,
    }, undefined, 2)}\n`, 'utf8')
    const before = JSON.parse(await readFile(join(home, 'workspaces', key, 'lease.json'), 'utf8')) as Record<string, unknown>

    const refused = await run('write', agentOf('s2'), 'c2')
    expect(refused.isError).toBe(true)
    expect(refused.error?.info?.code).toBe(WORKSPACE_LEASE_QUEUE_TIMEOUT)
    // A live holder keeps the record: the wait ends with a refusal, and the
    // record the previous build wrote is read and left untouched.
    expect(JSON.parse(await readFile(join(home, 'workspaces', key, 'lease.json'), 'utf8'))).toEqual(before)
  })
})

describe('turn end, disposal, and archive release', () => {
  it('releases on turn end through the production listener', async () => {
    await mount()
    holdBody('s1')
    const call = run('write', agentOf('s1'), 'c1')
    await waitForEnter(1)
    ctx.emit('session/event', sessionOf('s1'), {
      type: 'turn/end', seq: 0, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } },
    } as never)
    await vi.waitFor(async () => { expect(await record()).toBeUndefined() }, { timeout: 10000, interval: 10 })
    const released = (await auditLines()).filter(line => line.event === 'released')
    expect(released.at(-1)).toMatchObject({ sessionId: 's1', operation: 'turn end' })
    releaseBody('s1')
    await call
  })

  it('releases on agent disposal', async () => {
    await mount()
    holdBody('s1')
    const call = run('write', agentOf('s1'), 'c1')
    await waitForEnter(1)
    ctx.emit('agent/disposed', { agent: agentOf('s1') } as never)
    await vi.waitFor(async () => { expect(await record()).toBeUndefined() }, { timeout: 10000, interval: 10 })
    const released = (await auditLines()).filter(line => line.event === 'released')
    expect(released.at(-1)).toMatchObject({ sessionId: 's1', operation: 'session disposed' })
    releaseBody('s1')
    await call
  })

  it('releases the archived Session lease and audits the operation', async () => {
    await mount()
    holdBody('s1')
    const call = run('write', agentOf('s1'), 'c1')
    await waitForEnter(1)
    const archived = await run('workspace_sessions', agentOf('s2'), 'c2', { action: 'archive', sessionId: 's1' })
    expect(archived.isError).toBe(false)
    expect(await record()).toBeUndefined()
    const released = (await auditLines()).filter(line => line.event === 'released')
    expect(released.at(-1)).toMatchObject({ sessionId: 's1', operation: 'session archived' })
    releaseBody('s1')
    await call
  })

  it('does not release when the archive call itself failed', async () => {
    await mount()
    holdBody('s1')
    const call = run('write', agentOf('s1'), 'c1')
    await waitForEnter(1)
    archiveFails = true
    const archived = await run('workspace_sessions', agentOf('s2'), 'c2', { action: 'archive', sessionId: 's1' })
    expect(archived.isError).toBe(true)
    expect(await record()).toMatchObject({ sessionId: 's1' })
    expect((await auditLines()).filter(line => line.event === 'released')).toEqual([])
    releaseBody('s1')
    await call
  })
})

describe('fencing after a lost record', () => {
  it('refuses a Session whose open call lost the record to another Session', async () => {
    await mount()
    holdBody('s1')
    const call = run('write', agentOf('s1'), 'c1')
    await waitForEnter(1)
    const key = await leaseKey()
    if (key === undefined) throw new Error('expected a lease directory')
    // Another Session's record replaces the open one, as a reclaim after the
    // maximum life would.
    const now = Date.now()
    await writeFile(join(home, 'workspaces', key, 'lease.json'), `${JSON.stringify({
      version: 1,
      root: project,
      sessionId: 's2',
      generation: 9,
      acquiredAt: new Date(now).toISOString(),
      renewedAt: new Date(now).toISOString(),
      lastOperation: 'edit',
      idleExpiresAt: new Date(now + 60_000).toISOString(),
      maxExpiresAt: new Date(now + LEASE_MAX_MS).toISOString(),
      hostId: 'test-host',
      pid: 4242,
    })}\n`, 'utf8')

    const lost = await run('write', agentOf('s1'), 'c2')
    expect(lost.isError).toBe(true)
    expect(lost.error?.info?.code).toBe(WORKSPACE_LEASE_LOST)
    const text = lost.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    expect(text).toContain('WORKSPACE_LEASE_LOST')
    expect(text).toContain('holder:     session s2')
    expect(text).toContain('retry once after that moment')
    releaseBody('s1')
    await call
  })
})
