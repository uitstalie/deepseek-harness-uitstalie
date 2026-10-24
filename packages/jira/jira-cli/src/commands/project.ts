/**
 * cli/commands/project — `jira project [list|bind|rebind]`: the workspace bindings.
 *
 * Actions are small handlers under one table (decision 187); `cwd` is the injected working
 * directory, so `bind`/`rebind` default to "here" without reading `process` (§3.1 ①).
 */

import { stringFlag } from '@deepseek-ai/dsh-jira-core/args.ts'
import { invalidInput } from '@deepseek-ai/dsh-jira-core/errors.ts'
import { bindProject, listProjects, normalizePath, rebindProject, remoteIdentity, renderProjects } from '@deepseek-ai/dsh-jira-core/project.ts'
import { fail, type CommandContext, type Handler } from '../runtime.ts'

const listAction = async (ctx: CommandContext): Promise<number> => {
  const projects = await listProjects(ctx.store)
  if (!projects.ok) return fail(ctx.io, projects.error, 1)
  ctx.say(ctx.json ? projects.value : renderProjects(projects.value, ctx.cwd))
  return 0
}

const bindAction = async (ctx: CommandContext): Promise<number> => {
  const key = stringFlag(ctx.flags, 'key')
  if (key === undefined) return fail(ctx.io, invalidInput('project bind 需要 --key（例如 --key DH）'), 2)
  const path = stringFlag(ctx.flags, 'path') ?? ctx.cwd
  const remote = stringFlag(ctx.flags, 'remote')
  const bound = await bindProject(ctx.store, await ctx.actorFor(), {
    key,
    path,
    ...(remote === undefined ? {} : { remotes: [remote] }),
    ...(stringFlag(ctx.flags, 'name') === undefined ? {} : { name: stringFlag(ctx.flags, 'name') as string }),
  })
  if (!bound.ok) return fail(ctx.io, bound.error, 1)
  ctx.say(ctx.json
    ? bound.value
    : `${key} 已绑定到 ${normalizePath(path)}${bound.value.addedPath ? '' : '（之前已绑定）'}`
      + `\n身份：${remoteIdentity(bound.value.project.remotes) ?? '（无 remote 记录）'}`)
  return 0
}

const rebindAction = async (ctx: CommandContext): Promise<number> => {
  const from = stringFlag(ctx.flags, 'from')
  const to = stringFlag(ctx.flags, 'to')
  if (from === undefined || to === undefined) {
    return fail(ctx.io, invalidInput('project rebind 需要 --from 与 --to'), 2)
  }
  const path = stringFlag(ctx.flags, 'path') ?? ctx.cwd
  const rebound = await rebindProject(ctx.store, await ctx.actorFor(), { from, to, path })
  if (!rebound.ok) return fail(ctx.io, rebound.error, 1)
  ctx.say(ctx.json
    ? rebound.value
    : `${from} → ${to}：${normalizePath(path)} ${rebound.value.moved ? '已移动' : '本来没有绑定到源项目，现已加入目标项目'}`)
  return 0
}

const ACTIONS: Readonly<Record<string, (ctx: CommandContext) => Promise<number>>> = Object.freeze({
  list: listAction,
  bind: bindAction,
  rebind: rebindAction,
})

export const projectCommand: Handler = async (ctx) => {
  const action = ctx.positionals[0] ?? 'list'
  const handler = ACTIONS[action]
  if (handler === undefined) return fail(ctx.io, invalidInput(`未知的 project 动作 "${action}"（可选 list/bind/rebind）`), 2)
  return handler(ctx)
}
