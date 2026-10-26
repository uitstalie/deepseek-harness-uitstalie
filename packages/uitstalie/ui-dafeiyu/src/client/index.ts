/**
 * The capability list's browser plugin: mounts the organizer's status
 * namespace, registers the `settings.capabilities` copy dictionary, and
 * contributes the capability page to the settings section seat.
 *
 * The Remote entry is mounted rather than declared in `inject`: the namespace
 * exists only after this apply's own `$mount`, so a module-level requirement
 * would wait forever on a service only this plugin can provide. The inner
 * `ctx.inject` waits for it after the mount, and a runtime that already
 * provides the namespace (the client test tier, another composition of the
 * same row) is left alone instead of mounting a second copy.
 *
 * @module @deepseek-ai/dsh-client-ui-dafeiyu/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the ctx.remote merge and the ClientRemote method types.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import dafeiyuRemote from '@deepseek-ai/dsh-dafeiyu/remote'
import { CapabilitiesSection } from './CapabilitiesSection.tsx'
import type { CapabilitiesSectionInjected } from './CapabilitiesSection.tsx'
import { en, zh, type CapabilityKey } from './locales.ts'
import { CapabilityStore } from './store.ts'
import type { CapabilityGate, CapabilityGateValue, CapabilityWire } from './store.ts'
import { CAPABILITIES_SETTINGS_ORDER, CAPABILITIES_SETTINGS_SECTION } from '../section.ts'

export type { CapabilitiesSectionInjected, CapabilitiesSectionProps } from './CapabilitiesSection.tsx'
export type { CapabilityKey } from './locales.ts'
export type { CapabilitiesState, CapabilityGate, CapabilityGateValue, CapabilityWire } from './store.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Capability list copy. */
    'settings.capabilities': CapabilityKey
  }
}

/** This package's plugin name. */
export const name = 'ui-dafeiyu'

/** Required services; `remote.dafeiyu` arrives in the inner scope after this apply's mount. */
export const inject = ['slots', 'locale', 'remote', 'configForms']

/** Locale namespace of this page's copy. */
const NS = 'settings.capabilities'

/**
 * Mount the organizer's status namespace, its copy, and the settings section.
 * @param ctx - browser plugin context carrying slots, locale, the Remote carrier and config forms.
 * @returns a disposer that unmounts the Remote contribution when this plugin provided it.
 */
export async function apply(ctx: ClientContext): Promise<() => void> {
  // Generated artifacts are mounted by whoever composes the row: the Web shell does not mount
  // them, while a row-based client test runtime already did.
  const mounted = ctx.get('remote.dafeiyu') === undefined ? await ctx.remote.$mount(dafeiyuRemote) : undefined
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-dafeiyu: copy dictionaries')
  const t = ctx.locale.bind(NS) as CapabilitiesSectionInjected['t']
  // The organizer's own row namespace: its `capabilities` field is the volatile gate the provider
  // reads, so this switch writes the same configuration a profile edit writes.
  const gate = ctx.configForms.get<CapabilityGateValue>('dafeiyu')

  ctx.inject(['slots', 'remote.dafeiyu'], (scoped) => {
    const controller = new CapabilityStore(scoped.remote.dafeiyu as CapabilityWire, gate as CapabilityGate)
    scoped.slots.inject('settings.section', () => scoped.slots.register({
      name: 'settings.section',
      id: CAPABILITIES_SETTINGS_SECTION,
      order: CAPABILITIES_SETTINGS_ORDER,
      label: () => t('nav'),
      locale: NS,
      inject: (): CapabilitiesSectionInjected => ({
        controller,
        activate: () => { void controller.load() },
        hooks: { snapshot: controller.store },
        t,
      }),
    }, CapabilitiesSection))
  })
  return () => {
    // The mount disposer is asynchronous; the fiber's cleanup callback is synchronous.
    void mounted?.()
  }
}
