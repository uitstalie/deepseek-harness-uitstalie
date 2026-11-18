/**
 * Session lifecycle of the workspace toolset: every action of `workspace_sessions`
 * beyond `list`/`get` runs through a real tool call against a recording Session
 * controller stub and the real workspace registry.
 *
 * The stub covers the host verbs the toolset duck-types (`create`, `prompt`,
 * `list`, `cancel`, `selectModel`, `rename`, `resolveAgent`, `fork`, `delete`);
 * the toolset itself owns the target selection, role refusal, and delivery
 * fallback rules asserted here.
 */
import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  callTool,
  createRoot,
  mountWorkspaceTools,
  registerWorkspace,
  textOf,
  valueOf,
} from './harness.ts'
import type { TestWorkspace, TestWorkspaceRegistry, WorkspaceToolsHarness } from './harness.ts'

/** One prompt the recording controller received. */
interface RecordedPrompt {
  readonly requestId: string
  readonly sessionId: string
  readonly mode: 'queue' | 'steer'
  readonly text: string
}

/** One Session row the stub reports. */
interface RecordedSession {
  readonly sessionId: string
  running: boolean
  readonly cwd: string
  readonly parentSessionId?: unknown
  readonly origin?: string
  readonly blank?: boolean
  readonly updatedAt: number
}

/** Which host verbs the recording controller exposes. */
interface ControllerOptions {
  /** Expose the optional hard cancel. */
  readonly cancel?: boolean
  /** Expose the optional model selection. */
  readonly selectModel?: boolean
  /** Expose the optional title rename. */
  readonly rename?: boolean
  /** Expose the optional Agent resolution. */
  readonly resolveAgent?: boolean
  /** Expose the optional fork. */
  readonly fork?: boolean
  /** Expose the optional hard delete; omitted mirrors current hosts. */
  readonly deleteApi?: boolean
}

/** A recording stand-in for the host Session controller. */
class RecordingController {
  /** Every create request, in call order. */
  readonly created: { readonly workspaceId?: string }[] = []
  /** Every admitted prompt, in call order. */
  readonly prompts: RecordedPrompt[] = []
  /** Every cancelled Session, in call order. */
  readonly cancelled: string[] = []
  /** Every model selection, in call order. */
  readonly selected: {
    readonly sessionId: string
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string
  }[] = []
  /** Every renamed Session, in call order. */
  readonly renamed: { readonly sessionId: string; readonly title: string }[] = []
  /** Every fork request, in call order. */
  readonly forked: { readonly sessionId: string; readonly atSeq?: number }[] = []
  /** Every deleted Session, in call order. */
  readonly deleted: string[] = []

  private readonly sessions: RecordedSession[] = []
  private counter = 0

  /**
   * @param registry - the mounted workspace registry, so a created Session is attached.
   * @param options - which optional verbs this deployment exposes.
   */
  constructor(
    private readonly registry: TestWorkspaceRegistry,
  ) {}

  /** Create one Session attached to the requested workspace. */
  async create(request: { readonly workspaceId?: string }): Promise<{ readonly sessionId: string }> {
    this.created.push(request)
    this.counter += 1
    const sessionId = `session-${String(this.counter)}`
    const workspace = this.workspaceOf(request.workspaceId)
    if (workspace !== undefined) await workspace.attachSession(SessionId(sessionId))
    this.sessions.push({
      sessionId,
      running: true,
      cwd: workspace?.path ?? '',
      updatedAt: Date.now() + this.counter,
    })
    return { sessionId }
  }

  /** Admit one prompt and record its exact text and mode. */
  async prompt(request: {
    readonly requestId: string
    readonly sessionId: string
    readonly mode: 'queue' | 'steer'
    readonly content: readonly { readonly type: 'text'; readonly text: string }[]
  }): Promise<{ readonly accepted: boolean }> {
    this.prompts.push({
      requestId: request.requestId,
      sessionId: request.sessionId,
      mode: request.mode,
      text: request.content.map(part => part.type === 'text' ? part.text : '').join(''),
    })
    return { accepted: true }
  }

