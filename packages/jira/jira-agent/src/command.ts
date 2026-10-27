/**
 * plugin/command — the `/jira` slash command (decision 88's human surface).
 *
 * The command answers the questions the tool cannot: "what does the store look like", "what
 * is in flight", "is it healthy", "is anything unpushed". Every read goes through `ctx.jira`
 * (DH-205): this module parses arguments and renders core messages and presentation helpers, and
 * never opens, locks or commits the store itself.
 *
 * It writes nothing except `new`; a command that silently changed the ledger while a model
 * was mid-thought would be a bad trade for convenience.
 */

import { parseArgs, booleanFlag, splitTokens, stringFlag, type FlagSpec } from '@deepseek-ai/dsh-jira-core/args.ts'
import { type JiraError, formatError, invalidInput } from '@deepseek-ai/dsh-jira-core/errors.ts'
import { asIssueKey, isProjectKey } from '@deepseek-ai/dsh-jira-core/entity.ts'
import {
  BOARD_NEEDS_VOCAB,
  NEW_NEEDS_SUMMARY,
  createdMessage,
  hiddenIssuesNote,
  invalidProjectKey,
  syncPushLine,
  unknownTagsAction,
} from '@deepseek-ai/dsh-jira-core/messages.ts'
import { renderBoard, renderDoctorReport, renderIssueHuman, renderIssueList, renderTagsLint } from '@deepseek-ai/dsh-jira-core/render.ts'
import type { JiraServiceApi, ListQuery } from '@deepseek-ai/dsh-jira-service'

/** What the command surface prints back: one rendered message, marked success or error. */
export type CommandResult = Readonly<{ kind: 'success' | 'error'; text: string }>

/** One invocation as the host delivers it: the raw text after `/jira`, plus the calling agent. */
export type CommandInvocation = Readonly<{
  /** The exact text after the command name, including leading whitespace. */
  rawInput: string
  agent?: unknown
}>

/** The command as the host registers it: its name, description, input hint and handler. */
export type CommandDefinition = Readonly<{
  name: string
  description: string
  input?: Readonly<{ hint: string; attachments: boolean }>
  handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
}>

/** What the plugin supplies to one run: the ledger service and the facts only the host knows. */
export type CommandOptions = Readonly<{
  /** The ledger facade; every read and the one write go through it. */
  jira: JiraServiceApi
  /** The clock the command's audit timestamps are formatted from. */
  now: () => string
  /** The identity a `/jira new` write is recorded under. */
  identity: () => string
  /**
   * One line answering "may this session write?" (decision 177). The plugin knows (it has the caller);
   * the command surface does not, and a hardcoded "yes" misled every read-only session.
   */
  writable?: () => string
  /** One line about the last push attempt, when it failed (decision 191). */
  pushStatus?: () => Promise<string | undefined>
}>

const FLAGS: Readonly<Record<string, FlagSpec>> = Object.freeze({
  status: { type: 'string', description: 'only this status' },
  project: { type: 'string', description: 'only this project' },
  tag: { type: 'string', description: 'only issues carrying this tag' },
  all: { type: 'boolean', description: 'include closed issues' },
  summary: { type: 'string', description: 'new: the one-line summary' },
})

const USAGE = `jira —— 本地 issue 账本

  /jira                 账本现在有什么
  /jira list [--status S] [--project P] [--tag T] [--all]
  /jira board
  /jira show <KEY>      看一条 issue 的全部事实
  /jira tags lint       检查 tag 注册表（只用一次 / 缺描述 / 太像）
  /jira new --project P --summary TEXT
  /jira doctor          检查账本健康
  /jira sync            推送已提交内容并报告状态`

/** The `/jira` subcommands this command understands; the parity test pins this list against the CLI surface. */
export const JIRA_SUBCOMMANDS: readonly string[] = Object.freeze([
  'status', 'list', 'board', 'show', 'tags', 'new', 'doctor', 'sync',
])

