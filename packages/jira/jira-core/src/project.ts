/**
 * core/project — `project.md`, the remote identity, and the checkout paths (decisions 77/92).
 *
 * Two rules make this file worth having:
 *
 *   - **the key lives in the directory name**, never in the frontmatter (decision 77) — the same
 *     rule the knowledge library follows (decision 107);
 *   - **identity is `remotes[]`, never `paths[]`**. Remotes are normalized hard (lowercase, no
 *     scheme, no credentials, no port, no `.git`) because a single clone URL comes in five
 *     spellings and identity must not depend on which one the developer happened to type; the
 *     priority is `upstream` > `origin` > the rest. Paths are a **cache** — normalized the same
 *     every time so they can be compared, and never allowed to decide who this project is.
 */

import { basename, join } from 'node:path'

import { system, systemFor } from './system/index.ts'
import { type Timestamp, projectRelPath } from './entity.ts'
import { type JiraError, foreignMachineReadOnly, invalidInput } from './errors.ts'
import { parseFrontmatter, renderFrontmatter, type Frontmatter } from './frontmatter.ts'
import { noIssueSubject } from './git.ts'
import { exists, listDirEntries, readText, writeTextAtomic } from './io.ts'
import { issueLockPath, lockOptionsOf, lockOwnerOf, withLock } from './lock.ts'
import { type Result, err, ok } from './result.ts'
import { type Actor, type Store, commitStoreWrite } from './store.ts'
import type { WorkspaceBinding } from './workspace.ts'

export const PROJECT_SCHEMA = 'project/v1'

/**
 * Reduce a clone URL to the part that identifies the repository.
 *
 * `git@github.com:o/r.git`, `ssh://git@GitHub.com:22/o/r.git/` and `https://u:p@github.com/o/r`
 * all become `github.com/o/r`, because they are the same remote and must compare equal.
 */
export const normalizeRemote = (url: string): string => {
  let rest = url.trim()
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//iu.exec(rest)
  if (scheme !== null) {
    rest = rest.slice(scheme[0].length)
    const at = rest.indexOf('@')
    if (at !== -1 && (rest.indexOf('/') === -1 || at < rest.indexOf('/'))) rest = rest.slice(at + 1)
  } else {
    const at = rest.indexOf('@')
    if (at !== -1) rest = rest.slice(at + 1)
    // The scp form `host:path` has no scheme; its first colon is a separator, not a port.
    rest = rest.replace(':', '/')
  }
  // Strip a port from the host part only, leaving the path alone.
  const slash = rest.indexOf('/')
  const host = slash === -1 ? rest : rest.slice(0, slash)
  const path = slash === -1 ? '' : rest.slice(slash)
  rest = `${host.replace(/:\d+$/u, '')}${path}`
  return rest.replace(/\.git$/iu, '').replace(/\/+$/u, '').toLowerCase()
}

/**
 * Decision 92: absolute, lowercase on Windows, backslashes on Windows.
 *
 * The `platform` argument decides the rules, **not the host that happens to be running**. That is
 * not a detail of the tests: the store is shared, so a `paths[]` entry written on Windows
 * (`d:\work\repo`) is read on Linux, and "is this the same path" has to be answered by the path's
 * own syntax. Resolving with the host's rules turned that entry into `<cwd>/d:\work\repo` on Linux
 * — a string that can never compare equal to anything, so a rebind or a re-bind silently stopped
 * matching (found by CI and reproduced on Fedora, 2026-10-16).
 *
 * A relative path is still made absolute against the process's working directory, because that is
 * the only base a single machine has; it just goes through the module of the platform being
 * described rather than the host's.
 */
export const normalizePath = (path: string, platform: string = system.facts.platform): string =>
  system.normalizePath(path, platform)

/** The identity remote: `upstream` > `origin` > the rest, lexicographically (decision 77). */
export const remoteIdentity = (remotes: readonly string[]): string | undefined => {
  const normalized = remotes.map(normalizeRemote).filter(remote => remote !== '')
  for (const preferred of ['upstream', 'origin']) {
    const found = normalized.find(remote => remote.split('/')[1] === preferred || remote.endsWith(`/${preferred}`))
    if (found !== undefined) return found
  }
  return [...normalized].sort()[0]
}

export type ProjectFile = Readonly<{
  key: string
  name?: string
  remotes: readonly string[]
  paths: readonly string[]
  /**
   * §4.10/§4.11: `shared` when a remote anchors the project (any machine's agent may write),
   * `owner-machine` when it does not (only humans, and only this machine's agents).
   */
  agentWritePolicy: 'shared' | 'owner-machine'
  /** Which machine owns an `owner-machine` project. */
  ownerMachine?: string
}>

/** Decision 182: the path rule lives in `entity.ts`; re-exported so project readers find it here. */
export { projectRelPath }

