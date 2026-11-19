/**
 * Routing tests for `ask_user_question_plus`: a question from a person reaches
 * the host user-questions service, while a question inside a request delivered
 * by another agent is refused with the dispatcher to reply to.
 */
import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  callTool,
  createRoot,
  mountWorkspaceTools,
  registerWorkspace,
  textOf,
  valueOf,
} from './harness.ts'
import type { WorkspaceToolsHarness } from './harness.ts'

/** One request the fake host service received. */
interface AskedRequest {
  readonly questions: readonly { readonly id: string; readonly question: string }[]
}

let project: string
let home: string
let contexts: Context[]
let mounted: WorkspaceToolsHarness
let asked: AskedRequest[]

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'dsh-ask-plus-'))
  home = await mkdtemp(join(tmpdir(), 'dsh-ask-plus-home-'))
  await mkdir(join(project, '.git'), { recursive: true })
  contexts = []
  asked = []
  const ctx = new Context()
  contexts.push(ctx)
  mounted = await mountWorkspaceTools(ctx, home)
  await registerWorkspace(mounted.registry, project, 'ask-workspace')
  mounted.ctx.provide('userQuestions' as never, {
    ask: async (request: AskedRequest) => {
      asked.push(request)
      return { answers: [{ id: 'q1', selected: ['yes'] }] }
    },
  } as never)
})

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await rm(project, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

test('a person-started turn delegates the question to the host user-questions service', async () => {
  const agent = await createRoot(mounted, 'ask-person', project)
  const result = await callTool(mounted.ctx, agent, 'ask_user_question_plus', {
    questions: [{ id: 'q1', question: 'Proceed?' }],
  })
  expect(result.isError).toBe(false)
  expect(valueOf(result)).toEqual({ answers: [{ id: 'q1', selected: ['yes'] }] })
  expect(asked).toHaveLength(1)
  expect(asked[0]?.questions[0]?.id).toBe('q1')
})

test('a turn started by a workspace message refuses and names the dispatcher', async () => {
  const agent = await createRoot(mounted, 'ask-dispatched', project)
  agent.session.append('user/message', createUserMessage({
    content: [{
      type: 'text',
      text: '[workspace_message] from super dispatcher-session in Ask workspace (ws-ask-workspace)\n'
        + 'No task bound · reply to dispatcher-session with workspace_message.send',
    }, { type: 'text', text: 'Do the task.' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })

  const result = await callTool(mounted.ctx, agent, 'ask_user_question_plus', {
    questions: [{ id: 'q1', question: 'Proceed?' }],
  })
  expect(result.isError).toBe(true)
  expect(textOf(result)).toContain('do not ask the user directly')
  expect(textOf(result)).toContain('dispatcher-session')
  expect(asked).toEqual([])
})

test('a super-agent turn with a workspace header still reaches the person', async () => {
  const agent = await createRoot(mounted, 'ask-super', project, 'super')
  agent.session.append('user/message', createUserMessage({
    content: [{
      type: 'text',
      text: '[workspace_message] from agent executor-session in Ask workspace (ws-ask-workspace)\n'
        + 'No task bound · reply to executor-session with workspace_message.send',
    }, { type: 'text', text: 'I need a decision: proceed?' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })

  const result = await callTool(mounted.ctx, agent, 'ask_user_question_plus', {
    questions: [{ id: 'q1', question: 'Proceed?' }],
  })
  expect(result.isError).toBe(false)
  expect(asked).toHaveLength(1)
})

test('a turn started by a workspace session request refuses and names the dispatcher', async () => {
  const agent = await createRoot(mounted, 'ask-session', project)
  agent.session.append('user/message', createUserMessage({
    content: [{
      type: 'text',
      text: '[workspace_session] from agent dispatcher-session in Ask workspace (ws-ask-workspace)\n'
        + 'reply to dispatcher-session with workspace_message.send',
    }, { type: 'text', text: 'Do the task.' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })

  const result = await callTool(mounted.ctx, agent, 'ask_user_question_plus', {
    questions: [{ id: 'q1', question: 'Proceed?' }],
  })
  expect(result.isError).toBe(true)
  expect(textOf(result)).toContain('dispatcher-session')
  expect(asked).toEqual([])
})
