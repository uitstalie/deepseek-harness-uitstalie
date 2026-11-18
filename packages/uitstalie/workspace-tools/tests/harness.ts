/**
 * Real-composition harness for the workspace toolset specs: the real agent
 * loop, session store, session-query service, local filesystem, `.dsh` store,
 * and the dafeiyu organizer with the toolset mounted.
 *
 * The workspace registry is a small in-memory implementation of the consumer
 * interface, because these specs assert scoping rather than registry
 * durability. `$DSH_HOME` points at the fixture directory, so the toolset's
 * records never touch the user's harness home.
 */
import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import type { Agent, AgentRole } from '@deepseek-ai/dsh-agent'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionId as SessionIdValue } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import type {
  SessionEventSearchPage,
  SessionEventSearchRequest,
  SessionSearchExecContext,
  SessionSearchHit,
  SessionSearchPage,
  SessionSearchRequest,
} from '@deepseek-ai/dsh-session-query'
import { createDshStore } from '@deepseek-ai/dsh-store-atom/src/api.ts'
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit'
import type { AgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { ToolExecutionResult, ToolExecutionSuccess } from '@deepseek-ai/dsh-tools'
import type { Workspace, WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { WorkspaceId as brandWorkspaceId } from '@deepseek-ai/dsh-workspace'
import Dafeiyu from '@deepseek-ai/dsh-dafeiyu'
import * as WorkspaceTools from '../src/api.ts'

/** Signal for tool calls that are not cancelled. */
export const signal = new AbortController().signal

/** Minimal concrete query service: no search backend, so session search is empty. */
export class TestSessionQueryEngine extends SessionQueryEngine {
  override searchSessions(
    _request: SessionSearchRequest,
    _exec?: SessionSearchExecContext,
  ): Promise<SessionSearchPage<SessionSearchHit>> {
    return Promise.resolve({ items: [] })
  }

  override async searchEvents(
    request: SessionEventSearchRequest,
    _exec?: SessionSearchExecContext,
  ): Promise<SessionEventSearchPage> {
    return { session: (await this.readSurface(request.sessionId)).session, items: [] }
  }
}

/** One in-memory registered workspace; durability is the registry's concern, not this toolset's. */
export class TestWorkspace implements Workspace {
  readonly createdAt: string

  /**
   * @param id - stable workspace id.
   * @param path - canonical workspace directory.
   * @param title - display title.
   * @param sessionIds - sessions the workspace accounts for.
   */
  constructor(
    readonly id: WorkspaceId,
    readonly path: string,
    private displayTitle: string,
    public sessionIds: SessionIdValue[],
  ) {
    this.createdAt = new Date().toISOString()
  }

  /** Display title. */
  get title(): string {
    return this.displayTitle
  }

  /** Workspace role; the specs do not exercise dispatcher authorization yet. */
  get role(): 'agent' | 'super' {
    return 'agent'
  }

  /** Last durable mutation; this fake rewrites it on every setter. */
  get updatedAt(): string {
    return this.createdAt
  }

  /** Replace the display title. */
  async setTitle(title: string): Promise<void> {
    this.displayTitle = title
  }

  /** Replace the workspace role. */
  async setRole(_role: 'agent' | 'super'): Promise<void> {}

  /** Append one session to the account. */
  async attachSession(sessionId: SessionIdValue): Promise<void> {
    if (!this.sessionIds.includes(sessionId)) this.sessionIds.push(sessionId)
  }

  /** Move one accounted session; the fake keeps insertion order. */
  async insertSessionBefore(_sessionId: SessionIdValue, _beforeSessionId?: SessionIdValue): Promise<void> {}

  /** Stored headers for the accounted sessions, one per id. */
  getSessionHeaders(): readonly SessionHeader[] {
    const createdAt = Date.parse(this.createdAt)
    return this.sessionIds.map(id => ({
      version: SESSION_FORMAT_VERSION,
      id,
      createdAt: Number.isFinite(createdAt) ? createdAt : 0,
      isSeeded: false,
    }))
  }

  /** Remove one session from the account. */
  async detachSession(sessionId: SessionIdValue): Promise<void> {
    this.sessionIds = this.sessionIds.filter(id => id !== sessionId)
  }

  /** Directory existence; fixture directories always exist. */
  async status(): Promise<'ok' | 'missing-dir'> {
    return 'ok'
  }
}

/** In-memory registry exposing exactly the consumer interface. */
export class TestWorkspaceRegistry {
  /** Archived session ids the registry would report. */
  archivedSessionIds: SessionIdValue[] = []

  private readonly workspaces: Workspace[] = []

  /**
   * Register one workspace.
   * @param workspace - the workspace to register.
   * @returns the same workspace, for convenient setup.
   */
  add(workspace: TestWorkspace): TestWorkspace {
    this.workspaces.push(workspace)
    return workspace
  }

  /** Every registered workspace, in registration order. */
  list(): Workspace[] {
    return this.workspaces
  }

  /**
   * Record one archived Session, as the durable registry would.
   * @param sessionId - Session the caller archived.
   * @param options - archive choices; this fake does not run activity providers.
   */
  async archiveSession(sessionId: SessionIdValue, _options: { readonly stopActivity?: boolean } = {}): Promise<void> {
    if (!this.archivedSessionIds.includes(sessionId)) this.archivedSessionIds.push(sessionId)
  }
}

/** Services and helpers bound to one mounted toolset composition. */
export interface WorkspaceToolsHarness {
  /** Context owning every mounted service. */
  readonly ctx: Context
  /** Production agent driver mounted by the testkit. */
  readonly harness: AgentLoopTestHarness
  /** The in-memory workspace registry the composition reads. */
  readonly registry: TestWorkspaceRegistry
  /** Fixture harness home that owns the toolset records. */
  readonly home: string
  /** Fiber of the mounted toolset provider. */
  readonly fiber: Fiber
}

/**
 * Mount the real services and the workspace toolset into a caller-owned context.
 * @param ctx - caller-owned context that will own every mounted service.
 * @param home - fixture `$DSH_HOME` directory.
 * @returns the mounted services and registry.
 */
export async function mountWorkspaceTools(ctx: Context, home: string): Promise<WorkspaceToolsHarness> {
  process.env['DSH_HOME'] = home
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(LocalFileSystem, { cwd: home })
  await ctx.plugin(TestSessionQueryEngine)
  ctx.provide('dshStore', createDshStore(ctx, false))
  const registry = new TestWorkspaceRegistry()
  ctx.provide('workspaceRegistry', registry)
  await ctx.plugin(Dafeiyu)
  const plugin = {
    name: WorkspaceTools.name,
    inject: WorkspaceTools.inject,
    apply(pluginCtx: Context) {
      WorkspaceTools.apply(pluginCtx)
    },
  }
  const fiber = await ctx.plugin(plugin as never, {} as never)
  const harness = await mountAgentLoopTestHarness(ctx)
  return { ctx, harness, registry, home, fiber }
}

/**
 * Register one workspace over an existing directory and return its canonical path.
 * @param registry - registry to add the workspace to.
 * @param directory - directory the workspace covers.
 * @param title - display title.
 * @returns the registered workspace.
 */
export async function registerWorkspace(
  registry: TestWorkspaceRegistry,
  directory: string,
  title: string,
): Promise<TestWorkspace> {
  const canonical = await realpath(directory)
  return registry.add(new TestWorkspace(brandWorkspaceId(`ws-${title}`), canonical, title, []))
}

/**
 * Create one root agent in a workspace directory.
 * @param mounted - mounted composition.
 * @param id - session id.
 * @param directory - working directory of the new session.
 * @param role - explicit agent role; a super agent may mutate cards and dispatch tasks.
 * @returns the created agent.
 */
export async function createRoot(
  mounted: WorkspaceToolsHarness,
  id: string,
  directory: string,
  role?: AgentRole,
): Promise<Agent> {
  return await mounted.harness.create(SessionId(id), role === undefined ? {} : { role }, { cwd: directory })
}

/** Invoke one registered tool through the real tool runtime. */
let callCounter = 0
export async function callTool(
  ctx: Context,
  agent: Agent,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  const batch = await ctx.tools.execute({
    signal,
    calls: [{
      type: 'tool-call',
      id: ToolCallId(`call-${String(++callCounter)}`),
      name,
      arguments: JSON.stringify(args),
    }],
    agent,
  })
  const result = batch.results[0]?.result
  if (result === undefined) throw new Error(`tool "${name}" settled no result`)
  return result
}

/** The canonical value of one successful tool result. */
export function valueOf(result: ToolExecutionResult): ToolExecutionSuccess['value'] {
  if (result.isError) throw new Error(`tool failed: ${textOf(result)}`)
  return result.value
}

/** Text blocks of one tool result. */
export function textOf(result: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/**
 * Write one toolset record through the same store the tools read.
 * @param mounted - mounted composition.
 * @param path - store-relative record path.
 * @param value - lossless JSON record value.
 */
export async function seedRecord(
  mounted: WorkspaceToolsHarness,
  path: string,
  value: unknown,
): Promise<void> {
  await mounted.ctx.dshStore.writeFile(undefined, path, JSON.stringify(value, undefined, 2), { scope: 'global' })
}

/**
 * Hash one byte sequence as the artifact index does.
 * @param bytes - file bytes.
 * @returns lowercase hex SHA-256.
 */
export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Path of one workspace's task directory inside the fixture home. */
export function taskDirectory(home: string, workspace: TestWorkspace, taskId: string): string {
  return join(home, 'workspaces', String(workspace.id), 'tasks', `${taskId}.json`)
}
