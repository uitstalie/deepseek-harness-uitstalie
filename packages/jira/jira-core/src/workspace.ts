/**
 * core/workspace — which project is *this* checkout (§4.10, decisions 77/92).
 *
 * The design settled the question before it came up again: identity is the **normalized git remote**,
 * never the path, because the same work moves between machines and directories. `SessionHeader.cwd`
 * is the reliable basis for attributing a session to a project — it is fixed when the session is
 * created, and changing the working directory inside the session does not change ownership (§2.5).
 *
 * The rules this module follows, in order:
 *
 *   1. read the checkout's remotes, preferring `upstream` over `origin` over the rest (§4.10);
 *   2. look for a project whose `remotes[]` matches that identity — **a hit wins even if the path is
 *      completely different** (the moved-machine case);
 *   3. otherwise look for a project whose `paths[]` contains this checkout (decision 92: a cache,
 *      useful exactly here);
 *   4. otherwise **derive** the key the first write *would* register (`dsh-jira` → `DJ`), without
 *      registering anything: opening a session must not write (decision 38);
 *   5. a checkout with no remote cannot be recognized across machines, so other machines' agents are
 *      read-only there (§4.10 step 5 / §4.11's `owner-machine`); humans may still write.
 */

import { type JiraError } from './errors.ts'
import { type GitRunner, runGit } from './git.ts'
import { deriveKey, listProjects, normalizeRemote, remoteIdentity } from './project.ts'
import { system, systemFor } from './system/index.ts'

export { deriveKey }
import { type Result, ok } from './result.ts'
import { type Store } from './store.ts'

/** What a session's checkout resolves to. */
export type WorkspaceBinding = Readonly<{
  cwd: string
  /** The project this checkout belongs to, when one could be identified. */
  project?: string
  by: 'remote' | 'path' | 'derived' | 'none'
  /** The normalized identity that decided it, for `remote`. */
  remote?: string
  /** The key a first write would register (§4.10 step 4) — derived, not created. */
  derivedKey?: string
  /** No remote: this project is anchored to one machine, so other machines' agents must not write. */
  agentReadOnly: boolean
}>

/**
 * Derive a key the way §4.10 says: **from the repository name**, not from the path, uppercase
 * initials of the words, at most six characters. `deepseek-harness` → `DH`, `dsh-jira` → `DJ`.
 *
 * `deriveKey` is also given the *normalized remote* (its basename is the repository), so the same
 * checkout registers the same key on every machine even though its directory differs.
 */
/** The remotes of a checkout, as git reports them. Remotes that cannot be read are simply absent. */
export const workspaceRemotes = async (
  cwd: string,
  run: GitRunner = runGit,
): Promise<readonly string[]> => {
  const listed = await run(cwd, ['remote', '-v'])
  if (listed.code !== 0) return Object.freeze([])
  const named = new Map<string, string>()
  for (const line of listed.stdout.split('\n')) {
    const fields = line.trim().split(/\s+/u)
    const name = fields[0]
    const url = fields[1]
    if (name === undefined || url === undefined || name === '') continue
    // `git remote -v` prints fetch and push; the fetch URL is the identity.
    if (!named.has(name)) named.set(name, url)
  }
  const order = ['upstream', 'origin']
  const sorted = [...named.entries()].sort(([left], [right]) => {
    const leftRank = order.indexOf(left)
    const rightRank = order.indexOf(right)
    return (leftRank === -1 ? order.length : leftRank) - (rightRank === -1 ? order.length : rightRank)
  })
  return Object.freeze(sorted.map(([, url]) => url))
}

/**
 * Resolve a checkout against a store. **Read-only**: nothing is created here, even when the answer
 * is "this would be a new project" (decision 38, §4.10).
 */
export const resolveWorkspace = async (
  store: Store,
  cwd: string,
  run: GitRunner = runGit,
  platform: string = system.facts.platform,
): Promise<Result<WorkspaceBinding, JiraError>> => {
  const projects = await listProjects(store)
  if (!projects.ok) return projects

  const remotes = await workspaceRemotes(cwd, run)
  const identity = remoteIdentity(remotes)
  if (identity !== undefined && identity !== '') {
    for (const project of projects.value) {
      if (project.remotes.some(remote => normalizeRemote(remote) === identity)) {
        return ok(Object.freeze({
          cwd,
          project: project.key,
          by: 'remote' as const,
          remote: identity,
          agentReadOnly: false,
        }))
      }
    }
  }

  const sys = systemFor(platform)
  const here = sys.normalizePath(cwd)
  for (const project of projects.value) {
    if (project.paths.some(entry => sys.samePath(entry, here))) {
      return ok(Object.freeze({
        cwd,
        project: project.key,
        by: 'path' as const,
        ...(identity === undefined || identity === '' ? {} : { remote: identity }),
        agentReadOnly: false,
      }))
    }
  }

  // §4.10: the key comes from the **repository** name, so a checkout registers the same key on
  // every machine. Only a checkout with no remote falls back to its directory name.
  const derived = deriveKey(identity === undefined || identity === '' ? cwd : identity)
  if (identity === undefined || identity === '') {
    // No remote: nothing to match on and nothing to register across machines (§4.10 step 5).
    return ok(Object.freeze({ cwd, by: 'none' as const, derivedKey: derived, agentReadOnly: true }))
  }
  return ok(Object.freeze({
    cwd,
    by: 'derived' as const,
    remote: identity,
    derivedKey: derived,
    agentReadOnly: false,
  }))
}

/** The compact phrase the prompt line carries. Empty when nothing could be said. */
export const describeBinding = (binding: WorkspaceBinding | undefined): string => {
  if (binding === undefined) return ''
  if (binding.project !== undefined) {
    return binding.by === 'remote' ? `workspace → ${binding.project} (by remote)` : `workspace → ${binding.project} (by path)`
  }
  if (binding.by === 'derived' && binding.derivedKey !== undefined) {
    // Worth saying: the first write will register it, so the model can name it before that happens.
    return `workspace → new project ${binding.derivedKey} on first write`
  }
  return 'workspace → no remote (owner-machine: other machines read-only)'
}
