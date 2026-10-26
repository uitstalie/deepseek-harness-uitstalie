/**
 * The ledger row's editable block: root path, audit host and the push switch.
 *
 * The two text fields stage edits and write them in one save; the switch writes immediately, so
 * it never shows a state the row has not accepted. The block renders nothing when the Host does
 * not serve the row's volatile form, which keeps a deployment without the jira-service row silent.
 *
 * @module @deepseek-ai/dsh-client-ui-jira/LedgerSettings
 */

import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { JiraKey } from './locales.ts'
import type { JiraLedgerSettingsState } from './ledger-settings.ts'
import styles from './JiraSection.module.css'

/** What the block renders. */
export interface LedgerSettingsProps {
  /** The staged form state. */
  state: JiraLedgerSettingsState
  /** This page's copy. */
  t: (key: JiraKey) => string
  /** Stage one text field. */
  onEdit: (field: 'root' | 'host', text: string) => void
  /** Write both staged text fields. */
  onSave: () => void
  /** Throw the staged text away. */
  onDiscard: () => void
  /** Write the push switch. */
  onTogglePush: (enabled: boolean) => void
}

/** The ledger settings block. */
export function LedgerSettings({ state, t, onEdit, onSave, onDiscard, onTogglePush }: LedgerSettingsProps) {
  if (!state.available) return null
  const disabled = !state.writable
  return (
    <section className={styles.block}>
      <h3 className={styles.heading}>{t('settingsTitle')}</h3>
      <p className={styles.note}>{t('settingsIntro')}</p>
      <div className={styles.fields}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>{t('settingsRoot')}</span>
          <input
            className={styles.input}
            value={state.root}
            placeholder={t('settingsRootPlaceholder')}
            disabled={disabled || state.saving}
            onChange={(event) => { onEdit('root', event.target.value) }}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>{t('settingsHost')}</span>
          <input
            className={styles.input}
            value={state.host}
            placeholder={t('settingsHostPlaceholder')}
            disabled={disabled || state.saving}
            onChange={(event) => { onEdit('host', event.target.value) }}
          />
        </label>
      </div>
      <div className={styles.actions}>
        <Button
          variant="primary"
          size="sm"
          disabled={!state.dirty || state.saving || disabled}
          onClick={onSave}
        >
          {state.saving ? t('settingsSaving') : t('settingsSave')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!state.dirty || state.saving}
          onClick={onDiscard}
        >
          {t('settingsDiscard')}
        </Button>
      </div>
      {state.failed ? <p className={styles.errorText} role="alert">{t('settingsSaveFailed')}</p> : null}
      <div className={styles.switchRow}>
        <div className={styles.switchCopy}>
          <span className={styles.fieldLabel}>{t('settingsPush')}</span>
          <p className={styles.note}>{t('settingsPushHint')}</p>
        </div>
        <Switch
          checked={state.pushEnabled}
          disabled={disabled || state.pushSaving}
          label={t('settingsPush')}
          onChange={onTogglePush}
        />
      </div>
      {state.pushFailed ? <p className={styles.errorText} role="alert">{t('settingsPushFailed')}</p> : null}
    </section>
  )
}
