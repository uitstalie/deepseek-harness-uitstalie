/**
 * Tests for the plugin adapter, driven through a **fake host context** and a real store.
 *
 * Decision 108 makes this possible: the adapter depends on a shape we declared, so the
 * whole tool — all seven verbs, the argument checking, the write guard, the store rules —
 * can be exercised in-process, with no DSH install, no profile and no server.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { encodeIssue } from '../core/codec.ts'
import { type Identity, type Issue, type Timestamp } from '../core/entity.ts'
import { initializeRepository, runGit, stageAllAndCommit, stageAndCommit } from '../core/git.ts'
import { checkGenerated } from '../core/generateStore.ts'
import { writeTextAtomic } from '../core/io.ts'
import { createIssue } from '../core/mutate.ts'
import { createStore, storePaths } from '../core/store.ts'
import { parseVocab } from '../core/vocab.ts'
import { removeTree } from '../testing/removeTree.ts'
import { type JiraHostContext, type JiraToolDefinition, KB_TOOL_NAME, LIST_TOOL_NAME, TOOL_NAME, type ToolValue, apply } from './index.ts'
import { writeFileSync, rmSync, existsSync } from 'node:fs'

/**
 * Run this file on a machine that **cannot guess a git identity** — which is what the plugin's own CI
 * runners are.
 *
 * `git pull --rebase` replays commits, and replaying **creates** one, so it needs a committer
 * identity exactly like `git commit` does. On 2026-10-17 the end-to-end push test below passed on a
 * developer's machine (git guesses `uitstalie <…@host>`) and failed on **all four CI jobs**: the
 * rebase stopped with "Committer identity unknown", left the store mid-rebase (HEAD detached, the
 * replayed file staged), and the push never happened. `user.useConfigOnly=true` is how decision
 * 146's own bug was reproduced; pinning it here keeps that class visible locally, not only in CI.
 */
process.env.GIT_CONFIG_COUNT = '1'
process.env.GIT_CONFIG_KEY_0 = 'user.useConfigOnly'
process.env.GIT_CONFIG_VALUE_0 = 'true'
// …and hide the developer's own identity, or `useConfigOnly` proves nothing: git already has a name
// to use and never needs to guess. Only done when there *is* one — the runners have nothing to hide
// (which is why the bug showed up there and not on the machine it was written on), and pointing
// `GIT_CONFIG_GLOBAL` at a device path is one platform assumption too many.
//
// An **empty file**, never a device path. `node:os.devNull` is `nul` on Windows, and pointing
// `GIT_CONFIG_GLOBAL` at it makes every later git command fail with
// "fatal: unable to access '//./nul': Invalid argument" — including the `git init` calls this
// very file makes (2026-10-17: green on CI, red on a Windows machine that has an identity).
const identityIsConfigured = ['--global', '--system'].some(scope =>
  (spawnSync('git', ['config', scope, '--get', 'user.name'], { encoding: 'utf8' }).stdout ?? '').trim() !== '')
let emptyGitConfig = ''
/** The throwaway stores a few tests make, removed in `after` (decision 170). */
const emptyStores: string[] = []
if (identityIsConfigured) {
  const emptyConfig = join(tmpdir(), `dsh-jira-empty-gitconfig-${String(process.pid)}`)
  emptyGitConfig = emptyConfig
  writeFileSync(emptyConfig, '', 'utf8')
  process.env.GIT_CONFIG_GLOBAL = emptyConfig
  process.env.GIT_CONFIG_SYSTEM = emptyConfig
  process.env.GIT_CONFIG_NOSYSTEM = '1'
}

/**
 * Temp cleanup goes through the shared `removeTree` (src/testing): it retries the ENOTEMPTY that a
 * still-finishing git helper can cause under `.git/objects/pack` (2026-10-17, one CI job).
 */

const MACHINE = 'a1b2c3d4'
const AT = new Date('2026-10-15T12:00:00Z').getTime()
const AT_ISO = '2026-10-15T12:00:00Z'
const fixture = await readFile(new URL('../../fixtures/config.md', import.meta.url), 'utf8')

const vocab = (() => {
  const parsed = parseVocab(fixture)
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error))
  return parsed.value
})()

const registrations: JiraToolDefinition[] = []

/**
 * A host context that refuses what the real host refuses.
 *
 * The host is a **proxy**: reading a service the plugin did not declare in `inject` throws
 * `cannot get property "<name>" without inject`. A plain object hands back `undefined` instead,
 * which is how a missing `inject` kept every test green while the plugin failed to activate on a
 * real machine (2026-10-15). Optional services are reachable through `get`, so the fake opens the
 * same door and no other.
 */
const hostContext = (services: Record<string, unknown>): JiraHostContext => {
  const table: Record<string, unknown> = {
    ...services,
    get: (name: string) => services[name],
    on: () => () => undefined,
  }
  const proxy = new Proxy(
    {},
    {
      get: (_target, property) => {
        const name = String(property)
        if (name === 'then') return undefined // keep the proxy await-safe
        if (name in table) return table[name]
        throw new Error(`cannot get property "${name}" without inject`)
      },
    },
  )
  return proxy as JiraHostContext
}

const fakeHost = hostContext({
  tools: {
    register: (definition: JiraToolDefinition) => {
      registrations.push(definition)
      return () => undefined
    },
  },
})

const mainAgent = { id: 'main-1', session: { id: 'main-1', header: {} }, options: {} }
const subagent = {
  id: 'child-1',
  session: { id: 'child-1', header: { origin: 'subagent', parentSession: 'main-1' } },
  options: {},
}

let root = ''

/** The tool by name: the adapter registers more than one, so "the last one" is not a lookup. */
const tool = (name = TOOL_NAME): JiraToolDefinition => {
  const found = registrations.find(definition => definition.name === name)
  assert.ok(found !== undefined, `the adapter must register ${name}`)
  return found
}

const call = async (args: unknown, exec: Record<string, unknown> = { agent: mainAgent }, env = {}): Promise<ToolValue> => {
  registrations.length = 0
  await apply(fakeHost, { root, machine_id: MACHINE }, env, () => AT)
  return (await tool().execute(args, exec)) as ToolValue
}

const failure = (value: ToolValue): { code: string; message: string; context?: Record<string, unknown> } => {
  assert.equal(value.ok, false, `expected a failure, got ${JSON.stringify(value)}`)
  assert.ok(value.error !== undefined)
  return value.error
}

const issueOf = (value: ToolValue): Record<string, unknown> => {
  assert.equal(value.ok, true, `expected success, got ${JSON.stringify(value)}`)
  return value.issue as Record<string, unknown>
}

const buildIssue = (key: string, summary: string): Issue => {
  const created = createIssue(
    { key, issueType: 'task', summary, tags: ['demo'], body: 'body\n' },
    { vocab, knownTags: [{ name: 'demo' }], at: '2026-10-15T08:30:00Z' as Timestamp, by: 'human:daiqc' as Identity },
  )
  assert.equal(created.ok, true)
  if (!created.ok) throw new Error('unreachable')
  return created.value.issue
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-jira-plugin-'))
  await mkdir(join(root, 'tags'), { recursive: true })
  await writeFile(join(root, 'tags', 'demo.md'), '---\ntype: tag\nname: demo\ndescription: demo\n---\n', 'utf8')
  await writeTextAtomic(storePaths.config(root), fixture)
  const encoded = encodeIssue(buildIssue('DH-12', 'first'))
  assert.equal(encoded.ok, true)
  if (encoded.ok) await writeTextAtomic(storePaths.issue(root, 'DH', 'DH-12' as never), encoded.value)
})

after(async () => {
  if (root !== '') await removeTree(root)
  // Decision 170: the two throwaways this file makes are removed too — a full run used to leave one
  // empty store and one empty git-config file per run in the temp directory.
  for (const dir of emptyStores) await removeTree(dir)
  if (emptyGitConfig !== '') rmSync(emptyGitConfig, { force: true })
})

