/** cli/commands/link — `jira link <KEY> --type … --target … [--remove]`: add/remove a link. */

import { booleanFlag, stringFlag } from '@deepseek-ai/dsh-jira-core/args.ts'
import { type LinkType, asIssueKey } from '@deepseek-ai/dsh-jira-core/entity.ts'
import { invalidInput } from '@deepseek-ai/dsh-jira-core/errors.ts'
import { applyLink } from '@deepseek-ai/dsh-jira-core/mutate.ts'
import { ok } from '@deepseek-ai/dsh-jira-core/result.ts'
import { planUsage, writeCommand, type Handler } from '../runtime.ts'

export const linkCommand: Handler = ctx =>
  writeCommand(ctx, 'link', async (key) => {
    const type = stringFlag(ctx.flags, 'type')
    const target = asIssueKey(stringFlag(ctx.flags, 'target') ?? '')
    if (type === undefined) return planUsage(invalidInput('link 需要 --type（例如 --type is_blocked_by）'))
    if (target === undefined) return planUsage(invalidInput('link 需要 --target <KEY>'))
    const op = booleanFlag(ctx.flags, 'remove') === true ? 'remove' : 'add'
    return ok({
      mutate: (issue, changeContext) => applyLink(
        issue,
        { type: type as LinkType, target: target as never, op },
        changeContext,
      ),
      what: `link ${op}`,
      line: () => `${key} ${op === 'remove' ? '已解除链接' : '已链接到'} ${String(target)}（${type}）`,
    })
  })
