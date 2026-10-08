/**
 * Workspace-row rules button: a read-only view of one workspace's `.dsh` rules,
 * opened from the sidebar row that owns it.
 *
 * The rule list is the shared `Menu`, so its placement, portalling, keyboard
 * walk, and focus return are the same ones every other row menu uses; reading a
 * rule opens the shared `Modal`, which owns the surface material and Escape
 * handling. An empty or failed listing answers in the same modal instead of an
 * empty dropdown. Nothing in this package writes.
 * @module @deepseek-ai/dsh-client-ui-tool-dsh-store/RulesButton
 */

import { useRef, useState } from 'react'
import {
  Button,
  Menu,
  Modal,
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

/** The rule list while the menu is open; null keeps the menu closed. */
type RuleMenu = readonly { path: string; size: number }[] | null

/** One open modal: either an authoring notice or a rule being read. */
interface RuleModal {
  /** Dialog title: the workspace for a notice, the rule path for a rule. */
  title: string
  /** Body text: the notice copy, the rule text, or a pending/failed message. */
  body: string
  /** Whether the body is an error the reader must notice. */
  alert: boolean
}

/**
 * Render the rules mark and its menu and dialog.
 * @param props - the row's workspace identity plus the injected loaders and copy.
 * @returns the anchored menu trigger and, while open, the dialog.
 */
export function RulesButton({ workspaceId, label, t, loadRules, loadRule }: RulesButtonProps) {
  const [entries, setEntries] = useState<RuleMenu>(null)
  const [modal, setModal] = useState<RuleModal | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)

  /** Load the workspace's rules: a menu when there are any, a notice otherwise. */
  const openMenu = async (): Promise<void> => {
    const result = await loadRules(workspaceId)
    if (!result.ok) {
      setModal({ title: t('title', { name: label }), body: t('loadFailed', { message: result.error.message }), alert: true })
      return
    }
    if (result.value.entries.length === 0) {
      setModal({ title: t('title', { name: label }), body: `${t('empty')} ${t('emptyHint')}`, alert: false })
      return
    }
    setEntries(result.value.entries)
  }

  /** Read one rule into the dialog; the menu closes first so focus returns to the mark. */
  const openRule = async (path: string): Promise<void> => {
    setEntries(null)
    setModal({ title: path, body: t('loading'), alert: false })
    const result = await loadRule(workspaceId, path)
    setModal(result.ok
      ? { title: path, body: result.value.text, alert: false }
      : { title: path, body: t('ruleFailed', { message: result.error.message }), alert: true })
  }

  return (
    <>
      <Menu
        open={entries !== null}
        portal
        align="end"
        side="bottom"
        items={(entries ?? []).map(entry => ({ id: entry.path, label: entry.path }))}
        onSelect={(id) => { void openRule(id) }}
        onClose={() => { setEntries(null) }}
        anchor={(
          <Tooltip label={t('button')} side="bottom" align="end" delayMs={500}>
            <Button
              ref={trigger}
              size="sm"
              className={css.trigger}
              aria-label={t('buttonAria', { name: label })}
              icon={<span className={css.mark} aria-hidden="true">{t('glyph')}</span>}
              onClick={(event) => { event.stopPropagation(); void openMenu() }}
            />
          </Tooltip>
        )}
      />
      {modal !== null && (
        <Modal
          open
          onClose={() => { setModal(null) }}
          closeLabel={t('close')}
          title={modal.title}
          footer={<Button variant="outline" onClick={() => { setModal(null) }}>{t('close')}</Button>}
        >
          {modal.alert
            ? <div className={css.ruleText} role="alert">{modal.body}</div>
            : <pre className={css.ruleText}>{modal.body}</pre>}
        </Modal>
      )}
    </>
  )
}
