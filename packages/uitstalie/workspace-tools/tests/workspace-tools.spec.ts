/**
 * Read-side behavior of the workspace toolset: scope, paging, task, message,
 * and artifact reads, and the artifact resolution statuses. Every assertion
 * runs through a real tool call against the mounted composition.
 */
import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  callTool,
  createRoot,
  mountWorkspaceTools,
  registerWorkspace,
  seedRecord,
  sha256,
  textOf,
  valueOf,
} from './harness.ts'
import type { WorkspaceToolsHarness } from './harness.ts'

let projectA: string
let projectB: string
let home: string
let contexts: Context[]
let mounted: WorkspaceToolsHarness

beforeEach(async () => {
  projectA = await mkdtemp(join(tmpdir(), 'dsh-workspace-tools-a-'))
  projectB = await mkdtemp(join(tmpdir(), 'dsh-workspace-tools-b-'))
  home = await mkdtemp(join(tmpdir(), 'dsh-workspace-tools-home-'))
  // A `.git` marker makes each fixture look like a checkout, as a real workspace does.
  await mkdir(join(projectA, '.git'), { recursive: true })
  await mkdir(join(projectB, '.git'), { recursive: true })
  contexts = []
  const ctx = new Context()
  contexts.push(ctx)
  mounted = await mountWorkspaceTools(ctx, home)
})

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await rm(projectA, { recursive: true, force: true })
  await rm(projectB, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

test('a session sees only its own workspace; a cross-workspace read needs the explicit id', async () => {
  const a = await registerWorkspace(mounted.registry, projectA, 'a')
  const b = await registerWorkspace(mounted.registry, projectB, 'b')
  const agentA = await createRoot(mounted, 'session-a', projectA)
  await a.attachSession(agentA.session.id)
  const agentB = await createRoot(mounted, 'session-b', projectB)
  await b.attachSession(agentB.session.id)

  const own = await callTool(mounted.ctx, agentA, 'workspace_sessions', { action: 'list' })
  expect(own.isError).toBe(false)
  expect(textOf(own)).toContain('session-a')
  expect(textOf(own)).not.toContain('session-b')
  expect(valueOf(own)).toMatchObject({ workspace: String(a.id) })

  const cross = await callTool(mounted.ctx, agentA, 'workspace_sessions', {
    action: 'list',
    workspace: String(b.id),
  })
  expect(cross.isError).toBe(false)
  expect(textOf(cross)).toContain('session-b')
  expect(valueOf(cross)).toMatchObject({ workspace: String(b.id) })

  const implicitCross = await callTool(mounted.ctx, agentA, 'workspace_sessions', {
    action: 'get',
    sessionId: String(agentB.session.id),
  })
  expect(implicitCross.isError).toBe(true)
  expect(textOf(implicitCross)).toContain('is not a session of workspace')

  const unregistered = await callTool(mounted.ctx, agentA, 'workspace_sessions', {
    action: 'list',
    workspace: 'unregistered-workspace',
  })
  expect(unregistered.isError).toBe(true)
  expect(textOf(unregistered)).toContain('is not registered')

  const subdirectory = await callTool(mounted.ctx, agentA, 'workspace_sessions', {
    action: 'list',
    workspace: join(projectA, 'nested'),
  })
  expect(subdirectory.isError).toBe(true)
  expect(textOf(subdirectory)).toContain('is not registered')
})

test('list results are bounded by limit and walkable with the returned cursor', async () => {
  const a = await registerWorkspace(mounted.registry, projectA, 'paged')
  const agents = []
  for (const id of ['paged-1', 'paged-2', 'paged-3']) {
    const agent = await createRoot(mounted, id, projectA)
    await a.attachSession(agent.session.id)
    agents.push(agent)
  }

  const first = await callTool(mounted.ctx, agents[0]!, 'workspace_sessions', { action: 'list', limit: 2 })
  expect(first.isError).toBe(false)
  const firstValue = valueOf(first) as { items?: unknown[]; nextCursor?: string }
  expect(firstValue.items).toHaveLength(2)
  expect(firstValue.nextCursor).toBe('2')

  const second = await callTool(mounted.ctx, agents[0]!, 'workspace_sessions', {
    action: 'list',
    limit: 2,
    cursor: firstValue.nextCursor,
  })
  const secondValue = valueOf(second) as { items?: unknown[]; nextCursor?: string }
  expect(secondValue.items).toHaveLength(1)
  expect(secondValue.nextCursor).toBeUndefined()

  const invalid = await callTool(mounted.ctx, agents[0]!, 'workspace_sessions', { action: 'list', cursor: 'nope' })
  expect(invalid.isError).toBe(true)
  expect(textOf(invalid)).toContain('invalid cursor')
})

test('get reports status, progress, inbox, and artifact counts from the durable records', async () => {
  const a = await registerWorkspace(mounted.registry, projectA, 'detail')
  const agent = await createRoot(mounted, 'detail-session', projectA)
  await a.attachSession(agent.session.id)
  agent.session.append('turn/start', { turn: 3 })
  agent.session.append('assistant/message', {
    turn: 3,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: 'Checking the read side.\nSecond line.' }],
      source: { provider: 'stub', model: 'stub' },
    }),
    stream: [],
  }, { surfaceOp: 'append' })
  await seedRecord(mounted, `workspaces/${String(a.id)}/messages/message-1.json`, {
    messageId: 'message-1',
    workspaceId: String(a.id),
    targetSessionId: String(agent.session.id),
    sourceSessionId: 'source-session',
    text: 'status update',
    kind: 'message',
    priority: 'normal',
    references: [],
    requestId: 'request-1',
    status: 'queued',
    createdAt: '2026-11-17T00:00:00.000Z',
    receipts: [],
  })

  const result = await callTool(mounted.ctx, agent, 'workspace_sessions', {
    action: 'get',
    sessionId: String(agent.session.id),
  })
  expect(result.isError).toBe(false)
  const value = valueOf(result) as {
    session: {
      status: string
      currentTurn: number
      latestProgress?: string
      pendingInbox: number
      artifactCount: number
      recentProgress: { summary: string }[]
    }
  }
  expect(value.session.currentTurn).toBe(3)
  expect(value.session.latestProgress).toContain('Checking the read side.')
  expect(value.session.pendingInbox).toBe(1)
  expect(value.session.artifactCount).toBe(0)
  expect(value.session.recentProgress).toHaveLength(1)
})

