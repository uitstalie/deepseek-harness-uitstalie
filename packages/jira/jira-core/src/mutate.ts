/**
 * core/mutate — every change to an issue, as a pure function.
 *
 * Decision 102 ①/②: the caller supplies the clock (`at`), the actor (`by`) and the
 * vocabulary; the function returns a **new** issue plus any comments that must be appended.
 * Nothing here reads a file, takes a lock, or knows what a store is — which is why the
 * whole rulebook (transitions, the closed set, reopen bookkeeping) is testable in
 * microseconds and cannot be half-applied.
 *
 * Decision 44: `revision` starts at 1 and advances only when the issue's own fields or
 * body change — a no-op update leaves it alone, and comments (which have their own ids and
 * counters) never advance it.
 */

import { type Comment, type Identity, type Issue, type IssueKey, type Link, type LinkType, type Timestamp, asIssueKey } from './entity.ts'
import { type JiraError, blockedByOpen, invalidInput, invalidTransition } from './errors.ts'
import { asKnowledgeKey } from './kb.ts'
import { type Result, err, ok } from './result.ts'
import { type TagDef } from './tags.ts'
import { type Vocab, DEFAULT_PRIORITY, isClosedStatus, isLegalTransition, legalTargets } from './vocab.ts'
import {
  validateIssueType,
  validateKey,
  validatePriority,
  validateResolution,
  validateResolutionNote,
  validateStatus,
  validateSummary,
  validateTags,
} from './validate.ts'

export type PendingComment = Readonly<{ body: string; author: Identity; createdAt: Timestamp }>

/** A change is always "the new issue" plus "comments to append" — never a mutation. */
export type Change = Readonly<{ issue: Issue; comments: readonly PendingComment[] }>

export type ChangeContext = Readonly<{
  /** Decision 24: the open issues blocking this one; supplied by the caller (it needs the map). */
  blockers?: readonly string[]
  /** A human may step over the block rule; the override is recorded as a comment. */
  override?: boolean
  vocab: Vocab
  /** The tag registry, for the unknown-tag refusal (decisions 26/86). */
  knownTags: readonly TagDef[]
  at: Timestamp
  by: Identity
}>

const freezeChange = (issue: Issue, comments: readonly PendingComment[]): Change =>
  Object.freeze({ issue, comments: Object.freeze([...comments]) })

/** The status a new issue starts in: the lowest `order` the vocabulary declares. */
export const initialStatus = (vocab: Vocab): string => {
  const sorted = [...vocab.statuses].sort((left, right) => left.order - right.order)
  return sorted[0]?.name ?? 'todo'
}

/** Everything a create may supply; validation fills in the defaults and refuses unknown fields. */
export type NewIssueInput = Readonly<{
  key: string
  issueType: string
  summary: string
  priority?: string
  status?: string
  tags?: readonly string[]
  links?: readonly Link[]
  note?: string
  assignee?: string
  body?: string
}>

/** The validated, normalized fields of a new issue — everything except the key. */
export type ValidatedNewIssue = Readonly<{
  summary: string
  issueType: string
  priority: string
  status: string
  tags: readonly string[]
}>

/**
 * The key-independent half of creation validation (decision 190). A caller that allocates
 * keys must run this **before** allocating: a refused input must never burn a number —
 * a skipped number on disk is a gap nobody can explain from the counter alone.
 */
export const validateNewIssue = (
  input: Omit<NewIssueInput, 'key'>,
  ctx: ChangeContext,
): Result<ValidatedNewIssue, JiraError> => {
  const summary = validateSummary(input.summary)
  if (!summary.ok) return summary
  const issueType = validateIssueType(ctx.vocab, input.issueType)
  if (!issueType.ok) return issueType
  const priority = validatePriority(ctx.vocab, input.priority ?? DEFAULT_PRIORITY)
  if (!priority.ok) return priority
  const status = validateStatus(ctx.vocab, input.status ?? initialStatus(ctx.vocab))
  if (!status.ok) return status
  const tags = validateTags(ctx.knownTags, input.tags ?? [])
  if (!tags.ok) return tags
  // A brand-new issue carries no resolution: it cannot be closing in the same breath.
  const resolution = validateResolution(ctx.vocab, status.value, undefined)
  if (!resolution.ok) return resolution
  return ok(Object.freeze({
    summary: summary.value,
    issueType: issueType.value,
    priority: priority.value,
    status: status.value,
    tags: tags.value,
  }))
}