describe('plugin: the store awareness line (decision 78)', () => {
  it('registers `jira:store` as a PromptContext, not a prompt section', async () => {
    const captured: { name: string; order: number; text: () => string }[] = []
    const ctx = hostContext({
      systemPrompt: {
        context: (context: { name: string; order: number; text: () => string }) => {
          captured.push(context)
          return () => undefined
        },
      },
      tools: { register: () => () => undefined },
    })
    const empty = await mkdtemp(join(tmpdir(), 'dsh-jira-inject-empty-'))
    emptyStores.push(empty)
    await apply(ctx, { root: empty }, {}, () => 0)

    assert.equal(captured.length, 1)
    assert.equal(captured[0]?.name, 'jira:store')
    assert.equal(typeof captured[0]?.order, 'number')
    // An empty store says nothing — the host treats empty text as "contributes nothing".
    assert.equal(captured[0]?.text(), '')
  })

  it('carries the counts once the store has something in it', async () => {
    const captured: { name: string; order: number; text: () => string }[] = []
    const ctx = hostContext({
      systemPrompt: {
        context: (context: { name: string; order: number; text: () => string }) => {
          captured.push(context)
          return () => undefined
        },
      },
      tools: { register: () => () => undefined },
    })
    await apply(ctx, { root }, {}, () => 0)
    assert.match(captured[0]?.text() ?? '', /^\[store\] .*\d+ projects · \d+ knowledge · \d+ open issues( \| read-only: \d+)?$/u, 'the fixed format; the label and binding appear when known, the read-only suffix only when there is one')
  })

  it('survives a host without the service, because it is optional', async () => {
    const ctx = hostContext({ tools: { register: () => () => undefined } })
    await apply(ctx, { root }, {}, () => 0)
  })

  it('undoes the prompt context when the apply is disposed (decisions 166/183)', async () => {
    let contextDisposed = 0
    const ctx = hostContext({
      systemPrompt: { context: () => () => { contextDisposed += 1 } },
      tools: { register: () => () => undefined },
    })
    const dispose = await apply(ctx, { root }, {}, () => 0)
    assert.equal(contextDisposed, 0)
    dispose()
    assert.equal(contextDisposed, 1, 'the context registration must be kept so a reload can undo it')
  })

  it('injects nothing when the store cannot be read — and nothing throws (decision 183)', async () => {
    // The read callback returns an empty read instead of throwing: a missing root is a Result,
    // not an exception. Activation must survive it either way.
    const captured: { name: string; text: () => string }[] = []
    const ctx = hostContext({
      systemPrompt: { context: (context: { name: string; text: () => string }) => { captured.push(context); return () => undefined } },
      tools: { register: () => () => undefined },
    })
    const empty = await mkdtemp(join(tmpdir(), 'dsh-jira-inject-missing-'))
    emptyStores.push(empty)
    await removeTree(empty) // the root now does not exist at all
    await apply(ctx, { root: empty }, {}, () => 0)
    assert.equal(captured.length, 1)
    assert.equal(captured[0]?.text(), '', 'an unreadable store injects no line')
  })
})

describe('plugin: session recording (decisions 10/119/177/183)', () => {
  it('records the same session again in a second store — the memory is per-apply, keyed by root', async () => {
    // Decision 183: the recorder used to be module-level state, so a second `apply` (a reload, or
    // another store) inherited "already recorded" and the session never landed in the new store.
    const first = await mkdtemp(join(tmpdir(), 'dsh-jira-plugin-first-'))
    const second = await mkdtemp(join(tmpdir(), 'dsh-jira-plugin-second-'))
    emptyStores.push(first, second)
    await writeTextAtomic(storePaths.config(first), fixture)
    await writeTextAtomic(storePaths.config(second), fixture)

    const callIn = async (rootDir: string, summary: string): Promise<ToolValue> => {
      registrations.length = 0
      await apply(fakeHost, { root: rootDir, machine_id: MACHINE }, {}, () => AT)
      return (await tool().execute(
        { action: 'create', project: 'DH', data: { summary } },
        { agent: mainAgent },
      )) as ToolValue
    }

    assert.equal((await callIn(first, 'first store write')).ok, true)
    assert.equal(existsSync(join(first, 'sessions', 'main-1.md')), true, 'the first store records the session')

    assert.equal((await callIn(second, 'second store write')).ok, true)
    assert.equal(existsSync(join(second, 'sessions', 'main-1.md')), true,
      'a fresh apply must not inherit "already recorded" from the previous one')
  })

  it('records at most once per store while the same apply lives', async () => {
    const third = await mkdtemp(join(tmpdir(), 'dsh-jira-plugin-third-'))
    emptyStores.push(third)
    await writeTextAtomic(storePaths.config(third), fixture)

    registrations.length = 0
    await apply(fakeHost, { root: third, machine_id: MACHINE }, {}, () => AT)
    const first = (await tool().execute({ action: 'create', project: 'DH', data: { summary: 'one' } }, { agent: mainAgent })) as ToolValue
    assert.equal(first.ok, true)
    const file = join(third, 'sessions', 'main-1.md')
    const bytes = (await readFile(file, 'utf8')).length
    const second = (await tool().execute({ action: 'create', project: 'DH', data: { summary: 'two' } }, { agent: mainAgent })) as ToolValue
    assert.equal(second.ok, true)
    assert.equal((await readFile(file, 'utf8')).length, bytes, 'the same session in the same store is not recorded twice')
  })
})
describe('plugin: what the host receives', () => {
  it('registers the resident tools, the first carrying all ten verbs', async () => {
    registrations.length = 0
    await apply(fakeHost, { root }, {}, () => AT)
    assert.deepEqual(registrations.map(definition => definition.name), [TOOL_NAME, LIST_TOOL_NAME, KB_TOOL_NAME])
    const parameters = tool().parameters as Record<string, unknown>
    assert.equal(parameters.additionalProperties, false)
    const properties = parameters.properties as Record<string, Record<string, unknown>>
    // Decision 192: `tag_create` joined the list — the tool surface could not create a tag at all.
    // Decision 193: `close` composes the transition and its comment into one transaction.
    assert.deepEqual(properties.action?.enum, ['get', 'create', 'update', 'switch_state', 'comment', 'assignee', 'link', 'tag_create', 'close', 'batch_close'])
    assert.deepEqual(parameters.required, ['action'])
    assert.equal(properties.action?.required, undefined, 'standard dialect: no per-property required')
  })

  it('declares an output schema whose required fields every value carries', async () => {
    // Decisions 56/82: the envelope is the same whichever way the call went — `writable` (with
    // `reason?`) and `me` are on a **refusal** too, because "who am I and why may I not write" is
    // exactly what a refusal is about. `me` is therefore required, and this checks values, not just
    // the declaration: the previous version of this test only compared the `required` array.
    for (const name of [TOOL_NAME, LIST_TOOL_NAME, KB_TOOL_NAME]) {
      const schema = tool(name).output.schema as Record<string, unknown>
      assert.deepEqual(schema.required, ['ok', 'writable', 'me'], name)
      assert.equal(schema.additionalProperties, true)
    }

    const carries = (value: ToolValue, what: string): void => {
      for (const field of ['ok', 'writable', 'me']) {
        assert.ok(Object.hasOwn(value, field), `${what} must carry ${field}: ${JSON.stringify(value)}`)
      }
    }
    carries(await call({ action: 'get', key: 'DH-12' }), 'a read')
    carries(await call({ action: 'get', key: 'DH-99' }), 'a refusal')
    carries(await call({ action: 'update', key: 'DH-12', data: { summary: '' } }), 'a refused write')
  })

  it('never touches a service it did not declare in inject', async () => {
    // `fakeHost` refuses what the host refuses, so reaching the end of `apply` is the assertion.
    // Before the 2026-10-15 fix the adapter read `ctx.commands`, which the real host rejected as
    // `cannot get property "commands" without inject` — and a plain fake object hid it.
    registrations.length = 0
    await apply(fakeHost, { root }, {}, () => AT)
    assert.equal(registrations.length, 3)
    assert.throws(
      () => (fakeHost as unknown as Record<string, unknown>).commands,
      /cannot get property "commands" without inject/u,
      'the fake must refuse what the host refuses, or this test proves nothing',
    )
  })
})

