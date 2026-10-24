/**
 * The always-on registrations the agent row makes beside the capability: the monotonic write
 * guard, the `/jira` command and the three bundled skills.
 *
 * Each function takes the registry it registers into, so a composition without one simply does
 * not call it. Nothing here reaches the ledger directly — the command reads through
 * `ctx.jira`, and the guard only classifies the call before the tool body runs.
 *
 * @module @deepseek-ai/dsh-jira-agent/wiring
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandRuntime } from '@deepseek-ai/dsh-commands'
import { ioFailed } from '@deepseek-ai/dsh-jira-core/errors.ts'
import { err, ok } from '@deepseek-ai/dsh-jira-core/result.ts'
import { system } from '@deepseek-ai/dsh-jira-core/system/index.ts'
import type { SkillRegistry } from '@deepseek-ai/dsh-skill'
import { createJiraCommand, type CommandOptions } from './command.ts'
import { type HostEnv } from './env.ts'
import { nowUtc } from './envelope.ts'
import { readPushFailure, stateDirOf } from './sessionRecord.ts'
import { packageRootFrom, registerSkills } from './skills.ts'
import { TOOL_NAME, WRITE_ACTIONS } from './toolIssue.ts'
import { callerOf } from './tools.ts'

/** The slash command this row owns. */
export const JIRA_COMMAND_NAME = 'jira'

/**
 * Install the monotonic write guard: a write the session may not perform is denied before the
 * handler runs, and no later plugin can force-allow it. The handlers refuse as well (defence in
 * depth, and that refusal is an ordinary tool result); the guard only decides earlier.
 * @param ctx - the plugin context; `ctx.tools` is the registry the guard registers with.
 * @param env - the process environment the read-only switch comes from.
 */
export const installWriteGuard = (ctx: Context, env: HostEnv): void => {
  ctx.tools.guard((execution) => {
    if (execution.name !== TOOL_NAME) return undefined
    const action = (execution.arguments as { action?: unknown } | undefined)?.action
    if (typeof action !== 'string' || !WRITE_ACTIONS.includes(action)) return undefined
    const caller = callerOf({ ctx, env }, execution.agent)
    if (caller.writable) return undefined
    return `dsh-jira: ${action} writes the ledger, and this session may not write (${caller.reason ?? 'read-only'})`
  })
}

/**
 * Register `/jira` against a composition's command registry.
 *
 * Every value the command reads is a closure, resolved at invocation time: the machine identity is
 * only resolved once the ledger service opens, and `/jira sync` must flush the service's own queue
 * rather than build a second one.
 * @param commands - the command registry to register with.
 * @param ctx - the plugin context the ledger service is read from.
 * @param env - the process environment the state directory is resolved from.
 * @param clock - the clock the command's audit timestamps are formatted from.
 * @returns the registry's disposer for this definition.
 */
export const registerJiraCommand = (
  commands: CommandRuntime,
  ctx: Context,
  env: HostEnv,
  clock: () => number,
): (() => void) => {
  const options: CommandOptions = Object.freeze({
    root: () => {
      const root = ctx.jira.root
      return root === '' ? err(ioFailed('cannot resolve the store root')) : ok(root)
    },
    machineId: () => ctx.jira.machineId,
    host: system.hostName(env),
    identity: () => `human:${ctx.jira.machineId}`,
    now: () => nowUtc(clock),
    sync: () => ctx.jira.sync(),
    writable: () => {
      const caller = callerOf({ ctx, env }, undefined)
      return caller.writable ? '本会话可以写' : `不能写（${caller.reason ?? 'read-only'}）`
    },
    pushStatus: async () => {
      const failure = await readPushFailure(stateDirOf(env, ctx.jira.root))
      return failure === undefined ? undefined : `上次推送失败（${failure.at}）：${failure.message}`
    },
  })
  return commands.register(createJiraCommand(options))
}

/**
 * Register the three bundled skills against a composition's skill registry.
 *
 * A missing skill file is skipped rather than fatal: a broken skill must never stop the tools
 * from working. The registration is awaited so a caller that composed the plugin can rely on the
 * catalogue holding the skills.
 * @param skills - the skill registry to register with.
 * @param moduleUrl - the plugin module's URL, from which the package root (and `skills/`) is derived.
 * @returns a promise that settles when every skill file was read and registered.
 */
export const registerJiraSkills = async (skills: SkillRegistry, moduleUrl: string): Promise<void> => {
  await registerSkills({ skills }, packageRootFrom(moduleUrl))
}
