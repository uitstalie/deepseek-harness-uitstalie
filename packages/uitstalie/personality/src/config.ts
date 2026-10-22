/**
 * Provider configuration for the personality capability: the global profile
 * path, the workspace overlay switch, the managed-body budget, and the
 * per-session auto-learning budget.
 * @module @deepseek-ai/dsh-personality/config
 */

import { dirname, join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { expandHomePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import {
  DEFAULT_PERSONALITY_MAX_BYTES,
  PERSONALITY_FILE_NAME,
  PERSONALITY_HISTORY_FILE_NAME,
  PERSONALITY_HISTORY_STORE_PATH,
  PERSONALITY_STORE_PATH,
} from './personality-file.ts'

/** Raw auto-learning budget as the Loader passes it; every field carries a schema default. */
export interface AutoLearnConfig {
  /** Automatic writes allowed per session. */
  entries?: number
  /** Automatic-write bytes allowed per session. */
  bytes?: number
}

/** Resolved per-session auto-learning budget. */
export interface AutoLearnBudget {
  /** Automatic writes allowed per session. */
  readonly entries: number
  /** Automatic-write bytes allowed per session. */
  readonly bytes: number
}

/** Default per-session auto-learning budget. */
export const DEFAULT_AUTO_LEARN_BUDGET: AutoLearnBudget = { entries: 3, bytes: 512 }

/** Configuration as the Loader passes it; every field carries a schema default. */
export interface Config {
  /**
   * Absolute path of the global profile; empty resolves to
   * `<DSH_HOME>/personality/PERSONALITY.md`, where `DSH_HOME` defaults to `~/.dsh`.
   */
  globalPath?: string
  /** Read and write style and preference entries in the workspace overlay; defaults to true. */
  workspaceOverlay?: boolean
  /** Managed-block body budget in UTF-8 bytes. */
  maxBytes?: number
  /** Per-session automatic-learning budget; defaults to {@link DEFAULT_AUTO_LEARN_BUDGET}. */
  autoLearn?: AutoLearnConfig
}

/** Schemastery configuration for the personality provider. */
export const Config: z<Config> = z.object({
  globalPath: z.string().default(''),
  workspaceOverlay: z.boolean().default(true),
  maxBytes: z.number().step(1).min(1).default(DEFAULT_PERSONALITY_MAX_BYTES),
  autoLearn: z.object({
    entries: z.number().step(1).min(1).default(DEFAULT_AUTO_LEARN_BUDGET.entries),
    bytes: z.number().step(1).min(1).default(DEFAULT_AUTO_LEARN_BUDGET.bytes),
  }).default({}),
})

/** Resolved provider settings; the provider reads configuration only in this form. */
export interface PersonalitySettings {
  /** Absolute path of the global profile. */
  readonly globalPath: string
  /** Absolute path of the append-only history beside the global profile. */
  readonly globalHistoryPath: string
  /** Whether the workspace overlay is read and written. */
  readonly workspaceOverlay: boolean
  /** Store-relative path of the workspace overlay. */
  readonly workspaceStorePath: string
  /** Store-relative path of the append-only history beside the workspace overlay. */
  readonly workspaceHistoryStorePath: string
  /** Managed-block body budget in UTF-8 bytes. */
  readonly maxBytes: number
  /** Resolved per-session auto-learning budget. */
  readonly autoLearn: AutoLearnBudget
}

/**
 * Resolve raw configuration into the settings the provider uses.
 *
 * The global path defaults to `<DSH_HOME>/personality/PERSONALITY.md`; an
 * explicit path expands a leading tilde and resolves against the current
 * directory, like the harness home resolvers do.
 * @param config - raw plugin configuration; absent fields take their defaults.
 * @returns resolved settings, including both file paths and both history paths.
 * @throws Error when the body budget or an auto-learning budget is not a
 *   positive safe integer.
 */
export function resolveConfig(config: Config): PersonalitySettings {
  const globalPath = config.globalPath === undefined || config.globalPath.trim().length === 0
    ? join(resolveDshHome(), 'personality', PERSONALITY_FILE_NAME)
    : resolve(expandHomePath(config.globalPath))
  const maxBytes = config.maxBytes ?? DEFAULT_PERSONALITY_MAX_BYTES
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error(`personality: maxBytes must be a positive integer; got ${String(maxBytes)}`)
  }
  const autoLearn: AutoLearnBudget = {
    entries: config.autoLearn?.entries ?? DEFAULT_AUTO_LEARN_BUDGET.entries,
    bytes: config.autoLearn?.bytes ?? DEFAULT_AUTO_LEARN_BUDGET.bytes,
  }
  if (!Number.isSafeInteger(autoLearn.entries) || autoLearn.entries < 1) {
    throw new Error(`personality: autoLearn.entries must be a positive integer; got ${String(autoLearn.entries)}`)
  }
  if (!Number.isSafeInteger(autoLearn.bytes) || autoLearn.bytes < 1) {
    throw new Error(`personality: autoLearn.bytes must be a positive integer; got ${String(autoLearn.bytes)}`)
  }
  return {
    globalPath,
    globalHistoryPath: join(dirname(globalPath), PERSONALITY_HISTORY_FILE_NAME),
    workspaceOverlay: config.workspaceOverlay ?? true,
    workspaceStorePath: PERSONALITY_STORE_PATH,
    workspaceHistoryStorePath: PERSONALITY_HISTORY_STORE_PATH,
    maxBytes,
    autoLearn,
  }
}
