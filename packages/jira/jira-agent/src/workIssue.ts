/**
 * plugin/toolWork — `issue_work`: the narrow surface a dispatched executor writes through.
 *
 * Decision 89 keeps `jira_issue`'s writes to the main agent, and DH-512 keeps it that way: an
 * executor needs to report progress and hand a finished issue back for review, which is a strictly
 * smaller surface than renaming an issue, creating one, registering a tag or closing one. So this
 * is a second tool rather than a relaxation of the first.
 *
 * Authorization is a **scope**, not a role (DH-512): the issue must be in progress, and its
 * assignee must be the session that delegated to the caller (`SessionHeader.parentSession`). That
 * is precisely the window between the claiming parent and the review — the executor writes exactly
 * the issue it was dispatched for, and nothing once the issue is handed back.
 *
 * @module @deepseek-ai/dsh-jira-agent/workIssue
 */

import { formatError, invalidInput, readOnlySession, validateArgs } from '@deepseek-ai/dsh-jira-core'
import { type FieldSpec, type Identity, type IssueKey } from '@deepseek-ai/dsh-jira-core'
import type { IssueMutation } from '@deepseek-ai/dsh-jira-service'
import { type Caller } from './caller.ts'
import { type RunOptions, type ToolValue, actorFor, asString, failure, okValue } from './envelope.ts'

/** The tool name the host registry and the worker preset refer to. */
export const WORK_TOOL_NAME = 'issue_work'

/** The closed verb set: an executor reports, hands back, or asks for a hand-off. */
export const WORK_ACTIONS = ['progress', 'deliver', 'blocked'] as const

/** Who a blocked report waits for. The distinction is the reporter's fact, never inferred from prose. */
export const WAITING_FOR = ['person', 'dependency'] as const

/** The status a `deliver` enters: the shipped vocabulary's "awaiting a person's confirmation". */
export const REVIEW_STATUS = 'in_review'

/** `issue_work`'s argument schema, validated before any action runs. */
export const WORK_PARAMETERS: Readonly<Record<string, FieldSpec>> = Object.freeze({
  action: {
    type: 'string',
    required: true,
    description: `What to do: ${WORK_ACTIONS.join(' / ')}.`,
    enum: WORK_ACTIONS,
  },
  key: {
    type: 'string',
    required: true,
    description: 'The issue key you were dispatched for, e.g. DH-12.',
  },
  body: {
    type: 'string',
    description: 'progress and deliver: what you did, what you found and how it was verified. '
      + 'deliver records it as the review evidence, so it must say how to check the result.',
  },
  waiting_for: {
    type: 'string',
    description: 'blocked: who or what the work waits for.',
    enum: WAITING_FOR,
  },
  reason: {
    type: 'string',
    description: 'blocked: the concrete reason the work cannot go on.',
  },
})

/**
 * The model-facing description.
 *
 * It states the one constraint a caller cannot discover from a result: which issues this tool
 * accepts. Everything else (a refused verb, an empty body, a transition the vocabulary forbids)
 * comes back as an error that says what to do, so it is not repeated here.
 */
export const WORK_DESCRIPTION =
  'Report on one issue you were dispatched for, in the local dsh-jira ledger. '
  + '`progress` appends a comment; `deliver` hands the issue back for a person\'s review with the '
  + 'evidence comment; `blocked` records what the work waits for and why. '
  + 'It accepts only an issue that is in progress and assigned to the session that dispatched you — '
  + 'the dispatcher claims and reviews, you report.'

/** What the scope check decided about one call. */
export type WorkAccess = Readonly<{
  allowed: boolean
  /** Why the write is refused, when it is. */
  reason?: string
}>

const ALLOWED: WorkAccess = Object.freeze({ allowed: true })

/**
 * A refusal, with the sentence the caller reads. The closed error-code set (decision 52) has no
 * "not yours"; the shape of the refusal is a write refusal, so the code is `READ_ONLY_SESSION` and
 * the reason carries the distinction.
 * @param reason - the specific reason, phrased for the executor reading it.
 * @returns the frozen denial.
 */
const DENIED = (reason: string): WorkAccess => Object.freeze({ allowed: false, reason })

/**
 * The session inside an `agent:` identity — decision 48's fourth component.
 * @param identity - the assignee identity, when the issue has one.
 * @returns the session id, or undefined for a human identity or a malformed one.
 */
const sessionOf = (identity: Identity | undefined): string | undefined => {
  if (identity === undefined) return undefined
  const parts = identity.split('|')
  return parts.length === 4 ? parts[3] : undefined
}

/** The facts the scope check reads from one issue. */
export interface WorkTarget {
  /** The issue key, used in the refusals' sentences. */
  readonly key: IssueKey
  /** The issue's current status; only `in_progress` passes. */
  readonly status: string
  /** The claiming identity, when it has one. */
  readonly assignee?: Identity | undefined
}

/**
 * Decide whether this caller may write this issue (DH-512's scope check).
 *
 * The order is the one that produces the most useful refusal: a read-only deployment, then "you
 * were not dispatched", then the claim's owner, then the claim's state.
 * @param issue - the issue the call names.
 * @param caller - the caller verdict, carrying the parent session id.
 * @returns the access verdict with its reason.
 */
