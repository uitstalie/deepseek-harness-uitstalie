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
  textOf,
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

/** One host acknowledgement the recording controller returned. */
interface DeliveryReply {
  readonly accepted: boolean
  readonly error?: string
}

/** Replacement behavior for the next controller calls; defaults to acceptance. */
let deliveryBehaviour: () => Promise<DeliveryReply>

let projectA: string
let projectB: string
let home: string
let contexts: Context[]
let mounted: WorkspaceToolsHarness
/** Every prompt handed to the controller, including attempts that were refused. */
let delivered: RecordedPrompt[]
/** Only the prompts the controller accepted, so a test can prove one admission. */
let admitted: RecordedPrompt[]

beforeEach(async () => {
  projectA = await mkdtemp(join(tmpdir(), 'dsh-workspace-delivery-a-'))
  projectB = await mkdtemp(join(tmpdir(), 'dsh-workspace-delivery-b-'))
  home = await mkdtemp(join(tmpdir(), 'dsh-workspace-delivery-home-'))
  await mkdir(join(projectA, '.git'), { recursive: true })
  await mkdir(join(projectB, '.git'), { recursive: true })
  contexts = []
  delivered = []
  admitted = []
  deliveryBehaviour = async () => ({ accepted: true })
  const ctx = new Context()
  contexts.push(ctx)
  mounted = await mountWorkspaceTools(ctx, home)
  // Duck-typed exactly like the toolset reads it: only `prompt` is used.
  mounted.ctx.provide('sessionController' as never, {
    prompt: async (request: { requestId: string; sessionId: string; mode: 'queue' | 'steer'; content: readonly { type: 'text'; text: string }[] }) => {
      const recorded: RecordedPrompt = {
        requestId: request.requestId,
        sessionId: request.sessionId,
        mode: request.mode,
        text: request.content.flatMap(part => part.type === 'text' ? [part.text] : []).join(''),
      }
      delivered.push(recorded)
      const reply = await deliveryBehaviour()
      if (reply.accepted) admitted.push(recorded)
      return reply
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

test('publish and resolve route .dsh paths through the store checks', async () => {
  const workspace = await registerWorkspace(mounted.registry, projectA, 'artifact-dsh')
  const root = await createRoot(mounted, 'dsh-publisher', projectA)
  await workspace.attachSession(root.session.id)
  await mkdir(join(projectA, '.dsh', 'rules'), { recursive: true })
  await mkdir(join(projectA, '.dsh', 'memory'), { recursive: true })
  await writeFile(join(projectA, '.dsh', 'rules', 'tone.md'), 'Do not use codenames.\n')
  await writeFile(join(projectA, '.dsh', 'memory', 'GLOBAL.md'), 'version: 1\n')

  const published = await callTool(mounted.ctx, root, 'workspace_artifacts', {
    action: 'publish', path: '.dsh/rules/tone.md', kind: 'rule', requestId: 'dsh-rule-1',
  })
  expect(published.isError).toBe(false)
  const artifact = (valueOf(published) as { artifact: { artifactId: string } }).artifact
  const resolved = await callTool(mounted.ctx, root, 'workspace_artifacts', {
    action: 'resolve', artifactId: artifact.artifactId,
  })
  expect(resolved.isError).toBe(false)
  expect((valueOf(resolved) as { resolution: { status: string } }).resolution.status).toBe('ok')

  const memory = await callTool(mounted.ctx, root, 'workspace_artifacts', {
    action: 'publish', path: '.dsh/memory/GLOBAL.md', kind: 'memory', requestId: 'dsh-memory-1',
  })
  expect(memory.isError).toBe(true)
  expect(textOf(memory)).toContain('managed memory')

  const traversal = await callTool(mounted.ctx, root, 'workspace_artifacts', {
    action: 'publish', path: '.dsh/../outside.txt', kind: 'report', requestId: 'dsh-traversal-1',
  })
  expect(traversal.isError).toBe(true)
  expect(textOf(traversal)).toContain('refused by the .dsh store')
})

/** One sent result as the delivery tests inspect it. */
interface SentDeliveryView {
  messageId: string
  status: string
  error?: string
  attempts?: number
}

/** One message as `status` and `read` return it. */
interface MessageDeliveryView {
  messageId: string
  status: string
  error?: string
  attempts?: number
  references: { artifactId: string; version: number; sha256: string }[]
}

test('a thrown delivery failure is persisted as failed and retry delivers exactly once', async () => {
  const workspace = await registerWorkspace(mounted.registry, projectA, 'message-thrown-failure')
  const sender = await createRoot(mounted, 'thrown-sender', projectA)
  const target = await createRoot(mounted, 'thrown-target', projectA)
  await workspace.attachSession(sender.session.id)
  await workspace.attachSession(target.session.id)

  deliveryBehaviour = async () => { throw new Error('target inbox is closed') }
  const first = await callTool(mounted.ctx, sender, 'workspace_message', {
    action: 'send',
    targetSessionId: String(target.id),
    text: 'conclusion: needs a retry\nnext: deliver it',
    kind: 'followup',
    requestId: 'retry-after-thrown-failure',
  })
  expect(first.isError).toBe(false)
  const failed = (valueOf(first) as unknown as { sent: SentDeliveryView }).sent
  expect(failed.status).toBe('failed')
  expect(failed.error).toContain('target inbox is closed')
  expect(failed.attempts).toBe(1)

  const status = await callTool(mounted.ctx, target, 'workspace_message', {
    action: 'status', messageId: failed.messageId,
  })
  expect(status.isError).toBe(false)
  const failedView = (valueOf(status) as unknown as { message: MessageDeliveryView }).message
  expect(failedView.messageId).toBe(failed.messageId)
  expect(failedView.status).toBe('failed')
  expect(failedView.error).toContain('target inbox is closed')
  expect(failedView.attempts).toBe(1)
  expect(failedView.references).toEqual([])

  const latest = await callTool(mounted.ctx, target, 'workspace_message', {
    action: 'status', targetSessionId: String(target.id),
  })
  expect(latest.isError).toBe(false)
  expect((valueOf(latest) as unknown as { message: MessageDeliveryView }).message.messageId).toBe(failed.messageId)

  const readFailed = await callTool(mounted.ctx, target, 'workspace_message', {
    action: 'read', messageId: failed.messageId,
  })
  expect(readFailed.isError).toBe(false)
  const visible = (valueOf(readFailed) as unknown as { messages: MessageDeliveryView[] }).messages
  expect(visible).toHaveLength(1)
  expect(visible[0]?.status).toBe('failed')
  expect(visible[0]?.error).toContain('target inbox is closed')

  deliveryBehaviour = async () => ({ accepted: true })
  const retried = await callTool(mounted.ctx, sender, 'workspace_message', {
    action: 'retry', messageId: failed.messageId,
  })
  expect(retried.isError).toBe(false)
  const deliveredSent = (valueOf(retried) as unknown as { sent: SentDeliveryView }).sent
  expect(deliveredSent.messageId).toBe(failed.messageId)
  expect(deliveredSent.status).toBe('delivered')
  expect(deliveredSent.attempts).toBe(2)
  expect(deliveredSent.error).toBeUndefined()

  const deliveredStatus = await callTool(mounted.ctx, target, 'workspace_message', {
    action: 'status', messageId: failed.messageId,
  })
  expect(deliveredStatus.isError).toBe(false)
  const deliveredView = (valueOf(deliveredStatus) as unknown as { message: MessageDeliveryView }).message
  expect(deliveredView.status).toBe('delivered')
  expect(deliveredView.attempts).toBe(2)
  expect(deliveredView.error).toBeUndefined()

  const requestId = `workspace-message-${failed.messageId}`
  expect(admitted.filter(prompt => prompt.requestId === requestId)).toHaveLength(1)
  const hostCalls = delivered.length
  const repeated = await callTool(mounted.ctx, sender, 'workspace_message', {
    action: 'retry', messageId: failed.messageId,
  })
  expect(repeated.isError).toBe(false)
  expect((valueOf(repeated) as unknown as { sent: SentDeliveryView }).sent.status).toBe('delivered')
  expect(delivered).toHaveLength(hostCalls)
  expect(admitted.filter(prompt => prompt.requestId === requestId)).toHaveLength(1)
})

test('a declined delivery keeps its reason, advances attempts, and retry then delivers', async () => {
  const workspace = await registerWorkspace(mounted.registry, projectA, 'message-declined-failure')
  const sender = await createRoot(mounted, 'declined-sender', projectA)
  const target = await createRoot(mounted, 'declined-target', projectA)
  await workspace.attachSession(sender.session.id)
  await workspace.attachSession(target.session.id)

  deliveryBehaviour = async () => ({ accepted: false, error: 'recipient inbox is full' })
  const first = await callTool(mounted.ctx, sender, 'workspace_message', {
    action: 'send',
    targetSessionId: String(target.id),
    text: 'one declined delivery',
    requestId: 'declined-send',
  })
  expect(first.isError).toBe(false)
  const failed = (valueOf(first) as unknown as { sent: SentDeliveryView }).sent
  expect(failed.status).toBe('failed')
  expect(failed.error).toContain('recipient inbox is full')
  expect(failed.attempts).toBe(1)

  // A repeated send with the same requestId returns the failed record instead of delivering again.
  const repeatedSend = await callTool(mounted.ctx, sender, 'workspace_message', {
    action: 'send',
    targetSessionId: String(target.id),
    text: 'one declined delivery',
    requestId: 'declined-send',
  })
  expect(repeatedSend.isError).toBe(false)
  expect((valueOf(repeatedSend) as unknown as { sent: SentDeliveryView }).sent.status).toBe('failed')
  expect(delivered).toHaveLength(1)

  deliveryBehaviour = async () => ({ accepted: false, error: 'recipient inbox is still full' })
  const stillFailed = await callTool(mounted.ctx, sender, 'workspace_message', {
    action: 'retry', messageId: failed.messageId,
  })
  expect(stillFailed.isError).toBe(false)
  const stillFailedSent = (valueOf(stillFailed) as unknown as { sent: SentDeliveryView }).sent
  expect(stillFailedSent.status).toBe('failed')
  expect(stillFailedSent.error).toContain('recipient inbox is still full')
  expect(stillFailedSent.attempts).toBe(2)

  const persisted = await callTool(mounted.ctx, target, 'workspace_message', {
    action: 'status', messageId: failed.messageId,
  })
  const persistedView = (valueOf(persisted) as unknown as { message: MessageDeliveryView }).message
  expect(persistedView.status).toBe('failed')
  expect(persistedView.error).toContain('recipient inbox is still full')
  expect(persistedView.attempts).toBe(2)

  const noSelector = await callTool(mounted.ctx, target, 'workspace_message', { action: 'status' })
  expect(noSelector.isError).toBe(true)
  expect(textOf(noSelector)).toContain('messageId or targetSessionId')

  const missing = await callTool(mounted.ctx, sender, 'workspace_message', {
    action: 'retry', messageId: 'message-missing',
  })
  expect(missing.isError).toBe(true)
  expect(textOf(missing)).toContain('holds no message')

  deliveryBehaviour = async () => ({ accepted: true })
  const retried = await callTool(mounted.ctx, sender, 'workspace_message', {
    action: 'retry', messageId: failed.messageId,
  })
  expect(retried.isError).toBe(false)
  const deliveredSent = (valueOf(retried) as unknown as { sent: SentDeliveryView }).sent
  expect(deliveredSent.status).toBe('delivered')
  expect(deliveredSent.attempts).toBe(3)
  expect(deliveredSent.error).toBeUndefined()
  expect(admitted).toHaveLength(1)
})
