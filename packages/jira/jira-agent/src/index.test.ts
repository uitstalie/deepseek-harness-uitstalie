/**
 * Tests for the jira agent's registration, driven through the **real** service tree.
 *
 * The composition is the shipped one — real system-prompt/tool/command/skill registries, the real
 * dafeiyu organizer, the real `jira-service` provider and a real store — with only the process
 * facts pinned (environment and clock). That is what lets these tests catch what a hand-built
 * stand-in cannot: a capability the organizer never activates, a tool the registry rejects, a
 * command whose registration throws, or a settle that does not commit.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { checkGenerated } from '@deepseek-ai/dsh-jira-core/generateStore.ts'
import { initializeRepository, runGit, stageAllAndCommit } from '@deepseek-ai/dsh-jira-core/git.ts'
import { writeTextAtomic } from '@deepseek-ai/dsh-jira-core/io.ts'
import { createStore, storePaths } from '@deepseek-ai/dsh-jira-core/store.ts'
import { removeTree } from '@deepseek-ai/dsh-jira-core/testing/removeTree.ts'
import {
  KB_TOOL_NAME,
  LIST_TOOL_NAME,
  TOOL_NAME,
  settleCompletedTurn,
} from './index.ts'
import * as jiraAgent from './index.ts'
import { JIRA_AWARENESS_SECTION_NAME } from './awareness.ts'
import {
  CONFIG_FIXTURE,
  concurrencySafe,
  type JiraHarness,
  MACHINE,
  createLedgerFixture,
  mountJira,
  testAgent,
  waitFor,
} from './testing/host.ts'

/**
 * Run on a machine that **cannot guess a git identity** — which is what CI runners are. `git
 * pull --rebase`/`commit` replay commits and need a committer identity; pinning
 * `user.useConfigOnly` reproduces that condition locally instead of only on CI.
 */
process.env.GIT_CONFIG_COUNT = '1'
process.env.GIT_CONFIG_KEY_0 = 'user.useConfigOnly'
process.env.GIT_CONFIG_VALUE_0 = 'true'
const identityIsConfigured = ['--global', '--system'].some(scope =>
  (spawnSync('git', ['config', scope, '--get', 'user.name'], { encoding: 'utf8' }).stdout).trim() !== '')
let emptyGitConfig = ''
const throwaway: string[] = []
if (identityIsConfigured) {
  const emptyConfig = join(tmpdir(), `dsh-jira-empty-gitconfig-${String(process.pid)}`)
  emptyGitConfig = emptyConfig
  writeFileSync(emptyConfig, '', 'utf8')
  process.env.GIT_CONFIG_GLOBAL = emptyConfig
  process.env.GIT_CONFIG_SYSTEM = emptyConfig
  process.env.GIT_CONFIG_NOSYSTEM = '1'
}

let root = ''

/** What one registry dispatch returns, as the tests read it. */
interface DispatchResult {
  readonly isError: boolean
  readonly value?: unknown
  readonly content: readonly { readonly type: string; readonly text?: string }[]
}

/** The result of one registry dispatch with its envelope unwrapped. */
const envelopeOf = (result: DispatchResult): Record<string, unknown> => {
  assert.equal(result.isError, false, textOf(result))
  const value = result.value
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value), 'a tool must return an object envelope')
  return value as Record<string, unknown>
}

const textOf = (result: Pick<DispatchResult, 'content'>): string =>
  result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')

/** One nested JSON object from an envelope field. */
const recordOf = (value: unknown): Record<string, unknown> => {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value), `expected an object, got ${JSON.stringify(value)}`)
  return value as Record<string, unknown>
}

/** One JSON array from an envelope field. */
const listOf = (value: unknown): readonly unknown[] => {
  assert.ok(Array.isArray(value), `expected an array, got ${JSON.stringify(value)}`)
  return value
}

/** The typed failure of an envelope. */
const failureOf = (envelope: Record<string, unknown>): { code: string; message: string; context?: Record<string, unknown> } => {
  assert.equal(envelope.ok, false, `expected a failure, got ${JSON.stringify(envelope)}`)
  const error = recordOf(envelope.error)
  return {
    code: String(error.code),
    message: String(error.message),
    ...(error.context === undefined ? {} : { context: recordOf(error.context) }),
  }
}

