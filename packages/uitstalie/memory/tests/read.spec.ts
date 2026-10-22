/**
 * `memory_read` tests: the real AgentLoop, organizer, store, and session query,
 * with synthetic session events for each conversation surface. They assert the
 * default latest-turn read, explicit turns, seq selection with the before/after
 * clamp, workspace authorization, the tool-line rendering without payloads, the
 * per-message and total byte bounds, and the non-throwing refusals.
 */
import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  appendMemoryNotice,
  MEMORY_READ_MAX_BYTES,
  MEMORY_READ_NARROW_HINT,
  MEMORY_READ_TEXT_MAX_BYTES,
  MEMORY_READ_WINDOW_MAX_EVENTS,
} from '../src/index.ts'
import {
  appendAssistantText,
  appendUserText,
  callTool,
  createRoot,
  mountMemory,
  textOf,
} from './harness.ts'
import type { MemoryTestHarness } from './harness.ts'

let project: string
let contexts: Context[]

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'dsh-memory-read-'))
  // A `.git` marker makes the fixture look like a checkout, so project-root
  // discovery resolves to the fixture rather than to the temp directory above it.
  await mkdir(join(project, '.git'), { recursive: true })
  contexts = []
})

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await rm(project, { recursive: true, force: true })
})

/** Mount the real composition and return its helpers. */
async function mount(): Promise<MemoryTestHarness> {
  const ctx = new Context()
  contexts.push(ctx)
  return mountMemory(ctx, project)
}

/** Append user and assistant text, then close one already-open turn. */
function finishTurn(agent: Agent, turn: number, user: string, answer: string): void {
  appendUserText(agent, user)
  appendAssistantText(agent, turn, answer)
  agent.session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** Open one further turn. */
function openTurn(agent: Agent, turn: number): void {
  agent.session.append('turn/start', { turn })
}

/** Seq of the event at one observed-log index; a miss fails the spec. */
function seqAt(agent: Agent, index: number): number {
  const event = agent.session.snapshotEvents()[index]
  if (event === undefined) throw new Error(`expected an event at index ${String(index)}`)
  return event.seq
}

/** Seq of the first user message whose text blocks equal one string. */
function seqOfUser(agent: Agent, text: string): number {
  for (const event of agent.session.snapshotEvents()) {
    if (event.type !== 'user/message') continue
    const matches = event.data.content.some(block => block.type === 'text' && block.text === text)
    if (matches) return event.seq
  }
  throw new Error(`expected a user message ${JSON.stringify(text)}`)
}

test('reads the latest completed turn by default', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted, 'read-root', 1)
  finishTurn(root, 1, 'first request', 'first answer')
  openTurn(root, 2)
  finishTurn(root, 2, 'second request', 'second answer')

  const events = root.session.snapshotEvents()
  const start = events.findIndex(event => event.type === 'turn/start' && event.data.turn === 2)
  const end = events.findIndex(event => event.type === 'turn/end' && event.data.turn === 2)
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)

  const result = await callTool(mounted.ctx, root, 'memory_read', {})
  const text = textOf(result)

  expect(result.isError, text).toBe(false)
  expect(text.split('\n')[0]).toBe(`session read-root, turn 2–2, seqs ${seqAt(root, start)}–${seqAt(root, end)}`)
  expect(text).toContain('[user] second request')
  expect(text).toContain('[assistant] second answer')
  expect(text).not.toContain('first request')
})

test('reads an explicit turn and the caller names its own session', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted, 'read-root', 1)
  finishTurn(root, 1, 'first request', 'first answer')
  openTurn(root, 2)
  finishTurn(root, 2, 'second request', 'second answer')

  const result = await callTool(mounted.ctx, root, 'memory_read', { sessionId: 'read-root', turn: 1 })
  const text = textOf(result)

  expect(result.isError, text).toBe(false)
  expect(text.split('\n')[0]).toMatch(/^session read-root, turn 1–1, seqs \d+–\d+$/u)
  expect(text).toContain('[user] first request')
  expect(text).toContain('[assistant] first answer')
  expect(text).not.toContain('second request')
})

