/** cli/commands/lint — `jira lint [--keys [--compare OTHER]]`: the structural self-check. */

import { booleanFlag, stringFlag } from '@deepseek-ai/dsh-jira-core/args.ts'
import { listIssues } from '@deepseek-ai/dsh-jira-core/inspect.ts'
import { compareKeyInventories, keyInventory, renderKeyComparison, renderKeyInventory } from '@deepseek-ai/dsh-jira-core/keyset.ts'
import { listKnowledge } from '@deepseek-ai/dsh-jira-core/kbstore.ts'
import { lintStore, renderLintReport } from '@deepseek-ai/dsh-jira-core/lint.ts'
import { loadTags, loadVocab } from '@deepseek-ai/dsh-jira-core/store.ts'
import { fail, type Handler } from '../runtime.ts'

export const lintCommand: Handler = async (ctx) => {
  const issues = await listIssues(ctx.root)
  if (booleanFlag(ctx.flags, 'keys') === true) {
    // Decision 94: the key inventory, and — with `--compare` — the collision list a merge needs.
    const inventory = keyInventory(issues.issues)
    const other = stringFlag(ctx.flags, 'compare')
    if (other === undefined) {
      ctx.say(ctx.json ? inventory : renderKeyInventory(inventory))
      return 0
    }
    const otherIssues = await listIssues(other)
    const comparison = compareKeyInventories(inventory, keyInventory(otherIssues.issues))
    ctx.say(ctx.json ? comparison : renderKeyComparison(comparison, '本账本', other))
    return 0
  }
  const knowledge = await listKnowledge(ctx.store)
  if (!knowledge.ok) return fail(ctx.io, knowledge.error, 1)
  const vocab = await loadVocab(ctx.store)
  if (!vocab.ok) return fail(ctx.io, vocab.error, 1)
  const tags = await loadTags(ctx.store)
  if (!tags.ok) return fail(ctx.io, tags.error, 1)
  const lint = lintStore({
    issues: issues.issues,
    knowledge: knowledge.value.entries,
    broken: [...issues.broken, ...knowledge.value.broken],
    vocab: vocab.value,
    knownTags: tags.value,
  })
  for (const warning of issues.broken) ctx.io.err(`warning: ${warning.path}: ${warning.reason}`)
  ctx.say(ctx.json ? lint : renderLintReport(lint))
  return lint.ok ? 0 : 1
}
