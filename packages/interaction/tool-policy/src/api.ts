/**
 * The soft tool policy (`ctx.toolPolicy`).
 *
 * This service owns named policy profiles and enforces their blacklists over
 * **model tool calls only**:
 *
 * - the monotonic `ctx.tools.guard()` denies a denied tool by name;
 * - `tool-fs` calls {@link ToolPolicyService.assertFileAccess} for every file
 *   operation, so read/write/edit/apply_patch targets are checked;
 * - per-agent `ctx.tools.restrict()` hides denied tools from the model schema;
 * - the `tool-policy` runtime context replaces the retired
 *   `Current DSH file policy: …` line and states the bypass surface;
 * - `/policy` selects a profile and records it in the reused
 *   `permission/preset` session event;
 * - the retired `DSH_PERMISSION_MODE` variable maps to a profile at load and is
 *   announced as deprecated.
 *
 * It is a **soft, best-effort policy, not an OS sandbox**: shell commands, PTC
 * code, MCP tools, and direct native file access are outside its reach.
 *
 * @module @deepseek-ai/dsh-tool-policy
 */

import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-commands'
import { canonicalizeTarget } from './canonicalize.ts'
import { installPolicyCommand } from './command.ts'
import { installToolGuard } from './guard.ts'
import { findDeniedPath } from './match.ts'
import type { PathDenial } from './match.ts'
import { LEGACY_PERMISSION_MODE_ENV, mapLegacyPermissionMode, prepareProfiles } from './profiles.ts'
import { renderToolPolicyPrompt } from './prompt.ts'
import { installVisibility } from './visibility.ts'
import type { Config, FileAccessOperation, PreparedProfile } from './types.ts'

export type * from './types.ts'
export {
  BUILTIN_PROFILES, DEFAULT_PROFILE, LEGACY_PERMISSION_MODE_ENV, mapLegacyPermissionMode,
} from './profiles.ts'
export { defaultCaseSensitive, canonicalizeTarget, compareKey, expandHome, isWithin } from './canonicalize.ts'
export { findDeniedPath } from './match.ts'
export { renderToolPolicyPrompt } from './prompt.ts'
export { applyVisibilityForAgent, restrictableDeny } from './visibility.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    toolPolicy: ToolPolicyService
  }
}

/**
 * Named soft-policy profiles over model tool calls. Requires the session
 * projection registry (the profile fold) and the agent registry (per-agent
 * visibility); the tools, prompt, and command registries are optional children.
 */
export class ToolPolicyService extends Service {
  // Inline schema call: the config catalog walks `static Config` statically.
  static Config = z.object({
    defaultProfile: z.string().default('guarded'),
    profiles: z.dict(z.object({
      description: z.string(),
      paths: z.array(z.object({
        path: z.string().required(),
        operations: z.array(z.union(['read', 'write', 'list'] as const)),
        includeSelf: z.boolean(),
        reason: z.string(),
      })).default([]),
      tools: z.array(z.object({
        name: z.string().required(),
        reason: z.string(),
      })).default([]),
    })).default({}),
  })

  static inject = ['sessionProjections']

  /** Deployment default profile name. */
  readonly defaultProfile: string
  private readonly profileMap: ReadonlyMap<string, PreparedProfile>
  private projectionHandle!: ProjectionHandle<string | null>

  constructor(ctx: Context, config: Config) {
    super(ctx, 'toolPolicy')
    const prepared = prepareProfiles(config)
    this.profileMap = prepared.profiles
    // The retired sandbox variable stays a one-release alias. It is honored
    // after config validation and announced, so a deployment that still exports
    // it learns which profile the process actually runs under.
    const legacyMode = process.env[LEGACY_PERMISSION_MODE_ENV]
    if (legacyMode === undefined) {
      this.defaultProfile = prepared.defaultProfile
    } else {
      const alias = mapLegacyPermissionMode(legacyMode)
      this.defaultProfile = prepared.profiles.has(alias) ? alias : prepared.defaultProfile
      ctx.logger.warn(
        `tool-policy: ${LEGACY_PERMISSION_MODE_ENV} is deprecated; selected profile "${this.defaultProfile}" for ${JSON.stringify(legacyMode)}`,
      )
    }
  }

  protected async [Service.init](): Promise<void> {
    const ctx = this.ctx
    this.projectionHandle = await ctx.sessionProjections.register({
      key: 'toolPolicyProfile',
      stateVersion: 1,
      stateSchema: zod.string().nullable(),
      init: () => null,
      apply: (state, event) => event.type === 'permission/preset' ? event.data.preset : state,
    })

    const stopVisibility = installVisibility(ctx, this)
    ctx.effect(() => () => { stopVisibility() })

    ctx.inject(['tools'], (scope) => {
      scope.effect(() => installToolGuard(scope, this))
    })

    ctx.inject(['systemPrompt'], (scope) => {
      scope.systemPrompt.context({
        name: 'tool-policy',
        order: scope.systemPrompt.getContextOrder('SANDBOX_POLICY'),
        text: (context) => {
          const session = context.agent?.session
          return session === undefined ? '' : renderToolPolicyPrompt(this.profileForSession(session))
        },
      })
    })

    installPolicyCommand(ctx, this)
  }

