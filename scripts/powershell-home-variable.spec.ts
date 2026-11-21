import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { expect, it } from 'vitest'

/** Directories that never carry repository scripts. */
const SKIP = new Set(['node_modules', 'vendor', 'dist', 'lib', 'out', '.git', '.desktop-build', 'dsh-backups'])

/** Gather every PowerShell and cmd script below one directory. */
function scripts(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    if (SKIP.has(entry)) continue
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) scripts(path, found)
    else if (/\.(?:ps1|psm1|cmd|bat)$/iu.test(entry)) found.push(path)
  }
  return found
}

it('never assigns the read-only $home automatic variable in shell scripts', () => {
  const root = join(import.meta.dirname, '..')
  const offenders: string[] = []
  for (const path of scripts(root)) {
    const text = readFileSync(path, 'utf8')
    // `$home` is PowerShell's read-only profile path: an assignment fails silently and every derived home path
    // then lands in the user profile instead of the intended Harness home.
    if (/^\s*\$home\s*=/imu.test(text)) offenders.push(relative(root, path))
  }
  expect(offenders).toEqual([])
})