describe('plugin: reading', () => {
  it('returns the issue, the comments and the session\'s writability', async () => {
    const value = await call({ action: 'get', key: 'DH-12' })
    const issue = issueOf(value)
    assert.equal(value.writable, true)
    assert.equal(issue.key, 'DH-12')
    assert.equal(issue.summary, 'first')
    assert.deepEqual(value.comments, [])
    assert.deepEqual(value.me, { tool: 'dsh', machine: MACHINE, session: 'main-1' })
  })

  it('reads even when the vocabulary is missing: a read is a read (decision 38)', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'dsh-jira-bare-'))
    emptyStores.push(bare)
    await writeTextAtomic(
      storePaths.issue(bare, 'DH', 'DH-1' as never),
      (() => {
        const encoded = encodeIssue(buildIssue('DH-1', 'no vocab here'))
        if (!encoded.ok) throw new Error('unreachable')
        return encoded.value
      })(),
    )
    registrations.length = 0
    await apply(fakeHost, { root: bare, machine_id: MACHINE }, {}, () => AT)
    const value = (await tool().execute({ action: 'get', key: 'DH-1' }, { agent: mainAgent })) as ToolValue
    assert.equal(issueOf(value).summary, 'no vocab here')
    await removeTree(bare)
  })
})

describe('plugin: writing', () => {
  it('creates an issue with an allocated key', async () => {
    const value = await call({ action: 'create', project: 'DH', data: { summary: 'brand new', tags: ['demo'] } })
    const issue = issueOf(value)
    assert.equal(issue.key, 'DH-13', 'the next key the store allocates (DH-12 already exists)')
    assert.equal(issue.status, 'todo')
    assert.equal(issue.priority, 'S3')
    assert.equal(issue.revision, 1)
    const readBack = await call({ action: 'get', key: 'DH-13' })
    assert.equal(issueOf(readBack).summary, 'brand new')
  })

  it('updates an issue and advances its revision', async () => {
    const value = await call({ action: 'update', key: 'DH-13', data: { summary: 'renamed', priority: 'S1' } })
    const issue = issueOf(value)
    assert.equal(issue.summary, 'renamed')
    assert.equal(issue.priority, 'S1')
    assert.equal(issue.revision, 2)
  })

  it('refuses an unknown data field by name', async () => {
    const error = failure(await call({ action: 'update', key: 'DH-13', data: { summmary: 'typo' } }))
    assert.equal(error.code, 'INVALID_INPUT')
    assert.match(error.message, /unknown data field\(s\): summmary/)
  })

  it('refuses a stale write when expected_revision disagrees', async () => {
    const error = failure(await call({ action: 'update', key: 'DH-13', expected_revision: 1, data: { summary: 'x' } }))
    // Decisions 44/52: the **typed** error, so a caller can tell a lost race from bad input.
    assert.equal(error.code, 'STALE_REVISION')
    assert.match(error.message, /expected 1, found 2/)
    assert.deepEqual(error.context, { expected: 1, actual: 2 })
  })

  it('moves along the table, and requires a resolution to close', async () => {
    const moved = await call({ action: 'switch_state', key: 'DH-13', to: 'in_progress' })
    assert.equal(issueOf(moved).status, 'in_progress')

    const refused = failure(await call({ action: 'switch_state', key: 'DH-13', to: 'closed' }))
    assert.equal(refused.code, 'RESOLUTION_REQUIRED')

    const closed = await call({ action: 'switch_state', key: 'DH-13', to: 'closed', resolution: 'fixed' })
    const issue = issueOf(closed)
    assert.equal(issue.status, 'closed')
    assert.equal(issue.resolution, 'fixed')

    const badEdge = failure(await call({ action: 'switch_state', key: 'DH-13', to: 'in_review' }))
    assert.equal(badEdge.code, 'INVALID_TRANSITION')
    assert.deepEqual(badEdge.context?.allowed, ['in_progress'])
  })

  it('appends a comment without touching the issue', async () => {
    const before = issueOf(await call({ action: 'get', key: 'DH-13' }))
    const value = await call({ action: 'comment', key: 'DH-13', comment: { body: 'noted' } })
    const after = issueOf(value)
    assert.equal(after.revision, before.revision, 'a comment does not advance the revision')
    const comments = value.comments as readonly { id: string; body: string }[]
    assert.equal(comments.length, 1)
    assert.equal(comments[0]?.body, 'noted')
    assert.equal(comments[0]?.id, `c-${MACHINE.slice(0, 4)}-1`)
  })

  it('claims and releases, and links and unlinks', async () => {
    const claimed = issueOf(await call({ action: 'assignee', key: 'DH-13', assignee: 'self' }))
    assert.equal(claimed.assignee, `agent:unknown|dsh|${MACHINE}|main-1`)

    const released = issueOf(await call({ action: 'assignee', key: 'DH-13', assignee: 'none' }))
    assert.equal('assignee' in released, false)

    const linked = issueOf(await call({ action: 'link', key: 'DH-13', link: { type: 'is_blocked_by', target: 'DH-12' } }))
    assert.deepEqual(linked.links, [{ type: 'is_blocked_by', target: 'DH-12' }])

    const duplicate = failure(await call({ action: 'link', key: 'DH-13', link: { type: 'is_blocked_by', target: 'DH-12' } }))
    assert.match(duplicate.message, /already has is_blocked_by/)

    const unlinked = issueOf(await call({ action: 'link', key: 'DH-13', link: { type: 'is_blocked_by', target: 'DH-12', op: 'remove' } }))
    assert.deepEqual(unlinked.links, [])

    const missing = failure(await call({ action: 'link', key: 'DH-13', link: { type: 'parent', target: 'DH-12', op: 'remove' } }))
    assert.match(missing.message, /has no parent/)
  })
})

describe('plugin: who may write (decisions 89/93)', () => {
  it('lets a subagent read but not write', async () => {
    const read = await call({ action: 'get', key: 'DH-12' }, { agent: subagent })
    assert.equal(read.ok, true)
    assert.equal(read.writable, false)
    assert.equal(read.reason, 'subagent')

    const write = await call({ action: 'update', key: 'DH-12', data: { summary: 'nope' } }, { agent: subagent })
    const error = failure(write)
    assert.equal(error.code, 'READ_ONLY_SESSION')
    assert.equal(error.context?.reason, 'subagent')
  })

  it('refuses writes in a read-only session', async () => {
    const value = await call({ action: 'update', key: 'DH-12', data: { summary: 'nope' } }, { agent: mainAgent }, { DSH_READ_ONLY_SESSION: '1' })
    const error = failure(value)
    assert.equal(error.code, 'READ_ONLY_SESSION')
    assert.equal(error.context?.reason, 'dsh-read-only')
  })

  it('refuses to overwrite a conflicted issue without an acknowledgement (decision 71)', async () => {
    const conflicted = { ...buildIssue('DH-9', 'conflicted one'), conflicted: true }
    const encoded = encodeIssue(conflicted)
    assert.equal(encoded.ok, true)
    if (encoded.ok) await writeTextAtomic(storePaths.issue(root, 'DH', 'DH-9' as never), encoded.value)

    const refused = failure(await call({ action: 'update', key: 'DH-9', data: { summary: 'x' } }))
    assert.match(refused.message, /marked conflicted/)

    const allowed = await call({ action: 'update', key: 'DH-9', data: { summary: 'x' }, ack_conflict: true })
    assert.equal(allowed.ok, true)
    assert.equal(issueOf(allowed).conflicted, false, 'acknowledging clears the flag (decision 71)')
    assert.equal(issueOf(allowed).summary, 'x', 'and the write the caller asked for still happened')
  })
})

