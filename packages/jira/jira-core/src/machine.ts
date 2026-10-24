/**
 * core/machine — this machine's stable identity inside the store (decision 73).
 *
 * Two machines sharing one id would share `counters/<id>.json` and mint the same keys, so
 * the id must be **stable** (survives restarts) and **unique per machine**. It lives in a
 * file outside the store (`$DSH_HOME/dsh-jira/machine-id`) because a store is now a clone of
 * a shared repository: an identity kept inside it would travel to the other machine.
 *
 * Resolution order: explicit configuration, then the environment, then the file (created on
 * first use). The hostname is deliberately **not** used — it changes on a re-image, and two
 * containers can share one.
 */

import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'

import { type JiraError, invalidInput } from './errors.ts'
import { exists, readText, writeTextAtomic } from './io.ts'
import { type Result, err, ok } from './result.ts'
import { system } from './system/index.ts'

/** `<model>|<machine>`-safe: short, lowercase, no separators that mean something else. */
export const MACHINE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,31}$/u

/**
 * Where the identity lives. `$DSH_HOME` first, then the user profile — and if neither is
 * known, **inside the store's ignored `.jira/`** rather than relative to the working
 * directory: a machine id dropped into whatever directory a command happened to run from is
 * how one ends up committed into a repository that other machines clone.
 */
/**
 * The directory that holds this machine's own state — the machine id and everything that must not
 * travel to another machine (`notices/`, session watermarks). Decision 73's rule, one place.
 *
 * The fallback is the store's ignored `.jira/` when neither `DSH_HOME` nor a home directory is
 * known, so the answer is always a path: a caller never has to invent one.
 */
export const machineStateDir = (
  env: Readonly<Record<string, string | undefined>>,
  fallbackRoot?: string,
): string => {
  const file = machineIdFile(env, fallbackRoot)
  return file === undefined ? join(fallbackRoot ?? '.', '.jira') : dirname(file)
}

export const machineIdFile = (
  env: Readonly<Record<string, string | undefined>>,
  fallbackRoot?: string,
): string | undefined => {
  // Decision 153: the home / state-directory rule is the adapter's, so this file, the plugin and
  // the session watermark cannot resolve it three slightly different ways.
  const state = system.stateDir(env, fallbackRoot)
  return state === undefined ? undefined : join(state, 'machine-id')
}

export const generateMachineId = (): string => `m-${randomBytes(4).toString('hex')}`

/**
 * Claim a notice that must appear **once per machine** (decisions 91/150): `true` the first time,
 * `false` every time after. The marker lives in the machine's own state directory, not in the
 * store — "have I already said this" is a fact about this machine, and a store is a clone that
 * other machines read (decision 73). A marker we cannot write is not worth failing a listing
 * over: the caller then simply sees the hint again.
 *
 * Decision 187: this used to be the CLI's private `claimNotice`; it is machine state, so it
 * lives here, on the io boundary like every other write (decision 180).
 */
export const claimNoticeOnce = async (directory: string, machineId: string, name: string): Promise<boolean> => {
  // One sanitizer for every "an id becomes a file name" case (decision 167).
  const path = join(directory, 'notices', `${system.safeFileName(`${name}-${machineId}`)}.seen`)
  if (await exists(path)) return false
  await writeTextAtomic(path, '')
  return true
}

export const isMachineId = (value: string): boolean => MACHINE_ID_PATTERN.test(value)

export type MachineIdSource = 'configured' | 'environment' | 'file' | 'generated'

export type ResolvedMachine = Readonly<{ id: string; source: MachineIdSource; file: string }>

/**
 * Read the machine id, creating it on first use. A malformed file is replaced rather than
 * trusted: an id that another machine might also compute is worse than a new one.
 */
export const resolveMachineId = async (options: Readonly<{
  configured?: string
  env: Readonly<Record<string, string | undefined>>
  /** The store root, used when neither DSH_HOME nor a user profile is known. */
  fallbackRoot?: string
  /** Overridable for tests. */
  file?: string
  create?: (id: string) => Promise<Result<void, JiraError>>
}>): Promise<Result<ResolvedMachine, JiraError>> => {
  const file = options.file ?? machineIdFile(options.env, options.fallbackRoot)
  if (file === undefined) {
    return err(invalidInput('cannot locate the machine id: set DSH_HOME (or HOME), or pass a store root'))
  }
  if (options.configured !== undefined && options.configured !== '') {
    if (!isMachineId(options.configured)) {
      return err(invalidInput(
        `machine_id "${options.configured}" must be lowercase letters, digits or dashes (3-32)`,
        { machineId: options.configured },
      ))
    }
    return ok(Object.freeze({ id: options.configured, source: 'configured', file }))
  }

  const fromEnv = options.env.DSH_MACHINE_ID
  if (fromEnv !== undefined && fromEnv !== '' && isMachineId(fromEnv)) {
    return ok(Object.freeze({ id: fromEnv, source: 'environment', file }))
  }

  const existing = await readText(file)
  if (existing.ok && isMachineId(existing.value.trim())) {
    return ok(Object.freeze({ id: existing.value.trim(), source: 'file', file }))
  }
  // no file yet, or unreadable: fall through and make one

  const generated = generateMachineId()
  // Decision 180: the write goes through the io boundary like every other store-adjacent write —
  // atomic, retried, and with the BOM/CR refusal in one place instead of a raw writeFile bypass.
  const write = options.create ?? ((id: string): Promise<Result<void, JiraError>> =>
    writeTextAtomic(file, `${id}\n`))
  const written = await write(generated)
  return written.ok ? ok(Object.freeze({ id: generated, source: 'generated', file })) : written
}
