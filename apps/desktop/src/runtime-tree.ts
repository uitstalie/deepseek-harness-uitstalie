/** Relocatable, integrity-recorded production packages carried by one Desktop release. */

import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFile, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { valid } from 'semver'
import { DESKTOP_HOST_PACKAGE } from './core-package-set.ts'
import { parseDesktopRelease, type DesktopRelease } from './release.ts'

/** Descriptor at the root of the immutable Desktop resource tree. */
export const DESKTOP_RUNTIME_FILE = 'desktop-runtime.json'

/** Host-owned package available to external plugins through a directory link. */
export interface DesktopSharedPackage {
  readonly name: string
  readonly version: string
  readonly path: string
}

/** Final bytes and executable permissions of a runtime file. */
export interface DesktopRuntimeFile {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
  readonly executable: boolean
}

/** One signed application's production dependency tree. */
export interface DesktopRuntimeDescriptor {
  readonly schemaVersion: 1
  readonly release: DesktopRelease
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly sharedPackages: readonly DesktopSharedPackage[]
  readonly files: readonly DesktopRuntimeFile[]
}

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/u
const readRuntimeFile = promisify(readFile)

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Resolve one portable resource path without permitting traversal or absolute paths.
 * @param root - Runtime root.
 * @param path - Slash-separated relative path from durable metadata.
 * @returns Absolute resource path.
 */
export function runtimePath(root: string, path: string): string {
  if (path === '' || isAbsolute(path) || path.includes('\\') || path.includes(':')
    || path.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new Error(`desktop runtime: invalid relative path ${JSON.stringify(path)}`)
  }
  return join(root, ...path.split('/'))
}

function runtimeFiles(root: string): { path: string; name: string }[] {
  const files: { path: string; name: string }[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const name = relative(root, path).split(sep).join('/')
      if (name === DESKTOP_RUNTIME_FILE) continue
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) files.push({ path, name })
      else throw new Error(`desktop runtime: unsupported filesystem entry ${name}`)
    }
  }
  visit(root)
  return files
}

function runtimeFile(path: string, name: string, body: Buffer): DesktopRuntimeFile {
  return { path: name, bytes: body.byteLength, sha256: createHash('sha256').update(body).digest('hex'),
    // Windows has no portable Unix executable permission bits.
    executable: process.platform !== 'win32' && (lstatSync(path).mode & 0o111) !== 0 }
}

/**
 * Inventory a materialized runtime without following links or including its descriptor.
 * @param root - Self-contained runtime directory.
 * @returns Sorted final-file inventory; executable permissions are false on Windows.
 */
export function inventoryDesktopRuntime(root: string): DesktopRuntimeFile[] {
  return runtimeFiles(root).map(({ path, name }) => runtimeFile(path, name, readFileSync(path)))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}

async function inventoryRuntimeConcurrently(root: string): Promise<DesktopRuntimeFile[]> {
  const entries = runtimeFiles(root)
  const files: DesktopRuntimeFile[] = []
  const remaining = entries.values()
  let failed = false
  const workers = Array.from({ length: Math.min(8, entries.length) }, async () => {
    while (!failed) {
      const next = remaining.next()
      if (next.done) return
      const { path, name } = next.value
      try {
        files.push(runtimeFile(path, name, await readRuntimeFile(path)))
      } catch (error) {
        failed = true
        throw error
      }
    }
  })
  // Failure returns only after every outstanding file read has closed its descriptor.
  const results = await Promise.allSettled(workers)
  for (const result of results) if (result.status === 'rejected') throw result.reason
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}

/**
 * Seal the final runtime tree after materialization and native signing.
 * @param root - Runtime output directory.
 * @param release - Matching shell, dsh, Host, and executable versions.
 * @param sharedNames - Release-owned packages supplied to plugins.
 * @param target - Platform and architecture selected by runtime preparation.
 * @returns Descriptor written beside the production packages.
 */
export function writeDesktopRuntime(
  root: string, release: DesktopRelease, sharedNames: readonly string[],
  target: { platform: NodeJS.Platform; arch: string } = process,
): DesktopRuntimeDescriptor {
  return writeRuntimeDescriptor(root, {
    ...runtimeMetadata(root, release, sharedNames, target), files: inventoryDesktopRuntime(root),
  })
}

/**
 * Seal a materialized runtime with bounded concurrent reads, draining readers before failure returns.
 * @param root - Runtime output directory.
 * @param release - Matching shell, dsh, Host, and executable versions.
 * @param sharedNames - Release-owned packages supplied to plugins.
 * @param target - Platform and architecture selected by runtime preparation.
 * @returns Descriptor written after every final file has been inventoried.
 */
export async function writeDesktopRuntimeAsync(
  root: string, release: DesktopRelease, sharedNames: readonly string[],
  target: { platform: NodeJS.Platform; arch: string } = process,
): Promise<DesktopRuntimeDescriptor> {
  const metadata = runtimeMetadata(root, release, sharedNames, target)
  return writeRuntimeDescriptor(root, { ...metadata, files: await inventoryRuntimeConcurrently(root) })
}

