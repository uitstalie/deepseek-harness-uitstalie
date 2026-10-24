/** cli/commands/board — `jira board [--html [--out F]]`: the board, text or one static page. */

import { writeFile } from 'node:fs/promises'

import { booleanFlag, stringFlag } from '@deepseek-ai/dsh-jira-core/args.ts'
import { renderBoardHtml } from '@deepseek-ai/dsh-jira-core/boardHtml.ts'
import { invalidInput } from '@deepseek-ai/dsh-jira-core/errors.ts'
import { listIssues } from '@deepseek-ai/dsh-jira-core/inspect.ts'
import { BOARD_NEEDS_VOCAB, hiddenIssuesNote } from '@deepseek-ai/dsh-jira-core/messages.ts'
import { renderBoard } from '@deepseek-ai/dsh-jira-core/render.ts'
import { fail, nowUtc, optionalVocab, queryFromFlags, type Handler } from '../runtime.ts'

export const boardCommand: Handler = async (ctx) => {
  const listed = await listIssues(ctx.root)
  const vocab = await optionalVocab(ctx.root)
  if (vocab === undefined) return fail(ctx.io, invalidInput(BOARD_NEEDS_VOCAB), 1)
  const issues = queryFromFlags(listed.issues, ctx.flags, vocab)
  if (ctx.json) {
    ctx.say(issues)
    return 0
  }
  if (booleanFlag(ctx.flags, 'html') === true) {
    const html = renderBoardHtml(issues, vocab, {
      title: `${[...new Set(issues.map(issue => issue.project))].join(', ') || 'jira'} 看板`,
      generatedAt: nowUtc(),
    })
    const out = stringFlag(ctx.flags, 'out')
    if (out === undefined) {
      ctx.say(html)
      return 0
    }
    await writeFile(out, html, 'utf8')
    ctx.say(`${out} 已写出（${String(html.length)} 字节，${String(issues.length)} 条 issue）`)
    return 0
  }
  const hidden = listed.issues.length - issues.length
  ctx.say(renderBoard(issues, vocab).replace(/\n$/u, '') + (hidden > 0 ? hiddenIssuesNote(hidden) : ''))
  return 0
}
