/**
 * The toolset's write side under the real filesystem fence.
 *
 * The ordinary specs mount `LocalFileSystem` and therefore never exercise
 * `.dsh`-store writes through `workspace-write`; a store record outside the
 * session workspace was refused in production even though every non-fenced
 * test passed. This spec mounts the shipped sandbox policy and the
 * sandbox-enforcing filesystem, runs the whole write path (card, confirmation,
 * task, receipt) under `workspace-write`, and pins both sides of the grant:
 * the store's own root is writable, while ordinary file mutations elsewhere
 * under `$DSH_HOME` stay refused.
 */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { FsError } from '@deepseek-ai/dsh-fs'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createDshStore } from '@deepseek-ai/dsh-store-atom/src/api.ts'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import Dafeiyu from '@deepseek-ai/dsh-dafeiyu'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { AgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as WorkspaceTools from '../src/api.ts'
import { assertWorkspaceOutsideTemp } from '../../../../scripts/snapshot-workspace-parent.ts'
import { TestSessionQueryEngine, TestWorkspaceRegistry, registerWorkspace, signal } from './harness.ts'
import type { TestWorkspace } from './harness.ts'

/** One mounted composition: the sandbox, the store, and the toolset. */
interface Composition {
  readonly ctx: Context
  readonly harness: AgentLoopTestHarness
  readonly agent: Agent
  readonly workspace: TestWorkspace
  readonly other: TestWorkspace
}

let scratch: string
let savedHome: string | undefined
let composition: Composition | undefined

/** The mounted composition, or a clear failure when a hook did not run. */
function mountedComposition(): Composition {
  if (composition === undefined) throw new Error('the sandbox composition is not mounted')
  return composition
}

/** The repository root, so the fixture lives outside every temporary write grant. */
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
let callId = 0

/** Call one registered tool through the real registry. */
async function callTool(agent: Agent, name: string, args: unknown): Promise<ToolExecutionResult> {
  const mounted = composition
  if (mounted === undefined) throw new Error('the sandbox composition is not mounted')
  callId += 1
  const batch = await mounted.ctx.tools.execute({
    signal,
    calls: [{
      type: 'tool-call',
      id: ToolCallId(`sandbox-call-${String(callId)}`),
      name,
      arguments: JSON.stringify(args),
    }],
    agent,
  })
  const result = batch.results[0]?.result
  if (result === undefined) throw new Error(`tool ${name} settled no result`)
  return result
}

/** Read a successful tool value. */
function valueOf(result: ToolExecutionResult): Record<string, unknown> {
  if (result.isError) {
    throw new Error(result.content.map(block => block.type === 'text' ? block.text : '').join(''))
  }
  return result.value as Record<string, unknown>
}

/** The stable code of a failed tool call. */
function codeOf(result: ToolExecutionResult): string | undefined {
  return result.isError ? result.error.info?.code : (result.value as { error?: { code?: string } }).error?.code
}

/** Create one active (all traceable) card and confirm it. */
async function createAndConfirmCard(requestId: string): Promise<{ intentId: string; version: number }> {
  const mounted = composition
  if (mounted === undefined) throw new Error('the sandbox composition is not mounted')
  const created = valueOf(await callTool(mounted.agent, 'workspace_intents', {
    action: 'create',
    workspace: String(mounted.workspace.id),
    requestId,
    rawUserText: 'Fix the helper. Keep the build green. Do not touch the README.',
    items: {
      goal: [{ text: 'Fix the helper', source: 'user-verbatim' }],
      acceptance: [{ text: 'Keep the build green', source: 'user-verbatim' }],
      boundaries: [{ text: 'Do not touch the README', source: 'user-verbatim' }],
      outputForm: [],
    },
  })) as { intentId: string; intent: { version: number } }
  const card = { intentId: created.intentId, version: created.intent.version }
  const confirmed = await callTool(mounted.agent, 'workspace_intents', {
    action: 'confirm',
    workspace: String(mounted.workspace.id),
    intentId: card.intentId,
    version: card.version,
    decision: 'confirm',
    requestId: `${requestId}-confirm`,
  })
  expect(confirmed.isError).toBe(false)
  return card
}

/** The task arguments that cover every card point. */
function taskArgs(card: { intentId: string; version: number }, requestId: string): Record<string, unknown> {
  return {
    action: 'create',
    workspace: String(composition?.workspace.id ?? ''),
    requestId,
    intentId: card.intentId,
    intentVersion: card.version,
    taskType: 'fix',
    goal: 'Fix the helper',
    acceptance: ['Keep the build green'],
    boundaries: ['Do not touch the README'],
    coverage: [
      { point: 'goal[0]', brief: 'Fix the helper' },
      { point: 'acceptance[0]', brief: 'Keep the build green' },
      { point: 'boundaries[0]', brief: 'Do not touch the README' },
    ],
  }
}

beforeAll(async () => {
  savedHome = process.env['DSH_HOME']
  // The workspace-write mode grants the platform temp areas, so a home inside /tmp would
  // pass without the store-root grant and prove nothing.
  scratch = await mkdtemp(join(repoRoot, '.dsh-store-sandbox-'))
  assertWorkspaceOutsideTemp(scratch)
  const home = join(scratch, 'home')
  const projectA = join(scratch, 'project-a')
  const projectB = join(scratch, 'project-b')
  for (const directory of [home, projectA, projectB]) await mkdir(directory, { recursive: true })
  process.env['DSH_HOME'] = home

  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(TestSessionQueryEngine)
  await ctx.plugin(SandboxPolicy, { mode: 'workspace-write' })
  // A real composition registers fs-only grants (the super agent hands files to
  // registered workspaces); the store's global grant must compose with them.
  ctx.sandboxPolicy.registerFsWritableRoots(() => [projectB])
  await ctx.plugin(SandboxedFileSystem, { cwd: projectA })
  if (!(ctx.fs instanceof SandboxedFileSystem)) throw new Error('the fixture must mount the sandboxed filesystem')
  ctx.provide('dshStore', createDshStore(ctx, false))
  const registry = new TestWorkspaceRegistry()
  ctx.provide('workspaceRegistry', registry)
  await ctx.plugin(Dafeiyu)
  await ctx.plugin({
    name: WorkspaceTools.name,
    inject: WorkspaceTools.inject,
    apply(pluginCtx: Context) { WorkspaceTools.apply(pluginCtx) },
  } as never, {} as never)
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('sandbox-session'), { role: 'super' }, { cwd: projectA })
  const workspace = await registerWorkspace(registry, projectA, 'project a')
  await workspace.attachSession(agent.session.id)
  const other = await registerWorkspace(registry, projectB, 'project b')
  composition = { ctx, harness, agent, workspace, other }
}, 60_000)

