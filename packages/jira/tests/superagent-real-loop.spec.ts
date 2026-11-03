/**
 * The superagent loop over the real host services: the shipped `SessionController` creates and
 * prompts the executor, a real AgentLoop runs its turn, and the executor delivers through the
 * capability's own `issue_work`.
 *
 * Every earlier loop test substituted the session controller with a duck-typed stand-in, which is
 * how a missing `AbortSignal` reached a release (DH-711). Here the controller is the production
 * class; only the model is scripted, because a keyless test cannot call a provider. The executor's
 * identity, tool surface, guard, delivery and dispatch records are therefore the ones a deployment
 * gets.
 *
 * @module @deepseek-ai/dsh-jira/tests/superagent-real-loop
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import Dafeiyu from '@deepseek-ai/dsh-dafeiyu'
import { ToolCallId, LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { asIdentity, createIssue, encodeIssue, parseVocab, storePaths, writeTextAtomic } from '@deepseek-ai/dsh-jira-core'
import type { Identity, Timestamp } from '@deepseek-ai/dsh-jira-core'
import * as JiraAgent from '@deepseek-ai/dsh-jira-agent'
import JiraService from '@deepseek-ai/dsh-jira-service'
import { SessionId } from '@deepseek-ai/dsh-session'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 60_000 })

/** The machine identity every mount resolves. */
const MACHINE = 'a1b2c3d4'

/** The audit timestamp the fixture ledger is created at. */
const AT = '2026-10-15T12:00:00Z' as Timestamp

/** The human who confirms the claim in this scenario. */
const HUMAN = asIdentity('human:tester') as Identity

/**
 * Keyless model: one `issue_work` delivery, then the closing text.
 *
 * The executor's first step must be the delivery, so the dispatch prompt's authorization is
 * tested against the record that preceded it. Only a role switch is interpreted; the arguments
 * are fixed because the scenario is fixed.
 */
class ScriptedExecutorAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const last = options.messages.at(-1)
    if (last?.role !== 'tool') {
      // The dispatch instruction names the issue; DH-12 has to reach review, while DH-13 stays in
      // progress so the restart path has something to revive.
      const key = /DH-\d+/u.exec(JSON.stringify(options.messages))?.[0] ?? 'DH-12'
      const args = JSON.stringify(key === 'DH-12'
        ? { action: 'deliver', key, body: 'delivered by the real executor' }
        : { action: 'progress', key, body: 'started by the real executor' })
      const call = ToolCallId(`executor-${key}`)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield {
        type: 'tool-call-delta', index: 0, id: call, name: 'issue_work', argumentsDelta: args,
      }
      yield {
        type: 'block-end', index: 0,
        block: { type: 'tool-call', id: call, name: 'issue_work', arguments: args },
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = 'Worked through issue_work.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** The `@Service.init` hook the production class runs when a deployment mounts it. */
class TestSessionController extends SessionController {
  /**
   * Run the production initialization outside a Loader.
   * @returns after every controller sub-service is ready.
   */
  initialize(): Promise<void> {
    return this[Service.init]()
  }
}

let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Wait until a probe produces a value. */
const waitFor = async <T>(probe: () => T | undefined | Promise<T | undefined>, timeoutMs = 10_000): Promise<T> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() >= deadline) throw new Error(`condition was not met within ${String(timeoutMs)}ms`)
    await new Promise<void>((resolve) => { setTimeout(resolve, 10) })
  }
}

/** The vocabulary fixture `jira-core` ships. */
const CONFIG_FIXTURE = readFileSync(new URL('../jira-core/fixtures/config.md', import.meta.url), 'utf8')

/** A throwaway ledger with two ready issues; the second is the restart case. */
const createLedger = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-jira-real-loop-'))
  await mkdir(join(dir, 'tags'), { recursive: true })
  await writeTextAtomic(storePaths.config(dir), CONFIG_FIXTURE)
  const parsed = parseVocab(CONFIG_FIXTURE)
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error))
  for (const [key, summary] of [['DH-12', 'first'], ['DH-13', 'second']] as const) {
    const created = createIssue(
      { key, issueType: 'task', summary, tags: [], body: 'body\n' },
      { vocab: parsed.value, knownTags: [], at: AT, by: HUMAN },
    )
    if (!created.ok) throw new Error(JSON.stringify(created.error))
    const encoded = encodeIssue(created.value.issue)
    if (!encoded.ok) throw new Error(JSON.stringify(encoded.error))
    await writeTextAtomic(storePaths.issue(dir, 'DH', key as never), encoded.value)
  }
  return dir
}

