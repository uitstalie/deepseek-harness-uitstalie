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
import { IconPlusOutlineMedium, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { ChatTranscript, type TranscriptMessage } from './ChatTranscript.tsx'
import { ContextMeter, type ContextOccupancy } from './ContextMeter.tsx'
import { HeroShell, WorkspaceChip } from './HeroShell.tsx'
import { classes } from './classes.ts'
import { TextView } from '../../units/TextView.tsx'
import css from './ContentBody.module.css'
import type { CommonViewKey } from '../../locales.ts'

/** Injected share of the body. */
export interface ContentBodyInjected {
  /** Localized copy of the `common-view` namespace. */
  t: (key: CommonViewKey, params?: Record<string, string>) => string
  /** Whether the Session is still blank, which is when the shell centres the hero. */
  hero: boolean
  /** The workspace the hero's chip names. */
  workspaceLabel: string
  /** What the composer's context meter reports. */
  occupancy: ContextOccupancy
  /** The transcript the active phase draws. */
  messages: readonly TranscriptMessage[]
}

/** Props the body renders from. */
export type ContentBodyProps = ContentBodyInjected

/**
 * Render the composer's control row: the attach control on the left, the
 * trailing group with the send circle on the right, and the seats the shell
 * leaves for the mode, model, and activity occupants.
 *
 * The send circle is disabled because the stand-in draft is empty, which is the
 * state the shell disables it in too. Its glyph is the shell's own arrow, drawn
 * inline in `InputBar.tsx`; the shared `IconSendOutline*` is another glyph.
 * @param props - the copy namespace.
 * @returns the control row.
 */
function ComposerControls({ t }: { t: ContentBodyInjected['t'] }) {
  return (
    <div className={css.composerRow}>
      <div className={css.composerTools}>
        <Tooltip label={t('scaffold.attach')} side="top" delayMs={500}>
          <button
            type="button"
            className={css.composerAttach}
            aria-label={t('scaffold.attach')}
            aria-haspopup="listbox"
            aria-expanded={false}
          >
            <IconPlusOutlineMedium size={14} />
          </button>
        </Tooltip>
        {/* The permission and plan seats, empty without their occupants. */}
        <div className={css.composerModes} />
      </div>
      <div className={css.composerTrailing}>
        <div className={css.composerStandard} />
        {/* The activity seat carries its own `:empty` rule in the shell. */}
        <div className={css.composerActivity} />
        <Tooltip label={t('scaffold.send')} side="top" delayMs={500}>
          <button type="button" className={css.composerPrimary} aria-label={t('scaffold.send')} disabled>
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
              <path
                d="M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z"
                fill="currentColor"
              />
            </svg>
          </button>
        </Tooltip>
      </div>
    </div>
  )
}

/**
 * Render the middle region's body.
 * @param props - the copy namespace, the phase, the hero's workspace, the occupancy, and the rows.
 * @returns the scroll body with the composer seat at its end.
 */
export function ContentBody({ t, hero, workspaceLabel, occupancy, messages }: ContentBodyProps) {
  return (
    <div className={css.body}>
      <div className={classes(css.scrollBody, hero && css.scrollBodyHero)}>
        {/* The shell mounts the view only once a Session has content, and keeps
            the stand-in for the phase where nothing has happened yet. */}
        {hero
          ? (
            <div className={css.viewArea}>
              {/* Auto margins center the stand-in without touching the view's own box. */}
              <div className={css.transcript}>
                <TextView text={t('scaffold.content')} size="caption" tone="tertiary" />
              </div>
            </div>
          )
          : <ChatTranscript messages={messages} />}
        {/* The composer chain's seat stays stuck to the scroll body's floor; on a
            blank Session the stack carries the hero above the card. */}
        <div className={css.composerSeat}>
          <div className={classes(css.composerStack, hero && css.composerHero)}>
            {hero ? <HeroShell t={t} /> : null}
            {hero
              ? (
                <div className={css.heroWorkspaceRow}>
                  <WorkspaceChip t={t} label={workspaceLabel} />
                </div>
              )
              : null}
            <div className={css.composerRoot}>
              <div className={css.composerCard}>
                <div className={css.composerInput} />
                <span className={css.composerPlaceholder}>{t('scaffold.draft')}</span>
                <ComposerControls t={t} />
              </div>
              {/* The dock seat: the shell's own slot for composer-bar occupants,
                  carrying the context meter. */}
              <div className={css.composerDock}>
                <ContextMeter t={t} occupancy={occupancy} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
