/**
 * cli/commands/kb — `jira kb [search|get|create|update]`: the knowledge surface.
 *
 * `search` and `create` need no key; `get`/`update` do — so the keyed pair is one table and the
 * other two are their own handlers (decision 187).
 */

import { optFlags, stringFlag } from '@deepseek-ai/dsh-jira-core/args.ts'
import { invalidInput } from '@deepseek-ai/dsh-jira-core/errors.ts'
import { asKnowledgeKey, type KnowledgeKey } from '@deepseek-ai/dsh-jira-core/kb.ts'
import { renderKbEntry, renderKbSearch } from '@deepseek-ai/dsh-jira-core/kbsearch.ts'
import {
  type KnowledgePatch,
  createKnowledge,
  findKnowledge,
  originFromIdentity,
  searchKnowledgeIn,
  updateKnowledge,
} from '@deepseek-ai/dsh-jira-core/kbstore.ts'
import { createdMessage, updatedMessage } from '@deepseek-ai/dsh-jira-core/messages.ts'
import { fail, type CommandContext, type Handler } from '../runtime.ts'

/**
 * Decision 198: a citation leaves the issue pointing back. Say what the mirror did — and say what it
 * could not do, instead of leaving a one-sided reference for the doctor to find later.
 */
const noteMirror = (
  ctx: CommandContext,
  mirror: { updated: readonly string[]; failed: readonly { key: string; error: { message: string } }[] } | undefined,
): void => {
  if (mirror === undefined) return
  if (mirror.updated.length > 0) ctx.io.err(`已回填 kb_refs：${mirror.updated.join('、')}`)
  for (const failure of mirror.failed) ctx.io.err(`未能回填 ${String(failure.key)}：${failure.error.message}`)
}

const searchAction = async (ctx: CommandContext): Promise<number> => {
  const query = stringFlag(ctx.flags, 'query') ?? ctx.positionals[1]
  if (query === undefined || query.trim() === '') {
    return fail(ctx.io, invalidInput('kb search 需要检索词（位置参数或 --query）'), 2)
  }
  const found = await searchKnowledgeIn(ctx.store, query, typeof ctx.flags['top-k'] === 'number' ? ctx.flags['top-k'] : undefined)
  if (!found.ok) return fail(ctx.io, found.error, 1)
  ctx.say(ctx.json ? found.value : renderKbSearch(found.value, 'zh'))
  return 0
}

const getAction = async (ctx: CommandContext, key: KnowledgeKey): Promise<number> => {
  const found = await findKnowledge(ctx.store, key as never)
  if (!found.ok) return fail(ctx.io, found.error, 1)
  const item = found.value.entry
  for (const warning of found.value.warnings) ctx.io.err(`warning: ${warning}`)
  ctx.say(ctx.json ? item : renderKbEntry(item))
  return 0
}

const createAction = async (ctx: CommandContext): Promise<number> => {
  const origin = originFromIdentity(undefined, ctx.store.machineId)
  const created = await createKnowledge(ctx.store, await ctx.actorFor(), origin, {
    domain: stringFlag(ctx.flags, 'domain') ?? '',
    kbType: stringFlag(ctx.flags, 'type') ?? '',
    title: stringFlag(ctx.flags, 'title') ?? '',
    ...optFlags<Parameters<typeof createKnowledge>[3]>(ctx.flags, {
      tags: 'list',
      body: 'string',
      issues: 'list',
      source: 'string',
      'source-sha256': { kind: 'string', to: 'sourceSha256' },
    }),
  })
  if (!created.ok) return fail(ctx.io, created.error, 1)
  noteMirror(ctx, created.value.mirror)
  ctx.say(ctx.json
    ? created.value.entry
    : createdMessage(created.value.entry.key, created.value.committed))
  return 0
}

const updateAction = async (ctx: CommandContext, key: KnowledgeKey): Promise<number> => {
  const origin = originFromIdentity(undefined, ctx.store.machineId)
  const updated = await updateKnowledge(ctx.store, key as never, await ctx.actorFor(), origin, optFlags<KnowledgePatch>(ctx.flags, {
    title: 'string',
    type: { kind: 'string', to: 'kbType' },
    tags: 'list',
    body: 'string',
    issues: 'list',
    source: 'string',
    'source-sha256': { kind: 'string', to: 'sourceSha256' },
  }))
  if (!updated.ok) return fail(ctx.io, updated.error, 1)
  noteMirror(ctx, updated.value.mirror)
  ctx.say(ctx.json ? updated.value.entry : updatedMessage(updated.value.entry.key, updated.value.committed))
  return 0
}

const KEYED: Readonly<Record<string, (ctx: CommandContext, key: KnowledgeKey) => Promise<number>>> = Object.freeze({
  get: getAction,
  update: updateAction,
})

export const kbCommand: Handler = async (ctx) => {
  const action = ctx.positionals[0] ?? 'search'
  if (action === 'search') return searchAction(ctx)
  if (action === 'create') return createAction(ctx)
  // The key gate runs **before** the unknown-action error: `kb frobnicate` (no key) has always
  // answered "kb frobnicate 需要一个 <KEY>", and only `kb frobnicate KB-1` reaches "未知的 kb 动作".
  const key = asKnowledgeKey(ctx.positionals[1] ?? '')
  if (key === undefined) {
    return fail(ctx.io, invalidInput(`kb ${action} 需要一个 <KEY>（例如 KB-7）`), 2)
  }
  const keyed = KEYED[action]
  if (keyed === undefined) return fail(ctx.io, invalidInput(`未知的 kb 动作 "${action}"（可选 get/search/create/update）`), 2)
  return keyed(ctx, key)
}
