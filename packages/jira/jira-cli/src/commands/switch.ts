/** cli/commands/switch — `jira switch <KEY> --to …`: walk a declared transition. */

import { optFlags, stringFlag } from '@deepseek-ai/dsh-jira-core'
import { invalidInput } from '@deepseek-ai/dsh-jira-core'
import { type TransitionOptions, applyTransition } from '@deepseek-ai/dsh-jira-core'
import { ok } from '@deepseek-ai/dsh-jira-core'
import { planUsage, writeCommand, type Handler } from '../runtime.ts'

export const switchCommand: Handler = ctx =>
  writeCommand(ctx, 'switch', async (key) => {
    const to = stringFlag(ctx.flags, 'to')
    if (to === undefined || to === '') return planUsage(invalidInput('switch 需要 --to'))
    return ok({
      mutate: (issue, changeContext) => applyTransition(issue, to, optFlags<TransitionOptions>(ctx.flags, {
        resolution: 'string',
        'resolution-note': { kind: 'string', to: 'resolutionNote' },
      }), changeContext),
      what: 'switch_state',
      line: tx => `${key} → ${to}${tx.committed ? '（已提交）' : ''}`,
    })
  })
