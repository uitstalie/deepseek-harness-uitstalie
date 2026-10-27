/**
 * plugin/toolIssue — `jira_issue`: read or change one issue (decisions 50/82/89/93).
 *
 * Split out of `index.ts` under decision 186. The schema, the description and the runner live
 * together so the tool's surface is edited in exactly one place; `index.ts` only registers them.
 */

import { type IssueKey, isLinkType } from '@deepseek-ai/dsh-jira-core/entity.ts'
import { formatError, invalidInput, readOnlySession } from '@deepseek-ai/dsh-jira-core/errors.ts'
import { type FieldSpec, pickKnownKeys, validateArgs } from '@deepseek-ai/dsh-jira-core/schema.ts'
import type { IssueMutation } from '@deepseek-ai/dsh-jira-service'
import { type RunOptions, type ToolValue, actorFor, asString, asStringList, failure, okValue } from './envelope.ts'

/** The tool name the host registry and the shipped skills refer to. */
export const TOOL_NAME = 'jira_issue'

const ACTIONS = ['get', 'create', 'update', 'switch_state', 'comment', 'assignee', 'link', 'tag_create', 'close', 'batch_close'] as const
/** Everything except `get` needs a writable session (decisions 89/93). */
export const WRITE_ACTIONS: readonly string[] = ACTIONS.filter(action => action !== 'get')
/** Decision 84: the allow-list for concurrency — a call we cannot classify stays exclusive (fail closed). */
export const READ_ACTIONS: readonly string[] = ACTIONS.filter(action => !WRITE_ACTIONS.includes(action))

/** Decision 84: a read must not be allowed to hang as long as a write. */
export const READ_TIMEOUT_MS = 5_000
/** How long a write may run: the settle's git work is included in the budget. */
export const WRITE_TIMEOUT_MS = 30_000

const CREATE_FIELDS = ['issue_type', 'summary', 'priority', 'status', 'tags', 'note', 'assignee', 'description'] as const
/** Decision 192: the tag registry was CLI-only, so a tool-surface session could not create a tag at all. */
const TAG_CREATE_FIELDS = ['name', 'description', 'alias'] as const
const UPDATE_FIELDS = ['summary', 'issue_type', 'priority', 'tags', 'note', 'description', 'kb_refs'] as const

/** `jira_issue`'s argument schema, validated before any action runs. */
export const ISSUE_PARAMETERS: Readonly<Record<string, FieldSpec>> = Object.freeze({
  action: {
    type: 'string',
    required: true,
    description: `What to do: ${ACTIONS.join(' / ')}.`,
    enum: ACTIONS,
  },
  key: { type: 'string', description: 'Issue key, e.g. DH-12. Required for every action except create, tag_create and batch_close.' },
  keys: { type: 'array', description: 'batch_close: the issue keys to close (all-or-nothing: one refusal writes nothing).' },
  project: { type: 'string', description: 'Project key for create, e.g. DH (the key prefix).' },
  data: {
    type: 'object',
    description: `create: { ${CREATE_FIELDS.join(', ')} } · update: { ${UPDATE_FIELDS.join(', ')} } `
      + `· tag_create: { ${TAG_CREATE_FIELDS.join(', ')} } `
      + '(`description` is the Markdown body; `note` is the mutable reminder; `name` is the tag, lower-kebab).',
  },
  to: { type: 'string', description: 'switch_state: the target status, which must be a declared transition.' },
  resolution: { type: 'string', description: 'switch_state: required when the target status is a closed one.' },
  resolution_note: { type: 'string', description: 'switch_state: required when resolution is "limitation".' },
  assignee: {
    type: 'string',
    description: 'assignee: "self" to claim, "none" to release.',
    enum: ['self', 'none'],
  },
  link: { type: 'object', description: 'link: { type, target, op } with op being "add" or "remove".' },
  comment: { type: 'object', description: 'comment: { body }. Comments are append-only.' },
  expected_revision: { type: 'number', description: 'Refuse the write if the issue is not at this revision.' },
  ack_conflict: { type: 'boolean', description: 'Set when writing to an issue marked conflicted.' },
  override: { type: 'boolean', description: 'Decision 24: a human may claim an issue that is still blocked; the override is recorded as a comment.' },
})

/**
 * Decision 177: the tool declares **one** timeout, and it is the write-sized one (30 s) because a write
 * may include the settle's git work. A read through the same tool therefore gets 30 s instead of the 5 s
 * decision 84 uses for reads. Splitting the tool would mean two registrations for one verb set (and
 * re-deciding 82), so the trade is accepted and recorded here rather than left as a silent surprise.
 */
