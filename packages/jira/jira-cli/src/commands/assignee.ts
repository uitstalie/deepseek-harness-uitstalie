/** cli/commands/assignee — `jira assignee <KEY> [--set self|none] [--override]`: claim/release. */

import { booleanFlag, stringFlag } from '@deepseek-ai/dsh-jira-core/args.ts'
import { type Identity } from '@deepseek-ai/dsh-jira-core/entity.ts'
import { invalidInput } from '@deepseek-ai/dsh-jira-core/errors.ts'
import { blockersOf } from '@deepseek-ai/dsh-jira-core/inspect.ts'
import { applyAssignee } from '@deepseek-ai/dsh-jira-core/mutate.ts'
import { ok } from '@deepseek-ai/dsh-jira-core/result.ts'
import { type TransactOptions } from '@deepseek-ai/dsh-jira-core/store.ts'
import { planStore, planUsage, writeCommand, type Handler } from '../runtime.ts'

export const assigneeCommand: Handler = ctx =>
  writeCommand(ctx, 'assignee', async (key, actor) => {
    const wanted = stringFlag(ctx.flags, 'set') ?? 'self'
    if (wanted !== 'self' && wanted !== 'none') {
      return planUsage(invalidInput(`assignee --set 只接受 "self" 或 "none"，不接受 "${wanted}"`))
    }
    // Decision 24: the blockers come from the issue map, so they are computed here and
    // handed to the write transaction; an agent is refused, a human may override.
    let options: TransactOptions = {}
    if (wanted !== 'none') {
      const blockers = await blockersOf(ctx.store, key)
      if (!blockers.ok) return planStore(blockers.error)
      options = { blockers: blockers.value, override: booleanFlag(ctx.flags, 'override') === true }
    }
    return ok({
      mutate: (issue, changeContext) => applyAssignee(
        issue,
        wanted === 'none' ? null : (actor.by as Identity),
        changeContext,
      ),
      what: wanted === 'none' ? 'release' : 'claim',
      options,
      line: tx => `${key} ${wanted === 'none' ? '已释放' : `已认领给 ${String(tx.change.issue.assignee ?? '')}`}`,
    })
  })
