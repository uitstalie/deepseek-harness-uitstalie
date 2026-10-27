/**
 * core/render — turning entities into text, for humans and for models.
 *
 * Decision 55 splits the surfaces: model-facing output is English and compact; the human
 * view (CLI, `/jira`) is allowed to be comfortable to read. Both live here as pure
 * functions so either surface can be tested without a store.
 */

import { type Timestamp, type Comment, type Issue } from './entity.ts'
import { type Vocab, statusOrder } from './vocab.ts'
import { type JiraError, formatError } from './errors.ts'
import { type Result } from './result.ts'

/**
 * Decision 55's two surfaces, made an explicit option rather than a global.
 *
 * The functions that **both** surfaces call ({@link renderIssueHuman}, {@link leaseNote},
 * `renderKbSearch`) default to English — that is the model's view — and the CLI asks for `zh` at
 * its own call site. So editing the human text can never silently change what a tool returns.
 */
export type Locale = 'en' | 'zh'

/** The words `renderIssueHuman`/`leaseNote` vary by locale; everything else they print is data. */
type IssueWords = Readonly<{
  /** Field labels, colon included, so the Chinese ones can use a full-width colon. */
  project: string
  type: string
  revision: string
  conflicted: string
  tags: string
  reporter: string
  assignee: string
  unassigned: string
  created: string
  updated: string
  links: string
  kb: string
  resolution: string
  note: string
  /** `comments (2):` — a heading with a count in it. */
  comments: (count: number) => string
  /** How a lease note is appended to the assignee line. */
  lease: (note: string) => string
  leaseUntil: string
  leaseExpired: string
  reclaimable: string
}>

const ISSUE_WORDS: Readonly<Record<Locale, IssueWords>> = Object.freeze({
  en: Object.freeze({
    project: 'project: ', type: 'type: ', revision: 'revision: ', conflicted: 'CONFLICTED',
    tags: 'tags: ', reporter: 'reporter: ', assignee: 'assignee: ', unassigned: '(unassigned)',
    created: 'created: ', updated: 'updated: ', links: 'links: ', kb: 'kb: ',
    resolution: 'resolution: ', note: 'note: ',
    comments: (count: number) => `comments (${String(count)}):`,
    lease: (note: string) => ` (${note})`,
    leaseUntil: 'lease until ',
    leaseExpired: 'lease expired at ',
    reclaimable: ' — reclaimable',
  }),
  zh: Object.freeze({
    project: '项目：', type: '类型：', revision: '版本：', conflicted: 'CONFLICTED',
    tags: '标签：', reporter: '报告者：', assignee: '认领：', unassigned: '（未认领）',
    created: '创建：', updated: '更新：', links: '链接：', kb: '知识：',
    resolution: '结论：', note: '备注：',
    comments: (count: number) => `评论（${String(count)}）：`,
    lease: (note: string) => `（${note}）`,
    leaseUntil: '租约至 ',
    leaseExpired: '租约已于 ',
    reclaimable: ' 到期 —— 可接管',
  }),
})

/** One line, used by `jira list` and the injection counter (decision 53's grouping aside). */
export const renderIssueLine = (issue: Issue): string =>
  `${issue.key}  ${issue.status}  ${issue.priority}  ${issue.summary}`

/** Machine form: what the tools return, and what `--json` prints. */
/**
 * Decision 41's wire shape: **every JSON key is snake_case**.
 *
 * Applied **at the boundary** rather than per builder: entities are camelCase inside TypeScript
 * (which is what makes them pleasant to write), and every value that crosses into JSON — this file's
 * {@link renderIssueJson}, the three tools' results, the CLI's `--json` — goes through here. Six
 * hand-written mappings would drift; one transform cannot.
 *
 * Only **keys** change. Values are never touched: a summary, an identity, a key or a file path may
 * contain anything at all, camelCase included.
 */
export const toWire = (value: unknown): unknown => {
  if (Array.isArray(value)) return Object.freeze(value.map(entry => toWire(entry)))
  if (value === null || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key.replace(/[A-Z]/gu, letter => `_${letter.toLowerCase()}`)] = toWire(entry)
  }
  return Object.freeze(out)
}