export const ISSUE_DESCRIPTION =
  'Read or change one issue in the local dsh-jira ledger (a git repository, one Markdown file per issue). '
  + '`get` returns the issue; every other action **writes**. A write is refused unless this session may '
  + 'write: read-only and delegated sessions get `ok: false` with `writable: false` and a `reason`, and the '
  + 'host guard denies the call before it runs (decision 9). So check `writable` on a read first instead of '
  + 'attempting a write you will be refused. '
  + 'Tags must exist before an issue can use them: `tag_create` registers one (decision 192).'

/** The envelope `jira_issue` advertises to the host, with `ok`, `writable` and `me` always present. */
export const ISSUE_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    writable: { type: 'boolean' },
    issue: { type: 'object', additionalProperties: true },
    comments: { type: 'array' },
    me: { type: 'object', additionalProperties: true },
    error: { type: 'object', additionalProperties: true },
    reason: { type: 'string' },
    rejected: { type: 'array' },
    message: { type: 'string' },
  },
  required: Object.freeze(['ok', 'writable', 'me']),
})

/**
 * Validate the arguments, run the requested action, and answer in the shared envelope.
 * @param args - the raw tool arguments, validated against `ISSUE_PARAMETERS`.
 * @param options - the store, caller verdict, clock and write hooks for this run.
 * @param me - the caller's identity tuple, returned in every result.
 * @returns the action's value, or the refusal as a failed envelope.
 */
