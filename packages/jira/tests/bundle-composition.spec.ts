/**
 * The jira surface of the shipped Web profile, composed and booted.
 *
 * The previous version of this suite compared three YAML ids with a regular expression; it could
 * not fail when a row stopped loading, registered twice, or produced no tool. Here the real patch
 * layer is read through `app-boot` and handed to the real Loader as the root include's runtime
 * patch list (the same mechanism a profile boot uses), so the rows that mount are the rows the
 * bundle ships. The base composition is the minimum set of host services the jira rows inject;
 * the capabilities that are not jira (memory, personality, home-backup, the browser-only rows) are
 * filtered out and belong to their own suites.
 *
 * @module @deepseek-ai/dsh-jira/tests/bundle-composition
 */

import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import * as CommandsPlugin from '@deepseek-ai/dsh-commands'
import * as DafeiyuPlugin from '@deepseek-ai/dsh-dafeiyu'
import * as JiraAgentPlugin from '@deepseek-ai/dsh-jira-agent'
import * as JiraServicePlugin from '@deepseek-ai/dsh-jira-service'
import * as JiraUiPlugin from '@deepseek-ai/dsh-client-ui-jira'
import * as SkillPlugin from '@deepseek-ai/dsh-skill'
import * as SystemPromptPlugin from '@deepseek-ai/dsh-system-prompt'
import * as ToolExecutorPlugin from '@deepseek-ai/dsh-tool-executor-native'
import * as ToolsPlugin from '@deepseek-ai/dsh-tools'
import { runGit } from '@deepseek-ai/dsh-jira-core/git.ts'
import { scaffoldStore } from '@deepseek-ai/dsh-jira-core/scaffold.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'

/** The shipped branch layer whose jira rows this suite boots. */
const BRANCH_LAYER = new URL('../../bundle/web-app/cordis.patch.uitstalie.yml', import.meta.url)

/** The standalone bundle `DH-203` removed; its return would duplicate every row. */
const STANDALONE_BUNDLE = new URL('../../bundle/jira-app', import.meta.url)

/** Rows of the branch layer this suite keeps: the jira capability and the organizer it joins. */
const JIRA_ROWS = new Set(['dafeiyu', 'jira-service', 'jira-agent', 'jira-ui'])

/** Host services the kept rows inject; every one is a real package from the profile. */
const BASE_ROWS: Readonly<Record<string, unknown>> = Object.freeze({
  '@deepseek-ai/dsh-system-prompt': SystemPromptPlugin,
  '@deepseek-ai/dsh-tools': ToolsPlugin,
  '@deepseek-ai/dsh-tool-executor-native': ToolExecutorPlugin,
  '@deepseek-ai/dsh-commands': CommandsPlugin,
  '@deepseek-ai/dsh-skill': SkillPlugin,
})

/** Plugin modules the kept rows name, so the Loader resolves them without a profile install. */
const JIRA_MODULES: Readonly<Record<string, unknown>> = Object.freeze({
  '@deepseek-ai/dsh-dafeiyu': DafeiyuPlugin,
  '@deepseek-ai/dsh-jira-service': JiraServicePlugin,
  '@deepseek-ai/dsh-jira-agent': JiraAgentPlugin,
  '@deepseek-ai/dsh-client-ui-jira': JiraUiPlugin,
})

let context: Context | undefined
let root: string | undefined
/** The process facts the composition reads, restored after each case. */
let previousEnv: { home: string | undefined; jira: string | undefined } | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  // The service resolves the root and the machine identity when it **opens**, which happens on the
  // first ledger operation, not at mount. Restoring the environment when `compose` returned would
  // point that first open at the developer's own ledger, so it stays in place for the whole case.
  if (previousEnv !== undefined) {
    if (previousEnv.home === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousEnv.home
    if (previousEnv.jira === undefined) delete process.env.JIRA_ROOT
    else process.env.JIRA_ROOT = previousEnv.jira
    previousEnv = undefined
  }
})

/** The branch layer's insert operations, filtered to the rows this suite boots. */
const shippedJiraPatches = (): PatchOptions[] =>
  loadOverlayPatches('dsh', fileURLToPath(BRANCH_LAYER))
    .map((patch) => {
      const insert = (patch.insert ?? []).filter(row => typeof row.id === 'string' && JIRA_ROWS.has(row.id))
      return { ...patch, insert }
    })
    .filter(patch => (patch.insert ?? []).length > 0)

/**
 * Boot the base rows plus the shipped jira rows through the real Loader.
 * @param dir - the scratch directory holding the ledger and the include file.
 * @param ledger - the scaffolded ledger the service row resolves through `JIRA_ROOT`.
 * @returns the contexts and the number of times each plugin module was imported.
 */