let calls = 0
/** Dispatch one tool call through the real registry. */
const call = async (
  harness: JiraHarness,
  agent: ReturnType<typeof testAgent>,
  args: unknown,
  name: string = TOOL_NAME,
): Promise<Record<string, unknown>> => {
  calls += 1
  const result = await harness.ctx.tools.execute({
    name,
    callId: ToolCallId(`call-${String(calls)}`),
    arguments: args,
    agent,
    signal: new AbortController().signal,
  })
  return envelopeOf(result)
}

/** The issue of a successful envelope. */
const issueOf = (envelope: Record<string, unknown>): Record<string, unknown> => recordOf(envelope.issue)

/** Mount the plugin as its own fiber and wire it onto one root agent. */
const mountWired = async (
  ledger: string,
  options: Parameters<typeof mountJira>[1] = {},
): Promise<{ harness: JiraHarness; agent: ReturnType<typeof testAgent>; fiber: { dispose(): Promise<void> } }> => {
  const harness = await mountJira(ledger, options)
  const fiber = await harness.ctx.plugin(jiraAgent)
  await settle()
  const agent = testAgent(harness.ctx, 'main-1')
  await harness.ctx.serial('agent/created', { agent, source: 'startup' })
  return { harness, agent, fiber }
}

/** Let activation and dispatch continuations run. */
const settle = async (): Promise<void> => {
  await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
}

/** A store that has an issue and a vocabulary, but no generated file yet. */
const storeWithoutGenerated = async (): Promise<string> => {
  const dir = await createLedgerFixture()
  throwaway.push(dir)
  return dir
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await readFile(path, 'utf8')
    return true
  } catch {
    return false
  }
}

before(async () => {
  root = await createLedgerFixture()
  throwaway.push(root)
})

after(async () => {
  for (const dir of throwaway.splice(0)) await removeTree(dir)
  if (emptyGitConfig !== '') rmSync(emptyGitConfig, { force: true })
})

describe('agent: the capability and its surfaces (contract §3)', () => {
  it('registers the jira capability with the organizer and wires the tools onto a root agent', async () => {
    const { harness, agent } = await mountWired(root)
    try {
      const status = harness.ctx.dafeiyu.status().find(entry => entry.id === 'jira')
      assert.ok(status !== undefined, 'the organizer must see one jira capability')
      assert.equal(status.present, true)
      assert.equal(status.enabled, true)
      assert.equal(status.state, 'active')

      const names = harness.ctx.tools.schemas(agent).map(schema => schema.name)
      assert.deepEqual([...names].sort(), [TOOL_NAME, LIST_TOOL_NAME, KB_TOOL_NAME].sort())
    } finally {
      await harness.dispose()
    }
  })

  it('contributes the awareness line as a prompt section, refreshed from the ledger', async () => {
    const { harness, agent } = await mountWired(root)
    try {
      const section = await waitFor(async () => {
        const assembly = await harness.ctx.systemPrompt.assemble(assembleContextFor(agent))
        const found = assembly.sections.find(entry => entry.name === JIRA_AWARENESS_SECTION_NAME)
        return found !== undefined && found.text !== '' ? found : undefined
      })
      assert.match(section.text, /^\[store\] .*\d+ projects · \d+ knowledge · \d+ open issues( \| read-only: \d+)?$/u)
    } finally {
      await harness.dispose()
    }
  })

  it('injects nothing for an empty ledger — a session pays nothing for a ledger it does not have', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'dsh-jira-agent-empty-'))
    throwaway.push(empty)
    await writeTextAtomic(storePaths.config(empty), CONFIG_FIXTURE)
    const { harness, agent } = await mountWired(empty)
    try {
      await settle()
      const assembly = await harness.ctx.systemPrompt.assemble(assembleContextFor(agent))
      const section = assembly.sections.find(entry => entry.name === JIRA_AWARENESS_SECTION_NAME)
      assert.equal(section?.text ?? '', '', 'an empty store injects no line')
    } finally {
      await harness.dispose()
    }
  })

  it('registers /jira and the three bundled skills', async () => {
    const { harness, agent } = await mountWired(root)
    try {
      const commands = harness.ctx.commands.list(agent).map(command => command.name)
      assert.ok(commands.includes('jira'), `the /jira command must be registered (got ${commands.join(', ')})`)
      // The skills are read from disk when the skill registry activates, so the catalogue is
      // observed rather than sampled after one tick.
      const skills = await waitFor(async () => {
        const names = (await harness.ctx.skills.list()).map(skill => skill.name)
        return ['jira-work', 'jira-board', 'jira-triage'].every(name => names.includes(name)) ? names : undefined
      })
      assert.ok(skills.length > 0)
    } finally {
      await harness.dispose()
    }
  })

  it('does nothing when the organizer gate is closed', async () => {
    const { harness } = await mountWired(root, { enabled: false })
    try {
      const status = harness.ctx.dafeiyu.status().find(entry => entry.id === 'jira')
      assert.equal(status?.state, 'disabled')
    } finally {
      await harness.dispose()
    }
  })

  it('undoes every registration when the plugin fiber is disposed', async () => {
    const { harness, agent, fiber } = await mountWired(root)
    try {
      assert.equal(harness.ctx.dafeiyu.status().length, 1)
      assert.ok(harness.ctx.tools.get(TOOL_NAME, agent) !== undefined)

      await fiber.dispose()
      assert.deepEqual(
        harness.ctx.dafeiyu.status(),
        [{ id: 'jira', present: false, enabled: true, state: 'missing' }],
        'the capability is gone; the configured gate is the only trace left',
      )
      assert.equal(harness.ctx.tools.get(TOOL_NAME, agent), undefined, 'the tools are gone')
      const commands = harness.ctx.commands.list(agent).map(command => command.name)
      assert.equal(commands.includes('jira'), false, 'the command is gone')
      await fiber.dispose() // idempotent: a second dispose must not throw
    } finally {
      await harness.dispose()
    }
  })
})

