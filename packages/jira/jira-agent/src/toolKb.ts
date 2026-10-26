/**
 * plugin/toolKb — `jira_kb`: the knowledge half of the ledger (decisions 29/54/75).
 *
 * Reads are open to every session; writes obey the same guard as the issue tool. Split out of
 * `index.ts` under decision 186.
 */

import { type KnowledgeKey, asKnowledgeKey, knowledgePath } from '@deepseek-ai/dsh-jira-core/kb.ts'
import { TOP_K_DEFAULT, TOP_K_MAX } from '@deepseek-ai/dsh-jira-core/kbsearch.ts'
import { createKnowledge, findKnowledge, originFromIdentity, searchKnowledgeIn, updateKnowledge } from '@deepseek-ai/dsh-jira-core/kbstore.ts'
import { formatError, invalidInput, readOnlySession } from '@deepseek-ai/dsh-jira-core/errors.ts'
import { type FieldSpec, pickKnownKeys, validateArgs } from '@deepseek-ai/dsh-jira-core/schema.ts'
import { system } from '@deepseek-ai/dsh-jira-core/system/index.ts'
import { type RunOptions, type ToolValue, actorFor, asString, asStringList, failure, skipped } from './envelope.ts'

/** The registered tool name for the knowledge half of the ledger. */
export const KB_TOOL_NAME = 'jira_kb'

const KB_ACTIONS = ['get', 'create', 'update', 'search'] as const
const KB_CREATE_FIELDS = ['domain', 'type', 'title', 'tags', 'body', 'issues', 'source', 'source_sha256'] as const
const KB_UPDATE_FIELDS = ['title', 'type', 'tags', 'body', 'issues', 'source', 'source_sha256'] as const

/** `jira_kb`'s argument schema, validated before any action runs. */
export const KB_PARAMETERS: Readonly<Record<string, FieldSpec>> = Object.freeze({
  action: {
    type: 'string',
    required: true,
    description: `What to do: ${KB_ACTIONS.join(' / ')}.`,
    enum: KB_ACTIONS,
  },
  key: { type: 'string', description: 'get/update: the knowledge key, e.g. KB-7.' },
  query: { type: 'string', description: 'search: the text to look for.' },
  top_k: { type: 'number', description: `search: how many hits; default ${String(TOP_K_DEFAULT)}, maximum ${String(TOP_K_MAX)}.` },
  data: {
    type: 'object',
    description: `create: { ${KB_CREATE_FIELDS.join(', ')} } · update: { ${KB_UPDATE_FIELDS.join(', ')} } `
      + '(`type` is one of the store\'s kb_types; the machine/os/tool/captured_at lineage and the '
      + 'key are recorded by the store, not typed here).',
  },
})

/** The description the host shows for `jira_kb`: what each action does and who may use it. */
export const KB_DESCRIPTION =
  'Read or add knowledge entries under knowledge/<domain>/KB-<n>.md (runbooks, pitfalls, how-tos, '
  + 'concepts). `search` scans the text and returns snippets with file:line so a claim can be traced '
  + 'back; it never returns a whole entry. Reading is open to every session; create and update need a '
  + 'writable one.'

/** The envelope `jira_kb` advertises to the host, with `ok`, `writable` and `me` always present. */
export const KB_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    writable: { type: 'boolean' },
    item: { type: 'object', additionalProperties: true },
    hits: { type: 'array' },
    counts: { type: 'object', additionalProperties: true },
    me: { type: 'object', additionalProperties: true },
    error: { type: 'object', additionalProperties: true },
    reason: { type: 'string' },
    rejected: { type: 'array' },
    message: { type: 'string' },
  },
  required: Object.freeze(['ok', 'writable', 'me']),
})

/**
 * `jira_kb`: the knowledge half of the ledger. Reads are open; writes obey the same guard.
 * @param args - the raw tool arguments, validated against `KB_PARAMETERS`.
 * @param options - the store, caller verdict, clock and write hooks for this run.
 * @param me - the caller's identity tuple, returned in every result.
 * @returns the entry or the search hits, or the refusal as a failed envelope.
 */
