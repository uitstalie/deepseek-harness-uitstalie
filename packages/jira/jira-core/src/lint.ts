/**
 * core/lint — structural legality, and nothing else (decision 94, §11.6's boundary).
 *
 * The design draws this line explicitly: **CI is responsible for structure, not policy.**
 * `status` not in `statuses[]` is red; "blocked but already claimed" is **not** a finding, because
 * a CI that reports things nobody agrees are wrong stops being believed. So this module checks that
 * every reference points at something that exists and every value belongs to a declared set — and
 * deliberately says nothing about whether the *state* is sensible.
 *
 * It is also where **dangling references** surface (decision 94): after renumbering a merged
 * instance, the old keys survive in commit messages and in other files, so the only honest way to
 * find what still points at a key that no longer exists is to look.
 */

import { type KnowledgeEntry, knowledgePath } from './kb.ts'
import { type Issue, issueRelPath } from './entity.ts'
import { type TagDef } from './tags.ts'
import { type Vocab } from './vocab.ts'

export type LintSeverity = 'error' | 'warning'

export type LintFinding = Readonly<{
  severity: LintSeverity
  code: string
  message: string
  path?: string
}>

export type LintInput = Readonly<{
  issues: readonly Issue[]
  knowledge: readonly KnowledgeEntry[]
  /** Files that could not be read at all, straight from the listing. */
  broken: readonly Readonly<{ path: string; reason: string }>[]
  vocab: Vocab
  knownTags: readonly TagDef[]
}>

export type LintCounts = Readonly<{
  issues: number
  knowledge: number
  /** References examined: issue→issue links, issue→kb refs, kb→issue refs. */
  references: number
}>

export type LintReport = Readonly<{
  ok: boolean
  findings: readonly LintFinding[]
  counts: LintCounts
}>

export const lintStore = (input: LintInput): LintReport => {
  const findings: LintFinding[] = []
  const add = (severity: LintSeverity, code: string, message: string, path?: string): void => {
    findings.push(Object.freeze({ severity, code, message, ...(path === undefined ? {} : { path }) }))
  }

  const statuses = new Set(input.vocab.statuses.map(status => status.name))
  const priorities = new Set(input.vocab.priorities)
  const issueTypes = new Set(input.vocab.issueTypes)
  const kbTypes = new Set(input.vocab.kbTypes)
  const tags = new Set(input.knownTags.map(tag => tag.name))
  const issueKeys = new Set(input.issues.map(issue => String(issue.key)))
  const knowledgeKeys = new Set(input.knowledge.map(entry => String(entry.key)))

  let references = 0

  for (const file of input.broken) {
    add('error', 'file-unreadable', file.reason, file.path)
  }

  for (const issue of input.issues) {
    const path = issueRelPath(issue.project, issue.key)
    if (!statuses.has(issue.status)) {
      add('error', 'status-unknown', `${String(issue.key)} has status "${issue.status}", which config.md does not declare`, path)
    }
    if (!issueTypes.has(issue.issueType)) {
      add('error', 'issue-type-unknown', `${String(issue.key)} has issue_type "${issue.issueType}"`, path)
    }
    if (!priorities.has(issue.priority)) {
      add('error', 'priority-unknown', `${String(issue.key)} has priority "${issue.priority}"`, path)
    }
    for (const tag of issue.tags) {
      if (!tags.has(tag)) {
        add('error', 'tag-unregistered', `${String(issue.key)} carries tag "${tag}", which has no tags/${tag}.md`, path)
      }
    }
    for (const link of issue.links) {
      references += 1
      if (!issueKeys.has(String(link.target))) {
        add('error', 'link-dangling', `${String(issue.key)} ${link.type} → ${String(link.target)}, which does not exist`, path)
      }
    }
    for (const reference of issue.kbRefs) {
      references += 1
      if (!knowledgeKeys.has(String(reference))) {
        add('error', 'kb-ref-dangling', `${String(issue.key)} references ${String(reference)}, which does not exist`, path)
      }
    }
  }

  for (const entry of input.knowledge) {
    const path = knowledgePath(entry.domain, entry.key)
    if (!kbTypes.has(entry.kbType)) {
      add('error', 'kb-type-unknown', `${String(entry.key)} has type "${entry.kbType}", which config.md's kb_types does not declare`, path)
    }
    for (const reference of entry.issues) {
      references += 1
      if (!issueKeys.has(String(reference))) {
        add('error', 'kb-issue-dangling', `${String(entry.key)} came from ${String(reference)}, which does not exist`, path)
      }
    }
  }

  return Object.freeze({
    ok: findings.every(finding => finding.severity !== 'error'),
    findings: Object.freeze(findings),
    counts: Object.freeze({
      issues: input.issues.length,
      knowledge: input.knowledge.length,
      references,
    }),
  })
}

/** The human-facing report: findings first, then what was examined. */
export const renderLintReport = (report: LintReport): string => {
  const lines = report.findings.map(finding =>
    `${finding.severity === 'error' ? '✗' : '!'} ${finding.code}: ${finding.message}`)
  if (lines.length === 0) lines.push('没有结构问题')
  lines.push(`已检查：${String(report.counts.issues)} 条 issue，${String(report.counts.knowledge)} 条知识条目，${String(report.counts.references)} 处引用`)
  lines.push(`结果：${report.ok ? '正常' : '有错误'}`)
  return `${lines.join('\n')}\n`
}
