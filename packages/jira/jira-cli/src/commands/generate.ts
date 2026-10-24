/** cli/commands/generate — `jira generate [--check]`: refresh the derived files; --check for CI. */

import { booleanFlag } from '@deepseek-ai/dsh-jira-core/args.ts'
import { planGenerated, writeGenerated } from '@deepseek-ai/dsh-jira-core/generateStore.ts'
import { fail, type Handler } from '../runtime.ts'

export const generateCommand: Handler = async (ctx) => {
  const plan = await planGenerated(ctx.store, ctx.now())
  if (!plan.ok) return fail(ctx.io, plan.error, 1)

  if (booleanFlag(ctx.flags, 'check')) {
    // The CI assertion: recompute with the timestamps already on disk and compare. Nothing
    // is written, so a clean run leaves the working tree untouched.
    const stale = plan.value.entries
      .filter(entry => entry.action === 'write')
      .map(entry => Object.freeze({
        path: entry.path,
        reason: entry.existing === undefined ? 'missing' : 'stale',
      }))
    ctx.say(ctx.json
      ? { stale, sourceTree: plan.value.sourceTree }
      : (stale.length === 0
        ? '派生文件已是最新'
        : `派生文件已过期：\n${stale.map(entry => `  ${entry.path}（${entry.reason}）`).join('\n')}\n请运行：jira generate`))
    return stale.length === 0 ? 0 : 1
  }

  const written = await writeGenerated(ctx.store, plan.value)
  if (!written.ok) return fail(ctx.io, written.error, 1)
  ctx.say(ctx.json
    ? { ...written.value, sourceTree: plan.value.sourceTree }
    : `已生成 ${String(written.value.written.length)} 个文件，${String(written.value.unchanged.length)} 个已是最新`)
  return 0
}
