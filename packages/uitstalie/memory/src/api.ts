/**
 * memory: the global-only memory capability provider.
 *
 * The provider registers one capability with the dafeiyu organizer, which wires
 * the fixed prompt section and the three global memory tools onto root agents.
 * It no longer receives completed turns: the per-turn summary job that wrote
 * `MEMORY.md` is gone, so a turn ending writes no memory entry and appends no
 * memory message.
 *
 * The global store lives at `$DSH_HOME/memory/GLOBAL.md` and is independent of
 * the caller's workspace; the legacy per-workspace files stay readable for the
 * one-time migration in `migration.ts`.
 * @module @deepseek-ai/dsh-memory
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CapabilityContribution } from '@deepseek-ai/dsh-dafeiyu'
import type {} from '@deepseek-ai/dsh-store-atom'
// Type-only: the Loader's loader/volatile-update event declaration.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { resolveConfig } from './config.ts'
import type { Config, MemorySettings } from './config.ts'
import { registerMemoryCommands } from './commands.ts'
import { MEMORY_PROMPT_SECTION } from './prompt.ts'
import { memoryTools } from './tools.ts'

export const name = 'memory'
/** The organizer and the `.dsh` store; global memory reads no session state. */
export const inject = ['dafeiyu', 'dshStore']

/** Stable capability id this provider registers with the organizer. */
export const MEMORY_CAPABILITY_ID = 'memory'

/** The settings section this provider owns; `ui-memory` registers the page. */
export const MEMORY_SETTINGS_SECTION = 'memory'

/** Sort order of that section inside the settings navigation. */
export const MEMORY_SETTINGS_ORDER = 190

/** Contract version the provider implements: contribution plus capability-list metadata. */
export const MEMORY_CONTRACT_VERSION = 2

/** Display name in the organizer's capability list. */
export const MEMORY_CAPABILITY_LABEL = 'Memory'

/** One-sentence capability-list description. */
export const MEMORY_CAPABILITY_DESCRIPTION = 'Global facts and conventions shared by every workspace'

export { Config } from './config.ts'
export { resolveConfig } from './config.ts'
export type { MemorySettings } from './config.ts'
export {
  appendMemoryEntry,
  appendTurnSummary,
  assertMemoryEntryKind,
  createMemoryDocument,
  DEFAULT_MEMORY_MAX_BYTES,
  DEFAULT_MEMORY_MAX_ENTRIES,
  DEFAULT_MEMORY_WINDOW,
  editMemorySummary,
  forgetMemoryEntries,
  MEMORY_ARCHIVE_BEGIN,
  MEMORY_ARCHIVE_END,
  MEMORY_ARCHIVE_STORE_PATH,
  MEMORY_EVICTION_RECORD_LIMIT,
  MEMORY_EVICTION_TEXT_MAX_CHARS,
  MEMORY_BLOCK_BEGIN,
  MEMORY_BLOCK_END,
  MEMORY_BRIEF_MAX_CHARS,
  MEMORY_BRIEF_MAX_ENTRIES,
  MEMORY_DOCUMENT_VERSION,
  MEMORY_ENTRY_KINDS,
  MEMORY_HISTORY_LIMIT,
  MEMORY_HISTORY_STORE_PATH,
  MEMORY_KIND_REGISTRY,
  MEMORY_STORE_PATH,
  MemoryDocumentError,
  memoryKindDefinition,
  memoryArchiveRecord,
  archiveEvictionRecord,
  appendEvictionRecords,
  removeMemoryEntry,
  pruneEmptyMemorySessions,
  resolveMemoryEntriesInStore,
  migrateMemoryTiers,
  parseMemoryDocument,
  pruneMemorySession,
  pruneSessionEntries,
  readMemoryDocument,
  readMemorySummaryHistory,
  renderMemoryDocument,
  revertMemorySummary,
  setMemorySummaryPaused,
  summarizeMemoryEntries,
  summaryPaused,
} from './memory-file.ts'
export type {
  MemoryAppendOptions,
  MemoryAppendResult,
  MemoryArchiveRecord,
  MemoryDocument,
  MemoryDocumentErrorCode,
  MemoryDocumentRead,
  MemoryEntry,
  MemoryEntryInput,
  MemoryEntryKind,
  MemoryEvictionReason,
  MemoryEvictionRecord,
  MemoryForgetFilter,
  MemoryForgetResult,
  MemoryFrame,
  MemoryKindDefinition,
  MemorySection,
  MemorySessionRecord,
  MemoryTier,
  MemoryTierCompressor,
  MemoryTierMigrationOptions,
  MemoryTierMigrationResult,
  MemoryTurnRecord,
  MemoryTurnSummaryInput,
  MemoryTurnSummaryOptions,
  MemoryTurnSummaryResult,
  MemoryWindow,
  MemoryEntryStats,
  MemoryPruneResult,
  MemorySummaryEditResult,
  MemorySummaryHistoryRecord,
  MemorySummaryTarget,
  SessionPrune,
} from './memory-file.ts'
export {
  DEFAULT_MEMORY_FILES_TTL_DAYS,
  DEFAULT_MEMORY_OPEN_TTL_DAYS,
  DEFAULT_MEMORY_SUPERSESSION_MIN_SHARED_TAGS,
  cleanupMemoryDocument,
  resolveMemoryEntries,
} from './cleanup.ts'
export type {
  MemoryCleanupCounts,
  MemoryCleanupNewerEntry,
  MemoryCleanupOptions,
  MemoryCleanupResult,
  MemoryResolveFilter,
  MemoryResolveResult,
} from './cleanup.ts'
export {
  MEMORY_ARCHIVE_TITLE,
  appendMemoryArchive,
  readMemoryArchive,
} from './archive.ts'
export type { MemoryResolveStoreResult } from './memory-file.ts'
export { collectMemoryEntryTimes } from './entry-times.ts'

