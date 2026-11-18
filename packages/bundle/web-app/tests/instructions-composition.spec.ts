/**
 * The shipped Web composition keeps the native instruction loader that the
 * branch's plus seam decorates.
 *
 * The Web patch disables the profile-level `agent-instructions` row and the
 * shipped presets no longer mount it, so after DH-5 no `AGENTS.md` baseline was
 * produced at all. This spec composes the real bundle patch layers, proves the
 * effective row is enabled, and then boots a real Session from the composed
 * instruction rows so the baseline is a logged `agent-instructions` message.
 */
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { bundlePatchPaths, composeEntries } from '@deepseek-ai/dsh-app-boot'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as AgentInstructions from '@deepseek-ai/dsh-agent-instructions'
import * as StoreAtom from '@deepseek-ai/dsh-store-atom'
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
  provideWorkingDirectoryFixture,
} from '@deepseek-ai/dsh-agent-loop-testkit'
import { parseEntryYaml } from '@deepseek-ai/cordis-plugin-include'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import * as Plus from '@deepseek-ai/dsh-agent-instructions-plus'

const webBundle = fileURLToPath(new URL('../', import.meta.url))
const baseBundle = fileURLToPath(new URL('../../base/', import.meta.url))

/** One effective entry row of the composed Web bundle. */
interface EffectiveRow {
  readonly id?: string
  readonly name?: string
  readonly config?: unknown
  readonly disabled?: unknown
}

/** Every patch of one bundle package, in its declared application order. */
function bundlePatches(directory: string): PatchOptions[] {
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
    dsh: { bundle: { patch: string[] } }
  }
  return bundlePatchPaths(directory, manifest.dsh.bundle)
    .flatMap((file: string) => parseEntryYaml(readFileSync(file, 'utf8')) as PatchOptions[])
}

/** Every effective row of the shipped Web profile (`base` then `web-app`), in order. */
function webComposition(): readonly EffectiveRow[] {
  const warnings: string[] = []
  return composeEntries(
    [bundlePatches(baseBundle), bundlePatches(webBundle)],
    (message: string) => { warnings.push(message) },
  )
}

let project: string | undefined
let context: Context | undefined
let savedHome: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (project !== undefined) await rm(project, { recursive: true, force: true })
  project = undefined
  if (savedHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = savedHome
  savedHome = undefined
})

test('the effective Web composition mounts the native loader and its plus seam', () => {
  const rows = webComposition()
  const native = rows.find(row => row.id === 'agent-instructions')
  const plus = rows.find(row => row.id === 'agent-instructions-plus')
  expect(native, 'agent-instructions row').toBeDefined()
  expect(native?.name).toBe('@deepseek-ai/dsh-agent-instructions')
  expect(native?.disabled).not.toBe(true)
  expect(native?.config).toMatchObject({ maxBytes: 65536 })
  expect(plus?.name).toBe('@deepseek-ai/dsh-agent-instructions-plus')
})

test('a new Session logs the AGENTS.md baseline under the composed instruction rows', async () => {
  const rows = webComposition()
  const native = rows.find(row => row.id === 'agent-instructions')
  const plus = rows.find(row => row.id === 'agent-instructions-plus')
  if (native === undefined || plus === undefined) throw new Error('the Web composition must mount both instruction rows')

  project = await mkdtemp(join(tmpdir(), 'dsh-web-instructions-'))
  const home = await mkdtemp(join(tmpdir(), 'dsh-web-instructions-home-'))
  savedHome = process.env['DSH_HOME']
  process.env['DSH_HOME'] = home
  await mkdir(join(project, '.git'), { recursive: true })
  await mkdir(join(project, '.dsh', 'rules'), { recursive: true })
  await writeFile(join(project, 'AGENTS.md'), '# Workspace rules\n\nRead the design before changing it.')
  await writeFile(join(project, '.dsh', 'rules', 'api.md'), 'Document every public API.')

  const ctx = new Context()
  context = ctx
  await mountAgentLoopTestDependencies(ctx)
  provideWorkingDirectoryFixture(ctx, project)
  await ctx.plugin(LocalFileSystem, { cwd: project })
  await ctx.plugin(StoreAtom as never, { ensureRoot: false } as never)
  const harness = await mountAgentLoopTestHarness(ctx)
  // The profile row mounts first; the plus seam prepends itself as the outer listener.
  await ctx.plugin(AgentInstructions, native.config as never)
  await ctx.plugin(Plus, plus.config as never)
  expect(ctx.agentContextSources).toBeDefined()

  const agent = await harness.create(SessionId('web-instructions'), {}, { cwd: project })
  await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [], turn: 1, step: 1, signal: new AbortController().signal, modelSelection: { provider: 'test', model: 'test' } },
    async () => ({ kind: 'enter' as const, messages: [] }),
  )
  const pending = agent.inbox.nextStep.filter(message => message.source.kind === 'agent-instructions')
  expect(pending).toHaveLength(1)
  const text = pending[0]!.content.map(block => block.type === 'text' ? block.text : '').join('\n')
  expect(text).toContain('Read the design before changing it.')
  expect(text).toContain('Document every public API.')

  // A turn admits the pending baseline into the Session log; the logged message
  // keeps its source kind, which is what a new Web Session's JSONL shows.
  for (const message of agent.inbox.nextStep.slice()) {
    const event = agent.session.append('user/message', message, { surfaceOp: 'append' })
    ctx.emit('session/event', agent.session, event)
    agent.inbox.remove(message.id)
  }
  const logged = agent.session.snapshotEvents().find(event =>
    event.type === 'user/message' && event.data.source.kind === 'agent-instructions')
  expect(logged, 'the baseline is a logged user/message').toBeDefined()
  const loggedText = logged!.type === 'user/message'
    ? logged!.data.content.map(block => block.type === 'text' ? block.text : '').join('\n')
    : ''
  expect(loggedText).toContain('AGENTS.md')
  expect(loggedText).toContain('Read the design before changing it.')
  console.log('web baseline log excerpt:', loggedText.slice(0, 1200))
})
