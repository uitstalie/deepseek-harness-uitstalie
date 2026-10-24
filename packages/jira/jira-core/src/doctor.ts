/**
 * core/doctor — the store's own health check (decision 3's "体检" and decision 83's ops).
 *
 * Everything is checked against a **snapshot** taken by one async reader, so the checks
 * themselves are pure, ordered and testable: a store with a broken vocabulary, a key that
 * does not match its file name, an orphan comment file, two machines that claimed the same
 * number block, a leftover lock, a conflicted issue, or a dirty git tree.
 *
 * The rule for severity: anything that makes a *write* unreliable is an error; anything
 * that makes a human's reading of the store misleading (but leaves writes working) is a
 * warning. `ok` means "no errors", not "nothing to say".
 */

import { parseComments } from './comments.ts'
import { type CountersFile, parseCounters } from './counters.ts'
import { readGeneratedHead } from './generate.ts'
import { GITATTRIBUTES } from './git.ts'
import { type JiraError } from './errors.ts'
import { type Result, ok } from './result.ts'
import { type Vocab, parseVocab } from './vocab.ts'
import { type Timestamp } from './entity.ts'

export type Severity = 'error' | 'warning'

export type Problem = Readonly<{
  severity: Severity
  code: string
  message: string
  path?: string
}>

export type IssueFile = Readonly<{ path: string; project: string; key: string; text: string }>
export type CommentFile = Readonly<{ path: string; key: string; text: string }>
export type CountersEntry = Readonly<{ machineId: string; path: string; raw: string }>

export type GitState = Readonly<{
  repository: boolean
  clean?: boolean
  branch?: string
  ahead?: number
  attributes?: boolean
}>

/** One generated file as it is on disk; `text` is absent when the file is missing. */
export type GeneratedFile = Readonly<{ path: string; text?: string }>

export type Snapshot = Readonly<{
  root: string
  configText?: string
  issues: readonly IssueFile[]
  commentFiles: readonly CommentFile[]
  counters: readonly CountersEntry[]
  /** Lock directories currently present under `.jira/locks/`. */
  locks: readonly string[]
  git?: GitState
  /** The hash the generated heads must carry (decision 79); absent skips the freshness check. */
  sourceTree?: string
  generated?: readonly GeneratedFile[]
  /** How many tags are registered under `tags/` (excluding the generated `index.md`). */
  tags?: number
}>

export type StoreSummary = Readonly<{
  projects: number
  issues: number
  comments: number
  tags: number
  conflicted: number
  counters: number
  /** How many generated files are missing, unmarked or stale (decision 120). */
  generatedStale: number
}>

export type DoctorReport = Readonly<{
  ok: boolean
  problems: readonly Problem[]
  summary: StoreSummary
  vocab?: Vocab
}>

const KEY_OF = /^([A-Z][A-Z0-9]{1,5})-(\d+)$/

const frontmatterValue = (text: string, field: string): string | undefined => {
  const match = new RegExp(`^${field}:\\s*(.*)$`, 'm').exec(text)
  return match?.[1]?.trim()
}

