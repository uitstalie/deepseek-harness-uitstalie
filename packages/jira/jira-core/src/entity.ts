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

/**
 * Decide whether a string is a usable project key.
 * @param value - the candidate key.
 * @returns true when it matches the project-key pattern: uppercase, at most six characters.
 */
export const isProjectKey = (value: string): boolean => PROJECT_KEY_PATTERN.test(value)

/**
 * Decision 162: a project key is a **path segment**, so it is validated before any path is built from
 * it. `/jira new --project ../../tmp/x` used to reach `join(root, 'projects', project, 'issues')` and
 * write outside the ledger; the tool surface had a regex, the command surface and the CLI did not.
 * The check lives here — next to the pattern — so every surface inherits it (decision 185: moved
 * out of `store.ts`, which had it as a private helper of the two path builders).
 * @param project - the candidate key, checked before any path is built from it.
 * @returns the key unchanged, or a refusal naming what is wrong with it.
 */
export const assertProjectKey = (project: string): Result<string, JiraError> =>
  isProjectKey(project)
    ? ok(project)
    : err(invalidInput(`"${project}" is not a project key (expected e.g. "DH": letters and digits, up to six)`, { project }))

/** `<PROJECT>-<n>`: the key is always "a project key, a dash, a number". */
export const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,5}-\d+$/

/**
 * Decide whether a string is shaped like an issue key (`DH-12`).
 * @param value - the candidate key.
 * @returns true for the `<PROJECT>-<n>` shape; whether that issue exists is not checked here.
 */
export const isIssueKey = (value: string): boolean => ISSUE_KEY_PATTERN.test(value)

/**
 * `DH-12` belongs to project `DH` — the directory name is the project key (decision 77).
 * @param key - the issue key to read the project from.
 * @returns the project key prefix.
 */
export const projectOf = (key: IssueKey): string => key.slice(0, key.lastIndexOf('-'))

/**
 * The store-relative paths of the ledger's files (decision 182's **single source**).
 *
 * These are **posix** on every platform — they double as git pathspecs (`git add --`), where
 * backslashes are not portable spelling. `io.ts` derives the absolute, platform-native form from
 * these; nobody else may hand-build one (the audit found the issue path written out three times).
 * @param project - the project key, which is also the directory name.
 * @param key - the issue key naming the file.
 * @returns the store-relative posix path of the issue's Markdown file.
 */
export const issueRelPath = (project: string, key: IssueKey): string =>
  `projects/${project}/issues/${key}.md`

/**
 * The store-relative path of an issue's comment file, in the same posix spelling as the others.
 * @param project - the project key, which is also the directory name.
 * @param key - the issue key naming the file.
 * @returns the store-relative posix path of the comment file.
 */
export const commentRelPath = (project: string, key: IssueKey): string =>
  `projects/${project}/comments/${key}.md`

/**
 * The store-relative path of a project's `project.md`.
 * @param key - the project key.
 * @returns the store-relative posix path of the project file.
 */
export const projectRelPath = (key: string): string => `projects/${key}/project.md`

/**
 * Narrow a string to an issue key. It checks the shape only: nothing is looked up.
 * @param value - the candidate string.
 * @returns the value as an issue key, or undefined when it has the wrong shape.
 */
export const asIssueKey = (value: string): IssueKey | undefined =>
  isIssueKey(value) ? (value as IssueKey) : undefined

/** UTC, ISO-8601, seconds precision (`2026-10-15T08:30:00Z`) — decision 47. */
export type Timestamp = string & { readonly __brand: 'Timestamp' }

const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

/**
 * Decide whether a string is a UTC, second-precision timestamp.
 * @param value - the candidate string.
 * @returns true for the `YYYY-MM-DDTHH:MM:SSZ` shape.
 */
export const isTimestamp = (value: string): boolean => TIMESTAMP_PATTERN.test(value)

/**
 * The clock is never read inside `core` — callers pass a `Date` in (§3.1 ①).
 * @param at - the instant to record.
 * @returns that instant as a `Timestamp`, truncated to whole seconds.
 */
export const utcTimestamp = (at: Date): Timestamp =>
  `${at.toISOString().slice(0, 19)}Z` as Timestamp

/** The identity string of §4.3: `agent:<model>|<tool>|<machine_id>|<session_id>` or `human:<name>`. */
export type Identity = string & { readonly __brand: 'Identity' }

/**
 * Narrow a string to an identity when it carries the `agent:` or `human:` prefix and a body.
 * @param value - the candidate string.
 * @returns the value as an identity, or undefined when it is not one.
 */
export const asIdentity = (value: string): Identity | undefined => {
  if (value.startsWith('agent:')) return value.slice('agent:'.length) === '' ? undefined : (value as Identity)
  if (value.startsWith('human:')) return value.slice('human:'.length) === '' ? undefined : (value as Identity)
  return undefined
}

/** The closed link vocabulary — adding one is a code change (decision 70). */
export const LINK_TYPES = ['related', 'duplicate', 'is_blocked_by', 'parent'] as const
/** One of the closed link verbs; adding a verb is a code change (decision 70). */
export type LinkType = (typeof LINK_TYPES)[number]

/**
 * Decide whether a string names one of the closed link verbs.
 * @param value - the candidate string.
 * @returns true when the value is a `LinkType`.
 */
export const isLinkType = (value: string): value is LinkType =>
  (LINK_TYPES as readonly string[]).includes(value)

/** One directed link from an issue: the verb and the target it points at. */
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

/** One issue as the ledger stores it: the frontmatter fields plus the Markdown body (decision 43). */
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

/** The longest summary a store accepts, in characters; it also bounds the OKF title. */
export const SUMMARY_MAX_CHARS = 120

/** A project's identity anchor is its normalized remote list, never its path (decision 77). */
export type Project = Readonly<{
  name: string
  remotes: readonly string[]
  paths: readonly string[]
  agentWritePolicy: 'shared' | 'owner-machine'
  ownerMachine?: string
}>

/**
 * A machine's registry entry: its identity, what it runs, and the first and last time it was
 * seen in this store.
 */
export type Machine = Readonly<{
  id: string
  label?: string
  os: string
  firstSeen: Timestamp
  lastSeen: Timestamp
}>

/**
 * A tag registration: the canonical name, what it means, and the alternative spellings that
 * resolve to it.
 */
export type Tag = Readonly<{
  name: string
  description: string
  aliases: readonly string[]
}>