describe('agent: the write guard (decision 96)', () => {
  it('denies a write from a read-only session before the handler runs', async () => {
    process.env.DSH_READ_ONLY_SESSION = '1'
    try {
      const { harness, agent } = await mountWired(root, { env: { DSH_READ_ONLY_SESSION: '1' } })
      try {
        const denied = await harness.ctx.tools.execute({
          name: TOOL_NAME,
          callId: ToolCallId('guard-1'),
          arguments: { action: 'update', key: 'DH-12', data: { summary: 'nope' } },
          agent,
          signal: new AbortController().signal,
        })
        assert.equal(denied.isError, true)
        assert.match(textOf(denied), /writes the ledger, and this session may not write \(dsh-read-only\)/u)
      } finally {
        await harness.dispose()
      }
    } finally {
      delete process.env.DSH_READ_ONLY_SESSION
    }
  })

  it('lets reads through in a read-only session', async () => {
    process.env.DSH_READ_ONLY_SESSION = '1'
    try {
      const { harness, agent } = await mountWired(root, { env: { DSH_READ_ONLY_SESSION: '1' } })
      try {
        const read = await call(harness, agent, { action: 'get', key: 'DH-12' })
        assert.equal(read.ok, true)
        assert.equal(read.writable, false)
        assert.equal(read.reason, 'dsh-read-only')
      } finally {
        await harness.dispose()
      }
    } finally {
      delete process.env.DSH_READ_ONLY_SESSION
    }
  })
})

describe('agent: what the tools declare', () => {
  it('registers the resident tools, the first carrying all ten verbs', async () => {
    const { harness, agent } = await mountWired(root)
    try {
      const definition = harness.ctx.tools.get(TOOL_NAME, agent)
      assert.ok(definition !== undefined)
      const parameters = definition.parameters
      assert.equal(parameters.additionalProperties, false)
      const properties = parameters.properties as Record<string, Record<string, unknown>>
      assert.deepEqual(properties.action?.enum, ['get', 'create', 'update', 'switch_state', 'comment', 'assignee', 'link', 'tag_create', 'close', 'batch_close'])
      assert.deepEqual(parameters.required, ['action'])
      assert.equal(Object.hasOwn(properties.action, 'required'), false, 'standard dialect: no per-property required')
    } finally {
      await harness.dispose()
    }
  })

  it('declares an output schema whose required fields every value carries', async () => {
    const { harness, agent } = await mountWired(root)
    try {
      for (const name of [TOOL_NAME, LIST_TOOL_NAME, KB_TOOL_NAME]) {
        const definition = harness.ctx.tools.get(name, agent)
        assert.ok(definition !== undefined, name)
        const schema = definition.output.schema as { required?: readonly string[]; additionalProperties?: boolean }
        assert.deepEqual(schema.required, ['ok', 'writable', 'me'], name)
        assert.equal(schema.additionalProperties, true)
      }
      const carries = (value: Record<string, unknown>, what: string): void => {
        for (const field of ['ok', 'writable', 'me']) {
          assert.ok(Object.hasOwn(value, field), `${what} must carry ${field}: ${JSON.stringify(value)}`)
        }
      }
      carries(await call(harness, agent, { action: 'get', key: 'DH-12' }), 'a read')
      carries(await call(harness, agent, { action: 'get', key: 'DH-99' }), 'a refusal')
      carries(await call(harness, agent, { action: 'update', key: 'DH-12', data: { summary: '' } }), 'a refused write')
    } finally {
      await harness.dispose()
    }
  })

  it('declares a read budget for the read tool, and only reads as concurrency-safe', async () => {
    const { harness, agent } = await mountWired(root)
    try {
      const list = harness.ctx.tools.get(LIST_TOOL_NAME, agent)
      const jira = harness.ctx.tools.get(TOOL_NAME, agent)
      assert.ok(list !== undefined)
      assert.ok(jira !== undefined)
      assert.equal(list.timeoutMs, 5_000, 'a read must not be allowed to hang as long as a write')
      assert.equal(concurrencySafe(list, {}), true, 'a pure read may overlap a sibling call')
      assert.equal(jira.timeoutMs, 30_000, 'a mixed tool takes the write budget')
      assert.equal(concurrencySafe(jira, { action: 'get' }), true, 'the read action may overlap')
      assert.equal(concurrencySafe(jira, { action: 'update' }), false, 'a write may not')
      assert.equal(concurrencySafe(jira, {}), false, 'and neither may a call we cannot classify')
    } finally {
      await harness.dispose()
    }
  })
})

