/**
 * The single owner of the jira ledger inside a host process: it resolves the root, opens the
 * store, holds the one push queue, refreshes the derived files and emits the `changed` event the
 * UI and the awareness line refresh from.
 *
 * One ledger root has exactly one `JiraService` per process (Cordis gives a service one instance)
 * and one writer across processes (the store's own file locks). A second consumer — a UI, another
 * capability, a CLI — shares this service; nobody else pushes.
 *
 * @module @deepseek-ai/dsh-jira-service
 */

import { Context, Service, type Volatile } from '@deepseek-ai/cordis'
// Type-only: the Loader's `loader/volatile-update` event declaration.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import {
  config as coreConfig,
  doctor,
  entities,
  errors,
  generateStore,
  git,
  inspect,
  io,
  kbstore,
  list,
  machine,
  provision,
  push,
  rebase,
  result,
  store as coreStore,
  system,
  tagsLint as coreTagsLint,
  vocab as coreVocab,
} from '@deepseek-ai/dsh-jira-core'
import { countStore } from '@deepseek-ai/dsh-jira-core/injection.ts'
import type { Store } from '@deepseek-ai/dsh-jira-core'
import { ensureSessionRecord, readWatermark, scanWatermarkPath, sessionScan, writeWatermark } from '@deepseek-ai/dsh-jira-core/session.ts'
import { decodeIssue } from '@deepseek-ai/dsh-jira-core/codec.ts'
import { blockersOf } from '@deepseek-ai/dsh-jira-core/inspect.ts'
import { invalidInput, staleRevision } from '@deepseek-ai/dsh-jira-core/errors.ts'
import {
  applyAckConflict, applyAssignee, applyClose, applyComment, applyLink, applyTransition, applyUpdate, combineChanges,
} from '@deepseek-ai/dsh-jira-core/mutate.ts'
import { assertProjectWritable, ensureWorkspaceProject } from '@deepseek-ai/dsh-jira-core/project.ts'
import { createTag as createTagInStore } from '@deepseek-ai/dsh-jira-core/tagstore.ts'
import { err, ok } from '@deepseek-ai/dsh-jira-core/result.ts'
import { closeMany } from '@deepseek-ai/dsh-jira-core/batch.ts'
import { resolveWorkspace } from '@deepseek-ai/dsh-jira-core/workspace.ts'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import type { Actor, Board, ChangeNotice, Created, DoctorReport, Identity, Issue, IssueKey, IssueList, DetailedIssueList, IssueBatchCloseResult, IssueCreateResult, IssueDraft, IssueMutation, IssueMutationOptions, IssueMutationResult, IssueRead, IssueBatchCloseOptions, TagCreateInput, TagCreateResult, JiraCounts, JiraFilteredIssues, JiraResult, JiraServiceApi, JiraSnapshot, JiraSyncState, JiraStatus, KnowledgeDetail, SessionRecordFacts, KbSearch, KnowledgeKey, KnowledgePatch, ListQuery, Mutation, NewIssueInput, NewKnowledge, PushOutcome, SyncRecord, TagsLintReport, Timestamp, Transaction, TransactOptions, WrittenKnowledge } from './types.ts'
import JiraRemote from './remote.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    jira: JiraService
  }
}

/** What a `jira-service` row may configure: where the ledger is, who writes, whether to push. */
export interface Config {
  /** Ledger root; absent means resolve through `$JIRA_ROOT`, `$DSH_HOME/jira`, then the profile. */
  root: Volatile<string | undefined>
  /** The `owner.host` audit field; absent means this machine's hostname. */
  host: Volatile<string | undefined>
  /** Override the machine identity; absent means `$DSH_HOME/dsh-jira/machine-id`. */
  machine_id: string | undefined
  /** Git remote to join on load; a local, offline operation that never clones or fetches. */
  remote: string | undefined
  /** Push switch and debounce for the queue this service owns. */
  push: {
    /** Whether a settle schedules a push. Absent means false: everything stays local. */
    enabled: Volatile<boolean>
    /** Debounce window in milliseconds; absent means the core's default. */
    debounce_ms: number | undefined
  }
}

/**
 * Read one live row value.
 *
 * A Loader-validated row hands this service `Volatile` references; a caller that mounts the
 * class directly (tests) may hand plain values, so both forms are accepted.
 * @param value - the configured value, a live reference, or undefined.
 * @returns the current plain value.
 */
function current<T>(value: Volatile<T> | T | undefined): T | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'object' && value !== null && typeof (value as { get?: unknown }).get === 'function') {
    return (value as Volatile<T>).get() as T
  }
  return value as T
}

