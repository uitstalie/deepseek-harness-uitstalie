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
import jiraRemote from '@deepseek-ai/dsh-jira-service/remote'
import { JiraSection } from './JiraSection.tsx'
import type { JiraSectionInjected } from './JiraSection.tsx'
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
    scoped.slots.inject('settings.section', () => scoped.slots.register({
      name: 'settings.section',
      id: JIRA_SETTINGS_SECTION,
      order: JIRA_SETTINGS_ORDER,
      label: () => t('nav'),
      locale: NS,
      inject: (): JiraSectionInjected => ({
        controller,
        activate: () => { void controller.load() },
        hooks: { snapshot: controller.store },
        t,
      }),
    }, JiraSection))
  })
  return () => {
    // The mount disposer is asynchronous; the fiber's cleanup callback is synchronous.
    void mounted?.()
  }
}