export const runIssueTool = async (
  args: unknown,
  options: RunOptions,
  me: unknown,
): Promise<ToolValue> => {
  const { jira, caller } = options

  const validated = validateArgs(ISSUE_PARAMETERS, args)
  if (!validated.ok) return failure(validated.error, caller, me)
  const input = validated.value
  const action = String(input.action)

  if (WRITE_ACTIONS.includes(action) && !caller.writable) {
    return failure(readOnlySession(caller.reason ?? 'session'), caller, me)
  }

  const actor = { by: actorFor(options, caller), at: options.at }
  const key = asString(input.key)

  if (action === 'create') {
    const fields = pickKnownKeys(input.data, CREATE_FIELDS, 'data')
    if (!fields.ok) return failure(fields.error, caller, me)
    const created = await jira.createIssue(
      asString(input.project),
      caller.cwd,
      {
        issueType: asString(fields.value.issue_type) ?? 'task',
        summary: asString(fields.value.summary) ?? '',
        ...(asString(fields.value.priority) === undefined ? {} : { priority: asString(fields.value.priority) as string }),
        ...(asString(fields.value.status) === undefined ? {} : { status: asString(fields.value.status) as string }),
        ...(asStringList(fields.value.tags) === undefined ? {} : { tags: asStringList(fields.value.tags) as readonly string[] }),
        ...(asString(fields.value.note) === undefined ? {} : { note: asString(fields.value.note) as string }),
        ...(asString(fields.value.assignee) === undefined ? {} : { assignee: asString(fields.value.assignee) as string }),
        ...(asString(fields.value.description) === undefined ? {} : { body: asString(fields.value.description) as string }),
      },
      actor,
    )
    if (!created.ok) return failure(created.error, caller, me)
    if (options.session !== undefined && caller.sessionId !== undefined && options.recordSession !== undefined) {
      await options.recordSession(options.jira, actor, caller.sessionId, options.session)
    }
    return okValue(caller, me, {
      ...created.value.created.change.issue,
      // Decision 195: the key is absent in the common case, and present only when this call
      // registered the project — the service's own fact, never a re-derivation here.
      ...(created.value.projectCreated ? { project_created: true } : {}),
    })
  }

  if (action === 'batch_close') {
    const keys = asStringList(input.keys) ?? []
    const resolution = asString(input.resolution)
    if (resolution === undefined) return failure(invalidInput('batch_close needs `resolution`'), caller, me)
    const comment = asString((input.comment as { body?: unknown } | undefined)?.body)
    const closed = await jira.batchClose(keys.map(item => item as IssueKey), {
      ...(asString(input.to) === undefined ? {} : { to: asString(input.to) as string }),
      resolution,
      ...(asString(input.resolution_note) === undefined ? {} : { resolutionNote: asString(input.resolution_note) as string }),
      ...(comment === undefined ? {} : { comment }),
    }, actor)
    if (!closed.ok) return failure(closed.error, caller, me)
    return okValue(caller, me, {
      closed: closed.value.closed,
      ...(closed.value.partial === undefined ? {} : { partial: closed.value.partial }),
    })
  }

  if (action === 'tag_create') {
    const fields = pickKnownKeys(input.data, TAG_CREATE_FIELDS, 'data')
    if (!fields.ok) return failure(fields.error, caller, me)
    const description = asString(fields.value.description) ?? ''
    if (description.trim() === '') {
      return failure(invalidInput('tag_create needs `description`: the registry exists to explain the tag (decision 26)'), caller, me)
    }
    const created = await jira.createTag(actor, {
      name: asString(fields.value.name) ?? '',
      description,
      ...(asString(fields.value.alias) === undefined ? {} : { alias: asString(fields.value.alias) as string }),
    })
    if (!created.ok) return failure(created.error, caller, me)
    return okValue(caller, me, { tag: created.value.tag, committed: created.value.committed })
  }

  if (key === undefined) return failure(invalidInput(`\`${action}\` needs a \`key\``), caller, me)
  const issueKey = key as IssueKey

  if (action === 'get') {
    const read = await jira.readIssue(issueKey)
    if (!read.ok) return failure(read.error, caller, me)
    const rejected = read.value.warnings.map(reason => Object.freeze({ file: key, reason }))
    return okValue(caller, me, read.value.issue, read.value.comments, rejected)
  }

  let mutation
  if (action === 'update') {
    const fields = pickKnownKeys(input.data, UPDATE_FIELDS, 'data')
    if (!fields.ok) return failure(fields.error, caller, me)
    mutation = {
      action: 'update' as const,
      patch: {
        ...(asString(fields.value.summary) === undefined ? {} : { summary: asString(fields.value.summary) as string }),
        ...(asString(fields.value.issue_type) === undefined ? {} : { issueType: asString(fields.value.issue_type) as string }),
        ...(asString(fields.value.priority) === undefined ? {} : { priority: asString(fields.value.priority) as string }),
        ...(asStringList(fields.value.tags) === undefined ? {} : { tags: asStringList(fields.value.tags) as readonly string[] }),
        ...(fields.value.note === undefined ? {} : { note: fields.value.note === null ? null : String(fields.value.note) }),
        ...(asString(fields.value.description) === undefined ? {} : { body: asString(fields.value.description) as string }),
        ...(asStringList(fields.value.kb_refs) === undefined ? {} : { kbRefs: asStringList(fields.value.kb_refs) as readonly string[] }),
      },
    }
  } else if (action === 'switch_state') {
    const to = asString(input.to)
    if (to === undefined) return failure(invalidInput('switch_state needs `to`'), caller, me)
    mutation = {
      action: 'switch_state' as const,
      to,
      ...(asString(input.resolution) === undefined ? {} : { resolution: asString(input.resolution) as string }),
      ...(asString(input.resolution_note) === undefined ? {} : { resolutionNote: asString(input.resolution_note) as string }),
    }
  } else if (action === 'close') {
    const comment = asString((input.comment as { body?: unknown } | undefined)?.body)
    mutation = {
      action: 'close' as const,
      ...(asString(input.to) === undefined ? {} : { to: asString(input.to) as string }),
      ...(asString(input.resolution) === undefined ? {} : { resolution: asString(input.resolution) as string }),
      ...(asString(input.resolution_note) === undefined ? {} : { resolutionNote: asString(input.resolution_note) as string }),
      ...(comment === undefined ? {} : { comment }),
    }
  } else if (action === 'comment') {
    const fields = pickKnownKeys(input.comment, ['body'], 'comment')
    if (!fields.ok) return failure(fields.error, caller, me)
    const body = asString(fields.value.body)
    if (body === undefined) return failure(invalidInput('comment needs { body }'), caller, me)
    mutation = { action: 'comment' as const, body }
  } else if (action === 'assignee') {
    const wanted = asString(input.assignee)
    if (wanted !== 'self' && wanted !== 'none') return failure(invalidInput('assignee needs "self" or "none"'), caller, me)
    mutation = { action: 'assignee' as const, value: wanted }
  } else if (action === 'link') {
    const fields = pickKnownKeys(input.link, ['type', 'target', 'op'], 'link')
    if (!fields.ok) return failure(fields.error, caller, me)
    const type = asString(fields.value.type)
    const target = asString(fields.value.target)
    const op = asString(fields.value.op) ?? 'add'
    if (type === undefined || !isLinkType(type)) return failure(invalidInput('link needs a valid `type`', { type }), caller, me)
    if (target === undefined) return failure(invalidInput('link needs a `target` issue key'), caller, me)
    if (op !== 'add' && op !== 'remove') return failure(invalidInput('link `op` must be "add" or "remove"', { op }), caller, me)
    mutation = { action: 'link' as const, type, target: target as IssueKey, op }
  } else {
    return failure(invalidInput(`unsupported action "${action}"`), caller, me)
  }

  const written = await jira.mutateIssue(issueKey, mutation as IssueMutation, actor, {
    ...(typeof input.expected_revision === 'number' ? { expectedRevision: input.expected_revision } : {}),
    ...(input.ack_conflict === true ? { ackConflict: true } : {}),
    ...(input.override === true ? { override: true } : {}),
  })
  if (!written.ok) return failure(written.error, caller, me)
  const rejected = written.value.transaction.commitError === undefined
    ? undefined
    : Object.freeze([Object.freeze({ file: 'git', reason: formatError(written.value.transaction.commitError) })])
  return okValue(caller, me, written.value.transaction.change.issue, written.value.comments, rejected ?? [], 'write')
}
