/**
 * The jira page's view state: one board, the selected issue, and the knowledge search.
 *
 * The page holds no ledger truth of its own. Every fact comes from `remote.jira`, which reads the
 * same service the agent's tools write, so a read after a write cannot disagree with it. The
 * controller publishes plain data and structured failures; the components map failures to copy.
 *
 * @module @deepseek-ai/dsh-client-ui-jira/store
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
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
  knowledge: { query: '', status: 'idle', error: null, view: null },
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
   */
  async load(): Promise<void> {
    this.store.update((draft) => {
      draft.board.status = 'loading'
      draft.board.error = null
    })
    const board = await read(() => this.wire.board())
    const status = await read(() => this.wire.status())
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
    this.store.update((draft) => {
      draft.detail = { key, status: 'loading', error: null, view: null }
    })
    const issue = await read(() => this.wire.get(key))
    this.store.update((draft) => {
      // A slower answer for an issue the reader already left must not replace what is shown.
      if (draft.detail?.key !== key) return
      draft.detail = issue.ok
        ? { key, status: 'ready', error: null, view: issue.value }
        : { key, status: 'error', error: issue.error, view: null }
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
      this.store.update((draft) => {
        draft.knowledge = { query: draft.knowledge.query, status: 'idle', error: null, view: null }
      })
      return
    }
    this.store.update((draft) => {
      draft.knowledge.status = 'loading'
      draft.knowledge.error = null
    })
    const found = await read(() => this.wire.kbSearch(query))
    this.store.update((draft) => {
      // The reader may have started another search while this one was in flight.
      if (draft.knowledge.query.trim() !== query) return
      if (found.ok) {
        draft.knowledge.status = 'ready'
        draft.knowledge.view = found.value
        draft.knowledge.error = null
      } else {
        draft.knowledge.status = 'error'
        draft.knowledge.error = found.error
      }
    })
  }
}