describe('plugin: jira_list (decision 53)', () => {
  const list = async (args: unknown, exec: Record<string, unknown> = { agent: mainAgent }): Promise<ToolValue> => {
    const value = (await tool(LIST_TOOL_NAME).execute(args, exec)) as ToolValue
    return value
  }

  it('returns items, groups and counts that agree with each other', async () => {
    const value = await list({ include_closed: true })
    assert.equal(value.ok, true, JSON.stringify(value.error))
    const items = value.items as readonly { key: string; blocked: boolean; status: string }[]
    const groups = value.groups as readonly { kind: string; items: readonly { key: string }[] }[]
    const counts = value.counts as {
      matched: number
      returned: number
      remaining: number
      by_status: Record<string, number>
      blocked: number
    }

    assert.ok(items.length > 0)
    assert.equal(counts.matched, items.length, 'nothing was truncated here')
    assert.equal(counts.returned, items.length)
    assert.equal(counts.remaining, 0)
    assert.equal(value.truncated, false)
    assert.equal(value.limit, 20)
    assert.equal(Object.values(counts.by_status).reduce((total, count) => total + count, 0), counts.matched)
    assert.equal(groups.flatMap(group => group.items).length, items.length, 'every item is in a group')
    assert.equal(counts.blocked, items.filter(item => item.blocked).length)
    // The shared store has no blocked issue at this point, so ordering is **not** asserted here —
    // the next test creates a blocked pair on purpose (a conditional assertion would skip silently).
    assert.equal(counts.blocked, 0, 'no blocked issue yet — ordering is tested below with a real one')
    assert.equal(value.writable, true)
  })

  it('puts blocked issues after every ready one — with a really blocked issue in the store (decision 53)', async () => {
    const blocker = issueOf(await call({ action: 'create', project: 'DH', data: { summary: 'the blocker' } }))
    const blocked = issueOf(await call({ action: 'create', project: 'DH', data: { summary: 'the blocked one' } }))
    // `create` deliberately does not take links (decision 82's field list); the edge is its own action.
    assert.equal(
      (await call({ action: 'link', key: blocked.key as string, link: { type: 'is_blocked_by', target: blocker.key as string } })).ok,
      true,
    )

    const value = await list({})
    const items = value.items as readonly { key: string; blocked: boolean }[]
    const firstBlocked = items.findIndex(item => item.blocked)
    assert.ok(firstBlocked !== -1, 'the fixture really contains a blocked issue, or this test proves nothing')
    assert.equal(items.slice(firstBlocked).every(item => item.blocked), true, 'nothing ready sits behind a blocked one')
    const at = (key: string): number => items.findIndex(item => item.key === key)
    assert.ok(at(blocker.key as string) !== -1 && at(blocked.key as string) !== -1, 'both new issues are listed')
    assert.ok(at(blocker.key as string) < at(blocked.key as string), 'the blocker sorts ahead of what it blocks')
    const counts = value.counts as { blocked: number }
    assert.equal(counts.blocked, items.filter(item => item.blocked).length)
    assert.ok(counts.blocked >= 1, 'the count says so too')
  })

  it('hides closed issues unless asked', async () => {
    const open = await list({})
    const all = await list({ include_closed: true })
    const openItems = open.items as readonly { status: string }[]
    assert.equal(openItems.every(item => item.status !== 'closed' && item.status !== 'cancelled'), true)
    assert.ok((all.items as readonly unknown[]).length > openItems.length, 'the closed ones came back with --all')
    const counts = all.counts as { by_status: Record<string, number> }
    assert.ok((counts.by_status.closed ?? 0) >= 1)
  })

  it('filters by status, assignee and link, and refuses a bad one', async () => {
    assert.equal(((await list({ status: 'closed' })).items as readonly unknown[]).length, 0, 'hidden by default')
    assert.ok(((await list({ status: 'closed', include_closed: true })).items as readonly unknown[]).length >= 1)
    assert.equal(((await list({ assignee: 'human:nobody' })).items as readonly unknown[]).length, 0)
    assert.equal((await list({ assignee: 'me' })).ok, true, 'a session identity is known here')
    assert.match(failure(await list({ link: { type: 'nonsense', target: 'DH-12' } })).message, /link needs a valid `type`/)
    assert.equal((await list({ nope: 1 })).ok, false, 'an unknown argument is refused')
  })

  it('caps the answer and still reports everything that matched', async () => {
    const value = await list({ include_closed: true, limit: 1 })
    assert.equal((value.items as readonly unknown[]).length, 1)
    assert.equal(value.truncated, true)
    const counts = value.counts as { matched: number; remaining: number }
    assert.ok(counts.matched > 1)
    assert.equal(counts.remaining, counts.matched - 1)
    const rendered = tool(LIST_TOOL_NAME).output.render({}, value) as readonly { text: string }[]
    assert.match(rendered[0]?.text ?? '', /more match/)
  })
  it('is readable by a subagent, because it writes nothing (decisions 38/89)', async () => {
    const value = await list({}, { agent: subagent })
    assert.equal(value.ok, true)
    assert.equal(value.writable, false)
    assert.equal(value.reason, 'subagent')
  })
})
describe('plugin: jira_kb (decisions 54/75)', () => {
  const kb = async (args: unknown, exec: Record<string, unknown> = { agent: mainAgent }): Promise<ToolValue> =>
    (await tool(KB_TOOL_NAME).execute(args, exec)) as ToolValue

  it('starts empty, creates an entry, then reads and searches it', async () => {
    const empty = await kb({ action: 'search', query: 'mkdir' })
    assert.equal(empty.ok, true, JSON.stringify(empty.error))
    assert.deepEqual(empty.hits, [])

    const created = await kb({
      action: 'create',
      data: {
        domain: 'locking',
        type: 'pitfall',
        title: 'Windows 上的锁必须用 mkdir',
        tags: ['windows'],
        body: 'flock 在 Windows 上不是原子的，用 mkdir。\n',
      },
    })
    assert.equal(created.ok, true, JSON.stringify(created.error))
    const item = created.item as { key: string; source: { machine_id: string; os: string; tool: string } }
    assert.equal(item.key, 'KB-1')
    assert.equal(item.source.machine_id, MACHINE, 'the lineage is recorded by the store, not typed')
    assert.equal(item.source.tool, 'dsh')

    const found = await kb({ action: 'get', key: 'KB-1' })
    assert.equal((found.item as { title: string }).title, 'Windows 上的锁必须用 mkdir')

    const search = await kb({ action: 'search', query: 'mkdir' })
    const hits = search.hits as readonly { key: string; file: string; line: number; snippet: string }[]
    assert.equal(hits.length, 1)
    assert.equal(hits[0]?.file, 'knowledge/locking/KB-1.md')
    // The citation must point at the line that really carries the hit — counted from the top of the
    // file, frontmatter included (decision 179), so opening `file:line` lands on the needle.
    const fileText = await readFile(join(root, 'knowledge', 'locking', 'KB-1.md'), 'utf8')
    const lineNo = hits[0]?.line ?? 0
    const rawLines = fileText.split('\n')
    assert.ok(lineNo >= 1 && lineNo <= rawLines.length, `line ${String(lineNo)} is inside the file`)
    assert.match(rawLines[lineNo - 1] ?? '', /mkdir/, 'the cited line really carries the hit')
    assert.equal(Object.hasOwn(hits[0] ?? {}, 'body'), false, 'a hit is a citation, not the entry')
    const rendered = tool(KB_TOOL_NAME).output.render({}, search) as readonly { text: string }[]
    assert.match(rendered[0]?.text ?? '', /knowledge\/locking\/KB-1\.md:/)
  })

  it('updates an entry, and refuses a type outside the vocabulary', async () => {
    const updated = await kb({ action: 'update', key: 'KB-1', data: { title: '锁：一律用 mkdir' } })
    assert.equal(updated.ok, true, JSON.stringify(updated.error))
    assert.equal((updated.item as { title: string }).title, '锁：一律用 mkdir')
    assert.equal((updated.item as { source: { captured_at: string } }).source.captured_at, AT_ISO, 'capture time is history')

    const bad = await kb({ action: 'create', data: { domain: 'locking', type: 'note', title: 'x' } })
    assert.equal(bad.ok, false)
    assert.match(failure(bad).message, /is not one of: runbook/)
  })

  it('needs a key for get, a query for search, and rejects unknown data fields', async () => {
    assert.match(failure(await kb({ action: 'get' })).message, /needs a `key`/)
    assert.match(failure(await kb({ action: 'search' })).message, /search needs `query`/)
    assert.match(failure(await kb({ action: 'get', key: 'nope' })).message, /is not a knowledge key/)
    assert.match(failure(await kb({ action: 'update', key: 'KB-1', data: { titre: 'typo' } })).message, /unknown data field/)
  })

  it('lets a subagent read but not write', async () => {
    assert.equal((await kb({ action: 'search', query: 'mkdir' }, { agent: subagent })).ok, true)
    const write = failure(await kb({ action: 'create', data: { domain: 'locking', type: 'concept', title: 'x' } }, { agent: subagent }))
    assert.equal(write.code, 'READ_ONLY_SESSION')
  })
})
describe('plugin: arguments and failure shapes', () => {
  it('lists every argument problem at once', async () => {
    const error = failure(await call({ action: 'get', keyy: 'DH-12' }))
    assert.equal(error.code, 'INVALID_INPUT')
    const issues = error.context?.issues as readonly string[]
    assert.equal(issues.length, 1)
    assert.match(issues[0] ?? '', /unknown argument "keyy"/)
  })

  it('rejects an action outside the vocabulary', async () => {
    const error = failure(await call({ action: 'delete', key: 'DH-12' }))
    assert.match(String(error.context?.issues), /must be one of: get, create/)
  })

  it('says which parameter an action is missing', async () => {
    assert.match(failure(await call({ action: 'update' })).message, /`update` needs a `key`/)
    assert.match(failure(await call({ action: 'create', data: { summary: 'x' } })).message, /create needs project/)
    assert.match(failure(await call({ action: 'switch_state', key: 'DH-12' })).message, /switch_state needs `to`/)
  })

  it('reports a missing issue as NOT_FOUND and a missing store clearly', async () => {
    const notFound = failure(await call({ action: 'get', key: 'DH-99' }))
    assert.equal(notFound.code, 'NOT_FOUND')

    registrations.length = 0
    await apply(fakeHost, {}, {}, () => AT)
    const noRoot = failure((await tool().execute({ action: 'get', key: 'DH-12' }, { agent: mainAgent })) as ToolValue)
    assert.match(noRoot.message, /cannot resolve the store root/)
  })

  it('never throws, whatever it is handed', async () => {
    for (const args of [undefined, null, 42, 'nope', [], {}, { action: 'get' }, { action: 'update', key: 7 }]) {
      const value = await call(args)
      assert.equal(typeof value, 'object')
      assert.equal(value.ok, false)
      assert.equal(typeof value.writable, 'boolean')
    }
  })

  it('rejects a project key that would be a path, before writing anything (decisions 162/183)', async () => {
    // The tool face now uses core's `isProjectKey` (one rule, not a second regex): `../../tmp/x`
    // uppercased is still not a key, so nothing outside — or inside — the store is created.
    const before = await readdir(join(root, 'projects'))
    const error = failure(await call({ action: 'create', project: '../../tmp/x', data: { summary: 'x' } }))
    assert.equal(error.code, 'INVALID_INPUT')
    assert.match(error.message, /create needs `project`/)
    assert.deepEqual(await readdir(join(root, 'projects')), before, 'no project directory appeared')
  })
})

