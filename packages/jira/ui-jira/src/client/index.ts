/**
 * The jira browser plugin: mounts `remote.jira`, registers the `settings.jira` copy dictionary,
 * and contributes the ledger page to the settings section seat.
 *
 * The Remote entry is mounted rather than declared in `inject`: the namespace exists only after
 * this apply's own `$mount`, so a module-level requirement would wait forever on a service only
 * this plugin can provide. The inner `ctx.inject` waits for it after the mount, and a runtime that
 * already provides the namespace (the client test tier, another composition of the same row) is
 * left alone instead of mounting a second copy.
 *
 * @module @deepseek-ai/dsh-client-ui-jira/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the ctx.remote merge and the ClientRemote method types.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { JiraChangeEvent } from '@deepseek-ai/dsh-jira-service/types'
import jiraRemote from '@deepseek-ai/dsh-jira-service/remote'
import { JiraSection } from './JiraSection.tsx'
import type { JiraSectionInjected } from './JiraSection.tsx'
import { JiraLedgerSettingsController, type JiraLedgerSettings } from './ledger-settings.ts'
import { en, zh, type JiraKey } from './locales.ts'
import { JiraStore } from './store.ts'
import { JIRA_SETTINGS_ORDER, JIRA_SETTINGS_SECTION } from '../section.ts'

export type { JiraSectionInjected, JiraSectionProps } from './JiraSection.tsx'
export type { JiraKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Jira settings page copy. */
    'settings.jira': JiraKey
  }
}

/** This package's plugin name. */
export const name = 'ui-jira'

/** Required services; `remote.jira` arrives in the inner scope after this apply's mount. */
export const inject = ['slots', 'locale', 'remote']

/** Locale namespace of this page's copy. */
const NS = 'settings.jira'

/**
 * Mount the ledger Remote namespace, its copy, and the settings section.
 * @param ctx - browser plugin context carrying slots, locale, and the Remote carrier.
 * @returns a disposer that unmounts the Remote contribution when this plugin provided it.
 */
export async function apply(ctx: ClientContext): Promise<() => void> {
  // Generated artifacts are mounted by whoever composes the row: the Web shell does not mount
  // them, while a row-based client test runtime already did.
  const mounted = ctx.get('remote.jira') === undefined ? await ctx.remote.$mount(jiraRemote) : undefined
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-jira: copy dictionaries')
  const t = ctx.locale.bind(NS) as JiraSectionInjected['t']

  ctx.inject(['slots', 'remote.jira'], (scoped) => {
    const controller = new JiraStore(scoped.remote.jira)
    const ledgerSettings = new JiraLedgerSettingsController(
      scoped.get('configForms')?.get<JiraLedgerSettings>('jira-service'),
    )
    scoped.effect(() => () => { ledgerSettings.dispose() }, 'ui-jira: ledger settings form')
    // The Host announces every committed change (a tool, another session, a sync). The stream is
    // the page's only change source: it re-reads the snapshots it shows instead of watching files
    // or polling, and a reconnected Host is caught up by one fresh read of the same snapshots.
    scoped.effect(() => {
      const lifetime = new AbortController()
      const stream = scoped.remote.$stream<JiraChangeEvent>({
        name: 'jira',
        open: signal => scoped.remote.jira.watch(signal),
        ended: () => new Error('the jira change stream ended'),
      })
      void (async () => {
        try {
          for await (const item of stream) {
            if (lifetime.signal.aborted) return
            // Accept before applying: the supervisor treats a generation as established only
            // after its first item reached the page.
            item.accept()
            controller.changed(item.value)
          }
        } catch {
          // A terminal stream failure must not take the page down: reads keep their own retry, and
          // the next reconnect re-reads the snapshots.
        }
      })()
      const stopReset = scoped.on('connection/reset', () => { controller.reconnected() })
      return () => {
        lifetime.abort()
        stopReset()
        void stream.dispose()
      }
    }, 'ui-jira: follow ledger changes')
    scoped.slots.inject('settings.section', () => scoped.slots.register({
      name: 'settings.section',
      id: JIRA_SETTINGS_SECTION,
      order: JIRA_SETTINGS_ORDER,
      label: () => t('nav'),
      locale: NS,
      inject: (): JiraSectionInjected => ({
        controller,
        activate: () => { void controller.load() },
        ledgerSettings: { controller: ledgerSettings, store: ledgerSettings.store },
        hooks: { snapshot: controller.store, ledgerSettings: ledgerSettings.store },
        t,
      }),
    }, JiraSection))
  })
  return () => {
    // The mount disposer is asynchronous; the fiber's cleanup callback is synchronous.
    void mounted?.()
  }
}
