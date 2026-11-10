/**
 * Super-agent permission inspection and switching for one explicitly addressed workspace Session.
 * Existing permission services remain the writers; this module only resolves ownership, selects the
 * active composition, and verifies the committed result.
 *
 * @module @deepseek-ai/dsh-jira-agent/superagent-permission
 */

import type { FieldSpec } from '@deepseek-ai/dsh-jira-core'
import { invalidInput, validateArgs } from '@deepseek-ai/dsh-jira-core'
import { asString, failure, type RunOptions, type ToolValue } from './envelope.ts'
import { sameCheckout, type SessionControllerLike, sessionControllerOf, type WorkspaceLike, workspaceRegistryOf } from './superagent.ts'

/** The model-facing permission tool name. */
export const PERMISSION_TOOL_NAME = 'superagent_permission'

/** The soft selection maps to the existing baseline profile, never to an OS sandbox mode. */
export const SOFT_PERMISSION_PRESET = 'soft'
/** The existing profile selected by `soft`. */
export const SOFT_TOOL_PROFILE = 'guarded'
/** The explicit initial selection for workspace Sessions started by the super agent. */
export const WORKSPACE_SESSION_PERMISSION = 'workspace-write'

/** `superagent_permission`'s schema. */
export const PERMISSION_PARAMETERS: Readonly<Record<string, FieldSpec>> = Object.freeze({
  action: {
    type: 'string',
    required: true,
    description: 'list: show selectable presets and their actual enforcement mapping. get: read one '
      + 'Session. set: switch one Session and record the change; it takes effect on subsequent tool calls.',
    enum: ['list', 'get', 'set'],
  },
  workspace: { type: 'string', description: 'get/set: the exact registered workspace id, title, or path that owns the Session.' },
  session: { type: 'string', description: 'get/set: the exact Session id; required, never inferred or applied in bulk.' },
  preset: {
    type: 'string',
    description: 'set: a name returned by list. OS presets include read-only, workspace-write, and '
      + 'danger-full-access when configured. soft selects the guarded tool policy only in an '
      + 'unconfined soft-policy composition; it does not disable an active OS sandbox.',
  },
  reason: { type: 'string', description: 'set: why this Session needs the change; required before widening sandbox access or approval freedom.' },
})

/** `superagent_permission`'s model-facing behavior and safety boundary. */
export const PERMISSION_DESCRIPTION =
  'Inspect or change the permission of ONE Session in a named registered workspace. `list` needs no '
  + 'target; `get` and `set` require both `workspace` and an exact `session` id. New Sessions started '
  + 'with superagent_control explicitly use workspace-write. Use list before set: only registered '
  + 'names are accepted. `soft` means full process file access plus the guarded tool/path blacklist, '
  + 'not OS confinement; it is refused while an OS sandbox is active. Changes are durable and apply '
  + 'to subsequent tool calls. Widening access needs `reason`; no separate human approval is requested.'

interface SessionLike {
  readonly id: unknown
}

interface PermissionSelectionLike {
  readonly currentValue: string
  readonly sandboxMode?: string
  readonly approvalPolicy?: string
}

interface PermissionPresetsLike {
  readonly names: readonly string[]
  resolve(name: string): { readonly sandbox: string; readonly approval: string; readonly description?: string }
  current(session: SessionLike): string
  selection?(session: SessionLike): PermissionSelectionLike
  set(session: SessionLike, name: string, reason?: string): void
}

interface ToolPolicyLike {
  has(name: string): boolean
  profile(name: string): { readonly description: string }
  profileForSession(session: SessionLike): { readonly name: string; readonly description: string }
  select(session: SessionLike, name: string, reason?: string): void
}

interface PermissionTarget {
  readonly id: string
  readonly session: SessionLike
  readonly workspace: WorkspaceLike
}

interface PermissionOption {
  readonly preset: string
  readonly description: string
  readonly sandbox?: string
  readonly approval?: string
  readonly toolPolicy?: string
}