/** The pure half: everything the doctor knows, given a snapshot. */
export const checkStore = (snapshot: Snapshot, now?: Timestamp): DoctorReport => {
  const problems: Problem[] = []
  const add = (severity: Severity, code: string, message: string, path?: string): void => {
    problems.push(Object.freeze({ severity, code, message, ...(path === undefined ? {} : { path }) }))
  }

  let vocab: Vocab | undefined
  if (snapshot.configText === undefined) {
    add('error', 'config-missing', 'the store has no config.md, so nothing can be validated')
  } else {
    const parsed = parseVocab(snapshot.configText)
    if (!parsed.ok) {
      // `jira doctor` is read by a person, so the specifics ride in the message itself
      // rather than only in the error's context (the tool surface stays terse).
      const details = (parsed.error.context?.problems as readonly string[] | undefined) ?? []
      const because = details.length === 0 ? '' : `: ${details.join('; ')}`
      add('error', 'config-invalid', `config.md does not parse: ${parsed.error.message}${because}`, 'config.md')
    } else {
      vocab = parsed.value
    }
  }

  // §4.8/decision 61: an expired claim is worth saying out loud in the doctor too — the holder is
  // gone, and the issue is reclaimable. Only reported when a clock was supplied (this stays pure).
  // 2026-10-23 (DPMJ-401): only for issues that are **still open**. A closed issue keeps its claim
  // as history; "it can be reclaimed" is noise there, and the noise grew with the ledger.
  if (now !== undefined) {
    const closed = new Set(vocab?.closed ?? ['closed', 'cancelled'])
    for (const file of snapshot.issues) {
      const status = frontmatterValue(file.text, 'status')
      if (status !== undefined && closed.has(status)) continue
      const holder = /^assignee:\s*(.+)$/mu.exec(file.text)?.[1]?.trim()
      const expires = /^lease_expires_at:\s*(.+)$/mu.exec(file.text)?.[1]?.trim()
      if (holder !== undefined && expires !== undefined && expires !== '' && expires <= now) {
        problems.push(Object.freeze({
          severity: 'warning' as const,
          code: 'lease-expired',
          message: `${file.key} is claimed by ${holder} but its lease expired at ${expires}; it can be reclaimed`,
          path: file.path,
        }))
      }
    }
  }

  // Keys: unique, matching the file name, and inside the project's own numbering space.
  const seen = new Map<string, string>()
  let conflicted = 0
  for (const issue of snapshot.issues) {
    const fileName = issue.path.replaceAll('\\', '/').split('/').at(-1)?.replace(/\.md$/, '') ?? ''
    if (fileName !== issue.key) {
      add('error', 'key-mismatch', `the file is named ${fileName} but holds ${issue.key}`, issue.path)
    }
    const parsedKey = KEY_OF.exec(issue.key)
    if (parsedKey === null) {
      add('error', 'key-shape', `${issue.key} is not a project key`, issue.path)
    } else if (parsedKey[1] !== issue.project) {
      add('error', 'project-mismatch', `${issue.key} lives under project ${issue.project}`, issue.path)
    }
    const previous = seen.get(issue.key)
    if (previous !== undefined) add('error', 'key-duplicate', `${issue.key} appears twice`, issue.path)
    else seen.set(issue.key, issue.path)

    if (frontmatterValue(issue.text, 'conflicted') === 'true') {
      conflicted += 1
      add('warning', 'conflicted', `${issue.key} is marked conflicted and needs an acknowledgement`, issue.path)
    }
  }

  // Comments: readable, ids unique **within their own file**, and attached to an issue that
  // exists. Numbering is per issue file (decision 68's anchor lives inside the file), so the
  // same id in two different issues' files is expected, not a duplicate.
  const commentIds = new Map<string, string>()
  let comments = 0
  for (const file of snapshot.commentFiles) {
    const parsed = parseComments(file.text)
    if (!parsed.ok) {
      add('error', 'comments-invalid', `the comment file does not parse: ${parsed.error.message}`, file.path)
      continue
    }
    comments += parsed.value.comments.length
    const inThisFile = new Set<string>()
    for (const comment of parsed.value.comments) {
      if (inThisFile.has(comment.id)) {
        add('error', 'comment-id-duplicate', `comment id ${comment.id} appears twice in one file`, file.path)
        continue
      }
      inThisFile.add(comment.id)
      commentIds.set(comment.id, file.path)
    }
    if (!seen.has(file.key) && !snapshot.issues.some(issue => issue.key === file.key)) {
      add('warning', 'comments-orphan', `comment file for ${file.key}, which has no issue file`, file.path)
    }
  }

  // Counters: each parses, and no two machines claimed the same number for one project.
  const claims = new Map<string, { machine: string; path: string }[]>()
  for (const entry of snapshot.counters) {
    const parsed = parseCounters(entry.raw, entry.machineId)
    if (!parsed.ok) {
      add('error', 'counters-invalid', `the counters file does not parse: ${parsed.error.message}`, entry.path)
      continue
    }
    checkCounters(parsed.value, entry.path, claims, add)
  }
  for (const [project, owners] of claims) {
    const ranges: { machine: string; path: string; start: number; end: number }[] = []
    for (const owner of owners) {
      const file = snapshot.counters.find(entry => entry.path === owner.path)
      if (file === undefined) continue
      const parsedCounters = parseCounters(file.raw, file.machineId)
      if (!parsedCounters.ok) continue
      for (const [start, end] of parsedCounters.value.projects[project]?.blocks ?? []) {
        ranges.push({ machine: owner.machine, path: owner.path, start, end })
      }
    }
    ranges.sort((left, right) => left.start - right.start)
    for (let index = 1; index < ranges.length; index += 1) {
      const previous = ranges[index - 1]
      const current = ranges[index]
      if (previous !== undefined && current !== undefined && current.start <= previous.end) {
        add('error', 'counters-overlap',
          `project ${project}: ${current.machine} claims ${current.start}-${current.end}, `
          + `which overlaps ${previous.machine}'s ${previous.start}-${previous.end}`,
          current.path)
      }
    }
  }

  for (const lock of snapshot.locks) {
    add('warning', 'lock-left', `a lock is present: ${lock} (fine while a writer runs, suspicious if not)`, lock)
  }

  if (snapshot.git !== undefined) {
    if (!snapshot.git.repository) {
      add('warning', 'git-missing', 'the store is not a git repository, so there is no audit history')
    } else {
      if (snapshot.git.attributes === false) {
        add('warning', 'git-attributes', '.gitattributes is missing, so line endings are not pinned')
      }
      if (snapshot.git.clean === false) {
        add('warning', 'git-dirty', 'the working tree has uncommitted changes')
      }
      if ((snapshot.git.ahead ?? 0) > 0) {
        add('warning', 'git-ahead', `${String(snapshot.git.ahead)} commit(s) not pushed yet`)
      }
    }
  }

  // Generated files (decisions 39/79/120). The comparison is against the head's own hash, so a
  // file that is current stays quiet no matter how long ago it was written. `log.md` is the one
  // exception: its input is commit history, not files, so its hash cannot prove freshness and it
  // is only reported when it is missing or unmarked — `jira generate --check` is the real test.
  let generatedStale = 0
  if (snapshot.generated !== undefined && snapshot.sourceTree !== undefined) {
    for (const file of snapshot.generated) {
      if (file.text === undefined) {
        add('warning', 'generated-missing', `${file.path} has not been generated yet`, file.path)
        generatedStale += 1
        continue
      }
      const head = readGeneratedHead(file.text)
      if (head === undefined) {
        add('warning', 'generated-unmarked', `${file.path} has no dsh-jira head, so its freshness is unknown`, file.path)
        generatedStale += 1
        continue
      }
      if (head.sourceTree !== snapshot.sourceTree && file.path !== 'log.md') {
        // Decision 179: a manual `git push` never regenerates, so the warning has to name the one
        // command that does (the store's CI checks `generate --check` and will go red otherwise).
        add('warning', 'generated-stale', `${file.path} was generated from other inputs — run \`jira sync\` before pushing (a manual git push will not regenerate it)`, file.path)
        generatedStale += 1
      }
    }
  }

  const projects = new Set(snapshot.issues.map(issue => issue.project))
  return Object.freeze({
    ok: problems.every(problem => problem.severity !== 'error'),
    problems: Object.freeze(problems),
    summary: Object.freeze({
      projects: projects.size,
      issues: snapshot.issues.length,
      comments,
      tags: snapshot.tags ?? 0,
      generatedStale,
      conflicted,
      counters: snapshot.counters.length,
    }),
    ...(vocab === undefined ? {} : { vocab }),
  })
}

