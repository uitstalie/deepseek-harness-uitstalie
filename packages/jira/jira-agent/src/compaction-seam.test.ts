/**
 * The manual compaction tool must resolve the compaction seam from the target Agent's scope.
 *
 * In the product composition the web preset disables root `compaction-basic` and mounts it in
 * an agent-preset isolate; jira-agent's root context therefore cannot see `compaction`.
 */

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { SessionId } from '@deepseek-ai/dsh-session'
import { compactWorkspaceSession } from './superagent.ts'

const MODEL = 'compaction-seam-test'
const PROMPT = 'older conversation history '.repeat(60)
const contexts: Context[] = []

after(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** A real LLM adapter: one text answer per request with a large context window. */
class TextAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 100_000 } })
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'answer' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Real BasicCompactionEngine with a deterministic summarizer. */
class TestCompaction extends BasicCompactionEngine {
  override async summarize(): Promise<{ summary: [{ type: 'text'; text: string }]; provider: string; model: string }> {
    return { summary: [{ type: 'text', text: 'checkpoint' }], provider: 'summary', model: 'summary' }
  }
}

/** One live composition with an agent whose own setup mounts compaction. */
const mount = async (withCompaction: boolean): Promise<{ root: Context; agent: Awaited<ReturnType<AgentLoop['createAgent']>>['agent'] }> => {
  const root = new Context()
  contexts.push(root)
  await mountAgentLoopTestDependencies(root)
  await root.plugin(AgentLoop, { agents: [] })
  await root.plugin(TokenMeter)
  root.llm.registerAdapter([MODEL], new TextAdapter())
  const handle = await root.agentLoop.createAgent(root, {
    sessionId: SessionId(withCompaction ? 'compaction-seam' : 'no-compaction-seam'),
    agentOptions: { provider: MODEL, model: MODEL },
    ...(withCompaction
      ? { setup: async (agentCtx: Context) => { await agentCtx.plugin(TestCompaction, { auto: false }) } }
      : {}),
  })
  return { root, agent: handle.agent }
}

/** Seed one closed turn so the manual compactor has a safe range. */
const seed = async (agent: Awaited<ReturnType<AgentLoop['createAgent']>>['agent']): Promise<void> => {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: PROMPT }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

describe('superagent: compaction seam scope', () => {
  it('uses the resolved Agent context when the plugin root cannot see compaction', async () => {
    const { root, agent } = await mount(true)
    assert.notEqual(agent.ctx.get('compaction'), undefined, 'the agent setup mounted the backend')
    // The product root cannot see the preset-isolate service. Model that exact view: the plugin
    // context has the host services but no compaction.
    const pluginRoot = {
      get: (key: string) => key === 'compaction' ? undefined : root.get(key),
    } as unknown as Context
    assert.equal(pluginRoot.get('compaction'), undefined)

    await seed(agent)
    const controller = {
      async create() { return { sessionId: 'unused' } },
      async prompt() { return { accepted: true } },
      async list() { return { items: [] } },
      async resolveAgent(id: string) { return id === String(agent.id) ? { agent } : { error: 'not found' } },
    }
    const outcome = await compactWorkspaceSession(pluginRoot, controller, String(agent.id))
    assert.equal(outcome.error, undefined, JSON.stringify(outcome))
    assert.equal(outcome.compacted, true)
    assert.ok((outcome.shadowedTokens ?? 0) > 0)
    assert.deepEqual(
      agent.session.snapshotEvents().filter(event => event.type.startsWith('compaction/')).map(event => event.type),
      ['compaction/start', 'compaction/summary', 'compaction/end'],
    )
  })

  it('returns a structured no-seam result when neither root nor agent exposes compaction', async () => {
    const { root, agent } = await mount(false)
    await seed(agent)
    const outcome = await compactWorkspaceSession(root, {
      async create() { return { sessionId: 'unused' } },
      async prompt() { return { accepted: true } },
      async list() { return { items: [] } },
      async resolveAgent() { return { agent } },
    }, String(agent.id))
    assert.deepEqual(outcome, { error: 'this deployment has no compaction seam' })
  })
})
