/**
 * Real composition: the shipped branch layer's capability rows boot through the real Loader, and
 * the organizer wires the providers onto a production Agent.
 *
 * The row list is read from `packages/bundle/web-app/cordis.patch.uitstalie.yml` rather than
 * written here, so a row the branch stops shipping (or a renamed package) fails this test. The
 * support rows around them are the minimum host the branch layer assumes.
 */
import { afterEach, expect, test, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { assembleContextFor, type Agent } from '@deepseek-ai/dsh-agent'
import * as AgentPlugin from '@deepseek-ai/dsh-agent'
import * as AgentLoopPlugin from '@deepseek-ai/dsh-agent-loop'
import * as FsLocalPlugin from '@deepseek-ai/dsh-fs-local'
import * as JobsPlugin from '@deepseek-ai/dsh-jobs'
import * as JobsLocalPlugin from '@deepseek-ai/dsh-jobs-local'
import * as LlmPlugin from '@deepseek-ai/dsh-llm'
import * as MemoryPlugin from '@deepseek-ai/dsh-memory'
import * as PersonalityPlugin from '@deepseek-ai/dsh-personality'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as SessionPlugin from '@deepseek-ai/dsh-session'
import * as SessionProjectionPlugin from '@deepseek-ai/dsh-session-projection'
import * as SessionQueryPlugin from '@deepseek-ai/dsh-session-query'
import * as StoreAtomPlugin from '@deepseek-ai/dsh-store-atom'
import * as SystemPromptPlugin from '@deepseek-ai/dsh-system-prompt'
import * as ToolDshStorePlugin from '@deepseek-ai/dsh-tool-dsh-store'
import * as ToolExecutorNativePlugin from '@deepseek-ai/dsh-tool-executor-native'
import * as ToolsPlugin from '@deepseek-ai/dsh-tools'
import * as DafeiyuPlugin from '../src/index.ts'

const BRANCH_LAYER = new URL('../../../bundle/web-app/cordis.patch.uitstalie.yml', import.meta.url)

/** The capability rows this test boots, in the order the organizer needs them. */
const CAPABILITY_ROWS = ['dafeiyu', 'memory', 'personality', 'store-atom', 'tool-dsh-store'] as const

/** The package each capability row must still point at. */
const EXPECTED_PACKAGES: Readonly<Record<string, string>> = {
  dafeiyu: '@deepseek-ai/dsh-dafeiyu',
  memory: '@deepseek-ai/dsh-memory',
  personality: '@deepseek-ai/dsh-personality',
  'store-atom': '@deepseek-ai/dsh-store-atom',
  'tool-dsh-store': '@deepseek-ai/dsh-tool-dsh-store',
}

let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Extract `- id:` / `name:` pairs from the branch patch layer. */
async function capabilityRows(): Promise<ReadonlyMap<string, string>> {
  const text = await readFile(BRANCH_LAYER, 'utf8')
  const rows = new Map<string, string>()
  for (const match of text.matchAll(/^\s+- id:\s*(\S+)\s*\n\s+name:\s*'([^']+)'/gmu)) {
    const id = match[1]
    const name = match[2]
    if (id !== undefined && name !== undefined) rows.set(id, name)
  }
  return rows
}

/** Boot the support rows plus the real capability rows through the real Loader. */
async function boot(project: string, rows: ReadonlyMap<string, string>): Promise<Context> {
  const support = [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-session-query'",
    "- name: '@deepseek-ai/dsh-jobs'",
    "- name: '@deepseek-ai/dsh-jobs-local'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-tool-executor-native'",
    "- name: '@deepseek-ai/dsh-fs-local'",
    '  config:',
    `    cwd: '${project.replaceAll('\\', '/')}'`,
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-agent-loop'",
    '  config:',
    '    agents: []',
  ]
  const capabilities = CAPABILITY_ROWS.map(id => `- name: '${rows.get(id) ?? ''}'`)
  const configPath = join(project, 'cordis.yml')
  await writeFile(configPath, [...support, ...capabilities].join('\n'))
  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(project).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmPlugin],
    ['@deepseek-ai/dsh-session', SessionPlugin],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionPlugin],
    ['@deepseek-ai/dsh-session-query', SessionQueryPlugin],
    ['@deepseek-ai/dsh-jobs', JobsPlugin],
    ['@deepseek-ai/dsh-jobs-local', JobsLocalPlugin],
    ['@deepseek-ai/dsh-system-prompt', SystemPromptPlugin],
    ['@deepseek-ai/dsh-tools', ToolsPlugin],
    ['@deepseek-ai/dsh-tool-executor-native', ToolExecutorNativePlugin],
    ['@deepseek-ai/dsh-fs-local', FsLocalPlugin],
    ['@deepseek-ai/dsh-agent', AgentPlugin],
    ['@deepseek-ai/dsh-agent-loop', AgentLoopPlugin],
    ['@deepseek-ai/dsh-dafeiyu', DafeiyuPlugin],
    ['@deepseek-ai/dsh-memory', MemoryPlugin],
    ['@deepseek-ai/dsh-personality', PersonalityPlugin],
    ['@deepseek-ai/dsh-store-atom', StoreAtomPlugin],
    ['@deepseek-ai/dsh-tool-dsh-store', ToolDshStorePlugin],
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

test('the branch layer wires the capability providers onto a production agent', async () => {
  root = await mkdtemp(join(tmpdir(), 'dafeiyu-composition-'))
  const project = root
  await mkdir(join(project, '.git'), { recursive: true })

  const rows = await capabilityRows()
  for (const id of CAPABILITY_ROWS) {
    expect(rows.get(id), id).toBe(EXPECTED_PACKAGES[id])
  }

  const ctx = await boot(project, rows)
  await vi.waitFor(() => {
    expect(ctx.dafeiyu.status().map(entry => entry.state)).toEqual(['active', 'active'])
  })
  const statuses = ctx.dafeiyu.status()
  expect(statuses.map(entry => entry.id)).toEqual(['memory', 'personality'])
  expect(statuses.map(entry => entry.label)).toEqual(['Memory', 'Personality'])

  const agent: Agent = await ctx.agentLoop.create(SessionId('composition-root'), {}, { cwd: project })
  expect(ctx.tools.get('memory_write', agent)).toBeDefined()
  expect(ctx.tools.get('personality_learn', agent)).toBeDefined()
  const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent))
  expect(assembly.sections.map(section => section.name)).toEqual(expect.arrayContaining(['memory', 'personality']))
})
