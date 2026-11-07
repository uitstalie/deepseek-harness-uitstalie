/**
 * Public vocabulary for the soft tool policy: config shapes, prepared profile
 * shapes, and the file-operation axis a path rule can deny.
 *
 * The policy is a **soft, best-effort** layer over model tool calls. It is not
 * an OS sandbox and cannot stop shell commands, PTC code, MCP tools, or any
 * service that calls `node:fs` directly.
 *
 * @module @deepseek-ai/dsh-tool-policy/types
 */

// The session profile reuses the `permission/preset` event owned by
// `@deepseek-ai/dsh-permission-presets` (the selected preset or profile name),
// so an older build can replay this session without an unknown event type.
// Type-only: the preset service is absent wherever the soft-policy overlay
// disables it, and the policy needs no value from it.
import type {} from '@deepseek-ai/dsh-permission-presets'

/** A model file operation a path rule can deny. */
export type FileAccessOperation = 'read' | 'write' | 'list'

/** Every file operation, in a stable order for prompts and diagnostics. */
export const FILE_ACCESS_OPERATIONS: readonly FileAccessOperation[] = ['read', 'write', 'list']

/**
 * One configured path deny rule. Matching is by canonical path prefix, on both
 * the lexical and the physical (symlink-resolved) spelling.
 */
export interface PathRuleConfig {
  /** Absolute path or a leading `~`; canonicalized when the profile is prepared. */
  path: string
  /** Operations to deny (default: every operation). */
  operations?: readonly FileAccessOperation[]
  /** Whether the path itself is denied (default: true). */
  includeSelf?: boolean
  /** Optional model-facing explanation appended to the denial. */
  reason?: string
}

/** One configured tool deny rule. Names are exact and case-sensitive. */
export interface ToolRuleConfig {
  /** Exact model-visible tool name. */
  name: string
  /** Optional model-facing explanation appended to the denial. */
  reason?: string
}

/** One named policy profile as configured in `cordis.yml`. */
export interface ProfileConfig {
  /** One sentence shown by `/policy` and in the prompt. */
  description?: string
  /** Path prefixes denied for the listed operations. */
  paths?: readonly PathRuleConfig[]
  /** Tools denied for the whole call, independent of arguments. */
  tools?: readonly ToolRuleConfig[]
}

/** Plugin config: named profiles plus the deployment default. */
export interface Config {
  /** Profile a session starts from (default: `guarded`). */
  defaultProfile?: string
  /** Profiles; entries merge over the built-ins and may override them. */
  profiles?: Record<string, ProfileConfig>
}

/** A path rule after `~` expansion and canonicalization. */
export interface PreparedPathRule {
  /** The configured spelling, kept for prompts (`~/.ssh`). */
  displayPath: string
  /** Canonical lexical path. */
  lexical: string
  /** Canonical physical path when it exists. */
  physical?: string
  /** Operations this rule denies. */
  operations: ReadonlySet<FileAccessOperation>
  /** Whether the rule's own root is denied. */
  includeSelf: boolean
  /** Optional explanation. */
  reason?: string
}

/** A tool rule after validation. */
export interface PreparedToolRule {
  /** Exact model-visible tool name. */
  name: string
  /** Optional explanation. */
  reason?: string
}

/** One named profile after validation. */
export interface PreparedProfile {
  /** Profile name (`guarded`, `unrestricted`, …). */
  name: string
  /** One-sentence description. */
  description: string
  /** Prepared path rules. */
  paths: readonly PreparedPathRule[]
  /** Prepared tool rules. */
  tools: readonly PreparedToolRule[]
}

/** One canonical target, used by matching and tests. */
export interface CanonicalTarget {
  /** Path after `~`/relative/`..` normalization. */
  lexical: string
  /** Physical path (nearest existing ancestor resolved) when available. */
  physical?: string
  /** Platform whose path grammar was used. */
  platform: NodeJS.Platform
  /** Comparison case sensitivity for this target. */
  caseSensitive: boolean
}
