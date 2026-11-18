/**
 * Session lifecycle through `workspace_sessions`: the actions that replace the
 * retired super-agent control surface. The Host controller is a recording stub;
 * every call goes through the real tool runtime.
 */
import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  callTool,
  createRoot,
  mountWorkspaceTools,
  registerWorkspace,
  textOf,
  valueOf,
} from './harness.ts'
import type { WorkspaceToolsHarness } from './harness.ts'

/** One Session row the stub controller remembers. */
interface StubSession {
  readonly sessionId: string
  readonly workspaceId?: string
  running: boolean
  title?: string
}

/** A recording Host Session controller with the verbs the lifecycle uses. */
class StubController {
  readonly sessions: StubSession[] = []
  readonly prompts: { readonly sessionId: string; readonly text: string }[] = []
  readonly cancelled: string[] = []
  private next = 0

  async create(request: { readonly workspaceId?: string }): Promise<{ sessionId: string }> {
    const sessionId = `stub-session-${String(++this.next)}`
    this.sessions.push({ sessionId, ...request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId }, running: true })
    return { sessionId }
  }

  async list(): Promise<{ items: readonly { sessionId: string; running: boolean; title?: string; updatedAt: number }[] }> {
    return {
      items: this.sessions.map(session => ({
        sessionId: session.sessionId,
        running: session.running,
        ...session.title === undefined ? {} : { title: session.title },
        updatedAt: this.sessions.indexOf(session),
      })),
    }
  }

  async prompt(
    request: { readonly sessionId: string; readonly content: readonly { readonly text?: string }[] },
    signal: AbortSignal,
  ): Promise<{ accepted: true }> {
    signal.throwIfAborted()
    this.prompts.push({ sessionId: request.sessionId, text: request.content.map(part => part.text ?? '').join('') })
    return { accepted: true }
  }

  async rename(request: { readonly sessionId: string; readonly title: string }): Promise<{ title: string }> {
    const session = this.sessions.find(row => row.sessionId === request.sessionId)
    if (session !== undefined) session.title = request.title
    return { title: request.title }
  }

  async cancel(request: { readonly sessionId: string }): Promise<{ accepted: true }> {
    this.cancelled.push(request.sessionId)
    const session = this.sessions.find(row => row.sessionId === request.sessionId)
    if (session !== undefined) session.running = false
    return { accepted: true }
  }

  async fork(request: { readonly sessionId: string }): Promise<{ sessionId: string }> {
    const sessionId = `stub-fork-${String(++this.next)}`
    const parent = this.sessions.find(row => row.sessionId === request.sessionId)
    this.sessions.push({
      sessionId,
      ...parent?.workspaceId === undefined ? {} : { workspaceId: parent.workspaceId },
      running: false,
    })
    return { sessionId }
  }

  async resolveAgent(): Promise<{ agent: { ctx: { get: () => undefined }; session: object } }> {
    return { agent: { ctx: { get: () => undefined }, session: {} } }
  }

  async delete(sessionId: string): Promise<void> {
    const index = this.sessions.findIndex(row => row.sessionId === sessionId)
    if (index >= 0) this.sessions.splice(index, 1)
  }
}

let projectA: string
let projectB: string
let home: string
let contexts: Context[]
let mounted: WorkspaceToolsHarness
let controller: StubController

