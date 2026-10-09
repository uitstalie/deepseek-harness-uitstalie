/**
 * Browser half of the common-view overlay plugin.
 *
 * The plugin adopts one native view at a time. For each adopted view it either
 * registers an item into an existing list cell (grouping) or takes a cell's
 * occupant over at a lower `priority` (replacement); every contribution goes
 * through `ctx.slots.inject`, so withdrawing it restores the native one. The
 * accent travels into component CSS as a component-local custom property set
 * inline — never as a literal color in a stylesheet.
 * @module @deepseek-ai/dsh-client-common-view/client
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the workspace's slot declarations into this program.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
// Type-only: pulls the locale service and namespace map into this program.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the `ctx.slots` service declaration into this program.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Config as CommonViewConfig } from '../index.ts'
import { resolveCommonViewConfig } from '../config.ts'
import { en, zh, type CommonViewKey } from './locales.ts'
import { MarkerButton } from './views/session-row-action/MarkerButton.tsx'
import { TintedArchiveButton } from './views/session-row-action/TintedArchiveButton.tsx'

export type { CommonViewKey } from './locales.ts'
export type { MarkerButtonProps } from './views/session-row-action/MarkerButton.tsx'
export type { TintedArchiveButtonProps } from './views/session-row-action/TintedArchiveButton.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Overlay copy of the adopted views. */
    'common-view': CommonViewKey
  }
}

export const name = 'common-view'

/** Services every adopted view registers through. */
export const inject = ['slots', 'locale']

/** Locale namespace of this plugin's copy. */
const NS = 'common-view'

/** The first adopted view: the session row's action list (declared by ui-workspace). */
const SESSION_ROW_ACTION = 'sidebar.workspaces.session.row.action'

/**
 * Register the overlay contributions the config asks for.
 * @param ctx - the plugin's client context.
 * @param config - the row's raw config; absent for a row that declares none, so it is resolved first.
 */
export function apply(ctx: Context, config?: Partial<CommonViewConfig>): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'common-view: copy dictionaries')
  const t = ctx.locale.bind(NS) as (key: CommonViewKey, params?: Record<string, string>) => string
  const resolved = resolveCommonViewConfig(config)
  const accent = resolved.accent

  // Grouping: one more item in the row's action list, between the native
  // `archive` (order 100) and `pin` (order 200) entries.
  if (resolved.sessionRowAction) {
    ctx.slots.inject(SESSION_ROW_ACTION, () => ctx.slots.register({
      name: SESSION_ROW_ACTION,
      id: 'common-view-marker',
      order: 150,
      locale: NS,
      inject: () => ({ t, accent }),
    }, MarkerButton))
  }

  // Replacement: the same cell the native `archive` item occupies, at a lower
  // priority, so this component renders while the native registration stays
  // live for an instant rollback.
  if (resolved.takeoverArchive) {
    ctx.slots.inject(SESSION_ROW_ACTION, () => ctx.slots.register({
      name: SESSION_ROW_ACTION,
      id: 'archive',
      priority: -1,
      order: 100,
      locale: NS,
      inject: () => ({ t, accent }),
    }, TintedArchiveButton))
  }
}
