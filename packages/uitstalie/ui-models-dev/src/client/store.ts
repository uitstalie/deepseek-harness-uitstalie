/**
 * Page store for the models.dev settings page: catalog snapshot + per-provider drafts + submit state.
 * The Host is the single source of truth — the catalog is fetched through the modelsDev Remote, finished routes
 * are written into the llm-plus namespace via settings.mutate (llm-plus's hot-update wiring takes over after the write),
 * and one-time secrets are written to the credentials service via credentials.set (this page never persists secrets).
 *
 * Copy discipline: the store only produces structured failure data (SubmitFailure); copy is mapped by the
 * component layer through the locales dictionary.
 *
 * @module @deepseek-ai/dsh-client-ui-models-dev/store
 */

import type { ClientRemote, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { CatalogModelSummary, CatalogProviderSummary } from '@deepseek-ai/dsh-models-dev/types'
import type { AttemptView, OAuthRouteInfo } from '@deepseek-ai/dsh-llm-plus/types'
import type { RouteConfig } from '@deepseek-ai/dsh-llm-plus'
import { defaultDraft, draftError, materializeRoute, type ProviderDraft } from './draft.ts'
import { draftToRoute, routeDraftError, routeToDraft, type RouteDraft } from './route-edit.ts'

/** Wire methods used by this page (narrowed surface). */
export interface ModelsDevWire {
  modelsDev: Pick<ClientRemote['modelsDev'], 'listCatalogProviders' | 'listCatalogModels'>
  settings: Pick<ClientRemote['settings'], 'mutate' | 'describe'>
  credentials: Pick<ClientRemote['credentials'], 'set'>
  /** llm-plus OAuth Remote (trigger/poll/answer/cancel sign-in flows). */
  llmPlusAuth: Pick<ClientRemote['llmPlusAuth'], 'listOAuthRoutes' | 'beginFlow' | 'describeAttempt' | 'submitPromptAnswer' | 'cancelAttempt'>
}

/** Structured submit failure shape (the component maps it to dictionary copy). */
export type SubmitFailure =
  | { readonly kind: 'protocol'; readonly provider: string }
  | { readonly kind: 'invalidJson'; readonly field: 'headers' | 'body'; readonly provider: string }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'message'; readonly message: string }

/** State of the OAuth sign-in area (pure data). */
export interface OAuthSectionState {
  /** Manifest load status. */
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Routes with OAuth capability (including whether credentials are in place). */
  routes: readonly OAuthRouteInfo[]
  /** routeId → the latest attempt view (the polling bridge's result). */
  attempts: Record<string, AttemptView>
  /** promptId → text input draft (the carrier before the answer is submitted). */
  answerDrafts: Record<string, string>
}

/** State of the "my routes" management area (pure data). */
export interface MyRoutesState {
  /** Current route table (the effective value of the llm-plus namespace; empty = not loaded or no routes). */
  routes: Record<string, RouteConfig>
  /** The route being edited (draft carrier). */
  editing: { routeId: string; draft: RouteDraft } | undefined
  /** Host message for an edit/delete failure. */
  failure: string | null
}

/** Page snapshot (pure data). */
export interface ModelsDevState {
  /** Catalog load status. */
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Host message for a load failure. */
  error: string | null
  /** Catalog providers (sorted by id). */
  providers: readonly CatalogProviderSummary[]
  /** Filter string (lowercase match against id/name/npm). */
  filter: string
  /** Checked provider id → draft. */
  drafts: Record<string, ProviderDraft>
  /** Model subset data ('loading' = fetching; absent = not fetched). */
  models: Record<string, readonly CatalogModelSummary[] | 'loading'>
  /** Submit in progress. */
  submitting: boolean
  /** The most recent submit failure. */
  submitError: SubmitFailure | null
  /** Route ids written by the most recent submit (success receipt). */
  addedRoutes: readonly string[]
  /** OAuth sign-in area. */
  oauth: OAuthSectionState
  /** "My routes" management area. */
  myRoutes: MyRoutesState
}

/** Initial snapshot. */
function initialState(): ModelsDevState {
  return {
    status: 'idle',
    error: null,
    providers: [],
    filter: '',
    drafts: {},
    models: {},
    submitting: false,
    submitError: null,
    addedRoutes: [],
    oauth: { status: 'idle', routes: [], attempts: {}, answerDrafts: {} },
    myRoutes: { routes: {}, editing: undefined, failure: null },
  }
}