/** Tolerant read (decision 49's read side): a hand-edited file must not break `project list`. */
export const readProjectFile = (text: string, key: string): Result<ProjectFile, JiraError> => {
  const parsed = parseFrontmatter(text)
  if (!parsed.ok) return parsed
  const fm = parsed.value.frontmatter
  const list = (value: unknown): readonly string[] =>
    Array.isArray(value) ? Object.freeze(value.map(entry => String(entry))) : Object.freeze([])
  const name = typeof fm.name === 'string' && fm.name.trim() !== '' ? fm.name.trim() : undefined
  const remotes = list(fm.remotes)
  const policy = fm.agent_write_policy === 'shared' || fm.agent_write_policy === 'owner-machine'
    ? fm.agent_write_policy
    // A file written before this field existed: derive it the same way §4.11 does.
    : remotes.length === 0 ? 'owner-machine' : 'shared'
  const owner = typeof fm.owner_machine === 'string' && fm.owner_machine.trim() !== '' ? fm.owner_machine.trim() : undefined
  return ok(Object.freeze({
    key,
    ...(name === undefined ? {} : { name }),
    remotes,
    paths: list(fm.paths),
    agentWritePolicy: policy as 'shared' | 'owner-machine',
    ...(owner === undefined ? {} : { ownerMachine: owner }),
  }))
}

export const encodeProjectFile = (project: ProjectFile): string => {
  const frontmatter: Frontmatter = Object.freeze({
    schema: PROJECT_SCHEMA,
    type: 'project',
    // `key` is deliberately absent: it is the directory name (decisions 77/107).
    ...(project.name === undefined ? {} : { name: project.name }),
    remotes: Object.freeze([...project.remotes]),
    paths: Object.freeze([...project.paths]),
    agent_write_policy: project.agentWritePolicy,
    ...(project.ownerMachine === undefined ? {} : { owner_machine: project.ownerMachine }),
  })
  return renderFrontmatter(frontmatter, `Project ${project.key}.\n`)
}

export const listProjects = async (store: Store): Promise<Result<readonly ProjectFile[], JiraError>> => {
  const directory = join(store.files.root, 'projects')
  const listed = await listDirEntries(directory)
  if (!listed.ok) return ok(Object.freeze([]))
  const keys = listed.value
    .filter(entry => entry.isDirectory)
    .map(entry => entry.name)
    .sort()

  const projects: ProjectFile[] = []
  for (const key of keys) {
    const text = await readText(join(directory, key, 'project.md'))
    if (!text.ok) {
      projects.push(unreadableProject(key, store.machineId))
      continue
    }
    const decoded = readProjectFile(text.value, key)
    projects.push(decoded.ok ? decoded.value : unreadableProject(key, store.machineId))
  }
  return ok(Object.freeze(projects))
}

/**
 * A project whose `project.md` cannot be read is treated as this machine's own: refusing writes
 * because a file is unreadable would be worse than allowing them, and the doctor reports the file.
 */
const unreadableProject = (key: string, machineId: string): ProjectFile => Object.freeze({
  key,
  remotes: Object.freeze([]),
  paths: Object.freeze([]),
  agentWritePolicy: 'owner-machine' as const,
  ownerMachine: machineId,
})

const writeProjectFile = async (store: Store, actor: Actor, project: ProjectFile): Promise<Result<ProjectFile, JiraError>> => {
  const path = projectRelPath(project.key)
  return withLock(issueLockPath(store.files.root, project.key), lockOwnerOf(store, actor.at), lockOptionsOf(store), async () => {
    const written = await writeTextAtomic(join(store.files.root, ...path.split('/')), encodeProjectFile(project))
    if (!written.ok) return written
    const commit = await commitStoreWrite(store, actor.at as Timestamp, [path], noIssueSubject('project '))
    if (!commit.ok) return commit
    return ok(project)
  })
}

export const readProject = async (store: Store, key: string): Promise<Result<ProjectFile, JiraError>> => {
  const text = await readText(join(store.files.root, ...projectRelPath(key).split('/')))
  if (!text.ok) return ok(unreadableProject(key, store.machineId))
  return readProjectFile(text.value, key)
}

/** Record a checkout (and optionally remotes) for a project. Idempotent: the same path is not added twice. */
/**
 * Decision 194 (trial feedback P1-3): `KB` is the **knowledge** key space, so a *new* project may not
 * claim it — `KB-12` would then be two different things depending on who is reading.
 *
 * The rule is "do not **create** a project named KB", not "KB does not exist": a ledger that already has
 * one (this one does) keeps working, because refusing retroactively would turn existing data into errors.
 */
export const RESERVED_PROJECT_KEYS: readonly string[] = Object.freeze(['KB'])

