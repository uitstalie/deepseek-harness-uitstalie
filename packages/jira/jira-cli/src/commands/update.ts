/** cli/commands/update — `jira update <KEY>`: replace fields (decision 44's CAS is in the plan). */

import { optFlags } from '@deepseek-ai/dsh-jira-core/args.ts'
import { type IssuePatch, applyUpdate } from '@deepseek-ai/dsh-jira-core/mutate.ts'
import { ok } from '@deepseek-ai/dsh-jira-core/result.ts'
import { writeCommand, type Handler } from '../runtime.ts'

export const updateCommand: Handler = ctx =>
  writeCommand(ctx, 'update', async key =>
    ok({
      mutate: (issue, changeContext) => applyUpdate(issue, optFlags<IssuePatch>(ctx.flags, {
        summary: 'string',
        priority: 'string',
        tags: 'list',
        note: 'string',
        body: 'string',
        // The other direction of decision 75's cross reference.
        'kb-refs': { kind: 'list', to: 'kbRefs' },
      }), changeContext),
      what: 'update',
      line: tx => `${key} 已更新（版本 ${String(tx.change.issue.revision)}）`,
    }))
