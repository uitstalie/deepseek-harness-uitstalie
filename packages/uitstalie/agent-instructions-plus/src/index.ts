/**
 * `@deepseek-ai/dsh-agent-instructions-plus` package entry.
 *
 * The plugin itself is the next slice of task16; this entry publishes the
 * configuration and rules-discovery layer so it can be type-checked, built,
 * and tested on its own.
 * @module @deepseek-ai/dsh-agent-instructions-plus
 */

export { Config, resolveRulesConfig, DEFAULT_RULES_MAX_BYTES, DEFAULT_RULES_MAX_SOURCE_BYTES } from './config.ts'
export type { Config as PlusConfig, ResolvedRulesConfig, RulesConfig } from './config.ts'
export { RULES_DIRECTORY, rulesScanChanged, scanWorkspaceRules } from './rules.ts'
export type { RulesScan, RulesScanOptions } from './rules.ts'
