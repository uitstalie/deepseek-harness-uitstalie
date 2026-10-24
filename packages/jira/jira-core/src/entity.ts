/**
 * core/entity — the domain data classes.
 *
 * §3.1 / decision 102: entities are **immutable data**, never class hierarchies. Every
 * type here is `Readonly<...>`, every constructor is a plain function, and "modifying"
 * an entity always means producing a new one.
 *
 * Field names are camelCase **in code**; the disk form is snake_case and the conversion
 * lives only in `codec.ts` (decision 41).
 *
 * Two things are deliberately *not* unions here: `status`, `priority` and `issueType` are
 * open strings, because their value sets live in the store's `config.md` vocabulary and
 * must be changeable without a code change (§4.2, decision 102 ②).
 */

import { type JiraError, invalidInput } from './errors.ts'
import { type Result, err, ok } from './result.ts'

/** `DH-12`: a project key, a dash, and a number (the regex is decision 67's). */
export type IssueKey = string & { readonly __brand: 'IssueKey' }

/**
 * A project key is what `projects/<key>/` is made of, so it is also a **path segment** (decision 162):
 * uppercase, starting with a letter, at most six characters. `..`, `/` and a lowercase name are all
 * refused by this one pattern — the ledger must never build a path out of something a caller typed.
 */
export const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,5}$/u

export const isProjectKey = (value: string): boolean => PROJECT_KEY_PATTERN.test(value)

/**
 * Decision 162: a project key is a **path segment**, so it is validated before any path is built from
 * it. `/jira new --project ../../tmp/x` used to reach `join(root, 'projects', project, 'issues')` and
 * write outside the ledger; the tool surface had a regex, the command surface and the CLI did not.
 * The check lives here — next to the pattern — so every surface inherits it (decision 185: moved
 * out of `store.ts`, which had it as a private helper of the two path builders).
 */
export const assertProjectKey = (project: string): Result<string, JiraError> =>
  isProjectKey(project)
    ? ok(project)
    : err(invalidInput(`"${project}" is not a project key (expected e.g. "DH": letters and digits, up to six)`, { project }))

/** `<PROJECT>-<n>`: the key is always "a project key, a dash, a number". */
export const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,5}-\d+$/

export const isIssueKey = (value: string): boolean => ISSUE_KEY_PATTERN.test(value)

/** `DH-12` belongs to project `DH` — the directory name is the project key (decision 77). */
export const projectOf = (key: IssueKey): string => key.slice(0, key.lastIndexOf('-'))

/**
 * The store-relative paths of the ledger's files (decision 182's **single source**).
 *
 * These are **posix** on every platform — they double as git pathspecs (`git add --`), where
 * backslashes are not portable spelling. `io.ts` derives the absolute, platform-native form from
 * these; nobody else may hand-build one (the audit found the issue path written out three times).
 */
export const issueRelPath = (project: string, key: IssueKey): string =>
  `projects/${project}/issues/${key}.md`

export const commentRelPath = (project: string, key: IssueKey): string =>
  `projects/${project}/comments/${key}.md`

export const projectRelPath = (key: string): string => `projects/${key}/project.md`

export const asIssueKey = (value: string): IssueKey | undefined =>
  isIssueKey(value) ? (value as IssueKey) : undefined

/** UTC, ISO-8601, seconds precision (`2026-10-15T08:30:00Z`) — decision 47. */
export type Timestamp = string & { readonly __brand: 'Timestamp' }

const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

export const isTimestamp = (value: string): boolean => TIMESTAMP_PATTERN.test(value)

/** The clock is never read inside `core` — callers pass a `Date` in (§3.1 ①). */
export const utcTimestamp = (at: Date): Timestamp =>
  `${at.toISOString().slice(0, 19)}Z` as Timestamp

/** The identity string of §4.3: `agent:<model>|<tool>|<machine_id>|<session_id>` or `human:<name>`. */
export type Identity = string & { readonly __brand: 'Identity' }

export const asIdentity = (value: string): Identity | undefined => {
  if (value.startsWith('agent:')) return value.slice('agent:'.length) === '' ? undefined : (value as Identity)
  if (value.startsWith('human:')) return value.slice('human:'.length) === '' ? undefined : (value as Identity)
  return undefined
}

/** The closed link vocabulary — adding one is a code change (decision 70). */
export const LINK_TYPES = ['related', 'duplicate', 'is_blocked_by', 'parent'] as const
export type LinkType = (typeof LINK_TYPES)[number]

export const isLinkType = (value: string): value is LinkType =>
  (LINK_TYPES as readonly string[]).includes(value)

export type Link = Readonly<{ type: LinkType; target: IssueKey }>

/** An append-only, editable-but-not-deletable remark (decisions 42/68/69). */
export type Comment = Readonly<{
  /** `c-<machine short code>-<n>` (decision 68). */
  id: string
  author: Identity
  /** The comment's own counter, initial 1, +1 per body edit (decisions 44/68). */
  revision: number
  createdAt: Timestamp
  body: string
}>

export type Issue = Readonly<{
  key: IssueKey
  project: string
  issueType: string
  status: string
  /** One line, required, ≤120 chars; it doubles as the OKF title (decisions 43/84). */
  summary: string
  priority: string
  tags: readonly string[]
  links: readonly Link[]
  /** Free text the `update` verb may rewrite (decision 51). */
  note?: string
  /** Required for any status inside the store's `closed` set (decision 25). */
  resolution?: string
  resolutionNote?: string
  /** Initial 1, +1 only when the body changes (decision 44). */
  revision: number
  createdAt: Timestamp
  updatedAt: Timestamp
  reporter: Identity
  /** `undefined` = unassigned; an identity = claimed (decision 50's `assignee` verb). */
  assignee?: Identity
  /**
   * §4.8/decision 61: a claim carries a lease. `claimed_at` is when it was taken, and
   * `lease_expires_at` is `claimed_at + 2 h`, renewed by any write that changes this issue —
   * deliberately **two flat scalars**, because the frontmatter subset has no top-level maps.
   */
  claimedAt?: Timestamp
  leaseExpiresAt?: Timestamp
  /** Knowledge entries this issue references, mirroring the KB side's `issues[]` (decision 75). */
  kbRefs: readonly string[]
  /** Set by the conflict pass; cleared by an acknowledged write (decision 71). */
  conflicted: boolean
  /** The description: the Markdown body of the file (decision 43). */
  body: string
}>

export const SUMMARY_MAX_CHARS = 120

/** A project's identity anchor is its normalized remote list, never its path (decision 77). */
export type Project = Readonly<{
  name: string
  remotes: readonly string[]
  paths: readonly string[]
  agentWritePolicy: 'shared' | 'owner-machine'
  ownerMachine?: string
}>

export type Machine = Readonly<{
  id: string
  label?: string
  os: string
  firstSeen: Timestamp
  lastSeen: Timestamp
}>

export type Tag = Readonly<{
  name: string
  description: string
  aliases: readonly string[]
}>
