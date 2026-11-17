/**
 * The dispatch entry, end to end: the super agent's `superagent_control start`
 * records the task in the target workspace against an active intent card, and
 * the dispatch ledger is its projection under the same task id.
 *
 * This is the composition the design calls for: the real dafeiyu organizer, the
 * real workspace toolset (intent cards, tasks, and the `workspaceTasks`
 * service), the real jira-agent superagent capability, and the shipped tool
 * registry. Only the Session controller and the permission service are
 * stand-ins, because starting a real Session is covered elsewhere and would not
 * change which task record the dispatch writes.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import Dafeiyu from '@deepseek-ai/dsh-dafeiyu'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { AgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as StoreAtom from '@deepseek-ai/dsh-store-atom'
import type { Workspace, WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { WorkspaceId as brandWorkspaceId } from '@deepseek-ai/dsh-workspace'
import JiraService from '@deepseek-ai/dsh-jira-service'
import * as WorkspaceTools from '@deepseek-ai/dsh-workspace-tools'
import * as JiraAgent from '@deepseek-ai/dsh-jira-agent'
import { createLedgerFixture } from '../src/testing/host.ts'

/** A workspace registry stand-in; scoping and role checks are what this test reads. */
class TestWorkspace implements Workspace {
  readonly createdAt = '2026-11-17T00:00:00.000Z'

  /**
   * @param id - stable workspace id.
   * @param path - canonical checkout path.
   * @param title - display title.
   * @param sessionIds - sessions the workspace accounts for.
   */
  constructor(
    readonly id: WorkspaceId,
    readonly path: string,
    private displayTitle: string,
    public sessionIds: SessionId[],
  ) {}

  /** Display title. */
  get title(): string { return this.displayTitle }

  /** Workspace role; the super workspace is the only special one. */
  get role(): 'agent' | 'super' { return 'agent' }

  /** Last durable mutation. */
  get updatedAt(): string { return this.createdAt }

  /** Replace the display title. */
  async setTitle(title: string): Promise<void> { this.displayTitle = title }

  /** Replace the role (the super workspace registration sets it). */
  async setRole(): Promise<void> {}

  /** Account one more Session. */
  async attachSession(sessionId: SessionId): Promise<void> {
    if (!this.sessionIds.includes(sessionId)) this.sessionIds.push(sessionId)
  }

  /** Move one Session; the stand-in keeps insertion order. */
  async insertSessionBefore(): Promise<void> {}

  /** Drop one accounted Session. */
  async detachSession(sessionId: SessionId): Promise<void> {
    this.sessionIds = this.sessionIds.filter(id => id !== sessionId)
  }

  /** The directory exists for every fixture workspace. */
  async status(): Promise<'ok'> { return 'ok' }
}

/** The registry operations the toolset and the jira capability read. */
class TestRegistry {
  archivedSessionIds: SessionId[] = []
  private readonly rows: TestWorkspace[] = []

  /** Register one workspace. */
  add(workspace: TestWorkspace): TestWorkspace {
    this.rows.push(workspace)
    return workspace
  }

  /** Every registered workspace. */
  list(): Workspace[] { return this.rows }

  /** Create one registration over a directory. */
  async create(path: string, title?: string, role?: 'agent' | 'super'): Promise<Workspace> {
    const workspace = this.add(new TestWorkspace(brandWorkspaceId(`ws-${String(this.rows.length + 1)}`), path, title ?? path, []))
    if (role === 'super') await workspace.setRole()
    return workspace
  }

  /** Keep display order; this test never reads it. */
  async insertBefore(): Promise<void> {}

  /** Archive one Session, as the Session-start failure path may. */
  async archiveSession(sessionId: string): Promise<void> { this.archivedSessionIds.push(SessionId(sessionId)) }
}

/** The one Session the controller creates for a dispatch. */
class TestController {
  prompted: { readonly sessionId: string; readonly requestId?: string; readonly text: string }[] = []
  created = 0
  private readonly children: { sessionId: string; workspaceId: string }[] = []

  /**
   * @param registry - the registrations the listed Sessions resolve their cwd through.
   */
  constructor(private readonly registry: TestRegistry) {}

  /** Create the child Session in the requested workspace. */
  async create(request: { workspaceId?: string }): Promise<{ sessionId: string }> {
    this.created += 1
    const sessionId = `child-${String(this.created)}`
    this.children.push({ sessionId, workspaceId: request.workspaceId ?? '' })
    return { sessionId }
  }

