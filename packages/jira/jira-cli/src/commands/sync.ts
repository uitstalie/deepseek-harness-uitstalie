/**
 * cli/commands/sync — `jira sync`: pull --rebase, settle the derived files, push (decisions
 * 119/148). This is a human command on a store they own, so the settle step is always allowed.
 */

import { formatError } from '@deepseek-ai/dsh-jira-core/errors.ts'
import { aheadBehind, hasRemote, runGit } from '@deepseek-ai/dsh-jira-core/git.ts'
import { syncPushLine } from '@deepseek-ai/dsh-jira-core/messages.ts'
import { regenerateAndCommit } from '@deepseek-ai/dsh-jira-core/generateStore.ts'
import { createPushQueue } from '@deepseek-ai/dsh-jira-core/push.ts'
import { pullRebase } from '@deepseek-ai/dsh-jira-core/rebase.ts'
import { type Handler } from '../runtime.ts'

export const syncCommand: Handler = async (ctx) => {
  const actor = await ctx.actorFor()
  const queue = createPushQueue({
    root: ctx.root,
    pull: () => pullRebase(ctx.store, actor),
    settle: () => regenerateAndCommit(ctx.store, actor.at),
  })
  const outcome = await queue.flushNow({ settle: true })
  const remote = await hasRemote(ctx.root)
  const status = await runGit(ctx.root, ['status', '--porcelain'])
  const value = {
    pushed: outcome.kind === 'pushed',
    detail: outcome.kind === 'failed' ? formatError(outcome.error) : outcome.kind === 'nothing-to-do' ? outcome.reason : '已推送',
    remote,
    dirty: status.code === 0 ? status.stdout !== '' : undefined,
  }
  // Decision 171: after a settle that could **not** push, the commits are local and the derived files
  // are stale — say so plainly instead of ending with a single word. This is the alarm that was
  // missing when a rejected `pull --rebase` left the store behind for hours.
  const drift = await aheadBehind(ctx.root)
  const note = value.pushed
    ? ''
    : [
      drift.ahead > 0 ? `\n本地领先 origin ${String(drift.ahead)} 个提交（未推送）` : '',
      drift.behind > 0 ? `\norigin 领先本地 ${String(drift.behind)} 个提交（未拉取）` : '',
    ].join('')
  ctx.say(ctx.json
    ? { ...value, ahead: drift.ahead, behind: drift.behind }
    : `${syncPushLine(value.detail)}${note}${value.dirty === true ? '\n注意：工作区有未提交的改动' : ''}`)
  return outcome.kind === 'failed' ? 1 : 0
}
