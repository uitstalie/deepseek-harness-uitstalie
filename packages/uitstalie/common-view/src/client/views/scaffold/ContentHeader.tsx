/**
 * The middle region's header, replicated from the conversation view's own
 * chrome: the breadcrumb navigation of the Session lineage, the tab strip of the
 * conversation views, and the empty seats the shell keeps beside them.
 *
 * Measurements come from `ui-conversation`'s `ConversationRoot.module.css`
 * (`.header`, `.titleRow`, `.crumbs`, `.tabs`, `.tab`).
 * @module @deepseek-ai/dsh-client-common-view/ContentHeader
 */
import { classes } from './classes.ts'
import css from './ContentHeader.module.css'
import type { CommonViewKey } from '../../locales.ts'

/** Injected share of the header. */
export interface ContentHeaderInjected {
  /** Localized copy of the `common-view` namespace. */
  t: (key: CommonViewKey, params?: Record<string, string>) => string
  /** Session lineage, current last. */
  breadcrumbs: readonly string[]
  /** The view tabs to draw. */
  tabs: readonly { id: string; label: string }[]
  /** The selected tab. */
  activeTab: string
  /** Select a tab. */
  onSelectTab: (id: string) => void
}

/** Props the header renders from. */
export type ContentHeaderProps = ContentHeaderInjected

/**
 * Render the middle region's header.
 * @param props - the lineage, the tabs, and the copy namespace.
 * @returns the header, its tab strip, and the seats the shell leaves empty.
 */
export function ContentHeader({ t, breadcrumbs, tabs, activeTab, onSelectTab }: ContentHeaderProps) {
  return (
    <header className={css.header}>
      {/* The shell's leading seat: global navigation, empty without one. */}
      <div className={css.headerLeading} />
      <div className={css.titleRow}>
        <div className={css.titleCluster}>
          <nav className={css.crumbs} aria-label={t('scaffold.sessionHierarchy')}>
            {breadcrumbs.map((title, index) => (
              <span key={`${String(index)}:${title}`} className={css.crumbSeg}>
                {index > 0 ? <span className={css.crumbSep}>/</span> : null}
                {/* Only ancestors navigate: the current crumb is plain text. */}
                {index === breadcrumbs.length - 1
                  ? <span className={classes(css.crumb, css.crumbCurrent)}>{title}</span>
                  : <button type="button" className={css.crumb}>{title}</button>}
              </span>
            ))}
          </nav>
          <div className={css.headerActions} />
        </div>
        <div className={css.headerUtilities} />
        <div className={css.headerCorner} />
      </div>
      {tabs.length > 1 ? (
        <div className={css.tabs} role="tablist">
          {tabs.map(tab => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={tab.id === activeTab}
              className={classes(css.tab, tab.id === activeTab && css.tabActive)}
              onClick={() => { onSelectTab(tab.id) }}
            >
              {tab.label}
            </button>
          ))}
        </div>
      ) : null}
    </header>
  )
}
