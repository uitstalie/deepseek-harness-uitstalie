/**
 * The super workspace's standing definition (`AGENTS.md`) and its versioned managed section.
 *
 * The file is what the native instruction loader reads for every conversation opened in that
 * directory, so the role belongs to the workspace rather than to one capability's prompt. The
 * plugin owns only the block between `<!-- superagent:managed begin v=N -->` and
 * `<!-- superagent:managed end -->`; everything outside those markers is the person's text and is
 * never rewritten. A version bump replaces the block body only; a hand-edited block is left alone
 * and reported once instead of being overwritten.
 *
 * @module @deepseek-ai/dsh-jira-agent/super-workspace-definition
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ContextFormed, MessageId, UserMessage } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Superagent workspace-definition notices. Another reader without this plugin still preserves
     * the recorded text; the producer reads neither the kind nor its metadata back.
     * @persistenceAttribution
     */
    'jira-agent': { kind: 'jira-agent' } & ContextFormed
  }
}

/** The instruction filename the native loader already understands. */
export const SUPER_WORKSPACE_DEFINITION_FILE = 'AGENTS.md'

/** The current managed-section version; bump it when `managedSectionBody()` changes. */
export const MANAGED_SECTION_VERSION = 1

/** State file inside the super workspace, beside the dispatch ledger. */
export const SUPER_WORKSPACE_STATE_FILE = join('.superagent', 'agents-md.json')

/** Title written into a file this plugin creates; a person's existing title is never touched. */
const DEFINITION_TITLE = '# Super agent workspace'

/** Longest summary a notice row shows before expanding. */
const NOTICE_SUMMARY_MAX = 120

/** The managed body for {@link MANAGED_SECTION_VERSION}. */
export const managedSectionBody = (): string => `The super agent workspace

This directory is the person's single conversation with the harness. It is not a project checkout:
it owns the conversation, the decisions made in it, and the dispatch ledger for every workspace.

## What belongs here

- The person's requests, questions and decisions.
- The per-workspace dispatch ledger under \`.superagent/ledger/\`.
- Durable conclusions written through the memory capability (\`.dsh/memory\` is managed there).
- Harness-global work: DSH settings, plugins, shared configuration.

## What must go to a workspace Session

Code, documents, data and commands that belong to a registered workspace go to that workspace's
real Session through \`superagent_control\` (append for follow-up, start only when the person asks
for a new isolated conversation). \`superagent_deliver\` copies a file into a workspace; do not edit
other workspace files from here.

## Registry discipline

- \`superagent_control\` \`ensure\`, \`rename_workspace\` and \`remove_workspace\` are writes. Never
  call one to "check" whether a workspace exists; \`roster\` is the only read.
- The order is fixed: read \`roster\`, decide whether a registration is actually needed (directory,
  title, duplicate), ask the person, then write only on their explicit instruction.
- A registration or rename the person already made in the UI wins. Do not "confirm" or "repair" it
  with a tool call.
- A write is not harmless because it is idempotent: it can move store order and timestamps. Treat
  every call like a new registration.

## Dispatch workflow

1. Before dispatching, read the workspace's ledger with \`superagent_ledger list\` and check what is
   still pending or unresolved.
2. After dispatching, the tool records a \`pending\` entry automatically. Report the task id to the
   person; use \`superagent_ledger record\` only as a manual fallback.
3. A long conversation may need its context compacted before more work: \`superagent_control list\`
   reports each Session's context usage, and \`compact\` (or \`compact: true\`) compacts it through
   the host seam. It refuses while the Session runs; wait rather than interrupt. When the person
   asks to tidy a workspace's memory, pass \`curate_memory: true\` so that workspace's agent curates
   its own memory.
4. When a \`[task-report]\` arrives, the plugin has already marked the task \`returned\` or
   \`failed\`. Read the ledger, confirm the outcome, and use \`superagent_ledger resolve\` to add the
   conclusion, artifact paths and open decisions the automatic record could not know.
5. Record the durable conclusion with \`memory_write\` after resolving.
6. Never copy jira issue status, comments or claim identity into the ledger. Reference the issue key
   only (\`issue: DH-123\`).

## Boundaries

- This workspace is never removed or renamed from itself.
- The ledger is append-only; corrections append a new section for the same task id.
- The jira ledger owns issue lifecycle; this ledger owns which task went to which workspace and
  what came back.
- \`superagent_permission\` lists, reads or switches the permission of one explicitly addressed
  workspace Session. New Sessions start with \`workspace-write\`. \`soft\` selects the guarded
  tool/path blacklist only in the unconfined soft-policy composition; it never disables an active
  OS sandbox.
`

