/**
 * The ledger's own block: the three `jira-service` row fields and what the service reports.
 *
 * The values are the effective row configuration; the editable form lives in the settings block
 * beside this one, because a status read and a staged edit have different lifetimes.
 *
 * @module @deepseek-ai/dsh-client-ui-jira/LedgerStatus
 */

import type { JiraStatusView } from '@deepseek-ai/dsh-jira-service/types'
import { fill, type JiraKey } from './locales.ts'
import styles from './JiraSection.module.css'

/** What the block renders. */
export interface LedgerStatusProps {
  /** The status the host answered, or `null` before the first read. */
  status: JiraStatusView | null
  /** Why the status could not be read. */
  error: string | null
  /** This page's copy. */
  t: (key: JiraKey) => string
}

/** The copy for the last push attempt. */
function lastSyncText(status: JiraStatusView, t: (key: JiraKey) => string): string {
  const record = status.lastSync
  if (record === null) return t('lastSyncNever')
  return record.outcome === 'ok'
    ? fill(t('lastSyncOk'), { at: record.at })
    : fill(t('lastSyncFailed'), { at: record.at, message: record.error ?? '' })
}

/** One label/value row. */
function Row(props: { label: string; value: string; mono?: boolean }) {
  return (
    <div className={styles.row}>
      <dt className={styles.rowLabel}>{props.label}</dt>
      <dd className={props.mono === true ? `${styles.rowValue} ${styles.mono}` : styles.rowValue}>{props.value}</dd>
    </div>
  )
}

/** The ledger status block. */
export function LedgerStatus({ status, error, t }: LedgerStatusProps) {
  return (
    <section className={styles.block}>
      <h3 className={styles.heading}>{t('statusTitle')}</h3>
      {error === null ? null : (
        <p className={styles.errorText} role="alert">{fill(t('statusFailed'), { message: error })}</p>
      )}
      {status === null ? null : (
        <>
          <dl className={styles.rows}>
            <Row label={t('fieldRoot')} value={status.root === '' ? t('detailNone') : status.root} mono />
            <Row label={t('fieldHost')} value={status.host === '' ? t('hostDefault') : status.host} />
            <Row label={t('fieldPush')} value={status.pushEnabled ? t('stateOn') : t('stateOff')} />
            <Row label={t('lastSync')} value={lastSyncText(status, t)} />
            <Row
              label={t('fieldPending')}
              value={status.pending ? t('pendingArmed') : t('pendingIdle')}
            />
          </dl>
        </>
      )}
    </section>
  )
}
