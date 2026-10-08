/**
 * Store tool tests: the real plugin registered on a real ToolRuntime, invoked
 * through `ctx.tools.execute` against a real filesystem-backed workspace, plus
 * the policy gate and the rules-namespace checks.
 */
import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId } from '@deepseek-ai/dsh-session'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
  type AgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit'
import * as Store from '../src/index.ts'

const signal = new AbortController().signal

let project: string
let contexts: Context[]
let callCounter = 0

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'dsh-store-tool-'))
  // A `.git` marker makes the fixture look like a checkout, so project-root
  // discovery resolves to the fixture rather than to the temp directory above it.
  await mkdir(join(project, '.git'), { recursive: true })
  contexts = []
})

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await rm(project, { recursive: true, force: true })
})

/** Mount the store plugin (optionally under a session policy) and one agent. */
async function mount(mode?: 'read-only' | 'workspace-write'): Promise<{ ctx: Context; agent: Agent }> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(LocalFileSystem, { cwd: project })
  if (mode !== undefined) await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: project })
  const harness: AgentLoopTestHarness = await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(Store, {})
  const agent = await harness.create(SessionId(`store-${++callCounter}`), {}, { cwd: project })
  return { ctx, agent }
}

/** Invoke the registered tool through the real tool runtime. */
function call(ctx: Context, agent: Agent, args: Record<string, unknown>) {
  return ctx.tools.execute({
    signal,
    callId: ToolCallId(`call-${++callCounter}`),
    name: 'tool-dsh-store',
    arguments: args,
    agent,
  })
}

/** Text blocks of one tool result. */
function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/** Drive one pre-step so the plugin's eager root preparation runs. */
async function drivePreStep(ctx: Context, agent: Agent): Promise<void> {
  await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [], turn: 1, step: 1, signal },
    async () => ({ kind: 'enter' as const, messages: [] }),
  )
}

test('registers one tool with the three actions', async () => {
  const { ctx } = await mount()
  const schema = ctx.tools.schemas().find(entry => entry.name === 'tool-dsh-store')
  expect(schema).toBeDefined()
  const properties = (schema!.parameters as { properties?: Record<string, { enum?: string[] }> }).properties ?? {}
  expect(Object.keys(properties).sort()).toEqual(['action', 'content', 'path', 'recursive', 'target'])
  expect(properties.action?.enum).toEqual(['create', 'query', 'delete'])
  expect(properties.target?.enum).toEqual(['file', 'folder'])
})

test('creates the store root for a session before its first step', async () => {
  const { ctx, agent } = await mount()
  await drivePreStep(ctx, agent)
  expect((await stat(join(project, '.dsh'))).isDirectory()).toBe(true)
})

test('creates a folder and a file, queries them, and deletes them', async () => {
  const { ctx, agent } = await mount()

  const folder = await call(ctx, agent, { action: 'create', target: 'folder', path: 'rules' })
  expect(folder.isError).toBe(false)
  expect(text(folder)).toBe('Created directory .dsh/rules.')

  const file = await call(ctx, agent, {
    action: 'create',
    target: 'file',
    path: 'rules/api.md',
    content: 'Always document public APIs.',
  })
  expect(file.isError).toBe(false)
  expect(text(file)).toBe('Created file .dsh/rules/api.md.')
  expect(await readFile(join(project, '.dsh', 'rules', 'api.md'), 'utf8')).toBe('Always document public APIs.')

  const queried = await call(ctx, agent, { action: 'query', path: 'rules' })
  expect(queried.isError).toBe(false)
  expect(text(queried)).toContain('- file .dsh/rules/api.md')
  expect(text(queried)).toContain('contains 1 entry')

  const read = await call(ctx, agent, { action: 'query', path: 'rules/api.md' })
  expect(text(read)).toContain('Always document public APIs.')

  const deleted = await call(ctx, agent, { action: 'delete', path: 'rules/api.md' })
  expect(deleted.isError).toBe(false)
  expect(text(deleted)).toBe('Deleted file .dsh/rules/api.md.')
  expect((await call(ctx, agent, { action: 'query', path: 'rules/api.md' })).isError).toBe(false)
  expect(text(await call(ctx, agent, { action: 'query', path: 'rules/api.md' }))).toBe('Not found: .dsh/rules/api.md.')
})

