/** Stage local-branded DSH packages for unsigned Desktop builds without a publication record. */

import { execFileSync } from 'node:child_process'
import { globSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  readClientBuildRecord,
  repositoryClientBuildEnvironment,
  resolveClientBuildEnvironment,
} from '../../../scripts/client-build-environment.ts'
import { releaseFamily } from '../../../scripts/release/families.ts'
import { packFamilyMembers, parsePackConcurrency } from '../../../scripts/release/pack.ts'
import { pnpmInvocation } from '../../../scripts/pnpm-invocation.ts'

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
    const invocation = pnpmInvocation(['--dir', entry.path.replace(/\/package\.json$/u, ''), 'pack', '--pack-destination', destination])
    execFileSync(invocation.command, invocation.args, { cwd: root, stdio: 'inherit' })
  }
  console.log(`desktop local pack: ${String(packed.length)} public and ${String(privateManifests.length)} private tarball(s) in ${destination}`)
}

await main()
