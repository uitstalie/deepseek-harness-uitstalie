/**
 * The real-composition harness the jira agent's wiring tests mount.
 *
 * Every service here is the shipped one — the system-prompt, tool, command and skill registries,
 * the dafeiyu organizer and the `jira-service` provider — so the tests exercise the registrations
 * the plugin really makes rather than a hand-built stand-in. Only the process facts are pinned:
 * `env` and the clock are fixed per mount, and the agent handles are constructed directly because
 * creating a live agent needs the whole agent loop.
 *
 * @module @deepseek-ai/dsh-jira-agent/testing/host
 */

import { Context } from '@deepseek-ai/cordis'
import { type Agent, type AgentOptions } from '@deepseek-ai/dsh-agent'
import { encodeIssue } from '@deepseek-ai/dsh-jira-core/codec.ts'
import { type Identity, type Timestamp } from '@deepseek-ai/dsh-jira-core/entity.ts'
import { writeTextAtomic } from '@deepseek-ai/dsh-jira-core/io.ts'
import { createIssue } from '@deepseek-ai/dsh-jira-core/mutate.ts'
import { storePaths } from '@deepseek-ai/dsh-jira-core/store.ts'
import { parseVocab } from '@deepseek-ai/dsh-jira-core/vocab.ts'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import Dafeiyu from '@deepseek-ai/dsh-dafeiyu'
import JiraService from '@deepseek-ai/dsh-jira-service'
import { SESSION_FORMAT_VERSION, Session, SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { type HostEnv } from '../env.ts'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { createSessionRecorder } from '../sessionRecord.ts'
import type { ToolHost } from '../tools.ts'

/** The machine identity every mount resolves; a store's counters are keyed by it. */
export const MACHINE = 'a1b2c3d4'

/** The frozen clock the tests format audit timestamps from. */
export const AT = Date.parse('2026-10-15T12:00:00Z')

/** The UTC form of {@link AT}, as the tools write it. */
export const AT_ISO = '2026-10-15T12:00:00Z'

/** Options the caller adapter reads duck-typed; `AgentOptions` does not declare them. */
export interface TestAgentOptions extends AgentOptions {
  /** The permission preset name the host carries on a live agent. */
  agentPreset?: string
  /** Runtime delegation depth for a child agent. */
  subagentDepth?: number
}

/** Services and helpers bound to one mounted composition. */
export interface JiraHarness {
  /** The root context owning every mounted service. */
  readonly ctx: Context
  /** The plugin host a test drives the contribution and the tools through. */
  readonly host: ToolHost
  /** Dispose the tree; every registration is released with it. */
  dispose(): Promise<void>
}

/** What one mount may vary. */
export interface MountOptions {
  /** Process facts the plugin reads; defaults to an empty environment. */
  readonly env?: HostEnv
  /** Whether the organizer's gate is open for the jira capability; defaults to open. */
  readonly enabled?: boolean
}

/**
 * Mount the real services and the jira provider into a fresh context.
 * @param root - the ledger root the service opens.
 * @param options - process facts and the capability gate.
 * @returns the mounted context and the plugin host bound to it.
 */
export const mountJira = async (root: string, options: MountOptions = {}): Promise<JiraHarness> => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Dafeiyu, options.enabled === undefined ? {} : { capabilities: { jira: { enabled: options.enabled } } })
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(JiraService, { root, machine_id: MACHINE })
  const host: ToolHost = Object.freeze({
    ctx,
    env: options.env ?? {},
    clock: () => AT,
    recorder: createSessionRecorder(),
  })
  return Object.freeze({ ctx, host, dispose: () => ctx.fiber.dispose() })
}

/**
 * Build one agent handle for the tests.
 *
 * `Agent` is not constructible outside the agent loop, but it is assignable to the shape built
 * here (id, session, options, ctx), which is what makes the handle usable by the organizer and the
 * registries without a cast through `unknown`. The context is the mount's root context, so the
 * organizer's per-agent registrations land in the global layer the test dispatches through.
 * @param ctx - the mounted context the agent's scoped registrations belong to.
 * @param id - the session id, which is also the agent id.
 * @param header - extra session header facts (lineage, checkout).
 * @param options - extra agent options (permission preset, delegation depth).
 * @returns the agent handle.
 */
export const testAgent = (
  ctx: Context,
  id: string,
  header: Partial<SessionHeader> = {},
  options: TestAgentOptions = {},
): Agent => {
  const sessionId = SessionId(id)
  const session = Session.create(sessionId, [], {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: 0,
    isSeeded: false,
    ...header,
  })
  return { id: sessionId, session, options, ctx } as Agent
}

/**
 * Whether one tool classifies a call as overlap-safe, tolerating a tool that declares no classifier.
 * @param definition - the registered tool definition.
 * @param args - the call's arguments.
 * @returns the classifier's verdict, or `undefined` when the tool declares none.
 */
export const concurrencySafe = (definition: ToolDefinition, args: unknown): boolean | undefined =>
  definition.isConcurrencySafe?.(args)

/** Wait for a value that a background refresh produces. */
export const waitFor = async <T>(read: () => T | undefined | Promise<T | undefined>, timeoutMs = 3000): Promise<T> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() >= deadline) throw new Error(`condition was not met within ${String(timeoutMs)}ms`)
    await new Promise<void>((resolve) => { setTimeout(resolve, 5) })
  }
}

/** The vocabulary fixture, read from `jira-core` so the two packages cannot drift. */
export const CONFIG_FIXTURE = readFileSync(new URL('../../../jira-core/fixtures/config.md', import.meta.url), 'utf8')

/**
 * Create a throwaway ledger with the vocabulary fixture, one tag and one issue (`DH-12`).
 *
 * A test that needs a writable ledger calls this; the directory belongs to the caller, which is
 * responsible for removing it.
 * @returns the absolute store root.
 */
export const createLedgerFixture = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-jira-agent-'))
  await mkdir(join(dir, 'tags'), { recursive: true })
  await writeFile(join(dir, 'tags', 'demo.md'), '---\ntype: tag\nname: demo\ndescription: demo\n---\n', 'utf8')
  await writeTextAtomic(storePaths.config(dir), CONFIG_FIXTURE)
  const parsed = parseVocab(CONFIG_FIXTURE)
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error))
  const created = createIssue(
    { key: 'DH-12', issueType: 'task', summary: 'first', tags: ['demo'], body: 'body\n' },
    { vocab: parsed.value, knownTags: [{ name: 'demo' }], at: '2026-10-15T08:30:00Z' as Timestamp, by: 'human:daiqc' as Identity },
  )
  if (!created.ok) throw new Error(JSON.stringify(created.error))
  const encoded = encodeIssue(created.value.issue)
  if (!encoded.ok) throw new Error(JSON.stringify(encoded.error))
  await writeTextAtomic(storePaths.issue(dir, 'DH', 'DH-12' as never), encoded.value)
  return dir
}
