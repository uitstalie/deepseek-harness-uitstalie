/**
 * plugin/toolList — `jira_list`: a view over the ledger (decision 53).
 *
 * Read-only, so it never consults the write guard and every session — including a subagent's —
 * may use it (decision 89). Split out of `index.ts` under decision 186.
 */

import { type LinkType, isLinkType } from '@deepseek-ai/dsh-jira-core/entity.ts'
import { invalidInput } from '@deepseek-ai/dsh-jira-core/errors.ts'
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from '@deepseek-ai/dsh-jira-core/list.ts'
import { type FieldSpec, pickKnownKeys, validateArgs } from '@deepseek-ai/dsh-jira-core/schema.ts'
import { type RunOptions, type ToolValue, asString, asStringList, failure, skipped } from './envelope.ts'

/** The registered tool name for the read-only ledger view. */
export const LIST_TOOL_NAME = 'jira_list'

/** `jira_list`'s filter schema; every field narrows the view. */
export const LIST_PARAMETERS: Readonly<Record<string, FieldSpec>> = Object.freeze({
  project: { type: 'string', description: 'Only issues of this project, e.g. DH.' },
  status: { type: 'string', description: 'Only issues in this status.' },
  tags: { type: 'array', description: 'Every listed tag must be present (narrowing, not widening).' },
  assignee: { type: 'string', description: '"me" for this session, or an exact identity such as "human:daiqc".' },
  link: { type: 'object', description: 'Only issues linked to another: { type, target }.' },
  limit: { type: 'number', description: `How many to return; default ${String(DEFAULT_LIST_LIMIT)}, maximum ${String(MAX_LIST_LIMIT)}.` },
  include_closed: { type: 'boolean', description: 'Also list issues in a closed status. Default false.' },
})

/** The description the host shows for `jira_list`: the ordering, the counts and its read-only nature. */
export const LIST_DESCRIPTION =
  'List issues in the local dsh-jira ledger, ready first and blocked last. Ordered by project, '
  + 'then the vocabulary\'s status order, then priority (S1 first), then most recently updated. '
  + 'The counts describe everything that matched, so a truncated answer does not look like a '
  + 'small store. Read-only, and available to every session including subagents.'

/** The envelope `jira_list` advertises to the host, with `ok`, `writable` and `me` always present. */
export const LIST_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    writable: { type: 'boolean' },
    items: { type: 'array' },
    groups: { type: 'array' },
    counts: { type: 'object', additionalProperties: true },
    truncated: { type: 'boolean' },
    limit: { type: 'number' },
    me: { type: 'object', additionalProperties: true },
    error: { type: 'object', additionalProperties: true },
    reason: { type: 'string' },
    rejected: { type: 'array' },
    message: { type: 'string' },
  },
  required: Object.freeze(['ok', 'writable', 'me']),
})

/**
 * `jira_list`: a view over the ledger. Read-only, so it never consults the write guard.
 * @param args - the raw tool arguments, validated against `LIST_PARAMETERS`.
 * @param options - the store, caller verdict and clock for this run.
 * @param me - the caller's identity tuple, returned in every result.
 * @returns the ordered items and groups with their counts.
 */
export const runListTool = async (args: unknown, options: RunOptions, me: unknown): Promise<ToolValue> => {
  const { jira, caller } = options

  const validated = validateArgs(LIST_PARAMETERS, args)
  if (!validated.ok) return failure(validated.error, caller, me)
  const input = validated.value

  const rawAssignee = asString(input.assignee)
  const assignee = rawAssignee === 'me' ? caller.identity : rawAssignee
  if (rawAssignee === 'me' && caller.identity === undefined) {
    return failure(invalidInput('assignee "me" needs a session identity; pass an explicit one instead'), caller, me)
  }

  let link: Readonly<{ type: LinkType; target: string }> | undefined
  if (input.link !== undefined) {
    const fields = pickKnownKeys(input.link, ['type', 'target'], 'link')
    if (!fields.ok) return failure(fields.error, caller, me)
    const type = asString(fields.value.type)
    const target = asString(fields.value.target)
    if (type === undefined || !isLinkType(type)) return failure(invalidInput('link needs a valid `type`', { type }), caller, me)
    if (target === undefined) return failure(invalidInput('link needs a `target` issue key'), caller, me)
    link = Object.freeze({ type, target })
  }

  const listed = await jira.listWithRejected({
    ...(asString(input.project) === undefined ? {} : { project: asString(input.project) as string }),
    ...(asString(input.status) === undefined ? {} : { status: asString(input.status) as string }),
    ...(asStringList(input.tags) === undefined ? {} : { tags: asStringList(input.tags) as readonly string[] }),
    ...(assignee === undefined ? {} : { assignee }),
    ...(link === undefined ? {} : { link }),
    includeClosed: input.include_closed === true,
    ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
  })
  if (!listed.ok) return failure(listed.error, caller, me)

  const result = listed.value.list
  const rejected = listed.value.rejected
  return Object.freeze({
    ok: true,
    writable: caller.writable,
    ...(caller.reason === undefined ? {} : { reason: caller.reason }),
    me,
    items: result.items,
    groups: result.groups,
    counts: result.counts,
    truncated: result.truncated,
    limit: result.limit,
    ...skipped(rejected, 'read'),
  })
}