/**
 * The pull's audit identity. The literal is non-empty, so `asIdentity` returns it unchanged; the
 * brand is asserted instead of re-parsed (§2: the service records an actor, it does not judge one).
 */
const PULL_IDENTITY = 'human:dsh-jira' as Identity

/** What opening the ledger produced; a failed root still answers `status()` without a store. */
interface Opened {
  readonly root: string
  readonly machineId: string
  readonly store: JiraResult<Store>
  readonly queue?: ReturnType<typeof push.createPushQueue>
}

/** One generation's resolved store and queue, unpublished until its generation wins. */
interface BuiltOpening {
  readonly generation: number
  readonly opened: Opened
  readonly queue?: ReturnType<typeof push.createPushQueue>
}

const CONFIG_SCHEMA = z.object({
  root: z.string().volatile(),
  host: z.string().volatile(),
  machine_id: z.string(),
  remote: z.string(),
  push: z.object({
    enabled: z.boolean().default(false).volatile(),
    debounce_ms: z.number().step(1).min(0),
  }).default({ enabled: false }),
})

/** A timestamp for now, in the ledger's UTC second precision. */
const now = (): Timestamp => entities.utcTimestamp(new Date())

/** The one comment in this module that is not JSDoc: `status()` needs a frozen snapshot. */
const statusOf = (
  root: string,
  machineId: string,
  host: string,
  pushEnabled: boolean,
  lastSync: SyncRecord | null,
  pending: boolean,
): JiraStatus =>
  Object.freeze({ root, machineId, host, pushEnabled, lastSync, pending })

/**
 * The ledger facade. Read methods return the decoded data; write methods run inside the core's
 * write transaction (two-level lock, validation, compare-and-set, audit identity, commit). None of
 * them pushes, and none of them catches: a failure is the returned `JiraError`.
 */
export class JiraService extends Service implements JiraServiceApi {
  /** Row configuration, so a profile can move the ledger without a rebuild. */
  static Config = CONFIG_SCHEMA

  /** The resolved ledger root, or the empty string when it could not be resolved. Live-updated. */
  root: string

  /** The `owner.host` audit value every write through this service carries. Live-updated. */
  host: string

  /** The push switch the queue was created with; live-updated with the row configuration. */
  private pushEnabled = false

  /**
   * Cordis hands a service to callers through a tracing proxy that overlays `ctx`, so a service
   * method runs with that proxy as `this`. ES `#private` fields brand-check the receiver and fail
   * there; these members are TypeScript-private instead, which is why the class can be a service
   * at all. Their one external reader is the constructor's own teardown closure.
   */
  private readonly config: Readonly<Config>
  private opened: Promise<Opened> | undefined
  private resolvedMachineId = 'local'
  private queue: ReturnType<typeof push.createPushQueue> | undefined
  private lastSync: SyncRecord | null = null
  /** Bumped by a live configuration change so an in-flight open cannot publish a stale queue. */
  private generation = 0
  private readonly listeners = new Set<(change: ChangeNotice) => void>()

  /**
   * @param ctx - the context the service is registered on.
   * @param config - the row configuration after schema validation, with defaults filled.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'jira')
    this.config = config
    this.root = this.resolveRoot()
    // Resolved once: the store's audit fields and `status()` must agree on the host writes carry.
    this.host = current(config.host) ?? system.system.hostName(process.env)
    this.pushEnabled = current(config.push.enabled) === true
    // The Loader commits volatile changes into the same references without remounting; a root,
    // host or push change therefore reopens the ledger and rebuilds the queue lazily.
    ctx.on('loader/volatile-update', () => { this.reconfigure() })
    // The queue is created lazily, so the disposer reads it at teardown rather than capturing a
    // value that does not exist yet. The teardown waits for admitted flush work: closing the queue
    // is what stops an old root from settling or pushing after the plugin has gone.
    ctx.effect(() => async () => {
      await this.retireQueue()
      this.listeners.clear()
    })
    // The browser face reads through this service, so it is mounted by the row that owns the
    // ledger: one row resolves one root, and no second row can answer from a different ledger.
    void ctx.plugin(JiraRemote)
  }

  /** Resolve the configured root through the shared precedence, without opening the store. */
  private resolveRoot(): string {
    const configured = coreConfig.configuredRootOf(current(this.config.root))
    const resolved = coreConfig.resolveStoreRoot({
      ...(configured === undefined ? {} : { configured }),
      env: process.env,
    })
    return resolved.ok ? resolved.value : ''
  }

