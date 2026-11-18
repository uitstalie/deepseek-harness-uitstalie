/**
 * Automatic completion reports: an executor's `turn/end` delivers the bound
 * task report to the dispatching Session through the real dafeiyu turn hook,
 * records the task receipt, and stays idempotent on replay.
 */
import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { TurnEndInput } from '@deepseek-ai/dsh-dafeiyu'
import type { MessagePrompt } from '../src/delivery.ts'
import { reportTurnEnd } from '../src/report.ts'
import { attachDispatchTaskSession } from '../src/tasks.ts'
import {
  callTool,
  createRoot,
  mountWorkspaceTools,
  registerWorkspace,
  startDispatchArgs,
  textOf,
  valueOf,
} from './harness.ts'
import type { WorkspaceToolsHarness } from './harness.ts'
import type { TestWorkspace } from './harness.ts'

/** A host Session controller that records prompts and admits them into the dispatcher log. */
class ReportController {
  readonly prompts: { readonly request: MessagePrompt; readonly text: string }[] = []

  /**
   * @param dispatcher - Session a report must reach; the controller appends the admitted text there.
   */
  constructor(private readonly dispatcher: Agent) {}

  /**
   * @param request - delivery request.
   * @param signal - cancellation for the admission.
   * @returns the host acknowledgement.
   */
  async prompt(request: MessagePrompt, signal: AbortSignal): Promise<{ readonly accepted: true }> {
    signal.throwIfAborted()
    const text = request.content.map(block => block.text).join('')
    this.prompts.push({ request, text })
    if (request.sessionId === String(this.dispatcher.session.id) && request.mode === 'queue') {
      const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
      this.dispatcher.session.append('user/message', message, { surfaceOp: 'append' })
    }
    return { accepted: true }
  }
}

let projectSuper: string
let projectWork: string
let home: string
let contexts: Context[]
let mounted: WorkspaceToolsHarness
let workspaceSuper: TestWorkspace
let workspaceWork: TestWorkspace
let superAgent: Agent
let executor: Agent
let controller: ReportController

