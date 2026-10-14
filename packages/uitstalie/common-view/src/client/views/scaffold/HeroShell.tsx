/**
 * The blank Session's hero, replicated from the conversation view's own chrome:
 * the centred mark and headline with their preview badge, and the workspace chip
 * that switches the Session's workspace.
 *
 * Measurements come from `ui-conversation`'s `HeroShell.module.css`; the shell's
 * animated swim morphs on the mark are not replicated, so the mark is the
 * shared `FishLogo` at the shell's own 34px.
 * @module @deepseek-ai/dsh-client-common-view/HeroShell
 */
import { FishLogo, IconChevronDownOutlineRegular, IconFolderCloseRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './HeroShell.module.css'
import type { CommonViewKey } from '../../locales.ts'

/** Injected share of the hero. */
export interface HeroShellInjected {
  /** Localized copy of the `common-view` namespace. */
  t: (key: CommonViewKey, params?: Record<string, string>) => string
}

/** Props the hero renders from. */
export type HeroShellProps = HeroShellInjected

/** The mark size the shell hands its brand-mark slot. */
const MARK_SIZE = 34

/**
 * Render the workspace chip.
 *
 * The chip stays interactive before the first message, and without a label it
 * shows the shell's placeholder state: closed folder plus the call to action.
 * @param props - the copy namespace and an optional workspace label.
 * @returns the chip button.
 */
export function WorkspaceChip({ t, label }: HeroShellInjected & { label?: string | undefined }) {
  return (
    <button
      type="button"
      className={css.workspace}
      aria-label={t('scaffold.chooseWorkspace')}
      aria-haspopup="menu"
      aria-expanded={false}
    >
      <IconFolderCloseRegular className={css.folder} size={16} />
      <span className={css.workspaceLabel}>{label ?? t('scaffold.chooseWorkspace')}</span>
      <IconChevronDownOutlineRegular className={css.chevron} size={12} />
    </button>
  )
}

/**
 * Render the hero's chrome.
 * @param props - the copy namespace.
 * @returns the mark, its headline, and the body the composer follows.
 */
export function HeroShell({ t }: HeroShellProps) {
  return (
    <div className={css.root}>
      <div className={css.stack}>
        <div className={css.headline}>
          <span className={css.mark}><FishLogo size={MARK_SIZE} /></span>
          <span className={css.titleGroup}>
            <span>{t('scaffold.heroHeadline')}</span>
            <span className={css.previewBadge}>{t('scaffold.heroPreview')}</span>
          </span>
        </div>
        {/* The composer stays mounted outside this component. */}
        <div className={css.body} />
      </div>
    </div>
  )
}
