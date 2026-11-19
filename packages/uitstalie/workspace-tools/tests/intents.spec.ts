/**
 * Intent-card behavior of the workspace toolset: source annotations, per-version
 * confirmation, cross-workspace splitting, corrections, coverage enforcement,
 * the receipt gate, the dispatch error codes, idempotency, paging, and the role
 * rules from the memory-scoping design (section 11).
 */
import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type {} from '../src/service.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import {
  callTool,
  createRoot,
  mountWorkspaceTools,
  objectValue,
  registerWorkspace,
  textOf,
  valueOf,
} from './harness.ts'
import type { TestWorkspace, WorkspaceToolsHarness } from './harness.ts'

let projectA: string
let projectB: string
let projectSuper: string
let home: string
let contexts: Context[]
let mounted: WorkspaceToolsHarness
let workspaceA: TestWorkspace
let workspaceB: TestWorkspace
let workspaceSuper: TestWorkspace
let superAgent: Agent
let agentA: Agent

beforeEach(async () => {
  projectA = await mkdtemp(join(tmpdir(), 'dsh-intents-a-'))
  projectB = await mkdtemp(join(tmpdir(), 'dsh-intents-b-'))
  projectSuper = await mkdtemp(join(tmpdir(), 'dsh-intents-super-'))
  home = await mkdtemp(join(tmpdir(), 'dsh-intents-home-'))
  for (const directory of [projectA, projectB, projectSuper]) await mkdir(join(directory, '.git'), { recursive: true })
  contexts = []
  const ctx = new Context()
  contexts.push(ctx)
  mounted = await mountWorkspaceTools(ctx, home)
  workspaceA = await registerWorkspace(mounted.registry, projectA, 'a')
  workspaceB = await registerWorkspace(mounted.registry, projectB, 'b')
  workspaceSuper = await registerWorkspace(mounted.registry, projectSuper, 'super')
  superAgent = await createRoot(mounted, 'session-super', projectSuper, 'super')
  await workspaceSuper.attachSession(superAgent.session.id)
  agentA = await createRoot(mounted, 'session-a', projectA)
  await workspaceA.attachSession(agentA.session.id)
})

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const directory of [projectA, projectB, projectSuper, home]) await rm(directory, { recursive: true, force: true })
})

/** One card item as the tests supply it. */
interface ItemInput {
  text: string
  source: 'user-verbatim' | 'user-anchor' | 'inference'
  anchor?: { path: string; heading?: string }
  reason?: string
}

/** Items grouped by card part. */
interface ItemsInput {
  goal: ItemInput[]
  acceptance: ItemInput[]
  boundaries: ItemInput[]
  outputForm: ItemInput[]
}

/** One returned card version, as the tests read it. */
interface CardValue {
  intentId: string
  version: number
  status: string
  rawUserText: string
  items: Record<'goal' | 'acceptance' | 'boundaries' | 'outputForm', { point: string; text: string; source: string; confirmedAt?: string }[]>
  confirmation?: { requestId: string; items: { point: string; text: string; reason: string }[] }
}

/** One returned task identity. */
interface TaskIdentity {
  taskId: string
  status: string
  createdAt?: string
  replayed?: boolean
}

/** Stable error code of a failed call. */
function codeOf(result: ToolExecutionResult): string | undefined {
  return result.isError ? result.error.info?.code : undefined
}

/** Assert one call failed with a code and return its message. */
function expectCode(result: ToolExecutionResult, code: string): string {
  expect(result.isError).toBe(true)
  expect(codeOf(result)).toBe(code)
  return textOf(result)
}

/** Read the returned card version. */
function cardOf(result: ToolExecutionResult): CardValue {
  return objectValue<{ intent: CardValue }>(valueOf(result)).intent
}

/** Read the returned task identity. */
function taskOf(result: ToolExecutionResult): TaskIdentity {
  return objectValue<TaskIdentity>(valueOf(result))
}

const RAW_TRACEABLE = 'Add a small helper. Keep the build green. Do not touch the README. Return a patch.'
const TRACEABLE_ITEMS: ItemsInput = {
  goal: [{ text: 'Add a small helper', source: 'user-verbatim' }],
  acceptance: [{ text: 'Keep the build green', source: 'user-verbatim' }],
  boundaries: [{ text: 'Do not touch the README', source: 'user-anchor', anchor: { path: 'docs/subsystems/workspace.md', heading: 'Scope' } }],
  outputForm: [{ text: 'Return a patch', source: 'user-verbatim' }],
}
const TRACEABLE_BRIEF = {
  goal: 'Add a small helper and keep the build green',
  acceptance: ['Keep the build green'],
  boundaries: ['Do not touch the README'],
  outputForm: ['Return a patch'],
}
const TRACEABLE_COVERAGE = [
  { point: 'goal[0]', brief: 'Add a small helper and keep the build green' },
  { point: 'acceptance[0]', brief: 'Keep the build green' },
  { point: 'boundaries[0]', brief: 'Do not touch the README' },
  { point: 'outputForm[0]', brief: 'Return a patch' },
]