test('a seq selects the containing turn and before/after clamp to ten events', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted, 'read-root', 1)
  for (let index = 1; index <= 12; index += 1) {
    appendUserText(root, `u${String(index).padStart(2, '0')}`)
  }
  appendAssistantText(root, 1, 'turn one answer')
  root.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  openTurn(root, 2)
  appendUserText(root, 'anchor request')
  appendAssistantText(root, 2, 'anchor answer')
  root.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  openTurn(root, 3)
  for (let index = 1; index <= 12; index += 1) {
    appendUserText(root, `t3-${String(index).padStart(2, '0')}`)
  }
  appendAssistantText(root, 3, 'turn three answer')
  root.session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })

  const events = root.session.snapshotEvents()
  const turnStart = events.findIndex(event => event.type === 'turn/start' && event.data.turn === 2)
  const turnEnd = events.findIndex(event => event.type === 'turn/end' && event.data.turn === 2)
  expect(turnStart).toBeGreaterThanOrEqual(MEMORY_READ_WINDOW_MAX_EVENTS)
  expect(turnEnd + MEMORY_READ_WINDOW_MAX_EVENTS).toBeLessThan(events.length)

  const result = await callTool(mounted.ctx, root, 'memory_read', {
    seq: seqOfUser(root, 'anchor request'),
    before: 99,
    after: 99,
  })
  const text = textOf(result)

  expect(result.isError, text).toBe(false)
  expect(text.split('\n')[0]).toBe(
    `session read-root, turn 1–3, seqs ${seqAt(root, turnStart - MEMORY_READ_WINDOW_MAX_EVENTS)}`
    + `–${seqAt(root, turnEnd + MEMORY_READ_WINDOW_MAX_EVENTS)}`,
  )
  expect(text).toContain('anchor request')
  expect(text).toContain('u05')
  expect(text).not.toContain('u04')
  expect(text).toContain('t3-09')
  expect(text).not.toContain('t3-10')
})

test('refuses a session outside the caller workspace without failing', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted, 'read-root', 1)
  finishTurn(root, 1, 'caller request', 'caller answer')

  const otherCwd = join(project, 'other-workspace')
  const other = await mounted.harness.create(SessionId('other-root'), {}, { cwd: otherCwd })
  other.session.append('turn/start', { turn: 1 })
  finishTurn(other, 1, 'other secret request', 'other secret answer')

  const refused = await callTool(mounted.ctx, root, 'memory_read', { sessionId: 'other-root' })
  expect(refused.isError, textOf(refused)).toBe(false)
  expect(textOf(refused)).toBe('memory_read: session other-root is outside the caller workspace.')
  expect(textOf(refused)).not.toContain('other secret')

  const missing = await callTool(mounted.ctx, root, 'memory_read', { sessionId: 'absent-session' })
  expect(missing.isError, textOf(missing)).toBe(false)
  expect(textOf(missing)).toBe('memory_read: session absent-session is outside the caller workspace.')
})

test('reads a peer session that shares the caller workspace', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted, 'read-root', 1)
  finishTurn(root, 1, 'caller request', 'caller answer')

  const peer = await mounted.harness.create(SessionId('peer-root'), {}, { cwd: project })
  peer.session.append('turn/start', { turn: 1 })
  finishTurn(peer, 1, 'peer request', 'peer answer')

  const result = await callTool(mounted.ctx, root, 'memory_read', { sessionId: 'peer-root' })
  const text = textOf(result)

  expect(result.isError, text).toBe(false)
  expect(text).toContain('[user] peer request')
  expect(text).toContain('[assistant] peer answer')
})

test('a caller without a workspace can read only its own session', async () => {
  const mounted = await mount()
  const scoped = await createRoot(mounted, 'read-root', 1)
  finishTurn(scoped, 1, 'workspace request', 'workspace answer')

  const rootless = await mounted.harness.create(SessionId('rootless-root'))
  rootless.session.append('turn/start', { turn: 1 })
  finishTurn(rootless, 1, 'rootless request', 'rootless answer')

  const own = await callTool(mounted.ctx, rootless, 'memory_read', {})
  expect(own.isError, textOf(own)).toBe(false)
  expect(textOf(own)).toContain('[user] rootless request')

  const refused = await callTool(mounted.ctx, rootless, 'memory_read', { sessionId: 'read-root' })
  expect(refused.isError, textOf(refused)).toBe(false)
  expect(textOf(refused)).toBe('memory_read: session read-root is outside the caller workspace.')
})