  /** Report every Session row. */
  async list(): Promise<{ readonly items: readonly RecordedSession[] }> {
    return {
      items: this.sessions.map(session => ({ ...session })),
    }
  }

  /** Stop one Session's running turn. */
  async cancel(request: { readonly sessionId: string }): Promise<{ readonly accepted: boolean }> {
    this.cancelled.push(request.sessionId)
    this.rowOf(request.sessionId).running = false
    return { accepted: true }
  }

  /** Record one model selection. */
  async selectModel(request: {
    readonly sessionId: string
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string
  }): Promise<{ readonly selected: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string } }> {
    this.selected.push(request)
    return {
      selected: {
        provider: request.provider,
        model: request.model,
        ...request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort },
      },
    }
  }

  /** Record one durable title. */
  async rename(request: { readonly sessionId: string; readonly title: string }): Promise<{ readonly title: string }> {
    this.renamed.push(request)
    return { title: request.title }
  }

  /** Resolve a fake Agent so compaction can reach its seam. */
  async resolveAgent(sessionId: string): Promise<{ readonly agent: unknown }> {
    return { agent: { session: { sessionId }, ctx: {} } }
  }

  /** Branch one Session into a new row in the same directory. */
  async fork(request: { readonly sessionId: string; readonly atSeq?: number }): Promise<{ readonly sessionId: string }> {
    this.forked.push(request)
    this.counter += 1
    const source = this.rowOf(request.sessionId)
    const sessionId = `session-${String(this.counter)}`
    this.sessions.push({
      sessionId,
      running: false,
      cwd: source.cwd,
      updatedAt: Date.now() + this.counter,
    })
    const workspace = this.registry.list().find(candidate => candidate.sessionIds.some(id => String(id) === request.sessionId))
    if (workspace !== undefined) await workspace.attachSession(SessionId(sessionId))
    return { sessionId }
  }

  /** Delete one stored Session row. */
  async delete(sessionId: string): Promise<void> {
    this.deleted.push(sessionId)
    const index = this.sessions.findIndex(session => session.sessionId === sessionId)
    if (index >= 0) this.sessions.splice(index, 1)
  }

  /** The Session row for one id; the specs only name Sessions they created. */
  private rowOf(sessionId: string): RecordedSession {
    const row = this.sessions.find(session => session.sessionId === sessionId)
    if (row === undefined) throw new Error(`the spec named unknown session ${sessionId}`)
    return row
  }

  /** Resolve a workspace id against the mounted registry. */
  private workspaceOf(workspaceId: string | undefined): TestWorkspace | undefined {
    return this.registry.list().find(candidate => String(candidate.id) === workspaceId) as TestWorkspace | undefined
  }
}

/** Expose the stub as the duck-typed `sessionController` service. */
function installController(
  mounted: WorkspaceToolsHarness,
  options: ControllerOptions = {},
): RecordingController {
  const resolved: Required<ControllerOptions> = {
    cancel: options.cancel ?? true,
    selectModel: options.selectModel ?? true,
    rename: options.rename ?? true,
    resolveAgent: options.resolveAgent ?? true,
    fork: options.fork ?? true,
    deleteApi: options.deleteApi ?? false,
  }
  const controller = new RecordingController(mounted.registry)
  const service: Record<string, unknown> = {
    create: controller.create.bind(controller),
    prompt: controller.prompt.bind(controller),
    list: controller.list.bind(controller),
  }
  if (resolved.cancel) service['cancel'] = controller.cancel.bind(controller)
  if (resolved.selectModel) service['selectModel'] = controller.selectModel.bind(controller)
  if (resolved.rename) service['rename'] = controller.rename.bind(controller)
  if (resolved.resolveAgent) service['resolveAgent'] = controller.resolveAgent.bind(controller)
  if (resolved.fork) service['fork'] = controller.fork.bind(controller)
  if (resolved.deleteApi) service['delete'] = controller.delete.bind(controller)
  mounted.ctx.provide('sessionController' as never, service as never)
  return controller
}