/**
 * Create one card through the tool.
 * @param workspace - target workspace id.
 * @param requestId - idempotency key.
 * @param rawUserText - the user's words.
 * @param items - source-annotated items.
 * @returns the returned card version.
 */
async function createCard(
  workspace: TestWorkspace,
  requestId: string,
  rawUserText: string,
  items: ItemsInput,
): Promise<CardValue> {
  const result = await callTool(mounted.ctx, superAgent, 'workspace_intents', {
    action: 'create',
    workspace: String(workspace.id),
    requestId,
    rawUserText,
    items,
  })
  return cardOf(result)
}

/**
 * Dispatch one task through the tool.
 * @param workspace - target workspace id.
 * @param requestId - idempotency key.
 * @param card - card the task references.
 * @param brief - task brief and coverage.
 * @param extra - optional coverage waivers or other arguments.
 * @returns the tool result.
 */
async function createTask(
  workspace: TestWorkspace,
  requestId: string,
  card: Pick<CardValue, 'intentId' | 'version'>,
  brief: { goal: string; acceptance: string[]; boundaries: string[]; outputForm?: string[] },
  extra: Record<string, unknown> = {},
): Promise<ToolExecutionResult> {
  return await callTool(mounted.ctx, superAgent, 'workspace_tasks', {
    action: 'create',
    workspace: String(workspace.id),
    requestId,
    intentId: card.intentId,
    intentVersion: card.version,
    taskType: 'fix',
    ...brief,
    ...extra,
  })
}

/**
 * Move one task through the state machine.
 * @param workspace - target workspace id.
 * @param taskId - task to move.
 * @param status - target state.
 * @param requestId - idempotency key.
 * @returns the tool result.
 */
async function updateTask(
  workspace: TestWorkspace,
  taskId: string,
  status: string,
  requestId: string,
): Promise<ToolExecutionResult> {
  return await callTool(mounted.ctx, superAgent, 'workspace_tasks', {
    action: 'update',
    workspace: String(workspace.id),
    taskId,
    status,
    requestId,
  })
}

/**
 * Mark one task in progress as the dispatcher.
 * @param workspace - target workspace id.
 * @param taskId - task to start.
 */
let startCounter = 0
async function startTask(workspace: TestWorkspace, taskId: string): Promise<void> {
  startCounter += 1
  const started = await updateTask(workspace, taskId, 'in_progress', `start-${taskId}-${String(startCounter)}`)
  expect(started.isError).toBe(false)
}

/**
 * Build one alignment for a card version.
 * @param card - card version.
 * @param acceptance - acceptance statuses by point.
 * @param boundaries - boundary statuses by point.
 * @returns the alignment argument.
 */
function alignmentOf(
  card: Pick<CardValue, 'intentId' | 'version'>,
  acceptance: { point: string; status: 'satisfied' | 'not_satisfied' | 'out_of_scope'; evidence: string }[],
  boundaries: { point: string; status: 'respected' | 'violated'; evidence: string }[],
): Record<string, unknown> {
  return { intentId: card.intentId, intentVersion: card.version, acceptance, boundaries, outputForm: [] }
}

test('§11.10(1) a fully traceable card becomes active and dispatches without confirmation', async () => {
  const card = await createCard(workspaceA, 'card-traceable', RAW_TRACEABLE, TRACEABLE_ITEMS)
  expect(card).toMatchObject({ status: 'active', version: 1, rawUserText: RAW_TRACEABLE })
  expect(card.confirmation).toBeUndefined()

  const dispatched = await createTask(workspaceA, 'task-traceable', card, TRACEABLE_BRIEF, { coverage: TRACEABLE_COVERAGE })
  expect(dispatched.isError).toBe(false)
  const task = taskOf(dispatched)
  expect(task.status).toBe('pending')

  const read = await callTool(mounted.ctx, agentA, 'workspace_tasks', { action: 'get', taskId: task.taskId })
  expect(read.isError).toBe(false)
  expect(valueOf(read)).toMatchObject({
    task: {
      taskId: task.taskId,
      status: 'pending',
      intentId: card.intentId,
      intentVersion: 1,
      coverage: TRACEABLE_COVERAGE,
    },
  })
})