  /**
   * Re-read the volatile fields after a Loader commit.
   *
   * A changed root or host invalidates the open store (its audit identity and files live under
   * the old root); a changed push switch invalidates the queue created with the old value. The
   * next operation reopens lazily, and the generation bump keeps a concurrent open from
   * publishing a queue built for the previous configuration.
   */
  private reconfigure(): void {
    const root = this.resolveRoot()
    const host = current(this.config.host) ?? system.system.hostName(process.env)
    const pushEnabled = current(this.config.push.enabled) === true
    if (root === this.root && host === this.host && pushEnabled === this.pushEnabled) return
    this.root = root
    this.host = host
    this.pushEnabled = pushEnabled
    this.generation += 1
    this.root = root
    this.host = host
    this.pushEnabled = pushEnabled
    // The queue refuses new work immediately and resolves after the flush it already admitted has
    // observed the close; a later open on the new root cannot be affected by that outcome because
    // `onOutcome` only records into the queue the service currently publishes.
    void this.retireQueue()
  }

  /**
   * Retire the published queue: stop admission, clear the open promise and the last outcome, then
   * wait for admitted flush work. Shared by a live root/host switch and by plugin teardown so both
   * own the queue the same way.
   * @returns a promise that settles after the retired queue has no in-flight work.
   */
  private async retireQueue(): Promise<void> {
    const queue = this.queue
    this.queue = undefined
    this.opened = undefined
    this.lastSync = null
    await queue?.close()
  }

  /** This machine's identity in the ledger's counter blocks. */
  get machineId(): string {
    return this.resolvedMachineId
  }

  /**
   * A synchronous view of the ledger's state.
   * @returns the root, identity, audit host, push switch, last push outcome and whether a push is armed.
   */
  status(): JiraStatus {
    return statusOf(
      this.root,
      this.resolvedMachineId,
      this.host,
      this.pushEnabled,
      this.lastSync,
      this.queue?.isPending() === true,
    )
  }

  /**
   * Read one issue with its comments and decode warnings.
   * @param key - the issue key.
   * @returns the issue, or `not-found`.
   */
  async readIssue(key: IssueKey): Promise<JiraResult<IssueRead>> {
    const opened = await this.open()
    if (!opened.store.ok) return opened.store
    const text = await coreStore.readIssueText(opened.store.value, key)
    if (!text.ok) return text
    const decoded = decodeIssue(text.value, key)
    if (!decoded.ok) return decoded
    const comments = await coreStore.readComments(opened.store.value, key)
    return result.ok(Object.freeze({
      issue: decoded.value.issue,
      warnings: decoded.value.warnings,
      ...(comments.ok ? { comments: comments.value } : {}),
    }))
  }

  /**
   * Apply one issue mutation under the issue lock.
   * @param key - the issue key.
   * @param mutation - the action and its fields.
   * @param actor - who is writing, for the audit fields.
   * @param options - compare-and-set and conflict acknowledgement.
   * @returns the transaction and the comments after it.
   */
  async mutateIssue(
    key: IssueKey,
    mutation: IssueMutation,
    actor: Actor,
    options: IssueMutationOptions = {},
  ): Promise<JiraResult<IssueMutationResult>> {
    const opened = await this.open()
    if (!opened.store.ok) return opened.store
    const mutate = (original: Parameters<typeof applyUpdate>[0], ctx: Parameters<typeof applyUpdate>[2]) => {
      const expected = options.expectedRevision
      if (expected !== undefined && expected !== original.revision) return err(staleRevision(expected, original.revision))
      if (original.conflicted === true && options.ackConflict !== true) {
        return err(invalidInput(`${original.key} is marked conflicted; pass ack_conflict to overwrite it deliberately`, {
          key: original.key,
        }))
      }
      const acked = original.conflicted === true && options.ackConflict === true
        ? applyAckConflict(original, ctx)
        : ok(Object.freeze({ issue: original, comments: Object.freeze([]) }))
      if (!acked.ok) return acked
      const issue = acked.value.issue
      const finish = (change: ReturnType<typeof applyUpdate>) =>
        change.ok ? ok(combineChanges(acked.value, change.value)) : change
      switch (mutation.action) {
        case 'update':
          return finish(applyUpdate(issue, mutation.patch, ctx))
        case 'switch_state':
          return finish(applyTransition(issue, mutation.to, {
            ...(mutation.resolution === undefined ? {} : { resolution: mutation.resolution }),
            ...(mutation.resolutionNote === undefined ? {} : { resolutionNote: mutation.resolutionNote }),
          }, ctx))
        case 'close':
          return finish(applyClose(issue, {
            ...(mutation.to === undefined ? {} : { to: mutation.to }),
            ...(mutation.resolution === undefined ? {} : { resolution: mutation.resolution }),
            ...(mutation.resolutionNote === undefined ? {} : { resolutionNote: mutation.resolutionNote }),
            ...(mutation.comment === undefined ? {} : { comment: mutation.comment }),
          }, ctx))
        case 'comment':
          return finish(applyComment(issue, mutation.body, ctx))
        case 'assignee':
          return finish(applyAssignee(issue, mutation.value === 'none' ? null : (ctx.by as Identity), ctx))
        case 'link':
          return finish(applyLink(issue, { type: mutation.type, target: mutation.target, op: mutation.op }, ctx))
      }
    }
    const allowed = await assertProjectWritable(opened.store.value, coreStore.projectOf(key), String(actor.by))
    if (!allowed.ok) return allowed
    let writeOptions: TransactOptions = {}
    if (mutation.action === 'assignee' && mutation.value === 'self') {
      const blockers = await blockersOf(opened.store.value, key)
      if (!blockers.ok) return blockers
      writeOptions = { blockers: blockers.value, override: options.override === true }
    }
    const done = await coreStore.transact(opened.store.value, key, actor, mutate, mutation.action, writeOptions)
    if (!done.ok) return done
    this.notifyWrite(key)
    const comments = await coreStore.readComments(opened.store.value, key)
    return result.ok(Object.freeze({
      transaction: done.value,
      ...(comments.ok ? { comments: comments.value } : {}),
    }))
  }

