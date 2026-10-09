/**
 * The frame scaffold: the parent view's big layout — a left column, a top strip,
 * and the middle region — rebuilt as a composition of this package's own units
 * and leaves, so layout work iterates here instead of on native files.
 *
 * Every region carries its own name, and every measurement arrives from the
 * plugin config as a component-local custom property, so a layout experiment is
 * a config change.
 * @module @deepseek-ai/dsh-client-common-view/AppScaffold
 */
import type { CSSProperties } from 'react'
import { Column } from '../../units/Column.tsx'
import { Divider } from '../../units/Divider.tsx'
import { Row } from '../../units/Row.tsx'
import { TextView } from '../../units/TextView.tsx'
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

/**
 * Render the frame scaffold.
 * @param props - the copy and the two measurements the config supplies.
 * @returns the scaffold frame.
 */
export function AppScaffold({ t, sidebarWidth, topHeight }: AppScaffoldProps) {
  return (
    <div className={css.frame}>
      <div className={css.sidebar} style={{ '--dsh-common-view-scaffold-sidebar': sidebarWidth } as CSSProperties}>
        <Column gap="8px">
          <TextView text={t('scaffold.sidebar')} size="caption" tone="tertiary" />
        </Column>
      </div>
      <Divider orientation="vertical" />
      <Column gap="0" align="stretch" className={css.main}>
        <div className={css.top} style={{ '--dsh-common-view-scaffold-top': topHeight } as CSSProperties}>
          <Row gap="8px">
            <TextView text={t('scaffold.top')} size="caption" tone="tertiary" />
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
