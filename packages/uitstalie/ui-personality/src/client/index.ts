/**
 * The identity proposal queue's browser plugin: mounts the `remote.personality`
 * namespace, registers the `settings.personality` copy dictionary, and
 * contributes the proposal page to the settings section seat.
 *
 * The Remote entry is mounted here rather than declared in `inject`: the
 * namespace exists only after this apply's own `$mount`, and a runtime that
 * already provides it (the client test tier, another composition of the same
 * row) is left alone instead of mounting a second copy.
 *
 * @module @deepseek-ai/dsh-client-ui-personality/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the ctx.remote merge and the ClientRemote method types.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import personalityRemote from '@deepseek-ai/dsh-personality/remote'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { PersonalitySection } from './PersonalitySection.tsx'
import type { PersonalitySectionInjected } from './PersonalitySection.tsx'
import { en, zh, type PersonalityKey } from './locales.ts'
import { PERSONALITY_SETTINGS_ORDER, PERSONALITY_SETTINGS_SECTION } from '../section.ts'

export type { PersonalityProposalController, PersonalitySectionInjected, PersonalitySectionProps } from './PersonalitySection.tsx'
export type { PersonalityKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Identity proposal page copy. */
    'settings.personality': PersonalityKey
  }
}

/** This package's plugin name. */
export const name = 'ui-personality'

/** Required services; `remote.personality` arrives in the inner scope after this apply's mount. */
export const inject = ['slots', 'locale', 'remote']

/** Locale namespace of this page's copy. */
const NS = 'settings.personality'

/** Unwrap one Remote call, rethrowing the host failure so the page can show it. */
async function unwrap<T>(call: Promise<RemoteResult<T>>): Promise<T> {
  const result = await call
  if (!result.ok) throw result.error
  return result.value
}

/**
 * Mount the proposal Remote namespace, its copy, and the settings section.
 * @param ctx - browser plugin context carrying slots, locale, and the Remote carrier.
 * @returns a disposer that unmounts the Remote contribution when this plugin provided it.
 */
export async function apply(ctx: ClientContext): Promise<() => void> {
  const mounted = ctx.get('remote.personality') === undefined
    ? await ctx.remote.$mount(personalityRemote)
    : undefined
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-personality: copy dictionaries')
  const t = ctx.locale.bind(NS) as PersonalitySectionInjected['t']

  ctx.inject(['slots', 'remote.personality'], (scoped) => {
    const controller = {
      list: async () => await unwrap(scoped.remote.personality.list()),
      decide: async (id: string, decision: 'accept' | 'reject') => await unwrap(decision === 'accept'
        ? scoped.remote.personality.accept(id)
        : scoped.remote.personality.reject(id)),
    }
    scoped.slots.inject('settings.section', () => scoped.slots.register({
      name: 'settings.section',
      id: PERSONALITY_SETTINGS_SECTION,
      order: PERSONALITY_SETTINGS_ORDER,
      label: () => t('nav'),
      locale: NS,
      inject: (): PersonalitySectionInjected => ({ controller, t }),
    }, PersonalitySection))
  })
  return () => {
    // The mount disposer is asynchronous; the fiber's cleanup callback is synchronous.
    void mounted?.()
  }
}