type TargetResolution = Readonly<{ target: PermissionTarget } | { error: string }>

/** Read a named optional host service without requiring it in every composition. */
function serviceOf<T>(ctx: unknown, name: string): T | undefined {
  const get = (ctx as { get?: (key: string) => unknown } | undefined)?.get
  return typeof get === 'function' ? get.call(ctx, name) as T | undefined : undefined
}

/**
 * Resolve a registered workspace and prove that the exact Session belongs to it.
 * @param ctx - the plugin context supplying the workspace registry.
 * @param controller - the host Session controller used to list and resolve the target.
 * @param workspaceArg - the registered workspace id, title, or path.
 * @param sessionArg - the exact target Session id; `latest` is not accepted.
 * @returns the resolved target, or an error before any permission changes.
 */
export async function resolvePermissionTarget(
  ctx: unknown,
  controller: SessionControllerLike,
  workspaceArg: string | undefined,
  sessionArg: string | undefined,
): Promise<TargetResolution> {
  if (workspaceArg === undefined || workspaceArg.trim() === '') return { error: 'get/set needs `workspace`: the registered workspace that owns the Session' }
  if (sessionArg === undefined || sessionArg.trim() === '' || sessionArg.trim() === 'latest') {
    return { error: 'get/set needs `session`: one exact Session id; permission changes never infer a target' }
  }
  const registry = workspaceRegistryOf(ctx)
  if (registry === undefined) return { error: 'this deployment has no workspace registry' }
  const needle = workspaceArg.trim()
  const workspace = registry.list().find(row => row.id === needle || row.title === needle || row.path === needle)
    ?? registry.list().find(row => sameCheckout(row.path, needle))
  if (workspace === undefined) return { error: `"${needle}" is not a registered workspace` }
  const id = sessionArg.trim()
  const listed = await controller.list()
  const owned = listed.items.some(item => String(item.sessionId) === id && item.cwd !== undefined && sameCheckout(item.cwd, workspace.path))
  if (!owned) return { error: `"${id}" is not a Session of "${workspace.title}"; no permission was changed` }
  if (controller.resolveAgent === undefined) return { error: 'this host cannot resolve the target Session, so its permission cannot be changed or read' }
  const resolved = await controller.resolveAgent(id)
  const agent = resolved.agent as { session?: SessionLike } | undefined
  if (agent?.session === undefined) return { error: `the Session could not be resolved: ${String(resolved.error ?? 'unknown')}` }
  return { target: { id, session: agent.session, workspace } }
}

/**
 * List every permission preset this composition can actually select.
 * @param ctx - the plugin context carrying the sandbox or soft-policy services.
 * @returns the supported preset options in service declaration order.
 */
export function permissionOptions(ctx: unknown): readonly PermissionOption[] {
  const presets = serviceOf(ctx, 'sandboxPolicy') === undefined ? undefined : serviceOf<PermissionPresetsLike>(ctx, 'permissionPresets')
  const options: PermissionOption[] = (presets?.names ?? []).map((preset) => {
    const spec = presets?.resolve(preset)
    return {
      preset,
      description: spec?.description ?? `${spec?.sandbox ?? 'unknown'} sandbox; ${spec?.approval ?? 'unknown'} approval`,
      ...spec === undefined ? {} : { sandbox: spec.sandbox, approval: spec.approval },
    }
  })
  const toolPolicy = serviceOf<ToolPolicyLike>(ctx, 'toolPolicy')
  if (serviceOf(ctx, 'sandboxPolicy') === undefined && toolPolicy?.has(SOFT_TOOL_PROFILE) === true) {
    options.push({
      preset: SOFT_PERMISSION_PRESET,
      description: 'Full process file access with tool and path blacklists; no OS sandbox. Shell and other process access can bypass path checks.',
      sandbox: 'unconfined',
      toolPolicy: SOFT_TOOL_PROFILE,
    })
  }
  return options
}

