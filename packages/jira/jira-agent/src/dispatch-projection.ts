import {
  appendDispatchTask,
  ledgerFileOf,
  listAllDispatchTasks,
  queryDispatchTasks,
} from './dispatch-ledger.ts'
import type { DispatchLedgerWorkspace, DispatchProjection, DispatchLedgerTask, DispatchLedgerQuery, DispatchLedgerRow } from '@deepseek-ai/dsh-superagent-core'

/** Keep the existing Jira Markdown projection behind the control package's interface. */
export const markdownDispatchProjection = (root: string): DispatchProjection => Object.freeze({
  fileFor: (workspaceId: string) => ledgerFileOf(root, workspaceId),
  append: async (workspace: DispatchLedgerWorkspace, task: DispatchLedgerTask): Promise<void> => {
    await appendDispatchTask(root, workspace, task)
  },
  readAll: () => listAllDispatchTasks(root),
  query: (rows: readonly DispatchLedgerRow[], query: DispatchLedgerQuery) => queryDispatchTasks(rows, query),
})