export const assertProjectNameFree = async (
  store: Store,
  project: string,
): Promise<Result<undefined, JiraError>> => {
  if (!RESERVED_PROJECT_KEYS.includes(project)) return ok(undefined)
  // Through `io` like every other existence check (decision 180) — a bare `access` here is how the
  // side-effect boundary regressed once, and the checker now refuses it.
  const alreadyThere = await exists(join(store.files.root, 'projects', project))
  if (alreadyThere) return ok(undefined)
  return err(invalidInput(
    `a project cannot be named "${project}": that is the knowledge key space, so ${project}-12 would be `
    + 'both a knowledge entry and an issue (decision 194)',
    { project, reserved: Object.freeze([...RESERVED_PROJECT_KEYS]) },
  ))
}

export const bindProject = async (
  store: Store,
  actor: Actor,
  input: Readonly<{ key: string; path?: string; remotes?: readonly string[]; name?: string; platform?: string }>,
): Promise<Result<Readonly<{ project: ProjectFile; addedPath: boolean }>, JiraError>> => {
  if (!/^[A-Z][A-Z0-9]{1,5}$/u.test(input.key)) {
    return err(invalidInput(`"${input.key}" is not a project key`, { key: input.key }))
  }
  // Decision 194: a *new* project cannot take the knowledge key space (an existing one is left alone).
  const free = await assertProjectNameFree(store, input.key)
  if (!free.ok) return free
  const current = await readProject(store, input.key)
  if (!current.ok) return current

  const remotes = [...new Set([...current.value.remotes.map(normalizeRemote), ...(input.remotes ?? []).map(normalizeRemote)].filter(remote => remote !== ''))].sort()
  const sys = systemFor(input.platform)
  const normalizedPath = input.path === undefined ? undefined : sys.normalizePath(input.path)
  // Decision 152: the comparison is the **platform's**, not string equality. A path recorded on Windows
  // as d:\\work\\repo and the same checkout spelled D:/Work/Repo are one working copy there, and two
  // different directories on POSIX — system.samePath is the single place that knows which.
  const alreadyListed = normalizedPath !== undefined && current.value.paths.some(entry => sys.samePath(entry, normalizedPath))
  const paths = normalizedPath === undefined || alreadyListed
    ? current.value.paths
    : [...current.value.paths, normalizedPath].sort()

  const project: ProjectFile = Object.freeze({
    key: input.key,
    ...(input.name === undefined ? (current.value.name === undefined ? {} : { name: current.value.name }) : { name: input.name }),
    remotes: Object.freeze(remotes),
    paths: Object.freeze(paths),
    // §4.11: a remote is what makes a project writable from other machines.
    agentWritePolicy: remotes.length === 0 ? 'owner-machine' as const : 'shared' as const,
    ...(remotes.length === 0 ? { ownerMachine: store.machineId } : {}),
  })
  const written = await writeProjectFile(store, actor, project)
  if (!written.ok) return written
  return ok(Object.freeze({ project: written.value, addedPath: normalizedPath !== undefined && !alreadyListed }))
}

/**
 * Move a checkout from one project to another (decision 92). Only `paths[]` changes — no issue
 * data is touched, because a path is a cache and the issues were never keyed by it.
 */
export const rebindProject = async (
  store: Store,
  actor: Actor,
  input: Readonly<{ from: string; to: string; path: string; platform?: string }>,
): Promise<Result<Readonly<{ from: ProjectFile; to: ProjectFile; moved: boolean }>, JiraError>> => {
  if (input.from === input.to) return err(invalidInput('rebind needs two different projects', { from: input.from, to: input.to }))
  const sys = systemFor(input.platform)
  const path = sys.normalizePath(input.path)

  const source = await readProject(store, input.from)
  if (!source.ok) return source
  const moved = source.value.paths.some(entry => sys.samePath(entry, path))
  const sourceNext: ProjectFile = Object.freeze({
    ...source.value,
    paths: Object.freeze(source.value.paths.filter(entry => !sys.samePath(entry, path))),
  })
  const sourceWritten = await writeProjectFile(store, actor, sourceNext)
  if (!sourceWritten.ok) return sourceWritten

  const bound = await bindProject(store, actor, {
    key: input.to,
    path,
    ...(input.platform === undefined ? {} : { platform: input.platform }),
  })
  if (!bound.ok) return bound
  return ok(Object.freeze({ from: sourceWritten.value, to: bound.value.project, moved }))
}

