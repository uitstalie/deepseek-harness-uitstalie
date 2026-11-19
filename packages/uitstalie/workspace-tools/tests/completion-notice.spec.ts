/**
 * Task-bound completion notices: the turn-end trigger, the dispatcher delivery
 * mode, the reply and notice-turn guards, task limits, and failure containment.
 *
 * The Session controller is a recording stub because the host owns the
 * next-turn queue; the assertions cover the delivery intent (queue, dispatcher
 * target, marked first line) and the toolset's own guards.
 */
import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  callTool,
  createRoot,
  mountWorkspaceTools,
  objectValue,
  registerWorkspace,
  seedRecord,
  valueOf,
} from './harness.ts'
import type { TestWorkspace, WorkspaceToolsHarness } from './harness.ts'
import * as WorkspaceTools from '../src/api.ts'
import { COMPLETION_NOTICE_MARKER } from '../src/completion.ts'

/** One prompt the recording controller received. */
interface RecordedPrompt {
  readonly requestId: string
  readonly sessionId: string
  readonly mode: 'queue' | 'steer'
  readonly text: string
}

/** A recording stand-in for the host Session controller's prompt verb. */
class RecordingDelivery {
  /** Every admitted prompt, in call order. */
  readonly prompts: RecordedPrompt[] = []
  /** Throw from the next prompt instead of accepting it. */
  failNext = false
  /** Decline the next prompt without recording it. */
  declineNext = false

  /**
   * Record one prompt or fail it.
   * @param request - the host request.
   * @returns the host acknowledgement.
   */
  async prompt(request: {
    readonly requestId: string
    readonly sessionId: string
    readonly mode: 'queue' | 'steer'
    readonly content: readonly { readonly type: 'text'; readonly text: string }[]
  }): Promise<{ readonly accepted: boolean }> {
    if (this.failNext) {
      this.failNext = false
      throw new Error('controller refused the admission')
    }
    if (this.declineNext) {
      this.declineNext = false
      return { accepted: false }
    }
    this.prompts.push({
      requestId: request.requestId,
      sessionId: request.sessionId,
      mode: request.mode,
      text: request.content.map(block => block.text).join('\n'),
    })
    return { accepted: true }
  }
}

/** Wait a short, real interval so an asynchronous turn-end worker can settle. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Admitted completion notices only; the controller also records ordinary messages. */
function notices(): readonly RecordedPrompt[] {
  return delivery.prompts.filter(prompt => prompt.requestId.startsWith('workspace-task-settled-'))
}

