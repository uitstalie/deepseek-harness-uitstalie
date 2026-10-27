/**
 * The knowledge search: a query box and the ranked hits the host answered, each with its
 * `file:line` so a reader can open the source instead of trusting the snippet.
 *
 * @module @deepseek-ai/dsh-client-ui-jira/KnowledgeSearch
 */

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { fill, type JiraKey } from './locales.ts'
import type { JiraKnowledgeState } from './store.ts'
import styles from './JiraSection.module.css'

/** What the knowledge block renders. */
export interface KnowledgeSearchProps {
  /** The search state. */
  knowledge: JiraKnowledgeState
  /** This page's copy. */
  t: (key: JiraKey) => string
  /** Record the query as typed. */
  onChange: (query: string) => void
  /** Run the search. */
  onSearch: () => void
}

/** The knowledge search block. */
export function KnowledgeSearch({ knowledge, t, onChange, onSearch }: KnowledgeSearchProps) {
  return (
    <section className={styles.block}>
      <h3 className={styles.heading}>{t('kbTitle')}</h3>
      <form
        className={styles.search}
        onSubmit={(event) => {
          event.preventDefault()
          onSearch()
        }}
      >
        <input
          className={styles.input}
          value={knowledge.query}
          placeholder={t('kbPlaceholder')}
          aria-label={t('kbPlaceholder')}
          onChange={(event) => { onChange(event.target.value) }}
        />
        <Button variant="outline" size="sm" type="submit">{t('kbAction')}</Button>
      </form>
      {knowledge.status === 'loading' ? <p className={styles.notice}>{t('kbLoading')}</p> : null}
      {knowledge.status === 'error'
        ? <p className={styles.errorText} role="alert">{fill(t('kbFailed'), { message: knowledge.error ?? '' })}</p>
        : null}
      {knowledge.stale && knowledge.status !== 'loading'
        ? <p className={styles.notice} role="status">{t('kbStale')}</p>
        : null}
      {knowledge.status === 'ready' && knowledge.view !== null ? <Hits knowledge={knowledge} t={t} /> : null}
    </section>
  )
}

/** The settled search's hits and their count. */
function Hits(props: { knowledge: JiraKnowledgeState; t: (key: JiraKey) => string }) {
  const { knowledge, t } = props
  const view = knowledge.view
  if (view === null) return null
  if (view.hits.length === 0) return <p className={styles.notice}>{t('kbEmpty')}</p>
  return (
    <>
      <ul className={styles.hits}>
        {view.hits.map(hit => (
          <li key={hit.key} className={styles.hit}>
            <div className={styles.hitHead}>
              <span className={styles.itemKey}>{hit.key}</span>
              <span className={styles.hitTitle}>{hit.title}</span>
              <span className={styles.hitLocation}>
                {fill(t('kbLocation'), { file: hit.file, line: String(hit.line) })}
              </span>
            </div>
            <p className={styles.hitSnippet}>{hit.snippet}</p>
          </li>
        ))}
      </ul>
      <p className={styles.counts}>
        {fill(t('kbMatched'), { matched: String(view.matched), topK: String(view.topK) })}
      </p>
    </>
  )
}
