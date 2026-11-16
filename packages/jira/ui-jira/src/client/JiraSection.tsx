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

/** The subset of store methods the page may call. */
export type JiraActions = Pick<JiraStore,
  | 'load'
  | 'select'
  | 'closeDetail'
  | 'setQuery'
  | 'search'
  | 'confirm'
  | 'loadMoreHistory'
  | 'loadMoreTriggers'
>

/** The subset of ledger-settings methods the block may call. */
export type LedgerSettingsActions = Pick<JiraLedgerSettingsController, 'edit' | 'save' | 'discard' | 'setPush'>

/** What the registration injects into the page. */
export interface JiraSectionInjected {
  /** The page actions (load, select, close, search), bound to the store. */
  actions: JiraActions
  /** Start the first read; a mounted-but-unopened page does not touch the host. */
  activate: () => void
  /** The editable `jira-service` row fields and their actions. */
  ledgerSettings: {
    actions: LedgerSettingsActions
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

/** A stable fallback for a deployment that does not serve the ledger-settings form. */
const noLedgerSettings = (): undefined => undefined

/** The jira settings page. */
export function JiraSection(props: JiraSectionProps) {
  const { actions, useSnapshot, t, activate, ledgerSettings, useLedgerSettings } = props
  // The assembly guarantees the page face; the partial props are the test path that supplies it.
  if (actions === undefined || useSnapshot === undefined || t === undefined) return null
  return (
    <JiraSectionBody
      actions={actions}
      useSnapshot={useSnapshot}
      t={t}
      activate={activate}
      ledgerSettings={ledgerSettings}
      useLedgerSettings={useLedgerSettings ?? noLedgerSettings}
    />
  )
}

/**
 * The page body, with every required inject value present.
 *
 * Kept separate so both hooks run unconditionally: the previous layout returned before
 * `useSnapshot` when a prop was missing, which changes the hook count if the props arrive later.
 * @param props - the page controller, its hooks, the editable settings block and the copy lookup.
 * @returns the settings page.
 */
function JiraSectionBody({
  actions,
  useSnapshot,
  t,
  activate,
  ledgerSettings,
  useLedgerSettings,
}: {
  actions: JiraActions
  useSnapshot: <T>(select: (state: JiraState) => T) => T
  t: (key: JiraKey) => string
  activate: (() => void) | undefined
  ledgerSettings: JiraSectionInjected['ledgerSettings'] | undefined
  useLedgerSettings: <T>(select: (state: JiraLedgerSettingsState) => T) => T | undefined
}) {
  useEffect(() => { activate?.() }, [activate])
  const settingsState = useLedgerSettings(snapshot => snapshot)
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
            onEdit={(field, text) => { ledgerSettings.actions.edit(field, text) }}
            onSave={() => { void ledgerSettings.actions.save() }}
            onDiscard={() => { ledgerSettings.actions.discard() }}
            onTogglePush={(enabled) => { void ledgerSettings.actions.setPush(enabled) }}
          />
        )}
      <JiraBoard
        board={state.board}
        t={t}
        onSelect={(key) => { void actions.select(key) }}
        onRetry={() => { void actions.load() }}
      />
      {state.detail === null
        ? null
        : (
          <IssueDetail
            detail={state.detail}
            t={t}
            onClose={() => { actions.closeDetail() }}
          />
        )}
      <KnowledgeSearch
        knowledge={state.knowledge}
        t={t}
        onChange={(query) => { actions.setQuery(query) }}
        onSearch={() => { void actions.search() }}
      />
    </div>
  )
}
