/**
 * Cross-workspace conventions for the super agent.
 *
 * A registered workspace owns its dispatch conventions: it may declare them in the
 * `<!-- superagent:conventions begin/end -->` section of its own `AGENTS.md`. The super agent
 * reads that section into its runtime context and cites it in a brief; it never writes it. The
 * renderer is deterministic (sorted by workspace id, content capped) and reads from disk only when
 * a file's mtime/size changed, so an unchanged set renders byte for byte and appends no snapshot.
 *
 * @module @deepseek-ai/dsh-jira-agent/workspace-conventions
 */

import { readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { WorkspaceRegistryLike } from './superagent.ts'

/** Opening marker a workspace puts in its own `AGENTS.md`. */
export const WORKSPACE_CONVENTIONS_BEGIN = '<!-- superagent:conventions begin -->'

/** Closing marker for the same section. */
export const WORKSPACE_CONVENTIONS_END = '<!-- superagent:conventions end -->'

/** Longest conventions excerpt injected for one workspace. */
export const CONVENTIONS_PER_WORKSPACE_MAX = 1000

/** Most workspaces with conventions rendered in one snapshot. */
export const CONVENTIONS_MAX_WORKSPACES = 6

/** One cached extraction, stamped by the file's stat facts. */
interface CachedConventions {
  readonly stamp: string
  readonly text: string
}

/** Process-local cache keyed by absolute `AGENTS.md` path. */
const cache = new Map<string, CachedConventions>()

/**
 * Whether two absolute paths name the same directory on this platform.
 * @param left - one path.
 * @param right - the other path.
 * @returns whether they compare equal under the filesystem's casing.
 */
const samePath = (left: string, right: string): boolean => process.platform === 'win32'
  ? left.toLowerCase() === right.toLowerCase()
  : left === right

/**
 * Read one workspace's conventions section, reusing the last extraction while the file is unchanged.
 * @param workspacePath - the registered workspace directory.
 * @returns the trimmed section, or undefined when the file or section is absent.
 */
const conventionsOf = (workspacePath: string): string | undefined => {
  const file = join(workspacePath, 'AGENTS.md')
  let stamp: string
  try {
    const stat = statSync(file)
    stamp = `${String(stat.mtimeMs)}:${String(stat.size)}`
  } catch {
    cache.delete(file)
    return undefined
  }
  const cached = cache.get(file)
  if (cached?.stamp === stamp) return cached.text === '' ? undefined : cached.text
  let content: string
  try {
    content = readFileSync(file, 'utf8')
  } catch {
    cache.delete(file)
    return undefined
  }
  const start = content.indexOf(WORKSPACE_CONVENTIONS_BEGIN)
  const end = start < 0 ? -1 : content.indexOf(WORKSPACE_CONVENTIONS_END, start + WORKSPACE_CONVENTIONS_BEGIN.length)
  let text = start < 0 || end < 0
    ? ''
    : content.slice(start + WORKSPACE_CONVENTIONS_BEGIN.length, end).replaceAll('\r\n', '\n').trim()
  if (text.length > CONVENTIONS_PER_WORKSPACE_MAX) {
    text = `${text.slice(0, CONVENTIONS_PER_WORKSPACE_MAX - 1)}…`
  }
  cache.set(file, { stamp, text })
  return text === '' ? undefined : text
}

/**
 * Render every registered workspace's declared conventions, sorted by workspace id.
 *
 * Empty when there is no super home, no registry, or no workspace declares a section, so an empty
 * contribution adds no runtime-context snapshot. The super workspace's own file is skipped: its
 * standing policy is already read by the native instruction loader for that session.
 * @param registry - the host workspace registry.
 * @param superHome - the configured super workspace path.
 * @returns the context text, or `''` when nothing is declared.
 */
export const workspaceConventionsText = (
  registry: WorkspaceRegistryLike | undefined,
  superHome: string | undefined,
): string => {
  if (superHome === undefined || superHome.trim() === '' || registry === undefined) return ''
  const home = resolve(superHome)
  const rows = [...registry.list()]
    .filter(workspace => !samePath(resolve(workspace.path), home))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const rendered: string[] = []
  let omitted = 0
  for (const workspace of rows) {
    const text = conventionsOf(workspace.path)
    if (text === undefined) continue
    if (rendered.length >= CONVENTIONS_MAX_WORKSPACES) {
      omitted += 1
      continue
    }
    const file = `${join(workspace.path, 'AGENTS.md')}#superagent:conventions`
    const body = text.split('\n').map(line => `    ${line}`).join('\n')
    rendered.push(`  ${workspace.id} · ${workspace.title} — ${file}\n${body}`)
  }
  if (rendered.length === 0) return ''
  return '[superagent workspace conventions] read-only; cite the file and section when used\n'
    + rendered.join('\n')
    + (omitted === 0 ? '' : `\n  … ${String(omitted)} more workspace(s) with conventions omitted`)
}

/**
 * Drop the process-local extraction cache; tests and a workspace remount use this to start clean.
 * @returns nothing.
 */
export const clearWorkspaceConventionsCache = (): void => {
  cache.clear()
}