test('§11.10(2) an inferred card is proposed, dispatch refuses it, one confirmation unblocks reuse', async () => {
  const raw = 'Make the test suite pass.'
  const items: ItemsInput = {
    goal: [{ text: 'Make the test suite pass', source: 'user-verbatim' }],
    acceptance: [{ text: 'All tests pass', source: 'inference', reason: 'the user implied the test suite must be green' }],
    boundaries: [],
    outputForm: [],
  }
  const card = await createCard(workspaceA, 'card-inferred', raw, items)
  expect(card.status).toBe('proposed')
  expect(card.confirmation?.items).toEqual([{
    point: 'acceptance[0]',
    text: 'All tests pass',
    reason: 'the user implied the test suite must be green',
  }])

  const brief = { goal: 'Make the test suite pass', acceptance: ['All tests pass'], boundaries: [] }
  const coverage = [
    { point: 'goal[0]', brief: 'Make the test suite pass' },
    { point: 'acceptance[0]', brief: 'All tests pass' },
  ]
  const blocked = await createTask(workspaceA, 'task-blocked', card, brief, { coverage })
  expect(expectCode(blocked, 'INTENT_UNCONFIRMED')).toContain(card.confirmation?.requestId ?? 'missing request id')

  const rejected = await callTool(mounted.ctx, superAgent, 'workspace_intents', {
    action: 'confirm',
    workspace: String(workspaceA.id),
    intentId: card.intentId,
    version: card.version,
    decision: 'reject',
    note: 'not the user\'s intent',
    requestId: 'reject-1',
  })
  expect(rejected.isError).toBe(false)
  expect(cardOf(rejected).status).toBe('proposed')
  expect(cardOf(rejected).confirmation?.requestId).toBe(card.confirmation?.requestId)
  expectCode(await createTask(workspaceA, 'task-after-reject', card, brief, { coverage }), 'INTENT_UNCONFIRMED')

  const confirmed = await callTool(mounted.ctx, superAgent, 'workspace_intents', {
    action: 'confirm',
    workspace: String(workspaceA.id),
    intentId: card.intentId,
    version: card.version,
    decision: 'confirm',
    requestId: 'confirm-1',
  })
  expect(confirmed.isError).toBe(false)
  const active = cardOf(confirmed)
  expect(active.status).toBe('active')
  expect(active.items.acceptance[0]?.confirmedAt).toBeDefined()
  expect(active.confirmation).toBeUndefined()

  const dispatched = await createTask(workspaceA, 'task-after-confirm', card, brief, { coverage })
  expect(dispatched.isError).toBe(false)
  expect(taskOf(dispatched).status).toBe('pending')

  const reused = await createTask(workspaceA, 'task-reuse', card, brief, { coverage })
  expect(reused.isError).toBe(false)
  expect(taskOf(reused).taskId).not.toBe(taskOf(dispatched).taskId)
})

test('§11.10(3) one cross-workspace request creates one card per workspace and refuses a foreign card', async () => {
  const raw = 'Add a helper in both workspaces and keep each build green.'
  const items: ItemsInput = {
    goal: [{ text: 'Add a helper', source: 'user-verbatim' }],
    acceptance: [{ text: 'keep each build green', source: 'user-verbatim' }],
    boundaries: [],
    outputForm: [],
  }
  const cardA = await createCard(workspaceA, 'card-a', raw, items)
  const cardB = await createCard(workspaceB, 'card-b', raw, items)
  expect(cardA.intentId).not.toBe(cardB.intentId)
  expect(cardA.rawUserText).toBe(cardB.rawUserText)
  expect(new TextEncoder().encode(cardA.rawUserText)).toEqual(new TextEncoder().encode(cardB.rawUserText))

  const coverage = [
    { point: 'goal[0]', brief: 'Add a helper' },
    { point: 'acceptance[0]', brief: 'keep each build green' },
  ]
  const brief = { goal: 'Add a helper', acceptance: ['keep each build green'], boundaries: [] }
  const own = await createTask(workspaceA, 'task-own', cardA, brief, { coverage })
  expect(own.isError).toBe(false)

  const foreign = await createTask(workspaceA, 'task-foreign', cardB, brief, { coverage })
  const message = expectCode(foreign, 'INTENT_SCOPE_MISMATCH')
  expect(message).toContain(String(workspaceB.id))
})

