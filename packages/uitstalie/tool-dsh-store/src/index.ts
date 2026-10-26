/**
 * The `.dsh` store plugin: the model-facing `tool-dsh-store` tool and the
 * read-only sidebar Remote over the store atom's `ctx.dshStore` service.
 *
 * The store implementation (path confinement, store operations, namespace
 * authoring checks, and the session policy gate) lives in
 * `@deepseek-ai/dsh-store-atom`; this package consumes it.
 * @module @deepseek-ai/dsh-tool-dsh-store
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineStoreTool } from './tool.ts'
import StoreRulesRemote from './remote.ts'

export const name = 'tool-dsh-store'
/** The tool registry and the store atom it drives. */
export const inject = ['dshStore', 'tools']

export { defineStoreTool } from './tool.ts'
export type { StoreToolOptions, StoreToolValue } from './tool.ts'
export { storeRelativePath, storeRootOfWorkspace, workspaceRootOf } from './remote.ts'
export type { StoreRuleEntry, StoreRulesListing, StoreRuleText } from './types.ts'

/**
 * Register the store tool and the read-only Remote namespace.
 * @param ctx - plugin context carrying the tool registry and the store atom.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineStoreTool(ctx, { store: ctx.dshStore }))

  // The read-only Remote namespace the Web sidebar consumes. It waits for the
  // workspace registry on its own fiber, so a composition without one keeps the
  // tool and loses only the sidebar surface.
  void ctx.plugin(StoreRulesRemote)
}
