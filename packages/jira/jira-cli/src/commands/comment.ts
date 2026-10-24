/** cli/commands/comment — `jira comment <KEY> --body …`: append a comment (never deleted). */

import { stringFlag } from '@deepseek-ai/dsh-jira-core/args.ts'
import { invalidInput } from '@deepseek-ai/dsh-jira-core/errors.ts'
import { applyComment } from '@deepseek-ai/dsh-jira-core/mutate.ts'
import { ok } from '@deepseek-ai/dsh-jira-core/result.ts'
import { planUsage, writeCommand, type Handler } from '../runtime.ts'

export const commentCommand: Handler = ctx =>
  writeCommand(ctx, 'comment', async (key) => {
    const body = stringFlag(ctx.flags, 'body')
    if (body === undefined || body === '') return planUsage(invalidInput('comment 需要 --body'))
    return ok({
      mutate: (issue, changeContext) => applyComment(issue, body, changeContext),
      what: 'comment',
      jsonValue: tx => tx.appended,
      line: tx => `已在 ${key} 上追加评论（${String(tx.appended.length)} 条）`,
    })
  })