describe('agent: reading, writing and the envelope', () => {
  it('returns the issue, the comments and the session\'s identity', async () => {
    const { harness, agent } = await mountWired(root)
    try {
      const value = await call(harness, agent, { action: 'get', key: 'DH-12' })
      assert.equal(value.writable, true)
      const issue = issueOf(value)
      assert.equal(issue.key, 'DH-12')
      assert.equal(issue.summary, 'first')
      assert.deepEqual(listOf(value.comments), [])
      assert.deepEqual(recordOf(value.me), { tool: 'dsh', machine: MACHINE, session: 'main-1' })
    } finally {
      await harness.dispose()
    }
  })

  it('creates, updates, comments, claims, links and closes with the store rules intact', async () => {
    const dir = await storeWithoutGenerated()
    const { harness, agent } = await mountWired(dir)
    try {
      const created = issueOf(await call(harness, agent, { action: 'create', project: 'DH', data: { summary: 'brand new', tags: ['demo'] } }))
      assert.equal(created.key, 'DH-13', 'the next key the store allocates (DH-12 exists)')
      assert.equal(created.status, 'todo')
      assert.equal(created.priority, 'S3')

      const updated = issueOf(await call(harness, agent, { action: 'update', key: 'DH-13', data: { summary: 'renamed', priority: 'S1' } }))
      assert.equal(updated.summary, 'renamed')
      assert.equal(updated.revision, 2)

      const stale = failureOf(await call(harness, agent, { action: 'update', key: 'DH-13', expected_revision: 1, data: { summary: 'x' } }))
      assert.equal(stale.code, 'STALE_REVISION')
      const staleContext = recordOf(stale.context)
      assert.equal(staleContext.expected, 1)
      assert.equal(staleContext.actual, 2)

      const commented = await call(harness, agent, { action: 'comment', key: 'DH-13', comment: { body: 'noted' } })
      const comments = listOf(commented.comments)
      assert.equal(comments.length, 1)
      assert.equal(recordOf(comments[0]).body, 'noted')
      assert.equal(recordOf(comments[0]).id, `c-${MACHINE.slice(0, 4)}-1`)

      const claimed = issueOf(await call(harness, agent, { action: 'assignee', key: 'DH-13', assignee: 'self' }))
      assert.equal(claimed.assignee, `agent:unknown|dsh|${MACHINE}|main-1`)
      const released = issueOf(await call(harness, agent, { action: 'assignee', key: 'DH-13', assignee: 'none' }))
      assert.equal('assignee' in released, false)

      const moved = issueOf(await call(harness, agent, { action: 'switch_state', key: 'DH-13', to: 'in_progress' }))
      assert.equal(moved.status, 'in_progress')
      const refused = failureOf(await call(harness, agent, { action: 'switch_state', key: 'DH-13', to: 'closed' }))
      assert.equal(refused.code, 'RESOLUTION_REQUIRED')
      const closed = issueOf(await call(harness, agent, { action: 'switch_state', key: 'DH-13', to: 'closed', resolution: 'fixed' }))
      assert.equal(closed.status, 'closed')
      assert.equal(closed.resolution, 'fixed')

      const linked = issueOf(await call(harness, agent, { action: 'link', key: 'DH-13', link: { type: 'is_blocked_by', target: 'DH-12' } }))
      assert.deepEqual(listOf(linked.links), [{ type: 'is_blocked_by', target: 'DH-12' }])
    } finally {
      await harness.dispose()
    }
  })

  it('refuses a stale write, an unknown data field and a bad action by name', async () => {
    const dir = await storeWithoutGenerated()
    const { harness, agent } = await mountWired(dir)
    try {
      const typo = failureOf(await call(harness, agent, { action: 'update', key: 'DH-12', data: { summmary: 'typo' } }))
      assert.equal(typo.code, 'INVALID_INPUT')
      assert.match(typo.message, /unknown data field\(s\): summmary/u)

      const unknownArgument = failureOf(await call(harness, agent, { action: 'get', keyy: 'DH-12' }))
      assert.match(String(unknownArgument.context?.issues), /unknown argument "keyy"/u)

      const badAction = failureOf(await call(harness, agent, { action: 'delete', key: 'DH-12' }))
      assert.match(String(badAction.context?.issues), /must be one of: get, create/u)

      const traversal = failureOf(await call(harness, agent, { action: 'create', project: '../../tmp/x', data: { summary: 'x' } }))
      assert.equal(traversal.code, 'INVALID_INPUT')
      assert.match(traversal.message, /create needs `project`/u)
    } finally {
      await harness.dispose()
    }
  })

  it('never throws, whatever it is handed', async () => {
    const { harness, agent } = await mountWired(root)
    try {
      // `undefined` never reaches a tool: the registry refuses non-JSON arguments before dispatch,
      // so the envelope is what a reachable call can be handed.
      for (const args of [null, 42, 'nope', [], {}, { action: 'get' }, { action: 'update', key: 7 }]) {
        const value = await call(harness, agent, args)
        assert.equal(value.ok, false, JSON.stringify(args))
        assert.equal(typeof value.writable, 'boolean')
      }
    } finally {
      await harness.dispose()
    }
  })

  it('refuses a subagent\'s write at the guard, and lets it read', async () => {
    const { harness } = await mountWired(root)
    const child = testAgent(harness.ctx, 'child-1', { origin: 'subagent', delegationDepth: 1 })
    try {
      const read = await call(harness, child, { action: 'get', key: 'DH-12' })
      assert.equal(read.ok, true)
      assert.equal(read.writable, false)
      assert.equal(read.reason, 'subagent')

      const denied = await harness.ctx.tools.execute({
        name: TOOL_NAME,
        callId: ToolCallId('guard-subagent'),
        arguments: { action: 'update', key: 'DH-12', data: { summary: 'nope' } },
        agent: child,
        signal: new AbortController().signal,
      })
      assert.equal(denied.isError, true)
      assert.match(textOf(denied), /may not write \(subagent\)/u)
    } finally {
      await harness.dispose()
    }
  })
})

