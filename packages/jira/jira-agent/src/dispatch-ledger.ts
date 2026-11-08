/**
 * The super workspace's dispatch ledger: one human-readable Markdown file per registered
 * workspace, under `<super>/.superagent/ledger/`.
 *
 * Entries are appended, never rewritten. A later `## <task> · <status>` section for the same task
 * id is the correction/outcome, and readers keep the latest one; that keeps the file safe for a
 * person to read and edit without the tool destroying earlier text.
 *
 * This module deliberately imports no host package (decision 108): the tool layer passes a root
 * directory and plain values, and the only dependency is Node's filesystem.
 *
 * @module @deepseek-ai/dsh-jira-agent/dispatch-ledger
 */

import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

/** Directory, relative to the super workspace, that owns the dispatch ledger. */
export const DISPATCH_LEDGER_DIR = '.superagent/ledger'

/** The state of one dispatched task. */
export type DispatchLedgerStatus = 'pending' | 'returned' | 'failed'

/** One dispatched task, as read from or written to the ledger. */
export interface DispatchLedgerTask {
  readonly id: string
  readonly workspaceId: string
  readonly workspaceTitle: string
  readonly workspacePath: string
  readonly task: string
  readonly dispatchedAt: string
  readonly status: DispatchLedgerStatus
  readonly updatedAt: string
  readonly sessionId?: string
  /**
   * The prompt request identity of the message that carried this task.
   *
   * `user/message.source.rpcId` preserves it, so a turn end can match the turn it actually
   * belongs to instead of guessing from the Session. Records written before this field existed
   * leave it undefined and use the FIFO fallback.
   */
  readonly requestId?: string
  readonly issue?: string
  readonly artifacts: readonly string[]
  readonly outcome?: string
  readonly decisions: readonly string[]
}

/** What a new task needs; the id and status defaults are supplied by the writer. */
export interface NewDispatchTask {
  readonly id?: string
  readonly workspaceId: string
  readonly workspaceTitle: string
  readonly workspacePath: string
  readonly task: string
  readonly dispatchedAt: string
  readonly sessionId?: string
  /** The prompt request identity bound to this task; see {@link DispatchLedgerTask.requestId}. */
  readonly requestId?: string
  readonly issue?: string
  readonly status?: DispatchLedgerStatus
}

/** A correction/outcome for an existing task. */
export interface DispatchTaskPatch {
  readonly status: DispatchLedgerStatus
  readonly outcome?: string
  readonly artifacts?: readonly string[]
  readonly decisions?: readonly string[]
  readonly sessionId?: string
  readonly issue?: string
  readonly updatedAt: string
}

/** One row returned by the ledger listing. */
export interface DispatchLedgerRow extends DispatchLedgerTask {
  /** Path of the Markdown file this row came from, for a reader who wants the full history. */
  readonly file: string
}

/** List filters. */
export interface DispatchLedgerQuery {
  readonly workspace?: string
  readonly status?: DispatchLedgerStatus
  readonly query?: string
  readonly limit?: number
}

/** The workspace identity a ledger writer needs. */
export interface DispatchLedgerWorkspace {
  readonly id: string
  readonly title: string
  readonly path: string
}

const STATUSES: readonly DispatchLedgerStatus[] = Object.freeze(['pending', 'returned', 'failed'])
const FIELD = /^- (workspace|path|task|dispatched|updated|session|request|issue|artifacts|outcome|decisions): (.*)$/u
const HEADING = /^## (\S+) · (pending|returned|failed)$/u

/** Whether a string is one of the three ledger statuses. */
export const isDispatchLedgerStatus = (value: unknown): value is DispatchLedgerStatus =>
  typeof value === 'string' && (STATUSES as readonly string[]).includes(value)

/** Mint a task id that is stable in a filename and readable in a report. */
export const newDispatchTaskId = (): string => `task-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`

/**
 * Where one workspace's ledger lives. The id becomes a filename, so anything outside the safe set
 * is replaced; real workspace ids are UUIDs, and a replacement only affects a hostile hand-written
 * id rather than creating a path outside the ledger directory.
 * @param root - the super workspace root.
 * @param workspaceId - the registered workspace id.
 * @returns the absolute Markdown path.
 */
