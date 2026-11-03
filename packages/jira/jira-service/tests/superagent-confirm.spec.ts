/**
 * `remote.jira.superagentConfirm`: the one write on the browser face.
 *
 * The confirmation has to be the credential `claim` consumes: a `[claim-approved]` comment whose
 * author is the ledger's own `human:<git user.name>`. The spec therefore checks the identity the
 * service reads from git, the idempotent repeat click, and the refusals that keep an arbitrary
 * write out of the browser.
 *
 * @module @deepseek-ai/dsh-jira-service/tests/superagent-confirm
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import JiraService from '@deepseek-ai/dsh-jira-service'
import type JiraRemote from '@deepseek-ai/dsh-jira-service/remote.ts'
import {
  asIdentity, createInStore, createStore, runGit, scaffoldStore, utcTimestamp,
} from '@deepseek-ai/dsh-jira-core'
import type { Identity, IssueKey, Timestamp } from '@deepseek-ai/dsh-jira-core'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '../src/remote.ts'

// Every case commits a comment through the ledger's git lock; under an aggregate run that is a
// few seconds, not the unit default's 5 (DH-713).
vi.setConfig({ testTimeout: 30_000 })

const MACHINE = 'a1b2c3d4'

const HUMAN = asIdentity('human:panel-tester') as Identity
const AGENT = asIdentity('agent:panel-test|dsh|a1b2c3d4|session-1') as Identity
const AT = utcTimestamp(new Date('2026-10-15T12:00:00Z'))
const LATER = '2026-10-15T13:00:00Z' as Timestamp

let ctx: Context
let remote: JiraRemote
let ledger: string
let first: IssueKey
let second: IssueKey

/** The mounted face, once its fiber has activated. */
const remoteOf = async (context: Context): Promise<JiraRemote> => {
  await vi.waitFor(() => { expect(context.get('jiraRemote')).toBeDefined() })
  return context.jiraRemote
}

/** The latest comment body of one issue, or undefined. */
const latestBody = async (key: IssueKey): Promise<string | undefined> => {
  const read = await ctx.jira.readIssue(key)
  if (!read.ok) throw new Error(JSON.stringify(read.error))
  return read.value.comments?.at(-1)?.body
}

/** The comment count of one issue. */
const commentCount = async (key: IssueKey): Promise<number> => {
  const read = await ctx.jira.readIssue(key)
  if (!read.ok) throw new Error(JSON.stringify(read.error))
  return read.value.comments?.length ?? 0
}

beforeAll(async () => {
  ledger = await mkdtemp(join(tmpdir(), 'dsh-jira-confirm-'))
  const scaffolded = await scaffoldStore(ledger)
  if (!scaffolded.ok) throw new Error(JSON.stringify(scaffolded.error))
  // The name the panel is allowed to claim: the same `git user.name` the CLI reads.
  const configured = await runGit(ledger, ['config', 'user.name', 'panel-tester'])
  if (configured.code !== 0) throw new Error(configured.stderr)

  const store = createStore({ root: ledger, machineId: MACHINE })
  const madeFirst = await createInStore(store, 'DH', { by: HUMAN, at: AT }, {
    issueType: 'task', summary: 'confirm me',
  })
  if (!madeFirst.ok) throw new Error(JSON.stringify(madeFirst.error))
  first = madeFirst.value.key
  const madeSecond = await createInStore(store, 'DH', { by: HUMAN, at: AT }, {
    issueType: 'task', summary: 'already started',
  })
  if (!madeSecond.ok) throw new Error(JSON.stringify(madeSecond.error))
  second = madeSecond.value.key

  ctx = new Context()
  await ctx.plugin(JiraService, {
    root: ledger,
    machine_id: MACHINE,
    host: 'fixture-host',
    push: { enabled: false },
  }).await()
  remote = await remoteOf(ctx)
}, 30_000)

afterAll(async () => {
  await ctx.fiber.dispose()
  await rm(ledger, { recursive: true, force: true })
})

describe('remote.jira.superagentConfirm', () => {
  it('refuses a malformed key and an issue with no pending proposal', async () => {
    const malformed = await remote.superagentConfirm('not-a-key').then(() => undefined, (error: unknown) => error)
    expect(malformed).toBeInstanceOf(RemoteError)
    expect(malformed).toMatchObject({ code: 'jira/invalid-input' })

    const noProposal = await remote.superagentConfirm(first).then(() => undefined, (error: unknown) => error)
    expect(noProposal).toMatchObject({ code: 'jira/invalid-input' })
    expect((noProposal as RemoteError).message).toMatch(/no pending proposal/u)
    expect(await commentCount(first)).toBe(0)
  })

  it('writes the human approval with the ledger\'s git identity and repeats idempotently', async () => {
    const proposed = await ctx.jira.mutateIssue(first, {
      action: 'comment',
      body: '[claim-proposal] I can take this',
    }, { by: AGENT, at: AT })
    expect(proposed.ok).toBe(true)
    expect((await remote.superagentStatus()).counts.proposed).toBe(1)

    const confirmed = await remote.superagentConfirm(first)
    expect(confirmed).toEqual({ key: String(first), author: 'human:panel-tester', alreadyApproved: false })
    expect(await latestBody(first)).toContain('[claim-approved]')
    expect(await commentCount(first)).toBe(2)

    const after = await ctx.jira.readIssue(first)
    expect(after.ok && after.value.comments?.at(-1)?.author).toBe('human:panel-tester')
    // The comment is the credential, not a state change: the issue is still ready for the claim.
    expect(after.ok && after.value.issue.status).toBe('todo')
    const status = await remote.superagentStatus()
    expect(status.counts.proposed).toBe(0)
    // Both issues are still todo; the second has no proposal yet, so the approval changed no state.
    expect(status.counts.ready).toBe(2)

    const again = await remote.superagentConfirm(first)
    expect(again).toEqual({ key: String(first), author: 'human:panel-tester', alreadyApproved: true })
    expect(await commentCount(first)).toBe(2)
  })

  it('refuses a proposal on an issue that is no longer todo', async () => {
    const proposed = await ctx.jira.mutateIssue(second, {
      action: 'comment',
      body: '[claim-proposal] start it',
    }, { by: AGENT, at: AT })
    expect(proposed.ok).toBe(true)
    const assigned = await ctx.jira.mutateIssue(second, { action: 'assignee', value: 'self' }, { by: HUMAN, at: AT })
    expect(assigned.ok).toBe(true)
    const started = await ctx.jira.mutateIssue(second, { action: 'switch_state', to: 'in_progress' }, {
      by: HUMAN, at: LATER,
    })
    expect(started.ok).toBe(true)

    const refused = await remote.superagentConfirm(second).then(() => undefined, (error: unknown) => error)
    expect(refused).toBeInstanceOf(RemoteError)
    expect(refused).toMatchObject({ code: 'jira/invalid-input' })
    expect((refused as RemoteError).message).toMatch(/only a todo proposal/u)
    expect(await latestBody(second)).toContain('[claim-proposal]')
  })
})