  /**
   * Create one issue, inferring the project from a checkout when it is omitted.
   * @param project - the project key, or undefined to infer it from `cwd`.
   * @param cwd - the checkout whose registered project should be used.
   * @param draft - the issue fields.
   * @param actor - who is writing.
   * @returns the created issue and whether the project was registered by this call.
   */
  async createIssue(
    project: string | undefined,
    cwd: string | undefined,
    draft: IssueDraft,
    actor: Actor,
  ): Promise<JiraResult<IssueCreateResult>> {
    const opened = await this.open()
    if (!opened.store.ok) return opened.store
    const store = opened.store.value
    let chosen = project?.toUpperCase() ?? ''
    /** Set by the inferred path: the registration itself knows whether it created the project. */
    let projectCreated: boolean | undefined
    if (chosen === '') {
      if (cwd === undefined) return err(invalidInput('create needs project: this session has no checkout to infer one from', { project: chosen }))
      const binding = await resolveWorkspace(store, cwd)
      if (!binding.ok) return binding
      const ensured = await ensureWorkspaceProject(store, actor, binding.value, store.machineId)
      if (!ensured.ok) return ensured
      chosen = ensured.value.key
      // `ensureWorkspaceProject` has already written `projects/<key>/`, so probing the directory
      // afterwards reports "existed" even for the project it just registered. The registration
      // result is the fact; only an explicit key still needs the directory probe.
      projectCreated = ensured.value.registered
    }
    if (!entities.isProjectKey(chosen)) return err(invalidInput('create needs `project`, e.g. "DH"', { project: chosen }))
    if (projectCreated === undefined) {
      // Probing a path is only safe after the key passed the path-segment check above (decision 162).
      const existed = await access(join(store.files.root, 'projects', chosen)).then(() => true).catch(() => false)
      projectCreated = !existed
    }
    const created = await coreStore.createInStore(store, chosen, actor, draft)
    if (!created.ok) return created
    this.notifyWrite(created.value.key)
    return result.ok(Object.freeze({ created: created.value, project: chosen, projectCreated }))
  }

  /**
   * Close several issues in one all-or-nothing call.
   * @param keys - the issue keys.
   * @param options - the target status, resolution and optional comment.
   * @param actor - who is writing.
   * @returns the closed keys, or every refusal.
   */
  async batchClose(
    keys: readonly IssueKey[],
    options: IssueBatchCloseOptions,
    actor: Actor,
  ): Promise<JiraResult<IssueBatchCloseResult>> {
    const opened = await this.open()
    if (!opened.store.ok) return opened.store
    const closed = await closeMany(opened.store.value, keys, actor, options)
    if (!closed.ok) return closed
    this.notifyWrite(keys[0] ?? '')
    return closed
  }