test('§11.10(4) a correction appends version 2, supersedes version 1, and old items stay readable', async () => {
  const raw = 'Add a helper and keep the build green. Do not touch the README.'
  const v1Items: ItemsInput = {
    goal: [{ text: 'Add a helper', source: 'user-verbatim' }],
    acceptance: [{ text: 'keep the build green', source: 'user-verbatim' }],
    boundaries: [],
    outputForm: [],
  }
  const card = await createCard(workspaceA, 'card-correct', raw, v1Items)
  expect(card.status).toBe('active')

  const v2Items: ItemsInput = {
    goal: [{ text: 'Add a helper and keep the build green', source: 'user-verbatim' }],
    acceptance: [{ text: 'keep the build green', source: 'user-verbatim' }],
    boundaries: [{ text: 'Do not touch the README', source: 'user-verbatim' }],
    outputForm: [],
  }
  const corrected = await callTool(mounted.ctx, superAgent, 'workspace_intents', {
    action: 'correct',
    workspace: String(workspaceA.id),
    intentId: card.intentId,
    requestId: 'correct-1',
    reason: 'the user restated the goal and added a boundary',
    correctionText: 'Add a helper and keep the build green. Do not touch the README.',
    items: v2Items,
  })
  expect(corrected.isError).toBe(false)
  const version2 = cardOf(corrected)
  expect(version2).toMatchObject({ version: 2, status: 'active', supersedesVersion: 1 })

  const old = await callTool(mounted.ctx, superAgent, 'workspace_intents', {
    action: 'get',
    workspace: String(workspaceA.id),
    intentId: card.intentId,
    version: 1,
  })
  expect(old.isError).toBe(false)
  const version1 = cardOf(old)
  expect(version1.status).toBe('superseded')
  expect(version1.items.goal[0]?.text).toBe('Add a helper')
  expect(version1.items.boundaries).toEqual([])

  const history = await callTool(mounted.ctx, superAgent, 'workspace_intents', {
    action: 'history',
    workspace: String(workspaceA.id),
    intentId: card.intentId,
  })
  expect(history.isError).toBe(false)
  expect((valueOf(history) as { versions: { version: number; status: string }[] }).versions).toMatchObject([
    { version: 2, status: 'active' },
    { version: 1, status: 'superseded' },
  ])

  const coverage = [
    { point: 'goal[0]', brief: 'Add a helper and keep the build green' },
    { point: 'acceptance[0]', brief: 'keep the build green' },
    { point: 'boundaries[0]', brief: 'Do not touch the README' },
  ]
  const brief = {
    goal: 'Add a helper and keep the build green',
    acceptance: ['keep the build green'],
    boundaries: ['Do not touch the README'],
  }
  const current = await createTask(workspaceA, 'task-v2', version2, brief, { coverage })
  expect(current.isError).toBe(false)

  const stale = await createTask(workspaceA, 'task-v1', card, brief, { coverage })
  expectCode(stale, 'INTENT_STALE')
})

test('§11.10(5) coverage is enforced and an explicit non-coverage reason is the only waiver', async () => {
  const raw = 'Write a report and make the tests pass.'
  const card = await createCard(workspaceB, 'card-coverage', raw, {
    goal: [{ text: 'Write a report', source: 'user-verbatim' }],
    acceptance: [{ text: 'make the tests pass', source: 'user-verbatim' }],
    boundaries: [],
    outputForm: [],
  })
  const brief = { goal: 'Write a report', acceptance: [], boundaries: [] }
  const partial = [{ point: 'goal[0]', brief: 'Write a report' }]
  const missing = await createTask(workspaceB, 'task-missing', card, brief, { coverage: partial })
  const message = expectCode(missing, 'INTENT_COVERAGE_MISSING')
  expect(message).toContain('acceptance[0]')

  const waived = await createTask(workspaceB, 'task-waived', card, brief, {
    coverage: partial,
    nonCoverage: [{ point: 'acceptance[0]', reason: 'the test suite belongs to a follow-up task' }],
  })
  expect(waived.isError).toBe(false)
  expect(valueOf(waived)).toMatchObject({ status: 'pending' })

  const covered = await createTask(
    workspaceB,
    'task-covered',
    card,
    { goal: 'Write a report', acceptance: ['make the tests pass'], boundaries: [] },
    {
      coverage: [
        { point: 'goal[0]', brief: 'Write a report' },
        { point: 'acceptance[0]', brief: 'make the tests pass' },
      ],
    },
  )
  expect(covered.isError).toBe(false)
})

