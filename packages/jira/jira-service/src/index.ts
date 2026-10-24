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

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  config as coreConfig,
  doctor,
  entities,
  errors,
  generateStore,
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
import type { ChangeNotice, Issue, IssueKey, IssueList, Board, JiraResult, JiraServiceApi, JiraStatus, DoctorReport, KbSearch, KnowledgeKey, KnowledgePatch, ListQuery, NewIssueInput, NewKnowledge, PushOutcome, Store, SyncRecord, TransactOptions, Transaction, Actor, Created, Mutation, WrittenKnowledge } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    jira: JiraService
  }
}

/** What a `jira-service` row may configure: where the ledger is, who writes, whether to push. */
export interface Config {
  /** Ledger root; absent means resolve through `$JIRA_ROOT`, `$DSH_HOME/jira`, then the profile. */
  root?: string
  /** The `owner.host` audit field; absent means this machine's hostname. */
  host?: string
  /** Override the machine identity; absent means `$DSH_HOME/dsh-jira/machine-id`. */
  machine_id?: string
  /** Git remote to join on load; a local, offline operation that never clones or fetches. */
  remote?: string
  /** Push switch and debounce for the queue this service owns. */
  push?: {
    /** Whether a settle schedules a push. Absent means false: everything stays local. */
    enabled?: boolean
    /** Debounce window in milliseconds; absent means the core's default. */
    debounce_ms?: number
  }
}

/**
 * The pull's audit identity. The literal is non-empty, so `asIdentity` returns it unchanged; the
 * brand is asserted instead of re-parsed (§2: the service records an actor, it does not judge one).
 */
const PULL_IDENTITY = 'human:dsh-jira' as entities.Identity

/** What opening the ledger produced; a failed root still answers `status()` without a store. */
interface Opened {
  readonly root: string
  readonly machineId: string
  readonly store: JiraResult<Store>
  readonly queue?: push.PushQueue
}

const CONFIG_SCHEMA: z<Config> = z.object({
  root: z.string(),
  host: z.string(),
  machine_id: z.string(),
  remote: z.string(),
  push: z.object({
    enabled: z.boolean().default(false),
    debounce_ms: z.number().step(1).min(0),
  }).default({ enabled: false }),
})

/** A timestamp for now, in the ledger's UTC second precision. */
const now = (): entities.Timestamp => entities.utcTimestamp(new Date())

/** The one comment in this module that is not JSDoc: `status()` needs a frozen snapshot. */
const statusOf = (root: string, machineId: string, pushEnabled: boolean, lastSync: SyncRecord | null, pending: boolean): JiraStatus =>
  Object.freeze({ root, machineId, pushEnabled, lastSync, pending })

/**
 * The ledger facade. Read methods return the decoded data; write methods run inside the core's
 * write transaction (two-level lock, validation, compare-and-set, audit identity, commit). None of
 * them pushes, and none of them catches: a failure is the returned `JiraError`.
 */
export class JiraService extends Service implements JiraServiceApi {
  /** Row configuration, so a profile can move the ledger without a rebuild. */
  static Config: z<Config> = CONFIG_SCHEMA

  /** The resolved ledger root, or the empty string when it could not be resolved. */
  readonly root: string

  readonly #config: Readonly<Config>
  #opened: Promise<Opened> | undefined
  #machineId = 'local'
  #queue: push.PushQueue | undefined
  #lastSync: SyncRecord | null = null
  readonly #listeners = new Set<(change: ChangeNotice) => void>()

  /**
   * @param ctx - the context the service is registered on.
   * @param config - the row configuration; every field is optional.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'jira')
    this.#config = config
    const configured = coreConfig.configuredRootOf(config.root)
    const resolved = coreConfig.resolveStoreRoot({
      ...(configured === undefined ? {} : { configured }),
      env: process.env,
    })
    this.root = resolved.ok ? resolved.value : ''
    // The queue is created lazily, so the disposer reads it at teardown rather than capturing a
    // value that does not exist yet.
    ctx.effect(() => () => {
      this.#queue?.dispose()
      this.#listeners.clear()
    })
  }

  /** This machine's identity in the ledger's counter blocks. */
  get machineId(): string {
    return this.#machineId
  }

