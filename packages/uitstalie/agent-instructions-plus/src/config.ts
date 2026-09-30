/**
 * Plus configuration: the native workspace-instruction config passed through
 * verbatim, plus the always-on workspace-rules section.
 * @module @deepseek-ai/dsh-agent-instructions-plus/config
 */

import z from '@deepseek-ai/schemastery'
import { Config as AgentInstructionsSchema } from '@deepseek-ai/dsh-agent-instructions'
import type { AgentInstructionsConfig } from '@deepseek-ai/dsh-agent-instructions'

/** Default byte budget for the rendered rules segment. */
export const DEFAULT_RULES_MAX_BYTES = 16 * 1024
/** Default per-file cap for one rule source file. */
export const DEFAULT_RULES_MAX_SOURCE_BYTES = 256 * 1024

/** Workspace-rules section of the plus configuration. */
export interface RulesConfig {
  /** Load `<projectRoot>/.dsh/rules` at all; `false` leaves the native chain alone. */
  enabled?: boolean
  /** Byte cap for the rendered rules segment, independent of the native chain's `maxBytes`. */
  maxBytes?: number
  /** Maximum UTF-8 bytes read from one rule file; larger files are skipped. */
  maxSourceBytes?: number
}

/**
 * Plus configuration. The native section is the reused loader's own schema, so
 * its fields, defaults, and validation stay exactly native's.
 */
export interface Config {
  /** Native workspace-instruction loader configuration, forwarded unchanged. */
  agentInstructions: AgentInstructionsConfig
  /** Always-on workspace rules under `<projectRoot>/.dsh/rules`. */
  rules?: RulesConfig
}

/** Validated plugin configuration. */
export const Config: z<Config> = z.object({
  agentInstructions: AgentInstructionsSchema,
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
