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

export type ErrorCode = (typeof ERROR_CODES)[number]

export type ErrorContext = Readonly<Record<string, unknown>>

export type JiraError = Readonly<{
  code: ErrorCode
  message: string
  context?: ErrorContext
}>

export const jiraError = (code: ErrorCode, message: string, context?: ErrorContext): JiraError =>
  Object.freeze(context === undefined ? { code, message } : { code, message, context })

/**
 * Attach extra context to an existing error without touching its code or message (decision 190's
 * `keyAllocated: false` marker is the first user: a refused create must say the number survives).
 */
export const withContext = (error: JiraError, extra: ErrorContext): JiraError =>
  jiraError(error.code, error.message, Object.freeze({ ...(error.context ?? {}), ...extra }))

/** Render an error the way the model-facing surfaces do (decision 55: English). */
export const formatError = (error: JiraError): string => {
  const where = error.context === undefined ? '' : ` (${JSON.stringify(error.context)})`
  return `${error.code}: ${error.message}${where}`
}

/* Named constructors for the codes the current slice can produce. Each is a pure
 * function so callers compose instead of assembling literals by hand. */

export const invalidInput = (message: string, context?: ErrorContext): JiraError =>
  jiraError('INVALID_INPUT', message, context)

/** `kind` lets a knowledge lookup say "knowledge entry", not "issue" (decision 75). */
export const notFound = (key: string, kind = 'issue'): JiraError =>
  jiraError('NOT_FOUND', `${kind} ${key} not found`, { key, kind })

export const staleRevision = (expected: number, actual: number): JiraError =>
  jiraError('STALE_REVISION', `revision mismatch: expected ${expected}, found ${actual}`, {
    expected,
    actual,
  })

/**
 * Any **I/O** failure, read or write (C4 / decision 111): the wire code stays
 * `WRITE_FAILED` because the twelve codes are frozen (decision 52), but the meaning is
 * "this file operation did not happen", and the message says which one.
 */
export const ioFailed = (message: string, context?: ErrorContext): JiraError =>
  jiraError('WRITE_FAILED', message, context)

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
 * §4.11: a project anchored to one machine (no remote) refuses writes from **other machines'
 * agents**. Humans are not affected, and the message names the owning machine so the reader knows
 * what to do about it (add a remote, or work on the machine that owns it).
 */
/**
 * Decision 24: claiming an issue that is still blocked by open issues is refused **for agents**,
 * naming exactly which keys are unresolved. A human may override, and the override is recorded as a
 * comment (the audit trail says the rule was stepped over, and by whom).
 */
export const blockedByOpen = (key: string, blockers: readonly string[]): JiraError =>
  jiraError('BLOCKED_BY_OPEN', `${key} is blocked by ${blockers.join(', ')}, which ${blockers.length === 1 ? 'is' : 'are'} not closed`, {
    key,
    blockers: Object.freeze([...blockers]),
  })
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
 */
export const keyExhausted = (project: string, limit: number, next: number): JiraError =>
  jiraError('KEY_EXHAUSTED',
    `${project} has no keys left: the next one would be ${project}-${String(next)}, and the space stops at ${project}-${String(limit)}`,
    { project, limit, next })

export const readOnlySession = (reason: string): JiraError =>
  jiraError('READ_ONLY_SESSION', `this session is read-only: ${reason}`, { reason })