/** Dispatch one tool call through the real registry under one Agent. */
const call = async (agent: Agent, name: string, args: unknown): Promise<{ ok: boolean; error?: unknown }> => {
  const batch = await agent.ctx.tools.execute({
    calls: [{ type: 'tool-call', id: ToolCallId(`${name}-call`), name, arguments: JSON.stringify(args) }],
    agent,
    signal: new AbortController().signal,
  })
  const result = batch.results[0]?.result
  if (result === undefined) throw new Error(`tool "${name}" settled no result`)
  const value = result.value as { ok?: boolean; error?: unknown } | undefined
  if (value === undefined) {
    // A guard refusal settles as a tool error with no value envelope: the call never reached
    // the definition, which is the outcome this test asserts for an executor write.
    return { ok: false, error: (result as { error?: unknown }).error ?? result }
  }
  return { ...value, ok: value.ok === true }
}

/** The comment bodies one issue carries. */
const bodiesOf = (issue: { comments?: readonly { body: string }[] }): string[] =>
  (issue.comments ?? []).map(comment => comment.body)

describe('superagent over the real Session controller', () => {
  it('dispatches into a production preset Session, delivers, and recovers an idle executor', async () => {
    root = await createLedger()
    const workspace = join(root, 'checkout')
    await mkdir(workspace, { recursive: true })

    const ctx = context = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await mountAgentLoopTestHarness(ctx)

    // The services a direct (non-Loader) controller construction reads. They are the narrowest
    // shapes the deployment supplies; the point of this test is the controller and the loop.
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
      saveSelection: async () => {},
    } as never)
    ctx.provide('typert', {
      lookups: { configure: () => () => {} },
      contexts: { configureHost: () => () => {} },
      resources: { register: () => () => {} },
    } as never)
    ctx.provide('attachments', {
      admitPromptContent: async (content: readonly { type: string }[]) => content,
    } as never)
    ctx.provide('fileUploads', {
      resolve: () => undefined,
      bindPrompt: () => ({ commit: () => {}, [Symbol.dispose]: () => {} }),
      registerAgentResolver: () => () => {},
      retirePrompt: () => {},
    } as never)
    ctx.provide('remoteAccess', { allows: () => true } as never)
    ctx.provide('sessionQuery', {
      listSessions: async () => ctx.agents.roots().map(agent => ({ header: agent.session.header })),
    } as never)
    // The roster only has to name the preset; the shipped composition is covered by the bundle
    // suite. What matters here is that a Session created with it is recognizably an executor.
    ctx.provide('agentPresets', {
      resolve: async (id?: string) => ({ id: id ?? 'standard' }),
      mount: async () => {},
      select: async () => {},
      presetForSession: () => undefined,
    } as never)

    await ctx.plugin(Dafeiyu, { capabilities: { jira: { enabled: true }, superagent: { enabled: true } } })
    await ctx.plugin(JiraService, { root, machine_id: MACHINE, push: { enabled: false } })
    await ctx.plugin(JiraAgent, { superagent_worker_preset: 'jira-worker' })

    ctx.llm.registerAdapter(['fixture'], new ScriptedExecutorAdapter())

    const controller = new TestSessionController(ctx, { nativeOpen: false, listWorkSliceMs: 16 })
    await controller.initialize()

    await waitFor(() => {
      const status = ctx.dafeiyu.status()
      return status.length === 2 && status.every(entry => entry.state === 'active') ? status : undefined
    })

    const dispatcher = await ctx.agentLoop.create(SessionId('dispatcher-1'), {}, { cwd: workspace })

    const proposed = await call(dispatcher, 'superagent_claim', { action: 'propose', key: 'DH-12', why: 'ready and small' })
    expect(proposed.ok).toBe(true)

    // A person confirms on the ledger; the model cannot author this identity.
    const approved = await ctx.jira.mutateIssue(
      'DH-12' as never,
      { action: 'comment', body: '[claim-approved] go ahead' },
      { by: HUMAN, at: AT },
    )
    expect(approved.ok).toBe(true)

    const claimed = await call(dispatcher, 'superagent_claim', { action: 'claim', key: 'DH-12' })
    expect(claimed.ok).toBe(true)

    const dispatched = await call(dispatcher, 'superagent_dispatch', { key: 'DH-12', cwd: workspace })
    expect(dispatched.ok).toBe(true)
    const session = (dispatched as unknown as { dispatch: { session: string } }).dispatch.session

    const executor = await waitFor(() => ctx.agents.get(SessionId(session)))
    expect(executor.session.header.agentPreset).toBe('jira-worker')
    await executor.whenIdle()

    // The executor's visible surface is the narrow one: the ledger reads, `jira_issue` for reads
    // (writes are refused by the guard below) and `issue_work`; no dispatcher verb.
    const executorTools = ctx.tools.schemas(executor).map(schema => schema.name).sort()
    expect(executorTools).toEqual(['issue_work', 'jira_issue', 'jira_kb', 'jira_list'])
    expect(ctx.tools.schemas(dispatcher).map(schema => schema.name)).toEqual(expect.arrayContaining([
      'superagent_claim', 'superagent_dispatch',
    ]))

    const delivered = await ctx.jira.readIssue('DH-12' as never)
    expect(delivered.ok).toBe(true)
    if (!delivered.ok) throw new Error(JSON.stringify(delivered.error))
    expect(delivered.value.issue.status).toBe('in_review')
    const deliveryComment = delivered.value.comments?.at(-1)
    expect(deliveryComment?.author).toMatch(/^agent:/u)
    expect(deliveryComment?.body).toContain('delivered by the real executor')

    // The record lifecycle is the one recovery reads, and both halves name the created Session.
    const records = bodiesOf(delivered.value).filter(body => body.startsWith('[dispatch:session]'))
    expect(records).toEqual([
      `[dispatch:session] ${session} starting`,
      `[dispatch:session] ${session} started`,
    ])

    // An executor's ordinary ledger write is refused by the guard, not merely hidden from it.
    const refused = await call(executor, 'jira_issue', { action: 'update', key: 'DH-12', data: { summary: 'nope' } })
    expect(refused.ok).toBe(false)
    expect(JSON.stringify(refused.error)).toContain('may not write (executor)')

    // A second issue stays in progress, so `recover` — the code path a restart leaves behind — has
    // work to revive. The real controller's list reports the idle executor as not running.
    expect((await call(dispatcher, 'superagent_claim', { action: 'propose', key: 'DH-13', why: 'ready too' })).ok).toBe(true)
    expect((await ctx.jira.mutateIssue(
      'DH-13' as never,
      { action: 'comment', body: '[claim-approved] go ahead' },
      { by: HUMAN, at: AT },
    )).ok).toBe(true)
    expect((await call(dispatcher, 'superagent_claim', { action: 'claim', key: 'DH-13' })).ok).toBe(true)
    const dispatched13 = await call(dispatcher, 'superagent_dispatch', { key: 'DH-13', cwd: workspace })
    expect(dispatched13.ok).toBe(true)
    const session13 = (dispatched13 as unknown as { dispatch: { session: string } }).dispatch.session
    const executor13 = await waitFor(() => ctx.agents.get(SessionId(session13)))
    await executor13.whenIdle()
    const inProgress = await ctx.jira.readIssue('DH-13' as never)
    expect(inProgress.ok && inProgress.value.issue.status).toBe('in_progress')

    const recovered = await call(dispatcher, 'superagent_dispatch', { action: 'recover' })
    expect(recovered.ok).toBe(true)
    const revived = (recovered as unknown as {
      recovered: readonly { key: string; previous: string; session: string }[]
    }).recovered
    expect(revived).toHaveLength(1)
    expect(revived[0]?.key).toBe('DH-13')
    expect(revived[0]?.previous).toBe(session13)
    expect(revived[0]?.session).not.toBe(session13)
    const revivedExecutor = await waitFor(() => ctx.agents.get(SessionId(revived[0]?.session ?? '')))
    await revivedExecutor.whenIdle()
    const afterRecover = await ctx.jira.readIssue('DH-13' as never)
    expect(afterRecover.ok).toBe(true)
    if (!afterRecover.ok) throw new Error(JSON.stringify(afterRecover.error))
    expect(bodiesOf(afterRecover.value)).toEqual(expect.arrayContaining([
      `[dispatch:session] ${session13} starting`,
      `[dispatch:session] ${session13} started`,
      `[dispatch:session] ${revived[0]?.session ?? ''} starting`,
      `[dispatch:session] ${revived[0]?.session ?? ''} started`,
    ]))
  })
})
