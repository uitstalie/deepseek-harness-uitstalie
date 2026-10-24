/**
 * core/system — the platform adapter (decisions 151/153).
 *
 * **One rule**: if behaviour depends on the operating system, it is a member of `System`, and a call
 * site asks the adapter instead of asking `process`. The module is split by concern so that the next
 * platform surprise has an obvious home:
 *
 * | file        | owns                                                              |
 * |-------------|-------------------------------------------------------------------|
 * | `types.ts`  | the `System` / `SystemFacts` shapes                               |
 * | `paths.ts`  | recorded-path rules, local resolution, separators, limits         |
 * | `env.ts`    | `$DSH_HOME` / profile, the state directory, the default root      |
 * | `git.ts`    | the environment a git child must see                              |
 * | `policy.ts` | atomic-write and cleanup retries                                  |
 *
 * It is deliberately **not** a god object: facts and pure derivations only — no store, no file IO, no
 * clock, no git process. That is what makes `systemFor('win32')` able to run Windows' rules on a Linux
 * machine and vice versa, which is the cheapest cross-OS test rig there is
 * (`src/testing/bothPlatforms.ts` drives exactly that).
 */

import { envRulesFor } from './env.ts'
import { gitEnvFor } from './git.ts'
import { longPathLimitOf, PATH_LENGTH_WARN, pathRulesFor } from './paths.ts'
import { REMOVE_RETRIES, WRITE_ATTEMPTS, removeDelayMs, writeDelayMs } from './policy.ts'
import type { System, SystemFacts, SystemPlatform } from './types.ts'

export type { System, SystemEnv, SystemFacts, SystemPlatform } from './types.ts'
export { PATH_LENGTH_WARN } from './paths.ts'

const factsFor = (platform: SystemPlatform): SystemFacts => Object.freeze({
  platform,
  isWindows: platform === 'win32',
  separator: platform === 'win32' ? '\\' : '/',
  devNull: platform === 'win32' ? 'nul' : '/dev/null',
  gitConfig: Object.freeze([
    Object.freeze(['core.fileMode', 'false'] as const),
    Object.freeze(['i18n.commitEncoding', 'utf-8'] as const),
  ]),
  pathLengthWarn: PATH_LENGTH_WARN,
  longPathLimit: longPathLimitOf(platform),
})

/** Build the adapter for `platform` (defaults to the machine this process runs on). */
export const systemFor = (platform: string = process.platform): System => {
  const known: SystemPlatform = platform === 'win32' || platform === 'darwin' ? platform : 'linux'
  const facts = factsFor(known)
  return Object.freeze({
    facts,
    isWindows: facts.isWindows,
    ...pathRulesFor(facts),
    ...envRulesFor(facts),
    gitEnv: gitEnvFor,
    writeAttempts: WRITE_ATTEMPTS,
    writeDelayMs,
    removeRetries: REMOVE_RETRIES,
    removeDelayMs,
  })
}

/** The adapter for the machine this process is running on. */
export const system: System = systemFor()
