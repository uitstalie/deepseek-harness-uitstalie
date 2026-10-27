/**
 * The ledger change feed: the in-process notice every capability reads, and the stream the
 * browser follows. Both are projected from the same service event, so a change the tools make is
 * the change the page is told about.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { asIdentity, utcTimestamp, type Identity } from '@deepseek-ai/dsh-jira-core/entity.ts'
import { writeTextAtomic } from '@deepseek-ai/dsh-jira-core/io.ts'
import { storePaths } from '@deepseek-ai/dsh-jira-core/store.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JiraService } from '../src/index.ts'
import type { ChangeNotice } from '../src/types.ts'

const MACHINE = 'a1b2c3d4'

// Every case mounts the real service over its own ledger; that mount has measured ~4.7 s under an
// aggregate run, so this file carries the composition budget rather than the 5 s unit default
// (DH-307).
vi.setConfig({ testTimeout: 30_000 })

const IDENTITY: Identity = (() => {
  const identity = asIdentity('human:tester')
  if (identity === undefined) throw new Error('unreachable')
  return identity
})()

const ACTOR = Object.freeze({
  by: IDENTITY,
  at: utcTimestamp(new Date('2026-10-15T12:00:00Z')),
})

const configFixture = async (): Promise<string> =>
  readFile(new URL('../../jira-core/fixtures/config.md', import.meta.url), 'utf8')

let context: Context | undefined
let ledger: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (ledger !== undefined) await rm(ledger, { recursive: true, force: true })
  ledger = undefined
})

/** Mount the real service over one scaffolded ledger. */
const mount = async (): Promise<Context> => {
  ledger = await mkdtemp(join(tmpdir(), 'dsh-jira-events-'))
  await writeTextAtomic(storePaths.config(ledger), await configFixture())
  const ctx = context = new Context()
  await ctx.plugin(JiraService, { root: ledger, machine_id: MACHINE, push: { enabled: false } })
  return ctx
}

/** Wait long enough for a generator to reach its first suspension point. */
const tick = async (): Promise<void> => {
  await new Promise<void>((resolve) => { setTimeout(resolve, 10) })
}

describe('the ledger change feed (DH-307)', () => {
  it('announces each committed write with its kind and key', async () => {
    const ctx = await mount()
    const changes: ChangeNotice[] = []
    ctx.jira.on('changed', (change) => { changes.push(change) })

    const first = await ctx.jira.createIssue('DH', undefined, { issueType: 'task', summary: 'first' }, ACTOR)
    expect(first.ok).toBe(true)
    await ctx.jira.createIssue('DH', undefined, { issueType: 'task', summary: 'second' }, ACTOR)

    expect(changes.map(change => change.kind)).toEqual(['write', 'write'])
    expect(changes.map(change => change.key)).toEqual(['DH-1', 'DH-2'])
    expect(changes[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u)
  })

  it('streams the same notice to the browser face, numbered, and ends on abort', async () => {
    const ctx = await mount()
    const lifetime = new AbortController()
    const iterator = ctx.jiraRemote.watch(lifetime.signal)[Symbol.asyncIterator]()
    const pending = iterator.next()
    await tick()

    const created = await ctx.jira.createIssue('DH', undefined, { issueType: 'task', summary: 'streamed' }, ACTOR)
    expect(created.ok).toBe(true)
    const item = await pending
    expect(item.done).toBe(false)
    expect(item.value?.version).toBe(1)
    expect(item.value?.key).toBe('DH-1')
    expect(item.value?.kind).toBe('write')

    lifetime.abort()
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
  })

  it('carries the settle notice too, so a pushed derived refresh refreshes the page', async () => {
    const ctx = await mount()
    const changes: ChangeNotice[] = []
    ctx.jira.on('changed', (change) => { changes.push(change) })
    const settled = await ctx.jira.settle()
    expect(settled.ok).toBe(true)
    expect(changes.map(change => change.kind)).toEqual(['settle'])
  })
})
