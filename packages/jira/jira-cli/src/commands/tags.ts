/** cli/commands/tags — `jira tags lint`: the tag registry check (read-only, decision 38). */

import { invalidInput } from '@deepseek-ai/dsh-jira-core/errors.ts'
import { listIssues } from '@deepseek-ai/dsh-jira-core/inspect.ts'
import { unknownTagsAction } from '@deepseek-ai/dsh-jira-core/messages.ts'
import { loadTags } from '@deepseek-ai/dsh-jira-core/store.ts'
import { lintTags, renderTagsLint } from '@deepseek-ai/dsh-jira-core/tagsLint.ts'
import { fail, type Handler } from '../runtime.ts'

export const tagsCommand: Handler = async (ctx) => {
  const action = ctx.positionals[0] ?? 'lint'
  if (action !== 'lint') return fail(ctx.io, invalidInput(unknownTagsAction(action)), 2)
  const tags = await loadTags(ctx.store)
  if (!tags.ok) return fail(ctx.io, tags.error, 1)
  const issues = await listIssues(ctx.root)
  const report = lintTags(tags.value, issues.issues)
  ctx.say(ctx.json ? report : renderTagsLint(report))
  return 0
}