beforeEach(async () => {
  projectA = await mkdtemp(join(tmpdir(), 'dsh-workspace-lifecycle-a-'))
  projectB = await mkdtemp(join(tmpdir(), 'dsh-workspace-lifecycle-b-'))
  home = await mkdtemp(join(tmpdir(), 'dsh-workspace-lifecycle-home-'))
  await mkdir(join(projectA, '.git'), { recursive: true })
  await mkdir(join(projectB, '.git'), { recursive: true })
  contexts = []
  controller = new StubController()
  const ctx = new Context()
  contexts.push(ctx)
  mounted = await mountWorkspaceTools(ctx, home)
  mounted.ctx.provide('sessionController' as never, controller as never)
  mounted.ctx.provide('compaction' as never, {
    compactNow: async () => ({ shadowedTokenCount: 3 }),
  } as never)
})

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await rm(projectA, { recursive: true, force: true })
  await rm(projectB, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

test('the super agent starts, continues, stops, aborts, forks, archives, compacts, and deletes a Session', async () => {
  const workspaceB = await registerWorkspace(mounted.registry, projectB, 'lifecycle-target')
  const superAgent = await createRoot(mounted, 'lifecycle-super', projectA, 'super')

  const started = await callTool(mounted.ctx, superAgent, 'workspace_sessions', {
    action: 'start',
    workspace: String(workspaceB.id),
    title: 'implement the thing',
    task: 'do the work',
  })
  expect(started.isError).toBe(false)
  const startValue = valueOf(started) as { started: { sessionId: string; workspace: string; title: string; admitted: boolean } }
  expect(startValue.started.workspace).toBe(String(workspaceB.id))
  expect(startValue.started.title).toBe('implement the thing')
  expect(startValue.started.admitted).toBe(true)
  const sessionId = startValue.started.sessionId
  await workspaceB.attachSession(sessionId as never)
  expect(controller.prompts).toEqual([{ sessionId, text: 'do the work' }])

  const appended = await callTool(mounted.ctx, superAgent, 'workspace_sessions', {
    action: 'append', workspace: String(workspaceB.id), session: sessionId, text: 'second step', delivery: 'interrupt',
  })
  expect(appended.isError).toBe(false)
  expect(textOf(appended)).toContain('interrupt')

  const prompted = await callTool(mounted.ctx, superAgent, 'workspace_sessions', {
    action: 'prompt', workspace: String(workspaceB.id), sessionId, text: 'third step',
  })
  expect(prompted.isError).toBe(false)

  // The stub reports the Session as idle after the first cancel, so make it running
  // again before `stop`/`abort` exercise the running-turn branch.
  const running = controller.sessions.find(row => row.sessionId === sessionId)
  if (running !== undefined) running.running = true
  const stopped = await callTool(mounted.ctx, superAgent, 'workspace_sessions', {
    action: 'stop', workspace: String(workspaceB.id), sessionId,
  })
  expect(stopped.isError).toBe(false)
  expect((valueOf(stopped) as { stopped: { accepted: boolean } }).stopped.accepted).toBe(true)

  if (running !== undefined) running.running = true
  const aborted = await callTool(mounted.ctx, superAgent, 'workspace_sessions', {
    action: 'abort', workspace: String(workspaceB.id), sessionId, text: 'after abort',
  })
  expect(aborted.isError).toBe(false)
  expect((valueOf(aborted) as { aborted: { accepted: boolean; resumed: boolean } }).aborted.resumed).toBe(true)
  expect(controller.cancelled).toEqual([sessionId, sessionId])

  const forked = await callTool(mounted.ctx, superAgent, 'workspace_sessions', {
    action: 'fork', workspace: String(workspaceB.id), sessionId,
  })
  expect(forked.isError).toBe(false)
  const forkId = (valueOf(forked) as { forked: { sessionId: string } }).forked.sessionId
  await workspaceB.attachSession(forkId as never)

  const compacted = await callTool(mounted.ctx, superAgent, 'workspace_sessions', {
    action: 'compact', workspace: String(workspaceB.id), sessionId,
  })
  expect(compacted.isError).toBe(false)
  expect((valueOf(compacted) as { compacted: { compacted: boolean; shadowedTokens: number } }).compacted.compacted).toBe(true)

  const archived = await callTool(mounted.ctx, superAgent, 'workspace_sessions', {
    action: 'archive', workspace: String(workspaceB.id), sessionId,
  })
  expect(archived.isError).toBe(false)
  expect((valueOf(archived) as { archived: { archived: boolean } }).archived.archived).toBe(true)

  const deleted = await callTool(mounted.ctx, superAgent, 'workspace_sessions', {
    action: 'delete', workspace: String(workspaceB.id), sessionId, confirm: sessionId,
  })
  expect(deleted.isError).toBe(false)
  expect(controller.sessions.some(row => row.sessionId === sessionId)).toBe(false)
})

test('an ordinary root cannot start, stop, or delete a Session', async () => {
  const workspaceB = await registerWorkspace(mounted.registry, projectB, 'ordinary-target')
  const ordinary = await createRoot(mounted, 'ordinary-lifecycle', projectA, 'agent')
  for (const args of [
    { action: 'start', workspace: String(workspaceB.id), title: 'x', task: 'y' },
    { action: 'stop', workspace: String(workspaceB.id), sessionId: 'stub-session-1' },
    { action: 'delete', workspace: String(workspaceB.id), sessionId: 'stub-session-1', confirm: 'stub-session-1' },
  ]) {
    const refused = await callTool(mounted.ctx, ordinary, 'workspace_sessions', args)
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toContain('requires the super agent role')
  }
  expect(controller.sessions).toEqual([])
})
