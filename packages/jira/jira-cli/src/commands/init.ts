/** cli/commands/init — `jira init`: provision the store, and register this machine first. */

import { booleanFlag, stringFlag } from '@deepseek-ai/dsh-jira-core/args.ts'
import { resolveMachineId } from '@deepseek-ai/dsh-jira-core/machine.ts'
import { provisionStore } from '@deepseek-ai/dsh-jira-core/provision.ts'
import { fail, type Handler } from '../runtime.ts'

export const initCommand: Handler = async (ctx) => {
  const remote = stringFlag(ctx.flags, 'remote')
  const provisioned = await provisionStore({
    root: ctx.root,
    ...(remote === undefined ? {} : { remote }),
    pull: booleanFlag(ctx.flags, 'pull'),
  })
  if (!provisioned.ok) return fail(ctx.io, provisioned.error, 1)
  // The machine's identity is resolved here too, so a fresh machine is registered
  // before its first write (two machines sharing an id would claim the same block).
  const machine = await resolveMachineId({ env: ctx.env, fallbackRoot: ctx.root })
  const value = {
    ...provisioned.value,
    machine: machine.ok ? machine.value.id : undefined,
    machineSource: machine.ok ? machine.value.source : undefined,
  }
  ctx.say(ctx.json
    ? value
    : [
      `账本位于 ${provisioned.value.root}`,
      `动作：${provisioned.value.action}${provisioned.value.pulled === undefined ? '' : `（${provisioned.value.pulled}）`}`,
      provisioned.value.remote === undefined ? 'remote: 无（仅本地）' : `remote: ${provisioned.value.remote}`,
      `本机：${String(value.machine)}（${String(value.machineSource)}）`,
    ].join('\n'))
  return machine.ok ? 0 : fail(ctx.io, machine.error, 1)
}
