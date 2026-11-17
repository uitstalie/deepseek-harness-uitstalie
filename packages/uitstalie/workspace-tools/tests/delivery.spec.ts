/**
 * Delivery side of the workspace toolset: `workspace_message.send`, the
 * published-artifact round trip, retry idempotency, and the rule that a turn
 * without a send delivers nothing. Every assertion runs through a real tool
 * call; the host Session controller is a recording stub because delivery into a
 * running inbox is the host's contract, not this toolset's.
 */
import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  callTool,
  createRoot,
  mountWorkspaceTools,
  registerWorkspace,
  sha256,
  valueOf,
} from './harness.ts'
import type { WorkspaceToolsHarness } from './harness.ts'

/** One prompt the recording controller received. */
interface RecordedPrompt {
  readonly requestId: string
  readonly sessionId: string
  readonly mode: 'queue' | 'steer'
  readonly text: string
}

let projectA: string
let projectB: string
let home: string
let contexts: Context[]
let mounted: WorkspaceToolsHarness
let delivered: RecordedPrompt[]

beforeEach(async () => {
  projectA = await mkdtemp(join(tmpdir(), 'dsh-workspace-delivery-a-'))
  projectB = await mkdtemp(join(tmpdir(), 'dsh-workspace-delivery-b-'))
  home = await mkdtemp(join(tmpdir(), 'dsh-workspace-delivery-home-'))
  await mkdir(join(projectA, '.git'), { recursive: true })
  await mkdir(join(projectB, '.git'), { recursive: true })
  contexts = []
  delivered = []
  const ctx = new Context()
  contexts.push(ctx)
  mounted = await mountWorkspaceTools(ctx, home)
  // Duck-typed exactly like the toolset reads it: only `prompt` is used.
  mounted.ctx.provide('sessionController' as never, {
    prompt: async (request: { requestId: string; sessionId: string; mode: 'queue' | 'steer'; content: readonly { type: 'text'; text: string }[] }) => {
      delivered.push({
        requestId: request.requestId,
        sessionId: request.sessionId,
        mode: request.mode,
        text: request.content.flatMap(part => part.type === 'text' ? [part.text] : []).join(''),
      })
      return { accepted: true }
    },
  } as never)
})

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await rm(projectA, { recursive: true, force: true })
  await rm(projectB, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

test('a message round-trips with its artifact reference', async () => {
  const workspace = await registerWorkspace(mounted.registry, projectA, 'message-round-trip')
  const sender = await createRoot(mounted, 'sender', projectA)
  const target = await createRoot(mounted, 'target', projectA)
  await workspace.attachSession(sender.session.id)
  await workspace.attachSession(target.session.id)
  await writeFile(join(projectA, 'report.md'), '# report\n')
  const published = await callTool(mounted.ctx, sender, 'workspace_artifacts', {
    action: 'publish',
    path: 'report.md',
    kind: 'report',
    summary: 'the delivery report',
    requestId: 'publish-1',
  })
  expect(published.isError).toBe(false)
  const artifact = (valueOf(published) as { artifact: { artifactId: string; version: number; sha256: string } }).artifact
  expect(artifact.version).toBe(1)
  expect(artifact.sha256).toBe(sha256(new Uint8Array(Buffer.from('# report\n'))))

  const sent = await callTool(mounted.ctx, sender, 'workspace_message', {
    action: 'send',
    targetSessionId: String(target.id),
    text: 'conclusion: report is ready\nnext: review it',
    kind: 'message',
    requestId: 'send-1',
    references: [{ artifactId: artifact.artifactId, version: artifact.version }],
  })
  expect(sent.isError).toBe(false)
  type SentView = { messageId: string; status: string; references: { artifactId: string; version: number }[] }
  const sentValue = (valueOf(sent) as { sent: SentView }).sent
  expect(sentValue.status).toBe('delivered')
  expect(sentValue.references).toEqual([{ artifactId: artifact.artifactId, version: 1, sha256: artifact.sha256 }])
  expect(delivered).toHaveLength(1)
  expect(delivered[0]?.sessionId).toBe('target')
  expect(delivered[0]?.requestId).toBe(`workspace-message-${sentValue.messageId}`)

  const read = await callTool(mounted.ctx, target, 'workspace_message', { action: 'read', messageId: sentValue.messageId })
  expect(read.isError).toBe(false)
  const messages = (valueOf(read) as { messages: { messageId: string; text: string; status: string; references: unknown[] }[] }).messages
  expect(messages).toHaveLength(1)
  expect(messages[0]?.text).toContain('report is ready')
  expect(messages[0]?.status).toBe('delivered')
  expect(messages[0]?.references).toHaveLength(1)
})

test('"what did I do last turn" is answered by workspace_sessions', async () => {
  const workspace = await registerWorkspace(mounted.registry, projectA, 'last-turn')
  const root = await createRoot(mounted, 'last-turn-root', projectA)
  await workspace.attachSession(root.session.id)
  root.session.append('turn/start', { turn: 2 })
  root.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'continue the fix' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  root.session.append('assistant/message', {
    turn: 2,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: 'Implemented the parser.\nThe tests pass.' }],
      source: { provider: 'stub', model: 'stub' },
    }),
    stream: [],
  }, { surfaceOp: 'append' })

  const answer = await callTool(mounted.ctx, root, 'workspace_sessions', {
    action: 'get',
    sessionId: String(root.id),
  })
  expect(answer.isError).toBe(false)
  type SessionView = {
    currentTurn: number
    latestProgress?: string
    recentProgress: { summary: string }[]
  }
  const session = (valueOf(answer) as { session: SessionView }).session
  expect(session.currentTurn).toBe(2)
  expect(session.latestProgress).toContain('Implemented the parser.')
  expect(session.recentProgress.at(-1)?.summary).toContain('Implemented the parser.')
  // The answer is a query result, not a delivered message: nothing was sent and no inbox record appeared.
  expect(delivered).toEqual([])
})