/** Read both effective knobs, not only the last preset label. */
function sandboxState(presets: PermissionPresetsLike, session: SessionLike): PermissionSelectionLike {
  return presets.selection?.(session) ?? { currentValue: presets.current(session) }
}

/** The current permission of a resolved target. */
function currentPermission(ctx: unknown, target: PermissionTarget): Readonly<Record<string, unknown>> {
  const presets = serviceOf<PermissionPresetsLike>(ctx, 'permissionPresets')
  if (presets !== undefined && serviceOf(ctx, 'sandboxPolicy') !== undefined) {
    const current = sandboxState(presets, target.session)
    return {
      workspace: target.workspace.path,
      session: target.id,
      kind: 'os-sandbox',
      preset: current.currentValue,
      ...(current.sandboxMode === undefined ? {} : { sandbox: current.sandboxMode }),
      ...(current.approvalPolicy === undefined ? {} : { approval: current.approvalPolicy }),
    }
  }
  const toolPolicy = serviceOf<ToolPolicyLike>(ctx, 'toolPolicy')
  if (toolPolicy !== undefined) {
    const profile = toolPolicy.profileForSession(target.session)
    return {
      workspace: target.workspace.path,
      session: target.id,
      kind: 'soft-policy',
      preset: profile.name === SOFT_TOOL_PROFILE ? SOFT_PERMISSION_PRESET : profile.name,
      sandbox: 'unconfined',
      toolPolicy: profile.name,
      description: profile.description,
    }
  }
  return { workspace: target.workspace.path, session: target.id, kind: 'unavailable' }
}

const SANDBOX_RANK: Readonly<Record<string, number>> = Object.freeze({ 'read-only': 0, 'workspace-write': 1, 'danger-full-access': 2 })

/** Whether the requested change grants broader file access or fewer approval prompts. */
function permissionWidens(before: PermissionSelectionLike | undefined, next: { sandbox: string; approval: string }): boolean {
  if (before?.sandboxMode === undefined || before.approvalPolicy === undefined) return true
  const previousRank = SANDBOX_RANK[before.sandboxMode]
  const nextRank = SANDBOX_RANK[next.sandbox]
  return previousRank === undefined || nextRank === undefined || nextRank > previousRank
    || (before.approvalPolicy === 'ask' && next.approval === 'never')
}

/**
 * Apply and verify one new or existing Session's permission.
 * @param ctx - the plugin context carrying the workspace and permission services.
 * @param controller - the host Session controller used to resolve the target.
 * @param workspace - the registered workspace owning the Session.
 * @param session - the exact Session whose permission is changing.
 * @param preset - the selected permission preset.
 * @param reason - the audit reason required when access widens.
 * @returns the committed state, or an error before any dependent prompt may be sent.
 */
