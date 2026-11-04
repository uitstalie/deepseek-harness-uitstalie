/**
 * The browser face of the ledger (`remote.jira`).
 *
 * The browser sees the board, one issue, the knowledge search and the service's state; it cannot
 * name a ledger root — the root is the one the `jira-service` row resolved for this host, so a
 * client reads the same ledger the tools write, and nothing else.
 *
 * It also has exactly one write, {@link JiraRemote.superagentConfirm}: a person confirms a pending
 * proposal from the panel, and the comment's author is the ledger repository's own
 * `git user.name` rather than anything the browser supplies. Every arbitrary write still lives
 * behind `ctx.jira`, whose callers carry a model or CLI identity.
 *
 * Failures keep the service's `Result` contract inside the host: a `JiraError` becomes a
 * {@link RemoteError} carrying `jira/<kebab-code>` and the ledger's own code in `details`, so a
 * client branches on a stable code instead of a message.
 *
 * @module @deepseek-ai/dsh-jira-service/remote
 */

import type { Context } from '@deepseek-ai/cordis'
import { mkdir } from 'node:fs/promises'
import { entities, errors } from '@deepseek-ai/dsh-jira-core'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { ErrorCode, JiraError } from '@deepseek-ai/dsh-jira-core'
import type { RemoteErrorCode } from '@deepseek-ai/dsh-typert-protocol'
import { boardViewOf, detailViewOf, kbSearchViewOf, statusViewOf } from './wire.ts'
import {
  type ConfigEditorLike,
  type SetupRegistryLike,
  type SetupWorkspaceLike,
  dshHomeOf,
  readSuperagentHome,
  sameSetupPath,
  superagentHomeProblem,
  writeSuperagentHome,
} from './superagent-setup.ts'
import type {
  ChangeNotice,
  JiraBoardView,
  JiraChangeEvent,
  JiraIssueDetailView,
  JiraKbSearchView,
  JiraListQuery,
  JiraResult,
  JiraStatusView,
  ListQuery,
  SuperagentConfirmView,
  SuperagentHistoryView,
  SuperagentSetupView,
  SuperagentTriggersView,
  SuperagentStatusView,
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
 * The `remote.jira` namespace: the reads a browser needs, one human confirmation, and the change
 * stream over the host's one ledger.
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
   * The read-only super-agent view: ready, proposed, in progress, in review and blocked.
   * @returns the counts and the rows that need a person.
   * @throws {RemoteError} when the ledger cannot be read.
   */
  @Remote
  async superagentStatus(): Promise<SuperagentStatusView> {
    return unwrap(await this.ctx.jira.superagentStatus())
  }

  /**
   * Confirm one pending proposal as the person the ledger's `git user.name` names.
   *
   * This is the face's single write. The browser cannot pass a name: the service reads the ledger
   * repository's identity, so the comment is the same `human:<name>` credential a person would
   * write with the CLI. Repeating the click answers `alreadyApproved` without a second comment.
   * @param key - the issue whose latest comment is the proposal.
   * @returns the identity written and whether the approval already existed.
   * @throws {RemoteError} `jira/invalid-input` for a malformed key or no pending proposal,
   * `jira/not-found` when the issue is absent.
   */
  @Remote
  async superagentConfirm(key: string): Promise<SuperagentConfirmView> {
    const parsed = entities.asIssueKey(key)
    if (parsed === undefined) throw remoteErrorOf(errors.invalidInput(`"${key}" is not an issue key`, { key }))
    return unwrap(await this.ctx.jira.superagentConfirm(parsed))
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
   * Recent proposal comments, newest first.
   * @param limit - how many entries; the service clamps it to 1..50.
   * @returns the proposals with their issue key and active flag.
   * @throws {RemoteError} when the ledger cannot be read.
   */
  @Remote
  async superagentTriggers(limit?: number, before?: string): Promise<SuperagentTriggersView> {
    return unwrap(await this.ctx.jira.superagentTriggers(limit, before))
  }

  /**
   * Recent ledger commits, newest first: the review panel's history.
   * @param limit - how many entries; the service clamps it to 1..50.
   * @returns the commits as plain JSON.
   * @throws {RemoteError} when git cannot read the ledger.
   */
  @Remote
  async superagentHistory(limit?: number, before?: string): Promise<SuperagentHistoryView> {
    return unwrap(await this.ctx.jira.superagentHistory(limit, before))
  }

  /**
   * Where the super agent lives, as the profile currently records it.
   *
   * The row's config is the single source (DH-718): this read never guesses a directory, and it
   * answers `configured: false` when a person has not chosen one yet.
   * @returns the configured home and the workspace that owns it, when both exist.
   */
  @Remote
  superagentState(): SuperagentSetupView {
    const editor = this.ctx.get('configEditor') as ConfigEditorLike | undefined
    const home = readSuperagentHome(editor)
    const registry = this.ctx.get('workspaceRegistry') as SetupRegistryLike | undefined
    const workspace = home === undefined || registry === undefined
      ? undefined
      : registry.list().find(row => sameSetupPath(row.path, home))
    return {
      configured: home !== undefined,
      ...(home === undefined ? {} : { home }),
      ...(workspace === undefined ? {} : { workspaceId: workspace.id }),
    }
  }

  /**
   * Choose the super workspace: create its directory, register and pin it, then persist the choice.
   *
   * The persisted config is what makes a session opened there the super agent; the workspace is
   * created first so the sidebar shows the result of the click even while the row reloads.
   * @param path - the directory the person picked.
   * @returns the resulting state.
   * @throws {RemoteError} `jira/invalid-input` for a path that breaks the placement rules,
   * `jira/write-failed` when this host cannot persist the choice.
   */
  @Remote
  async superagentSetup(path: string): Promise<SuperagentSetupView> {
    const home = path.trim()
    const problem = superagentHomeProblem(home, dshHomeOf(process.env))
    if (problem !== undefined) throw new RemoteError('jira/invalid-input', problem, { jiraCode: 'INVALID_INPUT' })
    const editor = this.ctx.get('configEditor') as ConfigEditorLike | undefined
    if (editor === undefined) {
      throw new RemoteError('jira/write-failed', 'this host cannot persist the super agent location', { jiraCode: 'WRITE_FAILED' })
    }
    await mkdir(home, { recursive: true })
    const registry = this.ctx.get('workspaceRegistry') as SetupRegistryLike | undefined
    let workspace: SetupWorkspaceLike | undefined
    if (registry !== undefined) {
      workspace = await registry.create(home, 'Super agent')
      const first = registry.list().find(row => row.id !== workspace?.id)
      if (first !== undefined && registry.insertBefore !== undefined) {
        await registry.insertBefore(workspace.id, first.id)
      }
    }
    try {
      await writeSuperagentHome(editor, home)
    } catch (error: unknown) {
      throw new RemoteError('jira/write-failed', String(error), { jiraCode: 'WRITE_FAILED' })
    }
    return {
      configured: true,
      home,
      ...(workspace === undefined ? {} : { workspaceId: workspace.id }),
    }
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
    const read = unwrap(await this.ctx.jira.readIssue(parsed))
    return detailViewOf(read.issue, read.comments)
  }

  /**
   * Follow the ledger's changes without replaying any that happened before the subscription.
   *
   * The stream carries the service's own notice (monotonic `version`, kind, key) and nothing else:
   * the browser re-reads the snapshots it shows, so the frame cannot go stale against a read that
   * started later. A stream that ends is reopened by the client's stream supervisor; the browser
   * also re-reads after a reconnect, because nothing is replayed.
   * @param signal - the stream generation's lifetime.
   * @returns one item per committed change while subscribed.
   */
  @Remote({ mode: 'stream' })
  async *watch(signal: AbortSignal): AsyncIterable<JiraChangeEvent> {
    const queue: ChangeNotice[] = []
    let version = 0
    let wake: (() => void) | undefined
    const stop = this.ctx.jira.on('changed', (change) => {
      queue.push(change)
      wake?.()
      wake = undefined
    })
    const interrupt = (): void => {
      wake?.()
      wake = undefined
    }
    signal.addEventListener('abort', interrupt, { once: true })
    try {
      while (!signal.aborted) {
        const next = queue.shift()
        if (next !== undefined) {
          version += 1
          yield Object.freeze({
            version,
            kind: next.kind,
            ...(next.key === undefined ? {} : { key: next.key }),
            at: next.at,
          })
          continue
        }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      stop()
      signal.removeEventListener('abort', interrupt)
    }
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
