/**
 * core/errors — the single source of truth for error codes.
 *
 * DESIGN.md decision 52: exactly twelve codes, one shape `{ code, message, context? }`,
 * defined once here and used by the tools, the CLI, and `/jira` alike. A test asserts
 * that this list and the list written in DESIGN.md agree (decision 52's own requirement).
 */


export const ERROR_CODES = [
  'STALE_REVISION',
  'INVALID_TRANSITION',
  'RESOLUTION_REQUIRED',
  'UNKNOWN_TAG',
  'BLOCKED_BY_OPEN',
  'FOREIGN_MACHINE_READ_ONLY',
  'NOT_FOUND',
  'LOCK_TIMEOUT',
  'WRITE_FAILED',
  'KEY_EXHAUSTED',
  'INVALID_INPUT',
  'READ_ONLY_SESSION',
] as const

/** The frozen set of wire codes (decision 52); every failure carries exactly one. */
export type ErrorCode = (typeof ERROR_CODES)[number]

/** Free-form structured details attached to an error, for callers and for diagnostics. */
export type ErrorContext = Readonly<Record<string, unknown>>

/** The one error shape every surface renders: a frozen code, a message, and optional context. */
export type JiraError = Readonly<{
  code: ErrorCode
  message: string
  context?: ErrorContext
}>

/**
 * Build the one error shape every surface renders.
 * @param code - one of the frozen twelve wire codes.
 * @param message - the sentence the reader sees.
 * @param context - optional structured details.
 * @returns the frozen error value.
 */
export const jiraError = (code: ErrorCode, message: string, context?: ErrorContext): JiraError =>
  Object.freeze(context === undefined ? { code, message } : { code, message, context })

/**
 * Attach extra context to an existing error without touching its code or message (decision 190's
 * `keyAllocated: false` marker is the first user: a refused create must say the number survives).
 * @param error - the error to extend.
 * @param extra - the fields to add; they win over an existing key of the same name.
 * @returns a new error with the same code and message and the merged context.
 */
export const withContext = (error: JiraError, extra: ErrorContext): JiraError =>
  jiraError(error.code, error.message, Object.freeze({ ...(error.context ?? {}), ...extra }))

/**
 * Render an error the way the model-facing surfaces do (decision 55: English).
 * @param error - the error to render.
 * @returns `CODE: message`, with the context JSON appended when there is any.
 */
export const formatError = (error: JiraError): string => {
  const where = error.context === undefined ? '' : ` (${JSON.stringify(error.context)})`
  return `${error.code}: ${error.message}${where}`
}

/* Named constructors for the codes the current slice can produce. Each is a pure
 * function so callers compose instead of assembling literals by hand. */

/**
 * A caller mistake: the request is malformed and the message says how to fix it.
 * @param message - what is wrong with the request.
 * @param context - optional structured details for callers and diagnostics.
 * @returns the typed `INVALID_INPUT` error.
 */
export const invalidInput = (message: string, context?: ErrorContext): JiraError =>
  jiraError('INVALID_INPUT', message, context)

/**
 * Build the not-found error for a key; `kind` lets a knowledge lookup say `knowledge entry`,
 * not `issue` (decision 75).
 * @param key - the id that was asked for.
 * @param kind - what sort of thing the key names.
 * @returns the typed `NOT_FOUND` error.
 */
export const notFound = (key: string, kind = 'issue'): JiraError =>
  jiraError('NOT_FOUND', `${kind} ${key} not found`, { key, kind })

/**
 * An optimistic-concurrency failure: the issue moved under the caller's recorded revision.
 * @param expected - the revision the caller recorded.
 * @param actual - the revision the store now holds.
 * @returns the typed `STALE_REVISION` error.
 */
export const staleRevision = (expected: number, actual: number): JiraError =>
  jiraError('STALE_REVISION', `revision mismatch: expected ${expected}, found ${actual}`, {
    expected,
    actual,
  })

/**
 * Any **I/O** failure, read or write (C4 / decision 111): the wire code stays
 * `WRITE_FAILED` because the twelve codes are frozen (decision 52), but the meaning is
 * "this file operation did not happen", and the message says which one.
 * @param message - the sentence describing which operation did not happen.
 * @param context - optional structured details, such as the path involved.
 * @returns the typed `WRITE_FAILED` error.
 */
export const ioFailed = (message: string, context?: ErrorContext): JiraError =>
  jiraError('WRITE_FAILED', message, context)

/**
 * Build the refusal for a transition the state machine does not allow, naming the targets that
 * are allowed instead.
 * @param from - the status the issue is in.
 * @param to - the status the caller asked for.
 * @param allowed - the statuses this state may move to.
 * @returns the typed `INVALID_TRANSITION` error.
 */
