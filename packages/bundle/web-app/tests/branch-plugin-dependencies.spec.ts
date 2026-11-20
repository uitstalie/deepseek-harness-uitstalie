import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

/**
 * The branch layer inserts these packages, so the packaged runtime tree only ships
 * what the web-app dependency closure installs. Declaring one only in the patch
 * leaves it out of the app and the row fails with ERR_MODULE_NOT_FOUND at load
 * (observed for token-calculator), which the host reports as a warning rather
 * than a startup failure.
 */
const BRANCH_CAPABILITIES = [
  '@deepseek-ai/dsh-memory',
  '@deepseek-ai/dsh-persona-card',
  '@deepseek-ai/dsh-token-calculator',
] as const

interface Resolution {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

/**
 * Resolve one package in a plain Node ESM process rooted at the bundle, the way a
 * consumer resolves it: through the installed dependency link and package exports.
 * @param name - package specifier to resolve.
 * @returns the child process outcome; `stdout` is the resolved file URL.
 */
function resolveFromBundle(name: string): Resolution {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `process.stdout.write(import.meta.resolve(${JSON.stringify(name)}))`], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

it('declares every branch capability package in the bundle dependencies', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    dependencies: Readonly<Record<string, string>>
  }
  for (const name of BRANCH_CAPABILITIES) expect(manifest.dependencies[name]).toBe('workspace:*')
})

it.each(BRANCH_CAPABILITIES)('resolves %s from the bundle as a plain Node consumer', (name) => {
  const resolution = resolveFromBundle(name)
  expect(resolution.stderr).toBe('')
  expect(resolution.status).toBe(0)
  // The installed link may realpath into the workspace package directory.
  const segment = name.replace('@deepseek-ai/dsh-', '')
  expect(resolution.stdout).toMatch(new RegExp(`/${segment.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}/`, 'u'))
})