/** Absolute path of the definition inside one super workspace. */
export const superWorkspaceDefinitionPath = (root: string): string =>
  join(root, SUPER_WORKSPACE_DEFINITION_FILE)

/** Absolute path of the managed-section state file inside one super workspace. */
export const superWorkspaceDefinitionStatePath = (root: string): string =>
  join(root, SUPER_WORKSPACE_STATE_FILE)

/** One complete managed section, markers included. */
export const renderManagedSection = (
  version: number = MANAGED_SECTION_VERSION,
  body: string = managedSectionBody(),
): string => `<!-- superagent:managed begin v=${String(version)} -->\n${body}\n<!-- superagent:managed end -->`

/** What one sync remembered between runs. */
export interface SuperWorkspaceDefinitionState {
  /** Version of the block this plugin wrote last. */
  readonly writtenVersion: number
  /** Hash of the block body this plugin wrote last; a mismatch means a local edit. */
  readonly writtenHash: string
  /** Hash of an edited block a notice already reported. */
  readonly notifiedHash?: string
  /** Notice to deliver on the next super Session, cleared once shown. */
  readonly pendingNotice?: string
}

/** The read/write seam the synchronizer uses; tests inject a counting implementation. */
export interface SuperWorkspaceDefinitionIo {
  /** File text, or undefined when the path does not exist. */
  read(path: string): Promise<string | undefined>
  /** Replace the file atomically, creating its directory when needed. */
  write(path: string, text: string): Promise<void>
}

/** What one synchronisation did. */
export type SuperWorkspaceDefinitionResult =
  | { readonly kind: 'created'; readonly path: string; readonly version: number }
  | { readonly kind: 'appended'; readonly path: string; readonly version: number; readonly notice: string }
  | { readonly kind: 'rebuilt'; readonly path: string; readonly version: number }
  | { readonly kind: 'upgraded'; readonly path: string; readonly from: number; readonly to: number }
  | { readonly kind: 'unchanged'; readonly path: string; readonly version: number }
  | { readonly kind: 'conflict'; readonly path: string; readonly version: number; readonly notice?: string }
  | { readonly kind: 'failed'; readonly path: string; readonly message: string }