const failure = (error: JiraError): CommandResult =>
  Object.freeze({ kind: 'error', text: formatError(error) })

const success = (text: string): CommandResult => Object.freeze({ kind: 'success', text })

/**
 * Parse and run one `/jira` invocation, returning the text the host shows the person.
 * @param rawInput - the exact text after the command name, split by the shared argument parser.
 * @param options - the ledger service, identity, clock and host facts this composition provides.
 * @returns the rendered result; a failure result whenever parsing or the service refuses.
 */
export const runJiraCommand = async (rawInput: string, options: CommandOptions): Promise<CommandResult> => {
  const tokens = splitTokens(rawInput)
  if (!tokens.ok) return failure(tokens.error)
  const subcommand = tokens.value[0] ?? 'status'
  if (subcommand === 'help' || subcommand === '-h' || subcommand === '--help') return success(USAGE)

  // `show <KEY>` and `tags lint` carry one word past the subcommand; everything else carries none,
  // so a stray word stays an error instead of being silently ignored.
  const parsed = parseArgs(tokens.value.slice(1), FLAGS, subcommand === 'show' || subcommand === 'tags' ? 1 : 0)
  if (!parsed.ok) return failure(parsed.error)
  const flags = parsed.value.flags

  switch (subcommand) {
    case 'status': {
      const snapshot = await options.jira.snapshot()
      if (!snapshot.ok) return failure(snapshot.error)
      const vocab = snapshot.value.vocab
      const report = snapshot.value.report
      const push = options.pushStatus === undefined ? undefined : await options.pushStatus()
      const lines = [
        `账本：${snapshot.value.root}`,
        vocab === undefined
          ? '词表：缺失或读不出来 —— 请运行 /jira doctor'
          : `词表：${String(vocab.statuses.length)} 个状态，${String(vocab.transitions.length)} 条迁移，closed=[${vocab.closed.join(', ')}]`,
        `issue：${String(snapshot.value.issues.length)} 条，分布在 ${String(report.summary.projects)} 个项目`
          + (report.summary.conflicted > 0 ? `，${String(report.summary.conflicted)} 条 conflicted` : ''),
        `健康：${report.ok ? '正常' : `${String(report.problems.filter(problem => problem.severity === 'error').length)} 个错误`}`
          + (report.problems.length > 0 ? ' —— 请运行 /jira doctor' : ''),
        // Decision 177: the command surface does not know the caller, so it asks — a read-only session
        // used to be told it could write. Unknown means the line is simply absent.
        ...(options.writable === undefined ? [] : [`可写：${options.writable()}`]),
        // Decision 191: if the last push failed, say so here — the alarm that was missing.
        ...(push === undefined ? [] : [push]),
      ]
      return success(lines.join('\n'))
    }

    case 'list':
    case 'board': {
      const query: ListQuery = {
        ...(stringFlag(flags, 'project') === undefined ? {} : { project: stringFlag(flags, 'project') as string }),
        ...(stringFlag(flags, 'status') === undefined ? {} : { status: stringFlag(flags, 'status') as string }),
        ...(stringFlag(flags, 'tag') === undefined ? {} : { tag: stringFlag(flags, 'tag') as string }),
        includeClosed: booleanFlag(flags, 'all'),
      }
      const matched = await options.jira.queryIssues(query)
      if (!matched.ok) return failure(matched.error)
      const vocab = matched.value.vocab
      if (subcommand === 'list') return success(renderIssueList(matched.value.issues, vocab))
      if (vocab === undefined) return failure(invalidInput(BOARD_NEEDS_VOCAB))
      const hidden = matched.value.total - matched.value.issues.length
      const board = renderBoard(matched.value.issues, vocab).replace(/\n$/u, '')
      return success(hidden > 0 ? board + hiddenIssuesNote(hidden) : board)
    }

    case 'show': {
      // Decision 83's read-only set: the human's "what is this one, really?" without leaving the
      // slash command. Reads only (decision 38) — no lock, no write, no state.
      const rawKey = parsed.value.positionals[0] ?? ''
      const key = asIssueKey(rawKey)
      if (key === undefined) return failure(invalidInput(`show 需要一个 issue key（形如 DH-12），收到 "${rawKey}"`))
      const read = await options.jira.readIssue(key)
      if (!read.ok) return failure(read.error)
      const text = renderIssueHuman(
        read.value.issue,
        read.value.comments ?? [],
        options.now() as never,
        'zh',
      )
      const warnings = read.value.warnings.length === 0
        ? ''
        : `\nwarning: ${read.value.warnings.join('; ')}`
      return success(`${text.replace(/\n$/u, '')}${warnings}`)
    }

    case 'tags': {
      if (parsed.value.positionals[0] !== 'lint') {
        return failure(invalidInput(unknownTagsAction(parsed.value.positionals[0]), { usage: 'jira tags lint' }))
      }
      const report = await options.jira.tagsLint()
      if (!report.ok) return failure(report.error)
      return success(renderTagsLint(report.value).replace(/\n$/u, ''))
    }

    case 'new': {
      const project = (stringFlag(flags, 'project') ?? '').toUpperCase()
      const summary = stringFlag(flags, 'summary')
      if (project === '') return failure(invalidInput('new 需要 --project', { usage: 'jira new --project DH --summary "…"' }))
      // Decision 162: the key becomes `projects/<key>/`, so `../../x` must not get past here. The core
      // validates again, but a clear message belongs at the surface the person typed at.
      if (!isProjectKey(project)) {
        return failure(invalidInput(invalidProjectKey(project), { project }))
      }
      if (summary === undefined || summary === '') return failure(invalidInput(NEW_NEEDS_SUMMARY))
      const created = await options.jira.createIssue(project, undefined, { issueType: 'task', summary }, {
        by: options.identity() as never,
        at: options.now() as never,
      })
      if (!created.ok) return failure(created.error)
      return success(createdMessage(created.value.created.key, created.value.created.committed))
    }

    case 'doctor': {
      const report = await options.jira.doctor()
      if (!report.ok) return failure(report.error)
      return success(renderDoctorReport(report.value).replace(/\n$/u, ''))
    }

    case 'sync': {
      // Decision 166: pull --rebase, refresh the derived files, then push — so a two-machine push
      // is not rejected as non-fast-forward and what leaves the machine agrees with its sources.
      // The service owns that one queue, so the command asks it instead of building a second one
      // that would race the debounce the last write armed.
      const outcome = await options.jira.sync()
      // A failed pull, settle or push is a **failed command**, not a successful one with a
      // discouraging line: the service reports it as an error result, and `PushOutcome` keeps its
      // own failed arm for callers that flush the queue directly.
      if (!outcome.ok) return failure(outcome.error)
      if (outcome.value.kind === 'failed') return failure(outcome.value.error)
      const state = await options.jira.syncState()
      const detail = outcome.value.kind === 'pushed' ? 'pushed' : outcome.value.reason
      return success([
        syncPushLine(detail),
        `remote：${state.ok && state.value.remote ? '有' : '无'}`,
        state.ok && state.value.dirty ? '工作区：有未提交的改动' : '工作区：干净',
      ].join('\n'))
    }

    default:
      return failure(invalidInput(`未知子命令 "${subcommand}"`, { usage: 'jira list | board | show <KEY> | tags lint | new | doctor | sync' }))
  }
}

/**
 * Build the `/jira` command definition the plugin registers.
 * @param options - the ledger service and the host facts every invocation uses.
 * @returns the frozen definition the host's command registry consumes.
 */
export const createJiraCommand = (options: CommandOptions): CommandDefinition =>
  Object.freeze({
    name: 'jira',
    description: '读写本地 issue 账本：status / list / board / new / doctor / sync',
    input: Object.freeze({ hint: '[status|list|board|new|doctor|sync]', attachments: false }),
    handler: (invocation: CommandInvocation) => runJiraCommand(invocation.rawInput, options),
  })