  /** List the Sessions of a workspace, as the permission path resolves them. */
  async list(): Promise<{ items: { sessionId: string; running: boolean; cwd: string; updatedAt: number }[] }> {
    return {
      items: this.children.map(child => ({
        sessionId: child.sessionId,
        running: false,
        cwd: this.registry.list().find(workspace => String(workspace.id) === child.workspaceId)?.path ?? '',
        updatedAt: 1,
      })),
    }
  }

  /** Record one admitted prompt. */
  async prompt(request: {
    sessionId: string
    requestId?: string
    content: readonly { text: string }[]
  }): Promise<{ accepted: boolean }> {
    this.prompted.push({
      sessionId: request.sessionId,
      ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
      text: request.content[0]?.text ?? '',
    })
    return { accepted: true }
  }

  /** Rename the child Session. */
  async rename(request: { title: string }): Promise<{ title: string }> { return { title: request.title } }

  /** No model selection service in this composition. */
  async resolveAgent(): Promise<{ agent: { id: string; session: Record<string, never> } }> {
    return { agent: { id: '', session: {} } }
  }
}

/** The permission presets the explicit workspace-write default resolves through. */
const PERMISSION_PRESETS = Object.freeze({
  names: ['workspace-write'] as const,
  resolve: () => ({ sandbox: 'workspace-write', approval: 'ask' }),
  current: () => 'workspace-write',
  selection: () => ({ currentValue: 'workspace-write', sandboxMode: 'workspace-write', approvalPolicy: 'ask' }),
  set: () => {},
})

/** One mounted composition plus the handles the test drives. */
interface Composition {
  readonly ctx: Context
  readonly harness: AgentLoopTestHarness
  readonly registry: TestRegistry
  readonly controller: TestController
  readonly superHome: string
  readonly workspaceA: TestWorkspace
  readonly workspaceB: TestWorkspace
  readonly superAgent: Agent
  readonly ordinaryAgent: Agent
}

let scratch: string
let ledgerRoot: string
let savedHome: string | undefined
let savedSnapshot: string | undefined
let composition: Composition
let disposers: Context[] = []


/** Read one tool's resolved value or throw on an error result. */
function valueOf(result: ToolExecutionResult): Record<string, unknown> {
  if (result.isError) throw new Error(result.content.map(block => block.type === 'text' ? block.text : '').join(''))
  return result.value as Record<string, unknown>
}

/** The failure code a tool result carries, from either failure face. */
function codeOf(result: ToolExecutionResult): string | undefined {
  if (result.isError) return result.error.info?.code
  const value = result.value as { error?: { code?: string } }
  return value.error?.code
}

/** The intent code the superagent refusal carries in its context. */
function intentCodeOf(result: ToolExecutionResult): string | undefined {
  if (result.isError) {
    const info = result.error.info as { intentCode?: string; intent_code?: string } | undefined
    return info?.intentCode ?? info?.intent_code
  }
  const value = result.value as { error?: { context?: { intentCode?: string; intent_code?: string } } }
  return value.error?.context?.intentCode ?? value.error?.context?.intent_code
}

/** Call one registered tool through the real registry. */
let callId = 0
async function callTool(agent: Agent, name: string, args: unknown): Promise<ToolExecutionResult> {
  callId += 1
  const batch = await composition.ctx.tools.execute({
    signal: new AbortController().signal,
    calls: [{ type: 'tool-call', id: ToolCallId(`dispatch-${String(callId)}`), name, arguments: JSON.stringify(args) }],
    agent,
  })
  const result = batch.results[0]?.result
  if (result === undefined) throw new Error(`tool ${name} produced no result`)
  return result
}

/** Build one active (all traceable) intent card in a workspace. */
async function createCard(workspaceId: string, requestId: string): Promise<{ intentId: string; version: number }> {
  const created = await callTool(composition.superAgent, 'workspace_intents', {
    action: 'create',
    workspace: workspaceId,
    requestId,
    rawUserText: 'Fix the checkout helper. Keep the build green. Do not touch the README.',
    items: {
      goal: [{ text: 'Fix the checkout helper', source: 'user-verbatim' }],
      acceptance: [{ text: 'Keep the build green', source: 'user-verbatim' }],
      boundaries: [{ text: 'Do not touch the README', source: 'user-verbatim' }],
      outputForm: [],
    },
  })
  const value = valueOf(created) as { intentId: string; intent: { version: number } }
  return { intentId: value.intentId, version: value.intent.version }
}