/**
 * The inverse of {@link toWire}, for the one place that must speak entities again: the host hands a
 * tool's **wire** value back to `output.render`, and the renderers are typed on entities. Keeping the
 * transform symmetric is what makes that boundary explicit rather than a set of `as never` casts that
 * silently read `undefined` (that is exactly how `issue.kbRefs` crashed a live `get` on 2026-10-17).
 */
export const fromWire = (value: unknown): unknown => {
  if (Array.isArray(value)) return Object.freeze(value.map(entry => fromWire(entry)))
  if (value === null || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key.replace(/_([a-z0-9])/gu, (_match, letter: string) => letter.toUpperCase())] = fromWire(entry)
  }
  return Object.freeze(out)
}

export const renderIssueJson = (issue: Issue, comments: readonly Comment[] = []): string =>
  JSON.stringify(toWire({ ...issue, comments }), null, 2)


/**
 * The human view: a header, the facts that matter, then the description.
 *
 * The CLI (a person) passes `zh`; the plugin (the model) takes the English default. The **data** —
 * key, status, priority, project, summary, identities, timestamps, link types — is the same in both.
 */
/**
 * Decision 195 (trial feedback P2-1): the human surface shows **local** time next to UTC.
 *
 * Files stay UTC (decision 47) — this is presentation only. `toLocaleString` with the machine's zone
 * keeps it correct across DST, and the offset is printed so the string is unambiguous when pasted into
 * an issue that another machine reads.
 */
export const withLocalTime = (utc: string, now: Date = new Date(utc)): string => {
  if (Number.isNaN(now.getTime())) return utc
  const local = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} `
    + `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  const offsetMinutes = -now.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const hours = String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, '0')
  const minutes = String(Math.abs(offsetMinutes) % 60).padStart(2, '0')
  return `${utc}（本地 ${local} ${sign}${hours}:${minutes}）`
}

export const renderIssueHuman = (
  issue: Issue,
  comments: readonly Comment[] = [],
  now?: Timestamp,
  locale: Locale = 'en',
): string => {
  const words = ISSUE_WORDS[locale]
  const lines: string[] = []
  lines.push(`${issue.key}  [${issue.status}]  ${issue.priority}  ${issue.summary}`)
  const facts: string[] = [
    `${words.project}${issue.project}`,
    `${words.type}${issue.issueType}`,
    `${words.revision}${issue.revision}`,
  ]
  if (issue.conflicted) facts.push(words.conflicted)
  lines.push(facts.join('   '))
  if (issue.tags.length > 0) lines.push(`${words.tags}${issue.tags.join(', ')}`)
  lines.push(`${words.reporter}${issue.reporter}`)
  const lease = leaseNote(issue, now, locale)
  lines.push(`${words.assignee}${issue.assignee ?? words.unassigned}${lease === undefined ? '' : words.lease(lease)}`)
  lines.push(`${words.created}${withLocalTime(issue.createdAt)}   ${words.updated}${withLocalTime(issue.updatedAt)}`)
  if (issue.links.length > 0) {
    lines.push(`${words.links}${issue.links.map(link => `${link.type} ${link.target}`).join(', ')}`)
  }
  if (issue.kbRefs.length > 0) lines.push(`${words.kb}${issue.kbRefs.join(', ')}`)
  if (issue.resolution !== undefined) {
    lines.push(`${words.resolution}${issue.resolution}${issue.resolutionNote === undefined ? '' : ` — ${issue.resolutionNote}`}`)
  }
  if (issue.note !== undefined) lines.push(`${words.note}${issue.note}`)
  if (comments.length > 0) {
    lines.push('', words.comments(comments.length))
    for (const comment of comments) {
      lines.push(`  ${comment.id}  ${comment.author}  ${comment.createdAt}`)
      for (const bodyLine of comment.body.split('\n')) lines.push(`    ${bodyLine}`)
    }
  }
  if (issue.body.trim() !== '') lines.push('', issue.body.replace(/\n+$/, ''))
  return `${lines.join('\n')}\n`
}

/** One failure, in the shape every surface uses (decision 52's single definition). */
export const renderError = (error: JiraError): string => formatError(error)

