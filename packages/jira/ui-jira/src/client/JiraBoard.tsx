/**
 * The board: one column per status, the cross-project blocked group last, and the counts the
 * filter left behind. Selecting a row opens the detail panel; the board itself writes nothing.
 *
 * @module @deepseek-ai/dsh-client-ui-jira/JiraBoard
 */

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { JiraBoardView } from '@deepseek-ai/dsh-jira-service/types'
import { fill, type JiraKey } from './locales.ts'
import type { JiraBoardState } from './store.ts'
import styles from './JiraSection.module.css'

/** What the board renders. */
export interface JiraBoardProps {
  /** The board's load state. */
  board: JiraBoardState
  /** This page's copy. */
  t: (key: JiraKey) => string
  /** Open one issue's detail. */
  onSelect: (key: string) => void
  /** Read the ledger again after a failure. */
  onRetry: () => void
}

/** One row: key, summary, and the metadata a reader scans for. */
function BoardRow(props: { item: JiraBoardView['items'][number]; t: (key: JiraKey) => string; onSelect: (key: string) => void }) {
  const { item, t, onSelect } = props
  const meta = [
    item.priority,
    item.assignee ?? t('unassigned'),
    ...(item.blocked ? [t('blockedBadge')] : []),
  ].join(' · ')
  return (
    <li>
      <Button variant="ghost" size="sm" className={styles.item} onClick={() => { onSelect(item.key) }}>
        <span className={styles.itemKey}>{item.key}</span>
        <span className={styles.itemSummary}>{item.summary}</span>
        <span className={styles.itemMeta}>{meta}</span>
      </Button>
    </li>
  )
}

/** The grouped board. */
export function JiraBoard({ board, t, onSelect, onRetry }: JiraBoardProps) {
  return (
    <section className={styles.block}>
      <h3 className={styles.heading}>{t('boardTitle')}</h3>
      {board.status === 'idle' || board.status === 'loading'
        ? <p className={styles.notice}>{t('boardLoading')}</p>
        : null}
      {board.status === 'error'
        ? (
          <div className={styles.failure}>
            <p className={styles.errorText} role="alert">{fill(t('boardFailed'), { message: board.error ?? '' })}</p>
            <Button variant="outline" size="sm" onClick={onRetry}>{t('retry')}</Button>
          </div>
        )
        : null}
      {board.status === 'ready' && board.view !== null ? <BoardContent view={board.view} t={t} onSelect={onSelect} /> : null}
    </section>
  )
}

/** The columns and counts of a settled board. */
function BoardContent(props: { view: JiraBoardView; t: (key: JiraKey) => string; onSelect: (key: string) => void }) {
  const { view, t, onSelect } = props
  if (view.items.length === 0) return <p className={styles.notice}>{t('boardEmpty')}</p>
  return (
    <>
      <div className={styles.columns}>
        {view.groups.map(group => (
          <div key={group.name} className={styles.column}>
            <h4 className={styles.columnTitle}>{group.name}</h4>
            <ul className={styles.items}>
              {group.items.map(item => <BoardRow key={item.key} item={item} t={t} onSelect={onSelect} />)}
            </ul>
          </div>
        ))}
      </div>
      <p className={styles.counts}>
        {fill(t('boardCounts'), { returned: String(view.counts.returned), matched: String(view.counts.matched) })}
        {view.truncated
          ? ` · ${fill(t('boardRemaining'), { remaining: String(view.counts.remaining) })}`
          : ''}
      </p>
    </>
  )
}