/** The shipped filesystem implementation: atomic replace via a sibling temporary file. */
export const defaultSuperWorkspaceDefinitionIo: SuperWorkspaceDefinitionIo = {
  async read(path: string): Promise<string | undefined> {
    try {
      return await readFile(path, 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  },
  async write(path: string, text: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${randomUUID()}.tmp`
    await writeFile(temporary, text, 'utf8')
    try {
      await rename(temporary, path)
    } catch (error: unknown) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  },
}

/** sha256 in lowercase hex; the hash identifies one block body exactly. */
const hashOf = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/** Parsed marker state of one definition file. */
type ParsedDefinition =
  | { readonly kind: 'none' }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'block'; readonly version: number; readonly body: string; readonly start: number; readonly end: number }

/**
 * Locate the managed block and its exact body.
 *
 * One begin marker and one end marker in order is the only shape this plugin writes; zero means
 * the file predates the managed section, and anything else is damage this plugin refuses to guess
 * around.
 * @param text - the whole definition file.
 * @returns the parsed shape.
 */
const parseManaged = (text: string): ParsedDefinition => {
  const begins = [...text.matchAll(/<!-- superagent:managed begin v=(\d+) -->/gu)]
  const ends = [...text.matchAll(/<!-- superagent:managed end -->/gu)]
  if (begins.length === 0 && ends.length === 0) return { kind: 'none' }
  const begin = begins[0]
  const end = ends[0]
  if (begins.length !== 1 || ends.length !== 1 || begin?.index === undefined || end?.index === undefined) {
    return { kind: 'malformed' }
  }
  if (end.index < begin.index) return { kind: 'malformed' }
  const version = Number.parseInt(begin[1] ?? '', 10)
  if (!Number.isFinite(version)) return { kind: 'malformed' }
  let body = text.slice(begin.index + begin[0].length, end.index)
  if (body.startsWith('\r\n')) body = body.slice(2)
  else if (body.startsWith('\n')) body = body.slice(1)
  if (body.endsWith('\r\n')) body = body.slice(0, -2)
  else if (body.endsWith('\n')) body = body.slice(0, -1)
  return { kind: 'block', version, body, start: begin.index, end: end.index + end[0].length }
}

/** Read the remembered state; a missing or unreadable record is treated as absent. */
const readState = async (
  root: string,
  io: SuperWorkspaceDefinitionIo,
): Promise<SuperWorkspaceDefinitionState | undefined> => {
  const text = await io.read(superWorkspaceDefinitionStatePath(root))
  if (text === undefined) return undefined
  try {
    const parsed = JSON.parse(text) as Partial<SuperWorkspaceDefinitionState>
    if (typeof parsed.writtenVersion !== 'number' || typeof parsed.writtenHash !== 'string') return undefined
    return {
      writtenVersion: parsed.writtenVersion,
      writtenHash: parsed.writtenHash,
      ...typeof parsed.notifiedHash === 'string' ? { notifiedHash: parsed.notifiedHash } : {},
      ...typeof parsed.pendingNotice === 'string' ? { pendingNotice: parsed.pendingNotice } : {},
    }
  } catch {
    return undefined
  }
}

/** Persist the remembered state. */
const writeState = async (
  root: string,
  io: SuperWorkspaceDefinitionIo,
  state: SuperWorkspaceDefinitionState,
): Promise<void> => {
  await io.write(superWorkspaceDefinitionStatePath(root), `${JSON.stringify(state, null, 2)}\n`)
}

/** Notice text for a file that predates the managed section or lost it. */
const appendedNotice = (path: string): string =>
  `[superagent] A managed section was appended to AGENTS.md (v${String(MANAGED_SECTION_VERSION)}); the hand-written content was preserved. Check it for rules that now duplicate the managed block. Path: ${path}`

/** Notice text for a locally edited managed section this plugin will not overwrite. */
const conflictNotice = (path: string): string =>
  `[superagent] AGENTS.md has local edits inside the superagent managed section, so v${String(MANAGED_SECTION_VERSION)} was not applied. Back it up and delete the managed block to let the plugin rebuild it, or merge the current version by hand. Path: ${path}`

/** Notice text for damaged or duplicated markers. */
const malformedNotice = (path: string): string =>
  `[superagent] AGENTS.md has a damaged superagent managed section (missing or duplicated markers), so it was left untouched. Fix the markers by hand. Path: ${path}`

/** Notice text for one failed read-compare-write; callers never retry in a loop. */
export const failedNotice = (path: string, message: string): string =>
  `[superagent] The AGENTS.md managed section could not be updated: ${message}. Path: ${path} (no automatic retry)`

/** Per-root serialization, so concurrent triggers cannot interleave their read-compare-write. */
const queues = new Map<string, Promise<unknown>>()

/**
 * Run one task after every earlier task for this root.
 * @param root - the super workspace directory.
 * @param task - the read-compare-write to run alone.
 * @returns the task's own result.
 */
const serialize = <T>(root: string, task: () => Promise<T>): Promise<T> => {
  const previous = queues.get(root) ?? Promise.resolve()
  const next = previous.then(task, task)
  const tail = next.then(() => undefined, () => undefined)
  queues.set(root, tail)
  void tail.then(() => {
    if (queues.get(root) === tail) queues.delete(root)
  })
  return next
}

/** One serialized synchronisation pass. */
const syncOnce = async (
  root: string,
  io: SuperWorkspaceDefinitionIo,
): Promise<SuperWorkspaceDefinitionResult> => {
  const path = superWorkspaceDefinitionPath(root)
  try {
    const text = await io.read(path)
    const state = await readState(root, io)
    if (text === undefined) {
      await io.write(path, `${DEFINITION_TITLE}\n\n${renderManagedSection()}\n`)
      await writeState(root, io, {
        writtenVersion: MANAGED_SECTION_VERSION,
        writtenHash: hashOf(managedSectionBody()),
      })
      return { kind: 'created', path, version: MANAGED_SECTION_VERSION }
    }

    const parsed = parseManaged(text)
    if (parsed.kind === 'none') {
      const notice = state === undefined ? appendedNotice(path) : undefined
      const separator = text.endsWith('\n') ? '\n' : '\n\n'
      await io.write(path, `${text}${separator}${renderManagedSection()}\n`)
      await writeState(root, io, {
        writtenVersion: MANAGED_SECTION_VERSION,
        writtenHash: hashOf(managedSectionBody()),
        ...notice === undefined ? {} : { pendingNotice: notice },
      })
      // A person who deleted the block asked for it to be rebuilt; only the pre-marker file gets
      // the "check for duplicates" notice.
      return notice === undefined
        ? { kind: 'rebuilt', path, version: MANAGED_SECTION_VERSION }
        : { kind: 'appended', path, version: MANAGED_SECTION_VERSION, notice }
    }

    if (parsed.kind === 'malformed') {
      const notice = malformedNotice(path)
      const hash = `malformed:${hashOf(text)}`
      if (state?.notifiedHash !== hash) {
        await writeState(root, io, {
          writtenVersion: state?.writtenVersion ?? 0,
          writtenHash: state?.writtenHash ?? '',
          notifiedHash: hash,
          pendingNotice: notice,
        })
        return { kind: 'conflict', path, version: state?.writtenVersion ?? 0, notice }
      }
      return { kind: 'conflict', path, version: state.writtenVersion }
    }

    const bodyHash = hashOf(parsed.body)
    const currentHash = hashOf(managedSectionBody())
    if (state === undefined) {
      // Markers but no record: adopt the block only when it is exactly what this version writes.
      if (bodyHash === currentHash) {
        await writeState(root, io, { writtenVersion: parsed.version, writtenHash: bodyHash })
        return { kind: 'unchanged', path, version: parsed.version }
      }
      const notice = conflictNotice(path)
      await writeState(root, io, { writtenVersion: 0, writtenHash: '', notifiedHash: bodyHash, pendingNotice: notice })
      return { kind: 'conflict', path, version: parsed.version, notice }
    }

    if (bodyHash !== state.writtenHash) {
      if (state.notifiedHash === bodyHash) return { kind: 'conflict', path, version: parsed.version }
      const notice = conflictNotice(path)
      await writeState(root, io, {
        writtenVersion: state.writtenVersion,
        writtenHash: state.writtenHash,
        notifiedHash: bodyHash,
        pendingNotice: notice,
      })
      return { kind: 'conflict', path, version: parsed.version, notice }
    }

    if (parsed.version >= MANAGED_SECTION_VERSION) {
      return { kind: 'unchanged', path, version: parsed.version }
    }

    const upgraded = `${text.slice(0, parsed.start)}${renderManagedSection()}${text.slice(parsed.end)}`
    await io.write(path, upgraded)
    await writeState(root, io, {
      writtenVersion: MANAGED_SECTION_VERSION,
      writtenHash: currentHash,
      ...state.notifiedHash === undefined ? {} : { notifiedHash: state.notifiedHash },
    })
    return { kind: 'upgraded', path, from: parsed.version, to: MANAGED_SECTION_VERSION }
  } catch (error: unknown) {
    return {
      kind: 'failed',
      path,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Bring one super workspace's `AGENTS.md` up to the current managed-section version.
 *
 * Runs are serialized per root and read-compare-write; an unchanged file is not touched at all.
 * Notices for an append or a refusing conflict are stored in the state file and delivered by the
 * next super Session through {@link takeSuperWorkspaceDefinitionNotice}.
 * @param root - the super workspace directory.
 * @param io - the read/write seam; tests inject one to count writes.
 * @returns what this pass did.
 */
export const syncSuperWorkspaceDefinition = (
  root: string,
  io: SuperWorkspaceDefinitionIo = defaultSuperWorkspaceDefinitionIo,
): Promise<SuperWorkspaceDefinitionResult> => serialize(root, async () => syncOnce(root, io))

/**
 * Take the pending managed-section notice, clearing it so it is shown once.
 * @param root - the super workspace directory.
 * @param io - the read/write seam.
 * @returns the notice text, or undefined when none is pending.
 */
export const takeSuperWorkspaceDefinitionNotice = (
  root: string,
  io: SuperWorkspaceDefinitionIo = defaultSuperWorkspaceDefinitionIo,
): Promise<string | undefined> => serialize(root, async () => {
  const state = await readState(root, io)
  if (state?.pendingNotice === undefined) return undefined
  const { pendingNotice, ...rest } = state
  await writeState(root, io, rest)
  return pendingNotice
})

/**
 * Append one visible notice to a Session as a synthetic user message.
 *
 * This is the same surface the harness uses for its own context notices: the person sees it in the
 * conversation and the model sees it in the next request; it is not a log line.
 * @param session - the Session receiving the notice.
 * @param text - the full notice text; its first characters become the row summary.
 * @returns whether the Session exposed an append surface.
 */
export const appendSuperWorkspaceDefinitionNotice = (session: unknown, text: string): boolean => {
  const append = (session as {
    append?: (type: 'user/message', message: UserMessage, options: { surfaceOp: 'append' }) => unknown
  } | undefined)?.append
  if (typeof append !== 'function') return false
  const summary = text.length <= NOTICE_SUMMARY_MAX ? text : `${text.slice(0, NOTICE_SUMMARY_MAX - 1)}…`
  const message: UserMessage = {
    id: randomUUID() as MessageId,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'jira-agent', form: 'notice', summary },
  }
  append.call(session, 'user/message', message, { surfaceOp: 'append' })
  return true
}

/**
 * Create the definition when it is missing, then synchronise the managed section.
 *
 * Kept for the registration path: an existing file is never replaced, only its managed block is
 * added or upgraded.
 * @param root - the super workspace directory, created when missing.
 * @returns whether this call created the file.
 */
export const ensureSuperWorkspaceDefinition = async (root: string): Promise<boolean> => {
  await mkdir(root, { recursive: true })
  const result = await syncSuperWorkspaceDefinition(root)
  return result.kind === 'created'
}