export const createIssue = (input: NewIssueInput, ctx: ChangeContext): Result<Change, JiraError> => {
  const key = validateKey(input.key)
  if (!key.ok) return key
  const checked = validateNewIssue(input, ctx)
  if (!checked.ok) return checked
  const { summary, issueType, priority, status, tags } = checked.value

  const project = key.value.slice(0, key.value.lastIndexOf('-'))
  const issue: Issue = Object.freeze({
    key: key.value,
    project,
    issueType,
    status,
    summary,
    priority,
    tags,
    links: Object.freeze([...(input.links ?? [])]),
    ...(input.note === undefined || input.note === '' ? {} : { note: input.note }),
    revision: 1,
    createdAt: ctx.at,
    updatedAt: ctx.at,
    reporter: ctx.by,
    ...(input.assignee === undefined || input.assignee === '' ? {} : { assignee: input.assignee as Identity }),
    kbRefs: Object.freeze([]),
    conflicted: false,
    body: input.body ?? '',
  })
  return ok(freezeChange(issue, []))
}

export type IssuePatch = Readonly<{
  summary?: string
  issueType?: string
  priority?: string
  tags?: readonly string[]
  /** The knowledge entries this issue was distilled into (decision 75's other direction). */
  kbRefs?: readonly string[]
  /** `null` clears the note; a string replaces it (decision 51). */
  note?: string | null
  body?: string
}>

/** Which of the patch's fields actually differ from the issue, in a stable order. */
const changedFields = (issue: Issue, next: Partial<Issue>): readonly string[] => {
  const fields: string[] = []
  for (const [field, value] of Object.entries(next)) {
    if (value === undefined) continue
    const current = (issue as unknown as Record<string, unknown>)[field]
    const before = Array.isArray(current) ? JSON.stringify(current) : current
    const after = Array.isArray(value) ? JSON.stringify(value) : value
    if (before !== after) fields.push(field)
  }
  return Object.freeze(fields)
}

/**
 * Build the next issue from a patch. Every supplied field is validated against the
 * vocabulary and the tag registry; a field the patch omits is left untouched.
 * @param issue - the issue before the update.
 * @param patch - the fields to change.
 * @param ctx - the change context (vocabulary, known tags, identity, timestamp).
 * @returns the change, or the first validation failure.
 */
export const applyUpdate = (issue: Issue, patch: IssuePatch, ctx: ChangeContext): Result<Change, JiraError> => {
  const next: Partial<Record<keyof Issue, unknown>> = {}

  if (patch.summary !== undefined) {
    const summary = validateSummary(patch.summary)
    if (!summary.ok) return summary
    next.summary = summary.value
  }
  if (patch.issueType !== undefined) {
    const issueType = validateIssueType(ctx.vocab, patch.issueType)
    if (!issueType.ok) return issueType
    next.issueType = issueType.value
  }
  if (patch.priority !== undefined) {
    const priority = validatePriority(ctx.vocab, patch.priority)
    if (!priority.ok) return priority
    next.priority = priority.value
  }
  if (patch.tags !== undefined) {
    const tags = validateTags(ctx.knownTags, patch.tags)
    if (!tags.ok) return tags
    next.tags = tags.value
  }
  if (patch.body !== undefined) next.body = patch.body
  if (patch.kbRefs !== undefined) {
    // Shape only: whether a referenced entry exists is `jira lint`'s business (decision 94), not a
    // reason to refuse a write that may be recording knowledge about to be written.
    for (const reference of patch.kbRefs) {
      if (asKnowledgeKey(reference) === undefined) {
        return err(invalidInput(`kb_refs entry "${reference}" is not a knowledge key (expected e.g. KB-7)`, {
          reference,
        }))
      }
    }
    next.kbRefs = Object.freeze([...patch.kbRefs]) as never
  }

  // `note` is the one field where "not given" and "cleared" differ, so it is handled
  // explicitly instead of through the generic comparison (which skips undefined).
  const noteCleared = patch.note !== undefined && (patch.note === null || patch.note === '')
  const nextNote = patch.note === undefined ? issue.note : noteCleared ? undefined : patch.note
  if (patch.note !== undefined) {
    if (nextNote === undefined) delete next.note
    else next.note = nextNote
  }

  const changed = [...changedFields(issue, next as Partial<Issue>)]
  if (patch.note !== undefined && nextNote !== issue.note && !changed.includes('note')) changed.push('note')
  if (changed.length === 0) return ok(freezeChange(issue, []))

  const merged: Record<string, unknown> = { ...issue, ...next }
  if (nextNote === undefined) delete merged.note
  else merged.note = nextNote
  const updated: Issue = Object.freeze({
    ...(merged as Issue),
    revision: issue.revision + 1,
    updatedAt: ctx.at,
  })
  return ok(freezeChange(updated, []))
}

