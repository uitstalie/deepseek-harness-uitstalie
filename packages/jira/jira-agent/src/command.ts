/**
 * plugin/command — the `/jira` slash command (decision 88's human surface).
 *
 * The command answers the questions the tool cannot: "what does the store look like", "what
 * is in flight", "is it healthy", "is anything unpushed". It reuses the CLI's argument
 * parser and the same `core` functions the CLI uses, so the two surfaces cannot disagree
 * about what `--status closed` means.
 *
 * It writes nothing except `new`; a command that silently changed the ledger while a model
 * was mid-thought would be a bad trade for convenience.
 */

import { parseArgs, booleanFlag, splitTokens, stringFlag, type FlagSpec } from '@deepseek-ai/dsh-jira-core/args.ts'
import { type JiraError, formatError, invalidInput } from '@deepseek-ai/dsh-jira-core/errors.ts'
import { checkStore, renderDoctorReport } from '@deepseek-ai/dsh-jira-core/doctor.ts'
import { hasRemote, runGit } from '@deepseek-ai/dsh-jira-core/git.ts'
import {
  BOARD_NEEDS_VOCAB,
  NEW_NEEDS_SUMMARY,
  createdMessage,
  hiddenIssuesNote,
  invalidProjectKey,
  syncPushLine,
  unknownTagsAction,
} from '@deepseek-ai/dsh-jira-core/messages.ts'
import { listIssues, queryIssues, readSnapshot } from '@deepseek-ai/dsh-jira-core/inspect.ts'
import { readIssue } from '@deepseek-ai/dsh-jira-core/io.ts'
import { loadTags, readComments } from '@deepseek-ai/dsh-jira-core/store.ts'
import { lintTags, renderTagsLint } from '@deepseek-ai/dsh-jira-core/tagsLint.ts'
import { asIssueKey, isProjectKey } from '@deepseek-ai/dsh-jira-core/entity.ts'
import { type PushOutcome } from '@deepseek-ai/dsh-jira-core/push.ts'
import { renderBoard, renderIssueHuman, renderIssueList } from '@deepseek-ai/dsh-jira-core/render.ts'
import { type Result } from '@deepseek-ai/dsh-jira-core/result.ts'
import { createInStore, createStore } from '@deepseek-ai/dsh-jira-core/store.ts'
import { parseVocab } from '@deepseek-ai/dsh-jira-core/vocab.ts'
import { type Actor } from '@deepseek-ai/dsh-jira-core/store.ts'

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

