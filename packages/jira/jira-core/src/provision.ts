/**
 * core/provision — joining the store on a new machine.
 *
 * The store is a **clone of one shared data repository**, so `jira init` is really "get me a
 * working copy of the ledger":
 *
 *  * nothing there yet + a remote → `git clone` it (history, vocabulary and the other
 *    machines' counters all arrive together);
 *  * nothing there yet + no remote → scaffold a local-only store (the offline case);
 *  * already a repository → make sure the remote is right and fast-forward, never rewrite.
 *
 * Nothing here decides *which* remote: that is configuration, and the whole point of this
 * module is that a second machine needs nothing but the URL.
 */

import { dirname } from 'node:path'

import { type JiraError, ioFailed } from './errors.ts'
import { type GitRunner, initializeRepository, isRepository, runGit } from './git.ts'
import { exists, mkdirp } from './io.ts'
import { type Result, err, ok } from './result.ts'
import { scaffoldStore } from './scaffold.ts'

export type ProvisionOptions = Readonly<{
  root: string
  /** The shared data repository. Absent means "local-only store". */
  remote?: string
  /** Fast-forward an existing clone; a dirty or diverged tree is reported, not forced. */
  pull?: boolean
  run?: GitRunner
}>

export type ProvisionResult = Readonly<{
  action: 'cloned' | 'scaffolded' | 'joined' | 'unchanged'
  root: string
  remote?: string
  /** What `git pull --ff-only` said, when a pull was attempted. */
  pulled?: 'up-to-date' | 'fast-forwarded' | 'refused'
  detail?: string
}>

/** The origin a repository is pointed at, or undefined when there is none. */
export const currentRemote = async (root: string, run: GitRunner = runGit): Promise<string | undefined> => {
  const result = await run(root, ['remote', 'get-url', 'origin'])
  return result.code === 0 && result.stdout !== '' ? result.stdout : undefined
}

/** Point the repository at `remote`, without touching history. */
export const ensureRemote = async (
  root: string,
  remote: string,
  run: GitRunner = runGit,
): Promise<Result<'set' | 'unchanged', JiraError>> => {
  const existing = await currentRemote(root, run)
  if (existing === remote) return ok('unchanged')
  const command = existing === undefined
    ? ['remote', 'add', 'origin', remote]
    : ['remote', 'set-url', 'origin', remote]
  const result = await run(root, command)
  return result.code === 0
    ? ok('set')
    : err(ioFailed(`cannot point ${root} at ${remote}`, { stderr: result.stderr.slice(0, 500) }))
}

/** Fast-forward only: a diverged or dirty clone is reported so a human can look. */
export const fastForward = async (
  root: string,
  run: GitRunner = runGit,
): Promise<Result<'up-to-date' | 'fast-forwarded' | 'refused', JiraError>> => {
  const before = await run(root, ['rev-parse', 'HEAD'])
  const pull = await run(root, ['pull', '--ff-only'])
  if (pull.code !== 0) return ok('refused')
  const after = await run(root, ['rev-parse', 'HEAD'])
  return ok(before.stdout === after.stdout ? 'up-to-date' : 'fast-forwarded')
}

export const provisionStore = async (options: ProvisionOptions): Promise<Result<ProvisionResult, JiraError>> => {
  const run = options.run ?? runGit

  if (!(await exists(options.root))) {
    if (options.remote === undefined) {
      const scaffolded = await scaffoldStore(options.root)
      if (!scaffolded.ok) return scaffolded
      return ok(Object.freeze({ action: 'scaffolded', root: options.root }))
    }
    const parent = dirname(options.root)
    if (parent !== '' && !(await exists(parent))) {
      const made = await mkdirp(parent)
      if (!made.ok) return made
    }
    const clone = await run(dirname(options.root), ['clone', options.remote, options.root])
    if (clone.code !== 0) {
      return err(ioFailed(`cannot clone ${options.remote}`, { stderr: clone.stderr.slice(0, 500) }))
    }
    // The clone carries `.gitattributes`, the vocabulary and the other machines' counters.
    return ok(Object.freeze({ action: 'cloned', root: options.root, remote: options.remote }))
  }

  if (!(await isRepository(options.root))) {
    // A directory with content but no repository: treat it as a local store to complete.
    const scaffolded = await scaffoldStore(options.root)
    if (!scaffolded.ok) return scaffolded
    if (options.remote === undefined) {
      return ok(Object.freeze({ action: 'scaffolded', root: options.root }))
    }
  }

  const initialized = await initializeRepository(options.root, run)
  if (!initialized.ok) return initialized

  let joined: 'set' | 'unchanged' = 'unchanged'
  if (options.remote !== undefined) {
    const ensured = await ensureRemote(options.root, options.remote, run)
    if (!ensured.ok) return ensured
    joined = ensured.value
  }

  const pulled = options.pull === true && options.remote !== undefined
    ? await fastForward(options.root, run)
    : undefined
  if (pulled !== undefined && !pulled.ok) return pulled

  const remote = options.remote ?? await currentRemote(options.root, run)
  return ok(Object.freeze({
    action: joined === 'set' ? 'joined' : 'unchanged',
    root: options.root,
    ...(remote === undefined ? {} : { remote }),
    ...(pulled === undefined ? {} : { pulled: pulled.value }),
  }))
}