test('§11.10(6) a receipt with a deviation cannot move the task to done', async () => {
  const raw = 'Implement the fix, keep the tests passing, and do not change the docs.'
  const card = await createCard(workspaceA, 'card-receipt', raw, {
    goal: [{ text: 'Implement the fix', source: 'user-verbatim' }],
    acceptance: [{ text: 'keep the tests passing', source: 'user-verbatim' }],
    boundaries: [{ text: 'do not change the docs', source: 'user-verbatim' }],
    outputForm: [],
  })
  const created = await createTask(
    workspaceA,
    'task-receipt',
    card,
    {
      goal: 'Implement the fix',
      acceptance: ['keep the tests passing'],
      boundaries: ['do not change the docs'],
    },
    {
      coverage: [
        { point: 'goal[0]', brief: 'Implement the fix' },
        { point: 'acceptance[0]', brief: 'keep the tests passing' },
        { point: 'boundaries[0]', brief: 'do not change the docs' },
      ],
    },
  )
  expect(created.isError).toBe(false)
  const taskId = taskOf(created).taskId
  await startTask(workspaceA, taskId)

  const noAlignment = await updateTask(workspaceA, taskId, 'done', 'done-no-alignment')
  expectCode(noAlignment, 'INTENT_ALIGNMENT_MISSING')

  const incompleteAlignment = await callTool(mounted.ctx, superAgent, 'workspace_tasks', {
    action: 'receipt',
    workspace: String(workspaceA.id),
    taskId,
    status: 'done',
    requestId: 'receipt-incomplete',
    alignment: alignmentOf(card,
      [{ point: 'acceptance[0]', status: 'satisfied', evidence: 'the suite passes' }],
      []),
  })
  expectCode(incompleteAlignment, 'INTENT_ALIGNMENT_INCOMPLETE')

  const unsatisfied = await callTool(mounted.ctx, superAgent, 'workspace_tasks', {
    action: 'receipt',
    workspace: String(workspaceA.id),
    taskId,
    status: 'done',
    requestId: 'receipt-unsatisfied',
    alignment: alignmentOf(card,
      [{ point: 'acceptance[0]', status: 'not_satisfied', evidence: 'the suite still fails' }],
      [{ point: 'boundaries[0]', status: 'respected', evidence: 'git diff shows no docs change' }]),
  })
  expect(unsatisfied.isError).toBe(false)
  expect(valueOf(unsatisfied)).toMatchObject({ status: 'waiting_review' })
  expect((valueOf(unsatisfied) as { deviations: string[] }).deviations).toContain('acceptance acceptance[0]: not_satisfied')
  const afterUnsatisfied = await callTool(mounted.ctx, agentA, 'workspace_tasks', { action: 'get', taskId })
  expect((valueOf(afterUnsatisfied) as { task: { status: string } }).task.status).toBe('waiting_review')
  expectCode(await updateTask(workspaceA, taskId, 'done', 'done-deviation'), 'INTENT_ALIGNMENT_UNSATISFIED')

  await startTask(workspaceA, taskId)
  const violated = await callTool(mounted.ctx, superAgent, 'workspace_tasks', {
    action: 'receipt',
    workspace: String(workspaceA.id),
    taskId,
    status: 'done',
    requestId: 'receipt-violated',
    alignment: alignmentOf(card,
      [{ point: 'acceptance[0]', status: 'satisfied', evidence: 'the suite passes' }],
      [{ point: 'boundaries[0]', status: 'violated', evidence: 'docs/subsystems/workspace.md changed' }]),
  })
  expect(violated.isError).toBe(false)
  expect(valueOf(violated)).toMatchObject({ status: 'blocked' })
  expect((valueOf(violated) as { deviations: string[] }).deviations).toContain('boundary boundaries[0]: violated')
  const afterViolated = await callTool(mounted.ctx, agentA, 'workspace_tasks', { action: 'get', taskId })
  expect((valueOf(afterViolated) as { task: { status: string } }).task.status).toBe('blocked')

  await startTask(workspaceA, taskId)
  const passed = await callTool(mounted.ctx, superAgent, 'workspace_tasks', {
    action: 'receipt',
    workspace: String(workspaceA.id),
    taskId,
    status: 'done',
    requestId: 'receipt-passed',
    alignment: alignmentOf(card,
      [{ point: 'acceptance[0]', status: 'satisfied', evidence: 'the suite passes' }],
      [{ point: 'boundaries[0]', status: 'respected', evidence: 'git diff shows no docs change' }]),
  })
  expect(passed.isError).toBe(false)
  expect(valueOf(passed)).toMatchObject({ status: 'done' })
  const done = await callTool(mounted.ctx, agentA, 'workspace_tasks', { action: 'get', taskId })
  expect((valueOf(done) as { task: { status: string } }).task.status).toBe('done')

  const receiptRetry = await callTool(mounted.ctx, superAgent, 'workspace_tasks', {
    action: 'receipt',
    workspace: String(workspaceA.id),
    taskId,
    status: 'done',
    requestId: 'receipt-passed',
    note: 'retry',
  })
  expect(receiptRetry.isError).toBe(false)
  expect(valueOf(receiptRetry)).toMatchObject({ replayed: true, status: 'done' })
})