function runtimeMetadata(
  root: string, release: DesktopRelease, sharedNames: readonly string[],
  target: { platform: NodeJS.Platform; arch: string },
): Omit<DesktopRuntimeDescriptor, 'files'> {
  const sharedPackages = [...new Set(sharedNames)].sort().map((name) => {
    if (!PACKAGE_NAME.test(name)) throw new Error(`desktop runtime: invalid shared package ${name}`)
    const path = `node_modules/${name}`
    const manifest: unknown = JSON.parse(readFileSync(join(runtimePath(root, path), 'package.json'), 'utf8'))
    if (!record(manifest) || manifest.name !== name || typeof manifest.version !== 'string' || valid(manifest.version) === null) {
      throw new Error(`desktop runtime: invalid shared package manifest ${name}`)
    }
    return { name, version: manifest.version, path }
  })
  return { schemaVersion: 1, release, platform: target.platform, arch: target.arch, sharedPackages }
}

function writeRuntimeDescriptor(root: string, descriptor: DesktopRuntimeDescriptor): DesktopRuntimeDescriptor {
  writeFileSync(join(root, DESKTOP_RUNTIME_FILE), `${JSON.stringify(descriptor, undefined, 2)}\n`)
  return descriptor
}

/**
 * Read packaged metadata and check shared package records.
 * @param root - Current application's runtime resources.
 * @returns Runtime metadata whose release compatibility is verified during packaging.
 */
export function readDesktopRuntime(root: string): DesktopRuntimeDescriptor {
  const value: unknown = JSON.parse(readFileSync(join(root, DESKTOP_RUNTIME_FILE), 'utf8'))
  if (!record(value) || typeof value.platform !== 'string' || typeof value.arch !== 'string'
    || !Array.isArray(value.sharedPackages) || !Array.isArray(value.files)) {
    throw new Error('desktop runtime: invalid descriptor')
  }
  if (!record(value.release) || typeof value.release.version !== 'string'
    || typeof value.release.nodeVersion !== 'string' || typeof value.release.pnpmVersion !== 'string') {
    throw new Error('desktop runtime: invalid release fields')
  }
  const release = value.release as unknown as DesktopRelease
  const sharedPackages = value.sharedPackages.map((entry: unknown): DesktopSharedPackage => {
    if (!record(entry) || typeof entry.name !== 'string' || !PACKAGE_NAME.test(entry.name)
      || typeof entry.version !== 'string' || valid(entry.version) === null || entry.path !== `node_modules/${entry.name}`) {
      throw new Error('desktop runtime: invalid shared package record')
    }
    return { name: entry.name, version: entry.version, path: entry.path }
  })
  if (new Set(sharedPackages.map(entry => entry.name)).size !== sharedPackages.length) {
    throw new Error('desktop runtime: duplicate shared package')
  }
  const files = value.files as DesktopRuntimeFile[]
  for (const name of ['@deepseek-ai/dsh', DESKTOP_HOST_PACKAGE]) {
    if (sharedPackages.find(entry => entry.name === name)?.version !== release.version) {
      throw new Error(`desktop runtime: missing or mismatched ${name}`)
    }
  }
  return { schemaVersion: value.schemaVersion as 1, release, platform: value.platform as NodeJS.Platform,
    arch: value.arch, sharedPackages, files }
}

/** Prefix every DSH release-family package name shares. */
const DSH_PACKAGE_PREFIX = '@deepseek-ai/dsh'

/** One packaged package whose DSH peer requirement names a version other than the runtime. */
export interface DshPeerIssue {
  /** Packaged package owning the peer requirement. */
  readonly packageName: string
  /** Peer package name. */
  readonly peer: string
  /** Range as packaged. */
  readonly range: string
}

