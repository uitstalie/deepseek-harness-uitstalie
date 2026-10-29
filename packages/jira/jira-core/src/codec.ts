/**
 * core/codec — the one place where disk names and code names meet.
 *
 * §3.1 / decisions 41, 43, 45, 46, 47, 70: on disk everything is `lower_snake_case`, the
 * body is the description, the frontmatter carries `schema`/`type`, and timestamps are
 * UTC ISO-8601 to the second. In code we use camelCase. This module is the seam.
 *
 * Asymmetry by design (decision 49/80): **reads are tolerant** — unknown keys are
 * reported as warnings instead of failing — while `validate.ts` rejects them on the way
 * in. A file somebody hand-edited must still be readable; a new record must be strict.
 */

import {
  type Identity,
  type Issue,
  type IssueKey,
  type Link,
  type LinkType,
  type Timestamp,
  asIssueKey,
  isLinkType,
} from './entity.ts'
import { type JiraError, invalidInput } from './errors.ts'
import { type Frontmatter, type FrontmatterMap, type FrontmatterValue, parseFrontmatter, renderFrontmatter } from './frontmatter.ts'
import { type Result, err, ok } from './result.ts'

export const ISSUE_SCHEMA = 'issue/v1'
export const ISSUE_DOCUMENT_TYPE = 'issue'

/** Disk key → entity field. Only this table knows the snake_case spellings (decision 41). */
const FIELD_BY_DISK_KEY = {
  schema: 'schema',
  type: 'type',
  project: 'project',
  issue_type: 'issueType',
  status: 'status',
  summary: 'summary',
  priority: 'priority',
  tags: 'tags',
  links: 'links',
  note: 'note',
  resolution: 'resolution',
  resolution_note: 'resolutionNote',
  revision: 'revision',
  created_at: 'createdAt',
  updated_at: 'updatedAt',
  reporter: 'reporter',
  assignee: 'assignee',
  claimed_at: 'claimedAt',
  lease_expires_at: 'leaseExpiresAt',
  kb_refs: 'kbRefs',
  conflicted: 'conflicted',
} as const

type DiskKey = keyof typeof FIELD_BY_DISK_KEY

const DISK_KEYS = Object.keys(FIELD_BY_DISK_KEY) as readonly DiskKey[]

export type DecodedIssue = Readonly<{
  issue: Issue
  /** Tolerated-on-read remarks: unknown keys, version surprises, mismatched key. */
  warnings: readonly string[]
  /**
   * Frontmatter keys this version does not know. Reading tolerates them (decision 49's read side),
   * but a **write** must refuse rather than re-encode the file without them — silently destroying
   * somebody's field is the one outcome nobody can debug afterwards.
   */
  unknownKeys: readonly string[]
  /** The `schema` the file actually carries, so a writer can refuse an unsupported version (46). */
  schema: string
}>

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

const asStringArray = (value: unknown): readonly string[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const items: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return undefined
    items.push(item)
  }
  return Object.freeze(items)
}

const decodeLinks = (value: unknown): Result<readonly Link[], JiraError> => {
  if (value === undefined || value === null) return ok(Object.freeze([]))
  if (!Array.isArray(value)) return err(invalidInput('`links` must be an array'))
  const links: Link[] = []
  for (const entry of value) {
    // Decision 70 chooses `links: [{ type, target }]`; the restricted subset admits
    // exactly one level of flow map, so anything else here is a real error.
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return err(invalidInput('each `links` entry must be a `{ type, target }` map'))
    }
    const record = entry as Record<string, unknown>
    const type = asString(record.type)
    const target = asString(record.target)
    if (type === undefined || target === undefined) return err(invalidInput('each `links` entry needs `type` and `target`'))
    if (!isLinkType(type)) return err(invalidInput(`unknown link type "${type}"`, { type }))
    const key = asIssueKey(target)
    if (key === undefined) return err(invalidInput(`link target "${target}" is not an issue key`, { target }))
    links.push(Object.freeze({ type: type as LinkType, target: key }))
  }
  return ok(Object.freeze(links))
}

/**
 * Read an issue from its file text. `key` comes from the file name (the name is the
 * identity; decision 77's principle applied to issues), and a frontmatter `key` that
 * disagrees is reported rather than silently preferred.
 * @param text - the issue file's full text, frontmatter and body.
 * @param key - the issue key derived from the file name; the identity of the issue.
 * @returns the decoded issue, or the validation failure that stops the read.
 */