describe('agent: jira_list and jira_kb', () => {
  it('lists every issue with counts that agree with each other', async () => {
    const { harness, agent } = await mountWired(root)
    try {
      const value = await call(harness, agent, { include_closed: true }, LIST_TOOL_NAME)
      assert.equal(value.ok, true, JSON.stringify(value.error))
      const items = listOf(value.items)
      const counts = recordOf(value.counts)
      assert.ok(items.length > 0)
      assert.equal(counts.matched, items.length)
      assert.equal(counts.returned, items.length)
      assert.equal(counts.remaining, 0)
      assert.equal(value.truncated, false)
      assert.equal(value.limit, 20)
      assert.equal(listOf(value.groups).flatMap(group => listOf(recordOf(group).items)).length, items.length, 'every item is in a group')
    } finally {
      await harness.dispose()
    }
  })

  it('hides closed issues unless asked, and filters by status', async () => {
    const dir = await storeWithoutGenerated()
    const { harness, agent } = await mountWired(dir)
    try {
      const created = issueOf(await call(harness, agent, { action: 'create', project: 'DH', data: { summary: 'closable' } }))
      const key = String(created.key)
      await call(harness, agent, { action: 'switch_state', key, to: 'in_progress' })
      await call(harness, agent, { action: 'close', key, resolution: 'fixed' })

      const open = await call(harness, agent, {}, LIST_TOOL_NAME)
      const openKeys = listOf(open.items).map(item => recordOf(item).key)
      assert.equal(openKeys.includes(key), false, 'closed work is out of the default view')
      const all = await call(harness, agent, { include_closed: true }, LIST_TOOL_NAME)
      assert.ok(listOf(all.items).map(item => recordOf(item).key).includes(key), 'the closed one came back with include_closed')
    } finally {
      await harness.dispose()
    }
  })

  it('starts empty, creates a knowledge entry, then reads and searches it', async () => {
    const dir = await storeWithoutGenerated()
    const { harness, agent } = await mountWired(dir)
    try {
      const empty = await call(harness, agent, { action: 'search', query: 'mkdir' }, KB_TOOL_NAME)
      assert.deepEqual(listOf(empty.hits), [])

      const created = await call(harness, agent, {
        action: 'create',
        data: {
          domain: 'locking',
          type: 'pitfall',
          title: 'Windows 上的锁必须用 mkdir',
          tags: ['windows'],
          body: 'flock 在 Windows 上不是原子的，用 mkdir。\n',
        },
      }, KB_TOOL_NAME)
      const item = recordOf(created.item)
      assert.equal(item.key, 'KB-1')
      assert.equal(recordOf(item.source).machine_id, MACHINE, 'the lineage is recorded by the store, not typed')
      assert.equal(recordOf(item.source).tool, 'dsh')
      // The plugin reads the process clock, so the capture time is "now": what the store promises
      // is the UTC second format and the identity, not a pinned instant.
      assert.match(String(recordOf(item.source).captured_at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u)

      const found = await call(harness, agent, { action: 'get', key: 'KB-1' }, KB_TOOL_NAME)
      assert.equal(recordOf(found.item).title, 'Windows 上的锁必须用 mkdir')

      const search = await call(harness, agent, { action: 'search', query: 'mkdir' }, KB_TOOL_NAME)
      const hits = listOf(search.hits)
      assert.equal(hits.length, 1)
      assert.equal(recordOf(hits[0]).file, 'knowledge/locking/KB-1.md')
      assert.equal(Object.hasOwn(recordOf(hits[0]), 'body'), false, 'a hit is a citation, not the entry')

      const updated = await call(harness, agent, { action: 'update', key: 'KB-1', data: { title: '锁：一律用 mkdir' } }, KB_TOOL_NAME)
      assert.equal(recordOf(updated.item).title, '锁：一律用 mkdir')
      const bad = failureOf(await call(harness, agent, { action: 'create', data: { domain: 'locking', type: 'note', title: 'x' } }, KB_TOOL_NAME))
      assert.match(bad.message, /is not one of: runbook/u)
    } finally {
      await harness.dispose()
    }
  })
})

describe('agent: the turn-end settle (contract §3)', () => {
  it('regenerates and commits, so what gets pushed agrees with its sources', async () => {
    const dir = await storeWithoutGenerated()
    const { harness, agent } = await mountWired(dir)
    try {
      assert.equal(await exists(join(dir, 'BOARD.md')), false, 'nothing generated before the turn ends')
      await settleCompletedTurn(harness.host, agent, 1, '')
      assert.equal(await exists(join(dir, 'BOARD.md')), true, 'BOARD.md is there after the turn end')
      assert.equal(await exists(join(dir, 'index.md')), true)
      const log = await runGit(dir, ['log', '--format=%s'])
      assert.match(log.stdout, /重生成派生工件/u)
    } finally {
      await harness.dispose()
    }
  })

  it('writes nothing when the session may not write', async () => {
    const dir = await storeWithoutGenerated()
    const { harness, agent } = await mountWired(dir, { env: { DSH_READ_ONLY_SESSION: '1' } })
    try {
      await settleCompletedTurn(harness.host, agent, 1, '')
      assert.equal(await exists(join(dir, 'BOARD.md')), false, 'a read-only session must not generate')
    } finally {
      await harness.dispose()
    }
  })

  it('leaves nothing uncommitted, so a checkout of the commit passes the gate', async () => {
    const dir = await storeWithoutGenerated()
    const issueFile = join(dir, 'projects', 'DH', 'issues', 'DH-12.md')
    const text = await readFile(issueFile, 'utf8')
    await writeFile(issueFile, text.replace(/^summary: .*$/mu, 'summary: 人改的，还没提交'), 'utf8')

    const { harness, agent } = await mountWired(dir)
    try {
      await settleCompletedTurn(harness.host, agent, 1, '')
      assert.equal((await runGit(dir, ['status', '--porcelain'])).stdout, '', 'the tree is clean afterwards')
      const checked = await checkGenerated(createStore({ root: dir, machineId: MACHINE }))
      assert.ok(checked.ok, JSON.stringify(checked))
      assert.deepEqual([...checked.value], [], 'a checkout of that commit is fresh')
      assert.match(await readFile(issueFile, 'utf8'), /人改的，还没提交/u, 'the human\'s text is in a commit, not lost')
    } finally {
      await harness.dispose()
    }
  })

  it('records what a writable session touched, and a read-only one does not even scan', async () => {
    const scanFixture = async (): Promise<string> => {
      const dir = await storeWithoutGenerated()
      assert.equal((await initializeRepository(dir)).ok, true)
      assert.equal((await stageAllAndCommit(dir, 'chore: store skeleton [no-issue]')).ok, true)
      return dir
    }
    const endAfterCommit = async (dir: string, env: Record<string, string>): Promise<void> => {
      const head = (await runGit(dir, ['rev-parse', 'HEAD'])).stdout.trim()
      const { harness, agent } = await mountWired(dir, { env })
      try {
        const landed = await runGit(dir, ['-c', 'user.name=dsh-jira', '-c', 'user.email=jira@local', 'commit', '--allow-empty', '-m', 'DH-12: something happened'])
        assert.equal(landed.code, 0, landed.stderr)
        await settleCompletedTurn(harness.host, agent, 1, head)
      } finally {
        await harness.dispose()
      }
    }

    const writable = await scanFixture()
    await endAfterCommit(writable, {})
    assert.match(await readFile(join(writable, 'projects', 'DH', 'comments', 'DH-12.md'), 'utf8'), /touched DH-12/u)
    assert.equal(await exists(join(writable, '.jira', 'dsh-jira', 'session-scan', 'main-1.json')), true)

    const readOnly = await scanFixture()
    await endAfterCommit(readOnly, { DSH_READ_ONLY_SESSION: '1' })
    assert.equal(await exists(join(readOnly, 'BOARD.md')), false, 'no regeneration')
    assert.equal(await exists(join(readOnly, 'projects', 'DH', 'comments', 'DH-12.md')), false, 'no scan comment')
    assert.equal(await exists(join(readOnly, '.jira', 'dsh-jira', 'session-scan', 'main-1.json')), false, 'and the scan did not even run')
  })
})

describe('agent: the wire and the render path (decisions 41/159)', () => {
  it('never hands the model a camelCase key, all the way down', async () => {
    const walk = (value: unknown, path: string): void => {
      if (Array.isArray(value)) {
        value.forEach((entry, index) => { walk(entry, `${path}[${String(index)}]`) })
        return
      }
      if (value === null || typeof value !== 'object') return
      for (const [key, entry] of Object.entries(value)) {
        assert.match(key, /^[a-z0-9_]+$/u, `${path}.${key} is not snake_case`)
        walk(entry, `${path}.${key}`)
      }
    }
    const { harness, agent } = await mountWired(root)
    try {
      walk(await call(harness, agent, { action: 'get', key: 'DH-12' }), 'get')
      walk(await call(harness, agent, { action: 'get', key: 'DH-99' }), 'refusal')
      walk(await call(harness, agent, { include_closed: true }, LIST_TOOL_NAME), 'list')
      walk(await call(harness, agent, { action: 'search', query: 'anything' }, KB_TOOL_NAME), 'kb')
    } finally {
      await harness.dispose()
    }
  })

  it('renders every result, which is the path a live call actually takes', async () => {
    const { harness, agent } = await mountWired(root)
    try {
      const render = async (args: unknown, name: string): Promise<string> => {
        const result = await harness.ctx.tools.execute({
          name,
          callId: ToolCallId(`render-${String(++calls)}`),
          arguments: args,
          agent,
          signal: new AbortController().signal,
        })
        assert.equal(result.isError, false, textOf(result))
        const text = textOf(result)
        assert.ok(text.length > 0, `${name} must render something`)
        return text
      }
      assert.match(await render({ action: 'get', key: 'DH-12' }, TOOL_NAME), /DH-12/u)
      assert.match(await render({ include_closed: true }, LIST_TOOL_NAME), /DH-12/u)
      assert.match(await render({ action: 'search', query: 'nothing' }, KB_TOOL_NAME), /./u)
      assert.match(await render({ action: 'get', key: 'DH-99' }, TOOL_NAME), /NOT_FOUND/u)
    } finally {
      await harness.dispose()
    }
  })
})

describe('agent: a partial read says so, and says which file (decision 80)', () => {
  it('names the unreadable file and warns that the answer is partial', async () => {
    const dir = await storeWithoutGenerated()
    await writeTextAtomic(join(dir, 'projects', 'DH', 'issues', 'DH-13.md'), '# not an issue at all\n')
    const { harness, agent } = await mountWired(dir)
    try {
      const value = await call(harness, agent, { include_closed: true }, LIST_TOOL_NAME)
      assert.equal(value.ok, true, JSON.stringify(value))
      const rejected = listOf(value.rejected)
      assert.equal(rejected.length, 1, 'the readable issue is still returned; only the broken one is reported')
      assert.equal(recordOf(rejected[0]).file, 'projects/DH/issues/DH-13.md')
      assert.match(String(value.message), /partial/u)
      assert.equal(recordOf(value.me).machine, MACHINE, 'and the envelope is intact')
    } finally {
      await harness.dispose()
    }
  })
})

describe('agent: a pure tool session can build the tag vocabulary (decision 192)', () => {
  it('creates a tag through the tool, then tags an issue with it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-jira-agent-tag-'))
    throwaway.push(dir)
    await initializeRepository(dir)
    await writeFile(join(dir, 'config.md'), CONFIG_FIXTURE, 'utf8')
    const { harness, agent } = await mountWired(dir)
    try {
      const tagged = await call(harness, agent, { action: 'tag_create', data: { name: 'mcp', description: 'the MCP surface' } })
      assert.equal(tagged.ok, true, JSON.stringify(tagged))
      const created = await call(harness, agent, { action: 'create', project: 'DH', data: { summary: 'tagged', tags: ['mcp'] } })
      assert.deepEqual(listOf(issueOf(created).tags), ['mcp'])
      const unknown = failureOf(await call(harness, agent, { action: 'create', project: 'DH', data: { summary: 'x', tags: ['nope'] } }))
      assert.deepEqual(listOf(unknown.context?.registered), ['mcp'])
    } finally {
      await harness.dispose()
    }
  })
})

