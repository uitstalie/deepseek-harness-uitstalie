/**
 * The dedicated super-agent page: the status, proposals and history, plus the one human action —
 * confirming a proposal so the dispatcher may claim it.
 *
 * @module @deepseek-ai/dsh-client-ui-jira/SuperagentSection
 */

import { useEffect } from 'react'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import { SuperagentPanel } from './SuperagentPanel.tsx'
import type { JiraSectionInjected } from './JiraSection.tsx'
import styles from './JiraSection.module.css'

/** The page's props: the jira inject face, flattened; tests may supply a subset. */
export type SuperagentSectionProps = Partial<InjectFace<JiraSectionInjected>>

/** The super-agent settings page. */
export function SuperagentSection(props: SuperagentSectionProps) {
  const { controller, useSnapshot, t, activate } = props
  useEffect(() => { activate?.() }, [activate])
  if (controller === undefined || useSnapshot === undefined || t === undefined) return null
  const state = useSnapshot(snapshot => snapshot)
  return (
    <div className={styles.section}>
      <h2 className={styles.title}>{t('superagentTitle')}</h2>
      <p className={styles.intro}>{t('superagentIntro')}</p>
      <SuperagentPanel
        board={state.board.view}
        status={state.superagent.view}
        history={state.superagentHistory.view}
        triggers={state.superagentTriggers.view}
        confirmState={state.superagentConfirm}
        t={t}
        onLoadMore={() => { void controller.loadMoreTriggers() }}
        onLoadMoreHistory={() => { void controller.loadMoreHistory() }}
        onSelect={(key) => { void controller.select(key) }}
        onConfirm={(key) => { void controller.confirm(key) }}
      />
    </div>
  )
}