/** One dispatch argument set whose brief covers every card point. */
const coverageOf = (card: { intentId: string; version: number }): Record<string, unknown> => ({
  intentId: card.intentId,
  intentVersion: card.version,
  acceptance: ['Keep the build green'],
  boundaries: ['Do not touch the README'],
  taskType: 'fix',
  coverage: [
    { point: 'goal[0]', brief: 'Fix the checkout helper' },
    { point: 'acceptance[0]', brief: 'Keep the build green' },
    { point: 'boundaries[0]', brief: 'Do not touch the README' },
  ],
})

beforeAll(async () => {
  savedHome = process.env['DSH_HOME']
  savedSnapshot = process.env['DSH_CTX_SNAPSHOT']
  scratch = await mkdtemp(join(tmpdir(), 'dsh-dispatch-intents-'))
  const dshHome = join(scratch, 'home')
  const superHome = join(scratch, 'super agent')
  const projectA = join(scratch, 'project-a')
  const projectB = join(scratch, 'project-b')
  for (const directory of [dshHome, superHome, projectA, projectB]) await mkdir(directory, { recursive: true })
  process.env['DSH_HOME'] = dshHome
  // The report marker round-trips through a fixture env; a value is enough to keep the pin stable.
  process.env['DSH_CTX_SNAPSHOT'] = savedSnapshot

  const ctx = new Context()
  disposers = [ctx]
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(LocalFileSystem, { cwd: scratch })
  const registry = new TestRegistry()
  const superWorkspace = registry.add(new TestWorkspace(brandWorkspaceId('ws-super'), superHome, 'Super agent', []))
  await superWorkspace.setRole()
  registry.add(new TestWorkspace(brandWorkspaceId('ws-a'), projectA, 'project a', []))
  registry.add(new TestWorkspace(brandWorkspaceId('ws-b'), projectB, 'project b', []))
  ctx.provide('workspaceRegistry', registry)
  // The toolset declares the query service as a dependency and reads one Session's event trail to
  // attribute a card to a turn; this scenario has no persisted log, so the observation is empty.
  ctx.provide('sessionQuery', Object.freeze({
    async observeSession() {
      return { session: {}, events: [], [Symbol.dispose]: () => {} }
    },
  }))
  await ctx.plugin(StoreAtom as never, { ensureRoot: false } as never)
  const controller = new TestController(registry)
  ctx.provide('sessionController', controller)
  // A workspace Session is started with an explicit workspace-write default; the permission path
  // requires both services to exist before it will commit that preset.
  ctx.provide('sandboxPolicy', Object.freeze({}))
  ctx.provide('permissionPresets', PERMISSION_PRESETS)
  ledgerRoot = await createLedgerFixture()
  await ctx.plugin(JiraService, { root: ledgerRoot, machine_id: 'a1b2c3d4', push: { enabled: false } })
  await ctx.plugin(Dafeiyu, { capabilities: { superagent: { enabled: true } } })
  await ctx.plugin(JiraAgent, { superagent_home: superHome, superagent_worker_preset: 'jira-worker' })
  await ctx.plugin({
    name: WorkspaceTools.name,
    inject: WorkspaceTools.inject,
    apply(pluginCtx: Context) { WorkspaceTools.apply(pluginCtx) },
  } as never, {} as never)
  const harness = await mountAgentLoopTestHarness(ctx)

  const superAgent = await harness.create(SessionId('super-1'), { role: 'super' }, { cwd: superHome })
  await superWorkspace.attachSession(superAgent.session.id)
  const ordinaryAgent = await harness.create(SessionId('ordinary-1'), {}, { cwd: projectA })
  await registry.list()[1]?.attachSession(ordinaryAgent.session.id)
  composition = {
    ctx,
    harness,
    registry,
    controller,
    superHome,
    workspaceA: registry.list()[1] as TestWorkspace,
    workspaceB: registry.list()[2] as TestWorkspace,
    superAgent,
    ordinaryAgent,
  }
  // The jira capability captures its HEAD asynchronously; one tick settles the wiring.
  await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
}, 60_000)