/** What the plugin supplies to one run: where the store is, who writes, and the service hooks. */
export type CommandOptions = Readonly<{
  /** Resolve the store root lazily, so a misconfigured plugin answers instead of throwing. */
  root: () => Result<string, JiraError>
  /** The **resolved** machine identity, read at call time: the service resolves it when it opens. */
  machineId: () => string
  /** The lock owner's `host` — the same value the plugin's own store uses (decision 181). */
  host: string
  /** The identity a `/jira new` write is recorded under; resolved at call time like `machineId`. */
  identity: () => string
  now: () => string
  /**
   * Flush the ledger's push queue now (decision 166). The service owns the one queue
   * (contract §2), so `/jira sync` asks it to rebase, settle and push instead of building a
   * second queue that would race the debounce the last write armed.
   */
  sync?: () => Promise<Result<PushOutcome, JiraError>>
  /**
   * One line answering "may this session write?" (decision 177). The plugin knows (it has the caller);
   * the command surface does not, and a hardcoded "yes" misled every read-only session.
   */
  writable?: () => string
  /** One line about the last push, when the last attempt failed (decision 191). */
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

const failure = (error: JiraError): CommandResult =>
  Object.freeze({ kind: 'error', text: formatError(error) })

const success = (text: string): CommandResult => Object.freeze({ kind: 'success', text })

const vocabularyOf = (configText: string | undefined) => {
  if (configText === undefined) return undefined
  const parsed = parseVocab(configText)
  return parsed.ok ? parsed.value : undefined
}

/**
 * Parse and run one `/jira` invocation, returning the text the host shows the person.
 * @param rawInput - the exact text after the command name, split by the shared argument parser.
 * @param options - the store root, identity, clock and service hooks this composition provides.
 * @returns the rendered result; a failure result whenever parsing or the store refuses.
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

  const root = options.root()
  if (!root.ok) return failure(root.error)
  const store = createStore({ root: root.value, machineId: options.machineId(), host: options.host })

  switch (subcommand) {
    case 'status': {
      const snapshot = await readSnapshot(root.value)
      const vocab = vocabularyOf(snapshot.configText)
      const report = checkStore(snapshot)
      const push = options.pushStatus === undefined ? undefined : await options.pushStatus()
      const lines = [
        `账本：${root.value}`,
        vocab === undefined
          ? '词表：缺失或读不出来 —— 请运行 /jira doctor'
          : `词表：${String(vocab.statuses.length)} 个状态，${String(vocab.transitions.length)} 条迁移，closed=[${vocab.closed.join(', ')}]`,
        `issue：${String(snapshot.issues.length)} 条，分布在 ${String(report.summary.projects)} 个项目`
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
      const listed = await listIssues(root.value)
      const snapshot = await readSnapshot(root.value)
      const vocab = vocabularyOf(snapshot.configText)
      const issues = queryIssues(listed.issues, {
        ...(stringFlag(flags, 'project') === undefined ? {} : { project: stringFlag(flags, 'project') as string }),
        ...(stringFlag(flags, 'status') === undefined ? {} : { status: stringFlag(flags, 'status') as string }),
        ...(stringFlag(flags, 'tag') === undefined ? {} : { tag: stringFlag(flags, 'tag') as string }),
        includeClosed: booleanFlag(flags, 'all'),
      }, vocab)
      if (subcommand === 'list') return success(renderIssueList(issues, vocab))
      if (vocab === undefined) return failure(invalidInput(BOARD_NEEDS_VOCAB))
      const hidden = listed.issues.length - issues.length
      const board = renderBoard(issues, vocab).replace(/\n$/u, '')
      return success(hidden > 0 ? board + hiddenIssuesNote(hidden) : board)
    }

    case 'show': {
      // Decision 83's read-only set: the human's "what is this one, really?" without leaving the
      // slash command. Reads only (decision 38) — no lock, no write, no state.
      const rawKey = parsed.value.positionals[0] ?? ''
      const key = asIssueKey(rawKey)
      if (key === undefined) return failure(invalidInput(`show 需要一个 issue key（形如 DH-12），收到 "${rawKey}"`))
      const read = await readIssue(store.files, key)
      if (!read.ok) return failure(read.error)
      const comments = await readComments(store, key)
      const text = renderIssueHuman(read.value.issue, comments.ok ? comments.value : [], options.now() as never, 'zh')
      const warnings = read.value.warnings.length === 0
        ? ''
        : `\nwarning: ${read.value.warnings.join('; ')}`
      return success(`${text.replace(/\n$/u, '')}${warnings}`)
    }

    case 'tags': {
      if (parsed.value.positionals[0] !== 'lint') {
        return failure(invalidInput(unknownTagsAction(parsed.value.positionals[0]), { usage: 'jira tags lint' }))
      }
      const tags = await loadTags(store)
      if (!tags.ok) return failure(tags.error)
      const listed = await listIssues(root.value)
      return success(renderTagsLint(lintTags(tags.value, listed.issues)).replace(/\n$/u, ''))
    }

    case 'new': {
      const project = (stringFlag(flags, 'project') ?? '').toUpperCase()
      const summary = stringFlag(flags, 'summary')
      if (project === '') return failure(invalidInput('new 需要 --project', { usage: 'jira new --project DH --summary "…"' }))
      // Decision 162: the key becomes `projects/<key>/`, so `../../x` must not get past here. The core
      // validates again (`createInStore`), but a clear message belongs at the surface the person typed at.
      if (!isProjectKey(project)) {
        return failure(invalidInput(invalidProjectKey(project), { project }))
      }
      if (summary === undefined || summary === '') return failure(invalidInput(NEW_NEEDS_SUMMARY))
      const actor: Actor = Object.freeze({ by: options.identity() as never, at: options.now() as never })
      const created = await createInStore(store, project, actor, { issueType: 'task', summary })
      if (!created.ok) return failure(created.error)
      return success(createdMessage(created.value.key, created.value.committed))
    }

    case 'doctor': {
      const report = checkStore(await readSnapshot(root.value))
      return success(renderDoctorReport(report).replace(/\n$/u, ''))
    }

    case 'sync': {
      // Decision 166: pull --rebase, refresh the derived files, then push — so a two-machine push
      // is not rejected as non-fast-forward and what leaves the machine agrees with its sources.
      // The service owns that one queue, so the command asks it instead of building a second one
      // that would race the debounce the last write armed.
      const outcome = options.sync === undefined
        ? undefined
        : await options.sync()
      const remote = await hasRemote(root.value)
      const status = await runGit(root.value, ['status', '--porcelain'])
      const detail = outcome === undefined
        ? 'this composition has no ledger service to sync through'
        : outcome.ok
          ? outcome.value.kind === 'pushed'
            ? 'pushed'
            : outcome.value.kind === 'failed'
              ? formatError(outcome.value.error)
              : outcome.value.reason
          : formatError(outcome.error)
      return success([
        syncPushLine(detail),
        `remote：${remote ? '有' : '无'}`,
        status.code === 0 && status.stdout !== '' ? '工作区：有未提交的改动' : '工作区：干净',
      ].join('\n'))
    }

    default:
      return failure(invalidInput(`未知子命令 "${subcommand}"`, { usage: 'jira list | board | show <KEY> | tags lint | new | doctor | sync' }))
  }
}

/**
 * Build the `/jira` command definition the plugin registers.
 * @param options - the store root, identity, clock and service hooks every invocation uses.
 * @returns the frozen definition the host's command registry consumes.
 */
export const createJiraCommand = (options: CommandOptions): CommandDefinition =>
  Object.freeze({
    name: 'jira',
    description: '读写本地 issue 账本：status / list / board / new / doctor / sync',
    input: Object.freeze({ hint: '[status|list|board|new|doctor|sync]', attachments: false }),
    handler: (invocation: CommandInvocation) => runJiraCommand(invocation.rawInput, options),
  })
