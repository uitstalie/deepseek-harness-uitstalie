/**
 * memory: the memory capability provider. It registers one capability with the
 * dafeiyu organizer, which wires the fixed prompt section and the memory tools
 * onto root agents and forwards completed turns back here.
 *
 * The provider owns the window policy, the MEMORY.md file, the prompt text, and
 * the tools. It never subscribes to session events or registers tools itself:
 * the organizer decides which agents receive the contribution and filters the
 * turns the provider sees.
 * @module @deepseek-ai/dsh-memory
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CapabilityContribution, CapabilityRuntime, TurnEndInput } from '@deepseek-ai/dsh-dafeiyu'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-store-atom'
// Type-only: the Loader's loader/volatile-update event declaration.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { resolveConfig } from './config.ts'
import type { Config, MemorySettings } from './config.ts'
import { MEMORY_PROMPT_SECTION } from './prompt.ts'
import { refreshMemorySnapshot } from './snapshot.ts'
import { MemorySummaryRunner } from './summary.ts'
import { memoryTools } from './tools.ts'

export const name = 'memory'
/** The organizer, the store, filesystem access, session history, model calls, and the job registry. */
export const inject = ['dafeiyu', 'dshStore', 'fs', 'sessionQuery', 'jobs', 'llm']

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
export const MEMORY_CAPABILITY_DESCRIPTION = 'Session summaries, searchable history, and tiered forgetting'

export { Config } from './config.ts'
export { resolveConfig } from './config.ts'
export type { MemorySettings } from './config.ts'
export {
  appendMemoryEntry,
  appendTurnSummary,
  assertMemoryEntryKind,
  createMemoryDocument,
  DEFAULT_MEMORY_MAX_BYTES,
  DEFAULT_MEMORY_WINDOW,
  MEMORY_BLOCK_BEGIN,
  MEMORY_BLOCK_END,
  MEMORY_BRIEF_MAX_CHARS,
  MEMORY_BRIEF_MAX_ENTRIES,
  MEMORY_DOCUMENT_VERSION,
  MEMORY_ENTRY_KINDS,
  MEMORY_KIND_REGISTRY,
  MEMORY_STORE_PATH,
  MemoryDocumentError,
  memoryKindDefinition,
  migrateMemoryTiers,
  parseMemoryDocument,
  readMemoryDocument,
  renderMemoryDocument,
} from './memory-file.ts'
export type {
  MemoryAppendOptions,
  MemoryAppendResult,
  MemoryDocument,
  MemoryDocumentErrorCode,
  MemoryDocumentRead,
  MemoryEntry,
  MemoryEntryInput,
  MemoryEntryKind,
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
} from './memory-file.ts'
export {
  isMemoryCheckpointSource,
  replaceSurfaceRange,
} from './checkpoint.ts'
export type {
  MemoryCheckpointWindow,
  SurfaceCheckpoint,
} from './checkpoint.ts'
export { MEMORY_PROMPT_ORDER, MEMORY_PROMPT_SECTION, MEMORY_PROMPT_SECTION_NAME, MEMORY_PROMPT_TEXT } from './prompt.ts'
export {
  appendMemoryNotice,
  isMemorySnapshotSource,
  MEMORY_SNAPSHOT_HINT,
  MEMORY_SNAPSHOT_MAX_BYTES,
  MEMORY_SNAPSHOT_SECTION_NAME,
  MEMORY_SNAPSHOT_TITLE,
  refreshMemorySnapshot,
  renderMemorySnapshot,
  syncMemorySnapshot,
} from './snapshot.ts'
export type { MemoryNoticeSource, MemorySnapshotSource } from './snapshot.ts'
export {
  MEMORY_SUMMARY_ENTRY_MAX_CHARS,
  MEMORY_SUMMARY_FAILURE_NOTICE,
  MEMORY_SUMMARY_INPUT_MAX_BYTES,
  MEMORY_SUMMARY_JOB_KIND,
  MEMORY_SUMMARY_JOB_LABEL,
  MEMORY_SUMMARY_TEXT_MAX_BYTES,
  MemorySummaryRunner,
  parseBriefEntries,
  parseSummaryEntries,
} from './summary.ts'
export {
  MEMORY_READ_MAX_BYTES,
  MEMORY_READ_NARROW_HINT,
  MEMORY_READ_TEXT_MAX_BYTES,
  MEMORY_READ_WINDOW_MAX_EVENTS,
} from './read.ts'
export { memoryTools } from './tools.ts'
export type { MemorySearchItem, MemorySearchValue, TurnFacts } from './tools.ts'
export { planTierMigrations } from './window.ts'
export type {
  MemoryWindowSnapshot,
  TierMigrationConfig,
  TierMigrationPlan,
  TurnRange,
} from './window.ts'