export const ledgerFileOf = (root: string, workspaceId: string): string => {
  const safe = workspaceId.replace(/[^A-Za-z0-9._-]/gu, '_') || 'unknown'
  return resolve(root, DISPATCH_LEDGER_DIR, `${safe}.md`)
}

/** Split a `; `-separated field, dropping empty values. */
const listOf = (value: string | undefined): readonly string[] =>
  value === undefined ? [] : value.split(';').map(item => item.trim()).filter(item => item !== '')

/** Render a possibly multi-line field, indenting continuation lines so a section never ends early. */
const fieldLines = (name: string, value: string): string[] => {
  const [first = '', ...rest] = value.split(/\r?\n/u)
  return [`- ${name}: ${first}`, ...rest.map(line => `  ${line}`)]
}

/** Render one task section; every present field is one line, lists are `; `-joined. */
export const renderTaskSection = (task: DispatchLedgerTask): string => {
  const lines = [
    `## ${task.id} · ${task.status}`,
    `- workspace: ${task.workspaceTitle}`,
    `- path: \`${task.workspacePath}\``,
    // A task or outcome is free text and routinely spans lines; continuation lines are indented so
    // an embedded `##` heading cannot make the reader treat the rest of the section as a new task.
    ...fieldLines('task', task.task),
    `- dispatched: ${task.dispatchedAt}`,
    `- updated: ${task.updatedAt}`,
    ...(task.sessionId === undefined ? [] : [`- session: ${task.sessionId}`]),
    ...(task.requestId === undefined ? [] : [`- request: ${task.requestId}`]),
    ...(task.issue === undefined ? [] : [`- issue: ${task.issue}`]),
    ...(task.artifacts.length === 0 ? [] : [`- artifacts: ${task.artifacts.join('; ')}`]),
    ...(task.outcome === undefined ? [] : fieldLines('outcome', task.outcome)),
    ...(task.decisions.length === 0 ? [] : [`- decisions: ${task.decisions.join('; ')}`]),
  ]
  return `${lines.join('\n')}\n\n`
}

/**
 * Parse one ledger file. Later sections for the same id supersede earlier ones; unknown prose is
 * ignored by the parser but left untouched by the append-only writer.
 * @param text - the Markdown file.
 * @param fallback - workspace facts for files written before a header existed.
 * @returns the latest section per task, in first-seen order.
 */
export const parseLedger = (
  text: string,
  fallback: Pick<DispatchLedgerTask, 'workspaceId' | 'workspaceTitle' | 'workspacePath'>,
): readonly DispatchLedgerTask[] => {
  interface Draft {
    id: string
    status: DispatchLedgerStatus
    fields: Map<string, string>
    workspaceTitle?: string
    workspacePath?: string
  }
  const latest = new Map<string, Draft>()
  const order: string[] = []
  let current: Draft | undefined
  let lastKey: string | undefined
  const finish = (): void => {
    if (current === undefined) return
    latest.set(current.id, current)
    if (!order.includes(current.id)) order.push(current.id)
    current = undefined
    lastKey = undefined
  }
  for (const line of text.split(/\r?\n/u)) {
    const heading = HEADING.exec(line)
    if (heading !== null) {
      finish()
      current = {
        id: heading[1] ?? '',
        status: (heading[2] ?? 'pending') as DispatchLedgerStatus,
        fields: new Map(),
      }
      continue
    }
    if (current === undefined) continue
    // Only a real task heading ends a section. Free text may contain its own `##` headings; older
    // records wrote them unindented, so treating them as prose is what lets those records keep the
    // structured fields that follow the task text.
    if (line.startsWith('## ')) continue
    const continuation = /^ {2,}(.*)$/u.exec(line)
    if (continuation !== null && lastKey !== undefined) {
      const previous = current.fields.get(lastKey) ?? ''
      current.fields.set(lastKey, previous === '' ? continuation[1] ?? '' : `${previous}\n${continuation[1] ?? ''}`)
      continue
    }
    const field = FIELD.exec(line)
    if (field === null) continue
    const key = field[1] ?? ''
    const value = field[2] ?? ''
    if (key === 'workspace') { current.workspaceTitle = value; lastKey = undefined }
    else if (key === 'path') { current.workspacePath = value.replace(/^`(.*)`$/u, '$1'); lastKey = undefined }
    else { current.fields.set(key, value); lastKey = key }
  }
  finish()
  return order.flatMap((id): readonly DispatchLedgerTask[] => {
    const draft = latest.get(id)
    if (draft === undefined) return []
    const dispatchedAt = draft.fields.get('dispatched') ?? ''
    const sessionId = draft.fields.get('session')
    const requestId = draft.fields.get('request')
    const issue = draft.fields.get('issue')
    const outcome = draft.fields.get('outcome')
    return [Object.freeze({
      id: draft.id,
      workspaceId: fallback.workspaceId,
      workspaceTitle: draft.workspaceTitle ?? fallback.workspaceTitle,
      workspacePath: draft.workspacePath ?? fallback.workspacePath,
      task: draft.fields.get('task') ?? '',
      dispatchedAt,
      status: draft.status,
      updatedAt: draft.fields.get('updated') ?? dispatchedAt,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(requestId === undefined ? {} : { requestId }),
      ...(issue === undefined ? {} : { issue }),
      artifacts: Object.freeze(listOf(draft.fields.get('artifacts'))),
      ...(outcome === undefined ? {} : { outcome }),
      decisions: Object.freeze(listOf(draft.fields.get('decisions'))),
    })]
  })
}

