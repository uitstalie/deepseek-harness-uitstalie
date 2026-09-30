/**
 * Real Loader composition: a test-only `cordis.yml` boots the plus row exactly
 * as a preset does, and the production Agent created by that composition
 * receives one instruction message carrying the native chain plus the rules.
 */
import { afterEach, expect, test } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import * as AgentPlugin from '@deepseek-ai/dsh-agent'
import { SessionId, type UserMessage } from '@deepseek-ai/dsh-session'
import * as SessionPlugin from '@deepseek-ai/dsh-session'
import * as SessionProjectionPlugin from '@deepseek-ai/dsh-session-projection'
import * as LlmPlugin from '@deepseek-ai/dsh-llm'
import * as SystemPromptPlugin from '@deepseek-ai/dsh-system-prompt'
import * as ToolsPlugin from '@deepseek-ai/dsh-tools'
import * as AgentLoopPlugin from '@deepseek-ai/dsh-agent-loop'
import * as FsLocalPlugin from '@deepseek-ai/dsh-fs-local'
import * as PlusPlugin from '../src/index.ts'

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
    ['@deepseek-ai/dsh-agent-instructions-plus', PlusPlugin],
  ])
  ctx.loader.internal = {
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
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

/** Text of every text block in one message. */
function messageText(message: UserMessage): string {
  return message.content.map(block => block.type === 'text' ? block.text : '').join('\n')
}

test('the composed row delivers the native chain and the rules in one message', async () => {
  root = await mkdtemp(join(tmpdir(), 'plus-loader-'))
  const project = root
  await mkdir(join(project, '.dsh', 'rules'), { recursive: true })
  await writeFile(join(project, 'AGENTS.md'), '# Repo rules\n\nBe careful.')
  await writeFile(join(project, '.dsh', 'rules', 'api.md'), 'Always document public APIs.')
  const ctx = await boot(project)

  const agent: Agent = await ctx.agentLoop.create(SessionId('plus-loader-1'), {}, { cwd: project })
  await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [], turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter' as const, messages: [] }),
  )

  const pending = agent.inbox.nextStep.filter(message => message.source.kind === 'agent-instructions')
  expect(pending).toHaveLength(1)
  const text = messageText(pending[0]!)
  expect(text).toContain('Instructions from: AGENTS.md')
  expect(text).toContain('Instructions from: .dsh/rules/api.md')
  expect(text).toContain('Always document public APIs.')
})

test('every agent preset swaps the native row for the plus row', async () => {
  for (const preset of ['standard', 'ptc', 'cordis']) {
    const text = await readFile(new URL(`../../../bundle/web-app/presets/${preset}.patch.yml`, import.meta.url), 'utf8')
    const block = text.slice(text.indexOf('# BEGIN uitstalie-k3'), text.indexOf('# END uitstalie-k3'))
    expect(block, preset).toContain("name: '@deepseek-ai/dsh-agent-instructions'")
    expect(block, preset).toContain('disabled: true')
    expect(block, preset).toContain("name: '@deepseek-ai/dsh-agent-instructions-plus'")
    expect(block, preset).toContain('agentInstructions:')
    expect(block, preset).toContain('rules:')
  }
})
