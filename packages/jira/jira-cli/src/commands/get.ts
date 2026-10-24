/** cli/commands/get — `jira get <KEY>`: read one issue (decision 38: a read writes nothing). */

import { asIssueKey } from '@deepseek-ai/dsh-jira-core/entity.ts'
import { invalidInput, notFound } from '@deepseek-ai/dsh-jira-core/errors.ts'
import { readIssue } from '@deepseek-ai/dsh-jira-core/io.ts'
import { renderIssueHuman, renderIssueJson } from '@deepseek-ai/dsh-jira-core/render.ts'
import { readComments } from '@deepseek-ai/dsh-jira-core/store.ts'
import { fail, type Handler } from '../runtime.ts'

export const getCommand: Handler = async (ctx) => {
  const rawKey = ctx.positionals[0] ?? ''
  const key = asIssueKey(rawKey)
  if (key === undefined) return fail(ctx.io, invalidInput(`"${rawKey}" 不是 issue key（形如 DH-12）`), 2)
  const read = await readIssue(ctx.store.files, key)
  if (!read.ok) return fail(ctx.io, read.error.code === 'NOT_FOUND' ? notFound(rawKey) : read.error, 1)
  for (const warning of read.value.warnings) ctx.io.err(`warning: ${warning}`)
  const comments = await readComments(ctx.store, key)
  ctx.say(ctx.json ? renderIssueJson(read.value.issue) : renderIssueHuman(read.value.issue, [], undefined, 'zh'))
  if (!ctx.json && comments.ok && comments.value.length > 0) ctx.io.out(`${String(comments.value.length)} 条评论`)
  return 0
}