export async function applySessionPermission(
  ctx: unknown,
  controller: SessionControllerLike,
  workspace: string,
  session: string,
  preset: string,
  reason?: string,
): Promise<Readonly<{ permission?: Readonly<Record<string, unknown>>; error?: string }>> {
  const resolved = await resolvePermissionTarget(ctx, controller, workspace, session)
  if ('error' in resolved) return { error: resolved.error }
  const target = resolved.target
  const options = permissionOptions(ctx)
  const option = options.find(candidate => candidate.preset === preset)
  if (option === undefined) {
    return { error: `unknown or unavailable permission preset "${preset}" (available: ${options.map(row => row.preset).join(', ') || 'none'})` }
  }
  if (preset === SOFT_PERMISSION_PRESET) {
    if (serviceOf(ctx, 'sandboxPolicy') !== undefined) {
      return { error: 'soft requires the unconfined soft-policy composition; it cannot disable this Session\'s active OS sandbox' }
    }
    const toolPolicy = serviceOf<ToolPolicyLike>(ctx, 'toolPolicy')
    if (toolPolicy?.has(SOFT_TOOL_PROFILE) !== true) return { error: 'soft is unavailable: the guarded tool-policy profile is not mounted' }
    if (reason === undefined || reason.trim() === '') return { error: 'switching to soft needs `reason`: it has full process file access and no OS sandbox' }
    toolPolicy.select(target.session, SOFT_TOOL_PROFILE, reason)
    if (toolPolicy.profileForSession(target.session).name !== SOFT_TOOL_PROFILE) {
      return { error: 'the soft policy did not take effect; no success is reported' }
    }
    return { permission: currentPermission(ctx, target) }
  }
  const presets = serviceOf(ctx, 'sandboxPolicy') === undefined ? undefined : serviceOf<PermissionPresetsLike>(ctx, 'permissionPresets')
  if (presets === undefined) return { error: `permission preset "${preset}" needs the active sandboxPolicy and permissionPresets services; a soft-policy composition cannot enable OS sandboxing per Session` }
  const before = sandboxState(presets, target.session)
  const spec = presets.resolve(preset)
  if (permissionWidens(before, spec) && (reason === undefined || reason.trim() === '')) {
    return { error: `widening permission to "${preset}" needs \`reason\`` }
  }
  presets.set(target.session, preset, reason)
  const after = sandboxState(presets, target.session)
  if (after.currentValue !== preset || after.sandboxMode !== spec.sandbox || after.approvalPolicy !== spec.approval) {
    return { error: `permission preset "${preset}" was not fully committed; current state is ${JSON.stringify(after)}` }
  }
  return { permission: currentPermission(ctx, target) }
}

/**
 * Run `superagent_permission`. Only the capability's super-agent tool roster exposes this runner.
 * @param args - raw model arguments.
 * @param options - the caller's existing write verdict.
 * @param me - the caller identity tuple echoed in the result.
 * @param ctx - the Host context carrying existing permission services.
 * @returns available presets, the current target state, or a verified switch outcome.
 */
export async function runPermissionTool(args: unknown, options: RunOptions, me: unknown, ctx: unknown): Promise<ToolValue> {
  const validated = validateArgs(PERMISSION_PARAMETERS, args)
  if (!validated.ok) return failure(validated.error, options.caller, me)
  const action = asString(validated.value.action)
  if (action === 'list') {
    const presets = permissionOptions(ctx)
    return Object.freeze({
      ok: true,
      writable: options.caller.writable,
      me,
      presets: Object.freeze(presets),
      defaultPreset: WORKSPACE_SESSION_PERMISSION,
      ...(presets.length === 0 ? { message: 'No supported permission service is mounted.' } : {}),
    })
  }
  if (!options.caller.writable) return failure(invalidInput('changing or resolving another Session needs a writable super agent Session'), options.caller, me)
  const workspace = asString(validated.value.workspace)
  const session = asString(validated.value.session)
  const preset = asString(validated.value.preset)
  const reason = asString(validated.value.reason)
  try {
    const controller = sessionControllerOf(ctx)
    if (controller === undefined) return failure(invalidInput('this deployment has no Session controller'), options.caller, me)
    if (action === 'get') {
      const resolved = await resolvePermissionTarget(ctx, controller, workspace, session)
      if ('error' in resolved) return failure(invalidInput(resolved.error), options.caller, me)
      return Object.freeze({ ok: true, writable: options.caller.writable, me, permission: currentPermission(ctx, resolved.target) })
    }
    if (preset === undefined || preset.trim() === '') return failure(invalidInput('set needs `preset` from superagent_permission list'), options.caller, me)
    const applied = await applySessionPermission(ctx, controller, workspace ?? '', session ?? '', preset.trim(), reason)
    if (applied.error !== undefined || applied.permission === undefined) {
      return failure(invalidInput(applied.error ?? 'the permission did not change'), options.caller, me)
    }
    return Object.freeze({ ok: true, writable: options.caller.writable, me, permission: applied.permission })
  } catch (error: unknown) {
    return failure(invalidInput(`the permission action failed: ${error instanceof Error ? error.message : String(error)}`), options.caller, me)
  }
}