export type TransitionOptions = Readonly<{ resolution?: string; resolutionNote?: string }>

/**
 * Move an issue along a declared transition. Entering a closed status requires a resolution;
 * leaving the closed set clears the previous conclusion and records it as a comment (decision 72).
 * @param issue - the issue before the transition.
 * @param to - the target status the vocabulary declares.
 * @param options - the optional resolution and resolution note.
 * @param ctx - the change context (vocabulary, identity, timestamp).
 * @returns the change, or the transition or validation failure.
 */
export const applyTransition = (
  issue: Issue,
  to: string,
  options: TransitionOptions,
  ctx: ChangeContext,
): Result<Change, JiraError> => {
  const status = validateStatus(ctx.vocab, to)
  if (!status.ok) return status
  const target = status.value

  if (target === issue.status) {
    return err(invalidInput(`"${target}" is already the status of ${issue.key}`, { status: target }))
  }
  if (!isLegalTransition(ctx.vocab, issue.status, target)) {
    return err(invalidTransition(issue.status, target, legalTargets(ctx.vocab, issue.status)))
  }

  const wasClosed = isClosedStatus(ctx.vocab, issue.status)
  const becomesClosed = isClosedStatus(ctx.vocab, target)
  const resolution = validateResolution(ctx.vocab, target, options.resolution)
  if (!resolution.ok) return resolution
  const resolutionNote = validateResolutionNote(resolution.value, options.resolutionNote)
  if (!resolutionNote.ok) return resolutionNote

  const comments: PendingComment[] = []
  const next: Record<string, unknown> = {
    ...issue,
    status: target,
    revision: issue.revision + 1,
    updatedAt: ctx.at,
  }

  if (becomesClosed) {
    next.resolution = resolution.value
    if (resolutionNote.value === undefined) delete next.resolutionNote
    else next.resolutionNote = resolutionNote.value
  } else {
    // Decision 72: leaving the closed set clears the conclusion, and the reason it was
    // there survives as an appended comment plus the git history.
    if (wasClosed) {
      const was = `${issue.resolution ?? 'unknown'}${issue.resolutionNote === undefined ? '' : ` — ${issue.resolutionNote}`}`
      comments.push(Object.freeze({
        body: `reopened: moving from "${issue.status}" to "${target}" cleared the previous resolution (${was})`,
        author: ctx.by,
        createdAt: ctx.at,
      }))
    }
    delete next.resolution
    delete next.resolutionNote
  }

  return ok(freezeChange(Object.freeze(next as Issue), comments))
}

/**
 * Decision 193 (trial feedback P0-3): **close = the transition and its closing comment, one commit**.
 *
 * Closing used to take two writes (`comment` then `switch_state`), so a batch of eight issues was 31
 * calls and 31 commits — for an agent, that is doubled context and doubled chance of getting it wrong.
 * This is a **composition**, not a bypass: the transition rules, the resolution requirement and the
 * comment's own validation all still run, and a failure of either half leaves the issue untouched.
 * @param issue - the issue to close.
 * @param options - the target status, resolution, note, and closing comment.
 * @param ctx - the change context (vocabulary, identity, timestamp).
 * @returns the combined transition and comment change, or the failure that left the issue untouched.
 */
export const applyClose = (
  issue: Issue,
  options: Readonly<{
    /** The closed status to enter; defaults to the first one the vocabulary declares. */
    to?: string
    resolution?: string
    resolutionNote?: string
    comment?: string
  }>,
  ctx: ChangeContext,
): Result<Change, JiraError> => {
  const target = options.to ?? ctx.vocab.closed[0] ?? ''
  const transition = applyTransition(issue, target, {
    ...(options.resolution === undefined ? {} : { resolution: options.resolution }),
    ...(options.resolutionNote === undefined ? {} : { resolutionNote: options.resolutionNote }),
  }, ctx)
  if (!transition.ok) return transition
  const body = options.comment
  if (body === undefined || body.trim() === '') return transition
  const commented = applyComment(transition.value.issue, body, ctx)
  if (!commented.ok) return commented
  return ok(freezeChange(commented.value.issue, [...transition.value.comments, ...commented.value.comments]))
}

