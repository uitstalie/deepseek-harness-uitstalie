/**
 * The one line a model is told about the ledger: it exists here, and how big it is.
 *
 * This is **awareness, not an agenda**: a session is usually opened for a reason, so a list of
 * open issues would be noise; what an agent needs to know is that a ledger exists, where it is,
 * and whether it may write. The line names the store and its counts and nothing else.
 *
 * The text is a prompt section rather than a dynamic context source because that is the
 * contribution `dafeiyu` wires onto a root agent. It is kept out of the request until the
 * capability is enabled, and it is refreshed when the ledger commits — `changed` is the single
 * refresh source the contract names, so there is no file watch and no polling. An empty ledger
 * still says nothing at all, exactly like the line it replaces.
 *
 * @module @deepseek-ai/dsh-jira-agent/awareness
 */

import { basename } from 'node:path'
import { countStore, injectionLine } from '@deepseek-ai/dsh-jira-core/injection.ts'
import type { JiraServiceApi } from '@deepseek-ai/dsh-jira-service'
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'

/** Registry name of the jira awareness section. */
export const JIRA_AWARENESS_SECTION_NAME = 'jira:store'

/**
 * Section order: after the plan and team policy sections (500/600) and before the PTC rule
 * (800) — orientation before instruction, and never inside the tool sections it describes.
 */
export const JIRA_AWARENESS_ORDER = 700

/** What the awareness line needs from the ledger service. */
export type AwarenessSource = Pick<JiraServiceApi, 'on' | 'store'>

/** The registered section plus the bookkeeping that keeps its text current. */
export interface StoreAwareness {
  /** The prompt section to contribute to a root agent. */
  readonly section: PromptSection
  /**
   * Re-read the ledger and replace the cached line.
   * @returns a promise that settles once this read (or the read already in flight) finished.
   */
  refresh(): Promise<void>
  /** Stop listening for ledger changes. */
  dispose(): void
}

/**
 * Build the awareness section around one ledger service.
 * @param jira - the ledger service the line describes.
 * @returns the section, its refresher and its unsubscribe handle.
 */
export const createStoreAwareness = (jira: AwarenessSource): StoreAwareness => {
  let text = ''
  let running: Promise<void> | undefined
  /** Monotonic request counter: a refresh asked for while one runs is served by the same loop. */
  let requested = 0
  let completed = 0

  /**
   * Compute the line once. A read failure clears it: the ledger is either unusable or absent, and
   * a stale count would describe a store the reader cannot reach.
   */
  const recompute = async (): Promise<void> => {
    const opened = await jira.store()
    if (!opened.ok) {
      text = ''
      return
    }
    const counts = await countStore(opened.value)
    text = counts.ok
      ? injectionLine(counts.value, { storeLabel: basename(opened.value.files.root) })
      : ''
  }

  /**
   * Read the ledger now. A refresh requested while one is running is counted instead of starting
   * a second scan, so a burst of commits collapses into one extra read and the last state wins.
   */
  const refresh = (): Promise<void> => {
    requested += 1
    if (running !== undefined) return running
    const started = (async () => {
      try {
        while (completed < requested) {
          completed = requested
          await recompute()
        }
      } finally {
        running = undefined
      }
    })()
    running = started
    return started
  }

  const unsubscribe = jira.on('changed', () => {
    void refresh()
  })

  return Object.freeze({
    section: Object.freeze({
      name: JIRA_AWARENESS_SECTION_NAME,
      order: JIRA_AWARENESS_ORDER,
      text: () => text,
    }),
    refresh,
    dispose: unsubscribe,
  })
}