export {
  isMemoryCheckpointSource,
  replaceSurfaceRange,
} from './checkpoint.ts'
export type {
  MemoryCheckpointWindow,
  SurfaceCheckpoint,
} from './checkpoint.ts'
export { MEMORY_PROMPT_ORDER, MEMORY_PROMPT_SECTION, MEMORY_PROMPT_SECTION_NAME, MEMORY_PROMPT_TEXT } from './prompt.ts'
export { appendMemoryNotice } from './notice.ts'
export type { MemoryNoticeSource } from './notice.ts'
export { memoryTools } from './tools.ts'
export {
  GLOBAL_MEMORY_ARCHIVE_STORE_PATH,
  GLOBAL_MEMORY_MAX_BYTES,
  GLOBAL_MEMORY_SEARCH_LIMIT,
  GLOBAL_MEMORY_STORE_PATH,
  GLOBAL_MEMORY_TOPICS,
  GlobalMemoryError,
  appendGlobalArchive,
  classifyMemoryText,
  createGlobalArchiveDocument,
  createGlobalMemoryDocument,
  forgetGlobalEntries,
  globalMemoryEntryId,
  globalMemoryPath,
  normalizeEntryText,
  parseGlobalArchiveDocument,
  parseGlobalMemoryDocument,
  readGlobalMemory,
  readGlobalMemoryArchive,
  renderGlobalArchiveDocument,
  renderGlobalMemoryDocument,
  renderSearchValue,
  searchGlobalMemory,
  writeGlobalEntry,
} from './global-memory.ts'
export type {
  GlobalMemoryArchiveDocument,
  GlobalMemoryArchiveEntry,
  GlobalMemoryArchiveRead,
  GlobalMemoryArchiveReason,
  GlobalMemoryDocument,
  GlobalMemoryEntry,
  GlobalMemoryErrorCode,
  GlobalMemoryForgetFilter,
  GlobalMemoryForgetResult,
  GlobalMemoryRead,
  GlobalMemorySearchItem,
  GlobalMemorySearchValue,
  GlobalMemoryTopic,
  GlobalMemoryWriteInput,
  GlobalMemoryWriteResult,
  MemoryClassification,
  MemoryFactClass,
} from './global-memory.ts'
export {
  MemoryMigrationError,
  applyMemoryMigration,
  dryRunMemoryMigration,
  rollbackMemoryMigration,
} from './migration.ts'
export type {
  MemoryMigrationApplyOptions,
  MemoryMigrationApplyResult,
  MemoryMigrationErrorCode,
  MemoryMigrationOptions,
  MemoryMigrationReport,
  MemoryMigrationRollbackOptions,
  MemoryMigrationRollbackResult,
  MigrationBackup,
  MigrationClassCounts,
  MigrationDisposition,
  MigrationFile,
  MigrationFileKind,
  MigrationSummary,
  MigrationUnit,
  MigrationUnitOrigin,
  MigrationWorkspace,
} from './migration.ts'
export {
  MEMORY_COMMAND_NAME,
  MEMORY_COMMAND_USAGE,
  memoryCommand,
  registerMemoryCommands,
} from './commands.ts'
export { planTierMigrations } from './window.ts'
export type {
  MemoryWindowValues,
  TierMigrationConfig,
  TierMigrationPlan,
  TurnRange,
} from './window.ts'

