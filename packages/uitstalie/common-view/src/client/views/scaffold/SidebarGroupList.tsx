/**
 * The sidebar replica, composed from this package's layout units.
 *
 * Every measurement and every element order mirrors the shipped sidebar: a 34px
 * workspace row whose leading cell swaps the folder glyph for the expand arrow
 * on hover, and 32px session rows whose leading cell holds the state dot, whose
 * title ellipsizes, and whose trailing cells carry the time, the pin, and the
 * hover-only actions. Colours are tokens; the drawing owns no colour of its own.
 * @module @deepseek-ai/dsh-client-common-view/SidebarGroupList
 */
import { Fragment, type CSSProperties } from 'react'
import {
  IconArchiveOutlineRegular,
  IconEllipsisOutlineRegular,
  IconFolderCloseRegular,
  IconFolderOpenRegular,
  IconNewChatOutlineRegular,
  IconPinFillRegular,
  IconTriangleRightFillRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { Column } from '../../units/Column.tsx'
import { Divider } from '../../units/Divider.tsx'
import { Row } from '../../units/Row.tsx'
import css from './SidebarGroupList.module.css'
import type { CommonViewKey } from '../../locales.ts'
import type { SidebarGroup, SidebarRow } from './sample-sidebar.ts'

/** Injected share of the replica. */
export interface SidebarGroupListInjected {
  /** Localized copy of the `common-view` namespace. */
  t: (key: CommonViewKey, params?: Record<string, string>) => string
  /** The groups to draw. */
  groups: readonly SidebarGroup[]
}

/** Props the replica renders from. */
export type SidebarGroupListProps = SidebarGroupListInjected

/** The indent one nesting level adds, as the shipped list applies it. */
const INDENT_PER_LEVEL_PX = 12

/** Join the classes a row draws with, dropping the absent ones. */
function classes(...parts: readonly (string | false | undefined)[]): string {
  return parts.filter((part): part is string => typeof part === 'string' && part.length > 0).join(' ')
}

/**
 * Render the trailing actions of a row.
 * @param props - the accessible names and the activation behavior.
 * @returns the hover-only action strip.
 */
function RowActions({ menuLabel, archiveLabel }: { menuLabel: string; archiveLabel: string }) {
  return (
    <span className={css.actions}>
      <button type="button" className={css.glyph} aria-label={menuLabel}><IconEllipsisOutlineRegular /></button>
      <button type="button" className={css.glyph} aria-label={archiveLabel}><IconArchiveOutlineRegular size={14} /></button>
    </span>
  )
}

/**
 * Render one session row.
 * @param props - the row's data, its depth, and the copy namespace.
 * @returns the session row.
 */
function SessionRow({ row, depth, t }: { row: SidebarRow; depth: number; t: SidebarGroupListInjected['t'] }) {
  return (
    <Row
      gap="0"
      className={classes(css.sessionRow, row.selected === true && css.sessionRowSelected)}
      style={{ '--dsh-common-view-indent': `${String(depth * INDENT_PER_LEVEL_PX)}px` } as CSSProperties}
    >
      <span className={css.sessionLead}>
        {row.running === true ? <span className={css.sessionDot} aria-hidden="true" /> : null}
      </span>
      <span className={classes(css.sessionTitle, row.archived === true && css.sessionTitleMuted)}>{row.title}</span>
      <span className={css.time}>{row.time}</span>
      {row.pinned === true ? <span className={css.pin}><IconPinFillRegular size={14} /></span> : null}
      <RowActions menuLabel={t('scaffold.rowMenu')} archiveLabel={t('scaffold.rowArchive')} />
    </Row>
  )
}

/**
 * Render the sidebar replica.
 * @param props - the groups and the copy namespace.
 * @returns the group list.
 */
export function SidebarGroupList({ t, groups }: SidebarGroupListProps) {
  return (
    <Column gap="0" align="stretch" className={css.groupList}>
      {groups.map((group, index) => (
        <Fragment key={group.id}>
          {index > 0 ? <Divider /> : null}
          <Row gap="0" className={css.groupRow}>
            <span className={css.groupLead}>
              <span className={css.groupFolder}>
                {group.expanded ? <IconFolderOpenRegular /> : <IconFolderCloseRegular />}
              </span>
              <span className={classes(css.groupArrow, group.expanded && css.groupArrowOpen)}>
                <IconTriangleRightFillRegular />
              </span>
            </span>
            <span className={css.groupTitle}>{group.title}</span>
            <span className={css.actions}>
              <button type="button" className={css.glyph} aria-label={t('scaffold.newSession')}>
                <IconNewChatOutlineRegular />
              </button>
            </span>
          </Row>
          {group.expanded
            ? group.rows.map(row => <SessionRow key={row.id} row={row} depth={1} t={t} />)
            : null}
        </Fragment>
      ))}
    </Column>
  )
}
