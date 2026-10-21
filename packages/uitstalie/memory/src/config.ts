/**
 * Provider configuration for the memory capability: window thresholds, the
 * summary job's model selection, and the managed-body budget.
 * @module @deepseek-ai/dsh-memory/config
 */

import z from '@deepseek-ai/schemastery'
import { DEFAULT_MEMORY_MAX_BYTES, DEFAULT_MEMORY_WINDOW } from './memory-file.ts'
import type { MemoryWindow } from './memory-file.ts'

/** Configuration as the Loader passes it; every field carries a schema default. */
export interface Config {
  /** Turn age at which a detail summary replaces the verbatim turn. */
  detail?: number
  /** Turn age at which a brief summary replaces the detail summary. */
  brief?: number
  /** Turn age at which the summary body leaves the context. */
  forget?: number
  /** Number of sessions kept with summaries in MEMORY.md. */
  sessions?: number
  /**
   * Provider for the later summary job; empty follows the routed model of the
   * turn that completes. Must be set together with {@link Config.summarizationModel}.
   */
  summarizationProvider?: string
  /** Model for the later summary job; empty follows the routed model. */
  summarizationModel?: string
  /** Maximum managed-block body size in UTF-8 bytes. */
  maxBytes?: number
}

/** Schemastery configuration for the memory provider. */
export const Config: z<Config> = z.object({
  detail: z.number().step(1).min(1).default(DEFAULT_MEMORY_WINDOW.detail),
  brief: z.number().step(1).min(1).default(DEFAULT_MEMORY_WINDOW.brief),
  forget: z.number().step(1).min(1).default(DEFAULT_MEMORY_WINDOW.forget),
  sessions: z.number().step(1).min(1).default(DEFAULT_MEMORY_WINDOW.sessions),
  summarizationProvider: z.string().default(''),
  summarizationModel: z.string().default(''),
  maxBytes: z.number().step(1).min(1).default(DEFAULT_MEMORY_MAX_BYTES),
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
 * @param config - raw plugin configuration; absent fields take their defaults.
 * @returns resolved settings.
 * @throws Error when the thresholds are not strictly increasing or only one of
 *   the summary provider and model is set.
 */
export function resolveConfig(config: Config): MemorySettings {
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
