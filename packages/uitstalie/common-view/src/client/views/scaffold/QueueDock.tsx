/**
 * The composer's queue dock, replicated from the conversation view's own panel:
 * a header counting the queued messages over a list that expands in place, its
 * square bottom tucked under the input card so the two read as one surface.
 *
 * Measurements come from `ui-conversation`'s `QueueDock.module.css`.
 * Attachment rows, the inline editor, and the send-echo row are separate slices.
 * @module @deepseek-ai/dsh-client-common-view/QueueDock
 */
import { useId, useState } from 'react'
import {
  IconChevronDownOutlineRegular,
  IconChevronUpOutlineRegular,
  IconQueueOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import css from './QueueDock.module.css'
import type { CommonViewKey } from '../../locales.ts'

/** Injected share of the dock. */
export interface QueueDockInjected {
  /** Localized copy of the `common-view` namespace. */
  t: (key: CommonViewKey, params?: Record<string, string>) => string
  /** The queued messages, oldest first. */
  queued: readonly string[]
}

/** Props the dock renders from. */
export type QueueDockProps = QueueDockInjected

/**
 * Render the queued messages.
 * @param props - the copy namespace and the queued messages.
 * @returns the dock panel, or nothing while the queue is empty.
 */
export function QueueDock({ t, queued }: QueueDockProps) {
  const [collapsed, setCollapsed] = useState(false)
  const listId = useId()
  if (queued.length === 0) return null
  const listVisible = !collapsed
  return (
    <div className={css.dock}>
      <div className={css.panel}>
        <button
          type="button"
          className={css.header}
          aria-controls={listId}
          aria-expanded={!collapsed}
          onClick={() => { setCollapsed(value => !value) }}
        >
          <span className={css.lead} aria-hidden><IconQueueOutlineRegular /></span>
          <span className={css.count}>{t('scaffold.queueCount', { n: String(queued.length) })}</span>
          <span className={css.chevron} aria-hidden>
            {listVisible ? <IconChevronDownOutlineRegular /> : <IconChevronUpOutlineRegular />}
          </span>
        </button>
        <ul id={listId} className={css.list} hidden={!listVisible}>
          {listVisible && queued.map((text, index) => (
            <li key={`${String(index)}:${text}`} className={css.row}>{text}</li>
          ))}
        </ul>
      </div>
    </div>
  )
}
