/**
 * The `.dsh` store atom: the base interface (`ctx.dshStore`) that branch
 * capabilities read and write `.dsh` content through.
 *
 * The implementation owns project-root discovery, `.dsh` path confinement, the
 * store operations, the rules/skills authoring checks, and the per-session
 * sandbox policy gate, so a provider or a model tool consumes one interface
 * instead of assembling a store path or re-implementing the refusal matrix.
 *
 * Providers receive this service through injection; the model-facing tool and
 * the read-only sidebar Remote live in `@deepseek-ai/dsh-tool-dsh-store` and
 * consume it.
 * @module @deepseek-ai/dsh-store-atom
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createDshStore } from './service.ts'

export const name = 'store-atom'
/** The filesystem every store call reads and writes through. */
export const inject = ['fs']

/** Store atom configuration. */
export interface Config {
  /** Create `<projectRoot>/.dsh` for a session that needs the store; `false` leaves it absent. */
  ensureRoot?: boolean
}

/** Schemastery configuration for the store atom. */
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
export { RULES_DIRECTORY, rulesScanChanged, scanWorkspaceRules } from './rules.ts'
export type { RulesScan, RulesScanOptions } from './rules.ts'
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
  StoreScope,
  StoreWriteOptions,
  StoreWriteResult,
} from './service.ts'

/**
 * Register the store service.
 *
 * The store root is prepared lazily by the first mutation (`prepare`), so the
 * atom never subscribes to the agent lifecycle: composing storage does not
 * require an Agent, and a session that never writes never creates a store.
 * @param ctx - plugin context carrying the filesystem and the optional sandbox-policy service.
 * @param config - whether a session creates the store root on its first mutation.
 */
export function apply(ctx: Context, config: Config): void {
  const ensureRoot = config.ensureRoot ?? true
  ctx.provide('dshStore', createDshStore(ctx, ensureRoot))
}
