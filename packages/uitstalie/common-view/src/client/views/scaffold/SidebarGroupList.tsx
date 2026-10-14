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
  IconTrashOutlineRegular,
  IconTriangleRightFillRegular,
  IconUnarchiveOutlineRegular,
  HoverCard,
  Menu,
  MenuItemButton,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { Column } from '../../units/Column.tsx'
import { Divider } from '../../units/Divider.tsx'
import { Row } from '../../units/Row.tsx'
import { classes } from './classes.ts'
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
 * Render the actions a workspace row surfaces on hover: the "…" menu with the
 * rename and delete rows, then the new-session button, as the shell orders them.
 * @param props - the workspace title, the copy namespace, and the menu state the row owns.
 * @returns the hover-only action strip.
 */
function GroupRowActions({ title, t, open, onOpenChange }: {
  title: string
  t: SidebarGroupListInjected['t']
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <span className={classes(css.actions, open && css.actionsOpen)} onClick={(event) => { event.stopPropagation() }}>
      <Menu
        open={open}
        onClose={() => { onOpenChange(false) }}
        portal
        closeOnPointerLeave
        items={[
          { id: 'rename', label: t('scaffold.menuRenameWorkspace'), icon: <IconEditOutlineRegular /> },
          { id: 'delete', label: t('scaffold.menuDeleteWorkspace'), icon: <IconTrashOutlineRegular />, danger: true },
        ]}
        onSelect={() => { onOpenChange(false) }}
        anchor={(
          <button
            type="button"
            className={css.glyph}
            aria-label={t('scaffold.groupMenu', { name: title })}
            onClick={() => { onOpenChange(!open) }}
          >
            <IconEllipsisOutlineRegular />
          </button>
        )}
      />
      <RowIconButton
        label={t('scaffold.newSessionIn', { name: title })}
        tooltip={t('scaffold.newSession')}
        icon={<IconNewChatOutlineRegular />}
      />
    </span>
  )
}

/** Two digits, as the shell pads a clock part. */
function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * The workspace creation line, as the shell renders it: a localized date plus
 * a 24-hour clock, both in local time.
 * @param createdAt - creation time in epoch milliseconds.
 * @param t - the copy namespace.
 * @returns the created-at sentence.
 */
function createdLabel(createdAt: number, t: SidebarGroupListInjected['t']): string {
  const date = new Date(createdAt)
  const day = t('scaffold.dateYmd', {
    y: String(date.getFullYear()),
    m: String(date.getMonth() + 1),
    d: String(date.getDate()),
  })
  return t('scaffold.createdAt', { time: `${day} ${pad2(date.getHours())}:${pad2(date.getMinutes())}` })
}

/**
 * Render the hover card's body: workspace title, its directory, and its
 * creation time, in the shell's order and measurements.
 * @param props - the workspace fields and the copy namespace.
 * @returns the card content.
 */
function WorkspaceHoverContent({ title, cwd, createdAt, t }: {
  title: string
  cwd: string
  createdAt: number
  t: SidebarGroupListInjected['t']
}) {
  return (
    <div className={css.hoverContent}>
      <div className={css.hoverTitle}>{title}</div>
      <div className={css.hoverPath}>{cwd}</div>
      <div className={css.hoverTime}>{createdLabel(createdAt, t)}</div>
    </div>
  )
}

/**
 * Render one workspace row: its leading folder-or-arrow cell, its title, the
 * hover actions, and the hover card the shell opens over it.
 * @param props - the group and the copy namespace.
 * @returns the workspace row.
 */
function WorkspaceRow({ group, t }: { group: SidebarGroup; t: SidebarGroupListInjected['t'] }) {
  // The row owns the menu state: the card stays closed while the menu is open.
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <HoverCard
      anchor={(
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
          <GroupRowActions title={group.title} t={t} open={menuOpen} onOpenChange={setMenuOpen} />
        </Row>
      )}
      content={<WorkspaceHoverContent title={group.title} cwd={group.cwd} createdAt={group.createdAt} t={t} />}
      openDelayMs={800}
      disabled={menuOpen}
      copyText={group.cwd}
      copyLabel={t('scaffold.copy')}
      copiedLabel={t('scaffold.copied')}
    />
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
          <WorkspaceRow group={group} t={t} />
          {group.expanded
            ? group.rows.map(row => <SessionRow key={row.id} row={row} depth={1} t={t} />)
            : null}
        </Fragment>
      ))}
    </Column>
  )
}
