/**
 * Provider configuration for the memory capability: window thresholds, the
 * summary job's model selection, and the managed-body budget.
 *
 * Every Loader field is a **volatile** reference: the settings page writes one
 * without remounting the row, and `apply` re-resolves the effective values on
 * `loader/volatile-update`, so a change reaches the next write or summary pass
 * instead of a stale `apply` closure.
 * @module @deepseek-ai/dsh-memory/config
 */

import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_MEMORY_MAX_BYTES, DEFAULT_MEMORY_WINDOW } from './memory-file.ts'
import type { MemoryWindow } from './memory-file.ts'

/** Plain configuration values, as `resolveConfig` accepts them (a default or a test). */
export interface MemoryConfigInput {
  /** Turn age at which a detail summary replaces the verbatim turn. */
  detail?: number | undefined
  /** Turn age at which a brief summary replaces the detail summary. */
  brief?: number | undefined
  /** Turn age at which the summary body leaves the context. */
  forget?: number | undefined
  /** Number of sessions kept with summaries in MEMORY.md. */
  sessions?: number | undefined
  /** Provider for the later summary job; empty follows the routed model. */
  summarizationProvider?: string | undefined
  /** Model for the later summary job; empty follows the routed model. */
  summarizationModel?: string | undefined
  /** Maximum managed-block body size in UTF-8 bytes. */
  maxBytes?: number | undefined
}

/** Configuration as the Loader passes it; every field is a live reference. */
export interface Config {
  detail: Volatile<number>
  brief: Volatile<number>
  forget: Volatile<number>
  sessions: Volatile<number>
  summarizationProvider: Volatile<string>
  summarizationModel: Volatile<string>
  maxBytes: Volatile<number>
}

/** Schemastery configuration for the memory provider. */
export const Config = z.object({
  detail: z.number().step(1).min(1).default(DEFAULT_MEMORY_WINDOW.detail).volatile(),
  brief: z.number().step(1).min(1).default(DEFAULT_MEMORY_WINDOW.brief).volatile(),
  forget: z.number().step(1).min(1).default(DEFAULT_MEMORY_WINDOW.forget).volatile(),
  sessions: z.number().step(1).min(1).default(DEFAULT_MEMORY_WINDOW.sessions).volatile(),
  summarizationProvider: z.string().default('').volatile(),
  summarizationModel: z.string().default('').volatile(),
  maxBytes: z.number().step(1).min(1).default(DEFAULT_MEMORY_MAX_BYTES).volatile(),
})

/** Resolved provider settings; the provider reads configuration only in this form. */
export interface MemorySettings {
  /** Window thresholds recorded in MEMORY.md and applied by the later summary job. */
  readonly window: MemoryWindow
  /** Summary provider; empty means follow the routed model. */
  readonly summarizationProvider: string
  /** Summary model; empty means follow the routed model. */
  readonly summarizationModel: string
  /** Managed-block body budget in UTF-8 bytes. */
  readonly maxBytes: number
}

/**
 * Resolve raw configuration into the settings the provider uses.
 *
 * Window thresholds must increase from detail to brief to forget; the summary
 * provider and model are either both empty (follow the routed model) or both
 * set (an explicit target).
 * @param config - plain configuration values; absent fields take their defaults.
 * @returns resolved settings.
 * @throws Error when the thresholds are not strictly increasing or only one of
 *   the summary provider and model is set.
 */
export function resolveConfig(config: MemoryConfigInput): MemorySettings {
  const window: MemoryWindow = {
    detail: config.detail ?? DEFAULT_MEMORY_WINDOW.detail,
    brief: config.brief ?? DEFAULT_MEMORY_WINDOW.brief,
    forget: config.forget ?? DEFAULT_MEMORY_WINDOW.forget,
    sessions: config.sessions ?? DEFAULT_MEMORY_WINDOW.sessions,
  }
  if (!(window.detail < window.brief && window.brief < window.forget)) {
    throw new Error(
      'memory: window thresholds must increase (detail < brief < forget); '
      + `got detail=${String(window.detail)}, brief=${String(window.brief)}, forget=${String(window.forget)}`,
    )
  }
  const summarizationProvider = config.summarizationProvider ?? ''
  const summarizationModel = config.summarizationModel ?? ''
  if ((summarizationProvider.length === 0) !== (summarizationModel.length === 0)) {
    throw new Error(
      'memory: summarizationProvider and summarizationModel must both be set or both be empty (empty follows the routed model)',
    )
  }
  return {
    window,
    summarizationProvider,
    summarizationModel,
    maxBytes: config.maxBytes ?? DEFAULT_MEMORY_MAX_BYTES,
  }
}
