/**
 * The person's choice of where the super agent lives.
 *
 * The super agent owns its checkout with a write-capable sandbox, so the location is chosen by a
 * person and never guessed: it must be absolute, must not be a filesystem root, and must not live
 * under the harness home, where settings, sessions and memory live. The rules mirror the
 * capability's own check in `jira-agent`; the two rows cannot import each other, so this module is
 * the browser-facing half and `jira-agent` keeps the mount-time half.
 *
 * @module @deepseek-ai/dsh-jira-service/superagent-setup
 */

import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

/** The loader row whose config names the super workspace. */
export const SUPERAGENT_AGENT_ROW = '@deepseek-ai/dsh-jira-agent'

/** One loader entry as the config editor sees it. */
export interface ConfigEditorEntryLike {
  readonly options: {
    readonly id?: string
    readonly name?: string
    readonly config?: Record<string, unknown>
  }
}

/** The slice of the host's config editor this module reads and writes. */
export interface ConfigEditorLike {
  entries(): readonly ConfigEditorEntryLike[]
  edit(
    entry: ConfigEditorEntryLike,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void>
}

/** The slice of the workspace registry the setup calls. */
export interface SetupWorkspaceLike {
  readonly id: string
  readonly path: string
}

/** The workspace registry methods the setup calls. */
export interface SetupRegistryLike {
  list(): readonly SetupWorkspaceLike[]
  create(path: string, title?: string): Promise<SetupWorkspaceLike>
  insertBefore?(id: string, beforeId?: string): Promise<readonly string[]>
}

/**
 * The harness home the path must stay out of: `$DSH_HOME`, else `<home>/.dsh`.
 * @param env - the process environment.
 * @returns the resolved harness home.
 */
export const dshHomeOf = (env: Readonly<Record<string, string | undefined>>): string => {
  const configured = env.DSH_HOME?.trim()
  if (configured === undefined || configured === '') return join(homedir(), '.dsh')
  return resolve(configured.replace(/^~(?=$|[\\/])/u, homedir()))
}

/**
 * Why one chosen super home cannot be used, if it cannot.
 * @param path - the directory the person picked.
 * @param dshHome - the resolved harness home the path must stay out of.
 * @returns a sentence naming the rule, or undefined when the path is usable.
 */
export const superagentHomeProblem = (path: string, dshHome: string): string | undefined => {
  const value = path.trim()
  if (value === '') return 'choose an absolute directory for the super agent'
  if (!isAbsolute(value)) return `the super agent needs an absolute directory, got ${value}`
  const resolved = resolve(value)
  if (dirname(resolved) === resolved) return `the super agent cannot live at a filesystem root (${resolved})`
  const home = resolve(dshHome)
  const candidate = relative(home, resolved)
  if (candidate === '' || (!candidate.startsWith('..') && !isAbsolute(candidate))) {
    return `the super agent cannot live under the harness home (${home}); choose a directory outside it`
  }
  return undefined
}

/**
 * The same checkout, compared the way the platform compares paths.
 * @param left - one absolute path.
 * @param right - the other absolute path.
 * @returns whether both name the same directory.
 */
export const sameSetupPath = (left: string, right: string): boolean => {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * Read the configured super home from the loader entry, without trusting the row's presence.
 * @param editor - the host's config editor, when the deployment has one.
 * @returns the configured, trimmed path; undefined when the row or the value is absent.
 */
export const readSuperagentHome = (editor: ConfigEditorLike | undefined): string | undefined => {
  const entry = editor?.entries().find(row => row.options.name === SUPERAGENT_AGENT_ROW)
  const configured = entry?.options.config?.['superagent_home']
  return typeof configured === 'string' && configured.trim() !== '' ? configured.trim() : undefined
}

/**
 * Persist one chosen super home on the jira-agent row.
 * @param editor - the host's config editor.
 * @param path - the validated directory.
 * @returns after the loader applied the new row config.
 * @throws Error when this profile carries no jira-agent row.
 */
export const writeSuperagentHome = async (editor: ConfigEditorLike, path: string): Promise<void> => {
  const entry = editor.entries().find(row => row.options.name === SUPERAGENT_AGENT_ROW)
  if (entry === undefined) throw new Error('this profile has no jira-agent row to configure')
  await editor.edit(entry, current => ({ ...current, superagent_home: path }))
}
