/**
 * Sidebar rules button, browser half: mounts the store's read-only Remote
 * namespace and registers one occupant of the workspace-row action seat.
 *
 * The Remote entry is mounted here rather than declared in `inject`: the
 * namespace exists only after this apply's own `$mount`, so a module-level
 * requirement would wait forever on a service only this plugin can provide. The
 * inner `ctx.inject` waits for it after the mount.
 * @module @deepseek-ai/dsh-client-ui-tool-dsh-store/client
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the workspace-row seat declaration into this program.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
// Type-only: pulls the locale service and namespace map into this program.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the ctx.remote merge and the ClientRemote method types.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the store's Remote boundary and error-code declarations.
import type {} from '@deepseek-ai/dsh-tool-dsh-store/types'
import storeRemote from '@deepseek-ai/dsh-tool-dsh-store/remote'
import { RulesButton } from './RulesButton.tsx'
import type { RulesButtonInjected } from './RulesButton.tsx'
import { en, zh, type RulesKey } from './locales.ts'

export type { RulesButtonInjected, RulesButtonProps } from './RulesButton.tsx'
export type { RulesKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Sidebar rules button copy. */
    'sidebar.tool-dsh-store': RulesKey
  }
}

export const name = 'ui-tool-dsh-store'
/** Slots, copy binding, and the Remote carrier; `remote.dshStore` arrives in the inner scope. */
export const inject = ['slots', 'locale', 'remote']

/** Locale namespace of this package's copy. */
const NS = 'sidebar.tool-dsh-store'

/** The workspace-row seat this plugin occupies. */
const SEAT = 'sidebar.workspaces.row.action'

/**
 * Mount the rules Remote namespace and register the row button.
 * @param ctx - browser plugin context carrying slots, locale, and the Remote carrier.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-tool-dsh-store: copy dictionaries')
  const t = ctx.locale.bind(NS) as RulesButtonInjected['t']

  void ctx.remote.$mount(storeRemote).then(() => {
    ctx.inject(['slots', 'remote.dshStore'], (scoped) => {
      scoped.slots.inject(SEAT, () => scoped.slots.register({
        name: SEAT,
        id: 'tool-dsh-store-rules',
        order: 100,
        inject: (): RulesButtonInjected => ({
          t,
          loadRules: workspaceId => scoped.remote.dshStore.listRules(workspaceId),
          loadRule: (workspaceId, path) => scoped.remote.dshStore.readRule(workspaceId, path),
        }),
      }, RulesButton))
    })
  })
}
