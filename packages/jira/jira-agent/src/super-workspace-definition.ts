/**
 * The super workspace's own standing definition, seeded as the `AGENTS.md` that the native
 * instruction loader reads for every conversation opened in that directory.
 *
 * It is a file rather than a prompt section because the role belongs to the workspace: a person
 * can read it, edit it, and any later Session (not only the capability's own turns) sees the same
 * contract before the first tool call.
 *
 * @module @deepseek-ai/dsh-jira-agent/super-workspace-definition
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** The instruction filename the native loader already understands. */
export const SUPER_WORKSPACE_DEFINITION_FILE = 'AGENTS.md'

/** The definition seeded into a new super workspace. Existing files are never overwritten. */
export const SUPER_WORKSPACE_DEFINITION = `# Super agent workspace

This directory is the person's single conversation with the harness. It is not a project checkout:
it owns the conversation, the decisions made in it, and the dispatch ledger for every workspace.

## What belongs here

- The person's requests, questions and decisions.
- The per-workspace dispatch ledger under \`.superagent/ledger/\`.
- Durable conclusions written through the memory capability (\`.dsh/memory\` is managed there).
- Harness-global work: DSH settings, plugins, shared configuration.

## What must go to a workspace Session

Code, documents, data and commands that belong to a registered workspace go to that workspace's
real Session through \`superagent_session\` (append for follow-up, start only when the person asks
for a new isolated conversation). The one write this checkout performs in a workspace is \`superagent_deliver\`, which copies a file (report, spreadsheet, attachment) into that workspace and names the delivered path in the task; do not edit other workspace files from here.

## Dispatch workflow

1. Before dispatching, read the workspace's ledger with \`superagent_ledger list\` and check what is
   still pending or unresolved.
2. After dispatching, the tool records a \`pending\` entry automatically. Report the task id to the
   person; use \`superagent_ledger record\` only as a manual fallback.
3. When a \`[task-report]\` arrives, the plugin has already marked the task \`returned\` or
   \`failed\`. Read the ledger, confirm the outcome, and use \`superagent_ledger resolve\` to add the
   conclusion, artifact paths and open decisions that the automatic record could not know.
4. Record the durable conclusion with \`memory_write\` after resolving: one \`decision\` line for a
   settled outcome, one \`open\` line for an unresolved decision, tags naming \`superagent\`, the
   workspace and the task id.
5. Never copy jira issue status, comments or claim identity into the ledger. Reference the issue
   key only (\`issue: DH-123\`) and leave the ledger's task state separate.

## Boundaries

- This workspace is never removed or renamed from itself.
- The ledger is append-only; corrections append a new section for the same task id.
- The jira ledger owns issue lifecycle; this ledger owns "which task went to which workspace and
  what came back".
`

/** Absolute path of the definition inside one super workspace. */
export const superWorkspaceDefinitionPath = (root: string): string =>
  join(root, SUPER_WORKSPACE_DEFINITION_FILE)

/**
 * Create the definition when it is missing. An existing file is left byte-for-byte alone, so a
 * person's edits survive every remount.
 * @param root - the super workspace directory, already created.
 * @returns whether this call created the file.
 * @throws when the file exists but cannot be written for a reason other than `EEXIST`.
 */
export const ensureSuperWorkspaceDefinition = async (root: string): Promise<boolean> => {
  await mkdir(root, { recursive: true })
  try {
    await writeFile(superWorkspaceDefinitionPath(root), SUPER_WORKSPACE_DEFINITION, { encoding: 'utf8', flag: 'wx' })
    return true
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}
