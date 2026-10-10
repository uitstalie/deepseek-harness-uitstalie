/**
 * The frame scaffold: the parent view's big layout — a left column, a top strip,
 * and the middle region — rebuilt as a composition of this package's own units,
 * leaves, and button capability, so layout work iterates here instead of on
 * native files.
 *
 * Its top strip carries two demonstration buttons built from the button
 * capability: the default one, and one derived into the outlined variant. Each
 * activation re-lays the scaffold out, so the capability's behaviour half is
 * visible without leaving this package.
 * @module @deepseek-ai/dsh-client-common-view/AppScaffold
 */
import { useState, type CSSProperties } from 'react'
import {
  FishLogo,
  IconPanelLeftOutlineRegular,
  IconSlidersTwoOutlineRegular,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { Column } from '../../units/Column.tsx'
import { Divider } from '../../units/Divider.tsx'
import { Row } from '../../units/Row.tsx'
import { Spacer } from '../../units/Spacer.tsx'
import { TextView } from '../../units/TextView.tsx'
import { DefaultButton } from '../../capabilities/DefaultButton.tsx'
import { deriveButton, type ButtonSpec } from '../../capabilities/button-capability.ts'
import { SidebarGroupList } from './SidebarGroupList.tsx'
import { SAMPLE_GROUPS } from './sample-sidebar.ts'
import css from './AppScaffold.module.css'
import type { CommonViewKey } from '../../locales.ts'

/** Injected share of the scaffold. */
export interface AppScaffoldInjected {
  /** Localized copy of the `common-view` namespace. */
  t: (key: CommonViewKey, params?: Record<string, string>) => string
  /** Width of the left column. */
  sidebarWidth: string
  /** Height of the top strip. */
  topHeight: string
}

/** Props the scaffold renders from. */
export type AppScaffoldProps = AppScaffoldInjected

/** The width the demonstration button narrows the left column to. */
const NARROW_SIDEBAR = '160px'

/** The height the demonstration button flattens the top strip to. */
const FLAT_TOP = '28px'

/**
 * Render the frame scaffold.
 * @param props - the copy and the two measurements the config supplies.
 * @returns the scaffold frame.
 */
export function AppScaffold({ t, sidebarWidth, topHeight }: AppScaffoldProps) {
  // Component-private layout experiments: only this component reads them.
  const [wideSidebar, setWideSidebar] = useState(true)
  const [tallTop, setTallTop] = useState(true)

  const sidebarButton: ButtonSpec = { id: 'scaffold.sidebar', ariaLabel: t('scaffold.buttonSidebar'), label: t('scaffold.buttonSidebar') }
  // The second button is the same capability derived into another variant.
  const topButton = deriveButton(
    { id: 'scaffold.top', ariaLabel: t('scaffold.buttonTop'), label: t('scaffold.buttonTop'), size: 'sm' },
    { variant: 'outline' },
  )

  return (
    <div className={css.frame}>
      <div
        className={css.sidebar}
        style={{ '--dsh-common-view-scaffold-sidebar': wideSidebar ? sidebarWidth : NARROW_SIDEBAR } as CSSProperties}
      >
        <Column gap="0" align="stretch" className={css.sidebarBody}>
          {/* Logo row, exactly as the shipped sidebar lays it out: the brand
              identity (a New Session shortcut) and, at its end, the collapse
              toggle — a plain 16px panel glyph while the column is expanded. */}
          <Row gap="0" className={css.brandRow}>
            <button type="button" className={css.brandButton} aria-label={t('scaffold.newSession')}>
              <span className={css.brandMark}><FishLogo size={24} /></span>
              <span className={css.brandName}>{t('scaffold.brand')}</span>
            </button>
            <Tooltip label={t('scaffold.toggleSidebar')} delayMs={500} side="bottom">
              <button
                type="button"
                className={css.glyph}
                aria-label={t('scaffold.toggleSidebar')}
                onClick={() => { setWideSidebar(current => !current) }}
              >
                <IconPanelLeftOutlineRegular size={16} />
              </button>
            </Tooltip>
          </Row>
          <SidebarGroupList t={t} groups={SAMPLE_GROUPS} />
          <Spacer grow />
          {/* Foot: the settings row, exactly where the shell puts its seat. */}
          <Row gap="8px" className={css.settingsRow}>
            <span className={css.glyph}><IconSlidersTwoOutlineRegular /></span>
            <span className={css.settingsLabel}>{t('scaffold.settings')}</span>
          </Row>
        </Column>
      </div>
      <Divider orientation="vertical" />
      <Column gap="0" align="stretch" className={css.main}>
        <div
          className={css.top}
          style={{ '--dsh-common-view-scaffold-top': tallTop ? topHeight : FLAT_TOP } as CSSProperties}
        >
          <Row gap="8px">
            <TextView text={t('scaffold.top')} size="caption" tone="tertiary" />
            <DefaultButton spec={sidebarButton} bindings={{ onClick: () => { setWideSidebar(current => !current) } }} />
            <DefaultButton spec={topButton.spec} bindings={{ ...topButton.bindings, onClick: () => { setTallTop(current => !current) } }} />
          </Row>
        </div>
        <Divider />
        <div className={css.content}>
          <Column gap="8px">
            <TextView text={t('scaffold.content')} size="caption" tone="tertiary" />
          </Column>
        </div>
      </Column>
    </div>
  )
}
