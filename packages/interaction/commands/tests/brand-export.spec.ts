import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** Why these consumers: they import `@deepseek-ai/dsh-commands/brand` at runtime, so the
 * subpath must resolve through Node's own package exports from an external plugin — not
 * through the repository's tsconfig paths, which resolve `src/brand.ts` and hide a
 * missing `exports` entry until a built or packaged host loads the plugin. */
const CONSUMERS = ['memory', 'persona-card', 'token-calculator'] as const

interface Resolution {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

/**
 * Resolve the subpath in a plain Node ESM process whose working directory is one
 * consumer plugin, exactly as a built plugin resolves its own imports.
 * @param consumer - directory name under `packages/uitstalie`.
 * @returns the child process outcome; `stdout` is the resolved file URL.
 */
function resolveFromConsumer(consumer: string): Resolution {
  const directory = fileURLToPath(new URL(`../../../../packages/uitstalie/${consumer}`, import.meta.url))
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    "process.stdout.write(import.meta.resolve('@deepseek-ai/dsh-commands/brand'))"], {
    cwd: directory,
    encoding: 'utf8',
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe('the @deepseek-ai/dsh-commands ./brand export', () => {
  it.each(CONSUMERS)('resolves from the %s plugin through Node package exports', (consumer) => {
    const resolution = resolveFromConsumer(consumer)
    // A missing export fails with ERR_PACKAGE_PATH_NOT_EXPORTED here, before any host loads the plugin.
    expect(resolution.stderr).toBe('')
    expect(resolution.status).toBe(0)
    expect(resolution.stdout).toMatch(/lib\/types\/brand\.js$/u)
  })

  it('publishes the subpath with its types inside the tarball files', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      exports: Readonly<Record<string, { types?: string; default?: string }>>
      files: readonly string[]
    }
    expect(manifest.exports['./brand']).toEqual({
      types: './lib/types/brand.d.ts',
      default: './lib/types/brand.js',
    })
    expect(manifest.files).toContain('lib/types/**/*.js')
    expect(manifest.files).toContain('lib/types/**/*.d.ts')
  })
})
