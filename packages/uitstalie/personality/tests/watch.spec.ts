/**
 * The rewritten provider deliberately has no file watcher: a live agent keeps
 * its cached bundle, and a later agent reads the file again.
 */
import { afterEach, expect, test, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import { createDshStore } from '@deepseek-ai/dsh-store-atom'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import Dafeiyu from '@deepseek-ai/dsh-dafeiyu'
import * as Personality from '../src/index.ts'
import {
  createPersonalityDocument,
  globalPersonalityPath,
  renderPersonalityDocument,
} from '../src/global-store.ts'
import type { PersonalityEntry } from '../src/global-store.ts'
import { PROFILE_SECTION_NAME, renderPersonalitySection } from '../src/profile-prompt.ts'

let project: string | undefined
let ctx: Context | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await ctx?.fiber.dispose()
  ctx = undefined
  if (project !== undefined) await rm(project, { recursive: true, force: true })
  project = undefined
})

/** One entry fixture. */
function entry(text: string): PersonalityEntry {
  return { id: 'style.language', kind: 'style', text }
}

/** Write one new-format profile. */
async function writeProfile(entries: readonly PersonalityEntry[]): Promise<void> {
  await mkdir(join(project!, 'home', 'personality'), { recursive: true })
  await writeFile(globalPersonalityPath(), renderPersonalityDocument(createPersonalityDocument(entries)), 'utf8')
}

/** Read the rendered profile section for one agent. */
async function profileText(context: Context, root: Agent): Promise<string> {
  const assembly = await context.systemPrompt.assemble(assembleContextFor(root))
  return assembly.sections.find(section => section.name === PROFILE_SECTION_NAME)?.text ?? ''
}

test('does not register a filesystem watcher', async () => {
  project = await mkdtemp(join(tmpdir(), 'dsh-personality-watch-'))
  await mkdir(join(project, '.git'), { recursive: true })
  vi.stubEnv('DSH_HOME', join(project, 'home'))
  await writeProfile([entry('旧文本。')])
  ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(LocalFileSystem, { cwd: project })
  ctx.provide('dshStore', createDshStore(ctx, false))
  await ctx.plugin(Dafeiyu)
  // @ts-expect-error -- the package default export is an abstract service class; Cordis instantiates it.
  await ctx.plugin(SessionQuery, {})
  const watch = vi.spyOn(ctx.fs, 'watch')
  await ctx.plugin(Personality, {} as never)
  const harness = await mountAgentLoopTestHarness(ctx)
  const root = await harness.create(SessionId('watch-root'), {}, { cwd: project })
  await new Promise<void>((resolve) => { setTimeout(resolve, 0) })

  expect(watch).not.toHaveBeenCalled()
  expect(await profileText(ctx, root)).toBe(renderPersonalitySection([entry('旧文本。')]))
})

test('a live agent keeps its bundle and a later agent sees the edited file', async () => {
  project = await mkdtemp(join(tmpdir(), 'dsh-personality-watch-'))
  await mkdir(join(project, '.git'), { recursive: true })
  vi.stubEnv('DSH_HOME', join(project, 'home'))
  await writeProfile([entry('旧文本。')])
  ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(LocalFileSystem, { cwd: project })
  ctx.provide('dshStore', createDshStore(ctx, false))
  await ctx.plugin(Dafeiyu)
  // @ts-expect-error -- the package default export is an abstract service class; Cordis instantiates it.
  await ctx.plugin(SessionQuery, {})
  await ctx.plugin(Personality, {} as never)
  const harness = await mountAgentLoopTestHarness(ctx)
  const first = await harness.create(SessionId('watch-first'), {}, { cwd: project })
  let before = ''
  for (let attempt = 0; attempt < 200; attempt += 1) {
    before = await profileText(ctx, first)
    if (before.includes('旧文本。')) break
    await new Promise<void>((resolve) => { setTimeout(resolve, 1) })
  }
  expect(before).toContain('旧文本。')
  await new Promise<void>((resolve) => { setTimeout(resolve, 50) })

  await writeProfile([entry('新文本。')])
  await new Promise<void>((resolve) => { setTimeout(resolve, 5) })
  expect(await profileText(ctx, first)).toContain('旧文本。')
  const second = await harness.create(SessionId('watch-second'), {}, { cwd: project })
  let latest = ''
  for (let attempt = 0; attempt < 200; attempt += 1) {
    latest = await profileText(ctx, second)
    if (latest.includes('新文本。')) break
    await new Promise<void>((resolve) => { setTimeout(resolve, 1) })
  }
  expect(latest).toContain('新文本。')
})
