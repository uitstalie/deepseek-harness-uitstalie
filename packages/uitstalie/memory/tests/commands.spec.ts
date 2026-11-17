/**
 * `/memory` command tests over the real composition: global listing, statistics,
 * topic and id forget, and the grammar failures. The workspace-summary forms are
 * gone with the per-turn summary job and must be refused.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { callTool, createRoot, mountMemory } from './harness.ts'
import type { MemoryTestHarness } from './harness.ts'

let project: string
let contexts: Context[]
let mounted: MemoryTestHarness

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'dsh-memory-command-'))
  await mkdir(join(project, '.git'), { recursive: true })
  vi.stubEnv('DSH_HOME', join(project, 'home'))
  contexts = []
  const ctx = new Context()
  contexts.push(ctx)
  mounted = await mountMemory(ctx, project, { commands: true })
})

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await rm(project, { recursive: true, force: true })
})

/** Execute one slash command and return its settled result. */
async function run(root: Agent, line: string): Promise<{ readonly kind: string; readonly text?: string }> {
  const execution = await mounted.ctx.commands.execute(root, line, [], new AbortController().signal)
  if (execution === undefined) throw new Error(`command "${line}" did not resolve`)
  return execution.result
}

/** Seed one global entry through the real tool. */
async function seed(root: Agent, topic: string, text: string): Promise<void> {
  const result = await callTool(mounted.ctx, root, 'memory_write', { topic, text })
  expect(result.isError).toBeFalsy()
}

test('/memory and /memory list render every active entry', async () => {
  const root = await createRoot(mounted)
  await seed(root, 'global-server', 'Server alpha is the shared build host.')
  await seed(root, 'global-model', 'The harness default model is the routed model.')

  const result = await run(root, '/memory')
  expect(result.kind).toBe('success')
  expect(result.text).toContain('Global memory: 2 active entries')
  expect(result.text).toContain('[global-server]')
  expect(result.text).toContain('[global-model]')

  expect((await run(root, '/memory list')).text).toBe(result.text)
})

test('/memory stats reports counts, bytes, and the archive', async () => {
  const root = await createRoot(mounted)
  await seed(root, 'global-server', 'Server alpha is the shared build host.')

  const result = await run(root, '/memory stats')
  expect(result.kind).toBe('success')
  expect(result.text).toContain('Active: 1 entry')
  expect(result.text).toContain('global-server 1')
  expect(result.text).toContain('of 8192 B')
  expect(result.text).toContain('Archived: 0 entries')
})

test('/memory forget --topic archives the entry and --id removes an archived one', async () => {
  const root = await createRoot(mounted)
  await seed(root, 'global-server', 'Server alpha is the shared build host.')
  await seed(root, 'global-model', 'The harness default model is the routed model.')

  const forgotten = await run(root, '/memory forget --topic global-server')
  expect(forgotten.kind).toBe('success')
  expect(forgotten.text).toContain('Forgot the global-server entry; 1 remain')

  const stats = await run(root, '/memory stats')
  expect(stats.text).toContain('Archived: 1 entry')

  const list = await run(root, '/memory list')
  expect(list.text).not.toContain('global-server')
  expect((await run(root, '/memory forget --topic global-server')).text).toContain('No active entry for global-server')

  const missing = await run(root, '/memory forget --id gm-nope')
  expect(missing.kind).toBe('success')
  expect(missing.text).toContain('No global entry with that id')
})

test('/memory refuses the removed summary forms and malformed input', async () => {
  const root = await createRoot(mounted)
  const summaries = await run(root, '/memory summaries')
  expect(summaries.kind).toBe('error')
  expect(summaries.text).toContain('Unknown /memory form')

  const pause = await run(root, '/memory pause')
  expect(pause.kind).toBe('error')
  expect(pause.text).toContain('Unknown /memory form')

  const forget = await run(root, '/memory forget')
  expect(forget.kind).toBe('error')
  expect(forget.text).toContain('needs --topic or --id')

  const topic = await run(root, '/memory forget --topic global-workspace')
  expect(topic.kind).toBe('error')
  expect(topic.text).toContain('Unknown global topic')
})
