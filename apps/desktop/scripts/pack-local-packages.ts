/** Stage local-branded DSH packages for unsigned Desktop builds without a publication record. */

import { execFileSync } from 'node:child_process'
import { globSync, readFileSync } from 'node:fs'
import { dirname, resolve, win32 } from 'node:path'
import { parseArgs } from 'node:util'
import {
  readClientBuildRecord,
  repositoryClientBuildEnvironment,
  resolveClientBuildEnvironment,
} from '../../../scripts/client-build-environment.ts'
import { releaseFamily } from '../../../scripts/release/families.ts'
import { packFamilyMembers, parsePackConcurrency } from '../../../scripts/release/pack.ts'
import { pnpmInvocation } from '../../../scripts/pnpm-invocation.ts'

/**
 * Resolve one `packages/<group>/<pkg>/package.json` path to its package directory.
 *
 * `fs.globSync` reports the separators of the running host, so stripping only a
 * POSIX `/package.json` leaves the manifest filename on Windows and pnpm then
 * rejects the file as an importer. Relative input resolves against `root` after
 * separator normalization; Windows drive-letter and UNC input keeps Windows
 * path semantics on any host so the staging arguments stay platform-independent.
 * @param root - repository root relative input resolves against.
 * @param manifestPath - manifest path reported by the glob.
 * @returns the package directory.
 */
export function packageDirectory(root: string, manifestPath: string): string {
  if (/^(?:[A-Za-z]:[\\/]|\\\\)/u.test(manifestPath)) return win32.dirname(manifestPath)
  return dirname(resolve(root, manifestPath.replaceAll('\\', '/')))
}

/**
 * Build the pnpm arguments that pack one private package from its directory.
 * @param root - repository root.
 * @param manifestPath - the package's manifest path.
 * @param destination - tarball staging directory.
 * @returns pnpm `pack` arguments naming the package directory, never the manifest file.
 */
export function privatePackArguments(root: string, manifestPath: string, destination: string): readonly string[] {
  return ['--dir', packageDirectory(root, manifestPath), 'pack', '--pack-destination', destination]
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { out: { type: 'string' }, concurrency: { type: 'string' } },
    allowPositionals: false,
  })
  if (values.out === undefined) throw new Error('desktop local pack: --out must name the package staging directory')
  const concurrency = parsePackConcurrency(values.concurrency)
  const root = process.cwd()
  const environment = resolveClientBuildEnvironment(repositoryClientBuildEnvironment(root), 'local')
  readClientBuildRecord(root, environment)
  const destination = resolve(root, values.out)
  const packed = await packFamilyMembers(root, releaseFamily('dsh'), destination, concurrency, { verifyVersions: false, validateManifests: false })
  // Private branch packages (the uitstalie layer) are outside the publish family but are real runtime
  // dependencies of the bundles; local staging packs them beside the public tarballs.
  const privateManifests = globSync('packages/*/*/package.json', { cwd: root })
    .map(path => ({ path, manifest: JSON.parse(readFileSync(resolve(root, path), 'utf8')) as { name?: string; version?: string; private?: boolean } }))
    .filter(entry => entry.manifest.private === true && entry.manifest.name?.startsWith('@deepseek-ai/') === true && typeof entry.manifest.version === 'string')
  for (const entry of privateManifests) {
    const invocation = pnpmInvocation(privatePackArguments(root, entry.path, destination))
    execFileSync(invocation.command, invocation.args, { cwd: root, stdio: 'inherit' })
  }
  console.log(`desktop local pack: ${String(packed.length)} public and ${String(privateManifests.length)} private tarball(s) in ${destination}`)
}

if (import.meta.main) await main()