export const workAccess = (issue: WorkTarget, caller: Caller): WorkAccess => {
  if (caller.reason === 'dsh-read-only') return DENIED('this deployment marks the session read-only')
  if (caller.parentSessionId === undefined) {
    return DENIED('issue_work belongs to a dispatched executor; a session without a dispatcher '
      + 'claims and reviews through jira_issue')
  }
  const owner = sessionOf(issue.assignee)
  if (owner === undefined) {
    return DENIED(`${String(issue.key)} is not claimed, so nothing was dispatched for it`)
  }
  if (owner !== caller.parentSessionId) {
    return DENIED(`the issue is claimed by session '${owner}', which did not dispatch you`)
  }
  if (issue.status !== 'in_progress') {
    return DENIED(`the issue is '${issue.status}'; issue_work writes only an issue in progress`)
  }
  return ALLOWED
}

/**
 * A blocked report's marker, so the dispatching parent finds it without parsing prose (DH-512: the
 * classification is a tool argument, never a reading of the comment body).
 * @param waitingFor - who or what the work waits for.
 * @returns the marker the comment starts with, e.g. `[blocked:person]`.
 */
export const blockedMarker = (waitingFor: (typeof WAITING_FOR)[number]): string => `[blocked:${waitingFor}]`

/**
 * The comment body a blocked report records.
 * @param waitingFor - who or what the work waits for.
 * @param reason - why it cannot go on.
 * @returns the comment body, marker first.
 */
export const blockedBody = (waitingFor: (typeof WAITING_FOR)[number], reason: string): string =>
  `${blockedMarker(waitingFor)} ${reason.trim()}`

/**
 * Re-state the caller's verdict in the scope check's terms.
 *
 * The envelope's `writable`/`reason` (decision 56) answers "may this session write", and for this
 * tool that question is the scope check's answer rather than the session's: an executor is
 * `writable: false` for the ledger and `writable: true` for its own issue.
 * @param caller - the session verdict the host produced.
 * @param access - this call's scope verdict.
 * @returns the verdict the envelope reports.
 */
const asCaller = (caller: Caller, access: WorkAccess): Caller => Object.freeze({
  writable: access.allowed,
  ...(access.reason === undefined ? {} : { reason: access.reason }),
  ...(caller.identity === undefined ? {} : { identity: caller.identity }),
  ...(caller.sessionId === undefined ? {} : { sessionId: caller.sessionId }),
  ...(caller.parentSessionId === undefined ? {} : { parentSessionId: caller.parentSessionId }),
  ...(caller.cwd === undefined ? {} : { cwd: caller.cwd }),
})

/**
 * Validate the arguments, check the scope against the issue on disk, then write.
 * @param args - the raw tool arguments, validated against `WORK_PARAMETERS`.
 * @param options - the store, caller verdict, clock and write hooks for this run.
 * @param me - the caller's identity tuple, returned in every result.
 * @returns the action's value, or the refusal as a failed envelope.
 */
export const runWorkTool = async (
  args: unknown,
  options: RunOptions,
  me: unknown,
): Promise<ToolValue> => {
  const { jira } = options
  const validated = validateArgs(WORK_PARAMETERS, args)
  if (!validated.ok) return failure(validated.error, asCaller(options.caller, DENIED('the arguments were refused')), me)
  const input = validated.value
  const action = String(input.action)
  const key = asString(input.key) ?? ''

  // Reading first is what makes the refusal specific: the scope is a fact about the issue on disk,
  // and a caller who needs to know why was refused should not have to guess from its own session.
  const read = await jira.readIssue(key as IssueKey)
  if (!read.ok) {
    return failure(read.error, asCaller(options.caller, DENIED('the issue could not be read')), me)
  }
  const access = workAccess(read.value.issue, options.caller)
  const caller = asCaller(options.caller, access)
  if (!access.allowed) return failure(readOnlySession(access.reason ?? 'not dispatched'), caller, me)

  const body = asString(input.body)
  let mutation: IssueMutation
  if (action === 'progress') {
    if (body === undefined || body.trim() === '') {
      return failure(invalidInput('progress needs a non-empty `body`'), caller, me)
    }
    mutation = { action: 'comment', body }
  } else if (action === 'deliver') {
    if (body === undefined || body.trim() === '') {
      return failure(invalidInput('deliver needs a non-empty `body`: the evidence a person reviews'), caller, me)
    }
    // Decision 193's composition: one transaction, the transition and its comment together. The
    // action is named `close` because that is where the composition was first needed; `to` is what
    // makes it a review hand-off, and the vocabulary still decides whether the edge exists.
    mutation = { action: 'close', to: REVIEW_STATUS, comment: body }
  } else {
    const waitingFor = asString(input.waiting_for)
    if (waitingFor !== 'person' && waitingFor !== 'dependency') {
      return failure(invalidInput('blocked needs `waiting_for` ("person" or "dependency")'), caller, me)
    }
    const reason = asString(input.reason)
    if (reason === undefined || reason.trim() === '') {
      return failure(invalidInput('blocked needs a non-empty `reason`'), caller, me)
    }
    mutation = { action: 'comment', body: blockedBody(waitingFor, reason) }
  }

  const actor = { by: actorFor(options, caller), at: options.at }
  const written = await jira.mutateIssue(key as IssueKey, mutation, actor, {})
  if (!written.ok) return failure(written.error, caller, me)
  const rejected = written.value.transaction.commitError === undefined
    ? []
    : Object.freeze([Object.freeze({
      file: 'git',
      reason: formatError(written.value.transaction.commitError),
    })])
  return okValue(caller, me, written.value.transaction.change.issue, written.value.comments, rejected, 'write')
}
