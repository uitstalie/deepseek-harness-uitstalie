/**
 * Workspace-row rules button: a read-only view of one workspace's `.dsh` rules,
 * opened from the sidebar row that owns it. The list is the Host's own loaded
 * set, so the panel shows exactly what the instruction loader injects, and
 * nothing in this package writes.
 * @module @deepseek-ai/dsh-client-ui-tool-dsh-store/RulesButton
 */

import { useRef, useState } from 'react'
import {
  Button,
  IconChecklistOutlineRegular,
  IconCloseOutlineRegular,
  MenuItemButton,
  MenuSurface,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the store's Remote error-code declarations into this program.
import type {} from '@deepseek-ai/dsh-tool-dsh-store/types'
import css from './RulesButton.module.css'
import type { RulesKey } from './locales.ts'

/** The workspace-row owner share this occupant receives. */
export interface RulesButtonOwnerProps {
  /** Identity of the Workspace whose row renders this button. */
  readonly workspaceId: string
  /** Display label of that row, used in the accessible name. */
  readonly label: string
}

/** Injected share of the rules button registration. */
export interface RulesButtonInjected {
  /** Localized copy of this package's dictionary. */
  t: (key: RulesKey, params?: Record<string, string>) => string
  /** The workspace's loaded rule set. */
  loadRules: ClientRemote['dshStore']['listRules']
  /** One rule's complete text. */
  loadRule: ClientRemote['dshStore']['readRule']
}

/** Row owner share plus the injected share. */
export type RulesButtonProps = RulesButtonOwnerProps & RulesButtonInjected

/** Panel state: the listing plus the rule the reader opened. */
interface PanelState {
  /** Listing progress. */
  status: 'loading' | 'ready' | 'failed'
  /** Retained rule files in path order. */
  entries: readonly { path: string; size: number }[]
  /** Listing failure copy, localized; empty while there is none. */
  message: string
  /** Path of the rule whose text is shown below the list; empty while none is open. */
  openPath: string
  /** That rule's text once it arrived; empty while it is still loading. */
  openText: string
  /** That rule's failure copy, localized; empty while there is none. */
  openMessage: string
}

/** Panel offset from the trigger; the surface is fixed-positioned under the row. */
const PANEL_OFFSET_PX = 6
/** Panel width used to right-align the surface with the row's action group. */
const PANEL_WIDTH_PX = 320

/**
 * Render the rules trigger and, while it is open, the workspace's rule panel.
 * @param props - the row's workspace identity plus the injected loaders and copy.
 * @returns the trigger element and its panel.
 */
export function RulesButton({ workspaceId, label, t, loadRules, loadRule }: RulesButtonProps) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const [state, setState] = useState<PanelState>({
    status: 'loading',
    entries: [],
    message: '',
    openPath: '',
    openText: '',
    openMessage: '',
  })
  const trigger = useRef<HTMLButtonElement>(null)

  /** Load one rule into the panel, keeping the list visible above it. */
  const select = async (path: string): Promise<void> => {
    setState(current => ({ ...current, openPath: path, openText: '', openMessage: '' }))
    const result = await loadRule(workspaceId, path)
    setState(current => result.ok
      ? { ...current, openText: result.value.text }
      : { ...current, openMessage: t('ruleFailed', { message: result.error.message }) })
  }

  /** Open the panel under the trigger, or close it when it is already open. */
  const toggle = async (): Promise<void> => {
    if (open) {
      setOpen(false)
      return
    }
    const rect = trigger.current?.getBoundingClientRect()
    setPosition({
      top: (rect?.bottom ?? 0) + PANEL_OFFSET_PX,
      left: Math.max(PANEL_OFFSET_PX, (rect?.right ?? 0) - PANEL_WIDTH_PX),
    })
    setOpen(true)
    setState({ status: 'loading', entries: [], message: '', openPath: '', openText: '', openMessage: '' })
    const result = await loadRules(workspaceId)
    setState(current => result.ok
      ? { ...current, status: 'ready', entries: result.value.entries }
      : { ...current, status: 'failed', message: t('loadFailed', { message: result.error.message }) })
  }

  return (
    <>
      <Tooltip label={t('button')} side="bottom" align="end" delayMs={500}>
        <Button
          ref={trigger}
          variant="toolbar"
          className={css.trigger}
          aria-expanded={open}
          aria-label={t('buttonAria', { name: label })}
          onClick={(event) => { event.stopPropagation(); void toggle() }}
        >
          <IconChecklistOutlineRegular />
        </Button>
      </Tooltip>
      {open && (
        <MenuSurface
          className={css.surface}
          style={{ top: position.top, left: position.left }}
          role="dialog"
          aria-label={t('title', { name: label })}
          onClick={(event) => { event.stopPropagation() }}
          onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false) }}
        >
          <span className={css.header}>
            <span className={css.title}>{t('title', { name: label })}</span>
            <Button variant="toolbar" aria-label={t('close')} onClick={() => { setOpen(false) }}>
              <IconCloseOutlineRegular />
            </Button>
          </span>
          {state.status === 'loading' && <span className={css.notice}>{t('loading')}</span>}
          {state.status === 'failed' && <span className={css.notice} role="alert">{state.message}</span>}
          {state.status === 'ready' && state.entries.length === 0 && (
            <span className={css.notice}>{`${t('empty')} ${t('emptyHint')}`}</span>
          )}
          {state.entries.length > 0 && (
            <span className={css.list}>
              {state.entries.map(entry => (
                <MenuItemButton key={entry.path} onSelect={() => { void select(entry.path) }}>
                  {entry.path}
                </MenuItemButton>
              ))}
            </span>
          )}
          {state.openPath !== '' && (
            <pre className={css.ruleText}>
              {state.openMessage !== '' ? state.openMessage : (state.openText !== '' ? state.openText : t('loading'))}
            </pre>
          )}
        </MenuSurface>
      )}
    </>
  )
}
