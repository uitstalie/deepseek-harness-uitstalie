/**
 * core/config — where the store lives, and how that is decided.
 *
 * Pure: it takes the two inputs a host can offer (a configured value and an environment)
 * and returns the first one that is present. The CLI and the plugin adapter both call it,
 * so the precedence lives in exactly one place (decisions 57, 102 ②).
 *
 * Precedence: an explicit config/flag value, then `$JIRA_ROOT`, then `$DSH_HOME/jira`, then
 * `<user profile>/.dsh/jira`. The last step matters because `dsh` resolves its own home to
 * `~/.dsh` **without exporting `DSH_HOME`** — the live host proved it: every tool answered
 * `cannot resolve the store root` until the home fallback existed (decision 123).
 */

import { type JiraError, invalidInput } from './errors.ts'
import { type Result, err, ok } from './result.ts'
import { systemFor, type SystemEnv } from './system/index.ts'

export type RootRequest = Readonly<{
  /** From `--root`, or the plugin's `root` config value. */
  configured?: string
  env: SystemEnv
  /** Which platform's path rules to use; defaults to this machine (decision 153). */
  platform?: string
}>

export const DEFAULT_ROOT_DIRNAME = 'jira'

/**
 * Decision 60's long-path guard, at the one place both surfaces resolve a root.
 *
 * Windows refuses paths past 260 characters (MAX_PATH) in the common case, and the store appends
 * `projects/<P>/comments/<KEY>.md` to whatever root it is handed — so a root that merely fits is not
 * good enough. The check is on the **root**, because that is the part a human chooses: the failure
 * mode otherwise is an `ENOENT` deep inside a write, which reads like a bug in the plugin.
 *
 * The 240-character *warning* is separate (`approachesPathLimit`, emitted at startup): a path near
 * the limit still works, it just will not survive a deeper project name.
 */
const acceptRoot = (root: string, request: RootRequest): Result<string, JiraError> => {
  const system = systemFor(request.platform)
  if (!system.exceedsPathLimit(root)) return ok(root)
  return err(invalidInput(
    `the store root is ${String(root.length)} characters long, past the ${String(system.facts.longPathLimit)}-character limit of ${system.facts.platform}: the files inside it would hit MAX_PATH and fail with a puzzling ENOENT, so pick a shorter directory`,
    { root, length: root.length, limit: system.facts.longPathLimit, platform: system.facts.platform },
  ))
}

export const resolveStoreRoot = (request: RootRequest): Result<string, JiraError> => {
  // Trimmed before it reaches a path (decision 169): `--root ' /srv/jira '` used to pass the spaces to
  // `git -C`, which then reported a directory that does not exist.
  const configured = request.configured?.trim()
  if (configured !== undefined && configured !== '') return acceptRoot(configured, request)

  const fromEnv = request.env.JIRA_ROOT?.trim()
  if (fromEnv !== undefined && fromEnv !== '') return acceptRoot(fromEnv, request)

  // Decision 153: the home / default-root rule lives in the adapter, so the CLI and the plugin
  // cannot resolve it two slightly different ways (the CLI had lost the `~/.dsh` fallback).
  const fromHome = systemFor(request.platform).defaultStoreRoot(request.env)
  if (fromHome !== undefined) return acceptRoot(fromHome, request)

  return err(invalidInput('cannot resolve the store root: configure `root`, or set JIRA_ROOT / DSH_HOME'))
}


/** `root: null` in a config file means "not configured", not "the literal null". */
export const configuredRootOf = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined
