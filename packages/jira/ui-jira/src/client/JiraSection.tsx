/**
 * The jira settings page: the editable ledger row, the read-only board, one issue's detail, and
 * the knowledge search. The row fields are the page's only writes; the ledger itself stays
 * read-only here and is written through the agent tools.
 *
 * The component is presentation only: every fact arrives through the inject face, every action
 * calls the controller, and every sentence comes from the `settings.jira` dictionary.
 *
 * @module @deepseek-ai/dsh-client-ui-jira/JiraSection
 */

import { useEffect } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import { IssueDetail } from './IssueDetail.tsx'
import { LedgerSettings } from './LedgerSettings.tsx'
import type { JiraLedgerSettingsController, JiraLedgerSettingsState } from './ledger-settings.ts'
import { JiraBoard } from './JiraBoard.tsx'
import { KnowledgeSearch } from './KnowledgeSearch.tsx'
import { LedgerStatus } from './LedgerStatus.tsx'
import type { JiraKey } from './locales.ts'
import type { JiraState, JiraStore } from './store.ts'
import styles from './JiraSection.module.css'

/** What the registration injects into the page. */
export interface JiraSectionInjected {
  /** The page controller (load, select, close, search). */
  controller: JiraStore
  /** Start the first read; a mounted-but-unopened page does not touch the host. */
  activate: () => void
  /** The editable `jira-service` row fields. */
  ledgerSettings: {
    controller: JiraLedgerSettingsController
    store: SnapshotStore<JiraLedgerSettingsState>
  }
  hooks: {
    /** The page snapshot, bound by the renderer as `useSnapshot`. */
    snapshot: SnapshotStore<JiraState>
    /** The ledger settings snapshot, bound by the renderer as `useLedgerSettings`. */
    ledgerSettings: SnapshotStore<JiraLedgerSettingsState>
  }
  /** This page's copy (`settings.jira`). */
  t: (key: JiraKey) => string
}

/** The page's props: the inject face, flattened, so a test may supply a subset. */
export type JiraSectionProps = Partial<InjectFace<JiraSectionInjected>>

/** The jira settings page. */
export function JiraSection(props: JiraSectionProps) {
  const { controller, useSnapshot, t, activate, ledgerSettings, useLedgerSettings } = props
  useEffect(() => { activate?.() }, [activate])
  const settingsState = useLedgerSettings === undefined
    ? undefined
    : useLedgerSettings(snapshot => snapshot)
  // The assembly guarantees the page face; the partial props are the test path that supplies it.
  if (controller === undefined || useSnapshot === undefined || t === undefined) return null
  const state = useSnapshot(snapshot => snapshot)

  return (
    <div className={styles.section}>
      <h2 className={styles.title}>{t('title')}</h2>
      <p className={styles.intro}>{t('intro')}</p>
      <LedgerStatus status={state.statusView} error={state.statusError} t={t} />
      {ledgerSettings === undefined || settingsState === undefined
        ? null
        : (
          <LedgerSettings
            state={settingsState}
            t={t}
            onEdit={(field, text) => { ledgerSettings.controller.edit(field, text) }}
            onSave={() => { void ledgerSettings.controller.save() }}
            onDiscard={() => { ledgerSettings.controller.discard() }}
            onTogglePush={(enabled) => { void ledgerSettings.controller.setPush(enabled) }}
          />
        )}
      <JiraBoard
        board={state.board}
        t={t}
        onSelect={(key) => { void controller.select(key) }}
        onRetry={() => { void controller.load() }}
      />
      {state.detail === null
        ? null
        : (
          <IssueDetail
            detail={state.detail}
            t={t}
            onClose={() => { controller.closeDetail() }}
          />
        )}
      <KnowledgeSearch
        knowledge={state.knowledge}
        t={t}
        onChange={(query) => { controller.setQuery(query) }}
        onSearch={() => { void controller.search() }}
      />
    </div>
  )
}
