/**
 * The memory settings page's browser plugin: registers the `settings.memory` copy dictionary and
 * contributes the row form to the settings section seat.
 *
 * The controller is built over the shared configuration form of the `memory` row, so the page only
 * edits the fields the settings service exposes (the volatile ones) and the provider applies them
 * without a remount.
 *
 * @module @deepseek-ai/dsh-client-ui-memory/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { MemorySection } from './MemorySection.tsx'
import type { MemorySectionInjected } from './MemorySection.tsx'
import { en, zh, type MemoryKey } from './locales.ts'
import { MemorySettingsController, type MemoryRowConfig } from './settings.ts'
import { MEMORY_SETTINGS_ORDER, MEMORY_SETTINGS_SECTION } from '../section.ts'

export type { MemorySectionInjected, MemorySectionProps } from './MemorySection.tsx'
export type { MemorySettingsState } from './settings.ts'
export type { MemoryKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Memory settings page copy. */
    'settings.memory': MemoryKey
  }
}

/** This package's plugin name. */
export const name = 'ui-memory'

/** Required services; the configuration form is read from the optional settings service. */
export const inject = ['slots', 'locale']

/** Locale namespace of this page's copy. */
const NS = 'settings.memory'

/**
 * Register the memory row's copy and the settings section.
 * @param ctx - browser plugin context carrying slots and locale.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-memory: copy dictionaries')
  const t = ctx.locale.bind(NS) as MemorySectionInjected['t']

  ctx.inject(['slots'], (scoped) => {
    const form = scoped.get('configForms')?.get<MemoryRowConfig>('memory')
    const controller = new MemorySettingsController(form)
    scoped.effect(() => () => { controller.dispose() }, 'ui-memory: settings controller')
    scoped.slots.inject('settings.section', () => scoped.slots.register({
      name: 'settings.section',
      id: MEMORY_SETTINGS_SECTION,
      order: MEMORY_SETTINGS_ORDER,
      label: () => t('nav'),
      locale: NS,
      inject: (): MemorySectionInjected => ({
        controller,
        t,
      }),
    }, MemorySection))
  })
}
