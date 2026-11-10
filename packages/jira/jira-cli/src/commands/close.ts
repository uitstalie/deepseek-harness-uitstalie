/** cli/commands/close — `jira close <KEY> --resolution fixed [--note …] [--comment …]` (decision 193). */

import { stringFlag } from '@deepseek-ai/dsh-jira-core'
import { invalidInput } from '@deepseek-ai/dsh-jira-core'
import { CLOSE_NEEDS_RESOLUTION, committedSuffix } from '@deepseek-ai/dsh-jira-core'
import { applyClose } from '@deepseek-ai/dsh-jira-core'
import { ok } from '@deepseek-ai/dsh-jira-core'
import { planUsage, writeCommand, type Handler } from '../runtime.ts'

export const closeCommand: Handler = ctx =>
  writeCommand(ctx, 'close', (key) => {
    const resolution = stringFlag(ctx.flags, 'resolution')
    if (resolution === undefined || resolution === '') return planUsage(invalidInput(CLOSE_NEEDS_RESOLUTION))
    const to = stringFlag(ctx.flags, 'to')
    const note = stringFlag(ctx.flags, 'resolution-note')
    const comment = stringFlag(ctx.flags, 'comment')
    return ok({
      mutate: (issue, changeContext) => applyClose(issue, {
        ...(to === undefined ? {} : { to }),
        resolution,
        ...(note === undefined ? {} : { resolutionNote: note }),
        ...(comment === undefined ? {} : { comment }),
      }, changeContext),
      what: 'close',
      line: tx => `${key} 已关闭（${resolution}）${committedSuffix(tx.committed)}`,
    })
  })