const checkCounters = (
  file: CountersFile,
  path: string,
  claims: Map<string, { machine: string; path: string }[]>,
  add: (severity: Severity, code: string, message: string, path?: string) => void,
): void => {
  for (const [project, counter] of Object.entries(file.projects)) {
    const owners = claims.get(project) ?? []
    owners.push({ machine: file.machine_id, path })
    claims.set(project, owners)

    const blocks = [...counter.blocks].sort((left, right) => left[0] - right[0])
    for (let index = 1; index < blocks.length; index += 1) {
      const previous = blocks[index - 1]
      const current = blocks[index]
      if (previous !== undefined && current !== undefined && current[0] <= previous[1]) {
        add('error', 'counters-block-overlap',
          `${file.machine_id} claims ${current[0]}-${current[1]} for ${project}, overlapping its own ${previous[0]}-${previous[1]}`,
          path)
      }
    }
    const first = blocks[0]?.[0] ?? 1
    const next = counter.next
    if (next < first) {
      add('error', 'counters-next-behind', `${file.machine_id}: next=${next} is before the first block`, path)
    }
  }
}

export const errorCount = (report: DoctorReport): number =>
  report.problems.filter(problem => problem.severity === 'error').length

export const warningCount = (report: DoctorReport): number =>
  report.problems.filter(problem => problem.severity === 'warning').length

/** The human/model-facing text: errors first, then warnings, then the summary. */
export const renderDoctorReport = (report: DoctorReport): string => {
  const lines: string[] = []
  const order: Severity[] = ['error', 'warning']
  for (const severity of order) {
    for (const problem of report.problems.filter(entry => entry.severity === severity)) {
      lines.push(`${severity === 'error' ? '✗' : '!'} ${problem.code}: ${problem.message}`)
    }
  }
  if (lines.length === 0) lines.push('没有发现问题')
  const { projects, issues, comments, tags, conflicted } = report.summary
  lines.push(`账本：${projects} 个项目，${issues} 条 issue，${comments} 条评论，${tags} 个标签，${conflicted} 条 conflicted`)
  lines.push(`结果：${report.ok ? '正常' : '有错误'}（${errorCount(report)} 个错误，${warningCount(report)} 个警告）`)
  return `${lines.join('\n')}\n`
}

/** The IO half reads a snapshot; the checks stay pure. */
export type SnapshotReader = (root: string) => Promise<Snapshot>

export const doctor = async (root: string, read: SnapshotReader): Promise<Result<DoctorReport, JiraError>> =>
  ok(checkStore(await read(root)))

/** The attribute line the doctor looks for, exported so the two cannot drift. */
export const REQUIRED_ATTRIBUTE = GITATTRIBUTES.split('\n')[1] ?? ''