test('a repeated requestId returns the first message without a second delivery', async () => {
  const workspace = await registerWorkspace(mounted.registry, projectA, 'message-retry')
  const sender = await createRoot(mounted, 'retry-sender', projectA)
  const target = await createRoot(mounted, 'retry-target', projectA)
  await workspace.attachSession(sender.session.id)
  await workspace.attachSession(target.session.id)

  const first = await callTool(mounted.ctx, sender, 'workspace_message', {
    action: 'send',
    targetSessionId: String(target.id),
    text: 'one delivery',
    requestId: 'retry-key',
  })
  expect(first.isError).toBe(false)
  const firstId = (valueOf(first) as { sent: { messageId: string } }).sent.messageId
  const second = await callTool(mounted.ctx, sender, 'workspace_message', {
    action: 'send',
    targetSessionId: String(target.id),
    text: 'one delivery',
    requestId: 'retry-key',
  })
  expect(second.isError).toBe(false)
  expect((valueOf(second) as { sent: { messageId: string } }).sent.messageId).toBe(firstId)
  expect(delivered).toHaveLength(1)

  const list = await callTool(mounted.ctx, target, 'workspace_message', { action: 'read' })
  expect((valueOf(list) as { messages: unknown[] }).messages).toHaveLength(1)
})

test('a turn with no send delivers nothing', async () => {
  const workspace = await registerWorkspace(mounted.registry, projectA, 'message-quiet')
  const root = await createRoot(mounted, 'quiet-root', projectA)
  await workspace.attachSession(root.session.id)

  root.session.append('turn/start', { turn: 1 })
  await callTool(mounted.ctx, root, 'workspace_sessions', { action: 'get', sessionId: String(root.id) })
  await callTool(mounted.ctx, root, 'workspace_artifacts', { action: 'list' })
  root.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await new Promise<void>((resolve) => { setTimeout(resolve, 0) })

  expect(delivered).toEqual([])
  const read = await callTool(mounted.ctx, root, 'workspace_message', { action: 'read' })
  expect((valueOf(read) as { messages: unknown[] }).messages).toEqual([])
})

test('an ordinary agent cannot message another workspace; the super agent can', async () => {
  const a = await registerWorkspace(mounted.registry, projectA, 'scope-a')
  const b = await registerWorkspace(mounted.registry, projectB, 'scope-b')
  const ordinary = await createRoot(mounted, 'ordinary', projectA)
  const superAgent = await createRoot(mounted, 'super', projectA, 'super')
  const target = await createRoot(mounted, 'scope-target', projectB)
  await a.attachSession(ordinary.session.id)
  await a.attachSession(superAgent.session.id)
  await b.attachSession(target.session.id)

  const refused = await callTool(mounted.ctx, ordinary, 'workspace_message', {
    action: 'send',
    workspace: String(b.id),
    targetSessionId: String(target.id),
    text: 'cross-workspace from an ordinary agent',
    requestId: 'cross-1',
  })
  expect(refused.isError).toBe(true)
  expect((refused.content[0] as { text?: string }).text).toContain('super agent')

  const allowed = await callTool(mounted.ctx, superAgent, 'workspace_message', {
    action: 'send',
    workspace: String(b.id),
    targetSessionId: String(target.id),
    text: 'cross-workspace from the super agent',
    requestId: 'cross-2',
  })
  expect(allowed.isError).toBe(false)
  expect((valueOf(allowed) as { sent: { status: string } }).sent.status).toBe('delivered')
  expect(delivered.at(-1)?.text).toContain('super agent')
})

