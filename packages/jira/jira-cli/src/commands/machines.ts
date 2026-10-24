/**
 * cli/commands/machines — `jira machines [list|label]`: the machine registry.
 *
 * Each action is its own small handler; the dispatch is the table below, so adding an action
 * is adding a row (decision 187).
 */

import { stringFlag } from '@deepseek-ai/dsh-jira-core/args.ts'
import { invalidInput } from '@deepseek-ai/dsh-jira-core/errors.ts'
import { claimNoticeOnce, machineStateDir } from '@deepseek-ai/dsh-jira-core/machine.ts'
import { labelMachine, listMachines, machinesHint, renderMachines } from '@deepseek-ai/dsh-jira-core/machines.ts'
import { fail, machineOf, type CommandContext, type Handler } from '../runtime.ts'

const listAction = async (ctx: CommandContext): Promise<number> => {
  const records = await listMachines(ctx.store)
  if (!records.ok) return fail(ctx.io, records.error, 1)
  const self = await machineOf(ctx.env, ctx.root)
  ctx.say(ctx.json ? records.value : renderMachines(records.value, self))
  const hint = machinesHint(records.value, self)
  // Decision 91/150: once per machine, and never in `--json` (stdout has to stay parseable).
  if (!ctx.json && hint !== undefined && await claimNoticeOnce(machineStateDir(ctx.env, ctx.root), self, 'machines-label')) {
    ctx.say(hint)
  }
  return 0
}

const labelAction = async (ctx: CommandContext): Promise<number> => {
  const name = stringFlag(ctx.flags, 'name')
  if (name === undefined || name.trim() === '') {
    return fail(ctx.io, invalidInput('machines label 需要 --name（例如 --name workstation）'), 2)
  }
  const self = await machineOf(ctx.env, ctx.root)
  const labelled = await labelMachine(ctx.store, await ctx.actorFor(), self, {
    label: name,
    ...(stringFlag(ctx.flags, 'os') === undefined ? {} : { os: stringFlag(ctx.flags, 'os') as string }),
    ...(stringFlag(ctx.flags, 'note') === undefined ? {} : { note: stringFlag(ctx.flags, 'note') as string }),
  })
  if (!labelled.ok) return fail(ctx.io, labelled.error, 1)
  ctx.say(ctx.json ? labelled.value : `${self} 已标记为「${String(labelled.value.label)}」`)
  return 0
}

const ACTIONS: Readonly<Record<string, (ctx: CommandContext) => Promise<number>>> = Object.freeze({
  list: listAction,
  label: labelAction,
})

export const machinesCommand: Handler = async (ctx) => {
  const action = ctx.positionals[0] ?? 'list'
  const handler = ACTIONS[action]
  if (handler === undefined) return fail(ctx.io, invalidInput(`未知的 machines 动作 "${action}"（可选 list/label）`), 2)
  return handler(ctx)
}
