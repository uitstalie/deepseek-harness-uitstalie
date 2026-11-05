/**
 * The writable-root derivation shared by every enforcement dialect that
 * expresses a mode as a canonical allow-list: `workspace-write` means "the
 * workspace root, explicit extra directories, and platform temp areas", and this module is that
 * meaning's one home. The Seatbelt profile
 * (`@deepseek-ai/dsh-sandbox-local`) and the in-process filesystem fence
 * (`@deepseek-ai/dsh-fs-sandbox`) both derive their allow-list here, so "the
 * write tool cannot write /tmp but bash can" asymmetries cannot arise between
 * them. The bwrap and Landlock dialects keep their own grant spellings (an
 * ephemeral `/tmp` mount, launcher-owned flags) — the honest per-runner
 * differences recorded in the sandbox RFC — with parity pinned by test.
 *
 * @module dsh-sandbox/roots
 */

import { realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, relative, resolve } from 'node:path'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { SandboxExecutionPolicy } from './index.ts'

/** An explicit directory grant cannot be enforced without changing the caller's selected path. */
export class SandboxInvalidRootError extends HarnessError {
  constructor(path: string, detail: string) {
    super(`Invalid additional writable directory ${JSON.stringify(path)}: ${detail}`, 'SANDBOX_INVALID_ROOT')
    this.name = 'SandboxInvalidRootError'
  }
}

/** Reject mutable path aliases before they can redirect an explicit grant. */
function additionalRoot(path: string): string {
  let physical: string
  let directory: boolean
  try {
    physical = realpathSync.native(path)
    directory = statSync(physical).isDirectory()
  } catch (error) {
    throw new SandboxInvalidRootError(path, `cannot read the directory: ${String(error)}`)
  }
  if (!directory) throw new SandboxInvalidRootError(path, 'expected an existing directory')
  if (physical !== resolve(path)) {
    throw new SandboxInvalidRootError(path, `use the physical directory path ${JSON.stringify(physical)}; symlinked grants are not supported`)
  }
  return physical
}

/**
 * Resolve a granted root to the path the enforcement layer actually compares:
 * canonical (symlinks resolved), because both Seatbelt filters and the fs
 * fence's containment check match resolved paths — `/tmp` IS `/private/tmp`
 * on darwin, and an as-spelled grant would match nothing.
 * @param path - the root as configured or platform-reported.
 * @returns the canonical path, or the spelling as-is when resolution fails
 *   (a missing root matches nothing until it exists — the conservative
 *   outcome; inventing a fallback would grant a path the caller never named).
 */
export function canonicalPath(path: string): string {
  try {
    // Node's JavaScript realpath implementation lexically collapses `..`
    // before resolving a preceding symlink on some platforms. The native
    // implementation follows the filesystem's component-by-component lookup,
    // matching chdir/spawn and the enforcement layers this identity feeds.
    return realpathSync.native(path)
  } catch {
    // realpathSync.native failed: the path (or a prefix) is missing or unreadable.
    return path
  }
}

/**
 * The workspace-owned writable roots — the policy's workspace root plus its
 * explicit extra directories, as a canonical, deduplicated allow-list. Both
 * the workspace and every extra root must be granted together by every
 * backend; this is the one derivation of that set, kept separate from the
 * platform temp policy each backend documents for itself (Seatbelt and the fs
 * fence use {@link writableRoots}; bwrap and Landlock add their own temp
 * grants).
 * @param policy - the file-effect policy to derive the allow-list from.
 * @returns the canonical workspace-owned roots; empty under `read-only`.
 * @throws {SandboxInvalidRootError} An extra root is missing, is not a directory, or uses a symlink.
 */
export function workspaceWritableRoots(policy: SandboxExecutionPolicy): string[] {
  if (policy.mode !== 'workspace-write') return []
  return [...new Set([canonicalPath(policy.workspaceRoot), ...(policy.additionalWritableRoots ?? []).map(additionalRoot)])]
}

