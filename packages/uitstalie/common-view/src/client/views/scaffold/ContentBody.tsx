/**
 * The middle region's body, replicated from the conversation view's own frame:
 * the scroll body that holds the view and the sticky composer seat, the width
 * axis they share, and the composer's card with its input line and control row.
 *
 * Measurements come from `ui-conversation`'s `ConversationRoot.module.css`
 * (`.body`, `.scrollBody`, `.viewArea`, `.composerStack`, `.composerSeat`) and
 * `InputBar.module.css` (`.root`, `.card`, `.input`, `.placeholder`, `.row`).
 *
 * The transcript inside the scroll body and the composer's control row are
 * still placeholders: the message rows and the controls are separate slices.
 * @module @deepseek-ai/dsh-client-common-view/ContentBody
 */
import { TextView } from '../../units/TextView.tsx'
import css from './ContentBody.module.css'
import type { CommonViewKey } from '../../locales.ts'

/** Injected share of the body. */
export interface ContentBodyInjected {
  /** Localized copy of the `common-view` namespace. */
  t: (key: CommonViewKey, params?: Record<string, string>) => string
}

/** Props the body renders from. */
export type ContentBodyProps = ContentBodyInjected

/**
 * Render the middle region's body.
 * @param props - the copy namespace.
 * @returns the scroll body with the composer seat at its end.
 */
export function ContentBody({ t }: ContentBodyProps) {
  return (
    <div className={css.body}>
      <div className={css.scrollBody}>
        <div className={css.viewArea}>
          {/* Auto margins center the stand-in without touching the view's own box. */}
          <div className={css.transcript}>
            <TextView text={t('scaffold.content')} size="caption" tone="tertiary" />
          </div>
        </div>
        {/* The composer chain's seat stays stuck to the scroll body's floor. */}
        <div className={css.composerSeat}>
          <div className={css.composerStack}>
            <div className={css.composerRoot}>
              <div className={css.composerCard}>
                <div className={css.composerInput} />
                <span className={css.composerPlaceholder}>{t('scaffold.draft')}</span>
                <div className={css.composerRow} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