export const renderProjects = (projects: readonly ProjectFile[], cwd: string, platform: string = system.facts.platform): string => {
  const sys = systemFor(platform)
  if (projects.length === 0) return '还没有项目\n'
  const here = sys.normalizePath(cwd)
  return `${projects.map((project) => {
    const identity = remoteIdentity(project.remotes)
    const mark = project.paths.some(entry => sys.samePath(entry, here)) ? '*' : ' '
    return [
      `${mark} ${project.key}${project.name === undefined ? '' : `  ${project.name}`}`,
      `    身份：${identity ?? '（无 remote）'}`,
      ...(project.remotes.length <= 1 ? [] : [`    remotes:  ${project.remotes.join(', ')}`]),
      ...(project.paths.length === 0 ? [] : [`    paths:    ${project.paths.join(', ')}`]),
    ].join('\n')
  }).join('\n')}\n`
}

/** Exported so the first-write registration (decision 133) can create a project file. */
export const writeProject = writeProjectFile

export type RegisteredProject = Readonly<{ key: string; registered: boolean; project: ProjectFile }>

/**
 * §4.10 step 4, the missing half: a **write** from a checkout whose project is unknown registers it —
 * the derived key, the normalized remote, this working copy in `paths[]`, and the policy that says
 * whether other machines may write it. Reading a session never does this (decision 38); only a write.
 *
 * A key collision appends digits (`dsh-jira` → `DJ`, then `DJ2`), because two repositories really can
 * derive the same initials.
 * @param store - the ledger store the project is registered in.
 * @param actor - the identity and timestamp recorded on the project file.
 * @param binding - the resolved checkout: its key, derived key, remote, and working directory.
 * @param machineId - this machine's identity, recorded when the project has no remote.
 * @returns the registered project (or the existing binding), or the write failure.
 */
export const ensureWorkspaceProject = async (
  store: Store,
  actor: Actor,
  binding: WorkspaceBinding,
  machineId: string,
): Promise<Result<RegisteredProject, JiraError>> => {
  if (binding.project !== undefined) {
    const existing = await readProject(store, binding.project)
    if (!existing.ok) return existing
    return ok(Object.freeze({ key: binding.project, registered: false, project: existing.value }))
  }

  const listed = await listProjects(store)
  if (!listed.ok) return listed
  const taken = new Set(listed.value.map(project => project.key))
  const base = binding.derivedKey ?? deriveKey(binding.cwd)
  let key = base
  let suffix = 2
  while (taken.has(key)) {
    const digits = String(suffix)
    key = `${base.slice(0, Math.max(1, 6 - digits.length))}${digits}`
    suffix += 1
    if (suffix > 99) return err(invalidInput(`cannot derive a free project key from "${base}"`, { base }))
  }

  const hasRemote = binding.remote !== undefined && binding.remote !== ''
  const project: ProjectFile = Object.freeze({
    key,
    remotes: Object.freeze(hasRemote ? [normalizeRemote(binding.remote as string)] : []),
    paths: Object.freeze([normalizePath(binding.cwd)]),
    agentWritePolicy: hasRemote ? 'shared' as const : 'owner-machine' as const,
    ...(hasRemote ? {} : { ownerMachine: machineId }),
  })
  const written = await writeProjectFile(store, actor, project)
  if (!written.ok) return written
  return ok(Object.freeze({ key, registered: true, project: written.value }))
}

/**
 * §4.11's interception, the piece that was computed but never consumed: a project with no remote is
 * anchored to one machine, so **other machines' agents** may not write it. Humans still may, and this
 * machine's own agents always may — the rule is about the tuple, not about distrust.
 * @param store - the ledger store that carries the project file.
 * @param projectKey - the project whose write policy is checked.
 * @param by - the acting identity; `agent:` identities are the ones the policy can refuse.
 * @returns success, or the refusal that names the owning machine.
 */
export const assertProjectWritable = async (
  store: Store,
  projectKey: string,
  by: string,
): Promise<Result<void, JiraError>> => {
  const project = await readProject(store, projectKey)
  if (!project.ok) return project
  if (project.value.agentWritePolicy !== 'owner-machine') return ok(undefined)
  const owner = project.value.ownerMachine
  if (owner !== undefined && owner !== store.machineId && by.startsWith('agent:')) {
    return err(foreignMachineReadOnly(projectKey, owner))
  }
  return ok(undefined)
}

export const deriveKey = (repository: string): string => {
  const words = basename(repository).split(/[^A-Za-z0-9]+/u).filter(word => word !== '')
  const initials = words.map(word => (word[0] ?? '').toUpperCase()).join('').replace(/^[^A-Z]+/u, '')
  // A key is `[A-Z][A-Z0-9]{1,5}`: at least two characters, starting with a letter. A single word
  // gives one initial, so take its first two letters rather than inventing a suffix.
  const key = initials.length >= 2
    ? initials
    : words.join('').toUpperCase().replace(/^[^A-Z]+/u, '').slice(0, 2)
  const cleaned = key.replace(/[^A-Z0-9]/gu, '').slice(0, 6)
  if (!/^[A-Z]/u.test(cleaned)) return 'WS'
  return cleaned.length >= 2 ? cleaned : `${cleaned}X`
}
