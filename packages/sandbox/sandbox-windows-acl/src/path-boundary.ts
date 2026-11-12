/**
 * Canonical directory-boundary checks for the Windows ACL workspace and
 * private-temp capabilities.
 * @module @deepseek-ai/dsh-sandbox-windows-acl/path-boundary
 */

import { realpathSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'

/** Whether `root` is the same canonical directory as `candidate` or contains it. */
function containsDirectory(root: string, candidate: string): boolean {
  const relation = relative(realpathSync.native(root), realpathSync.native(candidate))
  return relation === '' || (!isAbsolute(relation) && relation !== '..' && !relation.startsWith(`..${sep}`))
}

/**
 * Whether a temp parent is inside the workspace, where every child created
 * below it would inherit the standing workspace capability.
 * @param workspaceRoot - the canonical workspace root that receives the standing ACE.
 * @param tempRoot - the existing parent beneath which a private temp child would be created.
 * @returns whether the canonical workspace contains the canonical temp root.
 * @throws the filesystem error when either directory cannot be resolved.
 */
export function isTempRootInsideWorkspace(workspaceRoot: string, tempRoot: string): boolean {
  return containsDirectory(workspaceRoot, tempRoot)
}

/**
 * Reject a temp parent that is inside the workspace (see {@link isTempRootInsideWorkspace}).
 * @param workspaceRoot - the canonical workspace root that receives the standing ACE.
 * @param tempRoot - the existing parent beneath which a private temp child would be created.
 */
export function assertTempRootOutsideWorkspace(workspaceRoot: string, tempRoot: string): void {
  if (isTempRootInsideWorkspace(workspaceRoot, tempRoot)) {
    throw new Error(`Windows ACL temp root must be outside the workspace: workspace=${workspaceRoot}; temp=${tempRoot}`)
  }
}

/**
 * Reject overlap between an actual private temp directory and any writable
 * directory: either inheritance direction would merge the two capabilities.
 * @param writableDirs - directories carrying the standing workspace capability.
 * @param tempDir - the existing directory carrying the revocable temp capability.
 */
export function assertPrivateTempDisjoint(writableDirs: readonly string[], tempDir: string): void {
  for (const writableDir of writableDirs) {
    if (containsDirectory(writableDir, tempDir) || containsDirectory(tempDir, writableDir)) {
      throw new Error(`AclSandbox private temp directory must be disjoint from writable directories: writable=${writableDir}; temp=${tempDir}`)
    }
  }
}

/**
 * Assert the counterpart of {@link assertPrivateTempDisjoint} for a caller that
 * deliberately places the private temp inside an already-granted writable root
 * (`home-write`, whose roots include the whole user home). There the enclosing
 * grant already confers every right the temp capability would add, so nesting
 * merges no authority; the check only keeps the exemption honest by requiring
 * the nesting to actually exist.
 * @param writableDirs - directories carrying the standing capability.
 * @param tempDir - the private temp directory that must sit inside one of them.
 */
export function assertPrivateTempInsideWritable(writableDirs: readonly string[], tempDir: string): void {
  if (!writableDirs.some(writableDir => containsDirectory(writableDir, tempDir))) {
    throw new Error(`AclSandbox private temp directory was declared inside a writable directory but is not: writable=${writableDirs.join(', ')}; temp=${tempDir}`)
  }
}