  /** Every profile name, in definition order. */
  get names(): readonly string[] {
    return [...this.profileMap.keys()]
  }

  /**
   * Whether a profile is defined.
   * @param name - candidate profile name.
   * @returns true when `/policy` may select it.
   */
  has(name: string): boolean {
    return this.profileMap.has(name)
  }

  /**
   * Look up a profile.
   * @param name - profile name.
   * @returns the prepared profile.
   * @throws when the name is unknown.
   */
  profile(name: string): PreparedProfile {
    const profile = this.profileMap.get(name)
    if (profile === undefined) {
      throw new Error(`tool-policy: unknown profile "${name}" (known: ${this.names.join(', ')})`)
    }
    return profile
  }

  /**
   * Resolve the profile in force for a session: the last reused
   * `permission/preset` name wins when it names a defined profile; otherwise
   * the deployment default. A retired permission preset (e.g.
   * `workspace-write`) is not a profile, so it falls back instead of throwing.
   * @param session - the calling session, if any.
   * @returns the prepared profile.
   */
  profileForSession(session: Session | undefined): PreparedProfile {
    if (session !== undefined) {
      const selected = this.projectionHandle.stateOf(session) ?? null
      if (selected !== null && this.profileMap.has(selected)) return this.profile(selected)
    }
    return this.profile(this.defaultProfile)
  }

  /**
   * Resolve the profile for an agent.
   * @param agent - the calling agent.
   * @returns the prepared profile.
   */
  profileForAgent(agent: Agent): PreparedProfile {
    return this.profileForSession(agent.session)
  }

  /**
   * Resolve the profile for one execution: its agent's session, or the
   * deployment default for an agentless call.
   * @param exec - the calling tool execution, if any.
   * @returns the prepared profile.
   */
  private profileForExec(exec: ToolExecution | undefined): PreparedProfile {
    return exec?.agent === undefined ? this.profileForSession(undefined) : this.profileForAgent(exec.agent)
  }

  /**
   * Denial reason for one tool call, used by the monotonic guard.
   * @param toolName - the model-visible tool name.
   * @param exec - the pending execution (its agent selects the profile).
   * @returns the model-facing denial reason, or undefined to allow.
   */
  toolDenialReason(toolName: string, exec?: ToolExecution): string | undefined {
    const profile = this.profileForExec(exec)
    const rule = profile.tools.find(candidate => candidate.name === toolName)
    if (rule === undefined) return undefined
    return `tool "${toolName}" is denied by DSH tool policy "${profile.name}"${rule.reason === undefined ? '' : `: ${rule.reason}`}`
  }

  /**
   * Canonicalize and check one file target without throwing on a denial.
   * @param operation - read, write, or list.
   * @param hostPath - the backend's process path for the target.
   * @param exec - the calling tool execution.
   * @returns the matched rule and target, or undefined when allowed.
   * @throws {FsError} `FS_POLICY_DENIED` when the path cannot be canonicalized.
   */
  checkFileAccess(operation: FileAccessOperation, hostPath: string, exec?: ToolExecution): PathDenial | undefined {
    const profile = this.profileForExec(exec)
    if (profile.paths.length === 0) return undefined
    // Remote/opaque targets are outside this local path policy; the soft policy
    // deliberately skips them instead of denying every remote read.
    if (!isAbsolute(hostPath)) return undefined
    let target
    try {
      target = canonicalizeTarget(hostPath, { home: homedir() })
    } catch (cause: unknown) {
      throw new FsError(
        `cannot verify "${hostPath}" against DSH tool policy "${profile.name}": ${String(cause)}`,
        'FS_POLICY_DENIED',
        { cause },
      )
    }
    return findDeniedPath(profile, operation, target)
  }

  /**
   * Assert that a file target may be touched under the calling session's
   * profile. Tool implementations call this after resolving the target.
   * @param operation - read, write, or list.
   * @param hostPath - the backend's process path for the target.
   * @param exec - the calling tool execution.
   * @throws {FsError} `FS_POLICY_DENIED` with the matched rule.
   */
  assertFileAccess(operation: FileAccessOperation, hostPath: string, exec?: ToolExecution): void {
    const denial = this.checkFileAccess(operation, hostPath, exec)
    if (denial === undefined) return
    const profile = this.profileForExec(exec)
    const operations = [...denial.rule.operations].join('/')
    const reason = denial.rule.reason === undefined ? '' : `; ${denial.rule.reason}`
    throw new FsError(
      `cannot ${operation} "${hostPath}": it is under the tool-policy denied path `
      + `"${denial.rule.displayPath}" (${operations}) in profile "${profile.name}"${reason}. `
      + 'This is a soft policy over model tool calls, not an OS sandbox.',
      'FS_POLICY_DENIED',
    )
  }

  /**
   * Select a profile for one session. The selection is durable through the
   * reused `permission/preset` event; the user command and authorized super-agent tool call this.
   * @param session - the session whose profile changes.
   * @param name - a defined profile name.
   * @param reason - optional audit reason retained on the profile event.
   */
  select(session: Session, name: string, reason?: string): void {
    this.profile(name)
    session.append('permission/preset', {
      preset: name,
      ...reason === undefined || reason.trim() === '' ? {} : { reason: reason.trim() },
    })
  }
}

export default ToolPolicyService
