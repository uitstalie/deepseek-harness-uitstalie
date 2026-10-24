/** cli/commands/list — `jira list`: the shared query, rendered the way `jira_list` promises. */

import { booleanFlag, optFlags, stringFlag } from '@deepseek-ai/dsh-jira-core/args.ts'
import { invalidInput } from '@deepseek-ai/dsh-jira-core/errors.ts'
import { listIssues } from '@deepseek-ai/dsh-jira-core/inspect.ts'
import { buildIssueList } from '@deepseek-ai/dsh-jira-core/list.ts'
import { renderIssueList } from '@deepseek-ai/dsh-jira-core/render.ts'
import { fail, optionalVocab, type Handler } from '../runtime.ts'

export const listCommand: Handler = async (ctx) => {
  const listed = await listIssues(ctx.root)
  for (const broken of listed.broken) ctx.io.err(`warning: ${broken.path}: ${broken.reason}`)
  const vocab = await optionalVocab(ctx.root)
  if (vocab === undefined) return fail(ctx.io, invalidInput('list 需要可读的 config.md 词表'), 1)
  // The same ordering the `jira_list` tool promises (decision 53), so the two agree.
  const linkType = stringFlag(ctx.flags, 'link-type')
  const linkedTo = stringFlag(ctx.flags, 'linked-to')
  const result = buildIssueList(listed.issues, vocab, {
    ...optFlags(ctx.flags, { project: 'string', status: 'string', tag: 'string', assignee: 'string' }),
    ...(linkedTo === undefined || linkType === undefined
      ? {}
      : { link: { type: linkType as never, target: linkedTo } }),
    includeClosed: booleanFlag(ctx.flags, 'all'),
    ...(typeof ctx.flags.limit === 'number' ? { limit: ctx.flags.limit } : {}),
  })
  ctx.say(ctx.json ? result.items : renderIssueList(result.items, vocab))
  if (!ctx.json && result.truncated) ctx.io.err(`提示：还有 ${String(result.counts.remaining)} 条匹配；请调大 --limit（最多 100）`)
  return 0
}