  /**
   * Register one tag.
   * @param actor - who is writing.
   * @param input - the tag name, description and optional alias.
   * @returns the created tag and whether it committed.
   */
  async createTag(actor: Actor, input: TagCreateInput): Promise<JiraResult<TagCreateResult>> {
    const opened = await this.open()
    if (!opened.store.ok) return opened.store
    const created = await createTagInStore(opened.store.value, actor, {
      name: input.name,
      description: input.description,
      ...(input.alias === undefined ? {} : { aliases: [input.alias] }),
    })
    if (!created.ok) return created
    this.notifyWrite(input.name)
    return result.ok(Object.freeze({ tag: created.value.tag, committed: created.value.committed }))
  }

  /**
   * Record a session at its first write, at most once per ledger.
   * @param sessionId - the session to record.
   * @param facts - the tool, model and evidence to record.
   * @param actor - who is writing, for the audit fields.
   * @returns whether the record was written, or the error that prevented it.
   */
  async recordSession(
    sessionId: string,
    facts: SessionRecordFacts,
    actor: Actor,
  ): Promise<JiraResult<Readonly<{ written: boolean }>>> {
    const opened = await this.open()
    if (!opened.store.ok) return opened.store
    return ensureSessionRecord(opened.store.value, actor, {
      id: sessionId,
      tool: facts.tool,
      ...(facts.model === undefined ? {} : { model: facts.model }),
      machineId: opened.store.value.machineId,
      startedAt: actor.at,
      ...(facts.toolEvidence === undefined ? {} : { toolEvidence: facts.toolEvidence }),
    })
  }

  /**
   * The ledger repository's current HEAD, or an empty string when it cannot be read.
   * @returns the commit the close-out scan starts from.
   */
  async gitHead(): Promise<string> {
    const opened = await this.open()
    if (!opened.store.ok) return ''
    const head = await git.runGit(opened.store.value.files.root, ['rev-parse', 'HEAD'])
    return head.code === 0 ? head.stdout.trim() : ''
  }

  /**
   * Scan the session from its starting commit, then advance the scan watermark.
   * A close-out failure is swallowed: it must not turn a good session into a bad one.
   * @param sessionId - the session that just completed a turn.
   * @param headAtStart - the commit the session started from.
   * @param stateDir - the machine-local state directory holding the watermark.
   * @param at - the scan timestamp.
   */
  async closeOutSession(sessionId: string, headAtStart: string, stateDir: string, at: Timestamp): Promise<void> {
    try {
      const opened = await this.open()
      if (!opened.store.ok) return
      const watermarkPath = scanWatermarkPath(stateDir, sessionId)
      const watermark = await readWatermark(watermarkPath)
      const scanned = await sessionScan(
        opened.store.value,
        { by: `human:${this.resolvedMachineId}` as Identity, at },
        { sessionId, from: watermark.lastSha ?? headAtStart },
      )
      if (!scanned.ok) return
      const head = await git.runGit(opened.store.value.files.root, ['rev-parse', 'HEAD'])
      if (head.code === 0) {
        await writeWatermark(watermarkPath, { lastSha: head.stdout.trim(), scans: watermark.scans + 1 })
      }
    } catch {
      // A close-out that fails must not turn a good session into a bad one (decision 100).
    }
  }

  /**
   * Count the ledger's projects, knowledge entries and open issues.
   * @returns the counts, or the error that prevented reading the store.
   */
  async counts(): Promise<JiraResult<JiraCounts>> {
    const opened = await this.open()
    if (!opened.store.ok) return opened.store
    const counts = await countStore(opened.store.value)
    if (!counts.ok) return counts
    return result.ok(Object.freeze({
      projects: counts.value.projects,
      knowledge: counts.value.knowledge,
      openIssues: counts.value.openIssues,
      readOnlyProjects: counts.value.readOnlyProjects,
    }))
  }

  /**
   * Read the ledger once for a human command: issues, parsed vocabulary and the doctor report.
   * @returns the snapshot, or the error that prevented reading the store.
   */
  async snapshot(): Promise<JiraResult<JiraSnapshot>> {
    const opened = await this.open()
    if (!opened.store.ok) return opened.store
    const snapshot = await inspect.readSnapshot(opened.root)
    const decoded = await inspect.listIssues(opened.root)
    const parsed = snapshot.configText === undefined ? undefined : coreVocab.parseVocab(snapshot.configText)
    return result.ok(Object.freeze({
      root: opened.root,
      issues: Object.freeze(decoded.issues),
      ...(parsed?.ok === true ? { vocab: parsed.value } : {}),
      report: doctor.checkStore(snapshot),
    }))
  }