test('an agent in the workspace may write cards and tasks; a cross-workspace write still needs the super agent', async () => {
  const card = await createCard(workspaceA, 'card-roles', RAW_TRACEABLE, TRACEABLE_ITEMS)
  const ordinaryCard = await callTool(mounted.ctx, agentA, 'workspace_intents', {
    action: 'create',
    workspace: String(workspaceA.id),
    requestId: 'ordinary-card',
    rawUserText: RAW_TRACEABLE,
    items: TRACEABLE_ITEMS,
  })
  expect(ordinaryCard.isError).toBe(false)
  expect((valueOf(ordinaryCard) as { intentId: string }).intentId).toBe(card.intentId)

  const ordinaryTask = await callTool(mounted.ctx, agentA, 'workspace_tasks', {
    action: 'create',
    workspace: String(workspaceA.id),
    requestId: 'ordinary-task-2',
    intentId: card.intentId,
    intentVersion: card.version,
    taskType: 'fix',
    ...TRACEABLE_BRIEF,
    coverage: TRACEABLE_COVERAGE,
  })
  expect(ordinaryTask.isError).toBe(false)
  const ordinaryTaskId = (valueOf(ordinaryTask) as { taskId: string }).taskId
  const readTaskAsOrdinary = await callTool(mounted.ctx, agentA, 'workspace_tasks', {
    action: 'get',
    workspace: String(workspaceA.id),
    taskId: ordinaryTaskId,
  })
  expect(readTaskAsOrdinary.isError).toBe(false)
  expect((valueOf(readTaskAsOrdinary) as { task: { dispatcherSessionId?: string } }).task.dispatcherSessionId)
    .toBe(String(agentA.session.id))

  const readAsOrdinary = await callTool(mounted.ctx, agentA, 'workspace_intents', {
    action: 'get',
    workspace: String(workspaceA.id),
    intentId: card.intentId,
  })
  expect(readAsOrdinary.isError).toBe(false)

  const confirmAsOrdinary = await callTool(mounted.ctx, agentA, 'workspace_intents', {
    action: 'confirm',
    workspace: String(workspaceA.id),
    intentId: card.intentId,
    version: card.version,
    decision: 'confirm',
    requestId: 'ordinary-confirm',
  })
  expect(confirmAsOrdinary.isError).toBe(false)

  const crossWorkspaceCard = await callTool(mounted.ctx, agentA, 'workspace_intents', {
    action: 'create',
    workspace: String(workspaceB.id),
    requestId: 'ordinary-cross-card',
    rawUserText: RAW_TRACEABLE,
    items: TRACEABLE_ITEMS,
  })
  expectCode(crossWorkspaceCard, 'INTENT_PERMISSION_DENIED')

  const incomplete = await callTool(mounted.ctx, superAgent, 'workspace_tasks', {
    action: 'create',
    requestId: 'task-incomplete',
    goal: 'Add a small helper',
  })
  expect(expectCode(incomplete, 'INTENT_INCOMPLETE')).toContain('workspace')

  const unknownCard = await createTask(workspaceA, 'task-unknown-card', { intentId: 'intent-missing', version: 1 }, TRACEABLE_BRIEF, { coverage: TRACEABLE_COVERAGE })
  expectCode(unknownCard, 'INTENT_INCOMPLETE')

  const unregistered = await callTool(mounted.ctx, superAgent, 'workspace_intents', {
    action: 'create',
    workspace: join(projectA, 'nested'),
    requestId: 'card-unregistered',
    rawUserText: RAW_TRACEABLE,
    items: TRACEABLE_ITEMS,
  })
  expectCode(unregistered, 'WORKSPACE_NOT_REGISTERED')
})

test('a task with only a goal gets defaults and a generated request id', async () => {
  const created = await callTool(mounted.ctx, superAgent, 'workspace_tasks', {
    action: 'create',
    workspace: String(workspaceA.id),
    goal: 'Only the goal is required',
  })
  expect(created.isError).toBe(false)
  const firstId = (valueOf(created) as { taskId: string }).taskId

  const again = await callTool(mounted.ctx, superAgent, 'workspace_tasks', {
    action: 'create',
    workspace: String(workspaceA.id),
    goal: 'Only the goal is required',
  })
  expect(again.isError).toBe(false)
  const secondId = (valueOf(again) as { taskId: string }).taskId
  expect(secondId).not.toBe(firstId)

  const read = await callTool(mounted.ctx, superAgent, 'workspace_tasks', {
    action: 'get', workspace: String(workspaceA.id), taskId: firstId,
  })
  const task = (valueOf(read) as {
    task: { acceptance: string[]; boundaries: string[]; taskType?: string; requestId?: string }
  }).task
  expect(task.acceptance).toEqual([])
  expect(task.boundaries).toEqual([])
  expect(task.taskType).toBe('other')
  expect(task.requestId).toBeTypeOf('string')
  expect(task.requestId).not.toBe('')

  const secondRead = await callTool(mounted.ctx, superAgent, 'workspace_tasks', {
    action: 'get', workspace: String(workspaceA.id), taskId: secondId,
  })
  const secondRequestId = (valueOf(secondRead) as { task: { requestId: string } }).task.requestId
  expect(secondRequestId).not.toBe(task.requestId)

  // A receipt without requestId still completes a cardless task.
  await startTask(workspaceA, firstId)
  const receipt = await callTool(mounted.ctx, superAgent, 'workspace_tasks', {
    action: 'receipt', workspace: String(workspaceA.id), taskId: firstId, status: 'done',
  })
  expect(receipt.isError, textOf(receipt)).toBe(false)
})