const compose = async (dir: string, ledger: string): Promise<{ ctx: Context; imports: Map<string, number> }> => {
  const configPath = join(dir, 'cordis.yml')
  const lines = Object.keys(BASE_ROWS).map(name => `- name: '${name}'`)
  await writeFile(configPath, `${lines.join('\n')}\n`, 'utf8')

  previousEnv = { home: process.env.DSH_HOME, jira: process.env.JIRA_ROOT }
  process.env.DSH_HOME = dir
  process.env.JIRA_ROOT = ledger
  const ctx = context = new Context()
  ctx.baseUrl = `${pathToFileURL(dir).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const imports = new Map<string, number>()
  const modules: Readonly<Record<string, unknown>> = { ...BASE_ROWS, ...JIRA_MODULES }
  ctx.loader.internal = {
    version: 'v2',
    loadCache: new Map(),
    async import(specifier: string) {
      const module = modules[specifier]
      if (module === undefined) throw new Error(`Unexpected Loader import: ${specifier}`)
      imports.set(specifier, (imports.get(specifier) ?? 0) + 1)
      return module
    },
    register: () => {},
    getOrCreateModuleJob: () => Promise.reject(new Error('the composition never creates a module job')),
    resolveSync: () => { throw new Error('the composition never resolves synchronously') },
    load: () => Promise.reject(new Error('the composition never loads a module body')),
  }
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href, patches: shippedJiraPatches() },
  })
  await ctx.loader.await()
  return { ctx, imports }
}

describe('jira bundle composition', () => {
  it('mounts each shipped jira row exactly once through the Loader (DH-308)', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-jira-compose-'))
    const ledger = join(root, 'ledger')
    expect((await scaffoldStore(ledger)).ok).toBe(true)
    const { ctx, imports } = await compose(root, ledger)

    // One import per row: a duplicated insert or a second layer would mount the module twice.
    expect(imports.get('@deepseek-ai/dsh-jira-service')).toBe(1)
    expect(imports.get('@deepseek-ai/dsh-jira-agent')).toBe(1)
    expect(imports.get('@deepseek-ai/dsh-client-ui-jira')).toBe(1)
    expect(imports.get('@deepseek-ai/dsh-dafeiyu')).toBe(1)

    expect(ctx.jira.status().root.replaceAll('\\', '/')).toBe(ledger.replaceAll('\\', '/'))

    const status = ctx.dafeiyu.status().find(entry => entry.id === 'jira')
    expect(status?.present).toBe(true)
    expect(status?.state).toBe('active')
    // The capability list links to the section the browser half registers, once.
    expect(status?.settings?.sectionId).toBe(JiraUiPlugin.JIRA_SETTINGS_SECTION)
    expect(JiraUiPlugin.JIRA_SETTINGS_SECTION).toBe('jira')
    expect(JiraUiPlugin.JIRA_SETTINGS_ORDER).toBe(200)

    expect(existsSync(fileURLToPath(STANDALONE_BUNDLE))).toBe(false)
  })

  it('registers three tools, /jira and three skills once, then writes what the command reads (DH-308)', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-jira-compose-'))
    const ledger = join(root, 'ledger')
    expect((await scaffoldStore(ledger)).ok).toBe(true)
    const { ctx } = await compose(root, ledger)

    const agent = {
      id: 'composition-1',
      session: { header: { cwd: root } },
      options: {},
      ctx,
    }
    // The organizer wires a capability's contributions when an agent appears.
    await ctx.serial('agent/created', { agent: agent as never, source: 'startup' })
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })

    const toolNames = ctx.tools.schemas(agent as never).map(schema => schema.name)
    expect(toolNames.filter(name => name === 'jira_issue')).toHaveLength(1)
    expect(toolNames.filter(name => name === 'jira_list')).toHaveLength(1)
    expect(toolNames.filter(name => name === 'jira_kb')).toHaveLength(1)

    const commands = ctx.commands.list(agent as never).filter(command => command.name === 'jira')
    expect(commands).toHaveLength(1)
    // The skill registry reads the three files on its own activation, which happens after this
    // test's one tick; wait for the registrations instead of sleeping a fixed amount.
    const jiraSkills = ['jira-work', 'jira-board', 'jira-triage']
    const deadline = Date.now() + 5_000
    let skills = await ctx.skills.list()
    while (!jiraSkills.every(name => skills.some(skill => skill.name === name)) && Date.now() < deadline) {
      await new Promise<void>((resolve) => { setTimeout(resolve, 10) })
      skills = await ctx.skills.list()
    }
    for (const name of jiraSkills) {
      expect(skills.filter(skill => skill.name === name)).toHaveLength(1)
    }

    // The durable result: a tool write lands on disk and in the ledger's history...
    const batch = await ctx.tools.execute({
      calls: [{
        type: 'tool-call',
        id: ToolCallId('compose-1'),
        name: 'jira_issue',
        arguments: JSON.stringify({ action: 'create', project: 'DH', data: { summary: 'composition proof' } }),
      }],
      agent: agent as never,
      signal: new AbortController().signal,
    })
    const result = batch.results[0]?.result
    expect(result).toBeDefined()
    // The registry keeps the canonical envelope in `value`; the text block is the human render.
    const envelope = result?.value as { ok?: boolean; issue?: { key?: string } } | undefined
    expect(envelope?.ok).toBe(true)
    const key = envelope?.issue?.key
    expect(key).toMatch(/^DH-\d+$/u)
    expect(existsSync(join(ledger, 'projects', 'DH', 'issues', `${String(key)}.md`))).toBe(true)
    const log = await runGit(ledger, ['log', '--format=%s'])
    expect(log.stdout.split('\n').some(line => line.startsWith(`${String(key)}: create`))).toBe(true)

    // ...and the user-visible command reads that same durable state back. `execute` would append
    // lifecycle events to a session this test does not run, so call the registered handler.
    const definition = ctx.commands.find(agent as never, 'jira')
    expect(definition).toBeDefined()
    const shown = await definition!.handler({
      commandId: 'composition-command' as never,
      agent: agent as never,
      rawInput: `show ${String(key)}`,
      attachments: [],
      signal: new AbortController().signal,
    })
    expect(shown.kind).toBe('success')
    expect(shown.text).toContain(String(key))
    expect(shown.text).toContain('composition proof')
    expect(await readFile(join(ledger, 'projects', 'DH', 'issues', `${String(key)}.md`), 'utf8')).toContain('composition proof')
  })
})