test('refuses a rule that repeats an existing rule without writing it', async () => {
  const { ctx, agent } = await mount()
  await call(ctx, agent, { action: 'create', target: 'file', path: 'rules/api.md', content: 'Same text.' })
  const duplicate = await call(ctx, agent, {
    action: 'create',
    target: 'file',
    path: 'rules/copy.md',
    content: '  Same text.  ',
  })
  expect(duplicate.isError).toBe(true)
  expect(text(duplicate)).toContain('duplicate rule')
  await expect(stat(join(project, '.dsh', 'rules', 'copy.md'))).rejects.toThrow()
})

test('refuses a non-Markdown rule and an empty rule', async () => {
  const { ctx, agent } = await mount()
  const notMarkdown = await call(ctx, agent, { action: 'create', target: 'file', path: 'rules/api.txt', content: 'x' })
  expect(notMarkdown.isError).toBe(true)
  expect(text(notMarkdown)).toContain('invalid rule')
  const empty = await call(ctx, agent, { action: 'create', target: 'file', path: 'rules/api.md', content: '   ' })
  expect(empty.isError).toBe(true)
  expect(text(empty)).toContain('must not be empty')
})

test('refuses a create without content and without a target', async () => {
  const { ctx, agent } = await mount()
  const noTarget = await call(ctx, agent, { action: 'create', path: 'rules' })
  expect(noTarget.isError).toBe(true)
  expect(text(noTarget)).toContain('`target` must be')
  const noContent = await call(ctx, agent, { action: 'create', target: 'file', path: 'rules/api.md' })
  expect(noContent.isError).toBe(true)
  expect(text(noContent)).toContain('requires `content`')
})

test('refuses every path that leaves the store root', async () => {
  const { ctx, agent } = await mount()
  for (const path of ['../outside.md', '/etc/passwd', 'C:\\Windows\\system32', '~/rules.md']) {
    const refused = await call(ctx, agent, { action: 'create', target: 'file', path, content: 'x' })
    expect(refused.isError, path).toBe(true)
    expect(text(refused), path).toContain('path rejected')
  }
  await expect(stat(join(project, 'outside.md'))).rejects.toThrow()
})

test('refuses to delete the store root and refuses a populated folder without recursive', async () => {
  const { ctx, agent } = await mount()
  await call(ctx, agent, { action: 'create', target: 'file', path: 'rules/api.md', content: 'text' })

  const rootDelete = await call(ctx, agent, { action: 'delete', path: '' })
  expect(rootDelete.isError).toBe(true)
  expect(text(rootDelete)).toContain('refusing to delete')

  const notRecursive = await call(ctx, agent, { action: 'delete', path: 'rules' })
  expect(notRecursive.isError).toBe(true)

  const recursive = await call(ctx, agent, { action: 'delete', path: 'rules', recursive: true })
  expect(recursive.isError).toBe(false)
  expect(text(recursive)).toBe('Deleted directory .dsh/rules.')
})

test('refuses a delete for a path that does not exist', async () => {
  const { ctx, agent } = await mount()
  const missing = await call(ctx, agent, { action: 'delete', path: 'rules/absent.md' })
  expect(missing.isError).toBe(true)
  expect(text(missing)).toContain('not found: .dsh/rules/absent.md')
})

test('a read-only session refuses every mutation with the shared denial marker', async () => {
  const { ctx, agent } = await mount('read-only')
  const refused = await call(ctx, agent, {
    action: 'create',
    target: 'file',
    path: 'rules/api.md',
    content: 'text',
  })
  expect(refused.isError).toBe(true)
  expect(text(refused)).toContain('[sandbox:')
  await expect(stat(join(project, '.dsh', 'rules', 'api.md'))).rejects.toThrow()

  // Reading stays available, and the root is not created either.
  const queried = await call(ctx, agent, { action: 'query', path: '' })
  expect(queried.isError).toBe(false)
  expect(text(queried)).toBe('Not found: .dsh/.')
  await expect(stat(join(project, '.dsh'))).rejects.toThrow()
})

test('a workspace-write session writes inside the store', async () => {
  const { ctx, agent } = await mount('workspace-write')
  const created = await call(ctx, agent, { action: 'create', target: 'folder', path: 'skills' })
  expect(created.isError).toBe(false)
  await writeFile(join(project, '.dsh', 'skills', 'SKILL.md'), '# skill')
  expect(text(await call(ctx, agent, { action: 'query', path: 'skills' }))).toContain('SKILL.md')
})