test('an intent card create without requestId works', async () => {
  const created = await callTool(mounted.ctx, superAgent, 'workspace_intents', {
    action: 'create',
    workspace: String(workspaceA.id),
    rawUserText: RAW_TRACEABLE,
    items: TRACEABLE_ITEMS,
  })
  expect(created.isError, textOf(created)).toBe(false)
  expect((valueOf(created) as { intent: { intentId: string } }).intent.intentId).toBeTypeOf('string')
})

test('a task without an intent card records and completes without an alignment checklist', async () => {
  const created = await callTool(mounted.ctx, superAgent, 'workspace_tasks', {
    action: 'create',
    workspace: String(workspaceA.id),
    requestId: 'task-cardless',
    taskType: 'fix',
    goal: 'Fix the flaky test',
    acceptance: ['the suite is stable'],
    boundaries: ['do not touch docs'],
  })
  expect(created.isError).toBe(false)
  const taskId = taskOf(created).taskId
  await startTask(workspaceA, taskId)

  const done = await callTool(mounted.ctx, superAgent, 'workspace_tasks', {
    action: 'receipt',
    workspace: String(workspaceA.id),
    taskId,
    status: 'done',
    requestId: 'receipt-cardless',
  })
  expect(done.isError).toBe(false)
  expect(valueOf(done)).toMatchObject({ status: 'done' })

  const read = await callTool(mounted.ctx, superAgent, 'workspace_tasks', {
    action: 'get', workspace: String(workspaceA.id), taskId,
  })
  const task = (valueOf(read) as { task: { intentId?: string; intentVersion?: number; status: string } }).task
  expect(task.intentId).toBeUndefined()
  expect(task.intentVersion).toBeUndefined()
  expect(task.status).toBe('done')

  const partial = await callTool(mounted.ctx, superAgent, 'workspace_tasks', {
    action: 'create',
    workspace: String(workspaceA.id),
    requestId: 'task-partial-card',
    intentId: 'intent-anything',
    taskType: 'fix',
    goal: 'Fix the flaky test',
    acceptance: ['the suite is stable'],
    boundaries: ['do not touch docs'],
  })
  expectCode(partial, 'INTENT_INCOMPLETE')

  const coverageOnly = await callTool(mounted.ctx, superAgent, 'workspace_tasks', {
    action: 'create',
    workspace: String(workspaceA.id),
    requestId: 'task-coverage-only',
    taskType: 'fix',
    goal: 'Fix the flaky test',
    acceptance: ['the suite is stable'],
    boundaries: ['do not touch docs'],
    coverage: [{ point: 'goal[0]', brief: 'Fix the flaky test' }],
  })
  expectCode(coverageOnly, 'INTENT_INCOMPLETE')
})