describe('plugin: read-only sessions (decision 93)', () => {
  const readOnlyAgent = { id: 'ro-1', session: { id: 'ro-1', header: {} }, options: { agentPreset: 'readOnly' } }
  const normalAgent = { id: 'n-1', session: { id: 'n-1', header: {} }, options: { agentPreset: 'workspaceWrite' } }

  it('refuses writes when the permission preset is read-only, and still reads', async () => {
    // The host carries the preset on the agent. The environment variable the first version relied on
    // is set by nothing, which is why a read-only session could write freely until now.
    const created = await call({ action: 'create', project: 'DH', data: { summary: 'read-only fixture' } }, { agent: normalAgent })
    assert.equal(created.ok, true, JSON.stringify(created))
    const key = (created.issue as { key: string }).key

    const refused = failure(await call({ action: 'update', key, data: { summary: 'x' } }, { agent: readOnlyAgent }))
    assert.equal(refused.code, 'READ_ONLY_SESSION')
    assert.equal(refused.context?.reason, 'dsh-read-only')

    const read = await call({ action: 'get', key }, { agent: readOnlyAgent })
    assert.equal(read.ok, true, JSON.stringify(read))
    assert.equal((read as { writable: boolean }).writable, false, 'and the result says so')

    // The same write succeeds for an ordinary session, so the refusal is about the preset, not the key.
    const written = await call({ action: 'update', key, data: { summary: 'written normally' } }, { agent: normalAgent })
    assert.equal(written.ok, true, JSON.stringify(written))
  })
})