test('publish is idempotent for unchanged content and versions a changed file', async () => {
  const workspace = await registerWorkspace(mounted.registry, projectA, 'artifact-versions')
  const root = await createRoot(mounted, 'publisher', projectA)
  await workspace.attachSession(root.session.id)
  await writeFile(join(projectA, 'data.csv'), 'a,b\n1,2\n')

  const first = await callTool(mounted.ctx, root, 'workspace_artifacts', {
    action: 'publish', path: 'data.csv', kind: 'data', requestId: 'publish-csv-1',
  })
  expect(first.isError).toBe(false)
  const firstArtifact = (valueOf(first) as { artifact: { artifactId: string; version: number; size: number } }).artifact
  expect(firstArtifact.version).toBe(1)
  expect(firstArtifact.size).toBe(8)

  const repeated = await callTool(mounted.ctx, root, 'workspace_artifacts', {
    action: 'publish', path: 'data.csv', kind: 'data', requestId: 'publish-csv-1',
  })
  expect(repeated.isError).toBe(false)
  expect((valueOf(repeated) as { artifact: { artifactId: string; version: number } }).artifact)
    .toMatchObject({ artifactId: firstArtifact.artifactId, version: 1 })

  await writeFile(join(projectA, 'data.csv'), 'a,b\n1,2\n3,4\n')
  const second = await callTool(mounted.ctx, root, 'workspace_artifacts', {
    action: 'publish', path: 'data.csv', kind: 'data', requestId: 'publish-csv-2',
  })
  expect(second.isError).toBe(false)
  expect((valueOf(second) as { artifact: { artifactId: string; version: number; size: number } }).artifact)
    .toMatchObject({ artifactId: firstArtifact.artifactId, version: 2, size: 12 })
})

test('reference attaches a published artifact to a message and a task record', async () => {
  const workspace = await registerWorkspace(mounted.registry, projectA, 'artifact-reference')
  const root = await createRoot(mounted, 'referencer', projectA)
  await workspace.attachSession(root.session.id)
  await writeFile(join(projectA, 'notes.md'), 'notes\n')
  const published = await callTool(mounted.ctx, root, 'workspace_artifacts', {
    action: 'publish', path: 'notes.md', kind: 'report', requestId: 'publish-notes',
  })
  const artifact = (valueOf(published) as { artifact: { artifactId: string; version: number } }).artifact
  const sent = await callTool(mounted.ctx, root, 'workspace_message', {
    action: 'send',
    targetSessionId: String(root.id),
    text: 'the message first',
    requestId: 'reference-message',
  })
  const messageId = (valueOf(sent) as { sent: { messageId: string } }).sent.messageId

  const referenced = await callTool(mounted.ctx, root, 'workspace_artifacts', {
    action: 'reference',
    artifactId: artifact.artifactId,
    version: artifact.version,
    messageId,
    requestId: 'reference-1',
  })
  expect(referenced.isError).toBe(false)
  expect((valueOf(referenced) as { attachedTo: { messageId: string } }).attachedTo.messageId).toBe(messageId)

  const read = await callTool(mounted.ctx, root, 'workspace_message', { action: 'read', messageId })
  expect((valueOf(read) as { messages: { references: { artifactId: string }[] }[] }).messages[0]?.references[0]?.artifactId)
    .toBe(artifact.artifactId)
})

test('publish refuses a path outside the workspace root and a missing file', async () => {
  const workspace = await registerWorkspace(mounted.registry, projectA, 'artifact-scope')
  const root = await createRoot(mounted, 'boundary-publisher', projectA)
  await workspace.attachSession(root.session.id)
  await writeFile(join(projectA, '..', 'outside.txt'), 'outside\n')

  const outside = await callTool(mounted.ctx, root, 'workspace_artifacts', {
    action: 'publish', path: '../outside.txt', kind: 'report', requestId: 'outside-1',
  })
  expect(outside.isError).toBe(true)
  expect((outside.content[0] as { text?: string }).text).toContain('outside workspace')

  const missing = await callTool(mounted.ctx, root, 'workspace_artifacts', {
    action: 'publish', path: 'missing.md', kind: 'report', requestId: 'missing-1',
  })
  expect(missing.isError).toBe(true)
  expect((missing.content[0] as { text?: string }).text).toContain('does not exist')
})