/**
 * A comment never touches the issue (decision 44): the caller only appends it.
 * @param issue - the issue the comment is recorded against.
 * @param body - the comment text; an empty or whitespace-only body is refused.
 * @param ctx - the change context supplying the author and timestamp.
 * @returns the change carrying the pending comment.
 */
export const applyComment = (
  issue: Issue,
  body: string,
  ctx: ChangeContext,
): Result<Change, JiraError> => {
  if (body.trim() === '') return err(invalidInput('a comment must not be empty', { key: issue.key }))
  return ok(freezeChange(issue, [Object.freeze({ body, author: ctx.by, createdAt: ctx.at })]))
}

/** `assignee` merges claim and release (decision 50): an identity, or `null` to release. */
/** Decision 61: two hours, and no heartbeat — a claim nobody renews simply lapses. */
export const DEFAULT_LEASE_MS = 2 * 60 * 60 * 1000

/** `...Z` to the second, like every other timestamp (decision 47). */
const shiftSeconds = (at: Timestamp, ms: number): Timestamp =>
  new Date(new Date(at).getTime() + ms).toISOString().replace(/\.\d{3}Z$/u, 'Z') as Timestamp

/** An active lease is one that has not expired yet; the fixed-width format compares as text. */
export const leaseIsActive = (issue: Issue, at: Timestamp): boolean =>
  issue.leaseExpiresAt !== undefined && issue.leaseExpiresAt > at

/**
 * Renew a claim's lease (decision 61): the holder is clearly still working, so extend it. Only ever
 * **extends**, never shortens, and does **not** touch the revision — a lease is metadata, not body
 * (decision 44). Called from the write transaction, so it costs no extra write.
 */
export const renewAssigneeLease = (issue: Issue, at: Timestamp): Issue => {
  if (issue.assignee === undefined || issue.claimedAt === undefined) return issue
  const expires = shiftSeconds(at, DEFAULT_LEASE_MS)
  if (issue.leaseExpiresAt !== undefined && issue.leaseExpiresAt >= expires) return issue
  return Object.freeze({ ...issue, leaseExpiresAt: expires })
}

/**
 * Claim or release an issue (decision 50). A live lease held by somebody else is refused, an
 * expired one is taken over with a comment, and an agent may not claim blocked work without an
 * explicit override (decision 24).
 * @param issue - the issue before the assignment.
 * @param assignee - the new identity, or `null` to release.
 * @param ctx - the change context (identity, timestamp, blockers, override).
 * @returns the change, or the refusal that leaves the issue untouched.
 */
export const applyAssignee = (
  issue: Issue,
  assignee: Identity | null,
  ctx: ChangeContext,
): Result<Change, JiraError> => {
  const current = issue.assignee ?? null

  if (assignee === null) {
    if (current === null && issue.claimedAt === undefined && issue.leaseExpiresAt === undefined) {
      return ok(freezeChange(issue, []))
    }
    const released: Record<string, unknown> = { ...issue, revision: issue.revision + 1, updatedAt: ctx.at }
    delete released.assignee
    delete released.claimedAt
    delete released.leaseExpiresAt
    return ok(freezeChange(Object.freeze(released as Issue), []))
  }

  // §4.8: a live claim by somebody else is what keeps two agents off the same issue. An **expired**
  // one is not — it lapses, and the newcomer takes it over with a comment recording that.
  const heldByAnother = current !== null && current !== assignee
  if (heldByAnother && leaseIsActive(issue, ctx.at)) {
    return err(invalidInput(
      `${String(issue.key)} is claimed by ${String(current)} until ${String(issue.leaseExpiresAt)}; wait for the lease to lapse or ask the holder to release it`,
      { key: String(issue.key), holder: current, leaseExpiresAt: issue.leaseExpiresAt },
    ))
  }

  // Decision 24: an agent may not claim work that is still blocked. A human may, and the override
  // leaves a comment — the rule is a coordination device, not a cage.
  const blockers = ctx.blockers ?? []
  if (blockers.length > 0 && ctx.by.startsWith('agent:') && ctx.override !== true) {
    return err(blockedByOpen(String(issue.key), blockers))
  }

  const comments: PendingComment[] = heldByAnother
    ? [Object.freeze({
      body: `The claim held by ${String(current)} lapsed at ${String(issue.leaseExpiresAt)}; ${String(assignee)} took it over.`,
    }) as PendingComment]
    : []

  if (blockers.length > 0 && ctx.override === true) {
    comments.push(Object.freeze({
      body: `${String(assignee)} claimed ${String(issue.key)} while it is still blocked by ${blockers.join(', ')} (explicit override, decision 24).`,
    }) as PendingComment)
  }

  const next: Record<string, unknown> = {
    ...issue,
    assignee,
    claimedAt: ctx.at,
    leaseExpiresAt: shiftSeconds(ctx.at, DEFAULT_LEASE_MS),
    revision: issue.revision + 1,
    updatedAt: ctx.at,
  }
  return ok(freezeChange(Object.freeze(next as Issue), comments))
}