/**
 * The roots one confined execution may WRITE under — the mode's meaning as a
 * canonical, deduplicated allow-list. `read-only` allows nothing;
 * `workspace-write` allows the policy's workspace root, its explicit extra
 * directories, the host `/tmp`, and the per-user platform temp dir
 * (`os.tmpdir()` — the real temp area for mkstemp-family tools; omitting it
 * would deny what the mode promises).
 * @param policy - the file-effect policy to derive the allow-list from.
 * @returns the canonical writable roots; empty exactly under `read-only`.
 */
export function writableRoots(policy: SandboxExecutionPolicy): string[] {
  if (policy.mode !== 'workspace-write') return []
  return [...new Set([...workspaceWritableRoots(policy), canonicalPath('/tmp'), canonicalPath(tmpdir())])]
}

/**
 * Validate one filesystem-fence-only grant. Unlike an explicit extra root, an
 * unusable entry must not fail the whole policy (a registered workspace can be
 * removed at any time), so this returns `undefined` instead of throwing: the
 * fence then simply does not grant that path. Symlinked spellings are refused
 * for the same reason `additionalRoot` refuses them — a grant must name the
 * physical directory it was meant to cover.
 * @param path - the candidate directory as the provider supplied it.
 * @returns the canonical physical path, or `undefined` when it cannot be granted.
 */
function fsAdditionalRoot(path: string): string | undefined {
  if (!isAbsolute(path) || path.includes('\0')) return undefined
  try {
    const physical = realpathSync.native(path)
    if (!statSync(physical).isDirectory()) return undefined
    return physical === resolve(path) ? physical : undefined
  } catch {
    return undefined
  }
}

/**
 * The roots the in-process filesystem fence may WRITE under: the ordinary
 * `workspace-write` allow-list plus the policy's filesystem-only extra grants.
 * Shell and terminal backends keep using {@link writableRoots}, so a
 * capability can hand files to a directory without widening process
 * confinement. Unusable fs grants are skipped; `read-only` grants nothing.
 * @param policy - the file-effect policy to derive the fence's allow-list from.
 * @returns the canonical, deduplicated roots.
 */
export function fsWritableRoots(policy: SandboxExecutionPolicy): string[] {
  if (policy.mode !== 'workspace-write') return []
  const extra = (policy.fsAdditionalWritableRoots ?? [])
    .map(fsAdditionalRoot)
    .filter((root): root is string => root !== undefined)
  return [...new Set([...writableRoots(policy), ...extra])]
}

/** Whether `candidate` is the same as or below `root` (canonical inputs). */
export function isWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * The writable roots of `home-write`: the home itself plus its configured temp
 * exceptions. The workspace root is deliberately not included; a workspace
 * outside home is read-only under this mode.
 * @param policy - the file-effect policy to derive the roots from.
 * @returns canonical writable roots; empty outside `home-write`.
 */
export function homeWriteWritableRoots(policy: SandboxExecutionPolicy): string[] {
  if (policy.mode !== 'home-write' || policy.homeWriteRoot === undefined) return []
  return [...new Set([canonicalPath(policy.homeWriteRoot), ...(policy.homeWriteTempRoots ?? []).map(canonicalPath)])]
}

/**
 * The force-read-only roots of `home-write`, canonical and deduplicated.
 * @param policy - the file-effect policy to derive the roots from.
 * @returns canonical read-only roots; empty outside `home-write`.
 */
export function homeWriteReadOnlyRoots(policy: SandboxExecutionPolicy): string[] {
  if (policy.mode !== 'home-write') return []
  return [...new Set((policy.homeWriteReadOnlyRoots ?? []).map(canonicalPath))]
}

/**
 * The exact home-write priority decision for one already-canonical path:
 * force-read-only wins, then home/temp, else denied.
 * @param policy - the file-effect policy.
 * @param target - canonical target path.
 * @returns whether the path may be written under `home-write`.
 */
export function isHomeWriteAllowed(policy: SandboxExecutionPolicy, target: string): boolean {
  const denied = homeWriteReadOnlyRoots(policy).some(root => isWithinRoot(root, target))
  if (denied) return false
  return homeWriteWritableRoots(policy).some(root => isWithinRoot(root, target))
}