/**
 * Register the memory capability with the organizer.
 *
 * Configuration is resolved once per plugin load; a bad window fails the load
 * rather than silently degrading. The organizer owns per-agent wiring and turn
 * filtering, so the contribution only declares what it provides. Tool closures
 * capture this plugin's context, whose `inject` declaration admits the services
 * the tools read; the organizer's runtime context does not declare them.
 *
 * One {@link MemorySummaryRunner} per registration owns the per-session summary
 * jobs. A completed turn starts a job whose failure stays contained to a notice
 * message; the registration signal aborts in-flight work on unload.
 *
 * A root agent resumed over a workspace that already holds memory entries gets
 * its snapshot from the registration's agent hook, so a restarted provider
 * injects the current state before the first write of the new process. A
 * brand-new session has no surface yet; injecting there would place the snapshot
 * ahead of the system prompt, so it receives its first snapshot from the first
 * successful write instead.
 * @param ctx - plugin context carrying the organizer and services.
 * @param config - raw provider configuration from the Loader row.
 * @throws Error when the window thresholds or summary model pair are invalid,
 *   or when the capability id is already registered.
 */
export function apply(ctx: Context, config: Config): void {
  let effective = readSettings(config)
  // Every consumer reads these getters, so a volatile settings write applies to the next tool
  // call, summary pass or write without rebuilding the registration or keeping a stale closure.
  const settings: MemorySettings = Object.freeze({
    get window() { return effective.window },
    get summarizationProvider() { return effective.summarizationProvider },
    get summarizationModel() { return effective.summarizationModel },
    get maxBytes() { return effective.maxBytes },
  })
  ctx.on('loader/volatile-update', () => {
    try {
      effective = readSettings(config)
    } catch (error) {
      // The schema accepted the write; a cross-field rule (detail < brief < forget, provider and
      // model set together) can still refuse it. Keep the last valid settings and say so.
      ctx.logger.warn('memory: keeping previous settings after an invalid update: %o', error)
    }
  })
  const registration = ctx.dafeiyu.register({
    id: MEMORY_CAPABILITY_ID,
    contractVersion: MEMORY_CONTRACT_VERSION,
    label: MEMORY_CAPABILITY_LABEL,
    description: MEMORY_CAPABILITY_DESCRIPTION,
    settings: { sectionId: MEMORY_SETTINGS_SECTION, order: MEMORY_SETTINGS_ORDER },
    config: effective,
    create: (runtime: CapabilityRuntime): CapabilityContribution => {
      const summaries = new MemorySummaryRunner(ctx, settings, runtime.signal)
      return {
        scope: 'root',
        promptSections: () => [MEMORY_PROMPT_SECTION],
        tools: () => memoryTools(ctx, settings),
        onAgentCreated: (agent: Agent) => {
          // A resumed session already has a surface; a fresh one is empty until
          // its first step, and a user message must not precede the system prompt.
          if (agent.session.surface.nodes.length === 0) return
          void refreshMemorySnapshot(ctx, agent, runtime.signal)
        },
        onTurnEnd: (input) => {
          validateTurnEnd(input)
          summaries.onTurnEnd(input)
        },
        dispose: () => { summaries.dispose() },
      }
    },
  })
  ctx.effect(() => registration, 'memory.register()')
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
  })
}

/**
 * Validate one completed turn before the summary job reads the log.
 *
 * The organizer already filters turn outcomes and resolves the live agent; this
 * checks the one value read from the durable event, so a malformed turn number
 * fails loudly instead of being recorded into MEMORY.md.
 * @param input - the completed turn dispatched by the organizer.
 * @throws Error when the turn number is not a non-negative safe integer.
 */
function validateTurnEnd(input: TurnEndInput): void {
  if (!Number.isSafeInteger(input.turn) || input.turn < 0) {
    throw new Error(`memory: turn/end carried an invalid turn number: ${String(input.turn)}`)
  }
}