/** Every packaged `@deepseek-ai` package manifest below a runtime tree's node_modules. */
function packagedDshManifests(root: string): { directory: string; manifest: Record<string, unknown> }[] {
  const modules = join(root, 'node_modules')
  const found: { directory: string; manifest: Record<string, unknown> }[] = []
  for (const entry of readdirSync(modules, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    if (entry.name === '@deepseek-ai') {
      const scope = join(modules, entry.name)
      for (const child of readdirSync(scope, { withFileTypes: true })) {
        if (!child.isDirectory() && !child.isSymbolicLink()) continue
        const directory = join(scope, child.name)
        const manifest = readPackageManifest(directory)
        if (manifest !== undefined) found.push({ directory, manifest })
      }
    }
  }
  return found
}

/** Read one package manifest, or undefined when the directory carries none. */
function readPackageManifest(directory: string): Record<string, unknown> | undefined {
  let text: string
  try {
    text = readFileSync(join(directory, 'package.json'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const parsed: unknown = JSON.parse(text)
  return record(parsed) ? parsed : undefined
}

/** Whether one peer name belongs to the DSH release family the runtime version names. */
function isDshPeer(name: string): boolean {
  return name === DSH_PACKAGE_PREFIX || name.startsWith(`${DSH_PACKAGE_PREFIX}-`)
}

/**
 * Read every packaged DSH peer requirement that does not name the runtime version.
 *
 * Packaging materializes `workspace:*` peer ranges to the target package version, so a private
 * package lands as `0.0.0` and any package left on an older release lands as that release. The
 * startup compatibility preflight compares each DSH peer range with the running runtime version
 * and disables the whole row when they differ; a silent whole-row disable is how `tool-fs` and
 * `llm-plus` disappeared from the Desktop profile.
 * @param root - packaged dsh tree (the directory holding `node_modules`).
 * @param runtimeVersion - version the runtime declares, which every DSH peer must name.
 * @returns the offending requirements, in package then peer order.
 */
export function dshPeerIssues(root: string, runtimeVersion: string): DshPeerIssue[] {
  const issues: DshPeerIssue[] = []
  for (const { manifest } of packagedDshManifests(root)) {
    const peers = manifest.peerDependencies
    if (!record(peers)) continue
    const name = typeof manifest.name === 'string' ? manifest.name : undefined
    if (name === undefined) continue
    for (const [peer, range] of Object.entries(peers)) {
      if (!isDshPeer(peer) || typeof range !== 'string') continue
      if (range !== runtimeVersion) issues.push({ packageName: name, peer, range })
    }
  }
  return issues
}

/**
 * Rewrite every packaged DSH peer requirement to the runtime version.
 *
 * The staged tree is build output, so normalizing it after installation is what makes the
 * packaged manifests match the runtime the compatibility preflight compares them against.
 * Non-DSH peers (cordis, schemastery, third-party) keep their declared ranges.
 * @param root - packaged dsh tree (the directory holding `node_modules`).
 * @param runtimeVersion - version every DSH peer must name.
 * @returns package names whose manifest changed.
 */
export function normalizeDshPeerVersions(root: string, runtimeVersion: string): string[] {
  const changed: string[] = []
  for (const { directory, manifest } of packagedDshManifests(root)) {
    const peers = manifest.peerDependencies
    if (!record(peers)) continue
    const name = typeof manifest.name === 'string' ? manifest.name : undefined
    if (name === undefined) continue
    let touched = false
    for (const [peer, range] of Object.entries(peers)) {
      if (!isDshPeer(peer) || typeof range !== 'string' || range === runtimeVersion) continue
      peers[peer] = runtimeVersion
      touched = true
    }
    if (!touched) continue
    writeFileSync(join(directory, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}
`)
    changed.push(name)
  }
  return changed
}

/**
 * Verify every packaged runtime file against its recorded bytes and permissions at build time.
 * @param root - Materialized runtime resources.
 * @param expectedVersion - Version the bundled runtime must declare: the product version ordinarily,
 * and a rewritten one for installed-update qualification.
 * @param target - Required execution target; defaults to the current process.
 * @returns Validated runtime descriptor.
 */
export async function verifyDesktopRuntime(
  root: string, expectedVersion: string, target: { platform: NodeJS.Platform; arch: string } = process,
): Promise<DesktopRuntimeDescriptor> {
  const descriptor = readDesktopRuntime(root)
  // readDesktopRuntime preserves the disk schema value without validating release compatibility.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (descriptor.schemaVersion !== 1 || descriptor.platform !== target.platform || descriptor.arch !== target.arch) {
    throw new Error('desktop runtime: invalid descriptor or incompatible platform/architecture')
  }
  const release = parseDesktopRelease(descriptor.release)
  if (release.version !== expectedVersion) throw new Error(`desktop runtime: bundled ${release.version} is not the expected ${expectedVersion}`)
  for (const entry of descriptor.sharedPackages) {
    const manifest: unknown = JSON.parse(readFileSync(join(runtimePath(root, entry.path), 'package.json'), 'utf8'))
    if (!record(manifest) || manifest.name !== entry.name || manifest.version !== entry.version) {
      throw new Error(`desktop runtime: shared package metadata mismatch for ${entry.name}`)
    }
  }
  const peerIssues = dshPeerIssues(root, release.version)
  if (peerIssues.length > 0) {
    throw new Error(`desktop runtime: DSH peer requirements do not name ${release.version}: `
      + peerIssues.map(issue => `${issue.packageName} -> ${issue.peer}@${issue.range}`).join(', '))
  }
  const actual = await inventoryRuntimeConcurrently(root)
  // Windows has no portable Unix executable permission bits.
  const comparable = (items: readonly DesktopRuntimeFile[]): unknown => process.platform === 'win32'
    ? items.map(({ executable: _executable, ...item }) => item) : items
  if (JSON.stringify(comparable(descriptor.files)) !== JSON.stringify(comparable(actual))) {
    throw new Error('desktop runtime: integrity verification failed')
  }
  return descriptor
}