afterAll(async () => {
  await composition?.ctx.fiber.dispose()
  if (savedHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = savedHome
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true })
})

describe('workspace toolset writes under workspace-write', () => {
  it('runs card, confirmation, task, and receipt under the limited policy', async () => {
    const mounted = mountedComposition()
    expect(mounted.ctx.sandboxPolicy.resolve({ session: mounted.agent.session }).mode).toBe('workspace-write')
    const card = await createAndConfirmCard('card-sandbox')
    const created = valueOf(await callTool(mounted.agent, 'workspace_tasks', taskArgs(card, 'task-sandbox')))
    const taskId = created.taskId as string
    const started = valueOf(await callTool(mounted.agent, 'workspace_tasks', {
      action: 'update',
      workspace: String(mounted.workspace.id),
      taskId,
      status: 'in_progress',
      requestId: 'task-sandbox-start',
    }))
    expect(started.status).toBe('in_progress')
    const receipt = valueOf(await callTool(mounted.agent, 'workspace_tasks', {
      action: 'receipt',
      workspace: String(mounted.workspace.id),
      taskId,
      status: 'done',
      requestId: 'task-sandbox-done',
      alignment: {
        intentId: card.intentId,
        intentVersion: card.version,
        acceptance: [{ point: 'acceptance[0]', status: 'satisfied', evidence: 'npm test' }],
        boundaries: [{ point: 'boundaries[0]', status: 'respected', evidence: 'the README is unchanged' }],
        outputForm: [],
      },
    }))
    expect(receipt.status).toBe('done')
    expect(receipt.deviations).toBeUndefined()

    // The records really landed in the documented global store location.
    const taskFile = join(scratch, 'home', 'workspaces', String(mounted.workspace.id), 'tasks', `${taskId}.json`)
    const stored = JSON.parse(await readFile(taskFile, 'utf8')) as { status: string; intentId: string }
    expect(stored.status).toBe('done')
    expect(stored.intentId).toBe(card.intentId)
  })

  it('leaves ordinary file mutations outside the session workspace refused', async () => {
    const mounted = mountedComposition()
    const policy = mounted.ctx.sandboxPolicy.resolve({ session: mounted.agent.session })
    const otherStore = await mounted.ctx.fs.resolve(join(scratch, 'home', 'workspaces', String(mounted.other.id), 'intents', 'x.json'))
    const homeElsewhere = await mounted.ctx.fs.resolve(join(scratch, 'home', 'sessions', 'x.json'))
    const ownStore = await mounted.ctx.fs.resolve(join(scratch, 'home', 'workspaces', String(mounted.workspace.id), 'tasks', 'probe.json'))
    for (const target of [otherStore, homeElsewhere, ownStore]) {
      await expect(mounted.ctx.fs.writeText(target, '{}', undefined, undefined, policy))
        .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    }
    // The store wrote the same directory above; only the store call carries the
    // store-root grant, so the generic file tool still cannot reach it.
    await expect(mounted.ctx.fs.mkdir(
      await mounted.ctx.fs.resolve(join(scratch, 'home', 'outside')),
      undefined,
      policy,
    )).rejects.toBeInstanceOf(FsError)
  })

  it('applies a session mode switch to the next store write, without a new session', async () => {
    const mounted = mountedComposition()
    setSandboxMode(mounted.agent.session, 'danger-full-access')
    expect(mounted.ctx.sandboxPolicy.resolve({ session: mounted.agent.session }).mode).toBe('danger-full-access')
    // The same Session now writes through the store without any new grant.
    const card = await createAndConfirmCard('card-escalated')
    const created = valueOf(await callTool(mounted.agent, 'workspace_tasks', taskArgs(card, 'task-escalated')))
    expect(created.taskId).toBeTypeOf('string')
    // And an out-of-workspace mutation the limited policy refused is now allowed.
    const target = await mounted.ctx.fs.resolve(join(scratch, 'home', 'sessions', 'after-escalation.json'))
    await expect(mounted.ctx.fs.writeText(target, '{}', undefined, undefined,
      mounted.ctx.sandboxPolicy.resolve({ session: mounted.agent.session }))).resolves.toBeDefined()
  })

  it('keeps a read-only session refused even for the global store', async () => {
    const mounted = mountedComposition()
    setSandboxMode(mounted.agent.session, 'read-only')
    const denied = await callTool(mounted.agent, 'workspace_intents', {
      action: 'create',
      workspace: String(mounted.workspace.id),
      requestId: 'card-read-only',
      rawUserText: 'Do not write this.',
      items: {
        goal: [{ text: 'Do not write this', source: 'user-verbatim' }],
        acceptance: [],
        boundaries: [],
        outputForm: [],
      },
    })
    expect(codeOf(denied)).toBe('FS_SANDBOX_DENIED')
  })
})