export const runKbTool = async (args: unknown, options: RunOptions, me: unknown): Promise<ToolValue> => {
  const { store, caller } = options

  const validated = validateArgs(KB_PARAMETERS, args)
  if (!validated.ok) return failure(validated.error, caller, me)
  const input = validated.value
  const action = String(input.action)
  const key = asString(input.key)

  if (action !== 'get' && action !== 'search' && !caller.writable) {
    return failure(readOnlySession(caller.reason ?? 'session'), caller, me)
  }

  const origin = originFromIdentity(caller.identity, store.machineId, 'dsh', system.facts.platform)

  if (action === 'search') {
    const query = asString(input.query)
    if (query === undefined) return failure(invalidInput('search needs `query`'), caller, me)
    const result = await searchKnowledgeIn(store, query, typeof input.top_k === 'number' ? input.top_k : undefined)
    if (!result.ok) return failure(result.error, caller, me)
    return Object.freeze({
      ok: true,
      writable: caller.writable,
      ...(caller.reason === undefined ? {} : { reason: caller.reason }),
      me,
      hits: result.value.hits,
      counts: Object.freeze({
        matched: result.value.matched,
        returned: result.value.hits.length,
        remaining: result.value.matched - result.value.hits.length,
      }),
      truncated: result.value.truncated,
    })
  }

  if (action !== 'create' && key === undefined) {
    return failure(invalidInput(`\`${action}\` needs a \`key\``), caller, me)
  }
  const knowledgeKey = key === undefined ? undefined : asKnowledgeKey(key)
  if (action !== 'create' && knowledgeKey === undefined) {
    return failure(invalidInput(`"${String(key)}" is not a knowledge key (expected e.g. KB-7)`), caller, me)
  }

  if (action === 'get') {
    // knowledgeKey is proven above; the cast only re-states that for the compiler.
    const found = await findKnowledge(store, knowledgeKey as KnowledgeKey)
    if (!found.ok) return failure(found.error, caller, me)
    const rejected = found.value.warnings.map(reason => Object.freeze({ file: found.value.path, reason }))
    return Object.freeze({
      ok: true,
      writable: caller.writable,
      ...(caller.reason === undefined ? {} : { reason: caller.reason }),
      me,
      item: found.value.entry,
      ...skipped(rejected, 'read'),
    })
  }

  const fields = pickKnownKeys(input.data, action === 'create' ? KB_CREATE_FIELDS : KB_UPDATE_FIELDS, 'data')
  if (!fields.ok) return failure(fields.error, caller, me)
  const tags = asStringList(fields.value.tags)
  const issues = asStringList(fields.value.issues)
  const patch = {
    ...(asString(fields.value.title) === undefined ? {} : { title: asString(fields.value.title) as string }),
    ...(asString(fields.value.type) === undefined ? {} : { kbType: asString(fields.value.type) as string }),
    ...(tags === undefined ? {} : { tags }),
    ...(asString(fields.value.body) === undefined ? {} : { body: asString(fields.value.body) as string }),
    ...(issues === undefined ? {} : { issues: issues as never }),
    ...(asString(fields.value.source) === undefined ? {} : { source: asString(fields.value.source) as string }),
    ...(asString(fields.value.source_sha256) === undefined
      ? {}
      : { sourceSha256: asString(fields.value.source_sha256) as string }),
  }

  const written = action === 'create'
    ? await createKnowledge(store, { by: actorFor(options, caller), at: options.at }, origin, {
      domain: asString(fields.value.domain) ?? '',
      kbType: asString(fields.value.type) ?? '',
      title: asString(fields.value.title) ?? '',
      ...(tags === undefined ? {} : { tags }),
      ...(asString(fields.value.body) === undefined ? {} : { body: asString(fields.value.body) as string }),
      ...(issues === undefined ? {} : { issues: issues as never }),
      ...(asString(fields.value.source) === undefined ? {} : { source: asString(fields.value.source) as string }),
      ...(asString(fields.value.source_sha256) === undefined
        ? {}
        : { sourceSha256: asString(fields.value.source_sha256) as string }),
    })
    : await updateKnowledge(store, knowledgeKey as KnowledgeKey, { by: actorFor(options, caller), at: options.at }, origin, patch)
  if (!written.ok) return failure(written.error, caller, me)

  options.onWrote?.()
  const rejected = written.value.commitError === undefined
    ? undefined
    : Object.freeze([Object.freeze({ file: 'git', reason: formatError(written.value.commitError) })])
  return Object.freeze({
    ok: true,
    writable: caller.writable,
    ...(caller.reason === undefined ? {} : { reason: caller.reason }),
    me,
    item: written.value.entry,
    // Decision 195 (trial feedback P3-2): name the file. The trial user had to guess the domain directory.
    file: knowledgePath(written.value.entry.domain, written.value.entry.key),
    // Decision 198: what the mirror did to the cited issues' `kb_refs` (absent when nothing was cited).
    ...(written.value.mirror === undefined ? {} : { mirror: written.value.mirror }),
    ...skipped(rejected ?? [], 'write'),
  })
}