test('mutations are idempotent per requestId and history pages with a cursor', async () => {
  const card = await createCard(workspaceA, 'card-retry', RAW_TRACEABLE, TRACEABLE_ITEMS)
  const replay = await createCard(workspaceA, 'card-retry', RAW_TRACEABLE, TRACEABLE_ITEMS)
  expect(replay.intentId).toBe(card.intentId)
  expect(replay.version).toBe(card.version)

  const first = await createTask(workspaceA, 'task-retry', card, TRACEABLE_BRIEF, { coverage: TRACEABLE_COVERAGE })
  const second = await createTask(workspaceA, 'task-retry', card, TRACEABLE_BRIEF, { coverage: TRACEABLE_COVERAGE })
  expect(taskOf(second)).toMatchObject({ taskId: taskOf(first).taskId, replayed: true })

  const corrected = await callTool(mounted.ctx, superAgent, 'workspace_intents', {
    action: 'correct',
    workspace: String(workspaceA.id),
    intentId: card.intentId,
    requestId: 'correct-paging',
    reason: 'paging fixture',
    items: {
      ...TRACEABLE_ITEMS,
      boundaries: [{ text: 'Do not touch the README', source: 'user-verbatim' }],
    },
  })
  expect(corrected.isError).toBe(false)
  const correctedAgain = await callTool(mounted.ctx, superAgent, 'workspace_intents', {
    action: 'correct',
    workspace: String(workspaceA.id),
    intentId: card.intentId,
    requestId: 'correct-paging-2',
    reason: 'same acceptance point restated',
    items: {
      ...TRACEABLE_ITEMS,
      acceptance: [{ text: 'build green', source: 'user-verbatim' }],
      boundaries: [{ text: 'Do not touch the README', source: 'user-anchor', anchor: { path: 'docs/subsystems/workspace.md' } }],
    },
  })
  expect(correctedAgain.isError).toBe(false)
  const correctedThrice = await callTool(mounted.ctx, superAgent, 'workspace_intents', {
    action: 'correct',
    workspace: String(workspaceA.id),
    intentId: card.intentId,
    requestId: 'correct-paging-3',
    reason: 'the same acceptance point drifted again',
    items: {
      ...TRACEABLE_ITEMS,
      acceptance: [{ text: 'the build green', source: 'user-verbatim' }],
      boundaries: [{ text: 'Do not touch the README', source: 'user-anchor', anchor: { path: 'docs/subsystems/workspace.md' } }],
    },
  })
  expect(correctedThrice.isError).toBe(false)
  const page1 = await callTool(mounted.ctx, superAgent, 'workspace_intents', {
    action: 'history',
    workspace: String(workspaceA.id),
    intentId: card.intentId,
    limit: 1,
  })
  expect(page1.isError).toBe(false)
  const firstPage = valueOf(page1) as { versions: { version: number }[]; nextCursor?: string }
  expect(firstPage.versions).toHaveLength(1)
  expect(firstPage.nextCursor).toBe('1')
  const page2 = await callTool(mounted.ctx, superAgent, 'workspace_intents', {
    action: 'history',
    workspace: String(workspaceA.id),
    intentId: card.intentId,
    limit: 1,
    cursor: firstPage.nextCursor,
  })
  expect((valueOf(page2) as { versions: { version: number }[] }).versions).toHaveLength(1)

  const metrics = await callTool(mounted.ctx, superAgent, 'workspace_intents', {
    action: 'metrics',
    workspace: String(workspaceA.id),
  })
  expect(metrics.isError).toBe(false)
  const value = valueOf(metrics) as { metrics: { windows: { days: number; dispatchedTasks: number; corrections: number }[] } }
  expect(value.metrics.windows.map(window => window.days)).toEqual([7, 30])
  expect(value.metrics.windows[0]?.dispatchedTasks ?? 0).toBeGreaterThanOrEqual(1)
  expect(value.metrics.windows[0]?.corrections ?? 0).toBeGreaterThanOrEqual(3)
  expect((value.metrics.windows[0] as { recurringCorrections?: number }).recurringCorrections ?? 0).toBeGreaterThanOrEqual(1)
})

test('the dispatcher service records the same card-validated task and cancels a failed dispatch', async () => {
  const card = await createCard(workspaceA, 'card-service', RAW_TRACEABLE, TRACEABLE_ITEMS)
  const created = await mounted.ctx.workspaceTasks.createDispatchTask({
    workspaceId: String(workspaceA.id),
    requestId: 'service-task-1',
    intentId: card.intentId,
    intentVersion: card.version,
    taskType: 'fix',
    ...TRACEABLE_BRIEF,
    coverage: TRACEABLE_COVERAGE,
  })
  expect(created.taskId).toMatch(/^task-/u)
  expect(created.status).toBe('pending')

  const read = await callTool(mounted.ctx, superAgent, 'workspace_tasks', {
    action: 'get',
    workspace: String(workspaceA.id),
    taskId: created.taskId,
  })
  expect(read.isError).toBe(false)
  const task = (valueOf(read) as { task: { intentId: string; intentVersion: number; taskType: string; status: string } }).task
  expect(task).toMatchObject({
    intentId: card.intentId,
    intentVersion: card.version,
    taskType: 'fix',
    status: 'pending',
  })

  expect(await mounted.ctx.workspaceTasks.cancelDispatchTask({
    workspaceId: String(workspaceA.id),
    taskId: created.taskId,
    reason: 'the Session could not be started',
  })).toBe(true)
  const cancelled = await callTool(mounted.ctx, superAgent, 'workspace_tasks', {
    action: 'get',
    workspace: String(workspaceA.id),
    taskId: created.taskId,
  })
  expect((valueOf(cancelled) as { task: { status: string } }).task.status).toBe('cancelled')
  expect(await mounted.ctx.workspaceTasks.cancelDispatchTask({
    workspaceId: String(workspaceA.id),
    taskId: created.taskId,
    reason: 'a terminal task must not change',
  })).toBe(false)

  const serviceTask = await mounted.ctx.workspaceTasks.createDispatchTask({
    workspaceId: String(workspaceA.id),
    requestId: 'service-task-2',
    goal: 'no card reference',
  })
  expect(serviceTask.status).toBe('pending')
  const serviceRead = await callTool(mounted.ctx, superAgent, 'workspace_tasks', {
    action: 'get',
    workspace: String(workspaceA.id),
    taskId: serviceTask.taskId,
  })
  expect((valueOf(serviceRead) as { task: { intentId?: string; taskType?: string } }).task)
    .toMatchObject({ taskType: 'other' })
  expect((valueOf(serviceRead) as { task: { intentId?: string } }).task.intentId).toBeUndefined()
})
