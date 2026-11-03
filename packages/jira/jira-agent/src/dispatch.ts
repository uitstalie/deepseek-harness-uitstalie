/**
 * The dispatch record: the append-only ledger comment that binds one issue to the executor
 * Session that runs it.
 *
 * The record is written **before** the Session receives its first prompt (DH-702 review): the
 * executor's first `issue_work` call authorizes against this record, so a record that appears only
 * after the prompt leaves a window in which the real executor cannot write. The status word makes a
 * failed start visible: `starting` is written first, `started` after the prompt is admitted, and
 * `failed` when the start throws, so recovery can tell "never ran" from "ran and finished".
 *
 * @module @deepseek-ai/dsh-jira-agent/dispatch
 */

import type { Comment } from '@deepseek-ai/dsh-jira-core'

/** The marker a dispatch record starts with, so a restart finds it without reading prose. */
export const DISPATCH_MARKER = '[dispatch:session]'

/** Lifecycle of one dispatch record. */
export type DispatchStatus = 'starting' | 'started' | 'failed'

/** One parsed dispatch record. */
export interface DispatchRecord {
  /** The executor Session the issue is bound to. */
  readonly session: string
  /** Where the dispatch stands. */
  readonly status: DispatchStatus
  /** The comment body this record was parsed from. */
  readonly body: string
}

const STATUSES: ReadonlySet<string> = new Set(['starting', 'started', 'failed'])

/**
 * Render one dispatch record.
 * @param session - the executor Session id.
 * @param status - where the dispatch stands.
 * @returns the comment body.
 */
export const dispatchBody = (session: string, status: DispatchStatus): string =>
  `${DISPATCH_MARKER} ${session} ${status}`

/**
 * The latest dispatch record on an issue, when there is one.
 *
 * Records written before the status word existed read as `started`: they were recorded after a
 * successful prompt, which is the same fact. An unknown status word also reads as `started` rather
 * than inventing a failure, so a newer writer cannot make an old record look failed.
 * @param comments - the issue's comments, oldest first.
 * @returns the latest record, or undefined when the issue was never dispatched.
 */
export const dispatchRecordOf = (comments: readonly Pick<Comment, 'body'>[]): DispatchRecord | undefined => {
  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const body = comments[index]?.body.trimStart() ?? ''
    if (!body.startsWith(DISPATCH_MARKER)) continue
    const [session, status] = body.slice(DISPATCH_MARKER.length).trim().split(/\s+/u)
    if (session === undefined || session === '') return undefined
    const parsed = STATUSES.has(status ?? '') ? status as DispatchStatus : 'started'
    return { session, status: parsed, body }
  }
  return undefined
}
