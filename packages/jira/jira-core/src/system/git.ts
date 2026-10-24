/**
 * The environment a git child must see (decision 153).
 *
 * `git -C <store>` is the only authority on *which* repository an operation touches. A stray
 * `GIT_DIR`/`GIT_WORK_TREE` — present inside a git hook, in some CI images, in a user's shell — would
 * silently redirect the store's writes into **another** repository, and nothing in the ledger would
 * look wrong. So those variables are stripped here, once, for every git invocation.
 *
 * Configuration variables (`GIT_CONFIG_*`) are deliberately **kept**: configuring git is a legitimate
 * choice, and the plugin's tests simulate a machine that cannot guess an identity through them
 * (decision 146's bug). Stripping those would quietly stop covering that class.
 */

import type { SystemEnv } from './types.ts'

/** Variables that redirect git at another repository or index. */
const REPO_LOCATION_VARS: readonly string[] = Object.freeze([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
])

export const gitEnvFor = (base: SystemEnv): Readonly<Record<string, string>> => {
  const cleaned: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue
    // Case-insensitively: Windows environment variable names are case-insensitive, so `git_dir` is
    // the same variable as `GIT_DIR` to every child process there (decision 167).
    if (REPO_LOCATION_VARS.includes(key.toUpperCase())) continue
    cleaned[key] = value
  }
  return Object.freeze(cleaned)
}