test('tasks read by id and by status filter, with receipts and a missing-task refusal', async () => {
  const a = await registerWorkspace(mounted.registry, projectA, 'tasks')
  const agent = await createRoot(mounted, 'task-reader', projectA)
  await a.attachSession(agent.session.id)
  await seedRecord(mounted, `workspaces/${String(a.id)}/tasks/task-1.json`, {
    taskId: 'task-1',
    workspaceId: String(a.id),
    title: 'Read side',
    goal: 'Implement the read side',
    acceptance: ['scope enforced'],
    boundaries: ['no workspace writes'],
    status: 'in_progress',
    assignee: 'agent:reader',
    targetSessionId: String(agent.session.id),
    createdAt: '2026-11-17T00:00:00.000Z',
    updatedAt: '2026-11-17T01:00:00.000Z',
    requestId: 'request-1',
    receipts: [{ receiptId: 'receipt-1', at: '2026-11-17T02:00:00.000Z', status: 'in_progress', note: 'started' }],
    artifactIds: [],
  })

  const one = await callTool(mounted.ctx, agent, 'workspace_tasks', { action: 'get', taskId: 'task-1' })
  expect(one.isError).toBe(false)
  expect(valueOf(one)).toMatchObject({
    workspace: String(a.id),
    task: {
      taskId: 'task-1',
      status: 'in_progress',
      acceptance: ['scope enforced'],
      receipts: [{ receiptId: 'receipt-1', status: 'in_progress' }],
    },
    targetSession: { sessionId: String(agent.session.id) },
    artifacts: [],
  })

  const filtered = await callTool(mounted.ctx, agent, 'workspace_tasks', { action: 'list', status: 'done' })
  expect(filtered.isError).toBe(false)
  expect(valueOf(filtered)).toMatchObject({ items: [] })

  const missing = await callTool(mounted.ctx, agent, 'workspace_tasks', { action: 'get', taskId: 'task-missing' })
  expect(missing.isError).toBe(true)
  expect(textOf(missing)).toContain('holds no task')
})

test('messages read one message or a target session queue, with receipts', async () => {
  const a = await registerWorkspace(mounted.registry, projectA, 'messages')
  const agent = await createRoot(mounted, 'message-reader', projectA)
  await a.attachSession(agent.session.id)
  await seedRecord(mounted, `workspaces/${String(a.id)}/messages/message-1.json`, {
    messageId: 'message-1',
    workspaceId: String(a.id),
    targetSessionId: String(agent.session.id),
    sourceSessionId: 'dispatcher',
    text: 'Conclusion: read side works. Evidence: tests. Next: create.',
    kind: 'followup',
    priority: 'normal',
    references: [{ artifactId: 'artifact-1', version: 1, sha256: 'a'.repeat(64) }],
    requestId: 'request-1',
    status: 'delivered',
    createdAt: '2026-11-17T00:00:00.000Z',
    deliveredAt: '2026-11-17T00:00:05.000Z',
    receipts: [{ at: '2026-11-17T00:00:05.000Z', status: 'delivered' }],
  })

  const byId = await callTool(mounted.ctx, agent, 'workspace_message', { action: 'read', messageId: 'message-1' })
  expect(byId.isError).toBe(false)
  expect(valueOf(byId)).toMatchObject({
    messages: [{
      messageId: 'message-1',
      kind: 'followup',
      status: 'delivered',
      receipts: [{ status: 'delivered' }],
      references: [{ artifactId: 'artifact-1', version: 1 }],
    }],
  })

  const byTarget = await callTool(mounted.ctx, agent, 'workspace_message', {
    action: 'read',
    targetSessionId: String(agent.session.id),
  })
  expect(byTarget.isError).toBe(false)
  expect(valueOf(byTarget)).toMatchObject({ messages: [{ messageId: 'message-1' }] })

  const missing = await callTool(mounted.ctx, agent, 'workspace_message', { action: 'read', messageId: 'missing' })
  expect(missing.isError).toBe(true)
  expect(textOf(missing)).toContain('holds no message')
})

test('artifact resolution distinguishes ok, changed, missing, and denied', async () => {
  const a = await registerWorkspace(mounted.registry, projectA, 'artifacts')
  const agent = await createRoot(mounted, 'artifact-reader', projectA)
  await a.attachSession(agent.session.id)
  await mkdir(join(projectA, 'reports'), { recursive: true })
  const report = join(projectA, 'reports', 'report.md')
  const bytes = new TextEncoder().encode('# report\n')
  await writeFile(report, bytes)
  const publish = (artifactId: string, path: string, hash: string): Record<string, unknown> => ({
    artifactId,
    workspaceId: String(a.id),
    versions: [{
      artifactId,
      workspaceId: String(a.id),
      path,
      sha256: hash,
      size: bytes.byteLength,
      version: 1,
      kind: 'report',
      sessionId: String(agent.session.id),
      createdAt: '2026-11-17T00:00:00.000Z',
    }],
  })
  await seedRecord(mounted, `workspaces/${String(a.id)}/artifacts/artifact-report.json`, publish('artifact-report', 'reports/report.md', sha256(bytes)))

  const listed = await callTool(mounted.ctx, agent, 'workspace_artifacts', { action: 'list' })
  expect(listed.isError).toBe(false)
  expect(valueOf(listed)).toMatchObject({
    items: [{ artifactId: 'artifact-report', version: 1, path: 'reports/report.md' }],
  })

  const ok = await callTool(mounted.ctx, agent, 'workspace_artifacts', { action: 'resolve', artifactId: 'artifact-report' })
  expect(ok.isError).toBe(false)
  expect(valueOf(ok)).toMatchObject({ resolution: { artifactId: 'artifact-report', version: 1, status: 'ok' } })

  await writeFile(report, '# report changed\n')
  const changed = await callTool(mounted.ctx, agent, 'workspace_artifacts', { action: 'resolve', artifactId: 'artifact-report' })
  expect(valueOf(changed)).toMatchObject({ resolution: { status: 'changed' } })

  await rm(report)
  const missing = await callTool(mounted.ctx, agent, 'workspace_artifacts', { action: 'resolve', artifactId: 'artifact-report' })
  expect(valueOf(missing)).toMatchObject({ resolution: { status: 'missing' } })

  await seedRecord(mounted, `workspaces/${String(a.id)}/artifacts/artifact-outside.json`, publish('artifact-outside', '../outside.txt', 'a'.repeat(64)))
  const denied = await callTool(mounted.ctx, agent, 'workspace_artifacts', { action: 'resolve', artifactId: 'artifact-outside' })
  expect(denied.isError).toBe(false)
  expect(valueOf(denied)).toMatchObject({ resolution: { status: 'denied' } })
})

test('archived sessions report done and a phase filter keeps only matching statuses', async () => {
  const a = await registerWorkspace(mounted.registry, projectA, 'status')
  const agent = await createRoot(mounted, 'status-session', projectA)
  await a.attachSession(agent.session.id)
  mounted.registry.archivedSessionIds = [SessionId('status-session')]

  const archived = await callTool(mounted.ctx, agent, 'workspace_sessions', { action: 'list', status: 'done' })
  expect(archived.isError).toBe(false)
  expect(valueOf(archived)).toMatchObject({ items: [{ sessionId: 'status-session', status: 'done' }] })

  const idle = await callTool(mounted.ctx, agent, 'workspace_sessions', { action: 'list', status: 'idle' })
  expect(valueOf(idle)).toMatchObject({ items: [] })
})
