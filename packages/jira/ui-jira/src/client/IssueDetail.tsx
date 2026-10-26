/**
 * One issue's detail: its frontmatter fields and the Markdown body, read-only.
 *
 * @module @deepseek-ai/dsh-client-ui-jira/IssueDetail
 */

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { JiraIssueDetailView } from '@deepseek-ai/dsh-jira-service/types'
import { fill, type JiraKey } from './locales.ts'
import type { JiraDetailState } from './store.ts'
import styles from './JiraSection.module.css'

/** What the detail panel renders. */
export interface IssueDetailProps {
  /** The selected issue's load state. */
  detail: JiraDetailState
  /** This page's copy. */
  t: (key: JiraKey) => string
  /** Close the panel. */
  onClose: () => void
}

/** One label/value pair, skipped when the issue does not carry the field. */
function Field(props: { label: string; value: string | undefined }) {
  return props.value === undefined ? null : (
    <div className={styles.row}>
      <dt className={styles.rowLabel}>{props.label}</dt>
      <dd className={styles.rowValue}>{props.value}</dd>
    </div>
  )
}

/** The detail panel. */
export function IssueDetail({ detail, t, onClose }: IssueDetailProps) {
  return (
    <section className={styles.block}>
      <div className={styles.detailHead}>
        <h3 className={styles.heading}>{fill(t('detailTitle'), { key: detail.key })}</h3>
        <Button variant="ghost" size="sm" onClick={onClose}>{t('detailClose')}</Button>
      </div>
      {detail.status === 'loading' ? <p className={styles.notice}>{t('detailLoading')}</p> : null}
      {detail.status === 'error'
        ? <p className={styles.errorText} role="alert">{fill(t('detailFailed'), { message: detail.error ?? '' })}</p>
        : null}
      {detail.status === 'ready' && detail.view !== null ? <DetailContent view={detail.view} t={t} /> : null}
    </section>
  )
}

/** A settled issue's fields and body. */
function DetailContent(props: { view: JiraIssueDetailView; t: (key: JiraKey) => string }) {
  const { view, t } = props
  const links = view.links.map(link => `${link.type} → ${link.target}`).join(', ')
  return (
    <>
      <p className={styles.detailSummary}>{view.summary}</p>
      <dl className={styles.rows}>
        <Field label={t('detailStatus')} value={view.status} />
        <Field label={t('detailPriority')} value={view.priority} />
        <Field label={t('detailType')} value={view.issueType} />
        <Field label={t('detailAssignee')} value={view.assignee ?? t('unassigned')} />
        <Field label={t('detailReporter')} value={view.reporter} />
        <Field label={t('detailTags')} value={view.tags.length === 0 ? t('detailNone') : view.tags.join(', ')} />
        <Field label={t('detailLinks')} value={view.links.length === 0 ? t('detailNone') : links} />
        <Field label={t('detailKnowledge')} value={view.kbRefs.length === 0 ? t('detailNone') : view.kbRefs.join(', ')} />
        <Field label={t('detailResolution')} value={view.resolution} />
        <Field label={t('detailNote')} value={view.note} />
        <Field label={t('detailCreated')} value={view.createdAt} />
        <Field label={t('detailUpdated')} value={view.updatedAt} />
        <Field label={t('detailRevision')} value={String(view.revision)} />
      </dl>
      <h4 className={styles.columnTitle}>{t('detailBody')}</h4>
      <p className={styles.bodyText}>{view.body}</p>
    </>
  )
}
