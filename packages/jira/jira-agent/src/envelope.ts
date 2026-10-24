/**
 * plugin/envelope — the model-facing value every tool returns (decision 56's envelope) and the
 * helpers that build it. Split out of `index.ts` under decision 186: the three tools share exactly
 * this vocabulary, so it is one module, not three copies.
 *
 * `me` belongs on a failure as much as on a success: §4.12's identity tuple is how the model
 * locates *itself* (§4.9), and the case where it most needs to is a refusal — "who am I, and why
 * may I not write" is exactly what a failure is about.
 */

import { type Identity, type Timestamp } from '@deepseek-ai/dsh-jira-core/entity.ts'
import { type JiraError } from '@deepseek-ai/dsh-jira-core/errors.ts'
import { type Actor, type Store } from '@deepseek-ai/dsh-jira-core/store.ts'
import { type Caller } from './caller.ts'
import { type SessionFacts } from './sessionRecord.ts'

export type ToolValue = Readonly<{
  ok: boolean
  issue?: unknown
  comments?: unknown
  /** `jira_kb`: one entry, or the hits of a search (decisions 54/75). */
  item?: unknown
  hits?: unknown
  /** `jira_list`: ready issues first, the blocked group last (decision 53). */
  items?: unknown
  groups?: unknown
  counts?: unknown
  truncated?: boolean
  limit?: number
  error?: JiraError
  writable: boolean
  reason?: string
  me?: unknown
  /** Files this answer had to skip (decision 80); `message` says the answer is therefore partial. */
  rejected?: readonly Readonly<{ file: string; reason: string }>[]
  /** One English sentence explaining a `rejected` list — decision 80's "not silent" half. */
  message?: string
}>

/** The clock the tools see, as decision 73's fixed-width UTC text. */
export const nowUtc = (clock: () => number): Timestamp =>
  `${new Date(clock()).toISOString().slice(0, 19)}Z` as Timestamp

/**
 * A failed call's value, in the same envelope a successful one uses (decisions 56/82).
 */
export const failure = (error: JiraError, caller: Caller, me: unknown): ToolValue =>
  Object.freeze({
    ok: false,
    error,
    writable: caller.writable,
    ...(caller.reason === undefined ? {} : { reason: caller.reason }),
    me,
  })

/**
 * `rejected` plus the sentence decision 80 requires it to carry.
 *
 * Decision 80: a read that had to skip unreadable files reports **which files and why** (never the
 * broken content) *and* says that the answer is partial — without the sentence, `rejected: []`-less
 * results look complete and a model reads a board that silently lost half its issues. The write half
 * of the same rule is the "the data landed, the commit did not" case (decisions 80/115): nothing is
 * lost, but silence would make it look as if the write never happened.
 */
export const skipped = (
  rejected: readonly Readonly<{ file: string; reason: string }>[],
  what: 'read' | 'write',
): Readonly<{ rejected?: readonly Readonly<{ file: string; reason: string }>[]; message?: string }> =>
  rejected.length === 0
    ? Object.freeze({})
    : Object.freeze({
      rejected: Object.freeze([...rejected]),
      message: what === 'read'
        ? `${String(rejected.length)} file(s) could not be read and were skipped, so this answer is partial; rejected names each file and the reason.`
        : 'The write is on disk but its commit failed, so it is not in the ledger history yet; rejected says why. Nothing is lost — the next flush retries.',
    })

export const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

export const asStringList = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value) && value.every(entry => typeof entry === 'string')
    ? Object.freeze(value as readonly string[])
    : undefined

export type RunOptions = Readonly<{
  store: Store
  caller: Caller
  at: Timestamp
  /** Called after a write lands, so the commit can be pushed soon (decision 60). */
  onWrote?: () => void
  /** Decision 84: declaring `timeoutMs` promises we honour `exec.signal`. */
  signal?: AbortSignal
  /** Decisions 10/119: what to record about this session, written once at its first write. */
  session?: Readonly<{ tool: string; model?: string; toolEvidence?: string; stateDir: string }>
  /**
   * The recorder `apply` injects (decision 183: per-apply state, not module level). Without it the
   * session is simply not recorded — direct callers of this function own their own bookkeeping.
   */
  recordSession?: (store: Store, actor: Actor, sessionId: string, facts: SessionFacts) => Promise<void>
}>

/** Turn a caller into the identity a write is recorded under (decision 48). */
export const actorFor = (options: RunOptions, caller: Caller): Identity =>
  caller.identity ?? (`human:${options.store.machineId}` as Identity)

export const okValue = (
  caller: Caller,
  me: unknown,
  issue: unknown,
  comments?: unknown,
  rejected: readonly Readonly<{ file: string; reason: string }>[] = [],
  what: 'read' | 'write' = 'read',
): ToolValue =>
  Object.freeze({
    ok: true,
    writable: caller.writable,
    ...(caller.reason === undefined ? {} : { reason: caller.reason }),
    me,
    issue,
    ...(comments === undefined ? {} : { comments }),
    ...skipped(rejected, what),
  })
