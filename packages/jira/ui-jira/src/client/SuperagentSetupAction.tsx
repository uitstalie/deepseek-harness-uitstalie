/**
 * The sidebar's Super agent entry: choose a directory, then let the host create and register the
 * super workspace there.
 *
 * The button owns no state beyond its own click: the host validates the path, creates the
 * directory, registers and pins the workspace, and persists the choice on the jira-agent row. The
 * label reports the outcome in place, because a sidebar action has no page to open.
 *
 * @module @deepseek-ai/dsh-client-ui-jira/SuperagentSetupAction
 */

import { useState } from 'react'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { JiraSectionInjected } from './JiraSection.tsx'
import styles from './SuperagentSetupAction.module.css'

/** What the sidebar entry needs from the client plugin. */
export interface SuperagentSetupInjected {
  /** Copy binder for this package's dictionary. */
  readonly t: JiraSectionInjected['t']
  /** Open the host's directory chooser; null means the person cancelled. */
  readonly pickDirectory: () => Promise<string | null>
  /** Ask the host to create and register the super workspace at one directory. */
  readonly setup: (path: string) => Promise<void>
}

/** The button's props: the injected face plus the sidebar's width flag. */
export type SuperagentSetupActionProps =
  Partial<InjectFace<SuperagentSetupInjected>> & { readonly wide?: boolean }

/**
 * Render the setup entry, and run the pick → create flow on click.
 * @param props - injected face and width flag.
 * @returns the footer action, or null while the injected face is incomplete.
 */
export function SuperagentSetupAction({ t, pickDirectory, setup, wide }: SuperagentSetupActionProps) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | undefined>(undefined)
  if (t === undefined || pickDirectory === undefined || setup === undefined) return null
  const run = async (): Promise<void> => {
    setBusy(true)
    setNote(undefined)
    try {
      const picked = await pickDirectory()
      if (picked === null) return
      await setup(picked)
      setNote(t('superagentSetupDone'))
    } catch (error: unknown) {
      setNote(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <button
      type="button"
      className={styles.action}
      onClick={() => { void run() }}
      disabled={busy}
      title={note ?? t('superagentSetupAction')}
    >
      <span className={styles.mark} aria-hidden>◆</span>
      {wide ? (
        <span className={styles.label}>
          {busy ? t('superagentSetupBusy') : t('superagentSetupAction')}
        </span>
      ) : null}
      {wide && note !== undefined ? <span className={styles.note}>{note}</span> : null}
    </button>
  )
}
