/**
 * `@deepseek-ai/dsh-tool-dsh-store` package entry.
 *
 * The tool that exposes these operations to the model is the next slice of
 * task14; this entry publishes the path matrix and the store operations so they
 * can be type-checked, built, and tested on their own.
 * @module @deepseek-ai/dsh-tool-dsh-store
 */

export {
  DEFAULT_STORE_PATH_LIMITS,
  isPathInside,
  normalizeStorePath,
  resolveStoreTarget,
  STORE_DIR_NAME,
  StorePathError,
} from './paths.ts'
export type {
  NormalizedStorePath,
  StorePathLimits,
  StorePathRejection,
} from './paths.ts'
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
