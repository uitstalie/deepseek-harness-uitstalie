/** cli/commands/batch — `jira batch <KEY…> --resolution fixed [--comment …]` (decision 196). */

import { stringFlag } from '@deepseek-ai/dsh-jira-core/args.ts'
import { closeMany } from '@deepseek-ai/dsh-jira-core/batch.ts'
import { asIssueKey } from '@deepseek-ai/dsh-jira-core/entity.ts'
import { type JiraError, invalidInput } from '@deepseek-ai/dsh-jira-core/errors.ts'
import { CLOSE_NEEDS_RESOLUTION } from '@deepseek-ai/dsh-jira-core/messages.ts'
import { fail, type Handler } from '../runtime.ts'

export const batchCommand: Handler = async (ctx) => {
  const keys = ctx.positionals.map(raw => asIssueKey(raw))
  const invalid = ctx.positionals.filter((_raw, index) => keys[index] === undefined)
  if (invalid.length > 0) {
    return fail(ctx.io, invalidInput(`batch 需要 issue 键（例如 DH-1），这些不是：${invalid.join(', ')}`), 2)
  }
  const resolution = stringFlag(ctx.flags, 'resolution')
  if (resolution === undefined || resolution === '') return fail(ctx.io, invalidInput(CLOSE_NEEDS_RESOLUTION), 2)
  const comment = stringFlag(ctx.flags, 'comment')
  const note = stringFlag(ctx.flags, 'resolution-note')
  const to = stringFlag(ctx.flags, 'to')

  const result = await closeMany(ctx.store, keys as never[], await ctx.actorFor(), {
    resolution,
    ...(to === undefined ? {} : { to }),
    ...(note === undefined ? {} : { resolutionNote: note }),
    ...(comment === undefined ? {} : { comment }),
  })
  if (!result.ok) return fail(ctx.io, result.error, 1)
  if (result.value.partial !== undefined) {
    const partial: JiraError = invalidInput(
      `只关闭了 ${String(result.value.closed.length)} 条；${String(result.value.partial.failed.key)} 失败：${result.value.partial.failed.error.message}`,
      { closed: Object.freeze(result.value.closed) },
    )
    return fail(ctx.io, partial, 1)
  }
  ctx.say(ctx.json ? result.value : `已关闭 ${String(result.value.closed.length)} 条：${result.value.closed.join(', ')}`)
  return 0
}
