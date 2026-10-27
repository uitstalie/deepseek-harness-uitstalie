/**
 * Provider configuration for the personality capability: the global profile
 * path, the workspace overlay switch, the managed-body budget, and the
 * per-session auto-learning budget.
 * @module @deepseek-ai/dsh-personality/config
 */

import { dirname, join } from 'node:path'
import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import {
  DEFAULT_PERSONALITY_MAX_BYTES,
  PERSONALITY_FILE_NAME,
  PERSONALITY_HISTORY_FILE_NAME,
  PERSONALITY_HISTORY_STORE_PATH,
  PERSONALITY_STORE_PATH,
} from './personality-file.ts'
import { PERSONALITY_PROPOSALS_FILE_NAME } from './proposals.ts'

/** Raw auto-learning budget as the Loader passes it; every field carries a schema default. */
export interface AutoLearnConfig {
  /** Automatic writes allowed per session. */
  entries?: number | undefined
  /** Automatic-write bytes allowed per session. */
  bytes?: number | undefined
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

/** Default number of `PERSONALITY.history.jsonl` records kept before the oldest are dropped. */
export const DEFAULT_PERSONALITY_HISTORY_LIMIT = 500

/** Plain configuration values, as `resolveConfig` accepts them (a default or a test). */
export interface PersonalityConfigInput {
  /** Read and write style and preference entries in the workspace overlay; defaults to true. */
  workspaceOverlay?: boolean | undefined
  /** Managed-block body budget in UTF-8 bytes. */
  maxBytes?: number | undefined
  /** Per-session automatic-learning budget; defaults to {@link DEFAULT_AUTO_LEARN_BUDGET}. */
  autoLearn?: AutoLearnConfig | undefined
  /**
   * Number of history records kept per file; the oldest are dropped when a
   * write would exceed it. Defaults to {@link DEFAULT_PERSONALITY_HISTORY_LIMIT}.
   */
  historyLimit?: number | undefined
}

/** Configuration as the Loader passes it; every field is a live reference. */
export interface Config {
  workspaceOverlay: Volatile<boolean>
  maxBytes: Volatile<number>
  autoLearn: Volatile<AutoLearnConfig>
  historyLimit: Volatile<number>
}

/** Schemastery configuration for the personality provider. */
export const Config = z.object({
  workspaceOverlay: z.boolean().default(true).volatile(),
  maxBytes: z.number().step(1).min(1).default(DEFAULT_PERSONALITY_MAX_BYTES).volatile(),
  autoLearn: z.object({
    entries: z.number().step(1).min(1).default(DEFAULT_AUTO_LEARN_BUDGET.entries),
    bytes: z.number().step(1).min(1).default(DEFAULT_AUTO_LEARN_BUDGET.bytes),
  }).default({}).volatile(),
  historyLimit: z.number().step(1).min(1).default(DEFAULT_PERSONALITY_HISTORY_LIMIT).volatile(),
})

/** Resolved provider settings; the provider reads configuration only in this form. */
export interface PersonalitySettings {
  /** Absolute display path of the global profile under `$DSH_HOME`. */
  readonly globalPath: string
  /** Absolute display path of the append-only history beside the global profile. */
  readonly globalHistoryPath: string
  /** Absolute display path of the identity proposal queue beside the global profile. */
  readonly proposalsPath: string
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
  /** Number of history records kept per history file. */
  readonly historyLimit: number
}

/**
 * Resolve raw configuration into the settings the provider uses.
 *
 * The global profile lives at `<DSH_HOME>/personality/PERSONALITY.md`, where
 * `DSH_HOME` defaults to `~/.dsh`; the store atom's `global` scope owns that
 * root, so no configuration field can point the profile elsewhere.
 * @param config - raw plugin configuration; absent fields take their defaults.
 * @returns resolved settings, including both display paths and both store paths.
 * @throws Error when the body budget or an auto-learning budget is not a
 *   positive safe integer.
 */
export function resolveConfig(config: PersonalityConfigInput): PersonalitySettings {
  const globalPath = join(resolveDshHome(), 'personality', PERSONALITY_FILE_NAME)
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
  const historyLimit = config.historyLimit ?? DEFAULT_PERSONALITY_HISTORY_LIMIT
  if (!Number.isSafeInteger(historyLimit) || historyLimit < 1) {
    throw new Error(`personality: historyLimit must be a positive integer; got ${String(historyLimit)}`)
  }
  return {
    globalPath,
    globalHistoryPath: join(dirname(globalPath), PERSONALITY_HISTORY_FILE_NAME),
    proposalsPath: join(dirname(globalPath), PERSONALITY_PROPOSALS_FILE_NAME),
    workspaceOverlay: config.workspaceOverlay ?? true,
    workspaceStorePath: PERSONALITY_STORE_PATH,
    workspaceHistoryStorePath: PERSONALITY_HISTORY_STORE_PATH,
    maxBytes,
    autoLearn,
    historyLimit,
  }
}
