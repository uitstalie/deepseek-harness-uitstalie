/**
 * Plus configuration: the always-on context sources this seam contributes.
 * The native instruction loader keeps its own row and configuration; this
 * package only configures its own sources.
 * @module @deepseek-ai/dsh-agent-instructions-plus/config
 */

import z from '@deepseek-ai/schemastery'

/** Default byte budget for the rendered rules segment. */
export const DEFAULT_RULES_MAX_BYTES = 16 * 1024
/** Default per-file cap for one rule source file. */
export const DEFAULT_RULES_MAX_SOURCE_BYTES = 256 * 1024

/** Workspace-rules source configuration. */
export interface RulesConfig {
  /** Load `<projectRoot>/.dsh/rules` at all; `false` drops this source. */
  enabled?: boolean
  /** Byte cap for the rendered rules segment, independent of the native chain's `maxBytes`. */
  maxBytes?: number
  /** Maximum UTF-8 bytes read from one rule file; larger files are skipped. */
  maxSourceBytes?: number
}

/** Plus configuration. */
export interface Config {
  /** Always-on workspace rules under `<projectRoot>/.dsh/rules`. */
  rules?: RulesConfig
}

/** Validated plugin configuration. */
export const Config: z<Config> = z.object({
  rules: z.object({
    enabled: z.boolean().default(true),
    maxBytes: z.number().step(1).default(DEFAULT_RULES_MAX_BYTES),
    maxSourceBytes: z.number().step(1).min(1).default(DEFAULT_RULES_MAX_SOURCE_BYTES),
  }).default({}),
})

/** Normalized rules configuration. */
export interface ResolvedRulesConfig {
  enabled: boolean
  maxBytes: number
  maxSourceBytes: number
}

/**
 * Apply the rules defaults for callers that bypass the schema.
 * @param config - optional rules section.
 * @returns the rules section with every field resolved.
 */
export function resolveRulesConfig(config: RulesConfig | undefined): ResolvedRulesConfig {
  return {
    enabled: config?.enabled ?? true,
    maxBytes: config?.maxBytes ?? DEFAULT_RULES_MAX_BYTES,
    maxSourceBytes: config?.maxSourceBytes ?? DEFAULT_RULES_MAX_SOURCE_BYTES,
  }
}
