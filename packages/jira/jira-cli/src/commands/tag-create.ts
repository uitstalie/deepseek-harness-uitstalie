/** cli/commands/tag-create — `jira tag-create NAME --description …`: register a tag (decision 26). */

import { stringFlag } from '@deepseek-ai/dsh-jira-core/args.ts'
import { invalidInput } from '@deepseek-ai/dsh-jira-core/errors.ts'
import { registeredMessage } from '@deepseek-ai/dsh-jira-core/messages.ts'
import { createTag } from '@deepseek-ai/dsh-jira-core/tagstore.ts'
import { fail, type Handler } from '../runtime.ts'

export const tagCreateCommand: Handler = async (ctx) => {
  const name = ctx.positionals[0]
  if (name === undefined) return fail(ctx.io, invalidInput('tag-create 需要一个名字，例如 jira tag-create windows --description why'), 2)
  const description = stringFlag(ctx.flags, 'description')
  if (description === undefined) return fail(ctx.io, invalidInput('tag-create 需要 --description：注册表存在的意义就是解释这个标签（决策 26）'), 2)
  const alias = stringFlag(ctx.flags, 'alias')
  const created = await createTag(ctx.store, await ctx.actorFor(), {
    name,
    description,
    ...(alias === undefined ? {} : { aliases: [alias] }),
  })
  if (!created.ok) return fail(ctx.io, created.error, 1)
  ctx.say(ctx.json ? created.value.tag : registeredMessage(created.value.tag.name, created.value.committed))
  return 0
}