  /**
   * Read the issues one human list or board filter matches.
   *
   * The vocabulary is optional on purpose: a ledger without a readable `config.md` still answers
   * `list`, and only the board refuses (the caller decides, as the command always has).
   * @param query - the filter; every field is optional.
   * @returns the matched issues, the vocabulary and the pre-filter issue count.
   */
  async queryIssues(query: ListQuery): Promise<JiraResult<JiraFilteredIssues>> {
    const opened = await this.open()
    if (!opened.store.ok) return opened.store
    const loaded = await coreStore.loadVocab(opened.store.value)
    const vocab = loaded.ok ? loaded.value : undefined
    const issues = await inspect.listIssues(opened.root)
    return result.ok(Object.freeze({
      issues: inspect.queryIssues(issues.issues, query, vocab),
      ...(vocab === undefined ? {} : { vocab }),
      total: issues.issues.length,
    }))
  }

  /**
   * Check the tag registry against the ledger's issues.
   * @returns the lint report the command renders, or the error that prevented reading.
   */
  async tagsLint(): Promise<JiraResult<TagsLintReport>> {
    const opened = await this.open()
    if (!opened.store.ok) return opened.store
    const tags = await coreStore.loadTags(opened.store.value)
    if (!tags.ok) return tags
    const issues = await inspect.listIssues(opened.root)
    return result.ok(coreTagsLint.lintTags(tags.value, issues.issues))
  }

  /**
   * Report whether the ledger has a remote and whether its worktree is dirty.
   * @returns the sync state, or the error that prevented asking git.
   */
  async syncState(): Promise<JiraResult<JiraSyncState>> {
    const opened = await this.open()
    if (!opened.store.ok) return opened.store
    const remote = await git.hasRemote(opened.root)
    const status = await git.runGit(opened.root, ['status', '--porcelain'])
    return result.ok(Object.freeze({
      remote,
      dirty: status.code === 0 && status.stdout !== '',
    }))
  }

  /**
   * Read the ledger's issues with a filter.
   * @param query - the filter; every field is optional.
   * @returns the grouped list, or the error that prevented reading it.
   */
  async list(query: ListQuery): Promise<JiraResult<IssueList>> {
    const opened = await this.open()
    if (!opened.store.ok) return opened.store
    const vocab = await coreStore.loadVocab(opened.store.value)
    if (!vocab.ok) return vocab
    const issues = await inspect.listIssues(opened.root)
    return result.ok(list.buildIssueList(issues.issues, vocab.value, query))
  }

  /**
   * Read the list together with the files it had to skip.
   * @param query - the filter; every field is optional.
   * @returns the grouped list and the skipped files, or the error that prevented reading.
   */
  async listWithRejected(query: ListQuery): Promise<JiraResult<DetailedIssueList>> {
    const opened = await this.open()
    if (!opened.store.ok) return opened.store
    const vocab = await coreStore.loadVocab(opened.store.value)
    if (!vocab.ok) return vocab
    const issues = await inspect.listIssues(opened.root)
    const rejected = issues.broken.map(entry => Object.freeze({ file: entry.path, reason: entry.reason }))
    return result.ok(Object.freeze({
      list: list.buildIssueList(issues.issues, vocab.value, query),
      rejected: Object.freeze(rejected),
    }))
  }

  /**
   * Read one issue.
   * @param key - the issue key.
   * @returns the decoded issue, or `not-found`.
   */
  async get(key: IssueKey): Promise<JiraResult<Issue>> {
    const opened = await this.open()
    if (!opened.store.ok) return opened.store
    const decoded = await io.readIssue(opened.store.value.files, key)
    if (!decoded.ok) return decoded
    return result.ok(decoded.value.issue)
  }

  /**
   * Group the ledger's issues by status for the board.
   * @returns the board, or the error that prevented reading it.
   */
  async board(): Promise<JiraResult<Board>> {
    return this.list({})
  }

  /**
   * Check the store for the inconsistencies the doctor knows about.
   * @param at - the timestamp the report is dated with; absent means now.
   * @returns the report, or the error that prevented reading the store.
   */
  async doctor(at?: Timestamp): Promise<JiraResult<DoctorReport>> {
    const opened = await this.open()
    if (!opened.store.ok) return opened.store
    const snapshot = await inspect.readSnapshot(opened.root)
    return result.ok(doctor.checkStore(snapshot, at))
  }

  /**
   * Search the knowledge base.
   * @param query - the search text.
   * @param topK - how many hits to return; the core clamps it.
   * @returns the hits with their `file:line`, or the error that prevented searching.
   */
  async searchKnowledge(query: string, topK?: number): Promise<JiraResult<KbSearch>> {
    const opened = await this.open()
    if (!opened.store.ok) return opened.store
    return kbstore.searchKnowledgeIn(opened.store.value, query, topK)
  }