beforeEach(async () => {
  projectSuper = await mkdtemp(join(tmpdir(), 'dsh-workspace-report-super-'))
  projectWork = await mkdtemp(join(tmpdir(), 'dsh-workspace-report-work-'))
  home = await mkdtemp(join(tmpdir(), 'dsh-workspace-report-home-'))
  await mkdir(join(projectSuper, '.git'), { recursive: true })
  await mkdir(join(projectWork, '.git'), { recursive: true })
  contexts = []
  const ctx = new Context()
  contexts.push(ctx)
  mounted = await mountWorkspaceTools(ctx, home)
  workspaceSuper = await registerWorkspace(mounted.registry, projectSuper, 'report-super')
  workspaceWork = await registerWorkspace(mounted.registry, projectWork, 'report-work')
  superAgent = await createRoot(mounted, 'report-super-session', projectSuper, 'super')
  executor = await createRoot(mounted, 'report-executor-session', projectWork)
  await workspaceSuper.attachSession(superAgent.session.id)
  await workspaceWork.attachSession(executor.session.id)
  controller = new ReportController(superAgent)
  mounted.ctx.provide('sessionController', controller)
})

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await rm(projectSuper, { recursive: true, force: true })
  await rm(projectWork, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

/**
 * Create a card and a task in the work workspace, then bind the executor.
 * @param taskText - brief text and card goal.
 * @param requestId - stable id used for the card and the task.
 * @param worker - executor Session.
 * @returns the task id.
 */
async function bindTask(taskText: string, requestId: string, worker: Agent = executor): Promise<string> {
  const card = await startDispatchArgs(mounted, superAgent, workspaceWork, taskText, requestId)
  const created = await callTool(mounted.ctx, superAgent, 'workspace_tasks', {
    action: 'create',
    workspace: String(workspaceWork.id),
    requestId: `${requestId}-task`,
    goal: taskText,
    ...card,
  })
  const taskId = (valueOf(created) as { taskId: string }).taskId
  await attachDispatchTaskSession(
    mounted.ctx,
    { workspaceId: String(workspaceWork.id), taskId, sessionId: String(worker.session.id) },
    { session: superAgent.session },
  )
  return taskId
}

/**
 * Poll a predicate until it holds.
 * @param predicate - condition to await.
 * @param timeoutMs - bound before the spec fails.
 */
async function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the turn-end hook')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/**
 * Read one task through the real tool.
 * @param taskId - task to read.
 * @returns the task view fields the report asserts.
 */
async function readTaskView(taskId: string): Promise<{
  status: string
  targetSessionId?: string
  dispatcherSessionId?: string
  receipts: { requestId?: string; status: string; note?: string }[]
}> {
  const result = await callTool(mounted.ctx, superAgent, 'workspace_tasks', {
    action: 'get', workspace: String(workspaceWork.id), taskId,
  })
  return (valueOf(result) as { task: {
    status: string
    targetSessionId?: string
    dispatcherSessionId?: string
    receipts: { requestId?: string; status: string; note?: string }[]
  } }).task
}

test('an executor turn end reports to the bound dispatcher without polling', async () => {
  const taskId = await bindTask('fix the parser', 'report-1')
  const assistant = createAssistantMessage({
    content: [{ type: 'text', text: 'Fixed the parser and ran the focused tests.' }],
    source: { provider: 'test', model: 'test' },
  })
  executor.session.append('assistant/message', { turn: 1, step: 1, stream: [], message: assistant }, { surfaceOp: 'append' })
  const turnEnd = executor.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  await until(() => controller.prompts.length === 1)
  const delivered = controller.prompts[0]!
  expect(delivered.request.sessionId).toBe(String(superAgent.session.id))
  expect(delivered.request.mode).toBe('queue')
  expect(delivered.text).toContain('[task-report]')
  expect(delivered.text).toContain(taskId)
  expect(delivered.text).toContain(String(executor.session.id))
  expect(delivered.text).toContain('waiting_review')
  expect(delivered.text).toContain('Fixed the parser and ran the focused tests.')
  expect(delivered.text.length).toBeLessThanOrEqual(600)

  // The dispatcher's own Session log carries the admitted report: no poll was made.
  const logged = superAgent.session.snapshotEvents().find(event =>
    event.type === 'user/message'
    && event.data.content.some(block => block.type === 'text' && block.text.includes('[task-report]')))
  expect(logged).toBeDefined()

  const task = await readTaskView(taskId)
  expect(task.status).toBe('waiting_review')
  expect(task.targetSessionId).toBe(String(executor.session.id))
  expect(task.dispatcherSessionId).toBe(String(superAgent.session.id))
  expect(task.receipts).toHaveLength(1)
  expect(task.receipts[0]?.requestId).toBe(`task-report-${taskId}-turn-1`)
  expect(task.receipts[0]?.status).toBe('waiting_review')

  const read = await callTool(mounted.ctx, superAgent, 'workspace_message', {
    action: 'read', workspace: String(workspaceWork.id),
  })
  const messages = (valueOf(read) as { messages: {
    taskId?: string
    sourceSessionId: string
    targetSessionId: string
    status: string
    text: string
  }[] }).messages
  expect(messages).toHaveLength(1)
  expect(messages[0]?.taskId).toBe(taskId)
  expect(messages[0]?.sourceSessionId).toBe(String(executor.session.id))
  expect(messages[0]?.targetSessionId).toBe(String(superAgent.session.id))
  expect(messages[0]?.status).toBe('delivered')

  // A replayed turn end changes neither the delivery nor the receipt.
  const replay: TurnEndInput = { agent: executor, session: executor.session, turn: 1, event: turnEnd, signal: new AbortController().signal }
  await reportTurnEnd(mounted.ctx, replay)
  await reportTurnEnd(mounted.ctx, replay)
  expect(controller.prompts).toHaveLength(1)
  expect((await readTaskView(taskId)).receipts).toHaveLength(1)
  const afterReplay = await callTool(mounted.ctx, superAgent, 'workspace_message', {
    action: 'read', workspace: String(workspaceWork.id),
  })
  expect((valueOf(afterReplay) as { messages: unknown[] }).messages).toHaveLength(1)

  // Reopening the task and replaying still reuses the delivered message by its
  // stable request id instead of admitting a second copy.
  await callTool(mounted.ctx, superAgent, 'workspace_tasks', {
    action: 'update', workspace: String(workspaceWork.id), taskId, status: 'in_progress', requestId: 'report-1-reopen',
  })
  await reportTurnEnd(mounted.ctx, replay)
  expect(controller.prompts).toHaveLength(1)
  expect((await readTaskView(taskId)).receipts).toHaveLength(1)

  // The dispatcher's own turn end is not a task completion and reports nothing.
  superAgent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(controller.prompts).toHaveLength(1)
})

test('a failed executor turn reports blocked and records no conclusion text', async () => {
  const worker = await createRoot(mounted, 'report-executor-failed', projectWork)
  await workspaceWork.attachSession(worker.session.id)
  const taskId = await bindTask('attempt the migration', 'report-2', worker)

  worker.session.append('turn/end', {
    turn: 1,
    reason: { kind: 'aborted', reason: { kind: 'user' } },
  })
  await until(() => controller.prompts.length === 1)
  expect(controller.prompts[0]?.text).toContain('blocked')
  expect(controller.prompts[0]?.text).toContain('without assistant text')
  const task = await readTaskView(taskId)
  expect(task.status).toBe('blocked')
  expect(task.receipts[0]?.status).toBe('blocked')
})

test('an executor cannot address a foreign Session with an ordinary message send', async () => {
  const within = await callTool(mounted.ctx, executor, 'workspace_message', {
    action: 'send',
    workspace: String(workspaceWork.id),
    targetSessionId: String(superAgent.session.id),
    text: 'not a bound report',
    requestId: 'foreign-send-1',
  })
  expect(within.isError).toBe(true)
  expect(textOf(within)).toContain('is not a session of workspace')

  const across = await callTool(mounted.ctx, executor, 'workspace_message', {
    action: 'send',
    workspace: String(workspaceSuper.id),
    targetSessionId: String(superAgent.session.id),
    text: 'not a bound report',
    requestId: 'foreign-send-2',
  })
  expect(across.isError).toBe(true)
  expect(textOf(across)).toContain('super agent')
})