describe('agent: close writes the transition and its comment in one transaction (decision 193)', () => {
  it('closes with a comment as ONE commit, where it used to take two', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-jira-agent-close-'))
    throwaway.push(dir)
    await writeTextAtomic(storePaths.config(dir), CONFIG_FIXTURE)
    const { harness, agent } = await mountWired(dir)
    try {
      const created = issueOf(await call(harness, agent, { action: 'create', project: 'DH', data: { summary: 'to close' } }))
      const key = String(created.key)
      const early = failureOf(await call(harness, agent, { action: 'close', key, resolution: 'fixed' }))
      assert.equal(early.code, 'INVALID_TRANSITION')
      await call(harness, agent, { action: 'switch_state', key, to: 'in_progress' })

      const before = await runGit(dir, ['rev-list', '--count', 'HEAD'])
      const closed = issueOf(await call(harness, agent, { action: 'close', key, resolution: 'fixed', comment: { body: 'done: one transaction' } }))
      const after = await runGit(dir, ['rev-list', '--count', 'HEAD'])
      assert.equal(Number(after.stdout.trim()) - Number(before.stdout.trim()), 1, 'exactly one commit')
      assert.equal(closed.resolution, 'fixed')
      const read = await call(harness, agent, { action: 'get', key })
      assert.ok(listOf(read.comments ?? []).some(entry => String(recordOf(entry).body).includes('one transaction')))
    } finally {
      await harness.dispose()
    }
  })
})

describe('agent: the machine identity is the service\'s (decision 166)', () => {
  it('uses the resolved machine id everywhere, not an invented one', async () => {
    const dir = await storeWithoutGenerated()
    const { harness, agent } = await mountWired(dir)
    try {
      await call(harness, agent, { action: 'create', project: 'DH', data: { summary: 'identity' } })
      const counters = await readdir(join(dir, 'counters')).catch(() => [] as string[])
      assert.equal(counters.includes(`dsh-${MACHINE}.json`), false, 'no invented "dsh-" identity')
      assert.equal(counters.includes(`${MACHINE}.json`), true, 'the service resolves the identity')
    } finally {
      await harness.dispose()
    }
  })
})
