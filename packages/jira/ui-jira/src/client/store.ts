/**
 * The jira page's view state: one board, the selected issue, and the knowledge search.
 *
 * The page holds no ledger truth of its own. Every fact comes from `remote.jira`, which reads the
 * same service the agent's tools write, so a read after a write cannot disagree with it. The
 * controller publishes plain data and structured failures; the components map failures to copy.
 *
 * A change-stream item (a tool, another session or a sync committed) refreshes the board, the
 * status and the open detail. Reads carry a generation: a response that arrives after a newer read
 * started is dropped instead of replacing fresher state, and the item's monotonic `version`
 * drops a delayed frame that is already behind. Knowledge hits are a snapshot of one query:
 * a change marks them stale and leaves them visible, and the next search replaces them.
 *
 * @module @deepseek-ai/dsh-client-ui-jira/store
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  JiraChangeEvent,
  JiraBoardView,
  JiraIssueDetailView,
  JiraKbSearchView,
  JiraStatusView,
} from '@deepseek-ai/dsh-jira-service/types'

/** The Remote methods this page calls; the generated `remote.jira` namespace satisfies it. */
export interface JiraWire {
  /** The ledger's root, audit host, identity and push state. */
  status(): Promise<RemoteResult<JiraStatusView>>
  /** Every issue, grouped by status. */
  board(): Promise<RemoteResult<JiraBoardView>>
  /** One issue's frontmatter and body. */
  get(key: string): Promise<RemoteResult<JiraIssueDetailView>>
  /** Ranked knowledge hits for one query. */
  kbSearch(query: string, topK?: number): Promise<RemoteResult<JiraKbSearchView>>
}

/** The board's load state. */
export interface JiraBoardState {
  /** Whether a board read is pending, settled or failed. */
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** The failure report, when the read failed. */
  error: string | null
  /** The board the host answered. */
  view: JiraBoardView | null
}

/** The selected issue's load state. */
export interface JiraDetailState {
  /** The issue key the detail panel shows. */
  key: string
  /** Whether the issue read is pending, settled or failed. */
  status: 'loading' | 'ready' | 'error'
  /** The failure report, when the read failed. */
  error: string | null
  /** The issue the host answered. */
  view: JiraIssueDetailView | null
}

/** The knowledge search's state. */
export interface JiraKnowledgeState {
  /** The query as typed. */
  query: string
  /** Whether a search is pending, settled or failed. */
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** The failure report, when the search failed. */
  error: string | null
  /** The hits the host answered. */
  view: JiraKbSearchView | null
  /** True when the ledger changed after these hits were read; the next search replaces them. */
  stale: boolean
}

/**
 * The page's snapshot.
 *
 * The fields are deliberately mutable: this type is also the store's draft type, which the update
 * callback edits in place. A reader treats the published snapshot as read-only.
 */
export interface JiraState {
  /** The ledger status, once read. */
  statusView: JiraStatusView | null
  /** Why the status could not be read. */
  statusError: string | null
  /** The board. */
  board: JiraBoardState
  /** The issue the reader opened; absent until one is selected. */
  detail: JiraDetailState | null
  /** The knowledge search. */
  knowledge: JiraKnowledgeState
}

/** One Remote read folded into the page's failure shape. */
type Read<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string }

/** The snapshot a page starts from. */
const initialState = (): JiraState => ({
  statusView: null,
  statusError: null,
  board: { status: 'idle', error: null, view: null },
  detail: null,
  knowledge: { query: '', status: 'idle', error: null, view: null, stale: false },
})

/**
 * Read one Remote answer, folding its failure branch and an assembly rejection into one shape.
 * @param call - the Remote call.
 * @returns the value, or the message to show.
 */
