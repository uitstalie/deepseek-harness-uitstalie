/**
 * Where the project keeps its directories, per platform (decisions 57/73/123/153).
 *
 * Three call sites used to answer this three slightly different ways — `core/config` (the store root),
 * `core/machine` (the machine id file) and the plugin adapter (the session watermark directory) — and
 * they had already drifted: the CLI's copy had lost the `~/.dsh` fallback that makes the tools work
 * inside the GUI. One implementation, called by all of them.
 */

import { posix, win32 } from 'node:path'

import type { SystemEnv, SystemFacts } from './types.ts'

/** Trim a configured directory and drop trailing separators, whichever platform wrote them. */
export const cleanDir = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined
  const trimmed = value.trim().replace(/[\\/]+$/u, '')
  return trimmed === '' ? undefined : trimmed
}

export type EnvRules = Readonly<{
  homeDir(env: SystemEnv): string | undefined
  stateDir(env: SystemEnv, fallbackRoot?: string): string | undefined
  defaultStoreRoot(env: SystemEnv): string | undefined
  hostName(env: SystemEnv): string
}>

export const envRulesFor = (facts: SystemFacts): EnvRules => {
  const join = (...parts: string[]): string => facts.isWindows ? win32.join(...parts) : posix.join(...parts)

  // `dsh` resolves its own home to `~/.dsh` **without exporting `DSH_HOME`**, so the profile is not
  // the home itself — the home is `<profile>/.dsh`. Getting that wrong moved every file this project
  // keeps beside the user by one directory (decision 123, re-learned in 153).
  // `~` is expanded against the user profile and a relative value is made absolute (decision 167):
  // a relative `DSH_HOME` used to leave the machine id in whatever directory the command ran from, so
  // every cwd would have had its own identity — the very thing decision 73 forbids.
  const absolute = (value: string, env: SystemEnv): string => {
    const profile = cleanDir(env.USERPROFILE) ?? cleanDir(env.HOME)
    const expanded = value.startsWith('~') && profile !== undefined ? join(profile, value.slice(1)) : value
    // Only a **relative** value is resolved: an absolute one keeps the spelling the user gave it (no
    // gratuitous `C:/x` → `C:\x` rewriting), while a relative one becomes stable instead of following
    // whatever directory the command happened to run in.
    if (facts.isWindows) return win32.isAbsolute(expanded) ? expanded : win32.resolve(expanded)
    return posix.isAbsolute(expanded) ? expanded : posix.resolve(expanded)
  }

  const homeDir = (env: SystemEnv): string | undefined => {
    const explicit = cleanDir(env.DSH_HOME)
    if (explicit !== undefined) return absolute(explicit, env)
    const profile = cleanDir(env.USERPROFILE) ?? cleanDir(env.HOME)
    return profile === undefined ? undefined : join(profile, '.dsh')
  }

  return Object.freeze({
    homeDir,
    stateDir: (env: SystemEnv, fallbackRoot?: string): string | undefined => {
      const home = homeDir(env)
      if (home !== undefined) return join(home, 'dsh-jira')
      const root = cleanDir(fallbackRoot)
      return root === undefined ? undefined : join(root, '.jira')
    },
    defaultStoreRoot: (env: SystemEnv): string | undefined => {
      const home = homeDir(env)
      return home === undefined ? undefined : join(home, 'jira')
    },
    // The lock owner's `host` names the OS host, whichever surface asked (decision 181): the plugin
    // used to spell this out inline, the CLI not at all — one answer for both.
    hostName: (env: SystemEnv): string => {
      const value = cleanDir(env.COMPUTERNAME) ?? cleanDir(env.HOSTNAME)
      return value ?? 'unknown'
    },
  })
}