export type LinkChange = Readonly<{ type: LinkType; target: IssueKey; op: 'add' | 'remove' }>

/**
 * Links are a closed vocabulary of four types, stored as `links: [{ type, target }]` (decision 70).
 * @param issue - the issue whose links change.
 * @param change - the link type, target key, and add or remove operation.
 * @param ctx - the change context supplying the timestamp.
 * @returns the change, or the validation failure.
 */
export const applyLink = (
  issue: Issue,
  change: LinkChange,
  ctx: ChangeContext,
): Result<Change, JiraError> => {
  const target = asIssueKey(change.target)
  if (target === undefined) {
    return err(invalidInput(`"${change.target}" is not an issue key`, { target: change.target }))
  }
  if (target === issue.key) {
    return err(invalidInput('an issue cannot link to itself', { key: issue.key }))
  }
  const exists = issue.links.some(link => link.type === change.type && link.target === target)
  if (change.op === 'add' && exists) {
    return err(invalidInput(`${issue.key} already has ${change.type} → ${target}`, { type: change.type, target }))
  }
  if (change.op === 'remove' && !exists) {
    return err(invalidInput(`${issue.key} has no ${change.type} → ${target} to remove`, { type: change.type, target }))
  }
  const links = change.op === 'add'
    ? Object.freeze([...issue.links, Object.freeze({ type: change.type, target })])
    : Object.freeze(issue.links.filter(link => !(link.type === change.type && link.target === target)))
  return ok(freezeChange(Object.freeze({
    ...issue,
    links,
    revision: issue.revision + 1,
    updatedAt: ctx.at,
  }), []))
}
/**
 * Mark an issue conflicted (decision 71). Set **only** by the pull/rebase path or inside a write
 * transaction — never by a reader (decision 38) — and the flag is what makes the next write demand
 * `ack_conflict` (decision 71), so a human or an agent has to look before overwriting.
 */
export const applyConflictMark = (issue: Issue, ctx: ChangeContext): Result<Change, JiraError> => {
  if (issue.conflicted) return ok(freezeChange(issue, []))
  return ok(freezeChange(
    Object.freeze({ ...issue, conflicted: true, revision: issue.revision + 1, updatedAt: ctx.at }),
    [],
  ))
}

/**
 * Clear the `conflicted` flag: a human has looked at what git could not merge (decision 71).
 * Acknowledging is a change to the issue in its own right, so it advances the revision.
 * @param issue - the issue whose conflict flag is cleared.
 * @param ctx - the change context supplying the timestamp.
 * @returns the change; an already-acknowledged issue is returned unchanged.
 */
export const applyAckConflict = (issue: Issue, ctx: ChangeContext): Result<Change, JiraError> =>
  issue.conflicted !== true
    ? ok(freezeChange(issue, []))
    : ok(freezeChange(Object.freeze({
      ...issue,
      conflicted: false,
      revision: issue.revision + 1,
      updatedAt: ctx.at,
    }), []))

/**
 * Two changes as one: the first's issue is fed to the second (whole or not at all), and the
 * comments both wanted to append are kept in order.
 * @param first - the change applied first.
 * @param second - the change applied to the first's resulting issue.
 * @returns one change carrying the second issue and both comment lists in order.
 */
export const combineChanges = (first: Change, second: Change): Change =>
  Object.freeze({
    issue: second.issue,
    comments: Object.freeze([...first.comments, ...second.comments]),
  })
/** Read-only helper for callers that need the comments' own counter (decision 44). */
export const commentCount = (comments: readonly Comment[]): number => comments.length