  /**
   * A synchronous view of the ledger's state.
   * @returns the root, identity, push switch, last push outcome and whether a push is armed.
   */
  status(): JiraStatus {
    return statusOf(this.root, this.#machineId, this.#config.push?.enabled === true, this.#lastSync, this.#queue?.isPending() === true)
  }

  /**
   * Read the ledger's issues with a filter.
   * @param query - the filter; every field is optional.
   * @returns the grouped list, or the error that prevented reading it.
   */
  async list(query: ListQuery): Promise<JiraResult<IssueList>> {
    const opened = await this.#open()
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
    const opened = await this.#open()
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
  async doctor(at?: entities.Timestamp): Promise<JiraResult<DoctorReport>> {
    const opened = await this.#open()
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
    const opened = await this.#open()
    if (!opened.store.ok) return opened.store
    return kbstore.searchKnowledgeIn(opened.store.value, query, topK)
  }

  /**
   * Create an issue in a project.
   * @param project - the project key, `DH`.
   * @param input - the draft.
   * @param actor - who is writing, for the audit fields.
   * @returns the created issue and its commit.
   */
  async create(project: string, input: NewIssueInput, actor: Actor): Promise<JiraResult<Created>> {
    const opened = await this.#open()
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
    const opened = await this.#open()
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
    const opened = await this.#open()
    if (!opened.store.ok) return opened.store
    const origin = kbstore.originFromIdentity(actor.by, this.#machineId)
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
    const opened = await this.#open()
    if (!opened.store.ok) return opened.store
    const origin = kbstore.originFromIdentity(actor.by, this.#machineId)
    const written = await kbstore.updateKnowledge(opened.store.value, key, actor, origin, patch)
    if (written.ok) this.notifyWrite(key)
    return written
  }

  /**
   * Flush the push queue now: pull --rebase, refresh the derived files, push.
   * @returns what the flush did, or the error that stopped it.
   */
  async sync(): Promise<JiraResult<PushOutcome>> {
    const opened = await this.#open()
    if (opened.queue === undefined) return result.err(errors.ioFailed('the ledger root could not be resolved'))
    const outcome = await opened.queue.flushNow({ settle: true })
    if (outcome.kind === 'failed') return result.err(outcome.error)
    this.notifyWrite()
    return result.ok(outcome)
  }

  /**
   * Refresh the derived files and commit them. Does not push; a successful settle arms the
   * debounced push when `push.enabled` is set, so what leaves the machine agrees with its sources.
   * @returns the ledger root-relative paths it rewrote, or the error that stopped it.
   */
  async settle(): Promise<JiraResult<readonly string[]>> {
    const opened = await this.#open()
    if (!opened.store.ok) return opened.store
    const settled = await generateStore.regenerateAndCommit(opened.store.value, now())
    if (!settled.ok) return settled
    if (this.#config.push?.enabled === true) opened.queue?.schedule()
    this.notifyWrite()
    return settled
  }

  /**
   * Subscribe to ledger changes.
   * @param event - the only event, `changed`.
   * @param listener - called after each commit.
   * @returns the unsubscribe function.
   */
  on(event: 'changed', listener: (change: ChangeNotice) => void): () => void {
    if (event !== 'changed') return () => {}
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /**
   * Open the store this service holds, for the tool runners that still work on the raw store.
   * This is the phase-1 bridge to `jira-agent`; moving them onto the methods above is phase 2.
   * @returns the store, or the error that prevented resolving its root.
   */
  async store(): Promise<JiraResult<Store>> {
    return (await this.#open()).store
  }

  /**
   * The push queue this service owns, so `/jira sync` reuses it instead of racing a second queue.
   * Part of the same phase-1 bridge.
   * @returns the queue, or `undefined` until the ledger root has opened.
   */
  pushQueue(): push.PushQueue | undefined {
    return this.#queue
  }

  /**
   * Record that a write happened outside this service's own methods (the tool runners' writes),
   * so the `changed` event still fires and the push queue still arms.
   * @param key - the affected key, when the write concerned one.
   */
  notifyWrite(key?: string): void {
    const change: ChangeNotice = Object.freeze({
      kind: 'write' as const,
      ...(key === undefined ? {} : { key }),
      at: now(),
    })
    for (const listener of this.#listeners) {
      try {
        listener(change)
      } catch {
        // A failing subscriber must not stop the others or the write that already committed.
      }
    }
    if (this.#config.push?.enabled === true) this.#queue?.schedule()
  }

  /** Open the ledger once: resolve the root, read the machine identity, create the store and queue. */
  #open = async (): Promise<Opened> => {
    this.#opened ??= this.#openOnce()
    return this.#opened
  }

  #openOnce = async (): Promise<Opened> => {
    const configured = coreConfig.configuredRootOf(this.#config.root)
    const resolved = coreConfig.resolveStoreRoot({
      ...(configured === undefined ? {} : { configured }),
      env: process.env,
    })
    if (!resolved.ok) return Object.freeze({ root: '', machineId: this.#machineId, store: resolved })

    const machineId = await machine.resolveMachineId({
      ...(this.#config.machine_id === undefined ? {} : { configured: this.#config.machine_id }),
      env: process.env,
      fallbackRoot: resolved.value,
    })
    this.#machineId = machineId.ok ? machineId.value.id : 'local'

    // Joining the shared repository is local: set the origin, never clone or fetch here.
    if (this.#config.remote !== undefined) await provision.ensureRemote(resolved.value, this.#config.remote)

    const store = coreStore.createStore({
      root: resolved.value,
      machineId: this.#machineId,
      host: this.#config.host ?? system.system.hostName(process.env),
    })
    const queue = push.createPushQueue({
      root: resolved.value,
      ...(this.#config.push?.enabled === undefined ? {} : { enabled: this.#config.push.enabled }),
      ...(this.#config.push?.debounce_ms === undefined ? {} : { debounceMs: this.#config.push.debounce_ms }),
      pull: async () => rebase.pullRebase(store, { by: PULL_IDENTITY, at: now() }),
      settle: async () => generateStore.regenerateAndCommit(store, now()),
      onOutcome: (outcome) => {
        this.#lastSync = recordOf(outcome)
      },
    })
    this.#queue = queue
    return Object.freeze({ root: resolved.value, machineId: this.#machineId, store: result.ok(store), queue })
  }
}

/** One push outcome in `status()` terms. */
const recordOf = (outcome: PushOutcome): SyncRecord => {
  const at = now()
  if (outcome.kind === 'failed') return Object.freeze({ at, outcome: 'failed', error: errors.formatError(outcome.error) })
  return Object.freeze({ at, outcome: 'ok' })
}

export default JiraService
