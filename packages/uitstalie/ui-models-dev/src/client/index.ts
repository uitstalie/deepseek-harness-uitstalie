/**
 * The models.dev catalog settings page plugin (browser half).
 *
 * Mount behavior:
 * - `ctx.remote.$mount(...)` mounts the models-dev Host-for-Client Remote
 *   contribution into this fiber (self-mounted in the package; no changes to the native api/remotes wiring needed);
 * - registers the settings.models-dev copy dictionaries (bilingual);
 * - `ctx.slots.inject('settings.section', …)` waits for the shell declaration, then registers the catalog page
 *   (dormant until the declaration arrives, removed on collapse, re-mounted when it reappears);
 * - the page store reaches the component through the inject face; controller.load() fetches the catalog once.
 *
 * @module @deepseek-ai/dsh-client-ui-models-dev/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: pulls in the shell's SlotMap merge (the 'settings.section' entry)
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls in the locale plugin's Context merge (ctx.locale)
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls in the ctx.remote merge and the ClientRemote type
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import modelsDevRemote from '@deepseek-ai/dsh-models-dev/remote'
import llmPlusRemote from '@deepseek-ai/dsh-llm-plus/remote'
import { ModelsDevSection, type ModelsDevSectionInjected } from './ModelsDevSection.tsx'
import { ModelsDevStore, type ModelsDevWire } from './store.ts'
import { en, zh, type ModelsDevKey } from './locales.ts'

export type { ModelsDevSectionInjected, ModelsDevSectionProps } from './ModelsDevSection.tsx'
export type { ModelsDevKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** models.dev catalog settings page copy. */
    'settings.models-dev': ModelsDevKey
  }
}

/** Copy namespace. */
const NS = 'settings.models-dev'

/** Catalog page polling cadence; deployments can tune it to Host load. */
export const Config = z.object({
  pollIntervalMs: z.number().step(1).min(1_000).default(60_000),
  promptPollDelayMs: z.number().step(1).min(50).default(800),
})

/** Resolved catalog page cadence. */
export interface ModelsDevSectionConfig {
  /** Background catalog refresh interval. */
  readonly pollIntervalMs: number
  /** Polling interval for an attempt after OAuth submission. */
  readonly promptPollDelayMs: number
}

/**
 * Required services (cordis fiber inject). 'remote.modelsDev' is not listed here —
 * it is provided by this apply's own $mount, and a module-level declaration would deadlock
 * (waiting for a service that does not exist yet and only this fiber can provide); after mounting
 * inside apply, it is awaited through ctx.inject (the same two-step pattern as
 * experimental/client-ui-agent-team).
 */
export const inject = ['slots', 'locale', 'remote', 'remote.settings', 'remote.credentials']

/**
 * Mount the catalog settings page; the Remote and polling cleanup belong to the registration effect.
 * @returns the page is registerable once settled.
 */
export async function apply(
  ctx: ClientContext,
  config: ModelsDevSectionConfig = { pollIntervalMs: 60_000, promptPollDelayMs: 800 },
): Promise<void> {
  // Who mounts the generated contribution depends on the assembly: the Web shell does not mount this
  // package automatically, while client test runtimes assembled per row have already mounted it. Mount it
  // only when missing — duplicate mounts are rejected by the Client Remote gateway as a namespace conflict
  // (`client api: namespace "modelsDev" conflicts with an existing Remote namespace`).
  const disposeModelsDev = ctx.get('remote.modelsDev') === undefined ? await ctx.remote.$mount(modelsDevRemote) : undefined
  const disposeLlmPlus = ctx.get('remote.llmPlusAuth') === undefined ? await ctx.remote.$mount(llmPlusRemote) : undefined
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-models-dev: copy dictionaries')

  const t = ctx.locale.bind(NS) as ModelsDevSectionInjected['t']
  /** Page controller (created in the inner inject scope; the disposer needs its polling switch). */
  let controller: ModelsDevStore | undefined
  // remote.* only exists after $mount: the inner inject waits for it and re-declares every used
  // service into its scope (the inner scope does not inherit the outer accessible set)
  ctx.inject(['slots', 'remote.modelsDev', 'remote.llmPlusAuth', 'remote.settings', 'remote.credentials'], (scoped) => {
    const wire: ModelsDevWire = {
      modelsDev: scoped.remote.modelsDev,
      settings: scoped.remote.settings,
      credentials: scoped.remote.credentials,
      llmPlusAuth: scoped.remote.llmPlusAuth,
    }
    const controllerInstance = new ModelsDevStore(wire, config)
    controller = controllerInstance
    /** Fetch only when this page is first opened: an assembly state (such as a client test runtime) must not read
     * the Host for a page nobody views. */
    let activated = false
    const activate = (): void => {
      if (activated) return
      activated = true
      // The catalog fetch is a one-time page-level action (failure enters the error state; the page can retry);
      // the 60s background polling afterwards keeps the list fresh (cache and TTL live on the host side)
      void controllerInstance.load()
      void controllerInstance.loadOAuthRoutes()
      void controllerInstance.loadMyRoutes()
      controllerInstance.startCatalogPolling()
    }
    const injected = (): ModelsDevSectionInjected => ({
      controller: controllerInstance,
      activate,
      hooks: { snapshot: controllerInstance.store },
      t,
    })

    scoped.slots.inject('settings.section', () => scoped.slots.register({
      name: 'settings.section',
      id: 'models-dev',
      // 12 sits between models(10) and plugins(15): this page extends the Models settings area
      order: 12,
      label: () => t('nav'),
      inject: injected,
    }, ModelsDevSection))
  })
  ctx.effect(() => async () => {
    controller?.dispose()
    const disposers = [disposeModelsDev?.(), disposeLlmPlus?.()].filter((item): item is Promise<void> => item !== undefined)
    await Promise.allSettled(disposers)
  }, 'ui-models-dev: remotes and polling')
}