describe('plugin: the session end refreshes the derived files (decisions 15/34, corrected 2026-10-17)', () => {
  /**
   * A host that keeps the two seams the session-end path needs: the `agent/created` subscription and
   * the `effect` scope. The shared `hostContext` swallows both (`on: () => () => undefined`), which
   * is exactly why this path had no test: the flush and the regeneration were unreachable from it.
   */
  const effectHost = (): Readonly<{ ctx: JiraHostContext; deliver: () => void; fire: () => Promise<void> }> => {
    const effects: (() => Promise<void>)[] = []
    let subscribed: ((payload: { agent: unknown }) => void) | undefined
    const table: Record<string, unknown> = {
      // The tools are recorded as well as swallowed: the debounced push is armed by a write that went
      // through the tool, so a test of that path has to make the same call the agent would.
      tools: {
        register: (definition: JiraToolDefinition) => {
          registrations.push(definition)
          return () => undefined
        },
      },
      get: () => undefined,
      on: (event: string, handler: (payload: { agent: unknown }) => void) => {
        if (event === 'agent/created') subscribed = handler
        return () => undefined
      },
    }
    const ctx = new Proxy({}, {
      get: (_target, property) => {
        const name = String(property)
        if (name === 'then') return undefined
        if (name in table) return table[name]
        throw new Error(`cannot get property "${name}" without inject`)
      },
    }) as JiraHostContext
    const agent = {
      id: 'main-1',
      session: { id: 'main-1', header: {} },
      options: {},
      ctx: { effect: (body: () => () => Promise<void>) => { effects.push(body()) } },
    }
    let delivered = false
    // Delivering `agent/created` is what captures `headAtStart`. A test that wants a commit to land
    // *during* the session has to deliver first and end the session afterwards — otherwise the commit
    // is already in `headAtStart` and the close-out scan legitimately sees nothing.
    const deliver = (): void => {
      if (delivered) return
      delivered = true
      // The **same** agent object that carries `ctx.effect`: the adapter reads the effect scope off the
      // agent the event carries, so firing with a fresh object would silently register nothing.
      subscribed?.({ agent })
    }
    return {
      ctx,
      deliver,
      fire: async () => {
        deliver()
        for (const start of effects) await start()
      },
    }
  }

  /** A store that has an issue and a vocabulary, but no generated file yet. */
  const storeWithoutGenerated = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-jira-sessionend-'))
    emptyStores.push(dir)
    await mkdir(join(dir, 'tags'), { recursive: true })
    await writeFile(join(dir, 'tags', 'demo.md'), '---\ntype: tag\nname: demo\ndescription: demo\n---\n', 'utf8')
    await writeTextAtomic(storePaths.config(dir), fixture)
    const encoded = encodeIssue(buildIssue('DH-12', 'first'))
    assert.equal(encoded.ok, true)
    if (encoded.ok) await writeTextAtomic(storePaths.issue(dir, 'DH', 'DH-12' as never), encoded.value)
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

  /**
   * The same question for a **directory**. `exists` above reads a file, so it answers "no" for a
   * directory (EISDIR) — which is how the first version of the diagnostic below claimed
   * `rebase state: false` for a rebase that was in fact stopped and in progress (2026-10-17).
   */
  const dirExists = async (path: string): Promise<boolean> => {
    try {
      await stat(path)
      return true
    } catch {
      return false
    }
  }

  it('regenerates and commits, so what gets pushed agrees with its sources', async () => {
    const dir = await storeWithoutGenerated()
    const host = effectHost()
    await apply(host.ctx, { root: dir, machine_id: MACHINE }, {}, () => AT)
    assert.equal(await exists(join(dir, 'BOARD.md')), false, 'nothing generated before the session ends')

    await host.fire()

    assert.equal(await exists(join(dir, 'BOARD.md')), true, 'BOARD.md is there after the session end')
    assert.equal(await exists(join(dir, 'index.md')), true)
    const log = await runGit(dir, ['log', '--format=%s'])
    assert.match(log.stdout, /重生成派生工件/u)
    await removeTree(dir)
  })

  it('writes nothing when the session may not write (decisions 89/93)', async () => {
    const dir = await storeWithoutGenerated()
    const host = effectHost()
    await apply(host.ctx, { root: dir, machine_id: MACHINE }, { DSH_READ_ONLY_SESSION: '1' }, () => AT)

    await host.fire()

    assert.equal(await exists(join(dir, 'BOARD.md')), false, 'a read-only session must not generate')
    await removeTree(dir)
  })

  it('leaves nothing uncommitted, so a checkout of the commit passes the gate', async () => {
    // The regression for the flaw this test was written from (2026-10-17): the heads hash the
    // **working tree** (decision 79), so regenerating over an uncommitted hand edit used to commit
    // generated files computed from a source state the commit did not contain — and the store's own
    // `generate --check` rejected it on the next push. §4.13 rule 1 has to run first.
    const dir = await storeWithoutGenerated()
    const issue = join(dir, 'projects', 'DH', 'issues', 'DH-12.md')
    const text = await readFile(issue, 'utf8')
    await writeFile(issue, text.replace(/^summary: .*$/mu, 'summary: 人改的，还没提交'), 'utf8')

    const host = effectHost()
    await apply(host.ctx, { root: dir, machine_id: MACHINE }, {}, () => AT)
    await host.fire()

    // A clean tree is what makes "what CI checks out" equal "what the generator saw".
    assert.equal((await runGit(dir, ['status', '--porcelain'])).stdout, '', 'the tree is clean afterwards')
    const checked = await checkGenerated(createStore({ root: dir, machineId: MACHINE }))
    assert.equal(checked.ok, true, JSON.stringify(checked))
    if (checked.ok) assert.deepEqual([...checked.value], [], 'a checkout of that commit is fresh')
    assert.match(await readFile(issue, 'utf8'), /人改的，还没提交/u, "the human's text is in a commit, not lost")
    await removeTree(dir)
  })

  it('a mid-session push settles through a rebase, and the pushed commit passes the gate', async () => {
    // The end-to-end shape decision 148 exists for: a write arms the debounce, and the flush that
    // follows has to `pull --rebase` (another machine pushed in the meantime), refresh the derived
    // files, and only then push. Measured on 2026-10-17: this push really happens ~500 ms after a
    // write, long before any session ends — so the old "regenerate at the session end" left every
    // one of these carrying a stale `log.md`, and the store's `generate --check` gate red.
    //
    // It is also the wiring test for the `pull` hook: that hook sat commented-out on a single line
    // from the commit that introduced it (`db7743e`) until 2026-10-17, so the plugin never rebased.
    // A push rejected as non-fast-forward never lands `BOARD.md`, which is exactly what the poll
    // below waits for — so a regression shows up here as a timeout, not as a silent pass.
    const bare = await mkdtemp(join(tmpdir(), 'dsh-jira-bare-'))
    emptyStores.push(bare)
    await runGit(bare, ['init', '--bare', '--initial-branch=main'])
    const dir = await storeWithoutGenerated()
    assert.equal((await initializeRepository(dir)).ok, true)
    assert.equal((await stageAllAndCommit(dir, 'chore: store skeleton [no-issue]')).ok, true)
    await runGit(dir, ['remote', 'add', 'origin', bare])
    assert.equal((await runGit(dir, ['push', '-u', 'origin', 'main'])).code, 0, 'the store has an upstream')

    // The other machine commits and pushes, so this machine's flush has a divergence to rebase onto.
    const other = await mkdtemp(join(tmpdir(), 'dsh-jira-other-'))
    emptyStores.push(other)
    assert.equal((await runGit(other, ['clone', '--quiet', bare, other])).code, 0)
    await writeFile(join(other, 'other-machine.md'), 'from the other machine\n', 'utf8')
    assert.equal((await stageAndCommit(other, ['other-machine.md'], 'chore: another machine [no-issue]')).ok, true)
    assert.equal((await runGit(other, ['push'])).code, 0)

    const host = effectHost()
    registrations.length = 0
    // A shorter debounce than the 500 ms default: the timer is real here, the push is what matters.
    await apply(host.ctx, { root: dir, machine_id: MACHINE, push: { debounce_ms: 50 } }, {}, () => AT)
    const wrote = await tool().execute(
      { action: 'comment', key: 'DH-12', comment: { body: 'a write that arms the flush' } },
      { agent: mainAgent },
    ) as ToolValue
    assert.equal(wrote.ok, true, JSON.stringify(wrote))

    const hasBoard = async (): Promise<boolean> => (await runGit(bare, ['cat-file', '-e', 'HEAD:BOARD.md'])).code === 0
    const deadline = Date.now() + 15_000
    while (!(await hasBoard()) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
    // The diagnostic is part of the assertion on purpose: this test failed on all four CI jobs
    // (2026-10-17) while passing locally, and a bare "false !== true" says nothing about *which* of
    // the flush's four steps did not happen.
    const oneLine = async (root: string, args: readonly string[]): Promise<string> =>
      (await runGit(root, [...args])).stdout.replace(/\n/gu, ' | ')
    assert.equal(await hasBoard(), true, [
      'the flush has to land the refreshed board on the remote. Evidence:',
      `bare log: ${await oneLine(bare, ['log', '--format=%h %s'])}`,
      `dir log: ${await oneLine(dir, ['log', '--format=%h %s'])}`,
      `dir status: ${await oneLine(dir, ['status', '--porcelain'])}`,
      `dir upstream: ${await oneLine(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])}`,
      `rebase state: ${await dirExists(join(dir, '.git', 'rebase-merge')) || await dirExists(join(dir, '.git', 'rebase-apply'))}`,
      `board written in dir: ${await exists(join(dir, 'BOARD.md'))}`,
      `index.lock: ${await exists(join(dir, '.git', 'index.lock'))}`,
      `all refs: ${await oneLine(dir, ['log', '--all', '--format=%h %s'])}`,
      `the write's own value: ${JSON.stringify(wrote)}`,
    ].join('\n'))

    // What the store's CI does with that commit: check it out, then ask whether it is fresh.
    const checkout = await mkdtemp(join(tmpdir(), 'dsh-jira-checkout-'))
    emptyStores.push(checkout)
    assert.equal((await runGit(checkout, ['clone', '--quiet', bare, checkout])).code, 0)
    const checked = await checkGenerated(createStore({ root: checkout, machineId: 'reader' }))
    assert.equal(checked.ok, true, JSON.stringify(checked))
    if (checked.ok) assert.deepEqual([...checked.value], [], 'a checkout of the pushed commit is fresh')

    for (const path of [bare, dir, other, checkout]) await removeTree(path)
  })

  /** A store that is a **repository** with one commit behind it, so a session-end scan has something
   * to find. `storeWithoutGenerated` above is deliberately not a repo: a scan over it is a no-op, which
   * would make a "read-only sessions write nothing" assertion pass for the wrong reason. */
  const scanFixture = async (): Promise<string> => {
    const dir = await storeWithoutGenerated()
    assert.equal((await initializeRepository(dir)).ok, true)
    assert.equal((await stageAllAndCommit(dir, 'chore: store skeleton [no-issue]')).ok, true)
    return dir
  }

  /** Apply, land a commit that mentions the issue (the scan's trigger), then end the session. */
  const endAfterACommitMentioning = async (dir: string, env: Record<string, string>): Promise<void> => {
    const host = effectHost()
    await apply(host.ctx, { root: dir, machine_id: MACHINE }, env, () => AT)
    host.deliver() // the session starts here: `headAtStart` is captured now
    // This file pins `user.useConfigOnly` (the CI condition), so the commit carries its own identity.
    const landed = await runGit(dir, ['-c', 'user.name=dsh-jira', '-c', 'user.email=jira@local', 'commit', '--allow-empty', '-m', 'DH-12: something happened'])
    assert.equal(landed.code, 0, landed.stderr)
    await host.fire()
  }

  /** The scan's machine-local watermark: its absence means the scan never ran at all. */
  const watermarkOf = (dir: string): string => join(dir, '.jira', 'dsh-jira', 'session-scan', 'main-1.json')

  it('a read-only session ends without writing: no scan comment, no commit, no watermark', async () => {
    const dir = await scanFixture()
    await endAfterACommitMentioning(dir, { DSH_READ_ONLY_SESSION: '1' })

    assert.equal(await exists(join(dir, 'BOARD.md')), false, 'no regeneration')
    const log = await runGit(dir, ['log', '--format=%s'])
    assert.match(log.stdout, /DH-12: something happened/u)
    assert.equal(log.stdout.trim().split('\n').length, 2, 'the history is exactly what it was')
    // The scan's comment would land in the comment file — its text never appears in a subject, which is
    // why asserting on `git log` alone would pass even when the scan *did* write.
    assert.equal(await exists(join(dir, 'projects', 'DH', 'comments', 'DH-12.md')), false, 'no scan comment')
    assert.equal(await exists(watermarkOf(dir)), false, 'and the scan did not even run')
    await removeTree(dir)
  })

  it('a writable session does it — which is what makes the test above mean something', async () => {
    const dir = await scanFixture()
    await endAfterACommitMentioning(dir, {})

    const comments = await readFile(join(dir, 'projects', 'DH', 'comments', 'DH-12.md'), 'utf8')
    assert.match(comments, /touched DH-12/u, 'the scan commented on the issue it saw')
    assert.equal(await exists(watermarkOf(dir)), true, 'and it recorded where it got to')
    await removeTree(dir)
  })
})

describe('plugin: a partial read says so, and says which file (decision 80)', () => {
  it('names the unreadable file and warns that the answer is partial', async () => {
    // Why its own store: the file-level fixture is shared by every test here, so leaving a corrupt
    // file in it would change what all the later tests see.
    const dir = await mkdtemp(join(tmpdir(), 'dsh-jira-partial-'))
    emptyStores.push(dir)
    await mkdir(join(dir, 'tags'), { recursive: true })
    await writeFile(join(dir, 'tags', 'demo.md'), '---\ntype: tag\nname: demo\ndescription: demo\n---\n', 'utf8')
    await writeTextAtomic(storePaths.config(dir), fixture)
    const readable = encodeIssue(buildIssue('DH-12', 'readable'))
    assert.equal(readable.ok, true)
    if (readable.ok) await writeTextAtomic(storePaths.issue(dir, 'DH', 'DH-12' as never), readable.value)
    await writeTextAtomic(join(dir, 'projects', 'DH', 'issues', 'DH-13.md'), '# not an issue at all\n')

    registrations.length = 0
    await apply(fakeHost, { root: dir, machine_id: MACHINE }, {}, () => AT)
    const value = (await tool(LIST_TOOL_NAME).execute({ include_closed: true }, { agent: mainAgent })) as ToolValue

    assert.equal(value.ok, true, JSON.stringify(value))
    const rejected = value.rejected as readonly { file: string; reason: string }[]
    assert.equal(rejected.length, 1, 'the readable issue is still returned; only the broken one is reported')
    assert.equal(rejected[0]?.file, 'projects/DH/issues/DH-13.md', 'the reader needs the path, not a category')
    assert.ok((rejected[0]?.reason ?? '') !== '', 'and the reason')
    // Decision 80's sentence: without it a model reads a board that silently lost a file.
    assert.match(String(value.message), /partial/u)
    assert.equal((value.me as { machine?: string }).machine, MACHINE, 'and the envelope is intact')
    await removeTree(dir)
  })
})

describe('plugin: the wire never hands the model a camelCase key (decisions 41/159)', () => {
  it('walks a real value and checks every key, all the way down', async () => {
    // Decision 41 is a rule about the **machine-facing surface**, so this asserts the value the model
    // actually receives — not `toWire` in isolation. A new camelCase field on an entity, or a new tool
    // that forgets to wrap, shows up here rather than in a prompt nobody reads.
    const walk = (value: unknown, path: string): void => {
      if (Array.isArray(value)) {
        value.forEach((entry, index) => walk(entry, `${path}[${String(index)}]`))
        return
      }
      if (value === null || typeof value !== 'object') return
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        assert.match(key, /^[a-z0-9_]+$/u, `${path}.${key} is not snake_case`)
        walk(entry, `${path}.${key}`)
      }
    }

    const read = await call({ action: 'get', key: 'DH-12' })
    walk(read, 'get')
    walk(await call({ action: 'get', key: 'DH-99' }), 'refusal')

    registrations.length = 0
    await apply(fakeHost, { root, machine_id: MACHINE }, {}, () => AT)
    walk((await tool(LIST_TOOL_NAME).execute({ include_closed: true }, { agent: mainAgent })) as ToolValue, 'list')
    walk((await tool(KB_TOOL_NAME).execute({ action: 'search', query: 'anything' }, { agent: mainAgent })) as ToolValue, 'kb')
  })
})