/** Expose a manual compaction engine that reports 12 shadowed tokens. */
function installCompaction(mounted: WorkspaceToolsHarness, pressure: { value: number }): void {
  mounted.ctx.provide('tokenMeter' as never, {
    contextPressure: () => ({ pressureTokens: pressure.value, contextWindow: 1000 }),
  } as never)
  mounted.ctx.provide('compaction' as never, {
    compactNow: async () => {
      pressure.value = 100
      return { shadowedTokenCount: 12 }
    },
  } as never)
}

let projectA: string
let projectB: string
let home: string
let contexts: Context[]
let mounted: WorkspaceToolsHarness
let workspaceA: TestWorkspace
let workspaceB: TestWorkspace
let superAgent: Awaited<ReturnType<typeof createRoot>>
let ordinaryAgent: Awaited<ReturnType<typeof createRoot>>

beforeEach(async () => {
  projectA = await mkdtemp(join(tmpdir(), 'dsh-session-lifecycle-a-'))
  projectB = await mkdtemp(join(tmpdir(), 'dsh-session-lifecycle-b-'))
  home = await mkdtemp(join(tmpdir(), 'dsh-session-lifecycle-home-'))
  await mkdir(join(projectA, '.git'), { recursive: true })
  await mkdir(join(projectB, '.git'), { recursive: true })
  contexts = []
  const ctx = new Context()
  contexts.push(ctx)
  mounted = await mountWorkspaceTools(ctx, home)
  workspaceA = await registerWorkspace(mounted.registry, projectA, 'lifecycle-a')
  workspaceB = await registerWorkspace(mounted.registry, projectB, 'lifecycle-b')
  superAgent = await createRoot(mounted, 'lifecycle-super', projectA, 'super')
  ordinaryAgent = await createRoot(mounted, 'lifecycle-ordinary', projectA)
  await workspaceA.attachSession(superAgent.session.id)
  await workspaceA.attachSession(ordinaryAgent.session.id)
})

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await rm(projectA, { recursive: true, force: true })
  await rm(projectB, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

test('start opens a Session in another workspace and append/prompt deliver into it', async () => {
  const controller = installController(mounted)

  const started = await callTool(mounted.ctx, superAgent, 'workspace_sessions', {
    action: 'start',
    workspace: String(workspaceB.id),
    task: 'review the branch',
    title: 'code review',
    provider: 'stub',
    model: 'stub-1',
    reasoning_effort: 'high',
  })
  expect(started.isError).toBe(false)
  type StartView = {
    started: { sessionId: string; workspace: string; cwd: string; title: string; titleRecorded: boolean; admitted: boolean }
  }
  const start = (valueOf(started) as StartView).started
  expect(start.workspace).toBe(String(workspaceB.id))
  expect(start.cwd).toBe(workspaceB.path)
  expect(start.title).toBe('code review')
  expect(start.titleRecorded).toBe(true)
  expect(start.admitted).toBe(true)
  expect(controller.created).toEqual([{ workspaceId: String(workspaceB.id) }])
  expect(controller.renamed).toEqual([{ sessionId: start.sessionId, title: 'code review' }])
  expect(controller.selected).toEqual([{
    sessionId: start.sessionId,
    provider: 'stub',
    model: 'stub-1',
    reasoningEffort: 'high',
  }])
  expect(controller.prompts).toHaveLength(1)
  expect(controller.prompts[0]).toMatchObject({
    sessionId: start.sessionId,
    mode: 'queue',
    text: 'review the branch',
  })
  expect(String(workspaceB.sessionIds.at(-1))).toBe(start.sessionId)

  const appended = await callTool(mounted.ctx, superAgent, 'workspace_sessions', {
    action: 'append',
    workspace: String(workspaceB.id),
    session: start.sessionId,
    text: 'also check the tests',
    delivery: 'interrupt',
  })
  expect(appended.isError).toBe(false)
  type DeliveryView = {
    delivery: { sessionId: string; requested: string; used: string; accepted: boolean; wasRunning: boolean }
  }
  expect((valueOf(appended) as DeliveryView).delivery).toEqual({
    sessionId: start.sessionId,
    requested: 'interrupt',
    used: 'interrupt',
    accepted: true,
    wasRunning: true,
  })
  expect(controller.prompts[1]).toMatchObject({ sessionId: start.sessionId, mode: 'steer', text: 'also check the tests' })

  const prompted = await callTool(mounted.ctx, superAgent, 'workspace_sessions', {
    action: 'prompt',
    workspace: String(workspaceB.id),
    sessionId: start.sessionId,
    text: 'one clarification',
  })
  expect(prompted.isError).toBe(false)
  expect((valueOf(prompted) as DeliveryView).delivery).toMatchObject({
    sessionId: start.sessionId,
    requested: 'queue',
    used: 'queue',
    accepted: true,
  })

  const latest = await callTool(mounted.ctx, superAgent, 'workspace_sessions', {
    action: 'append',
    workspace: String(workspaceB.id),
    session: 'latest',
    text: 'continue from the latest Session',
  })
  expect(latest.isError).toBe(false)
  expect((valueOf(latest) as DeliveryView).delivery.sessionId).toBe(start.sessionId)
  expect(controller.prompts).toHaveLength(4)
})

test('append refuses to guess when the workspace has more than one Session', async () => {
  installController(mounted)
  const first = await callTool(mounted.ctx, superAgent, 'workspace_sessions', {
    action: 'start', workspace: String(workspaceB.id), task: 'first task', title: 'first',
  })
  const second = await callTool(mounted.ctx, superAgent, 'workspace_sessions', {
    action: 'start', workspace: String(workspaceB.id), task: 'second task', title: 'second',
  })
  expect(first.isError).toBe(false)
  expect(second.isError).toBe(false)

  const ambiguous = await callTool(mounted.ctx, superAgent, 'workspace_sessions', {
    action: 'append', workspace: String(workspaceB.id), text: 'which one?',
  })
  expect(ambiguous.isError).toBe(true)
  expect(textOf(ambiguous)).toContain('requires session')
  expect(textOf(ambiguous)).toContain('latest')
})

test('stop cancels a running turn and admits no text', async () => {
  const controller = installController(mounted)
  const started = await callTool(mounted.ctx, superAgent, 'workspace_sessions', {
    action: 'start', workspace: String(workspaceB.id), task: 'long task', title: 'long task',
  })
  const sessionId = (valueOf(started) as { started: { sessionId: string } }).started.sessionId
  expect(controller.prompts).toHaveLength(1)

  const stopped = await callTool(mounted.ctx, superAgent, 'workspace_sessions', {
    action: 'stop', workspace: String(workspaceB.id), sessionId,
  })
  expect(stopped.isError).toBe(false)
  type StopView = { stopped: { sessionId: string; accepted: boolean; wasRunning: boolean; alreadyIdle?: boolean; cancelledVia?: string } }
  expect((valueOf(stopped) as StopView).stopped).toEqual({
    sessionId,
    accepted: true,
    wasRunning: true,
    cancelledVia: 'controller',
  })
  expect(controller.cancelled).toEqual([sessionId])
  expect(controller.prompts).toHaveLength(1)

  const idle = await callTool(mounted.ctx, superAgent, 'workspace_sessions', {
    action: 'stop', workspace: String(workspaceB.id), sessionId,
  })
  expect(idle.isError).toBe(false)
  expect((valueOf(idle) as StopView).stopped).toMatchObject({ accepted: false, wasRunning: false, alreadyIdle: true })
  expect(controller.cancelled).toEqual([sessionId])
})

test('abort cancels the running turn and then delivers the follow-up text', async () => {
  const controller = installController(mounted)
  const started = await callTool(mounted.ctx, superAgent, 'workspace_sessions', {
    action: 'start', workspace: String(workspaceB.id), task: 'start the work', title: 'abort target',
  })
  const sessionId = (valueOf(started) as { started: { sessionId: string } }).started.sessionId

  const aborted = await callTool(mounted.ctx, superAgent, 'workspace_sessions', {
    action: 'abort', workspace: String(workspaceB.id), sessionId, text: 'change direction',
  })
  expect(aborted.isError).toBe(false)
  type AbortView = {
    aborted: { sessionId: string; accepted: boolean; resumed: boolean }
    delivery: { sessionId: string; requested: string; used: string; accepted: boolean; wasRunning: boolean }
  }
  const value = valueOf(aborted) as AbortView
  expect(value.aborted).toEqual({ sessionId, accepted: true, resumed: true })
  expect(value.delivery).toEqual({
    sessionId,
    requested: 'queue',
    used: 'queue',
    accepted: true,
    wasRunning: false,
  })
  expect(controller.cancelled).toEqual([sessionId])
  expect(controller.prompts).toHaveLength(2)
  expect(controller.prompts[1]).toMatchObject({ sessionId, mode: 'queue', text: 'change direction' })

  const idle = await callTool(mounted.ctx, superAgent, 'workspace_sessions', {
    action: 'abort', workspace: String(workspaceB.id), sessionId, text: 'too late',
  })
  expect(idle.isError).toBe(true)
  expect(textOf(idle)).toContain('idle')
  expect(controller.prompts).toHaveLength(2)
})

test('fork, archive, compact, and delete each run through the host', async () => {
  const controller = installController(mounted, { deleteApi: true })
  const pressure = { value: 300 }
  installCompaction(mounted, pressure)
  const started = await callTool(mounted.ctx, superAgent, 'workspace_sessions', {
    action: 'start', workspace: String(workspaceB.id), task: 'branch me', title: 'branch source',
  })
  const sessionId = (valueOf(started) as { started: { sessionId: string } }).started.sessionId

  const forked = await callTool(mounted.ctx, superAgent, 'workspace_sessions', {
    action: 'fork', workspace: String(workspaceB.id), sessionId, atSeq: 4,
  })
  expect(forked.isError).toBe(false)
  type ForkView = { forked: { sessionId: string; forkedFrom: string; atSeq?: number } }
  const fork = (valueOf(forked) as ForkView).forked
  expect(fork.forkedFrom).toBe(sessionId)
  expect(fork.sessionId).not.toBe(sessionId)
  expect(fork.atSeq).toBe(4)
  expect(controller.forked).toEqual([{ sessionId, atSeq: 4 }])

  const archived = await callTool(mounted.ctx, superAgent, 'workspace_sessions', {
    action: 'archive', workspace: String(workspaceB.id), sessionId,
  })
  expect(archived.isError).toBe(false)
  expect((valueOf(archived) as { archived: { sessionId: string; archived: boolean } }).archived).toEqual({
    sessionId,
    archived: true,
  })
  expect(mounted.registry.archivedSessionIds.map(id => String(id))).toContain(sessionId)

  const compacted = await callTool(mounted.ctx, superAgent, 'workspace_sessions', {
    action: 'compact', workspace: String(workspaceB.id), sessionId,
  })
  expect(compacted.isError).toBe(false)
  type CompactView = {
    compacted: {
      sessionId: string
      compacted: boolean
      shadowedTokens?: number
      before?: { percent?: number }
      after?: { percent?: number }
    }
  }
  expect((valueOf(compacted) as CompactView).compacted).toMatchObject({
    sessionId,
    compacted: true,
    shadowedTokens: 12,
    before: { percent: 30 },
    after: { percent: 10 },
  })

  const deleted = await callTool(mounted.ctx, superAgent, 'workspace_sessions', {
    action: 'delete', workspace: String(workspaceB.id), sessionId, confirm: sessionId,
  })
  expect(deleted.isError).toBe(false)
  expect((valueOf(deleted) as { deleted: { sessionId: string; deleted: boolean } }).deleted).toEqual({
    sessionId,
    deleted: true,
  })
  expect(controller.deleted).toEqual([sessionId])
})

test('delete refuses a mismatched confirm and a host without a delete API', async () => {
  const controller = installController(mounted)
  const started = await callTool(mounted.ctx, superAgent, 'workspace_sessions', {
    action: 'start', workspace: String(workspaceB.id), task: 'keep me', title: 'keep me',
  })
  const sessionId = (valueOf(started) as { started: { sessionId: string } }).started.sessionId

  const mismatch = await callTool(mounted.ctx, superAgent, 'workspace_sessions', {
    action: 'delete', workspace: String(workspaceB.id), sessionId, confirm: 'session-other',
  })
  expect(mismatch.isError).toBe(true)
  expect(textOf(mismatch)).toContain('confirm')

  const unavailable = await callTool(mounted.ctx, superAgent, 'workspace_sessions', {
    action: 'delete', workspace: String(workspaceB.id), sessionId, confirm: sessionId,
  })
  expect(unavailable.isError).toBe(true)
  expect(textOf(unavailable)).toContain('no Session delete API')
  expect(controller.deleted).toEqual([])
})

test('an ordinary agent writes Sessions in its own workspace but not in another one', async () => {
  const controller = installController(mounted)
  const start = await callTool(mounted.ctx, superAgent, 'workspace_sessions', {
    action: 'start', workspace: String(workspaceB.id), task: 'started by the super agent', title: 'super session',
  })
  const sessionId = (valueOf(start) as { started: { sessionId: string } }).started.sessionId

  const attempts: Record<string, Record<string, unknown>> = {
    start: { action: 'start', workspace: String(workspaceB.id), task: 'task', title: 'title' },
    append: { action: 'append', workspace: String(workspaceB.id), session: sessionId, text: 'text' },
    prompt: { action: 'prompt', workspace: String(workspaceB.id), sessionId, text: 'text' },
    stop: { action: 'stop', workspace: String(workspaceB.id), sessionId },
    abort: { action: 'abort', workspace: String(workspaceB.id), sessionId, text: 'text' },
    fork: { action: 'fork', workspace: String(workspaceB.id), sessionId },
    archive: { action: 'archive', workspace: String(workspaceB.id), sessionId },
    compact: { action: 'compact', workspace: String(workspaceB.id), sessionId },
    delete: { action: 'delete', workspace: String(workspaceB.id), sessionId, confirm: sessionId },
  }
  const before = {
    created: controller.created.length,
    prompts: controller.prompts.length,
    cancelled: controller.cancelled.length,
    forked: controller.forked.length,
    deleted: controller.deleted.length,
  }
  for (const [action, args] of Object.entries(attempts)) {
    const refused = await callTool(mounted.ctx, ordinaryAgent, 'workspace_sessions', args)
    expect(refused.isError, `${action} must be refused for an ordinary agent`).toBe(true)
    expect(textOf(refused)).toContain('super agent')
  }
  expect({
    created: controller.created.length,
    prompts: controller.prompts.length,
    cancelled: controller.cancelled.length,
    forked: controller.forked.length,
    deleted: controller.deleted.length,
  }).toEqual(before)

  const read = await callTool(mounted.ctx, ordinaryAgent, 'workspace_sessions', { action: 'get', sessionId: String(ordinaryAgent.id) })
  expect(read.isError).toBe(false)
  const list = await callTool(mounted.ctx, ordinaryAgent, 'workspace_sessions', { action: 'list' })
  expect(list.isError).toBe(false)
  expect((valueOf(list) as { items: { sessionId: string }[] }).items.some(item => item.sessionId === String(ordinaryAgent.id))).toBe(true)
})

test('an ordinary agent may start, prompt, and stop a Session in its own workspace', async () => {
  const controller = installController(mounted)
  const started = await callTool(mounted.ctx, ordinaryAgent, 'workspace_sessions', {
    action: 'start', task: 'ordinary task', title: 'ordinary session',
  })
  expect(started.isError).toBe(false)
  const sessionId = (valueOf(started) as { started: { sessionId: string } }).started.sessionId
  expect(controller.created).toHaveLength(1)

  const prompted = await callTool(mounted.ctx, ordinaryAgent, 'workspace_sessions', {
    action: 'prompt', sessionId, text: 'ordinary follow-up',
  })
  expect(prompted.isError).toBe(false)

  const stopped = await callTool(mounted.ctx, ordinaryAgent, 'workspace_sessions', { action: 'stop', sessionId })
  expect(stopped.isError).toBe(false)
  expect(controller.cancelled).toHaveLength(1)
})
