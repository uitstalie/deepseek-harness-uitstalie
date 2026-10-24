/** cli/commands/verify-commit-msg — the commit-msg hook's check (decision 67). */

import { readFile } from 'node:fs/promises'

import { checkCommitMessage, renderVerdict, uncommentGitMessage } from '@deepseek-ai/dsh-jira-core/commitmsg.ts'
import { invalidInput } from '@deepseek-ai/dsh-jira-core/errors.ts'
import { runGit } from '@deepseek-ai/dsh-jira-core/git.ts'
import { collectKnownKeys } from '@deepseek-ai/dsh-jira-core/inspect.ts'
import { fail, type Handler } from '../runtime.ts'

export const verifyCommitMsgCommand: Handler = async (ctx) => {
  const file = ctx.positionals[0]
  if (file === undefined) return fail(ctx.io, invalidInput('verify-commit-msg 需要提交信息文件路径'), 2)
  const text = await readFile(file, 'utf8').catch(() => undefined)
  if (text === undefined) return fail(ctx.io, invalidInput(`读不到 ${file}`, { file }), 1)
  // Existence means "this key names something in the ledger" — and the ledger includes the
  // knowledge library, because `KB-1: kb create` is exactly the commit a KB write makes.
  const known = await collectKnownKeys(ctx.store)
  const branch = (await runGit(ctx.root, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout
  // git may pass the commit source as a second argument; the exemption uses it when present.
  const message = uncommentGitMessage(text)
  const verdict = checkCommitMessage(message, {
    knownKeys: known,
    branch,
    ...(ctx.positionals[1] === undefined ? {} : { source: ctx.positionals[1] }),
  })
  if (!verdict.ok) {
    ctx.io.err(renderVerdict(verdict, message))
    return 1
  }
  return 0
}