async function read<T>(call: () => Promise<RemoteResult<T>>): Promise<Read<T>> {
  try {
    const answer = await call()
    return answer.ok ? { ok: true, value: answer.value } : { ok: false, error: answer.error.message }
  } catch (error) {
    // Only assembly faults reject (a namespace that is not mounted, a closed connection); the
    // page reports them like any other read failure.
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** The jira page's controller: loads the ledger, selects an issue, runs the knowledge search. */
export class JiraStore {
  /** The snapshot source the renderer binds as `useSnapshot`. */
  readonly store: SnapshotStore<JiraState> = createSnapshotStore(initialState())

  /** The newest board/status read; an older answer is stale. */
  private boardRead = 0
  /** The newest detail read; an older answer is stale. */
  private detailRead = 0
  /** The newest knowledge search; an older answer is stale. */
  private knowledgeRead = 0
  /** Counts applied changes, so a search that straddled one can mark its hits stale. */
  private changeSerial = 0
  /** The newest notice applied; a delayed one below it is already superseded. */
  private lastVersion = 0
  /** True once the page has asked for ledger data; an unopened page holds nothing to refresh. */
  private activated = false

  /**
   * @param wire - the Remote methods this page reads.
   */
  constructor(private readonly wire: JiraWire) {}

  /**
   * Read the board, then the status.
   *
   * The order matters: the service resolves this machine's identity and audit host when it first
   * opens the ledger, so the status read that follows the board reports the resolved values
   * instead of the pre-open placeholder.
   * @returns when the state is published, or when a newer read has taken over.
   */
  async load(): Promise<void> {
    this.activated = true
    const generation = ++this.boardRead
    this.store.update((draft) => {
      draft.board.status = 'loading'
      draft.board.error = null
    })
    const board = await read(() => this.wire.board())
    const status = await read(() => this.wire.status())
    // A change (or a retry) started another load while these were in flight: that one owns the
    // state, and this answer is older than the truth it would replace.
    if (generation !== this.boardRead) return
    this.store.update((draft) => {
      if (board.ok) {
        draft.board.status = 'ready'
        draft.board.view = board.value
        draft.board.error = null
      } else {
        draft.board.status = 'error'
        draft.board.error = board.error
      }
      draft.statusView = status.ok ? status.value : null
      draft.statusError = status.ok ? null : status.error
    })
  }

  /**
   * Open one issue's detail.
   * @param key - the issue key the reader selected.
   */
  async select(key: string): Promise<void> {
    const current = this.store.getSnapshot().detail
    if (current?.key === key && current.status === 'loading') return
    await this.readDetail(key)
  }

  /**
   * Re-read one issue's detail, superseding whatever read was in flight.
   * @param key - the issue key to read.
   */
  private async readDetail(key: string): Promise<void> {
    this.activated = true
    const generation = ++this.detailRead
    this.store.update((draft) => {
      draft.detail = { key, status: 'loading', error: null, view: null }
    })
    const issue = await read(() => this.wire.get(key))
    if (generation !== this.detailRead) return
    this.store.update((draft) => {
      // A slower answer for an issue the reader already left must not replace what is shown.
      if (draft.detail?.key !== key) return
      draft.detail = issue.ok
        ? { key, status: 'ready', error: null, view: issue.value }
        : { key, status: 'error', error: issue.error, view: null }
    })
  }

  /**
   * Apply one Host change notice: refresh what the page shows, oldest notice first.
   * @param change - the notice the Host stream delivered.
   */
  changed(change: JiraChangeEvent): void {
    // Events are ordered on the wire; a delayed frame that is behind one already applied is
    // ignored instead of refreshing past the newer state.
    if (change.version <= this.lastVersion) return
    this.lastVersion = change.version
    this.refresh()
  }

  /**
   * Catch up after a reconnect. A remounted Host restarts its version at 1, so the next notice is
   * not comparable with the last one seen before the reset; re-read instead.
   */
  reconnected(): void {
    this.lastVersion = 0
    this.refresh()
  }

  /** Re-read the board, the status and the open detail; knowledge hits become stale. */
  private refresh(): void {
    this.changeSerial += 1
    // A page that was never opened holds no snapshot: the first `load()` reads the ledger fresh.
    if (!this.activated) return
    void this.load()
    const detail = this.store.getSnapshot().detail
    if (detail !== null) void this.readDetail(detail.key)
    this.store.update((draft) => {
      // A search in flight records the same signal when it settles, so hits read across a change
      // are marked stale too.
      if (draft.knowledge.status === 'ready' || draft.knowledge.status === 'error') draft.knowledge.stale = true
    })
  }

  /** Close the detail panel. */
  closeDetail(): void {
    this.store.update((draft) => {
      draft.detail = null
    })
  }

  /**
   * Record the query as typed, without searching.
   * @param query - the search box's current text.
   */
  setQuery(query: string): void {
    this.store.update((draft) => {
      draft.knowledge.query = query
    })
  }

  /** Search the knowledge base for the recorded query; a blank query clears the results. */
  async search(): Promise<void> {
    const query = this.store.getSnapshot().knowledge.query.trim()
    if (query === '') {
      this.knowledgeRead += 1
      this.store.update((draft) => {
        draft.knowledge = { query: draft.knowledge.query, status: 'idle', error: null, view: null, stale: false }
      })
      return
    }
    const generation = ++this.knowledgeRead
    const serial = this.changeSerial
    this.store.update((draft) => {
      draft.knowledge.status = 'loading'
      draft.knowledge.error = null
    })
    const found = await read(() => this.wire.kbSearch(query))
    this.store.update((draft) => {
      // The reader may have started another search while this one was in flight.
      if (generation !== this.knowledgeRead || draft.knowledge.query.trim() !== query) return
      // A change landed while this search was running: the hits may already be behind the ledger.
      const stale = serial !== this.changeSerial
      if (found.ok) {
        draft.knowledge = { query: draft.knowledge.query, status: 'ready', error: null, view: found.value, stale }
      } else {
        draft.knowledge = { query: draft.knowledge.query, status: 'error', error: found.error, view: null, stale }
      }
    })
  }
}
