/**
 * core/batch — closing several issues in one call (decision 196, trial feedback P0-3).
 *
 * The chosen semantics are **all-or-nothing**: every key is validated read-only first, and a single
 * refusal means **nothing is written**. What this does *not* promise is a single commit — git has no
 * multi-file transaction here, so each key still lands as its own commit (N instead of 2N, and the
 * caller gets one call, one receipt).
 *
 * A failure *after* validation (a lock timeout, a race on one file) can therefore leave a partial
 * result; that is reported explicitly as `partial` with both lists, never smoothed over.
 */

import { type Actor, readIssueText, transact } from './store.ts'
import { type IssueKey } from './entity.ts'
import { type JiraError, invalidInput } from './errors.ts'
import { type Result, err, ok } from './result.ts'
import { applyClose } from './mutate.ts'
import { decodeIssue } from './codec.ts'
import { type Store, loadTags, loadVocab } from './store.ts'
import { validateIdentity } from './validate.ts'
import { assertProjectWritable } from './project.ts'
import { projectOf } from './entity.ts'

export type BatchCloseOptions = Readonly<{
  /** The closed status to enter; defaults to the vocabulary's first closed one. */
  to?: string
  resolution: string
  resolutionNote?: string
  comment?: string
}>

export type BatchClosed = Readonly<{
  closed: readonly IssueKey[]
  /** Present when a write failed after every key had already passed validation. */
  partial?: Readonly<{ closed: readonly IssueKey[]; failed: Readonly<{ key: IssueKey; error: JiraError }> }>
}>

type Refusal = Readonly<{ key: IssueKey; code: string; message: string }>

/**
 * Validate one key exactly as the write would, without writing anything.
 *
 * `applyClose` runs against the decoded issue, so the **same** rules answer here and in the write
 * (state machine, decision 189's walk, the resolution requirement) — a dry run that re-implemented
 * them would drift on the first change.
 */
const refusalFor = async (
  store: Store,
  actor: Actor,
  key: IssueKey,
  options: BatchCloseOptions,
  vocab: Awaited<ReturnType<typeof loadVocab>>,
): Promise<Refusal | undefined> => {
  if (!vocab.ok) return { key, code: vocab.error.code, message: vocab.error.message }
  const text = await readIssueText(store, key)
  if (!text.ok) return { key, code: text.error.code, message: text.error.message }
  const decoded = decodeIssue(text.value, key)
  if (!decoded.ok) return { key, code: decoded.error.code, message: decoded.error.message }
  const allowed = await assertProjectWritable(store, projectOf(key), String(actor.by))
  if (!allowed.ok) return { key, code: allowed.error.code, message: allowed.error.message }
  const planned = applyClose(decoded.value.issue, options, {
    vocab: vocab.value as never,
    by: actor.by,
    at: actor.at,
  } as never)
  return planned.ok ? undefined : { key, code: planned.error.code, message: planned.error.message }
}

/**
 * Close every key, or none (see the module comment for the one residual).
 * @param store - the ledger store every issue and the vocabulary are read from.
 * @param keys - the issue keys to close; duplicates collapse and an empty list is refused.
 * @param actor - the identity and timestamp recorded on every transition and comment.
 * @param options - the close options shared by every key.
 * @returns the closed keys and their comments, or the first refusal that aborted the batch.
 */
export const closeMany = async (
  store: Store,
  keys: readonly IssueKey[],
  actor: Actor,
  options: BatchCloseOptions,
): Promise<Result<BatchClosed, JiraError>> => {
  const unique = [...new Set(keys.map(String))].map(key => key as IssueKey)
  if (unique.length === 0) return err(invalidInput('close needs at least one key'))

  const identity = validateIdentity(String(actor.by), 'the acting identity')
  if (!identity.ok) return identity
  const tags = await loadTags(store)
  if (!tags.ok) return tags
  const vocab = await loadVocab(store)

  // Phase 1: every refusal is collected, so the caller fixes them in one pass instead of one per call.
  const refusals: Refusal[] = []
  for (const key of unique) {
    const refusal = await refusalFor(store, actor, key, options, vocab)
    if (refusal !== undefined) refusals.push(refusal)
  }
  if (refusals.length > 0) {
    return err(invalidInput(
      `${String(refusals.length)} of ${String(unique.length)} key(s) cannot be closed; nothing was written`,
      { refused: Object.freeze(refusals.map(refusal => Object.freeze({ ...refusal }))) },
    ))
  }

  // Phase 2: write. Each key is its own transaction (and its own commit).
  const closed: IssueKey[] = []
  for (const key of unique) {
    const result = await transact(store, key, actor, (issue, ctx) => applyClose(issue, options, ctx), 'close')
    if (!result.ok) {
      return ok(Object.freeze({
        closed: Object.freeze([...closed]),
        partial: Object.freeze({ closed: Object.freeze([...closed]), failed: Object.freeze({ key, error: result.error }) }),
      }))
    }
    closed.push(key)
  }
  return ok(Object.freeze({ closed: Object.freeze(closed) }))
}