/** Record copy with one key removed (no-dynamic-delete: dynamic key deletion is done by rebuilding). */
function omitKeys<T>(record: Record<string, T>, keys: ReadonlySet<string>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([candidate]) => !keys.has(candidate)))
}

/** Page controller (held by register's inject; the hooks slot binds the store as useSnapshot). */
export class ModelsDevStore {
  /** Page snapshot source (the renderer binds it as useSnapshot). */
  readonly store: SnapshotStore<ModelsDevState> = createSnapshotStore(initialState())

  constructor(
    private readonly wire: ModelsDevWire,
    private readonly pacing: { readonly pollIntervalMs: number; readonly promptPollDelayMs: number },
  ) {}

  /**
   * Fetch the catalog provider list (shared entry point for the mount-time load and failure retries;
   * background refresh does not interrupt the current state).
   * @param background - background refreshes neither enter the loading state nor overwrite an existing error.
   */
  async load(background = false): Promise<void> {
    // Do not clear the existing list during background polling (avoids flicker); only the first load or an
    // explicit retry enters the loading state
    if (!background) {
      this.store.update((draft) => {
        draft.status = 'loading'
        draft.error = null
      })
    }
    try {
      const result = await this.wire.modelsDev.listCatalogProviders()
      this.store.update((draft) => {
        if (result.ok) {
          draft.status = 'ready'
          draft.providers = result.value
          draft.error = null
        } else if (!background) {
          draft.status = 'error'
          draft.error = result.error.message
        }
      })
    } catch (error) {
      // RemoteResult contract: business failures fold into {ok:false}; only assembly faults
      // (method not mounted/connection not ready) can reject — explicit loads enter the error state, background polling only logs
      if (!background) {
        const message = error instanceof Error ? error.message : String(error)
        console.error('ui-models-dev: catalog load rejected', error)
        this.store.update((draft) => {
          draft.status = 'error'
          draft.error = message
        })
      } else {
        console.error('ui-models-dev: background catalog refresh rejected', error)
      }
    }
  }

  /** Liveness switch for the polling loop (stopped when the fiber is removed). */
  private polling = false
  /** Timers owned by this controller, including OAuth polling and catalog refresh. */
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  /** Aborted when the controller is disposed, so pending waits settle immediately. */
  private readonly lifetime = new AbortController()

