/**
 * plugin/toolIssue — `jira_issue`: read or change one issue (decisions 50/82/89/93).
 *
 * Split out of `index.ts` under decision 186. The schema, the description and the runner live
 * together so the tool's surface is edited in exactly one place; `index.ts` only registers them.
 */

import { decodeIssue } from '@deepseek-ai/dsh-jira-core/codec.ts'
import { blockersOf } from '@deepseek-ai/dsh-jira-core/inspect.ts'
import { type Identity, type IssueKey, isLinkType, isProjectKey } from '@deepseek-ai/dsh-jira-core/entity.ts'
import { type JiraError, formatError, invalidInput, readOnlySession, staleRevision } from '@deepseek-ai/dsh-jira-core/errors.ts'
import {
  type Change,
  applyAckConflict,
  applyAssignee,
  applyClose,
  applyComment,
  applyLink,
  applyTransition,
  applyUpdate,
  combineChanges,
} from '@deepseek-ai/dsh-jira-core/mutate.ts'
import { access } from 'node:fs/promises'
import { join } from 'node:path'

import { assertProjectWritable, ensureWorkspaceProject } from '@deepseek-ai/dsh-jira-core/project.ts'
import { createTag } from '@deepseek-ai/dsh-jira-core/tagstore.ts'
import { type Result, err, ok } from '@deepseek-ai/dsh-jira-core/result.ts'
import { closeMany } from '@deepseek-ai/dsh-jira-core/batch.ts'
import { type FieldSpec, pickKnownKeys, validateArgs } from '@deepseek-ai/dsh-jira-core/schema.ts'
import { type TransactOptions, createInStore, projectOf, readComments, readIssueText, transact } from '@deepseek-ai/dsh-jira-core/store.ts'
import { resolveWorkspace } from '@deepseek-ai/dsh-jira-core/workspace.ts'
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
  const { store, caller } = options

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
    let project = (asString(input.project) ?? '').toUpperCase()
    if (project === '') {
      // Decision 133 (4.10): a write from a checkout whose project is unknown registers it --
      // the derived key, the remote, this path, and the policy that decides who may write later.
      if (caller.cwd === undefined) {
        return failure(invalidInput('create needs project: this session has no checkout to infer one from', { project }), caller, me)
      }
      const binding = await resolveWorkspace(store, caller.cwd)
      if (!binding.ok) return failure(binding.error, caller, me)
      const ensured = await ensureWorkspaceProject(store, actor, binding.value, store.machineId)
      if (!ensured.ok) return failure(ensured.error, caller, me)
      project = ensured.value.key
    }
    if (!isProjectKey(project)) {
      return failure(invalidInput('create needs `project`, e.g. "DH"', { project }), caller, me)
    }
    const fields = pickKnownKeys(input.data, CREATE_FIELDS, 'data')
    if (!fields.ok) return failure(fields.error, caller, me)
    const created = await createInStore(store, project, actor, {
      issueType: asString(fields.value.issue_type) ?? 'task',
      summary: asString(fields.value.summary) ?? '',
      ...(asString(fields.value.priority) === undefined ? {} : { priority: asString(fields.value.priority) as string }),
      ...(asString(fields.value.status) === undefined ? {} : { status: asString(fields.value.status) as string }),
      ...(asStringList(fields.value.tags) === undefined ? {} : { tags: asStringList(fields.value.tags) as readonly string[] }),
      ...(asString(fields.value.note) === undefined ? {} : { note: asString(fields.value.note) as string }),
      ...(asString(fields.value.assignee) === undefined ? {} : { assignee: asString(fields.value.assignee) as string }),
      ...(asString(fields.value.description) === undefined ? {} : { body: asString(fields.value.description) as string }),
    })
    if (!created.ok) return failure(created.error, caller, me)
    // Decision 195 (trial feedback P2-2): `create --project KB` used to register the project implicitly
    // and say nothing. The receipt now names that fact, so the caller is not surprised by a new project
    // appearing in the ledger (and the new project directory was the evidence).
    const projectExisted = await access(join(store.files.root, 'projects', project)).then(() => true).catch(() => false)
    options.onWrote?.()
    // Decisions 10/119: the session record lands once, at its first write. The recorder comes from
    // `apply`'s closure (decision 183) — no module-level memory survives a reload.
    if (options.session !== undefined && caller.sessionId !== undefined && options.recordSession !== undefined) {
      await options.recordSession(options.jira, actor, caller.sessionId, options.session)
    }
    return okValue(caller, me, {
      ...created.value.change.issue,
      // Named only when this call created it; absent otherwise, so the common case stays quiet.
      ...(projectExisted ? {} : { project_created: true }),
    })
  }

  // Decision 196 (trial feedback P0-3): closing several issues in one call, all-or-nothing. The refusals
  // are collected across every key, so one call tells the caller everything to fix.
  if (action === 'batch_close') {
    const keys = asStringList(input.keys) ?? []
    const resolution = asString(input.resolution)
    if (resolution === undefined) return failure(invalidInput('batch_close needs `resolution`'), caller, me)
    const comment = asString((input.comment as { body?: unknown } | undefined)?.body)
    const closed = await closeMany(store, keys.map(key => key as never), actor, {
      ...(asString(input.to) === undefined ? {} : { to: asString(input.to) as string }),
      resolution,
      ...(asString(input.resolution_note) === undefined ? {} : { resolutionNote: asString(input.resolution_note) as string }),
      ...(comment === undefined ? {} : { comment }),
    })
    if (!closed.ok) return failure(closed.error, caller, me)
    options.onWrote?.()
    return okValue(caller, me, {
      closed: closed.value.closed,
      ...(closed.value.partial === undefined ? {} : { partial: closed.value.partial }),
    })
  }

  // Decision 192 (trial feedback P0-2): a tag is store vocabulary, not an issue — but the tool surface
  // had no way to create one, so an agent could not close the loop "make a tag, then tag an issue".
  // Same core path as `jira tag-create` (decision 138).
  if (action === 'tag_create') {
    const fields = pickKnownKeys(input.data, TAG_CREATE_FIELDS, 'data')
    if (!fields.ok) return failure(fields.error, caller, me)
    const name = asString(fields.value.name) ?? ''
    const description = asString(fields.value.description) ?? ''
    if (description.trim() === '') {
      return failure(invalidInput('tag_create needs `description`: the registry exists to explain the tag (decision 26)'), caller, me)
    }
    const alias = asString(fields.value.alias)
    const created = await createTag(store, actor, {
      name,
      description,
      ...(alias === undefined ? {} : { aliases: [alias] }),
    })
    if (!created.ok) return failure(created.error, caller, me)
    options.onWrote?.()
    return okValue(caller, me, { tag: created.value.tag, committed: created.value.committed })
  }

  if (key === undefined) return failure(invalidInput(`\`${action}\` needs a \`key\``), caller, me)

  // A read is a read (decision 38): no lock, no vocabulary, no write. The tolerated
  // remarks from decoding come back as `rejected` rather than failing the read.
  if (action === 'get') {
    const text = await readIssueText(store, key as never)
    if (!text.ok) return failure(text.error, caller, me)
    const decoded = decodeIssue(text.value, key as never)
    if (!decoded.ok) return failure(decoded.error, caller, me)
    const comments = await readComments(store, key as never)
    const rejected = decoded.value.warnings.map(reason => Object.freeze({ file: key, reason }))
    return okValue(caller, me, decoded.value.issue, comments.ok ? comments.value : undefined, rejected)
  }

  const mutate = (
    original: Parameters<typeof applyUpdate>[0],
    ctx: Parameters<typeof applyUpdate>[2],
  ): Result<Change, JiraError> => {
    const expected = typeof input.expected_revision === 'number' ? input.expected_revision : undefined
    if (expected !== undefined && expected !== original.revision) {
      // Decisions 44/52: refused with the **typed** error and the value actually found, so a
      // caller can tell "somebody else wrote it" apart from "your input was wrong".
      return err(staleRevision(expected, original.revision))
    }
    if (original.conflicted === true && input.ack_conflict !== true) {
      return err(invalidInput(`${original.key} is marked conflicted; pass ack_conflict to overwrite it deliberately`, {
        key: original.key,
      }))
    }

    // Acknowledging happens **before** the action, so the change is applied to the
    // acknowledged issue. Doing it the other way round leaves `conflicted: true` riding
    // along in the result — the flag would never actually clear.
    const acked: Result<Change, JiraError> = original.conflicted === true && input.ack_conflict === true
      ? applyAckConflict(original, ctx)
      : ok(Object.freeze({ issue: original, comments: Object.freeze([]) }))
    if (!acked.ok) return acked
    const issue = acked.value.issue

    /** The action's change, merged with the acknowledgement that preceded it. */
    const finish = (change: Result<Change, JiraError>): Result<Change, JiraError> =>
      change.ok ? ok(combineChanges(acked.value, change.value)) : change

    switch (action) {
      case 'update': {
        const fields = pickKnownKeys(input.data, UPDATE_FIELDS, 'data')
        if (!fields.ok) return fields
        return finish(applyUpdate(issue, {
          ...(asString(fields.value.summary) === undefined ? {} : { summary: asString(fields.value.summary) as string }),
          ...(asString(fields.value.issue_type) === undefined ? {} : { issueType: asString(fields.value.issue_type) as string }),
          ...(asString(fields.value.priority) === undefined ? {} : { priority: asString(fields.value.priority) as string }),
          ...(asStringList(fields.value.tags) === undefined ? {} : { tags: asStringList(fields.value.tags) as readonly string[] }),
          ...(fields.value.note === undefined ? {} : { note: fields.value.note === null ? null : String(fields.value.note) }),
          ...(asString(fields.value.description) === undefined ? {} : { body: asString(fields.value.description) as string }),
          ...(asStringList(fields.value.kb_refs) === undefined ? {} : { kbRefs: asStringList(fields.value.kb_refs) as readonly string[] }),
        }, ctx))
      }
      case 'switch_state': {
        const to = asString(input.to)
        if (to === undefined) return err(invalidInput('switch_state needs `to`'))
        return finish(applyTransition(issue, to, {
          ...(asString(input.resolution) === undefined ? {} : { resolution: asString(input.resolution) as string }),
          ...(asString(input.resolution_note) === undefined ? {} : { resolutionNote: asString(input.resolution_note) as string }),
        }, ctx))
      }
      // Decision 193 (trial feedback P0-3): closing used to need `comment` + `switch_state`, two writes
      // and two commits per issue. `close` composes them — the same rules, one transaction.
      case 'close': {
        const comment = asString((input.comment as { body?: unknown } | undefined)?.body)
        return finish(applyClose(issue, {
          ...(asString(input.to) === undefined ? {} : { to: asString(input.to) as string }),
          ...(asString(input.resolution) === undefined ? {} : { resolution: asString(input.resolution) as string }),
          ...(asString(input.resolution_note) === undefined ? {} : { resolutionNote: asString(input.resolution_note) as string }),
          ...(comment === undefined ? {} : { comment }),
        }, ctx))
      }
      case 'comment': {
        const fields = pickKnownKeys(input.comment, ['body'], 'comment')
        if (!fields.ok) return fields
        const body = asString(fields.value.body)
        if (body === undefined) return err(invalidInput('comment needs { body }'))
        return finish(applyComment(issue, body, ctx))
      }
      case 'assignee': {
        const wanted = asString(input.assignee)
        if (wanted !== 'self' && wanted !== 'none') return err(invalidInput('assignee needs "self" or "none"'))
        return finish(applyAssignee(issue, wanted === 'none' ? null : (ctx.by as Identity), ctx))
      }
      case 'link': {
        const fields = pickKnownKeys(input.link, ['type', 'target', 'op'], 'link')
        if (!fields.ok) return fields
        const type = asString(fields.value.type)
        const target = asString(fields.value.target)
        const op = asString(fields.value.op) ?? 'add'
        if (type === undefined || !isLinkType(type)) return err(invalidInput('link needs a valid `type`', { type }))
        if (target === undefined) return err(invalidInput('link needs a `target` issue key'))
        if (op !== 'add' && op !== 'remove') return err(invalidInput('link `op` must be "add" or "remove"', { op }))
        return finish(applyLink(issue, { type, target: target as never, op }, ctx))
      }
      default:
        return err(invalidInput(`unsupported action "${action}"`))
    }
  }

  // 4.11: a project anchored to another machine refuses this agent's write; humans still write.
  const allowed = await assertProjectWritable(store, projectOf(key as IssueKey), String(actor.by))
  if (!allowed.ok) return failure(allowed.error, caller, me)
  // Decision 24: an agent claiming an issue must be told what still blocks it; the caller
  // supplies the blockers because answering needs the whole issue map.
  let writeOptions: TransactOptions = {}
  if (action === 'assignee' && asString(input.assignee) === 'self') {
    const blockers = await blockersOf(store, key as IssueKey)
    if (!blockers.ok) return failure(blockers.error, caller, me)
    writeOptions = { blockers: blockers.value, override: input.override === true }
  }
  const result = await transact(store, key as never, actor, mutate, action, writeOptions)
  if (!result.ok) return failure(result.error, caller, me)

  options.onWrote?.()
  const comments = await readComments(store, key as never)
  // A write that landed but could not be committed is not a failure — the file is the
  // truth source — yet it must be visible (decisions 80/115).
  const rejected = result.value.commitError === undefined
    ? undefined
    : Object.freeze([Object.freeze({ file: 'git', reason: formatError(result.value.commitError) })])
  return okValue(caller, me, result.value.change.issue, comments.ok ? comments.value : undefined, rejected, 'write')
}