export const asExitCode = (result: Result<unknown, JiraError>): number => (result.ok ? 0 : 1)

/**
 * Model-facing text has a budget (decision 84): the body is **never** returned whole, and
 * a truncation says so instead of ending mid-sentence as if that were the end.
 */
export const MODEL_TEXT_BUDGET = 8 * 1024

export const clampText = (text: string, budget: number = MODEL_TEXT_BUDGET): string =>
  text.length <= budget
    ? text
    : `${text.slice(0, budget)}\n… (truncated: ${text.length} characters total)`
/**
 * A flat list, one issue per line, ordered by the vocabulary's status order then by key —
 * stable output is what makes a CLI usable in a pipeline and in a diff.
 *
 * Human-only (the CLI's `list` and `/jira list`), so decision 55 makes it Chinese; the text the
 * `jira_list` **tool** returns is built by `core/list.ts` and stays English.
 */
/** The fields a list line needs, so both an `Issue` and a `ListItem` can be printed. */
export type ListableIssue = Pick<Issue, 'key' | 'status' | 'priority' | 'summary'>

export const renderIssueList = (issues: readonly ListableIssue[], vocab?: Vocab): string => {
  if (issues.length === 0) return '暂无 issue（共 0 条）\n'
  const sorted = [...issues].sort((left, right) => {
    const status = vocab === undefined ? 0 : statusOrder(vocab, left.status) - statusOrder(vocab, right.status)
    return status !== 0 ? status : left.key.localeCompare(right.key)
  })
  const keyWidth = Math.max(...sorted.map(issue => issue.key.length))
  const statusWidth = Math.max(...sorted.map(issue => issue.status.length))
  return `${sorted.map(issue => [
    issue.key.padEnd(keyWidth),
    issue.status.padEnd(statusWidth),
    issue.priority.padEnd(2),
    issue.summary,
  ].join('  ')).join('\n')}\n`
}

/**
 * The board view: one block per status, in the vocabulary's declared order.
 *
 * Human-only as well (the CLI's `board` and `/jira board`), so the frame is Chinese; the status
 * names themselves are data and are printed exactly as the vocabulary declares them.
 */
export const renderBoard = (issues: readonly Issue[], vocab: Vocab): string => {
  const statuses = [...vocab.statuses].sort((left, right) => left.order - right.order)
  const lines: string[] = []
  for (const status of statuses) {
    const column = issues.filter(issue => issue.status === status.name)
    lines.push(`${status.name}（${String(column.length)}）`)
    for (const issue of column.sort((left, right) => left.key.localeCompare(right.key))) {
      lines.push(`  ${issue.key}  ${issue.priority}  ${issue.summary}`)
    }
  }
  const unknown = issues.filter(issue => !vocab.statuses.some(status => status.name === issue.status))
  if (unknown.length > 0) {
    lines.push(`未知状态（${String(unknown.length)}）`)
    for (const issue of unknown) lines.push(`  ${issue.key}  ${issue.status}`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * §4.8/decision 61: the lease, said out loud. The design is explicit that an expired claim must be
 * **told to the model** as "expired, reclaimable" — the holder stays visible, because the point of the
 * lease is knowing who to ask, and the point of the expiry is knowing you may take over.
 *
 * The locale only changes the words: the English default is the sentence the design requires at the
 * model surface, and the Chinese one is what the CLI prints.
 */
export const leaseNote = (issue: Issue, now?: Timestamp, locale: Locale = 'en'): string | undefined => {
  const words = ISSUE_WORDS[locale]
  if (issue.assignee === undefined || issue.leaseExpiresAt === undefined) return undefined
  const until = words.leaseUntil + issue.leaseExpiresAt
  if (now === undefined) return until
  return issue.leaseExpiresAt > now ? until : words.leaseExpired + issue.leaseExpiresAt + words.reclaimable
}

// The human command renders through this presentation module only. Its store-access ratchet forbids
// importing the modules that also hold the checks, so the two pure renderers are surfaced here.
export { renderDoctorReport } from './doctor.ts'
export { renderTagsLint } from './tagsLint.ts'
