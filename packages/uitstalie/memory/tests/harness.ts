/**
 * Real-composition harness shared by the memory provider specs: the real agent
 * loop, agent and session registries, tool runtime, session query service, local
 * filesystem, `.dsh` store, and the dafeiyu organizer with the memory capability
 * mounted.
 *
 * Only the search backend is substituted: it has no index, so session search
 * returns nothing while every exact surface read still walks the live corpus.
 */
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionId as SessionIdValue, SessionSeq, UserMessage } from '@deepseek-ai/dsh-session'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import type {
  SessionEventSearchPage,
  SessionEventSearchRequest,
  SessionSearchExecContext,
  SessionSearchHit,
  SessionSearchPage,
  SessionSearchRequest,
} from '@deepseek-ai/dsh-session-query'
import { createDshStore } from '@deepseek-ai/dsh-tool-dsh-store'
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit'
import type { AgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import Dafeiyu from '@deepseek-ai/dsh-dafeiyu'
import { join } from 'node:path'
import * as Memory from '../src/index.ts'
import { isMemorySnapshotSource } from '../src/index.ts'
import type { MemorySnapshotSource } from '../src/index.ts'

/** Signal for tool calls that are not cancelled. */
export const signal = new AbortController().signal

/** Requests the search tool sent to the query service. */
export const searchRequests: SessionSearchRequest[] = []

/** Minimal concrete query service: no backend index, so session search is empty. */
export class TestSessionQueryEngine extends SessionQueryEngine {
  override searchSessions(
    request: SessionSearchRequest,
    _exec?: SessionSearchExecContext,
  ): Promise<SessionSearchPage<SessionSearchHit>> {
    searchRequests.push(request)
    return Promise.resolve({ items: [] })
  }

  override async searchEvents(
    request: SessionEventSearchRequest,
    _exec?: SessionSearchExecContext,
  ): Promise<SessionEventSearchPage> {
    return { session: (await this.readSurface(request.sessionId)).session, items: [] }
  }
}

/** One memory snapshot observed on a session's current model surface. */
export interface ObservedSnapshot {
  /** Seq of the surface node carrying the snapshot. */
  readonly seq: SessionSeq
  /** The durable user message. */
  readonly message: UserMessage
  /** The declared memory source, which carries the rendered sections. */
  readonly source: MemorySnapshotSource
}

/** Services and helpers bound to one mounted memory composition. */
export interface MemoryTestHarness {
  /** Context owning every mounted service. */
  readonly ctx: Context
  /** Production agent driver mounted by the testkit. */
  readonly harness: AgentLoopTestHarness
  /** Fiber of the mounted memory provider, owned by {@link MemoryTestHarness.ctx}. */
  readonly memoryFiber: Fiber
  /** Fixture workspace root. */
  readonly project: string
}

/** Mount the real services and the memory provider into a caller-owned context. */
export async function mountMemory(ctx: Context, project: string): Promise<MemoryTestHarness> {
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(LocalFileSystem, { cwd: project })
  await ctx.plugin(TestSessionQueryEngine)
  ctx.provide('dshStore', createDshStore(ctx, false))
  await ctx.plugin(Dafeiyu)
  const memoryFiber = await ctx.plugin(Memory, {})
  await settle()
  const harness = await mountAgentLoopTestHarness(ctx)
  return { ctx, harness, memoryFiber, project }
}

/** Let activation and dispatch continuations run. */
export async function settle(): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
}

/** Absolute path of the fixture MEMORY.md. */
export function memoryFilePath(project: string): string {
  return join(project, '.dsh', 'memory', 'sessions', 'MEMORY.md')
}

let callCounter = 0

/** Invoke one registered tool through the real tool runtime. */
export function callTool(
  ctx: Context,
  agent: Agent,
  name: string,
  args: Record<string, unknown>,
) {
  return ctx.tools.execute({
    signal,
    callId: ToolCallId(`call-${String(++callCounter)}`),
    name,
    arguments: args,
    agent,
  })
}

/** Text blocks of one tool result. */
export function textOf(result: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/** Create one root agent in the fixture workspace and open its first turn. */
export async function createRoot(
  mounted: MemoryTestHarness,
  id = 'memory-root',
  turn = 1,
): Promise<Agent> {
  const root = await mounted.harness.create(SessionId(id), {}, { cwd: mounted.project })
  root.session.append('turn/start', { turn })
  return root
}

/** Read every memory snapshot from one session's current model surface, in surface order. */
export async function memorySnapshots(
  ctx: Context,
  sessionId: SessionIdValue,
): Promise<ObservedSnapshot[]> {
  const surface = await ctx.sessionQuery.readSurface(sessionId)
  const snapshots: ObservedSnapshot[] = []
  for (const event of surface.events) {
    if (event.type !== 'user/message') continue
    const source = event.data.source
    if (!isMemorySnapshotSource(source)) continue
    snapshots.push({ seq: event.seq, message: event.data, source })
  }
  return snapshots
}

/** Extract the text blocks of one message. */
export function messageText(message: UserMessage): string {
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}