test('renders tool status lines without payloads and omits non-conversation messages', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted, 'read-root', 1)
  appendUserText(root, 'run the command')

  const okCall = ToolCallId('call-ok')
  root.session.append('tool/call', {
    turn: 1,
    step: 1,
    callId: okCall,
    name: 'bash',
    arguments: '{"secret":"args-secret"}',
  })
  root.session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId: okCall,
      content: [{ type: 'text', text: 'tool-output-secret' }],
      isError: false,
    }),
  }, { surfaceOp: 'append' })

  const errorCall = ToolCallId('call-error')
  root.session.append('tool/call', { turn: 1, step: 1, callId: errorCall, name: 'read', arguments: '{}' })
  root.session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId: errorCall,
      content: [{ type: 'text', text: 'error-output-secret' }],
      isError: true,
    }),
  }, { surfaceOp: 'append' })

  root.session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId: ToolCallId('call-orphan'),
      content: [{ type: 'text', text: 'orphan-output-secret' }],
      isError: true,
    }),
  }, { surfaceOp: 'append' })

  appendMemoryNotice(root.session, 'memory-notice-secret')
  appendAssistantText(root, 1, '')
  root.session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [
        { type: 'reasoning', text: 'reasoning-secret' },
        { type: 'text', text: 'final answer' },
      ],
      source: { provider: 'stub', model: 'stub' },
    }),
    stream: [],
  }, { surfaceOp: 'append' })
  root.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  const result = await callTool(mounted.ctx, root, 'memory_read', { turn: 1 })
  const text = textOf(result)

  expect(result.isError, text).toBe(false)
  expect(text).toMatch(/^- tool bash · called · seq \d+$/mu)
  expect(text).toMatch(/^- tool bash · ok · seq \d+$/mu)
  expect(text).toMatch(/^- tool read · error · seq \d+$/mu)
  expect(text).toMatch(/^- tool unknown · error · seq \d+$/mu)
  expect(text).toContain('[assistant] final answer')
  for (const secret of [
    'tool-output-secret',
    'args-secret',
    'error-output-secret',
    'orphan-output-secret',
    'memory-notice-secret',
    'reasoning-secret',
  ]) {
    expect(text).not.toContain(secret)
  }
})

test('caps each message at 2 KiB and the complete result at 16 KiB', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted, 'read-root', 1)
  appendUserText(root, 'X'.repeat(5000))
  appendAssistantText(root, 1, 'visible response')
  root.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  const single = textOf(await callTool(mounted.ctx, root, 'memory_read', { turn: 1 }))
  expect(single).toContain('[assistant] visible response')
  expect((single.match(/X/gu) ?? []).length).toBeLessThanOrEqual(MEMORY_READ_TEXT_MAX_BYTES)
  expect(single).toContain('…')

  openTurn(root, 2)
  for (let index = 0; index < 12; index += 1) appendUserText(root, 'Y'.repeat(2000))
  root.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

  const bounded = textOf(await callTool(mounted.ctx, root, 'memory_read', {}))
  expect(Buffer.byteLength(bounded, 'utf8')).toBeLessThanOrEqual(MEMORY_READ_MAX_BYTES)
  expect(bounded.endsWith(MEMORY_READ_NARROW_HINT)).toBe(true)
})

test('missing turns, seqs, and completed turns return short text without failing', async () => {
  const mounted = await mount()
  const root = await createRoot(mounted, 'read-root', 1)
  appendUserText(root, 'open request')
  appendAssistantText(root, 1, 'open answer')

  const pending = await callTool(mounted.ctx, root, 'memory_read', {})
  expect(pending.isError, textOf(pending)).toBe(false)
  expect(textOf(pending)).toBe('memory_read: session read-root has no completed turns.')

  root.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  const missingTurn = await callTool(mounted.ctx, root, 'memory_read', { turn: 99 })
  expect(missingTurn.isError, textOf(missingTurn)).toBe(false)
  expect(textOf(missingTurn)).toBe('memory_read: session read-root has no completed turn 99.')

  const missingSeq = await callTool(mounted.ctx, root, 'memory_read', { seq: -1 })
  expect(missingSeq.isError, textOf(missingSeq)).toBe(false)
  expect(textOf(missingSeq)).toBe('memory_read: session read-root has no turn containing seq -1.')
})