  /**
   * Read one knowledge entry.
   * @param key - the knowledge key.
   * @returns the entry with its file path and warnings, or `not-found`.
   */
  async kbGet(key: KnowledgeKey): Promise<JiraResult<KnowledgeDetail>> {
    const opened = await this.open()
    if (!opened.store.ok) return opened.store
    const found = await kbstore.findKnowledge(opened.store.value, key)
    if (!found.ok) return found
    return result.ok(Object.freeze({
      entry: found.value.entry,
      path: found.value.path,
      warnings: found.value.warnings,
    }))
  }

  /**
   * Create an issue in a project.
   * @param project - the project key, `DH`.
   * @param input - the draft.
   * @param actor - who is writing, for the audit fields.
   * @returns the created issue and its commit.
   */
  async create(project: string, input: NewIssueInput, actor: Actor): Promise<JiraResult<Created>> {
    const opened = await this.open()
    if (!opened.store.ok) return opened.store
    const created = await coreStore.createInStore(opened.store.value, project, actor, input)
    if (created.ok) this.notifyWrite(created.value.key)
    return created
  }

  /**
   * Apply one mutation under the issue lock.
   * @param key - the issue key.
   * @param mutate - the mutation to apply.
   * @param what - what the commit message says was done.
   * @param actor - who is writing.
   * @param options - compare-and-set and identity options.
   * @returns the transaction, or a `conflict` carrying the current revision.
   */
  async transact(
    key: IssueKey,
    mutate: Mutation,
    what: string,
    actor: Actor,
    options?: TransactOptions,
  ): Promise<JiraResult<Transaction>> {
    const opened = await this.open()
    if (!opened.store.ok) return opened.store
    const done = await coreStore.transact(opened.store.value, key, actor, mutate, what, options)
    if (done.ok) this.notifyWrite(key)
    return done
  }

  /**
   * Create a knowledge entry.
   * @param input - the draft.
   * @param actor - who is writing.
   * @returns the written entry and its commit.
   */
  async kbCreate(input: NewKnowledge, actor: Actor): Promise<JiraResult<WrittenKnowledge>> {
    const opened = await this.open()
    if (!opened.store.ok) return opened.store
    const origin = kbstore.originFromIdentity(actor.by, this.resolvedMachineId)
    const written = await kbstore.createKnowledge(opened.store.value, actor, origin, input)
    if (written.ok) this.notifyWrite(written.value.entry.key)
    return written
  }

  /**
   * Update a knowledge entry in place.
   * @param key - the knowledge key.
   * @param patch - the fields to change.
   * @param actor - who is writing.
   * @returns the written entry and its commit.
   */
  async kbUpdate(key: KnowledgeKey, patch: KnowledgePatch, actor: Actor): Promise<JiraResult<WrittenKnowledge>> {
    const opened = await this.open()
    if (!opened.store.ok) return opened.store
    const origin = kbstore.originFromIdentity(actor.by, this.resolvedMachineId)
    const written = await kbstore.updateKnowledge(opened.store.value, key, actor, origin, patch)
    if (written.ok) this.notifyWrite(key)
    return written
  }

  /**
   * Flush the push queue now: pull --rebase, refresh the derived files, push.
   * @returns what the flush did, or the error that stopped it.
   */
  async sync(): Promise<JiraResult<PushOutcome>> {
    const opened = await this.open()
    if (opened.queue === undefined) return result.err(errors.ioFailed('the ledger root could not be resolved'))
    if (this.queue !== opened.queue) return result.err(errors.ioFailed('the ledger configuration changed while syncing; retry'))
    const outcome = await opened.queue.flushNow({ settle: true })
    // A close during the flush returns without settling or pushing; reporting it as success would
    // claim a sync that the retired queue deliberately refused.
    if (outcome.kind === 'failed') return result.err(outcome.error)
    if (outcome.kind === 'nothing-to-do' && outcome.reason === 'the queue was closed') {
      return result.err(errors.ioFailed('the ledger configuration changed while syncing; retry'))
    }
    // The flush settled and pushed already; re-arming the queue here would push again forever.
    this.emitChange('sync')
    return result.ok(outcome)
  }

  /**
   * Refresh the derived files and commit them. Does not push; a successful settle arms the
   * debounced push when `push.enabled` is set, so what leaves the machine agrees with its sources.
   * @returns the ledger root-relative paths it rewrote, or the error that stopped it.
   */
  async settle(): Promise<JiraResult<readonly string[]>> {
    const opened = await this.open()
    if (!opened.store.ok) return opened.store
    const settled = await generateStore.regenerateAndCommit(opened.store.value, now())
    if (!settled.ok) return settled
    this.emitChange('settle')
    if (this.pushEnabled) opened.queue?.schedule()
    return settled
  }

