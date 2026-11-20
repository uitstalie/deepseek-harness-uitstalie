import { join, resolve, win32 } from 'node:path'
import { expect, it } from 'vitest'
import { packageDirectory, privatePackArguments } from '../scripts/pack-local-packages.ts'

/** Repository root for relative-input cases; the directory arithmetic must not depend on it. */
const root = resolve('repo')

it('resolves host-glob manifest paths to the package directory with either separator', () => {
  for (const manifest of ['packages\\uitstalie\\memory\\package.json', 'packages/uitstalie/memory/package.json']) {
    const directory = packageDirectory(root, manifest)
    expect(directory.endsWith(join('packages', 'uitstalie', 'memory'))).toBe(true)
    expect(directory.endsWith('package.json')).toBe(false)
  }
})

it('keeps Windows drive-letter and UNC input as a directory on any host', () => {
  const drive = 'D:\\work\\deepseek-harness\\packages\\uitstalie\\memory\\package.json'
  const unc = '\\\\server\\share\\repo\\packages\\uitstalie\\memory\\package.json'
  expect(packageDirectory(root, drive)).toBe(win32.dirname(drive))
  expect(packageDirectory(root, unc)).toBe(win32.dirname(unc))
  expect(packageDirectory(root, drive)).not.toMatch(/package\.json$/u)
})

it('passes the package directory to pnpm, never the manifest file', () => {
  for (const manifest of ['packages\\uitstalie\\memory\\package.json', 'D:\\work\\repo\\packages\\uitstalie\\memory\\package.json']) {
    const args = privatePackArguments(root, manifest, 'out')
    expect(args[0]).toBe('--dir')
    expect(args[1]).toBe(packageDirectory(root, manifest))
    expect(args[1]).not.toMatch(/package\.json$/u)
    expect(args).toContain('--pack-destination')
  }
})