/** Read one ledger file; a missing file is an empty ledger. */
export const readLedgerFile = async (
  root: string,
  workspace: DispatchLedgerWorkspace,
): Promise<readonly DispatchLedgerTask[]> => {
  try {
    const text = await readFile(ledgerFileOf(root, workspace.id), 'utf8')
    return parseLedger(text, {
      workspaceId: workspace.id,
      workspaceTitle: workspace.title,
      workspacePath: workspace.path,
    })
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** Create the ledger directory and the human-readable header when the file is new. */
const ensureLedgerFile = async (root: string, workspace: DispatchLedgerWorkspace): Promise<string> => {
  const file = ledgerFileOf(root, workspace.id)
  const dir = resolve(root, DISPATCH_LEDGER_DIR)
  await mkdir(dir, { recursive: true })
  try {
    await stat(file)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await appendFile(file, [
      `# Dispatch ledger — ${workspace.title}`,
      '',
      `- workspace: ${workspace.title}`,
      `- path: \`${workspace.path}\``,
      '',
    ].join('\n'), 'utf8')
  }
  return file
}

/** Append one task section, creating the file header on first use. */
export const appendDispatchTask = async (
  root: string,
  workspace: DispatchLedgerWorkspace,
  task: DispatchLedgerTask,
): Promise<string> => {
  const file = await ensureLedgerFile(root, workspace)
  await appendFile(file, renderTaskSection(task), 'utf8')
  return file
}

/** Turn a new task into its pending section. */
export const pendingTask = (input: NewDispatchTask): DispatchLedgerTask => Object.freeze({
  id: input.id ?? newDispatchTaskId(),
  workspaceId: input.workspaceId,
  workspaceTitle: input.workspaceTitle,
  workspacePath: input.workspacePath,
  task: input.task,
  dispatchedAt: input.dispatchedAt,
  status: input.status ?? 'pending',
  updatedAt: input.dispatchedAt,
  ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
  ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
  ...(input.issue === undefined ? {} : { issue: input.issue }),
  artifacts: Object.freeze([]),
  decisions: Object.freeze([]),
})

/** Apply a patch to one task, appending the new section rather than rewriting history. */
export const patchTask = (task: DispatchLedgerTask, patch: DispatchTaskPatch): DispatchLedgerTask => Object.freeze({
  ...task,
  status: patch.status,
  updatedAt: patch.updatedAt,
  ...(patch.outcome === undefined ? {} : { outcome: patch.outcome }),
  ...(patch.artifacts === undefined ? {} : { artifacts: Object.freeze([...patch.artifacts]) }),
  ...(patch.decisions === undefined ? {} : { decisions: Object.freeze([...patch.decisions]) }),
  ...(patch.sessionId === undefined ? {} : { sessionId: patch.sessionId }),
  ...(patch.issue === undefined ? {} : { issue: patch.issue }),
})

/** Read every workspace file in the ledger directory. */
export const listLedgerFiles = async (root: string): Promise<readonly string[]> => {
  try {
    const names = await readdir(resolve(root, DISPATCH_LEDGER_DIR))
    return names.filter(name => name.endsWith('.md')).map(name => resolve(root, DISPATCH_LEDGER_DIR, name)).sort()
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** Read the latest section per task id across every workspace file, without filtering. */
const latestTasks = async (root: string): Promise<DispatchLedgerRow[]> => {
  const files = await listLedgerFiles(root)
  const latest = new Map<string, DispatchLedgerRow>()
  for (const file of files) {
    const text = await readFile(file, 'utf8')
    const name = basename(file)
    const fallback = {
      workspaceId: name.replace(/\.md$/u, ''),
      workspaceTitle: name.replace(/\.md$/u, ''),
      workspacePath: '',
    }
    for (const task of parseLedger(text, fallback)) {
      // A cross-file duplicate cannot be resolved by file order; the later file is the last write.
      latest.set(task.id, Object.freeze({ ...task, file }))
    }
  }
  return [...latest.values()]
}

/** Every latest task, unfiltered and unsliced; used by the one-time storage migration. */
export const listAllDispatchTasks = async (root: string): Promise<DispatchLedgerRow[]> => {
  const tasks = await latestTasks(root)
  return tasks.sort((left, right) => left.dispatchedAt < right.dispatchedAt ? 1 : left.dispatchedAt > right.dispatchedAt ? -1 : 0)
}

/** Pick the latest task per id across every workspace file. */
export const listDispatchTasks = async (
  root: string,
  query: DispatchLedgerQuery = {},
): Promise<DispatchLedgerRow[]> => {
  const needle = query.query?.trim().toLowerCase() ?? ''
  const workspace = query.workspace?.trim().toLowerCase()
  const limit = Math.max(1, Math.min(100, Math.floor(query.limit ?? 20)))
  return (await latestTasks(root))
    .filter(task => task.status === (query.status ?? task.status))
    .filter(task => workspace === undefined || task.workspaceTitle.toLowerCase() === workspace
      || task.workspacePath.toLowerCase() === workspace || task.workspaceId === query.workspace)
    .filter(task => needle === '' || [task.id, task.task, task.workspaceTitle, task.workspacePath, task.outcome ?? '', ...task.artifacts, ...task.decisions]
      .some(value => value.toLowerCase().includes(needle)))
    .sort((left, right) => left.dispatchedAt < right.dispatchedAt ? 1 : left.dispatchedAt > right.dispatchedAt ? -1 : 0)
    .slice(0, limit)
}

/**
 * Append a corrected section for one task. The caller finds the task first so the workspace file
 * (and its title/path header) is known.
 * @param root - super workspace root.
 * @param task - the latest known task.
 * @param patch - the outcome/correction.
 * @returns the patched task and the file it was written to.
 */
export const resolveDispatchTask = async (
  root: string,
  task: DispatchLedgerTask,
  patch: DispatchTaskPatch,
): Promise<Readonly<{ task: DispatchLedgerTask; file: string }>> => {
  const next = patchTask(task, patch)
  const workspace = {
    id: task.workspaceId,
    title: task.workspaceTitle,
    path: task.workspacePath,
  }
  const file = await appendDispatchTask(root, workspace, next)
  return Object.freeze({ task: next, file })
}

/** Record a new pending dispatch; convenience wrapper for the tool and the report hook. */
export const recordDispatch = async (
  root: string,
  workspace: DispatchLedgerWorkspace,
  input: Omit<NewDispatchTask, 'workspaceId' | 'workspaceTitle' | 'workspacePath'>,
): Promise<Readonly<{ task: DispatchLedgerTask; file: string }>> => {
  const task = pendingTask({
    ...input,
    workspaceId: workspace.id,
    workspaceTitle: workspace.title,
    workspacePath: workspace.path,
  })
  const file = await appendDispatchTask(root, workspace, task)
  return Object.freeze({ task, file })
}