  /**
   * Subscribe to ledger changes.
   * @param _event - the only event, `changed`.
   * @param listener - called after each commit.
   * @returns the unsubscribe function.
   */
  on(_event: 'changed', listener: (change: ChangeNotice) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }



  /**
   * Record that a write happened outside this service's own methods (the tool runners' writes),
   * so the `changed` event still fires and the push queue still arms.
   * @param key - the affected key, when the write concerned one.
   */
  private notifyWrite(key?: string): void {
    this.emitChange('write', key)
    if (this.pushEnabled) this.queue?.schedule()
  }

  /**
   * Hand one notice to every subscriber. A throwing subscriber is contained: the commit it
   * reports already happened, and one bad listener must not hide the change from the others.
   * @param kind - what produced the change.
   * @param key - the affected key, when the change concerns one.
   */
  private emitChange(kind: ChangeNotice['kind'], key?: string): void {
    const change: ChangeNotice = Object.freeze({
      kind,
      ...(key === undefined ? {} : { key }),
      at: now(),
    })
    for (const listener of this.listeners) {
      try {
        listener(change)
      } catch {
        // A failing subscriber must not stop the others or the write that already committed.
      }
    }
  }

  /** Open the ledger once: resolve the root, read the machine identity, create the store and queue. */
  private readonly open = async (): Promise<Opened> => {
    this.opened ??= this.openOnce()
    return this.opened
  }

  private readonly openOnce = async (): Promise<Opened> => {
    // A volatile change can land while the root, machine or remote is being resolved. Rather than
    // publishing a queue built for the previous configuration, retire it and resolve again for the
    // generation that is current when the loop repeats.
    for (;;) {
      const generation = this.generation
      const built = await this.openStore(generation)
      if (built.queue === undefined) return built.opened
      if (generation !== this.generation) {
        await built.queue.close()
        continue
      }
      this.queue = built.queue
      return built.opened
    }
  }

  /**
   * Resolve one generation's store and queue without publishing it.
   * @param generation - the generation the caller captured before resolving.
   * @returns the built queue with its Opened record; `queue` is absent when the root fails to resolve.
   */
  private readonly openStore = async (generation: number): Promise<BuiltOpening> => {
    const configured = coreConfig.configuredRootOf(current(this.config.root))
    const resolved = coreConfig.resolveStoreRoot({
      ...(configured === undefined ? {} : { configured }),
      env: process.env,
    })
    if (!resolved.ok) {
      return { generation, opened: Object.freeze({ root: '', machineId: this.resolvedMachineId, store: resolved }) }
    }

    const machineId = await machine.resolveMachineId({
      ...(this.config.machine_id === undefined ? {} : { configured: this.config.machine_id }),
      env: process.env,
      fallbackRoot: resolved.value,
    })
    this.resolvedMachineId = machineId.ok ? machineId.value.id : 'local'

    // Joining the shared repository is local: set the origin, never clone or fetch here.
    if (this.config.remote !== undefined) await provision.ensureRemote(resolved.value, this.config.remote)

    const store = coreStore.createStore({
      root: resolved.value,
      machineId: this.resolvedMachineId,
      host: this.host,
    })
    const pushEnabled = current(this.config.push.enabled)
    const queue = push.createPushQueue({
      root: resolved.value,
      ...(pushEnabled === undefined ? {} : { enabled: pushEnabled }),
      ...(this.config.push.debounce_ms === undefined ? {} : { debounceMs: this.config.push.debounce_ms }),
      pull: async () => rebase.pullRebase(store, { by: PULL_IDENTITY, at: now() }),
      settle: async () => generateStore.regenerateAndCommit(store, now()),
      onOutcome: (outcome) => {
        // A retired queue may finish its admitted flush after a switch; its outcome must not
        // overwrite the status of the queue the service currently publishes.
        if (this.queue !== queue) return
        this.lastSync = recordOf(outcome)
      },
    })
    return {
      generation,
      queue,
      opened: Object.freeze({ root: resolved.value, machineId: this.resolvedMachineId, store: result.ok(store), queue }),
    }
  }
}

/** One push outcome in `status()` terms. */
const recordOf = (outcome: PushOutcome): SyncRecord => {
  const at = now()
  if (outcome.kind === 'failed') return Object.freeze({ at, outcome: 'failed', error: errors.formatError(outcome.error) })
  return Object.freeze({ at, outcome: 'ok' })
}

export default JiraService