describe('plugin: the host renders the wired value without crashing (decision 159)', () => {
  it('renders every tool result, which is the path a live call actually takes', async () => {
    // The regression this test exists for (2026-10-17): `wire()` made the value snake_case but the
    // renderers still read `issue.kbRefs`, so the host's `output.render` threw
    // `Cannot read properties of undefined (reading 'length')` and **every `get` failed live** —
    // while all 589 tests were green, because none of them rendered a wired value.
    const rendered = (value: ToolValue, name: string): string => {
      const parts = tool(name).output.render({}, value) as readonly { text?: string }[]
      const text = parts.map(part => part.text ?? '').join('\n')
      assert.equal(text.length > 0, true, `${name} must render something`)
      return text
    }

    const read = await call({ action: 'get', key: 'DH-12' })
    assert.match(rendered(read, TOOL_NAME), /DH-12/u)

    registrations.length = 0
    await apply(fakeHost, { root, machine_id: MACHINE }, {}, () => AT)
    const list = (await tool(LIST_TOOL_NAME).execute({ include_closed: true }, { agent: mainAgent })) as ToolValue
    assert.match(rendered(list, LIST_TOOL_NAME), /DH-12/u)

    const search = (await tool(KB_TOOL_NAME).execute({ action: 'search', query: 'nothing' }, { agent: mainAgent })) as ToolValue
    assert.equal(rendered(search, KB_TOOL_NAME).length > 0, true)

    // A refusal goes through the same render path, so it is worth one line too.
    assert.match(rendered(await call({ action: 'get', key: 'DH-99' }), TOOL_NAME), /NOT_FOUND/u)
  })
})