  /** Wait for one owned timer, or settle immediately once the controller is disposed. */
  private async waitFor(milliseconds: number): Promise<void> {
    if (this.lifetime.signal.aborted) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer)
        this.lifetime.signal.removeEventListener('abort', onAbort)
        resolve()
      }, milliseconds)
      const onAbort = (): void => {
        clearTimeout(timer)
        this.timers.delete(timer)
        resolve()
      }
      this.timers.add(timer)
      this.lifetime.signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** Stop every owned timer and wake pending loops; the controller is not reusable afterwards. */
  dispose(): void {
    this.polling = false
    this.lifetime.abort()
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }

  /**
   * Catalog refresh loop: one round every 60s (the catalog TTL is on the order of hours and summary calls are
   * very cheap; the gateway's forwarding event channel is application-exclusive, so models-dev/updated cannot be
   * pushed and polling is the honest channel). The host-side Remote answers only after the first load lands, so
   * the startup race is not on the page.
   */
  startCatalogPolling(): void {
    if (this.polling) return
    this.polling = true
    void (async () => {
      while (this.isPolling()) {
        await this.waitFor(this.pacing.pollIntervalMs)
        if (this.isPolling() && !this.lifetime.signal.aborted) await this.load(true)
      }
    })()
  }

  /**
   * Whether the poll loop is still armed.
   *
   * Read through a call so the loop re-reads the flag after each wait instead of
   * using the narrowing its own condition produced.
   * @returns whether polling is armed.
   */
  private isPolling(): boolean {
    return this.polling
  }

  /** Stop the polling loop (called when the page fiber is removed). */
  stopCatalogPolling(): void {
    this.polling = false
  }

  /**
   * Update the filter string.
   * @param filter - the new filter string (lowercase match against id/name/npm).
   */
  setFilter(filter: string): void {
    this.store.update((draft) => {
      draft.filter = filter
    })
  }

  /**
   * Check/uncheck a provider; checking builds a draft from the catalog defaults.
   * @param provider - the provider summary from the catalog.
   * @param checked - true to check, false to uncheck.
   */
  toggleProvider(provider: CatalogProviderSummary, checked: boolean): void {
    this.store.update((draft) => {
      if (checked) draft.drafts[provider.id] = defaultDraft(provider)
      else draft.drafts = omitKeys(draft.drafts, new Set([provider.id]))
    })
  }

  /**
   * Update individual fields of one draft (the component dispatches by field name).
   * @param id - catalog provider id.
   * @param patch - draft fields to overwrite.
   */
  updateDraft(id: string, patch: Partial<ProviderDraft>): void {
    this.store.update((draft) => {
      const current = draft.drafts[id]
      if (current !== undefined) draft.drafts[id] = { ...current, ...patch }
    })
  }

  /**
   * Lazily fetch one provider's model list (used by subset mode and the model count display).
   * @param id - catalog provider id.
   */
  async ensureModels(id: string): Promise<void> {
    if (this.store.getSnapshot().models[id] !== undefined) return
    this.store.update((draft) => {
      draft.models[id] = 'loading'
    })
    const result = await this.wire.modelsDev.listCatalogModels(id)
    this.store.update((draft) => {
      // Treat a failure as an empty table (the model count is advisory; a missing catalog does not block materialization)
      draft.models[id] = result.ok ? result.value : []
      // Default select-all before first entering subset; fill once the data is in place
      const current = draft.drafts[id]
      if (current?.modelMode === 'subset' && current.modelIds.length === 0 && result.ok) {
        draft.drafts[id] = { ...current, modelIds: result.value.map(model => model.id) }
      }
    })
  }

  /**
   * Switch the model subset mode; entering subset selects all by default (if the data has not arrived, ensureModels fills it).
   * @param id - catalog provider id.
   * @param mode - target subset mode.
   */
  setModelMode(id: string, mode: ProviderDraft['modelMode']): void {
    this.store.update((draft) => {
      const current = draft.drafts[id]
      if (current === undefined) return
      const loaded = draft.models[id]
      const allIds = loaded !== undefined && loaded !== 'loading' ? loaded.map(model => model.id) : []
      draft.drafts[id] = { ...current, modelMode: mode, modelIds: mode === 'subset' ? allIds : [] }
    })
    if (mode === 'subset') void this.ensureModels(id)
  }

  /**
   * Check one model in subset mode.
   * @param id - catalog provider id.
   * @param modelId - model id in the catalog.
   * @param checked - true to check, false to uncheck.
   */
  toggleModel(id: string, modelId: string, checked: boolean): void {
    this.store.update((draft) => {
      const current = draft.drafts[id]
      if (current === undefined) return
      draft.drafts[id] = {
        ...current,
        modelIds: checked
          ? [...current.modelIds, modelId]
          : current.modelIds.filter(candidate => candidate !== modelId),
      }
    })
  }

  // -------------------------------------------------------------------------
  // OAuth sign-in area (consumer side of the polling bridge: one describeAttempt every 800ms while running)
  // -------------------------------------------------------------------------

  /** Load the route list with OAuth capability (at mount + refresh configured after each attempt ends). */
  async loadOAuthRoutes(): Promise<void> {
    this.store.update((draft) => {
      draft.oauth.status = 'loading'
    })
    try {
      const result = await this.wire.llmPlusAuth.listOAuthRoutes()
      this.store.update((draft) => {
        draft.oauth.status = 'ready'
        if (result.ok) draft.oauth.routes = result.value
      })
    } catch (error) {
      console.error('ui-models-dev: oauth route list load rejected', error)
      this.store.update((draft) => {
        draft.oauth.status = 'error'
      })
    }
  }

  /**
   * Start one sign-in attempt and drive polling until a terminal state.
   * @param routeId - the route id to sign in to.
   */
  async beginLogin(routeId: string): Promise<void> {
    const result = await this.wire.llmPlusAuth.beginFlow(routeId)
    if (!result.ok) {
      console.error('ui-models-dev: beginFlow failed', result.error)
      return
    }
    const attemptId = result.value.attemptId
    // Polling bridge: until a terminal state; refresh the route list afterwards (configured may flip to true)
    let view: AttemptView | undefined
    do {
      if (this.lifetime.signal.aborted) return
      const described = await this.wire.llmPlusAuth.describeAttempt(attemptId)
      if (described.ok) {
        view = described.value
        this.store.update((draft) => {
          draft.oauth.attempts[routeId] = described.value
        })
      }
      if (view === undefined || view.status === 'running') {
        await this.waitFor(this.pacing.promptPollDelayMs)
      }
    } while (view === undefined || view.status === 'running')
    await this.loadOAuthRoutes()
  }

  /**
   * Answer a pending prompt (the text box draft is cleared with the answer).
   * @param routeId - the route id this attempt belongs to.
   * @param promptId - the id of the pending prompt.
   */
  async answerPrompt(routeId: string, promptId: string): Promise<void> {
    const attemptId = this.store.getSnapshot().oauth.attempts[routeId]?.id ?? ''
    const value = this.store.getSnapshot().oauth.answerDrafts[promptId] ?? ''
    const result = await this.wire.llmPlusAuth.submitPromptAnswer(attemptId, promptId, value)
    if (result.ok) {
      this.store.update((draft) => {
        draft.oauth.answerDrafts = omitKeys(draft.oauth.answerDrafts, new Set([promptId]))
      })
    }
  }

  /**
   * Update the input box draft for a prompt answer.
   * @param promptId - the id of the pending prompt.
   * @param value - the current text in the input box.
   */
  setAnswerDraft(promptId: string, value: string): void {
    this.store.update((draft) => {
      draft.oauth.answerDrafts[promptId] = value
    })
  }

  /**
   * Cancel an in-flight attempt.
   * @param routeId - the route id this attempt belongs to.
   */
  async cancelLogin(routeId: string): Promise<void> {
    const attemptId = this.store.getSnapshot().oauth.attempts[routeId]?.id
    if (attemptId === undefined) return
    await this.wire.llmPlusAuth.cancelAttempt(attemptId)
  }

  // -------------------------------------------------------------------------
  // "My routes" management area (reads the effective llm-plus namespace of settings, writes through mutate path ops)
  // -------------------------------------------------------------------------

  /** Read the current route table (at mount + after every write). */
  async loadMyRoutes(): Promise<void> {
    const described = await this.wire.settings.describe()
    if (!described.ok) return
    // describe's namespace view: find the effective llm-plus value (base←user already merged)
    const view = described.value.namespaces.find((ns: { ns: string }) => ns.ns === 'llm-plus')
    const value = (view as { value?: { routes?: Record<string, RouteConfig> } } | undefined)?.value
    this.store.update((draft) => {
      draft.myRoutes.routes = value?.routes ?? {}
    })
  }

  /**
   * Enter editing for one route (the draft is built from the current configuration).
   * @param routeId - the route id to edit.
   */
  startEditRoute(routeId: string): void {
    const route = this.store.getSnapshot().myRoutes.routes[routeId]
    if (route === undefined) return
    this.store.update((draft) => {
      draft.myRoutes.editing = { routeId, draft: routeToDraft(route) }
      draft.myRoutes.failure = null
    })
  }

  /**
   * Update individual fields of the edit draft.
   * @param patch - draft fields to overwrite.
   */
  patchEditDraft(patch: Partial<RouteDraft>): void {
    this.store.update((draft) => {
      const current = draft.myRoutes.editing
      if (current !== undefined) draft.myRoutes.editing = { ...current, draft: { ...current.draft, ...patch } }
    })
  }

  /** Cancel editing. */
  cancelEditRoute(): void {
    this.store.update((draft) => {
      draft.myRoutes.editing = undefined
    })
  }

  /** Save the edit: materialize the draft + carry non-edit-surface fields back from the original route as-is,
   * write back through mutate set. */
  async saveEditRoute(): Promise<void> {
    const editing = this.store.getSnapshot().myRoutes.editing
    if (editing === undefined) return
    const failure = routeDraftError(editing.draft)
    if (failure !== undefined) {
      this.store.update((draft) => {
        draft.myRoutes.failure = failure
      })
      return
    }
    const original = this.store.getSnapshot().myRoutes.routes[editing.routeId]
    // Non-edit-surface fields (modelsDevProvider/models/retryPolicy/requestImagePolicy) carried back as-is
    const next: Record<string, unknown> = {
      ...(original?.modelsDevProvider === undefined ? {} : { modelsDevProvider: original.modelsDevProvider }),
      ...(original?.models === undefined || original.models.length === 0 ? {} : { models: original.models }),
      ...(original?.retryPolicy === undefined ? {} : { retryPolicy: original.retryPolicy }),
      ...(original?.requestImagePolicy == null ? {} : { requestImagePolicy: original.requestImagePolicy }),
      ...draftToRoute(editing.draft),
    }
    const response = await this.wire.settings.mutate('llm-plus', [{ op: 'set', path: ['routes', editing.routeId], value: next as never }], undefined)
    this.store.update((draft) => {
      if (response.ok) {
        draft.myRoutes.editing = undefined
        draft.myRoutes.failure = null
      } else {
        draft.myRoutes.failure = response.error.message
      }
    })
    if (response.ok) await this.loadMyRoutes()
  }

  /**
   * Delete a route (mutate unset).
   * @param routeId - the route id to delete.
   */
  async deleteRoute(routeId: string): Promise<void> {
    const response = await this.wire.settings.mutate('llm-plus', [{ op: 'unset', path: ['routes', routeId] }], undefined)
    this.store.update((draft) => {
      draft.myRoutes.failure = response.ok ? null : response.error.message
    })
    if (response.ok) await this.loadMyRoutes()
  }

  /**
   * Materialize submit: every draft passes local validation first (one invalid draft blocks the whole write),
   * all routes are written in one mutate, then one-time secrets are written one by one. On success, clear the
   * added drafts and record the receipt.
   */
  async submit(): Promise<void> {
    const snapshot = this.store.getSnapshot()
    if (snapshot.submitting) return
    const entries = Object.entries(snapshot.drafts)
    if (entries.length === 0) return
    this.store.update((draft) => {
      draft.submitting = true
      draft.submitError = null
      draft.addedRoutes = []
    })
    const fail = (failure: SubmitFailure): void => {
      this.store.update((draft) => {
        draft.submitting = false
        draft.submitError = failure
      })
    }
    // Local validation: protocol is required and JSON fields must be valid (one invalid field blocks the whole write)
    for (const [id, draft] of entries) {
      const error = draftError(draft)
      if (error === 'protocol') {
        fail({ kind: 'protocol', provider: id })
        return
      }
      if (error === 'headers' || error === 'body') {
        fail({ kind: 'invalidJson', field: error, provider: id })
        return
      }
    }
    const ops: SettingsPathOpView[] = entries.map(([id, draft]) => {
      const loaded = snapshot.models[id]
      return {
        op: 'set',
        path: ['routes', draft.routeId.trim() === '' ? id : draft.routeId.trim()],
        value: materializeRoute(id, draft, loaded === undefined || loaded === 'loading' ? [] : loaded),
      }
    })
    // expectedRevision is not passed (this page does not track the llm-plus namespace revision;
    // the host's settings/conflict covers conflict semantics, and v1 does not implement optimistic locking)
    const response = await this.wire.settings.mutate('llm-plus', ops, undefined)
    if (!response.ok) {
      fail(response.error.code === 'settings/conflict' ? { kind: 'conflict' } : { kind: 'message', message: response.error.message })
      return
    }
    // One-time secrets: write to the credentials service one by one (secrets never go through settings and are not persisted on this page)
    for (const [, draft] of entries) {
      const ref = draft.apiKeyRef.trim()
      const key = draft.apiKey.trim()
      if (ref === '' || key === '') continue
      const stored = await this.wire.credentials.set(ref, key)
      if (!stored.ok) {
        fail({ kind: 'message', message: stored.error.message })
        return
      }
    }
    const added = ops.flatMap(op => op.path[1] === undefined ? [] : [op.path[1]])
    this.store.update((draft) => {
      draft.submitting = false
      draft.addedRoutes = added
      // Clear all submitted drafts (entries is the pre-submit snapshot, including any changed routeId)
      draft.drafts = omitKeys(draft.drafts, new Set(entries.map(([id]) => id)))
    })
    // The materialized routes enter the "my routes" management area
    await this.loadMyRoutes()
  }
}
