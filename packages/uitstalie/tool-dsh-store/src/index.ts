/**
 * The `.dsh` store plugin: the model-facing `tool-dsh-store` capability and the
 * read-only sidebar Remote over the store atom's `ctx.dshStore` service.
 *
 * The store implementation (path confinement, store operations, namespace
 * authoring checks, and the session policy gate) lives in
 * `@deepseek-ai/dsh-store-atom`; this package consumes it.
 *
 * The model face is one dafeiyu capability (`store`): the organizer gates it and
 * wires the tool onto each agent, so Capabilities can switch the model's `.dsh`
 * write/read surface off without unloading storage. The read-only Remote stays a
 * separate surface on its own fiber.
 * @module @deepseek-ai/dsh-tool-dsh-store
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CapabilityContribution } from '@deepseek-ai/dsh-dafeiyu'
import { defineStoreTool } from './tool.ts'
import StoreRulesRemote from './remote.ts'

export const name = 'tool-dsh-store'
/** The organizer, the store atom, and the tool registry the organizer wires. */
export const inject = ['dafeiyu', 'dshStore', 'tools']

/** Capability id this provider registers; `capabilities.store.enabled` gates the tool. */
export const STORE_CAPABILITY_ID = 'store'
/** Display name in the capability list. */
export const STORE_CAPABILITY_LABEL = '.dsh store'
/** One sentence the capability list renders. */
export const STORE_CAPABILITY_DESCRIPTION =
  'Read, create, and delete files under the workspace .dsh store (rules, skills, runtime snapshots).'

export { defineStoreTool } from './tool.ts'
export type { StoreToolOptions, StoreToolValue } from './tool.ts'
export { storeRelativePath, storeRootOfWorkspace, workspaceRootOf } from './remote.ts'
export type { StoreRuleEntry, StoreRulesListing, StoreRuleText } from './types.ts'

/**
 * Register the store capability and the read-only Remote namespace.
 * @param ctx - plugin context carrying the organizer and the store atom.
 */
export function apply(ctx: Context): void {
  const registration = ctx.dafeiyu.register({
    id: STORE_CAPABILITY_ID,
    contractVersion: 2,
    label: STORE_CAPABILITY_LABEL,
    description: STORE_CAPABILITY_DESCRIPTION,
    enabledByDefault: true,
    config: Object.freeze({}),
    create: (): CapabilityContribution => ({
      tools: () => [defineStoreTool(ctx, { store: ctx.dshStore })],
    }),
  })
  ctx.effect(() => registration, 'tool-dsh-store.register()')

  // The read-only Remote namespace the Web sidebar consumes. It waits for the
  // workspace registry on its own fiber, so a composition without one keeps the
  // tool and loses only the sidebar surface.
  void ctx.plugin(StoreRulesRemote)
}
