/**
 * Built-in profiles and config validation for the soft tool policy.
 *
 * The baseline is deliberately narrow: credential stores, the DSH home, plus
 * the PTC code tool (which can bypass every file-tool check). It does not deny
 * the workspace, `node_modules`, the editor's temp files, or the whole home, so
 * package installs and ordinary editing keep working.
 *
 * @module @deepseek-ai/dsh-tool-policy/profiles
 */

import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'
import { canonicalizeTarget, expandHome } from './canonicalize.ts'
import { FILE_ACCESS_OPERATIONS } from './types.ts'
import type {
  Config, FileAccessOperation, PreparedPathRule, PreparedProfile, PreparedToolRule, ProfileConfig,
} from './types.ts'

/** Paths every `guarded` profile denies to model file tools. */
const BASELINE_PATHS: readonly string[] = [
  '~/.ssh',
  '~/.gnupg',
  '~/.aws',
  '~/.config/gh',
  '~/.kube',
  '~/.docker',
  '~/.dsh',
]

/** A short reason for the PTC denial, repeated in the default profiles. */
const RUN_CODE_REASON = 'PTC code executes with full process access and can bypass the file-tool path policy.'

/** A short reason for the shell denials. */
const SHELL_REASON = 'The shell can reach any path the process can; the soft policy does not inspect commands.'

/** Tools every `files-read-only` profile denies. */
const READ_ONLY_DENIED_TOOLS: readonly string[] = [
  'write',
  'edit',
  'apply_patch',
  'str_replace_editor',
  'bash',
  'pwsh',
  'run_code',
]

/** Shipped profiles, overridable by the plugin config. */
export const BUILTIN_PROFILES: Readonly<Record<string, ProfileConfig>> = Object.freeze({
  unrestricted: Object.freeze({
    description: 'No file-tool path denials; the process is not OS-confined.',
    paths: [],
    tools: [],
  }),
  guarded: Object.freeze({
    description: 'Baseline soft policy: credential/DSH paths are denied to file tools; run_code is disabled.',
    paths: Object.freeze(BASELINE_PATHS.map(path => Object.freeze({ path }))),
    tools: Object.freeze([Object.freeze({ name: 'run_code', reason: RUN_CODE_REASON })]),
  }),
  'guarded-no-shell': Object.freeze({
    description: 'guarded plus the shell tools (bash, pwsh) and run_code are disabled.',
    paths: Object.freeze(BASELINE_PATHS.map(path => Object.freeze({ path }))),
    tools: Object.freeze([
      Object.freeze({ name: 'run_code', reason: RUN_CODE_REASON }),
      Object.freeze({ name: 'bash', reason: SHELL_REASON }),
      Object.freeze({ name: 'pwsh', reason: SHELL_REASON }),
    ]),
  }),
  'files-read-only': Object.freeze({
    description: 'File mutations, shell, and PTC code are denied; reads are allowed.',
    paths: [],
    tools: Object.freeze(READ_ONLY_DENIED_TOOLS.map(name => Object.freeze({ name }))),
  }),
})

/** The default profile name when the config does not name one. */
export const DEFAULT_PROFILE = 'guarded'

/** A validated profile set plus the deployment default. */
export interface PreparedProfiles {
  readonly profiles: ReadonlyMap<string, PreparedProfile>
  readonly defaultProfile: string
}

function assertKnownOperation(operation: unknown, profile: string, index: number): FileAccessOperation {
  if (operation !== 'read' && operation !== 'write' && operation !== 'list') {
    throw new Error(`tool-policy: profile "${profile}" path rule ${index} has unknown operation ${JSON.stringify(operation)}`)
  }
  return operation
}

function preparePathRules(name: string, profile: ProfileConfig, home: string): readonly PreparedPathRule[] {
  const rules = profile.paths ?? []
  return rules.map((rule, index) => {
    if (typeof rule.path !== 'string' || rule.path.trim() === '') {
      throw new Error(`tool-policy: profile "${name}" path rule ${index} needs a non-empty "path"`)
    }
    const expanded = expandHome(rule.path, home)
    if (!isAbsolute(expanded)) {
      throw new Error(`tool-policy: profile "${name}" path rule ${JSON.stringify(rule.path)} must be absolute or start with "~"`)
    }
    const canonical = canonicalizeTarget(expanded, { home, resolvePhysical: true })
    const operations = rule.operations === undefined || rule.operations.length === 0
      ? new Set<FileAccessOperation>(FILE_ACCESS_OPERATIONS)
      : new Set(rule.operations.map((operation, operationIndex) => assertKnownOperation(operation, name, operationIndex)))
    return {
      displayPath: rule.path,
      lexical: canonical.lexical,
      ...canonical.physical === undefined ? {} : { physical: canonical.physical },
      operations,
      includeSelf: rule.includeSelf ?? true,
      ...rule.reason === undefined ? {} : { reason: rule.reason },
    }
  })
}

function prepareToolRules(name: string, profile: ProfileConfig): readonly PreparedToolRule[] {
  const seen = new Set<string>()
  return (profile.tools ?? []).map((rule, index) => {
    if (typeof rule.name !== 'string' || rule.name.trim() === '') {
      throw new Error(`tool-policy: profile "${name}" tool rule ${index} needs a non-empty "name"`)
    }
    if (seen.has(rule.name)) {
      throw new Error(`tool-policy: profile "${name}" lists tool ${JSON.stringify(rule.name)} more than once`)
    }
    seen.add(rule.name)
    return { name: rule.name, ...rule.reason === undefined ? {} : { reason: rule.reason } }
  })
}

function prepareProfile(name: string, profile: ProfileConfig, home: string): PreparedProfile {
  if (name.trim() === '') throw new Error('tool-policy: profile names must be non-empty')
  return {
    name,
    description: profile.description ?? name,
    paths: preparePathRules(name, profile, home),
    tools: prepareToolRules(name, profile),
  }
}

/**
 * Merge the built-ins with the configured profiles and validate them.
 * A configured entry whose key matches a built-in replaces that profile
 * wholesale (it does not append to the built-in's lists).
 * @param config - plugin config.
 * @param home - home directory used for `~`; injectable for tests.
 * @returns the prepared profiles and the validated default name.
 * @throws when a profile, path, operation, tool name, or the default is invalid.
 */
export function prepareProfiles(config: Config, home: string = homedir()): PreparedProfiles {
  const merged: Record<string, ProfileConfig> = { ...BUILTIN_PROFILES, ...config.profiles }
  const profiles = new Map<string, PreparedProfile>()
  for (const [name, profile] of Object.entries(merged)) {
    profiles.set(name, prepareProfile(name, profile, home))
  }
  const defaultProfile = config.defaultProfile ?? DEFAULT_PROFILE
  if (!profiles.has(defaultProfile)) {
    throw new Error(`tool-policy: defaultProfile ${JSON.stringify(defaultProfile)} is not a defined profile (known: ${[...profiles.keys()].join(', ')})`)
  }
  return { profiles, defaultProfile }
}
