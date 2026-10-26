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
} from '@deepseek-ai/dsh-jira-core'
import { countStore } from '@deepseek-ai/dsh-jira-core/injection.ts'
import { readWatermark, scanWatermarkPath, sessionScan, writeWatermark } from '@deepseek-ai/dsh-jira-core/session.ts'
import type { Actor, Board, ChangeNotice, Created, DoctorReport, Identity, Issue, IssueKey, IssueList, JiraCounts, JiraResult, JiraServiceApi, KnowledgeDetail, JiraStatus, KbSearch, KnowledgeKey, KnowledgePatch, ListQuery, Mutation, NewIssueInput, NewKnowledge, PushOutcome, Store, SyncRecord, Timestamp, Transaction, TransactOptions, WrittenKnowledge } from './types.ts'
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
    // value that does not exist yet.
    ctx.effect(() => () => {
      this.queue?.dispose()
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
    const queue = this.queue
    this.queue = undefined
    this.opened = undefined
    this.lastSync = null
    queue?.dispose()
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
    const outcome = await opened.queue.flushNow({ settle: true })
    if (outcome.kind === 'failed') return result.err(outcome.error)
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
   * Open the store this service holds, for the tool runners that still work on the raw store.
   * This is the phase-1 bridge to `jira-agent`; moving them onto the methods above is phase 2.
   * @returns the store, or the error that prevented resolving its root.
   */
  async store(): Promise<JiraResult<Store>> {
    return (await this.open()).store
  }

  /**
   * Record that a write happened outside this service's own methods (the tool runners' writes),
   * so the `changed` event still fires and the push queue still arms.
   * @param key - the affected key, when the write concerned one.
   */
  notifyWrite(key?: string): void {
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
    const generation = this.generation
    const configured = coreConfig.configuredRootOf(current(this.config.root))
    const resolved = coreConfig.resolveStoreRoot({
      ...(configured === undefined ? {} : { configured }),
      env: process.env,
    })
    if (!resolved.ok) return Object.freeze({ root: '', machineId: this.resolvedMachineId, store: resolved })

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
        this.lastSync = recordOf(outcome)
      },
    })
    // A volatile change during open already invalidated this generation; do not publish its queue.
    if (generation === this.generation) this.queue = queue
    else queue.dispose()
    return Object.freeze({ root: resolved.value, machineId: this.resolvedMachineId, store: result.ok(store), queue })
  }
}

/** One push outcome in `status()` terms. */
const recordOf = (outcome: PushOutcome): SyncRecord => {
  const at = now()
  if (outcome.kind === 'failed') return Object.freeze({ at, outcome: 'failed', error: errors.formatError(outcome.error) })
  return Object.freeze({ at, outcome: 'ok' })
}

export default JiraService