export const decodeIssue = (text: string, key: IssueKey): Result<DecodedIssue, JiraError> => {
  const parsed = parseFrontmatter(text)
  if (!parsed.ok) return parsed
  const { frontmatter, body } = parsed.value
  const warnings: string[] = []
  const unknownKeys: string[] = []

  for (const diskKey of Object.keys(frontmatter)) {
    if (!(DISK_KEYS as readonly string[]).includes(diskKey)) {
      unknownKeys.push(diskKey)
      warnings.push(`unknown frontmatter key "${diskKey}" (ignored on read)`)
    }
  }

  const schema = asString(frontmatter.schema)
  if (schema === undefined) return err(invalidInput('frontmatter is missing `schema`', { key }))
  if (schema !== ISSUE_SCHEMA) {
    warnings.push(`unexpected schema "${schema}", expected "${ISSUE_SCHEMA}"`)
  }
  const documentType = asString(frontmatter.type)
  if (documentType !== ISSUE_DOCUMENT_TYPE) {
    return err(invalidInput(`frontmatter \`type\` must be "${ISSUE_DOCUMENT_TYPE}"`, { type: documentType }))
  }
  // C3: the file name *is* the identity, so a stored `key` would be a second source of
  // truth. Decision 77 refused exactly that for `project.md`; we refuse it here too.
  if (frontmatter.key !== undefined) {
    return err(invalidInput('frontmatter must not carry `key`: the file name is the identity', {
      key: frontmatter.key,
    }))
  }

  const required = (name: DiskKey): Result<string, JiraError> => {
    const value = asString(frontmatter[name])
    return value === undefined || value === ''
      ? err(invalidInput(`frontmatter is missing \`${name}\``, { key, field: name }))
      : ok(value)
  }

  const parts = {
    project: required('project'),
    status: required('status'),
    summary: required('summary'),
    priority: required('priority'),
    createdAt: required('created_at'),
    updatedAt: required('updated_at'),
    reporter: required('reporter'),
    issueType: required('issue_type'),
  }
  for (const part of Object.values(parts)) if (!part.ok) return part

  const links = decodeLinks(frontmatter.links)
  if (!links.ok) return links

  const revisionValue = frontmatter.revision
  const revision = typeof revisionValue === 'number'
    ? revisionValue
    : revisionValue === undefined || revisionValue === null
      ? 1 // decision 44: the initial revision is 1, never 0 (JS falsiness)
      : Number.NaN
  if (!Number.isSafeInteger(revision) || revision < 1) {
    return err(invalidInput('`revision` must be a positive integer', { revision: revisionValue }))
  }

  const assigneeValue = frontmatter.assignee
  const issue: Issue = Object.freeze({
    key,
    project: (parts.project as { value: string }).value,
    issueType: (parts.issueType as { value: string }).value,
    status: (parts.status as { value: string }).value,
    summary: (parts.summary as { value: string }).value,
    priority: (parts.priority as { value: string }).value,
    tags: asStringArray(frontmatter.tags) ?? Object.freeze([]),
    links: links.value,
    ...(asString(frontmatter.note) === undefined ? {} : { note: asString(frontmatter.note) as string }),
    ...(asString(frontmatter.resolution) === undefined ? {} : { resolution: asString(frontmatter.resolution) as string }),
    ...(asString(frontmatter.resolution_note) === undefined ? {} : { resolutionNote: asString(frontmatter.resolution_note) as string }),
    revision,
    createdAt: (parts.createdAt as { value: string }).value as Timestamp,
    updatedAt: (parts.updatedAt as { value: string }).value as Timestamp,
    reporter: (parts.reporter as { value: string }).value as Identity,
    ...(assigneeValue === undefined || assigneeValue === null ? {} : { assignee: String(assigneeValue) as Identity }),
    // §4.8's lease: two flat scalars, meaningful only with an assignee — the assignee is the authority.
    ...(assigneeValue === undefined || assigneeValue === null || asString(frontmatter.claimed_at) === undefined
      ? {}
      : { claimedAt: asString(frontmatter.claimed_at) as Timestamp }),
    ...(assigneeValue === undefined || assigneeValue === null || asString(frontmatter.lease_expires_at) === undefined
      ? {}
      : { leaseExpiresAt: asString(frontmatter.lease_expires_at) as Timestamp }),
    kbRefs: asStringArray(frontmatter.kb_refs) ?? Object.freeze([]),
    conflicted: frontmatter.conflicted === true,
    body,
  })
  return ok(Object.freeze({ issue, warnings: Object.freeze(warnings), unknownKeys: Object.freeze(unknownKeys), schema: schema as string }))
}

const diskLinks = (links: readonly Link[]): readonly FrontmatterMap[] =>
  links.map(link => Object.freeze({ type: link.type, target: link.target }))

/**
 * Write an issue back to file text. Field order follows the entity so that a diff shows
 * what actually changed, and the body is written verbatim after one blank line. `key` is
 * deliberately absent: the file name carries it (C3 / decision 77's principle).
 */
export const encodeIssue = (issue: Issue): Result<string, JiraError> => {
  const frontmatter: Record<string, FrontmatterValue> = {
    schema: ISSUE_SCHEMA,
    type: ISSUE_DOCUMENT_TYPE,
    project: issue.project,
    issue_type: issue.issueType,
    status: issue.status,
    summary: issue.summary,
    priority: issue.priority,
    tags: issue.tags,
    links: diskLinks(issue.links),
    revision: issue.revision,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    reporter: issue.reporter,
    kb_refs: issue.kbRefs,
    conflicted: issue.conflicted,
  }
  if (issue.note !== undefined) frontmatter.note = issue.note
  if (issue.resolution !== undefined) frontmatter.resolution = issue.resolution
  if (issue.resolutionNote !== undefined) frontmatter.resolution_note = issue.resolutionNote
  if (issue.assignee !== undefined) frontmatter.assignee = issue.assignee
  // §4.8: the lease rides along with the claim, and any issue-changing write renews it
  // (decision 61) — two flat scalars, because the frontmatter subset has no top-level maps.
  if (issue.claimedAt !== undefined) frontmatter.claimed_at = issue.claimedAt
  if (issue.leaseExpiresAt !== undefined) frontmatter.lease_expires_at = issue.leaseExpiresAt
  return ok(renderFrontmatter(frontmatter as Frontmatter, issue.body))
}
