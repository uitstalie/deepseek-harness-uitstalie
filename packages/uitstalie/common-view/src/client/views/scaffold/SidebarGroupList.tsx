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
import { Fragment, useState, type CSSProperties, type ReactNode } from 'react'
import {
  IconArchiveOutlineRegular,
  IconBranchOutlineRegular,
  IconEditOutlineRegular,
  IconEllipsisOutlineRegular,
  IconFolderCloseRegular,
  IconFolderOpenRegular,
  IconNewChatOutlineRegular,
  IconPinFillRegular,
  IconPinOutlineRegular,
  IconTriangleRightFillRegular,
  IconUnarchiveOutlineRegular,
  Menu,
  MenuItemButton,
  Tooltip,
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
 * One row of the session menu, in the shell's own order and with its icons:
 * pin, rename, fork, archive (the state flips the pin and archive rows).
 */
interface SessionMenuItem {
  /** Stable row id, also the React key. */
  id: string
  /** Leading glyph. */
  icon: ReactNode
  /** Localized label. */
  label: string
}

/**
 * Render the trailing icon buttons of a row: the plain `.iconButton` box with
 * the shell's own tooltip settings.
 * @param props - the accessible name, the tooltip sentence, and the glyph.
 * @returns one trailing button.
 */
function RowIconButton({ label, tooltip, icon }: { label: string; tooltip: string; icon: ReactNode }) {
  return (
    <Tooltip label={tooltip} side="bottom" align="end" delayMs={500}>
      <button type="button" className={css.glyph} aria-label={label}>{icon}</button>
    </Tooltip>
  )
}

/**
 * Render the actions a session row surfaces on hover: the "…" menu trigger and
 * the archive and pin buttons, in the shell's order and with its copy.
 * @param props - the row's title and its pin and archive membership.
 * @returns the hover-only action strip.
 */
function SessionRowActions({ title, pinned, archived, t }: {
  title: string
  pinned: boolean
  archived: boolean
  t: SidebarGroupListInjected['t']
}) {
  // Component-private: only this strip reads the open state.
  const [menuOpen, setMenuOpen] = useState(false)
  const menuItems: readonly SessionMenuItem[] = [
    pinned
      ? { id: 'pin', icon: <IconPinFillRegular />, label: t('scaffold.menuUnpin') }
      : { id: 'pin', icon: <IconPinOutlineRegular />, label: t('scaffold.menuPin') },
    { id: 'rename', icon: <IconEditOutlineRegular />, label: t('scaffold.menuRename') },
    { id: 'fork', icon: <IconBranchOutlineRegular />, label: t('scaffold.menuFork') },
    archived
      ? { id: 'archive', icon: <IconUnarchiveOutlineRegular />, label: t('scaffold.menuUnarchive') }
      : { id: 'archive', icon: <IconArchiveOutlineRegular />, label: t('scaffold.menuArchive') },
  ]
  return (
    // The strip's clicks stay in the strip, exactly as the shell keeps them out
    // of the row's own activation.
    <span className={classes(css.actions, menuOpen && css.actionsOpen)} onClick={(event) => { event.stopPropagation() }}>
      <Menu
        open={menuOpen}
        onClose={() => { setMenuOpen(false) }}
        portal
        closeOnPointerLeave
        anchor={(
          <button
            type="button"
            className={css.glyph}
            aria-label={t('scaffold.rowMenu', { name: title })}
            onClick={() => { setMenuOpen(current => !current) }}
          >
            <IconEllipsisOutlineRegular />
          </button>
        )}
      >
        {menuItems.map(item => (
          <MenuItemButton key={item.id} icon={item.icon} onSelect={() => { setMenuOpen(false) }}>
            {item.label}
          </MenuItemButton>
        ))}
      </Menu>
      <RowIconButton
        label={t(archived ? 'scaffold.menuUnarchive' : 'scaffold.menuArchive')}
        tooltip={t(archived ? 'scaffold.rowUnarchive' : 'scaffold.rowArchive')}
        icon={archived ? <IconUnarchiveOutlineRegular size={14} /> : <IconArchiveOutlineRegular size={14} />}
      />
      {/* Pin and archive are mutually exclusive on the Host, so the shell offers
          no pin button on an archived row. */}
      {archived ? null : (
        <RowIconButton
          label={t(pinned ? 'scaffold.menuUnpin' : 'scaffold.menuPin')}
          tooltip={t(pinned ? 'scaffold.rowUnpin' : 'scaffold.rowPin')}
          icon={pinned ? <IconPinFillRegular size={14} /> : <IconPinOutlineRegular size={14} />}
        />
      )}
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
      <SessionRowActions
        title={row.title}
        pinned={row.pinned === true}
        archived={row.archived === true}
        t={t}
      />
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
