/**
 * Internal platform-profile builders for the local sandbox provider.
 *
 * @module @deepseek-ai/dsh-sandbox-local/profiles
 */

import { grantArgs as landlockGrantArgs } from '@deepseek-ai/node-addon-system/landlock-run'
import { existsSync } from 'node:fs'
import { SandboxUnsupportedPolicyError, homeWriteReadOnlyRoots, homeWriteWritableRoots, workspaceWritableRoots, writableRoots } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'

/**
 * Build the bwrap profile arguments for one file-effect policy.
 * @param policy - file-effect policy to express as bwrap mounts.
 * @returns profile arguments before the trailing separator and command argv.
 */
export function bwrapProfileArgs(policy: SandboxPolicy): string[] {
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']
  if (policy.mode === 'workspace-write') {
    args.push('--tmpfs', '/tmp')
    for (const root of workspaceWritableRoots(policy)) args.push('--bind', root, root)
  }
  if (policy.mode === 'home-write') {
    // Every writable root (home, non-system drives on Windows, the session
    // workspace, temp exceptions) is bound read-write, then each exclusion is
    // rebound read-only: a later bind on a child wins over its parent mount.
    for (const root of homeWriteWritableRoots(policy)) {
      if (existsSync(root)) args.push('--bind', root, root)
    }
    for (const root of homeWriteReadOnlyRoots(policy)) {
      if (existsSync(root)) args.push('--ro-bind', root, root)
    }
  }
  return args
}

/**
 * Build the Landlock launcher grants for one file-effect policy.
 * @param policy - file-effect policy to express as Landlock allow-list grants.
 * @returns launcher grant arguments before the trailing separator and command argv.
 */
export function landlockProfileArgs(policy: SandboxPolicy): string[] {
  const readWrite = ['/dev/null']
  if (policy.mode === 'workspace-write') {
    readWrite.push('/tmp', ...workspaceWritableRoots(policy))
  }
  if (policy.mode === 'home-write') {
    if (homeWriteReadOnlyRoots(policy).length > 0) {
      throw new SandboxUnsupportedPolicyError(
        'Landlock cannot express excludePaths inside a writable root: its allow-list has no deny rules. Use bubblewrap or remove the exclusions.',
      )
    }
    readWrite.push(...homeWriteWritableRoots(policy))
  }
  return landlockGrantArgs({ readOnly: ['/'], readWrite })
}

/** Quote one path as an SBPL string literal. */
function sbplString(path: string): string {
  return `"${path.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`
}

/**
 * Build the sandbox-exec arguments and SBPL profile for one policy. The
 * workspace-owned writable roots (workspace plus explicit extra directories)
 * come from the shared {@link writableRoots} helper (canonical, deduplicated)
 * so the Seatbelt grant and the in-process fs fence
 * (`@deepseek-ai/dsh-fs-sandbox`) can never drift apart; the helper adds the
 * documented Seatbelt temp areas.
 * @param policy - file-effect policy to express as an SBPL profile.
 * @returns sandbox-exec arguments before the trailing separator and command argv.
 */
export function seatbeltProfileArgs(policy: SandboxPolicy): string[] {
  const forms = ['(version 1)', '(allow default)', '(deny file-write*)', `(allow file-write* (literal ${sbplString('/dev/null')}))`]
  const roots = policy.mode === 'home-write' ? homeWriteWritableRoots(policy) : writableRoots(policy)
  if (roots.length > 0) {
    forms.push(`(allow file-write* ${roots.map(root => `(subpath ${sbplString(root)})`).join(' ')})`)
  }
  if (policy.mode === 'home-write') {
    const excluded = homeWriteReadOnlyRoots(policy)
    if (excluded.length > 0) {
      forms.push(`(deny file-write* ${excluded.map(root => `(subpath ${sbplString(root)})`).join(' ')})`)
    }
  }
  return ['-p', forms.join(' ')]
}
