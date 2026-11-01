/**
 * The super-agent summary on the jira settings page: how many issues are ready, in progress, waiting
 * for review or blocked, and which review issues need a person.
 *
 * This is the first read-only slice of the super-agent panel. It reads the board the page already
 * fetched instead of adding a second Host read; proposal comments and the full trigger/history
 * pages come with the dedicated panel (DH-601).
 *
 * @module @deepseek-ai/dsh-client-ui-jira/SuperagentPanel
 */

import type { JiraBoardView, JiraIssueRowView } from '@deepseek-ai/dsh-jira-service/types'
import { fill } from './locales.ts'
import type { JiraKey } from './locales.ts'
import styles from './JiraSection.module.css'

/** The panel's props. */
export interface SuperagentPanelProps {
  /** The board the page already read; absent while it loads. */
  readonly board: JiraBoardView | null
  /** This page's copy. */
  readonly t: (key: JiraKey) => string
}

/** Rows of one status across projects, or the blocked group when no status is given. */
const rowsOf = (board: JiraBoardView, status: string | undefined): readonly JiraIssueRowView[] =>
  board.groups
    .filter(group => status === undefined ? group.kind === 'blocked' : group.kind === 'status' && group.status === status)
    .flatMap(group => group.items)

/** The super-agent summary block. */
export function SuperagentPanel({ board, t }: SuperagentPanelProps) {
  if (board === null) return null
  const ready = rowsOf(board, 'todo')
  const inProgress = rowsOf(board, 'in_progress')
  const inReview = rowsOf(board, 'in_review')
  const blocked = rowsOf(board, undefined)
  const counts = [
    ['superagentReady', ready.length],
    ['superagentInProgress', inProgress.length],
    ['superagentReview', inReview.length],
    ['superagentBlocked', blocked.length],
  ] as const

  return (
    <section className={styles.superagent}>
      <h3 className={styles.superagentTitle}>{t('superagentTitle')}</h3>
      <p className={styles.superagentIntro}>{t('superagentIntro')}</p>
      <dl className={styles.superagentCounts}>
        {counts.map(([key, count]) => (
          <div className={styles.superagentCount} key={key}>
            <dt>{fill(t(key), { count: String(count) })}</dt>
          </div>
        ))}
      </dl>
      {inReview.length === 0
        ? null
        : (
          <div className={styles.superagentNeeds}>
            <h4 className={styles.superagentNeedsTitle}>{t('superagentNeedsYou')}</h4>
            <ul className={styles.superagentList}>
              {inReview.map(row => (
                <li key={row.key}>{fill(t('superagentReviewItem'), { key: row.key, summary: row.summary })}</li>
              ))}
            </ul>
          </div>
        )}
    </section>
  )
}
