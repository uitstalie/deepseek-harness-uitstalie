/**
 * Tests for core/hooks — installing the commit binding, including a **real `git commit`**.
 *
 * The end-to-end assertion is the one that matters: git must actually run our shim and honour its
 * exit code. A stand-in CLI (`JIRA_CLI`) lets the test prove that without depending on a build.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { runGit, stageAndCommit } from './git.ts'
import { backupNameOf, hookShim, hookStatus, hooksDirectory, installHooks, renderHookStatus, uninstallHooks } from './hooks.ts'

let root = ''
let stub = ''

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  assert.equal(result.ok, true, `expected success, got ${JSON.stringify(result)}`)
  if (!result.ok) throw new Error('unreachable')
  return result.value
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-jira-hooks-'))
  await runGit(root, ['init', '--initial-branch=main'])
  await runGit(root, ['config', '--local', 'user.name', 'tester'])
  await runGit(root, ['config', '--local', 'user.email', 'tester@example.invalid'])

  // A stand-in for the CLI: refuses unless the message names a key, which is the real rule.
  stub = join(root, 'stub-cli.cjs')
  await writeFile(stub, [
    "'use strict'",
    "const fs = require('node:fs')",
    "if (process.argv[2] === 'verify-commit-msg') {",
    "  const text = fs.readFileSync(process.argv[3], 'utf8')",
    "  if (!/\\b[A-Z][A-Z0-9]{1,5}-\\d+\\b/.test(text) && !text.includes('[no-issue]')) {",
    "    console.error('stub: commit refused')",
    '    process.exit(1)',
    '  }',
    '  process.exit(0)',
    '}',
    'process.exit(0)',
    '',
  ].join('\n'), 'utf8')
})

after(async () => {
  if (root !== '') await rm(root, { recursive: true, force: true })
})

const commit = async (message: string): Promise<{ code: number; stderr: string }> => {
  // Different content each time, so the commit is never "nothing to commit".
  await writeFile(join(root, 'file.txt'), `${message}\n${String(Date.now())}\n`, 'utf8')
  await runGit(root, ['add', 'file.txt'])
  const result = await runGit(root, ['commit', '-m', message])
  return { code: result.code, stderr: result.stderr }
}

describe('hooks: the shim', () => {
  it('carries the marker, the kind and an overridable CLI path', () => {
    const shim = hookShim('commit-msg', '/somewhere/dist/cli/index.js', 'C:/Git/bin/sh.exe')
    assert.match(shim, /dsh-jira hook shim/)
    assert.match(shim, /kind: commit-msg/)
    assert.match(shim, /process\.env\.JIRA_CLI \|\| "\/somewhere\/dist\/cli\/index\.js"/)
    assert.match(shim, /'verify-commit-msg'/)
    assert.match(shim, /const shell = "C:\/Git\/bin\/sh\.exe"/)
  })

  it('chains to a preserved hook, and runs it first', () => {
    const shim = hookShim('commit-msg', '/cli.js', 'C:/Git/bin/sh.exe')
    assert.match(shim, new RegExp(backupNameOf('commit-msg').replace('.', '\\.')))
    const backupAt = shim.indexOf('existsSync(backup)')
    const verifyAt = shim.indexOf('verify-commit-msg')
    assert.ok(backupAt !== -1 && backupAt < verifyAt, 'the previous hook may rewrite the message we validate')
  })

  it('uses CommonJS, because git runs the hook file with no extension', () => {
    assert.match(hookShim('commit-msg', '/cli.js'), /require\('node:child_process'\)/)
    assert.equal(/^import /m.test(hookShim('commit-msg', '/cli.js')), false)
  })
})

describe('hooks: installing', () => {
  it('installs both hooks and then reports them installed', async () => {
    const report = unwrap(await installHooks(root, stub))
    assert.deepEqual([...report.installed], ['commit-msg', 'prepare-commit-msg'])
    assert.equal(report.directory.replaceAll('\\', '/').endsWith('/.git/hooks'), true)
    assert.deepEqual(report.backedUp, [])

    const states = await hookStatus(root)
    assert.deepEqual(states.map(state => state.installed), [true, true])
    assert.deepEqual(states.map(state => state.backup), [false, false])
    assert.match(renderHookStatus(states), /✓ commit-msg/)
  })

  it('preserves an existing hook instead of overwriting it', async () => {
    const target = join(hooksDirectory(root), 'commit-msg')
    await writeFile(target, '#!/bin/sh\necho original\n', 'utf8')
    const report = unwrap(await installHooks(root, stub))
    assert.deepEqual([...report.backedUp], ['commit-msg'])
    assert.equal(await readFile(join(hooksDirectory(root), backupNameOf('commit-msg')), 'utf8'), '#!/bin/sh\necho original\n')

    // Re-installing must not back up our own shim over the preserved original.
    const again = unwrap(await installHooks(root, stub))
    assert.deepEqual([...again.backedUp], [])
    assert.equal(await readFile(join(hooksDirectory(root), backupNameOf('commit-msg')), 'utf8'), '#!/bin/sh\necho original\n')
    assert.equal((await hookStatus(root))[0]?.backup, true)
  })

  it('restores the original on uninstall', async () => {
    unwrap(await installHooks(root, stub))
    const restored = unwrap(await uninstallHooks(root))
    assert.ok(restored.includes('commit-msg'))
    assert.equal(await readFile(join(hooksDirectory(root), 'commit-msg'), 'utf8'), '#!/bin/sh\necho original\n')
    assert.equal((await hookStatus(root))[0]?.installed, false)
  })
})

describe('hooks: chaining a preserved hook (the bug this test exists for)', () => {
  it('runs a shell-script backup instead of blocking every commit', async () => {
    // A preserved hook is usually `#!/bin/sh`. Handing that file straight to node fails with EFTYPE
    // on Windows, and the first version of the shim turned that failure into "every commit in this
    // repository is refused" — which is exactly the kind of bug a chain must not introduce.
    unwrap(await installHooks(root, stub))
    await writeFile(join(hooksDirectory(root), backupNameOf('commit-msg')), '#!/bin/sh\necho CHAINED-SH\n', 'utf8')
    process.env.JIRA_CLI = stub
    try {
      const result = await commit('DH-1: with a shell hook preserved')
      assert.equal(result.code, 0, `a shell backup must not block the commit (stderr: ${result.stderr})`)
    } finally {
      delete process.env.JIRA_CLI
      await rm(join(hooksDirectory(root), 'commit-msg'), { force: true })
      await rm(join(hooksDirectory(root), 'prepare-commit-msg'), { force: true })
      await rm(join(hooksDirectory(root), backupNameOf('commit-msg')), { force: true })
    }
  })

  it('still obeys a preserved hook that refuses', async () => {
    unwrap(await installHooks(root, stub))
    await writeFile(join(hooksDirectory(root), backupNameOf('commit-msg')), '#!/bin/sh\nexit 3\n', 'utf8')
    process.env.JIRA_CLI = stub
    try {
      const result = await commit('DH-1: the backup says no')
      assert.notEqual(result.code, 0, 'a chained hook that refuses still refuses')
    } finally {
      delete process.env.JIRA_CLI
      await rm(join(hooksDirectory(root), 'commit-msg'), { force: true })
      await rm(join(hooksDirectory(root), 'prepare-commit-msg'), { force: true })
      await rm(join(hooksDirectory(root), backupNameOf('commit-msg')), { force: true })
    }
  })
})
describe('hooks: a real git commit obeys the hook', () => {
  it('refuses a message with no key, and accepts one with a key', async () => {
    unwrap(await installHooks(root, stub))
    process.env.JIRA_CLI = stub
    try {
      await writeFile(join(root, '.gitattributes'), '* text=auto eol=lf\n', 'utf8')
      await stageAndCommit(root, ['.gitattributes'], 'DH-1: first [no-issue]')

      const refused = await commit('fix something with no key')
      assert.notEqual(refused.code, 0, `git must honour the shim exit code (stderr: ${refused.stderr})`)

      const accepted = await commit('DH-1: fix something')
      assert.equal(accepted.code, 0, `a keyed message commits (stderr: ${accepted.stderr})`)
      const log = await runGit(root, ['log', '-1', '--pretty=%s'])
      assert.equal(log.stdout, 'DH-1: fix something')

      const marker = await commit('chore: bump the toolchain [no-issue]')
      assert.equal(marker.code, 0, `the deliberate escape hatch works (stderr: ${marker.stderr})`)
    } finally {
      delete process.env.JIRA_CLI
      unwrap(await uninstallHooks(root))
    }
  })

  it('leaves the repository clean when a commit is refused', async () => {
    unwrap(await installHooks(root, stub))
    process.env.JIRA_CLI = stub
    try {
      await writeFile(join(root, 'file.txt'), 'nope\n', 'utf8')
      await runGit(root, ['add', 'file.txt'])
      assert.notEqual((await runGit(root, ['commit', '-m', 'no key here'])).code, 0)
      const status = await runGit(root, ['status', '--porcelain'])
      assert.match(status.stdout, /^[AM] {2}file\.txt$/m, 'the change is still staged, nothing was lost')
    } finally {
      delete process.env.JIRA_CLI
      unwrap(await uninstallHooks(root))
    }
  })
})
