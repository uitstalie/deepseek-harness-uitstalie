/**
 * Real Loader composition: a test-only `cordis.yml` boots the store row, and
 * the production Agent created by that composition gets the store root and can
 * write through the registered tool.
 */
import { afterEach, expect, test } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import * as AgentPlugin from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as LlmPlugin from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as SessionPlugin from '@deepseek-ai/dsh-session'
import * as SessionProjectionPlugin from '@deepseek-ai/dsh-session-projection'
import * as SystemPromptPlugin from '@deepseek-ai/dsh-system-prompt'
import * as ToolsPlugin from '@deepseek-ai/dsh-tools'
import * as AgentLoopPlugin from '@deepseek-ai/dsh-agent-loop'
import * as FsLocalPlugin from '@deepseek-ai/dsh-fs-local'
import * as StorePlugin from '../src/index.ts'

let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Boot the fixture composition through the real Loader. */
async function boot(project: string): Promise<Context> {
  const fixture = await readFile(new URL('./fixtures/loader-composition/cordis.yml', import.meta.url), 'utf8')
  const configPath = join(project, 'cordis.yml')
  await mkdir(join(project, '.git'), { recursive: true })
  await writeFile(configPath, fixture.replace('{{project}}', project.replaceAll('\\', '/')))
  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(project).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmPlugin],
    ['@deepseek-ai/dsh-session', SessionPlugin],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionPlugin],
    ['@deepseek-ai/dsh-system-prompt', SystemPromptPlugin],
    ['@deepseek-ai/dsh-tools', ToolsPlugin],
    ['@deepseek-ai/dsh-fs-local', FsLocalPlugin],
    ['@deepseek-ai/dsh-agent', AgentPlugin],
    ['@deepseek-ai/dsh-agent-loop', AgentLoopPlugin],
    ['@deepseek-ai/dsh-tool-dsh-store', StorePlugin],
  ])
  const internal: ModuleLoaderV2 = {
    version: 'v2',
    loadCache: new Map(),
    import: (specifier: string) => {
      if (!modules.has(specifier)) throw new Error('Unexpected Loader import: ' + specifier)
      return Promise.resolve(modules.get(specifier))
    },
    register(): never { throw new Error('unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job creation') },
    resolveSync(): never { throw new Error('unexpected synchronous module resolution') },
    load(): never { throw new Error('unexpected module load') },
  }
  ctx.loader.internal = internal
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

/** Text blocks of one tool result. */
function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

test('the composed row registers the tool and prepares the store root', async () => {
  root = await mkdtemp(join(tmpdir(), 'store-loader-'))
  const project = root
  const ctx = await boot(project)
  const agent: Agent = await ctx.agentLoop.create(SessionId('store-loader-1'), {}, { cwd: project })

  expect(ctx.tools.schemas().some(entry => entry.name === 'tool-dsh-store')).toBe(true)

  await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [], turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter' as const, messages: [] }),
  )
  expect((await stat(join(project, '.dsh'))).isDirectory()).toBe(true)

  const created = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('store-loader-call-1'),
    name: 'tool-dsh-store',
    arguments: { action: 'create', target: 'file', path: 'rules/api.md', content: 'Document public APIs.' },
    agent,
  })
  expect(created.isError).toBe(false)
  expect(text(created)).toBe('Created file .dsh/rules/api.md.')
  expect(await readFile(join(project, '.dsh', 'rules', 'api.md'), 'utf8')).toBe('Document public APIs.')
})
