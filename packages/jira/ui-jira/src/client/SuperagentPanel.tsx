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

import { useState } from 'react'
import type { JiraBoardView, JiraIssueRowView, SuperagentHistoryView, SuperagentStatusView, SuperagentTriggersView } from '@deepseek-ai/dsh-jira-service/types'
import { fill } from './locales.ts'
import type { JiraKey } from './locales.ts'
import styles from './JiraSection.module.css'

/** The panel's props. */
export interface SuperagentPanelProps {
  /** The board the page already read; absent while it loads. */
  readonly board: JiraBoardView | null
  /** The Host's super-agent view; preferred over deriving counts from the board. */
  readonly status?: SuperagentStatusView | null
  /** Recent ledger commits, newest first. */
  readonly history?: SuperagentHistoryView | null
  /** Recent proposal comments, newest first. */
  readonly triggers?: SuperagentTriggersView | null
  /** Open an issue's detail when a row is chosen. */
  readonly onSelect?: (key: string) => void
  /** This page's copy. */
  readonly t: (key: JiraKey) => string
}

/** Rows of one status across projects, or the blocked group when no status is given. */
const rowsOf = (board: JiraBoardView, status: string | undefined): readonly JiraIssueRowView[] =>
  board.groups
    .filter(group => status === undefined ? group.kind === 'blocked' : group.kind === 'status' && group.status === status)
    .flatMap(group => group.items)

/** The super-agent summary block. */
export function SuperagentPanel({ board, status, history, triggers, onSelect, t }: SuperagentPanelProps) {
  const [query, setQuery] = useState('')
  const [activeOnly, setActiveOnly] = useState(false)
  if (board === null && status === undefined) return null
  let counts: readonly (readonly [JiraKey, number])[]
  let needs: readonly { key: string; summary: string }[]
  if (status !== undefined && status !== null) {
    counts = [
      ['superagentReady', status.counts.ready],
      ['superagentInProgress', status.counts.inProgress],
      ['superagentReview', status.counts.inReview],
      ['superagentBlocked', status.counts.blocked],
    ] as const
    needs = status.needsPerson
  } else if (board !== null) {
    counts = [
      ['superagentReady', rowsOf(board, 'todo').length],
      ['superagentInProgress', rowsOf(board, 'in_progress').length],
      ['superagentReview', rowsOf(board, 'in_review').length],
      ['superagentBlocked', rowsOf(board, undefined).length],
    ] as const
    needs = rowsOf(board, 'in_review')
  } else {
    return null
  }

  const triggerEntries = triggers?.entries ?? []
  const needle = query.trim().toLowerCase()
  const visibleTriggers = triggerEntries.filter((entry) => {
    if (activeOnly && !entry.active) return false
    if (needle === '') return true
    return [entry.key, entry.author, entry.summary, entry.body].some(value => value.toLowerCase().includes(needle))
  })

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
      {needs.length === 0
        ? null
        : (
          <div className={styles.superagentNeeds}>
            <h4 className={styles.superagentNeedsTitle}>{t('superagentNeedsYou')}</h4>
            <ul className={styles.superagentList}>
              {needs.map(row => (
                <li key={row.key}>
                  <button type="button" className={styles.superagentLink} onClick={() => onSelect?.(row.key)}>
                    {fill(t('superagentReviewItem'), { key: row.key, summary: row.summary })}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      {triggers === undefined || triggers === null || triggers.entries.length === 0
        ? null
        : (
          <div className={styles.superagentNeeds}>
            <h4 className={styles.superagentNeedsTitle}>{t('superagentTriggersTitle')}</h4>
            <div className={styles.superagentFilters}>
              <input
                className={styles.superagentFilterInput}
                value={query}
                placeholder={t('superagentFilterPlaceholder')}
                onChange={(event) => { setQuery(event.target.value) }}
              />
              <label className={styles.superagentFilterToggle}>
                <input type="checkbox" checked={activeOnly} onChange={(event) => { setActiveOnly(event.target.checked) }} />
                {t('superagentFilterActive')}
              </label>
            </div>
            <ul className={styles.superagentList}>
              {visibleTriggers.map(entry => (
                <li key={`${entry.key}-${entry.at}-${entry.author}`}>
                  <button type="button" className={styles.superagentLink} onClick={() => onSelect?.(entry.key)}>
                    {entry.key} · {entry.author} · {entry.at}{entry.active ? ' · active' : ''}
                  </button>
                </li>
              ))}
            </ul>
            {visibleTriggers.length === 0 ? <p className={styles.notice}>{t('superagentFilterEmpty')}</p> : null}
          </div>
        )}
      {history === undefined || history === null || history.entries.length === 0
        ? null
        : (
          <div className={styles.superagentNeeds}>
            <h4 className={styles.superagentNeedsTitle}>{t('superagentHistoryTitle')}</h4>
            <ul className={styles.superagentList}>
              {history.entries.map(entry => (
                <li key={entry.sha}>{entry.subject} · {entry.author} · {entry.at}</li>
              ))}
            </ul>
          </div>
        )}
    </section>
  )
}