afterAll(async () => {
  for (const ctx of disposers.splice(0)) await ctx.fiber.dispose()
  if (savedHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = savedHome
  if (savedSnapshot === undefined) delete process.env['DSH_CTX_SNAPSHOT']
  else process.env['DSH_CTX_SNAPSHOT'] = savedSnapshot
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true })
  if (ledgerRoot !== undefined) await rm(ledgerRoot, { recursive: true, force: true })
})

describe('dispatch through the intent card', () => {
  it('registers workspace_intents and workspace_tasks on the super agent session', () => {
    const names = composition.ctx.tools.schemas(composition.superAgent).map(schema => schema.name)
    expect(names).toContain('workspace_intents')
    expect(names).toContain('workspace_tasks')
    expect(names).toContain('superagent_control')
    expect(names).toContain('superagent_ledger')
  })

  it('keeps ordinary agents on the read side of the same tools', async () => {
    const names = composition.ctx.tools.schemas(composition.ordinaryAgent).map(schema => schema.name)
    expect(names).toContain('workspace_intents')
    expect(names).toContain('workspace_tasks')
    expect(names).not.toContain('superagent_control')
    const read = await callTool(composition.ordinaryAgent, 'workspace_tasks', {
      action: 'list',
      workspace: String(composition.workspaceA.id),
    })
    expect(read.isError).toBe(false)
    const card = await createCard(String(composition.workspaceA.id), 'ordinary-read-card')
    const denied = await callTool(composition.ordinaryAgent, 'workspace_intents', {
      action: 'confirm',
      workspace: String(composition.workspaceA.id),
      intentId: card.intentId,
      version: card.version,
      decision: 'confirm',
      requestId: 'ordinary-confirm',
    })
    expect(codeOf(denied)).toBe('INTENT_PERMISSION_DENIED')
  })

  it('records the task in the target workspace and projects the ledger under the same id', async () => {
    const card = await createCard(String(composition.workspaceA.id), 'card-happy')
    const dispatched = await callTool(composition.superAgent, 'superagent_control', {
      action: 'start',
      workspace: String(composition.workspaceA.id),
      task: 'Fix the checkout helper',
      ...coverageOf(card),
    })
    const value = valueOf(dispatched)
    const task = value['dispatch_task'] as { task_id: string } | undefined
    expect(task?.task_id).toBeTypeOf('string')
    expect(composition.controller.prompted).toHaveLength(1)
    expect(composition.controller.prompted[0]?.text).toContain('Fix the checkout helper')
    const start = value['start'] as { stage?: string } | undefined
    expect(start?.stage).toBe('prompted')

    const listed = await callTool(composition.superAgent, 'workspace_tasks', {
      action: 'list',
      workspace: String(composition.workspaceA.id),
    })
    const items = valueOf(listed)['items'] as { taskId: string }[]
    expect(items.map(item => item.taskId)).toContain(task?.task_id)

    const read = await callTool(composition.superAgent, 'workspace_tasks', {
      action: 'get',
      workspace: String(composition.workspaceA.id),
      taskId: task?.task_id,
    })
    const record = valueOf(read)['task'] as {
      intentId: string
      intentVersion: number
      taskType: string
      status: string
    }
    expect(record).toMatchObject({
      intentId: card.intentId,
      intentVersion: card.version,
      taskType: 'fix',
      status: 'pending',
    })

    const ledger = await callTool(composition.superAgent, 'superagent_ledger', { action: 'list', workspace: 'project a' })
    const rows = valueOf(ledger)['entries'] as { id: string; status: string }[]
    expect(rows.map(row => row.id)).toEqual([task?.task_id])
    expect(rows[0]?.status).toBe('pending')
  })

  it('refuses a dispatch with no card reference or version', async () => {
    const missingCard = await callTool(composition.superAgent, 'superagent_control', {
      action: 'start',
      workspace: String(composition.workspaceA.id),
      task: 'no card reference',
      acceptance: ['keep the build green'],
      boundaries: ['do not touch the README'],
      taskType: 'fix',
    })
    expect(intentCodeOf(missingCard)).toBe('INTENT_INCOMPLETE')
    const missingVersion = await callTool(composition.superAgent, 'superagent_control', {
      action: 'start',
      workspace: String(composition.workspaceA.id),
      task: 'no card version',
      intentId: 'intent-without-version',
      acceptance: ['keep the build green'],
      boundaries: ['do not touch the README'],
      taskType: 'fix',
    })
    expect(intentCodeOf(missingVersion)).toBe('INTENT_INCOMPLETE')
    // A refused dispatch starts no Session.
    expect(composition.controller.created).toBe(1)
  })

  it('refuses a proposed card until the person confirms it', async () => {
    const proposedValue = valueOf(await callTool(composition.superAgent, 'workspace_intents', {
      action: 'create',
      workspace: String(composition.workspaceA.id),
      requestId: 'card-proposed',
      rawUserText: 'Fix the checkout helper. Do not touch the README.',
      items: {
        goal: [{ text: 'Fix the checkout helper', source: 'user-verbatim' }],
        acceptance: [{ text: 'Probably keep the build green', source: 'inference', reason: 'not stated by the user' }],
        boundaries: [{ text: 'Do not touch the README', source: 'user-verbatim' }],
        outputForm: [],
      },
    })) as { intentId: string; intent: { version: number } }
    const proposed = { intentId: proposedValue.intentId, version: proposedValue.intent.version }
    const refused = await callTool(composition.superAgent, 'superagent_control', {
      action: 'start',
      workspace: String(composition.workspaceA.id),
      task: 'Fix the checkout helper',
      ...coverageOf(proposed),
    })
    expect(intentCodeOf(refused)).toBe('INTENT_UNCONFIRMED')
    const confirmed = await callTool(composition.superAgent, 'workspace_intents', {
      action: 'confirm',
      workspace: String(composition.workspaceA.id),
      intentId: proposed.intentId,
      version: proposed.version,
      decision: 'confirm',
      requestId: 'card-proposed-confirm',
    })
    expect(confirmed.isError).toBe(false)
    const dispatched = await callTool(composition.superAgent, 'superagent_control', {
      action: 'start',
      workspace: String(composition.workspaceA.id),
      task: 'Fix the checkout helper',
      ...coverageOf(proposed),
    })
    expect(dispatched.isError).toBe(false)
    expect(composition.controller.created).toBe(2)
  })

  it('refuses a card that belongs to another workspace', async () => {
    const cardInB = await createCard(String(composition.workspaceB.id), 'card-in-b')
    const refused = await callTool(composition.superAgent, 'superagent_control', {
      action: 'start',
      workspace: String(composition.workspaceA.id),
      task: 'Fix the checkout helper',
      ...coverageOf(cardInB),
    })
    expect(intentCodeOf(refused)).toBe('INTENT_SCOPE_MISMATCH')
  })

  it('refuses a brief that does not cover every card point, and accepts the explicit waiver', async () => {
    const card = await createCard(String(composition.workspaceA.id), 'card-coverage')
    const uncovered = await callTool(composition.superAgent, 'superagent_control', {
      action: 'start',
      workspace: String(composition.workspaceA.id),
      task: 'Fix the checkout helper',
      ...coverageOf(card),
      coverage: [
        { point: 'goal[0]', brief: 'Fix the checkout helper' },
        { point: 'acceptance[0]', brief: 'Keep the build green' },
      ],
      boundaries: ['Do not touch the README'],
    })
    expect(intentCodeOf(uncovered)).toBe('INTENT_COVERAGE_MISSING')
    const waived = await callTool(composition.superAgent, 'superagent_control', {
      action: 'start',
      workspace: String(composition.workspaceA.id),
      task: 'Fix the checkout helper',
      ...coverageOf(card),
      coverage: [
        { point: 'goal[0]', brief: 'Fix the checkout helper' },
        { point: 'acceptance[0]', brief: 'Keep the build green' },
      ],
      boundaries: ['Do not touch the README'],
      nonCoverage: [{ point: 'boundaries[0]', reason: 'the README is not part of this dispatch' }],
    })
    expect(waived.isError).toBe(false)
    const value = valueOf(waived)['dispatch_task'] as { task_id: string }
    const read = await callTool(composition.superAgent, 'workspace_tasks', {
      action: 'get',
      workspace: String(composition.workspaceA.id),
      taskId: value.task_id,
    })
    expect((valueOf(read)['task'] as { nonCoverage?: unknown[] }).nonCoverage).toHaveLength(1)
  })
})
