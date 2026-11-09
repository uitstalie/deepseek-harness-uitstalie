import { appendFile, mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import type { DispatchLedgerQuery, DispatchLedgerRow, DispatchLedgerTask, DispatchProjection } from './dispatch-types.ts'

type Current = { id: string; status: DispatchLedgerTask['status']; fields: Map<string, string>; title?: string | undefined; path?: string | undefined }

const DIRECTORY = '.superagent/ledger'
const FIELD = /^- (workspace|path|task|dispatched|updated|session|request|issue|artifacts|outcome|decisions): (.*)$/u
const HEADING = /^## (\S+) · (pending|returned|failed)$/u

/** Test projection with the existing Jira Markdown representation. */
export const testMarkdownProjection = (root: string): DispatchProjection => Object.freeze({
  fileFor: (workspaceId: string) => resolve(root, DIRECTORY, `${workspaceId.replace(/[^A-Za-z0-9._-]/gu, '_') || 'unknown'}.md`),
  append: async (workspace: import('./dispatch-types.ts').DispatchLedgerWorkspace, task: DispatchLedgerTask) => {
    const file = testMarkdownProjection(root).fileFor(workspace.id)
    await mkdir(resolve(root, DIRECTORY), { recursive: true })
    try { await stat(file) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await appendFile(file, `# Dispatch ledger — ${workspace.title}\n\n- workspace: ${workspace.title}\n- path: \`${workspace.path}\`\n\n`, 'utf8')
    }
    const fieldLines = (name: string, value: string): string[] => {
      const [first = '', ...rest] = value.split(/\r?\n/u)
      return [`- ${name}: ${first}`, ...rest.map(line => `  ${line}`)]
    }
    const lines = [
      `## ${task.id} · ${task.status}`,
      `- workspace: ${task.workspaceTitle}`,
      `- path: \`${task.workspacePath}\``,
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
    await appendFile(file, `${lines.join('\n')}\n\n`, 'utf8')
  },
  readAll: async () => {
    let names: string[]
    try { names = await readdir(resolve(root, DIRECTORY)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const latest = new Map<string, DispatchLedgerRow>()
    for (const name of names.filter(name => name.endsWith('.md')).sort()) {
      const file = resolve(root, DIRECTORY, name)
      const text = await readFile(file, 'utf8')
      let current: Current | undefined
      let lastKey: string | undefined
      const finish = (): void => {
        if (current === undefined) return
        const at = current.fields.get('dispatched') ?? ''
        const sessionId = current.fields.get('session')
        const requestId = current.fields.get('request')
        const issue = current.fields.get('issue')
        const outcome = current.fields.get('outcome')
        latest.set(current.id, Object.freeze({
          id: current.id,
          workspaceId: basename(file, '.md'),
          workspaceTitle: current.title ?? basename(file, '.md'),
          workspacePath: current.path ?? '',
          task: current.fields.get('task') ?? '',
          dispatchedAt: at,
          status: current.status,
          updatedAt: current.fields.get('updated') ?? at,
          ...sessionId === undefined ? {} : { sessionId },
          ...requestId === undefined ? {} : { requestId },
          ...issue === undefined ? {} : { issue },
          artifacts: Object.freeze((current.fields.get('artifacts') ?? '').split(';').map(item => item.trim()).filter(Boolean)),
          ...outcome === undefined ? {} : { outcome },
          decisions: Object.freeze((current.fields.get('decisions') ?? '').split(';').map(item => item.trim()).filter(Boolean)),
          file,
        }))
        current = undefined
        lastKey = undefined
      }
      for (const line of text.split(/\r?\n/u)) {
        const heading = HEADING.exec(line)
        if (heading !== null) { finish(); current = { id: heading[1] ?? '', status: heading[2] as DispatchLedgerTask['status'], fields: new Map() }; continue }
        if (current === undefined) continue
        if (line.startsWith('## ')) continue
        const continuation = /^ {2,}(.*)$/u.exec(line)
        if (continuation !== null && lastKey !== undefined) {
          current.fields.set(lastKey, `${current.fields.get(lastKey) ?? ''}\n${continuation[1] ?? ''}`)
          continue
        }
        const field = FIELD.exec(line)
        if (field === null) continue
        if (field[1] === 'workspace') { current.title = field[2]; lastKey = undefined }
        else if (field[1] === 'path') { current.path = field[2]?.replace(/^`(.*)`$/u, '$1'); lastKey = undefined }
        else { current.fields.set(field[1] ?? '', field[2] ?? ''); lastKey = field[1] }
      }
      finish()
    }
    return [...latest.values()].sort((a, b) => a.dispatchedAt < b.dispatchedAt ? 1 : a.dispatchedAt > b.dispatchedAt ? -1 : 0)
  },
  query: (rows: readonly DispatchLedgerRow[], query: DispatchLedgerQuery) => {
    const needle = query.query?.trim().toLowerCase() ?? ''
    const workspace = query.workspace?.trim().toLowerCase()
    const limit = Math.max(1, Math.min(100, Math.floor(query.limit ?? 20)))
    const matched = rows
      .filter(row => query.status === undefined || row.status === query.status)
      .filter(row => workspace === undefined
        || row.workspaceTitle.toLowerCase() === workspace
        || row.workspacePath.toLowerCase() === workspace
        || row.workspaceId === query.workspace)
      .filter(row => needle === '' || [row.id, row.task, row.workspaceTitle, row.workspacePath, row.outcome ?? '', ...row.artifacts, ...row.decisions].some(value => value.toLowerCase().includes(needle)))
      .sort((a, b) => a.dispatchedAt < b.dispatchedAt ? 1 : a.dispatchedAt > b.dispatchedAt ? -1 : 0)
    const entries = matched.slice(0, limit)
    return Object.freeze({
      entries: Object.freeze(entries),
      counts: Object.freeze({ matched: matched.length, returned: entries.length, remaining: matched.length - entries.length }),
      truncated: matched.length > entries.length,
      limit,
    })
  },
})

/** Write an old-format pending task for migration tests. */
export const recordTestDispatch = async (root: string, id: string, at: string, sessionId: string): Promise<void> => {
  await testMarkdownProjection(root).append({ id: 'w1', title: 'workspace', path: '/workspace' }, {
    id, workspaceId: 'w1', workspaceTitle: 'workspace', workspacePath: '/workspace', task: 'old pending', dispatchedAt: at, updatedAt: at, status: 'pending', sessionId, artifacts: [], decisions: [],
  })
}
