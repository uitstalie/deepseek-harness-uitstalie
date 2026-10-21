/**
 * The `.dsh` store plugin: provides the base interface (`ctx.dshStore`), the
 * model-facing `tool-dsh-store` tool, the read-only sidebar Remote, and the
 * per-session store-root preparation.
 *
 * The store service is the base interface for `.dsh` management: path
 * confinement, the store operations, namespace authoring checks, and the session
 * policy gate live there, so every consumer drives one implementation.
 * @module @deepseek-ai/dsh-tool-dsh-store
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createDshStore } from './service.ts'
import { defineStoreTool } from './tool.ts'
import StoreRulesRemote from './remote.ts'

export const name = 'tool-dsh-store'
/** The tool registry and the filesystem every store call writes through. */
export const inject = ['tools', 'fs']

/** Store plugin configuration. */
export interface Config {
  /** Create `<projectRoot>/.dsh` for a session that needs the store; `false` leaves it absent. */
  ensureRoot?: boolean
}

/** Schemastery configuration for the store plugin. */
export const Config: z<Config> = z.object({
  ensureRoot: z.boolean().default(true),
})

export {
  DEFAULT_STORE_PATH_LIMITS,
  isPathInside,
  normalizeStorePath,
  resolveStoreTarget,
  STORE_DIR_NAME,
  StorePathError,
} from './paths.ts'
export type { NormalizedStorePath, StorePathLimits, StorePathRejection } from './paths.ts'
export {
  isMemoryPath,
  isRulesPath,
  isSkillsPath,
  RULES_NAMESPACE_PATTERN,
  SKILLS_NAMESPACE_PATTERN,
  validateNamespaceContent,
} from './namespaces.ts'
export {
  createStoreFile,
  createStoreFolder,
  ensureStoreRoot,
  queryStoreTarget,
  removeStoreTarget,
} from './store-ops.ts'
export type {
  StoreCreateResult,
  StoreEntry,
  StoreEntryKind,
  StoreQueryOptions,
  StoreQueryResult,
  StoreRemoveResult,
} from './store-ops.ts'
export { resolveSessionStorePolicy, resolveStorePolicy } from './policy.ts'
export type { StorePolicy } from './policy.ts'
export { createDshStore } from './service.ts'
export type {
  DshStore,
  StoreCallOptions,
  StoreReadResult,
  StoreRemoveOptions,
  StoreWriteOptions,
  StoreWriteResult,
} from './service.ts'
export { defineStoreTool } from './tool.ts'
export type { StoreToolOptions, StoreToolValue } from './tool.ts'
export { storeRelativePath, storeRootOfWorkspace, workspaceRootOf } from './remote.ts'
export type { StoreRuleEntry, StoreRulesListing, StoreRuleText } from './types.ts'

/**
 * Register the store service, the tool, the Remote, and the per-session root preparation.
 * @param ctx - plugin context carrying the tool registry and filesystem.
 * @param config - whether a session creates the store root on demand.
 */
export function apply(ctx: Context, config: Config): void {
  const ensureRoot = config.ensureRoot ?? true
  const store = createDshStore(ctx, ensureRoot)
  ctx.provide('dshStore', store)

  ctx.tools.register(defineStoreTool(ctx, { store }))

  // The read-only Remote namespace the Web sidebar consumes. It waits for the
  // workspace registry on its own fiber, so a composition without one keeps the
  // tool and loses only the sidebar surface.
  void ctx.plugin(StoreRulesRemote)

  if (!ensureRoot) return
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    try {
      await store.prepare(agent.session, signal)
    } catch (error: unknown) {
      // Preparing the store root is housekeeping rather than part of the step: a
      // failure here is reported, and the tool call that needs the store reports
      // it again with the model-facing message.
      ctx.logger.warn('store root preparation failed: %o', error)
    }
    return next()
  })
}
