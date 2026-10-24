/** cli/commands/new — `jira new`: create an issue; the project may come from the workspace. */

import { optFlags, stringFlag } from '@deepseek-ai/dsh-jira-core/args.ts'
import { isProjectKey } from '@deepseek-ai/dsh-jira-core/entity.ts'
import { invalidInput } from '@deepseek-ai/dsh-jira-core/errors.ts'
import { NEW_NEEDS_SUMMARY, createdMessage, invalidProjectKey } from '@deepseek-ai/dsh-jira-core/messages.ts'
import { type NewIssueInput } from '@deepseek-ai/dsh-jira-core/mutate.ts'
import { ensureWorkspaceProject } from '@deepseek-ai/dsh-jira-core/project.ts'
import { createInStore } from '@deepseek-ai/dsh-jira-core/store.ts'
import { resolveWorkspace } from '@deepseek-ai/dsh-jira-core/workspace.ts'
import { fail, type Handler } from '../runtime.ts'

export const newCommand: Handler = async (ctx) => {
  let project = (stringFlag(ctx.flags, 'project') ?? '').toUpperCase()
  const summary = stringFlag(ctx.flags, 'summary')
  // Decision 133 (§4.10): the project may come from the workspace; the first write from a new
  // checkout registers it, with the policy that says whether other machines may write it.
  if (project === '') {
    const binding = await resolveWorkspace(ctx.store, ctx.cwd)
    if (!binding.ok) return fail(ctx.io, binding.error, 1)
    const ensured = await ensureWorkspaceProject(ctx.store, await ctx.actorFor(), binding.value, ctx.store.machineId)
    if (!ensured.ok) return fail(ctx.io, ensured.error, 1)
    project = ensured.value.key
    if (!ctx.json && ensured.value.registered) ctx.io.err('已登记项目 ' + project + '（依据：' + binding.value.by + '）')
  }
  if (summary === undefined || summary === '') return fail(ctx.io, invalidInput(NEW_NEEDS_SUMMARY), 2)
  // Decision 162: the project key becomes `projects/<key>/`, so `--project ../../tmp/x` must not get
  // past here. `createInStore` validates again (the core is the backstop); this is the message a
  // person sees, and it fails before anything touches the filesystem.
  if (!isProjectKey(project)) {
    return fail(ctx.io, invalidInput(invalidProjectKey(project), { project }), 2)
  }
  const actor = await ctx.actorFor()
  const created = await createInStore(ctx.store, project, actor, {
    issueType: stringFlag(ctx.flags, 'type') ?? 'task',
    summary,
    ...optFlags<NewIssueInput>(ctx.flags, { priority: 'string', tags: 'list', note: 'string', body: 'string' }),
  })
  if (!created.ok) return fail(ctx.io, created.error, 1)
  ctx.say(ctx.json ? created.value.change.issue : createdMessage(created.value.key, created.value.committed))
  return 0
}
