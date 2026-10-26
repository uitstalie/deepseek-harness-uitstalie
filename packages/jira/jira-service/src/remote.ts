/**
 * The read-only Remote face of the ledger (`remote.jira`).
 *
 * The browser sees the board, one issue, the knowledge search and the service's state; it never
 * sees a write method, and it cannot name a ledger root — the root is the one the `jira-service`
 * row resolved for this host, so a client reads the same ledger the tools write, and nothing else.
 *
 * Failures keep the service's `Result` contract inside the host: a `JiraError` becomes a
 * {@link RemoteError} carrying `jira/<kebab-code>` and the ledger's own code in `details`, so a
 * client branches on a stable code instead of a message.
 *
 * @module @deepseek-ai/dsh-jira-service/remote
 */

import type { Context } from '@deepseek-ai/cordis'
import { entities, errors } from '@deepseek-ai/dsh-jira-core'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { ErrorCode, JiraError } from '@deepseek-ai/dsh-jira-core'
import type { RemoteErrorCode } from '@deepseek-ai/dsh-typert-protocol'
import { boardViewOf, detailViewOf, kbSearchViewOf, statusViewOf } from './wire.ts'
import type {
  JiraBoardView,
  JiraIssueDetailView,
  JiraKbSearchView,
  JiraListQuery,
  JiraResult,
  JiraStatusView,
  ListQuery,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The wire-facing read-only projection of `ctx.jira`. */
    jiraRemote: JiraRemote
  }
}

/**
 * One ledger error code as a Remote failure code. Every code is listed so a new `jira-core` code
 * fails this module's typecheck instead of quietly reusing another code's endpoint.
 */
const REMOTE_CODES = {
  STALE_REVISION: 'jira/stale-revision',
  INVALID_TRANSITION: 'jira/invalid-transition',
  RESOLUTION_REQUIRED: 'jira/resolution-required',
  UNKNOWN_TAG: 'jira/unknown-tag',
  BLOCKED_BY_OPEN: 'jira/blocked-by-open',
  FOREIGN_MACHINE_READ_ONLY: 'jira/foreign-machine-read-only',
  NOT_FOUND: 'jira/not-found',
  LOCK_TIMEOUT: 'jira/lock-timeout',
  WRITE_FAILED: 'jira/write-failed',
  KEY_EXHAUSTED: 'jira/key-exhausted',
  INVALID_INPUT: 'jira/invalid-input',
  READ_ONLY_SESSION: 'jira/read-only-session',
} as const satisfies Readonly<Record<ErrorCode, RemoteErrorCode>>

/**
 * Turn one ledger error into the failure this face throws.
 * @param error - the `JiraError` the service returned.
 * @returns the same failure as a Remote error, code translated and message formatted.
 */
export const remoteErrorOf = (error: JiraError): RemoteError =>
  new RemoteError(REMOTE_CODES[error.code], errors.formatError(error), { jiraCode: error.code })

/**
 * Read a successful result, or throw the ledger's failure as a Remote failure.
 * @param result - the service's result.
 * @returns the success value.
 * @throws {RemoteError} the translated `JiraError` when the result failed.
 */
export function unwrap<T>(result: JiraResult<T>): T {
  if (!result.ok) throw remoteErrorOf(result.error)
  return result.value
}

/**
 * The filter the wire carries, as the list's query type.
 *
 * The two field sets are the same by construction; the service keeps its own name for the query
 * so `jira-agent` and the CLI read the core's type, not this face's.
 * @param query - the browser's filter.
 * @returns the same filter.
 */
export const listQueryOf = (query: JiraListQuery): ListQuery => query

/**
 * The `remote.jira` namespace: five reads over the host's one ledger.
 *
 * Mounted by the `JiraService` constructor on its own fiber, so the `jira-service` row alone is a
 * complete browser surface and no second row can answer from a different ledger.
 */
export default class JiraRemote extends TypertRemoteService {
  /** The ledger this face reads; another service may not stand in for it. */
  static inject = ['jira']

  /**
   * @param ctx - owning context carrying the ledger service.
   */
  constructor(ctx: Context) {
    // The Cordis key cannot be `jira` — the service above owns it — while the wire namespace is
    // the one the UI addresses.
    super(ctx, 'jiraRemote', { namespace: 'jira' })
  }

  /**
   * The ledger's root, identity and push state.
   * @returns the service's synchronous snapshot as plain JSON.
   */
  @Remote
  status(): JiraStatusView {
    return statusViewOf(this.ctx.jira.status())
  }

  /**
   * Every issue on the board, grouped by status with the blocked group last.
   * @returns the grouped board with its counts.
   * @throws {RemoteError} when the store cannot be read.
   */
  @Remote
  async board(): Promise<JiraBoardView> {
    return boardViewOf(unwrap(await this.ctx.jira.board()))
  }

  /**
   * The board narrowed by a filter.
   * @param query - the filter; every field is optional.
   * @returns the grouped result with its counts.
   * @throws {RemoteError} when the store cannot be read.
   */
  @Remote
  async list(query: JiraListQuery): Promise<JiraBoardView> {
    return boardViewOf(unwrap(await this.ctx.jira.list(listQueryOf(query))))
  }

  /**
   * One issue's frontmatter fields and body.
   * @param key - the issue key, `DH-12`.
   * @returns the issue as plain JSON.
   * @throws {RemoteError} `jira/invalid-input` for a malformed key, `jira/not-found` when absent.
   */
  @Remote
  async get(key: string): Promise<JiraIssueDetailView> {
    const parsed = entities.asIssueKey(key)
    if (parsed === undefined) throw remoteErrorOf(errors.invalidInput(`"${key}" is not an issue key`, { key }))
    return detailViewOf(unwrap(await this.ctx.jira.get(parsed)))
  }

  /**
   * Rank the knowledge base for one query.
   * @param query - the search text.
   * @param topK - how many hits to return; the core clamps it.
   * @returns the ranked hits with their `file:line`.
   * @throws {RemoteError} when the store cannot be read.
   */
  @Remote
  async kbSearch(query: string, topK?: number): Promise<JiraKbSearchView> {
    return kbSearchViewOf(unwrap(await this.ctx.jira.searchKnowledge(query, topK)))
  }
}
