/**
 * The super-agent summary on the settings page: how many issues are ready, in progress, waiting
 * for review or blocked, and which rows need a person.
 *
 * It reads the board the page already fetched instead of adding a second Host read. The one action
 * is the confirmation of a proposal: it writes the same `human:<git user.name>` `[claim-approved]`
 * credential a person would write with the CLI, so the panel is a second way to say the one thing
 * the claim loop waits for (DH-713).
 *
 * @module @deepseek-ai/dsh-client-ui-jira/SuperagentPanel
 */

import { Fragment, useState } from 'react'
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
  /** Append the next proposal page. */
  readonly onLoadMore?: () => void
  /** Append the next history page. */
  readonly onLoadMoreHistory?: () => void
  /** Open an issue's detail when a row is chosen. */
  readonly onSelect?: (key: string) => void
  /** Record a person's confirmation of the row's pending proposal. */
  readonly onConfirm?: (key: string) => void
  /** The confirmation in flight, or the last one's outcome. */
  readonly confirmState?: { readonly key: string; readonly status: 'idle' | 'loading' | 'ready' | 'error'; readonly error: string | null }
  /** This page's copy. */
  readonly t: (key: JiraKey) => string
}

/** Rows of one status across projects, or the blocked group when no status is given. */
const rowsOf = (board: JiraBoardView, status: string | undefined): readonly JiraIssueRowView[] =>
  board.groups
    .filter(group => status === undefined ? group.kind === 'blocked' : group.kind === 'status' && group.status === status)
    .flatMap(group => group.items)

/**
 * Group trigger rows by their UTC day, preserving the newest-first order.
 * @param entries - the visible trigger rows.
 * @returns day → rows, in first-seen order.
 */
const groupByDay = <T extends { readonly at: string }>(entries: readonly T[]): ReadonlyMap<string, readonly T[]> => {
  const groups = new Map<string, T[]>()
  for (const entry of entries) {
    const day = entry.at.slice(0, 10)
    const rows = groups.get(day)
    if (rows === undefined) groups.set(day, [entry])
    else rows.push(entry)
  }
  return groups
}

/** The super-agent summary block. */
export function SuperagentPanel(props: SuperagentPanelProps) {
  const { board, status, history, triggers, onLoadMore, onLoadMoreHistory, onSelect, onConfirm, confirmState, t } = props
  const [query, setQuery] = useState('')
  const [activeOnly, setActiveOnly] = useState(false)
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  if (board === null && status === undefined) return null
  let counts: readonly (readonly [JiraKey, number])[]
  let needs: readonly { key: string; summary: string }[]
  let proposed: ReadonlySet<string> = new Set()
  if (status !== undefined && status !== null) {
    counts = [
      ['superagentReady', status.counts.ready],
      ['superagentInProgress', status.counts.inProgress],
      ['superagentReview', status.counts.inReview],
      ['superagentBlocked', status.counts.blocked],
    ] as const
    needs = status.needsPerson
    // Only a proposal has a credential to write; a delivery waiting for review has none.
    proposed = new Set(status.proposed.map(row => row.key))
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
    const day = entry.at.slice(0, 10)
    if (fromDate !== '' && day < fromDate) return false
    if (toDate !== '' && day > toDate) return false
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
                  {onConfirm === undefined || !proposed.has(row.key)
                    ? null
                    : (
                      <button
                        type="button"
                        className={styles.superagentConfirm}
                        disabled={confirmState?.status === 'loading'}
                        onClick={() => { onConfirm(row.key) }}
                      >
                        {confirmState?.key === row.key && confirmState.status === 'loading'
                          ? t('superagentConfirming')
                          : t('superagentConfirm')}
                      </button>
                    )}
                </li>
              ))}
            </ul>
            {confirmState?.status === 'error'
              ? <p className={styles.notice}>{fill(t('superagentConfirmFailed'), { message: confirmState.error ?? '' })}</p>
              : null}
            {confirmState?.status === 'ready'
              ? <p className={styles.notice}>{fill(t('superagentConfirmed'), { key: confirmState.key })}</p>
              : null}
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
              <label className={styles.superagentFilterToggle}>
                {t('superagentFilterFrom')}
                <input type="date" className={styles.superagentFilterDate} value={fromDate} onChange={(event) => { setFromDate(event.target.value) }} />
              </label>
              <label className={styles.superagentFilterToggle}>
                {t('superagentFilterTo')}
                <input type="date" className={styles.superagentFilterDate} value={toDate} onChange={(event) => { setToDate(event.target.value) }} />
              </label>
            </div>
            <ul className={styles.superagentList}>
              {[...groupByDay(visibleTriggers)].map(([day, entries]) => (
                <Fragment key={day}>
                  <li className={styles.superagentDate}>{day}</li>
                  {entries.map(entry => (
                    <li key={`${entry.key}-${entry.at}-${entry.author}`}>
                      <button type="button" className={styles.superagentLink} onClick={() => onSelect?.(entry.key)}>
                        {entry.key} · {entry.author} · {entry.at}{entry.active ? ` · ${t('superagentActive')}` : ''}
                      </button>
                    </li>
                  ))}
                </Fragment>
              ))}
            </ul>
            {visibleTriggers.length === 0 ? <p className={styles.notice}>{t('superagentFilterEmpty')}</p> : null}
            {triggers.hasMore && onLoadMore !== undefined
              ? <button type="button" className={styles.superagentLink} onClick={onLoadMore}>{t('superagentLoadMore')}</button>
              : null}
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
            {history.hasMore && onLoadMoreHistory !== undefined
              ? <button type="button" className={styles.superagentLink} onClick={onLoadMoreHistory}>{t('superagentLoadMoreHistory')}</button>
              : null}
          </div>
        )}
    </section>
  )
}