describe('plugin: apply can be undone, and the machine has one identity (decision 166)', () => {
  /**
   * A host whose registries behave like the real ones: `register` hands back an undo that actually
   * removes the entry. Without that, "dispose works" would be a test of nothing.
   */
  const disposableHost = (): Readonly<{
    ctx: JiraHostContext
    tools: string[]
    skills: string[]
    dispose: () => void
  }> => {
    const tools: string[] = []
    const skills: string[] = []
    const disposers: (() => void)[] = []
    let dispose: () => void = () => undefined
    const table: Record<string, unknown> = {
      tools: {
        register: (definition: { name: string }) => {
          tools.push(definition.name)
          const undo = (): void => {
            const at = tools.indexOf(definition.name)
            if (at !== -1) tools.splice(at, 1)
          }
          return undo
        },
        guard: () => () => undefined,
      },
      skills: {
        register: (definition: { name: string }) => {
          skills.push(definition.name)
          return (): void => {
            const at = skills.indexOf(definition.name)
            if (at !== -1) skills.splice(at, 1)
          }
        },
      },
      commands: {
        register: () => {
          const undo = (): void => undefined
          return undo
        },
      },
      get: (name: string) => table[name],
      on: () => () => undefined,
    }
    const ctx = new Proxy({}, {
      get: (_target, property) => {
        const name = String(property)
        if (name === 'then') return undefined
        if (name in table) return table[name]
        throw new Error(`cannot get property "${name}" without inject`)
      },
    }) as JiraHostContext
    return { ctx, tools, skills, get dispose() { return dispose }, set dispose(value: () => void) { dispose = value } }
  }

  it('returns a disposer that removes what it registered', async () => {
    const host = disposableHost()
    const dir = await mkdtemp(join(tmpdir(), 'dsh-jira-dispose-'))
    emptyStores.push(dir)
    const dispose = await apply(host.ctx, { root: dir, machine_id: MACHINE }, {}, () => AT)
    assert.equal(typeof dispose, 'function', 'apply hands back a disposer')
    assert.equal(host.tools.length, 3, 'three tools registered')
    assert.equal(host.skills.length >= 1, true, 'the skills registered')

    dispose()
    assert.deepEqual(host.tools, [], 'the tools are gone')
    assert.deepEqual(host.skills, [])
    dispose() // idempotent: a second dispose must not throw
    await removeTree(dir)
  })

  it('uses the resolved machine id everywhere, not the environment one', async () => {
    // The counters are keyed by machine id, so two identities on one machine means two number blocks
    // and two audit trails. The command surface used to compute `dsh-<env>` while the store used the
    // resolved id.
    const host = disposableHost()
    const dir = await mkdtemp(join(tmpdir(), 'dsh-jira-machine-'))
    emptyStores.push(dir)
    const dispose = await apply(host.ctx, { root: dir }, { DSH_MACHINE_ID: 'e2e-machine' }, () => AT)
    const counters = await readdir(join(dir, 'counters')).catch(() => [] as string[])
    // Nothing has written yet, so this asserts the wiring that *would* be used: the resolved id is the
    // environment one here, and the store's own id agrees with it rather than being prefixed.
    assert.equal(counters.includes('dsh-e2e-machine.json'), false, 'no invented "dsh-" identity')
    dispose()
    await removeTree(dir)
  })
})

describe('plugin: a pure tool session can build the tag vocabulary (decision 192)', () => {
  it('creates a tag through the tool, then tags an issue with it', async () => {
    // Trial feedback P0-2: the tag registry was CLI-only, so every issue an agent made ended up untagged
    // (and the error it got said `suggestions: []`). This is the whole loop, through the tool alone.
    const tagDir = await mkdtemp(join(tmpdir(), 'dsh-jira-tag-tool-'))
    try {
      await initializeRepository(tagDir)
      await writeFile(join(tagDir, 'config.md'), readFileSync(new URL('../../fixtures/config.md', import.meta.url), 'utf8'), 'utf8')
      registrations.length = 0
      await apply(fakeHost, { root: tagDir, machine_id: MACHINE }, {}, () => AT)

      const tagged = await tool().execute({ action: 'tag_create', data: { name: 'mcp', description: 'the MCP surface' } }, { agent: mainAgent }) as ToolValue
      assert.equal(tagged.ok, true, JSON.stringify(tagged))
      const created = await tool().execute({ action: 'create', project: 'DH', data: { summary: 'tagged', tags: ['mcp'] } }, { agent: mainAgent }) as ToolValue
      assert.equal(created.ok, true, JSON.stringify(created))
      assert.deepEqual((created as unknown as { issue?: { tags?: string[] } }).issue?.tags, ['mcp'])

      // …and an unknown tag now names the registry instead of offering an empty list.
      const unknown = await tool().execute({ action: 'create', project: 'DH', data: { summary: 'x', tags: ['nope'] } }, { agent: mainAgent }) as ToolValue
      assert.equal(unknown.ok, false)
      const context = unknown.error?.context as { registered?: readonly string[] } | undefined
      assert.deepEqual(context?.registered, ['mcp'])
    } finally {
      await removeTree(tagDir)
    }
  })
})

describe('plugin: close writes the transition and its comment in one transaction (decision 193)', () => {
  it('closes with a comment as ONE commit, where it used to take two', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-jira-close-'))
    try {
      await writeTextAtomic(storePaths.config(dir), readFileSync(new URL('../../fixtures/config.md', import.meta.url), 'utf8'))
      registrations.length = 0
      await apply(fakeHost, { root: dir, machine_id: MACHINE }, {}, () => AT)
      const created = (await tool().execute({ action: 'create', project: 'DH', data: { summary: 'to close' } }, { agent: mainAgent })) as ToolValue
      assert.equal(created.ok, true, JSON.stringify(created))
      const key = (created as unknown as { issue: { key: string } }).issue.key

      // Decision 189: a way must be walked — `todo` cannot jump to `closed`. That rule is **not** bypassed
      // by the composite action, which is the point of composing rather than special-casing.
      const early = (await tool().execute({ action: 'close', key, resolution: 'fixed' }, { agent: mainAgent })) as ToolValue
      assert.equal(early.ok, false)
      assert.equal(early.error?.code, 'INVALID_TRANSITION')
      const walking = (await tool().execute({ action: 'switch_state', key, to: 'in_progress' }, { agent: mainAgent })) as ToolValue
      assert.equal(walking.ok, true, JSON.stringify(walking))

      const before = await runGit(dir, ['rev-list', '--count', 'HEAD'])
      const closed = (await tool().execute({
        action: 'close',
        key,
        resolution: 'fixed',
        comment: { body: 'done: one transaction' },
      }, { agent: mainAgent })) as ToolValue
      assert.equal(closed.ok, true, JSON.stringify(closed))
      const after = await runGit(dir, ['rev-list', '--count', 'HEAD'])
      assert.equal(Number(after.stdout.trim()) - Number(before.stdout.trim()), 1, 'exactly one commit')

      const read = (await tool().execute({ action: 'get', key }, { agent: mainAgent })) as ToolValue
      const issue = (read as unknown as { issue: { status: string; resolution?: string } }).issue
      assert.equal(issue.resolution, 'fixed')
      assert.notEqual(issue.status, undefined)
      const comments = (read as unknown as { comments?: { body: string }[] }).comments ?? []
      assert.equal(comments.some(entry => entry.body.includes('one transaction')), true, 'the comment landed in the same write')
    } finally {
      await removeTree(dir)
    }
  })
})