/**
 * Register the memory capability with the organizer.
 *
 * The contribution is the static prompt section and the three global memory
 * tools. There is no `onTurnEnd` hook: a completed turn writes no memory entry,
 * starts no summary job, and appends no memory message. The legacy settings row
 * is still resolved so an existing deployment whose window or summary pair is
 * invalid fails the load loudly instead of being silently ignored; those values
 * no longer reach a live write path.
 * @param ctx - plugin context carrying the organizer and the store.
 * @param config - raw provider configuration from the Loader row.
 * @throws Error when the legacy window thresholds or summary model pair are invalid,
 *   or when the capability id is already registered.
 */
export function apply(ctx: Context, config: Config): void {
  const effective = readSettings(config)
  const registration = ctx.dafeiyu.register({
    id: MEMORY_CAPABILITY_ID,
    contractVersion: MEMORY_CONTRACT_VERSION,
    label: MEMORY_CAPABILITY_LABEL,
    description: MEMORY_CAPABILITY_DESCRIPTION,
    settings: { sectionId: MEMORY_SETTINGS_SECTION, order: MEMORY_SETTINGS_ORDER },
    config: effective,
    create: (): CapabilityContribution => ({
      scope: 'all',
      promptSections: (agent: Agent) => (agent.role ?? 'agent') === 'subagent' ? [] : [MEMORY_PROMPT_SECTION],
      tools: () => memoryTools(ctx),
    }),
  })
  ctx.effect(() => registration, 'memory.register()')

  // `/memory` is a human maintenance surface: it is not gated by the capability switch, so a
  // paused or broken capability can still be inspected and corrected.
  ctx.inject(['commands'], (commandCtx) => {
    ctx.effect(() => registerMemoryCommands(commandCtx), 'memory.commands()')
  })
}

/**
 * Read one live row value.
 *
 * A Loader-validated row hands this plugin `Volatile` references; a caller that mounts it directly
 * (a test) may hand plain values, so both forms are accepted.
 * @param value - the configured value, a live reference, or undefined.
 * @returns the current plain value.
 */
function current<T>(value: Volatile<T> | T | undefined): T | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'object' && value !== null && typeof (value as { get?: unknown }).get === 'function') {
    return (value as Volatile<T>).get() as T
  }
  return value as T
}

/**
 * Resolve the row's live references into settings.
 * @param config - the Loader row configuration.
 * @returns the settings for the values in effect right now.
 */
function readSettings(config: Config): MemorySettings {
  return resolveConfig({
    detail: current(config.detail),
    brief: current(config.brief),
    forget: current(config.forget),
    sessions: current(config.sessions),
    summarizationProvider: current(config.summarizationProvider),
    summarizationModel: current(config.summarizationModel),
    maxBytes: current(config.maxBytes),
    maxEntries: current(config.maxEntries),
    openTtlDays: current(config.openTtlDays),
    filesTtlDays: current(config.filesTtlDays),
    supersessionMinSharedTags: current(config.supersessionMinSharedTags),
    summarizeEveryTurns: current(config.summarizeEveryTurns),
  })
}
