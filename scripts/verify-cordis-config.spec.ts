/**
 * The verify-cordis-config metadata contract: `disabled` is the one entry
 * metadata field whose `!!js` expression the Loader interpolates; every other
 * metadata field must stay static, and a disabled expression must parse.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path' // uitstalie-deepseek-flash, 2026/11/01, DH-507, 新增 relative
import { describe, expect, it } from 'vitest'
import {
  bundleManifestPaths,
  bundlePluginDependencyErrors,
  exclusivePlaneRowIds,
  metadataExpressionErrors,
  packageTestFixtureDependencyErrors,
  packageTestPluginDependencyErrors,
  readCordisDocument, // uitstalie-deepseek-flash, 2026/11/01, DH-507
} from './verify-cordis-config.ts'

describe('verify-cordis-config metadata expressions', () => {
  it('accepts a disabled !!js expression', () => {
    const problems = metadataExpressionErrors(
      { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: { __jsExpr: "process.platform === 'win32'" } },
      '[0]',
    )
    expect(problems).toEqual([])
  })

  it('rejects an expression in a static metadata field', () => {
    const problems = metadataExpressionErrors({ id: { __jsExpr: 'process.platform' }, name: 'pkg' }, '[0]')
    expect(problems).toContain('[0].id: !!js is not interpolated here')
  })

  it('rejects an expression nested below disabled (only the field itself interpolates)', () => {
    const problems = metadataExpressionErrors(
      { id: 'tool-bash', name: 'pkg', disabled: { when: { __jsExpr: 'process.platform' } } },
      '[0]',
    )
    expect(problems).toContain('[0].disabled.when: !!js is not interpolated here')
  })

  it('rejects a disabled expression that does not parse (the loader would fail the boot)', () => {
    const problems = metadataExpressionErrors(
      { id: 'tool-bash', name: 'pkg', disabled: { __jsExpr: 'process.platform ===' } },
      '[0]',
    )
    expect(problems.some(problem => problem.includes('[0].disabled: disabled expression does not parse'))).toBe(true)
  })
})

// BEGIN uitstalie-deepseek-flash, 2026/11/01, DH-507, 物化软链档案按目标解析的回归用例
describe('materialized symlink Loader configs', () => {
  it('reads a tracked symlink checked out as a file through its target', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'dsh-materialized-symlink-'))
    try {
      mkdirSync(join(fixture, 'snapshots'), { recursive: true })
      mkdirSync(join(fixture, 'profiles'), { recursive: true })
      writeFileSync(join(fixture, 'snapshots/cordis.yml'), '- id: web\n  name: pkg\n')
      writeFileSync(join(fixture, 'profiles/cordis.yml'), '../snapshots/cordis.yml\n')

      expect(readCordisDocument(fixture, 'profiles/cordis.yml')).toEqual([{ id: 'web', name: 'pkg' }])
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('keeps a lone scalar that names no repository file as data', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'dsh-lone-scalar-'))
    try {
      mkdirSync(join(fixture, 'profiles'), { recursive: true })
      writeFileSync(join(fixture, 'profiles/cordis.yml'), 'not a file path\n')

      expect(readCordisDocument(fixture, 'profiles/cordis.yml')).toBe('not a file path')
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('does not follow a target outside the repository', () => {
    const outside = mkdtempSync(join(tmpdir(), 'dsh-symlink-outside-'))
    const fixture = mkdtempSync(join(tmpdir(), 'dsh-symlink-root-'))
    try {
      writeFileSync(join(outside, 'cordis.yml'), '- id: outside\n  name: pkg\n')
      mkdirSync(join(fixture, 'profiles'), { recursive: true })
      const link = relative(join(fixture, 'profiles'), join(outside, 'cordis.yml'))
      writeFileSync(join(fixture, 'profiles/cordis.yml'), link)

      expect(readCordisDocument(fixture, 'profiles/cordis.yml')).toBe(link)
    } finally {
      rmSync(outside, { recursive: true, force: true })
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})
// END uitstalie-deepseek-flash

describe('workspace Bundle discovery and product dependency closures', () => {
  it('allows scoped executors on both planes while retaining other plugin rows', () => {
    expect([...exclusivePlaneRowIds([{ insert: [
      { id: 'native', name: '@deepseek-ai/dsh-tool-executor-native' },
      { id: 'ptc', name: '@deepseek-ai/dsh-tool-executor-ptc' },
      { id: 'tools', name: '@deepseek-ai/dsh-tools' },
      { id: 'group', name: 'cordis:group', group: true, config: [
        { id: 'tool-executor-ptc', name: '@deepseek-ai/dsh-tool-fs' },
      ] },
    ] }])]).toEqual(['tools', 'group', 'tool-executor-ptc'])
  })

  it('discovers a Bundle outside packages/bundle from its manifest declaration', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'dsh-bundle-discovery-'))
    try {
      const bundleDir = join(fixture, 'packages/subagent/example')
      const plainDir = join(fixture, 'packages/bundle/plain')
      mkdirSync(bundleDir, { recursive: true })
      mkdirSync(plainDir, { recursive: true })
      writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({
        name: '@deepseek-ai/dsh-subagent-example',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }))
      writeFileSync(join(plainDir, 'package.json'), JSON.stringify({
        name: '@deepseek-ai/dsh-plain',
      }))

      expect(bundleManifestPaths(fixture)).toEqual([
        'packages/subagent/example/package.json',
      ])
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('allows a Bundle to mount itself but rejects an undeclared plugin package', () => {
    const manifestPath = 'packages/subagent/example/package.json'
    const file = 'packages/subagent/example/cordis.patch.yml'
    const manifest = {
      name: '@deepseek-ai/dsh-subagent-example',
      dependencies: {},
    }
    const self = { file, name: '@deepseek-ai/dsh-subagent-example' }
    expect(bundlePluginDependencyErrors(manifestPath, manifest, [self])).toEqual([])
    expect(bundlePluginDependencyErrors(manifestPath, {
      ...manifest, optionalDependencies: { '@deepseek-ai/dsh-platform-plugin': 'workspace:*' },
    }, [{ file, name: '@deepseek-ai/dsh-platform-plugin' }])).toEqual([])
    expect(bundlePluginDependencyErrors(manifestPath, manifest, [
      self,
      { file, name: '@deepseek-ai/dsh-missing-plugin' },
    ])).toEqual([
      `${file}: @deepseek-ai/dsh-missing-plugin must be declared in ${manifestPath} dependencies or optionalDependencies`,
    ])
  })
})

describe('package-owned Loader test dependency closures', () => {
  it('requires package test configs to declare each named plugin they load', () => {
    const manifestPath = 'packages/example/owner/package.json'
    const file = 'packages/example/owner/tests/fixtures/cordis.yml'
    const manifest = {
      name: '@deepseek-ai/dsh-owner',
      dependencies: {},
      devDependencies: {
        '@deepseek-ai/dsh-declared': 'workspace:^',
      },
    }
    expect(packageTestPluginDependencyErrors(manifestPath, manifest, [
      { file, name: '@deepseek-ai/dsh-owner' },
      { file, name: '@deepseek-ai/dsh-declared' },
      { file, name: '@deepseek-ai/dsh-missing' },
    ])).toEqual([
      `${file}: @deepseek-ai/dsh-missing must be declared in ${manifestPath} dependencies or devDependencies`,
    ])
  })

  it('requires executable package test fixtures to declare their bare imports', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'dsh-package-test-entrypoint-'))
    try {
      const packageDir = join(fixture, 'packages/example/owner')
      const driverDir = join(packageDir, 'tests/fixtures/loader')
      mkdirSync(driverDir, { recursive: true })
      writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
        name: '@deepseek-ai/dsh-owner',
        devDependencies: {
          '@deepseek-ai/dsh-declared': 'workspace:^',
        },
      }))
      writeFileSync(join(driverDir, 'driver.ts'), [
        "import '@deepseek-ai/dsh-owner'",
        "import '@deepseek-ai/dsh-declared'",
        "import '@deepseek-ai/dsh-missing'",
      ].join('\n'))
      writeFileSync(join(driverDir, 'cordis.yml'), '[]\n')
      writeFileSync(join(driverDir, 'fixture.mjs'), "import '@deepseek-ai/dsh-declared'\n")
      const unrelatedDir = join(packageDir, 'tests/fixtures/unrelated')
      mkdirSync(unrelatedDir, { recursive: true })
      writeFileSync(join(unrelatedDir, 'driver.ts'), "import '@deepseek-ai/dsh-unrelated'\n")

      expect(packageTestFixtureDependencyErrors(fixture)).toEqual([
        'packages/example/owner/tests/fixtures/loader/driver.ts: '
        + '@deepseek-ai/dsh-missing must be declared in '
        + 'packages/example/owner/package.json dependencies or devDependencies',
      ])
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('fails loud when package-owned Loader fixtures disappear from the scan', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'dsh-empty-package-test-entrypoint-'))
    try {
      expect(packageTestFixtureDependencyErrors(fixture)).toEqual([
        'package test fixture dependency scan found no package-owned Loader configs',
      ])
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})