let project: string
let home: string
let contexts: Context[]
let mounted: WorkspaceToolsHarness
let workspace: TestWorkspace
let dispatcher: Agent
let executor: Agent
let delivery: RecordingDelivery

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'dsh-completion-notice-'))
  home = await mkdtemp(join(tmpdir(), 'dsh-completion-notice-home-'))
  await mkdir(join(project, '.git'), { recursive: true })
  contexts = []
  const ctx = new Context()
  contexts.push(ctx)
  mounted = await mountWorkspaceTools(ctx, home, {
    config: { completionNotice: 'task-bound', noticeMaxPerTask: 8, noticeTtlMs: 3_600_000 },
  })
  workspace = await registerWorkspace(mounted.registry, project, 'completion')
  dispatcher = await createRoot(mounted, 'completion-dispatcher', project, 'super')
  executor = await createRoot(mounted, 'completion-executor', project)
  await workspace.attachSession(dispatcher.session.id)
  await workspace.attachSession(executor.session.id)
  delivery = new RecordingDelivery()
  mounted.ctx.provide('sessionController' as never, delivery as never)
})

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await rm(project, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

/** Emit one synthesized Session event to the toolset's global listener. */
function emit(session: Agent['session'], event: SessionEvent): void {
  mounted.ctx.emit('session/event', session, event)
}

/** Build one open-turn event. */
function turnStart(turn: number, time: number): SessionEvent<'turn/start'> {
  return { type: 'turn/start', seq: SessionSeq(0), time, data: { turn } }
}

/** Build one turn-end event. */
function turnEnd(turn: number, time: number): SessionEvent<'turn/end'> {
  return { type: 'turn/end', seq: SessionSeq(0), time, data: { turn, reason: { kind: 'completed' } } }
}

/** Build one user message event carrying `text`. */
function userMessage(text: string, time: number): SessionEvent<'user/message'> {
  return {
    type: 'user/message',
    seq: SessionSeq(0),
    time,
    surfaceOp: 'append',
    data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
  }
}

/** Create one task targeting `targetSessionId` on behalf of `author`. */
async function createTaskAs(author: Agent, targetSessionId: string): Promise<string> {
  const result = await callTool(mounted.ctx, author, 'workspace_tasks', {
    action: 'create',
    workspace: String(workspace.id),
    goal: 'finish the fixture task',
    targetSessionId,
    taskType: 'other',
  })
  return objectValue<{ taskId: string }>(valueOf(result)).taskId
}

/** Create one task targeting the executor, dispatched by the super agent. */
async function createTask(targetSessionId: string): Promise<string> {
  return await createTaskAs(dispatcher, targetSessionId)
}

/**
 * Rebuild the composition with different notice limits. Tests that need a
 * lower cap or a shorter window use this before creating their task.
 * @param config - the plugin configuration for the new composition.
 */
async function remount(config: Partial<WorkspaceTools.Config>, withController = true): Promise<void> {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await rm(home, { recursive: true, force: true })
  home = await mkdtemp(join(tmpdir(), 'dsh-completion-notice-home-'))
  const ctx = new Context()
  contexts.push(ctx)
  mounted = await mountWorkspaceTools(ctx, home, { config })
  workspace = await registerWorkspace(mounted.registry, project, 'completion-remount')
  dispatcher = await createRoot(mounted, 'completion-dispatcher-remount', project, 'super')
  executor = await createRoot(mounted, 'completion-executor-remount', project)
  await workspace.attachSession(dispatcher.session.id)
  await workspace.attachSession(executor.session.id)
  delivery = new RecordingDelivery()
  if (withController) mounted.ctx.provide('sessionController' as never, delivery as never)
}

/** Finish one successful turn and wait for the notice worker to settle. */
async function finishTurn(turn = 1, startedAt = 1_000, endedAt = 1_001): Promise<void> {
  emit(executor.session, turnStart(turn, startedAt))
  emit(executor.session, turnEnd(turn, endedAt))
}

test('completion notices default off and cap at one day', () => {
  expect(WorkspaceTools.Config({})).toMatchObject({
    completionNotice: 'off',
    noticeMaxPerTask: 32,
    noticeTtlMs: 86_400_000,
  })
})

test('a finished executor turn queues one marked notice for the task dispatcher', async () => {
  const taskId = await createTask(String(executor.session.id))
  emit(executor.session, turnStart(1, 1_000))
  emit(executor.session, turnEnd(1, 1_001))

  await expect.poll(() => notices().length, { timeout: 2_000 }).toBe(1)
  const notice = notices()[0]
  expect(notice).toMatchObject({ sessionId: String(dispatcher.session.id), mode: 'queue' })
  expect(notice?.text.split('\n')[0]).toContain(COMPLETION_NOTICE_MARKER)
  expect(notice?.text).toContain(taskId)
  expect(notice?.text).toContain('turn 1')
})

test('a turn that already sent a task-bound message is not announced again', async () => {
  const taskId = await createTask(String(executor.session.id))
  emit(executor.session, turnStart(1, Date.now() - 1_000))
  const sent = await callTool(mounted.ctx, executor, 'workspace_message', {
    action: 'send',
    targetSessionId: String(dispatcher.session.id),
    taskId,
    text: 'done: fixture task complete',
  })
  expect(sent.isError).toBe(false)
  emit(executor.session, turnEnd(1, Date.now()))
  await sleep(80)
  expect(notices()).toHaveLength(0)
})

test('a notice turn does not announce the task the dispatcher itself executes', async () => {
  const taskId = await createTaskAs(executor, String(dispatcher.session.id))
  expect(taskId).not.toBe('')
  emit(dispatcher.session, turnStart(1, 1_000))
  emit(dispatcher.session, userMessage(`${COMPLETION_NOTICE_MARKER} task-x · fixture notice`, 1_001))
  emit(dispatcher.session, turnEnd(1, 1_002))
  await sleep(80)
  expect(notices()).toHaveLength(0)
})

test('no task binding means no notice', async () => {
  await finishTurn()
  await sleep(80)
  expect(notices()).toHaveLength(0)
})

test('a task targeting another session does not notify this executor', async () => {
  await createTaskAs(executor, String(dispatcher.session.id))
  await finishTurn()
  await sleep(80)
  expect(notices()).toHaveLength(0)
})

test('done and cancelled tasks stop notifying', async () => {
  const cancelled = await createTask(String(executor.session.id))
  const done = await createTask(String(executor.session.id))
  await callTool(mounted.ctx, dispatcher, 'workspace_tasks', { action: 'update', taskId: cancelled, status: 'cancelled' })
  await callTool(mounted.ctx, dispatcher, 'workspace_tasks', { action: 'update', taskId: done, status: 'in_progress' })
  await callTool(mounted.ctx, dispatcher, 'workspace_tasks', { action: 'update', taskId: done, status: 'done' })

  await finishTurn()
  await sleep(80)
  expect(notices()).toHaveLength(0)
})

test('one task turn produces one notice, even when the turn end is observed twice', async () => {
  await createTask(String(executor.session.id))
  emit(executor.session, turnStart(1, 1_000))
  emit(executor.session, turnEnd(1, 1_001))
  emit(executor.session, turnEnd(1, 1_002))
  await expect.poll(() => notices().length, { timeout: 2_000 }).toBe(1)
  await sleep(40)
  expect(notices()).toHaveLength(1)
})

test('the per-task cap drops further notices inside the window', async () => {
  await remount({ completionNotice: 'task-bound', noticeMaxPerTask: 1, noticeTtlMs: 10 })
  await createTask(String(executor.session.id))
  await finishTurn(1, 1_000, 1_001)
  await expect.poll(() => notices().length, { timeout: 2_000 }).toBe(1)
  await finishTurn(2, 1_005, 1_006)
  await sleep(60)
  expect(notices()).toHaveLength(1)
})

test('the per-task window expires and allows a later notice', async () => {
  await remount({ completionNotice: 'task-bound', noticeMaxPerTask: 1, noticeTtlMs: 10 })
  await createTask(String(executor.session.id))
  await finishTurn(1, 1_000, 1_001)
  await expect.poll(() => notices().length, { timeout: 2_000 }).toBe(1)
  await finishTurn(2, 2_000, 2_001)
  await expect.poll(() => notices().length, { timeout: 2_000 }).toBe(2)
})

test('a controller failure is contained and does not fail the executor turn', async () => {
  await createTask(String(executor.session.id))
  delivery.failNext = true
  await finishTurn()
  await sleep(80)
  expect(notices()).toHaveLength(0)
})

test('urgent messages still steer the target step', async () => {
  await callTool(mounted.ctx, executor, 'workspace_message', {
    action: 'send',
    targetSessionId: String(dispatcher.session.id),
    text: 'stop: wrong conclusion',
    priority: 'urgent',
    urgentReason: 'stop-order',
  })
  expect(delivery.prompts).toHaveLength(1)
  expect(delivery.prompts[0]?.mode).toBe('steer')
})

test('the off switch mounts no listener and delivers nothing', async () => {
  await remount({ completionNotice: 'off' })
  await createTask(String(executor.session.id))
  await finishTurn()
  await sleep(80)
  expect(notices()).toHaveLength(0)
})

test('an unregistered Session has no workspace and no notice', async () => {
  const outside = join(project, 'outside-every-registration')
  await mkdir(outside, { recursive: true })
  const orphan = await createRoot(mounted, 'completion-orphan', outside)
  await createTask(String(executor.session.id))
  emit(orphan.session, turnStart(1, 1_000))
  emit(orphan.session, turnEnd(1, 1_001))
  await sleep(80)
  expect(notices()).toHaveLength(0)
})

test('a non-turn Session event and an ordinary user message do not suppress the notice', async () => {
  await createTask(String(executor.session.id))
  emit(executor.session, { type: 'step/start', seq: SessionSeq(0), time: 999, data: { turn: 1, step: 1 } })
  emit(executor.session, turnStart(1, 1_000))
  emit(executor.session, userMessage('ordinary turn input, not a notice', 1_000))
  emit(executor.session, turnEnd(1, 1_001))
  await expect.poll(() => notices().length, { timeout: 2_000 }).toBe(1)
})

test('the duplicate guard still drops a replayed turn end', async () => {
  await createTask(String(executor.session.id))
  await finishTurn(1, 1_000, 1_001)
  await expect.poll(() => notices().length, { timeout: 2_000 }).toBe(1)
  emit(executor.session, turnStart(1, 1_002))
  emit(executor.session, turnEnd(1, 1_003))
  await sleep(60)
  expect(notices()).toHaveLength(1)
})

test('an archived dispatcher receives nothing', async () => {
  await createTask(String(executor.session.id))
  await mounted.registry.archiveSession(dispatcher.session.id)
  await finishTurn()
  await expect.poll(() => true, { timeout: 2_000 }).toBe(true)
  await sleep(60)
  expect(notices()).toHaveLength(0)
})

test('a declined admission is logged and skipped', async () => {
  await createTask(String(executor.session.id))
  delivery.declineNext = true
  await finishTurn()
  await sleep(80)
  expect(notices()).toHaveLength(0)
})

test('a missing Session controller is logged and skipped', async () => {
  await remount({ completionNotice: 'task-bound', noticeMaxPerTask: 8, noticeTtlMs: 3_600_000 }, false)
  await createTask(String(executor.session.id))
  await finishTurn()
  await sleep(80)
  expect(delivery.prompts).toHaveLength(0)
})

test('a corrupt task record is contained and does not escape the turn', async () => {
  await createTask(String(executor.session.id))
  await seedRecord(mounted, `workspaces/${String(workspace.id)}/tasks/broken.json`, { broken: true })
  await finishTurn()
  await sleep(80)
  expect(notices()).toHaveLength(0)
})