export const invalidTransition = (
  from: string,
  to: string,
  allowed: readonly string[],
): JiraError =>
  jiraError('INVALID_TRANSITION', `cannot move from "${from}" to "${to}"`, {
    from,
    to,
    allowed: Object.freeze([...allowed]),
  })

/**
 * Build the refusal for entering a closed status without a resolution, listing the ones the
 * vocabulary accepts.
 * @param status - the closed status the issue was moving to.
 * @param resolutions - the resolutions the store accepts.
 * @returns the typed `RESOLUTION_REQUIRED` error.
 */
export const resolutionRequired = (status: string, resolutions: readonly string[]): JiraError =>
  jiraError('RESOLUTION_REQUIRED', `a resolution is required to enter "${status}"`, {
    status,
    resolutions: Object.freeze([...resolutions]),
  })

/**
 * Decision 192 (trial feedback P0-2): a tag error has to **say what to do**.
 *
 * `suggestions` used to be the only guidance, and it is empty when nothing is registered (or nothing is
 * close), so a pure tool-surface session saw `UNKNOWN_TAG` with `suggestions: []` — a dead end that made
 * the tag system unusable for agents. Now the context always carries `registered` (every tag there is),
 * or an explicit `hint` when there are none.
 * @param tag - the name the caller used.
 * @param suggestions - the close spellings worth trying, when there are any.
 * @param registered - every tag the store has registered.
 * @returns the typed `UNKNOWN_TAG` error, which always says how to get unstuck.
 */
export const unknownTag = (
  tag: string,
  suggestions: readonly string[],
  registered: readonly string[] = [],
): JiraError =>
  jiraError(
    'UNKNOWN_TAG',
    registered.length === 0
      ? `unknown tag "${tag}": no tags are registered yet`
      : `unknown tag "${tag}"`,
    {
      tag,
      suggestions: Object.freeze([...suggestions]),
      registered: Object.freeze([...registered]),
      ...(registered.length === 0
        ? { hint: 'create it first: jira_issue { action: "tag_create", data: { name, description } } — or `jira tag-create <name> --description <why>`' }
        : {}),
    },
  )
/**
 * Decision 24: claiming an issue that is still blocked by open issues is refused **for agents**,
 * naming exactly which keys are unresolved. A human may override, and the override is recorded as a
 * comment (the audit trail says the rule was stepped over, and by whom).
 * @param key - the issue whose claim was refused.
 * @param blockers - the open keys that block it.
 * @returns the typed `BLOCKED_BY_OPEN` error.
 */
export const blockedByOpen = (key: string, blockers: readonly string[]): JiraError =>
  jiraError('BLOCKED_BY_OPEN', `${key} is blocked by ${blockers.join(', ')}, which ${blockers.length === 1 ? 'is' : 'are'} not closed`, {
    key,
    blockers: Object.freeze([...blockers]),
  })
/**
 * §4.11: a project anchored to one machine (no remote) refuses writes from **other machines'
 * agents**. Humans are not affected, and the message names the owning machine so the reader knows
 * what to do about it (add a remote, or work on the machine that owns it).
 * @param project - the project that is anchored elsewhere.
 * @param ownerMachine - the machine the project belongs to.
 * @returns the typed `FOREIGN_MACHINE_READ_ONLY` error.
 */
export const foreignMachineReadOnly = (project: string, ownerMachine: string): JiraError =>
  jiraError('FOREIGN_MACHINE_READ_ONLY', `project ${project} belongs to machine ${ownerMachine}: agents on other machines may not write it`, {
    project,
    ownerMachine,
  })

/**
 * A project's key space is finite (decisions 52/158): `<PROJECT>-<n>` with `n` up to
 * {@link MAX_KEY_NUMBER}. Past that, refusing is the honest answer — a ledger with ten thousand
 * issues in one project is a project that should be split, and a corrupt counters file must not be
 * able to mint `DEMO-999999999` either.
 * @param project - the project whose space is exhausted.
 * @param limit - the last number the project may reach.
 * @param next - the number that would have been handed out.
 * @returns the typed `KEY_EXHAUSTED` error.
 */
export const keyExhausted = (project: string, limit: number, next: number): JiraError =>
  jiraError('KEY_EXHAUSTED',
    `${project} has no keys left: the next one would be ${project}-${String(next)}, and the space stops at ${project}-${String(limit)}`,
    { project, limit, next })

/**
 * Build the refusal for a write attempted in a read-only session.
 * @param reason - why the session is read-only, in the words the reader sees.
 * @returns the typed `READ_ONLY_SESSION` error.
 */
export const readOnlySession = (reason: string): JiraError =>
  jiraError('READ_ONLY_SESSION', `this session is read-only: ${reason}`, { reason })
