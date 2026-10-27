/**
 * Tests for `/jira` — the command surface, driven in-process against the real ledger service.
 *
 * The command must answer the questions a person asks *about* the ledger, and it must never
 * disagree with the CLI (they share `core`); these tests check the answers, not the wording.
 * The service is the shipped one (`mountJira`), so a command that opened its own store would be
 * visible here as behaviour that the service does not produce.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { removeTree } from '@deepseek-ai/dsh-jira-core/testing/removeTree.ts'
import { runGit } from '@deepseek-ai/dsh-jira-core/git.ts'
import { applyTransition } from '@deepseek-ai/dsh-jira-core/mutate.ts'
import { scaffoldStore } from '@deepseek-ai/dsh-jira-core/scaffold.ts'
import { createStore, transact } from '@deepseek-ai/dsh-jira-core/store.ts'
import { runJiraCommand, type CommandOptions } from './command.ts'
import { mountJira } from './testing/host.ts'
import type { JiraHarness } from './testing/host.ts'

let root = ''
let harness: JiraHarness
let options: CommandOptions
/** Every temp directory this file made beyond `root`, so `after` can remove them. */
const scratch: string[] = []

const run = async (rawInput: string) => runJiraCommand(rawInput, options)

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-jira-command-'))
  const scaffolded = await scaffoldStore(root)
  assert.equal(scaffolded.ok, true)
  await runGit(root, ['config', '--local', 'user.name', 'tester'])
  await runGit(root, ['config', '--local', 'user.email', 'tester@example.invalid'])
  harness = await mountJira(root)
  options = Object.freeze({
    jira: harness.ctx.jira,
    identity: () => 'human:tester',
    now: () => '2026-10-15T12:00:00Z',
  })
})

after(async () => {
  await harness?.dispose()
  if (root !== '') await removeTree(root)
  for (const dir of scratch.splice(0)) await removeTree(dir)
})

describe('/jira: creating and reading back', () => {
  it('creates an issue and reports its key', async () => {
    const created = await run('new --project DH --summary "first from the command"')
    assert.equal(created.kind, 'success', created.text)
    assert.match(created.text, /^DH-1 已创建/)

    const second = await run('new --project DH --summary second')
    assert.equal(second.kind, 'success', second.text)
    assert.match(second.text, /DH-2 已创建/)
  })

  it('lists open issues and hides closed ones unless --all', async () => {
    const open = await run('list')
    assert.match(open.text, /DH-1/)
    const board = await run('board')
    assert.match(board.text, /^todo（2）$/m)

    const store = createStore({ root, machineId: 'command-machine' })
    const moved = await transact(store, 'DH-2' as never, {
      by: 'human:tester' as never,
      at: '2026-10-15T13:00:00Z' as never,
    }, (issue, ctx) => applyTransition(issue, 'closed', { resolution: 'fixed' }, ctx))
    assert.equal(moved.ok, true, JSON.stringify(moved.ok ? undefined : moved.error))

    const after = await run('list')
    assert.equal(after.text.includes('DH-2'), false, 'closed work is out of the default view')
    const all = await run('list --all')
    assert.equal(all.text.includes('DH-2'), true)
    const filtered = await run('list --status closed --all')
    assert.match(filtered.text, /DH-2/)
    assert.equal(filtered.text.includes('DH-1'), false)
  })

  it('says what the store holds', async () => {
    const status = await run('status')
    assert.equal(status.kind, 'success', status.text)
    assert.match(status.text, /词表：\d+ 个状态，\d+ 条迁移/)
    assert.match(status.text, /issue：2 条，分布在 1 个项目/)
  })
})

describe('/jira: health, sync and mistakes', () => {
  it('reports health and pushes nothing without a remote', async () => {
    const doctor = await run('doctor')
    assert.equal(doctor.kind, 'success', doctor.text)
    assert.match(doctor.text, /结果：/)

    const sync = await run('sync')
    assert.equal(sync.kind, 'success', sync.text)
    assert.match(sync.text, /remote：无/)
    assert.match(sync.text, /推送：/)
  })

  it('names an unknown subcommand, a missing flag and bad usage', async () => {
    const unknown = await run('frobnicate')
    assert.equal(unknown.kind, 'error')
    assert.match(unknown.text, /未知子命令 "frobnicate"/)

    const noProject = await run('new --summary x')
    assert.equal(noProject.kind, 'error')
    assert.match(noProject.text, /new 需要 --project/)

    const badFlag = await run('list --porject DH')
    assert.equal(badFlag.kind, 'error')
    assert.match(badFlag.text, /未知的 flag --porject/)

    const help = await run('help')
    assert.match(help.text, /jira —— 本地 issue 账本/)
  })

  it('answers a store that cannot be read instead of throwing', async () => {
    const broken = await mountJira(join(root, 'missing-ledger'))
    try {
      const result = await runJiraCommand('status', Object.freeze({
        jira: broken.ctx.jira,
        identity: () => 'human:tester',
        now: () => '2026-10-15T12:00:00Z',
      }))
      assert.equal(result.kind, 'success', result.text)
      assert.match(result.text, /词表：缺失或读不出来/u)
      assert.match(result.text, /健康：\d+ 个错误/u)
    } finally {
      await broken.dispose()
    }
  })
})

/**
 * A scaffolded ledger with a bare remote and one pushed commit — the state `sync` needs before it
 * can pull, settle or push. Everything lands in `scratch`, which `after` removes.
 * @returns the ledger root, the bare remote and the checked-out branch.
 */
const ledgerWithRemote = async (): Promise<{ dir: string; bare: string; branch: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-jira-sync-'))
  const bare = await mkdtemp(join(tmpdir(), 'dsh-jira-bare-'))
  scratch.push(dir, bare)
  const scaffolded = await scaffoldStore(dir)
  assert.equal(scaffolded.ok, true)
  await runGit(dir, ['config', '--local', 'user.name', 'tester'])
  await runGit(dir, ['config', '--local', 'user.email', 'tester@example.invalid'])
  await runGit(bare, ['init', '--bare', '--quiet'])
  await runGit(dir, ['remote', 'add', 'origin', bare])
  await runGit(dir, ['add', '-A'])
  await runGit(dir, ['commit', '--no-verify', '-m', 'init [no-issue]'])
  const pushed = await runGit(dir, ['push', '-u', 'origin', 'HEAD'])
  assert.equal(pushed.code, 0, pushed.stderr)
  const branch = (await runGit(dir, ['branch', '--show-current'])).stdout.trim()
  return { dir, bare, branch }
}

/** Run `/jira sync` against one ledger mounted with its push queue on. */
const syncWithQueue = async (dir: string): Promise<{ kind: string; text: string }> => {
  const mounted = await mountJira(dir, { push: true })
  try {
    return await runJiraCommand('sync', Object.freeze({
      jira: mounted.ctx.jira,
      identity: () => 'human:tester',
      now: () => '2026-10-15T12:00:00Z',
    }))
  } finally {
    await mounted.dispose()
  }
}

describe('/jira: sync classifies every failed step as an error (DH-306)', () => {
  it('fails when pull --rebase stops on a real conflict', async () => {
    const { dir, bare, branch } = await ledgerWithRemote()
    const other = await mkdtemp(join(tmpdir(), 'dsh-jira-other-'))
    scratch.push(other)
    await runGit(other, ['clone', '--quiet', '--branch', branch, bare, '.'])
    await runGit(other, ['config', '--local', 'user.name', 'other'])
    await runGit(other, ['config', '--local', 'user.email', 'other@example.invalid'])
    // Both machines edit the same line: git cannot rebase one onto the other.
    const marker = '# This file is the store\'s vocabulary.'
    const theirs = join(other, 'config.md')
    await writeFile(theirs, (await readFile(theirs, 'utf8')).replace(marker, `${marker} (other)`), 'utf8')
    await runGit(other, ['commit', '-am', 'config from the other machine [no-issue]'])
    assert.equal((await runGit(other, ['push', 'origin', branch])).code, 0)
    const ours = join(dir, 'config.md')
    await writeFile(ours, (await readFile(ours, 'utf8')).replace(marker, `${marker} (local)`), 'utf8')
    await runGit(dir, ['commit', '-am', 'config here [no-issue]'])

    const result = await syncWithQueue(dir)
    assert.equal(result.kind, 'error', result.text)
    assert.match(result.text, /pull --rebase stopped/u)
  })

  it('fails when settling cannot commit', async () => {
    const { dir } = await ledgerWithRemote()
    // `git add -A` refuses to run while another process owns the index; the settle step reports
    // that as a failure instead of pretending the derived files were refreshed.
    await writeFile(join(dir, '.git', 'index.lock'), '', 'utf8')
    const result = await syncWithQueue(dir)
    assert.equal(result.kind, 'error', result.text)
    assert.match(result.text, /git add -A/u)
  })

  it('fails when the push is rejected', async () => {
    const { dir } = await ledgerWithRemote()
    // Fetch still works (so the pull succeeds); only the push URL is gone.
    await runGit(dir, ['remote', 'set-url', '--push', 'origin', join(dir, 'missing.git')])
    const result = await syncWithQueue(dir)
    assert.equal(result.kind, 'error', result.text)
    assert.match(result.text, /push/u)
  })
})

describe('/jira: the read-only pair decision 83 names', () => {
  it('shows one issue in full, and refuses something that is not a key', async () => {
    const shown = await run('show DH-1')
    assert.equal(shown.kind, 'success', shown.text)
    assert.match(shown.text, /DH-1/u)
    assert.match(shown.text, /项目：DH/u, 'the human surface is Chinese (decision 55)')

    const bad = await run('show nope')
    assert.equal(bad.kind, 'error')
    assert.match(bad.text, /show 需要一个 issue key/u)
  })

  it('refuses a project key that is a path traversal (decision 162)', async () => {
    const bad = await run('new --project ../../tmp/escaped --summary nope')
    assert.equal(bad.kind, 'error')
    assert.match(bad.text, /不合法/u)
  })

  it('lints the tag registry, and neither command writes a byte (decision 38)', async () => {
    // Both halves matter: a write that *commits* leaves `git status` empty, so the tree alone is not
    // evidence — the tip has to be unchanged too (or a mutating read passes this test).
    const head = await runGit(root, ['rev-parse', 'HEAD'])
    const before = await runGit(root, ['status', '--porcelain'])
    const linted = await run('tags lint')
    assert.equal(linted.kind, 'success', linted.text)
    assert.match(linted.text, /只报告，绝不改写/u)
    await run('show DH-1')
    const after = await runGit(root, ['status', '--porcelain'])
    const headAfter = await runGit(root, ['rev-parse', 'HEAD'])
    assert.equal(after.stdout, before.stdout, 'a read must not change the working tree')
    assert.equal(headAfter.stdout, head.stdout, 'and it must not commit anything either')

    const bad = await run('tags nope')
    assert.equal(bad.kind, 'error')
    assert.match(bad.text, /未知的 tags 动作 "nope"（可选 lint）/u, 'the same sentence the CLI prints (decision 184)')
  })
})

describe('/jira: status reports what the caller may do (decision 177)', () => {
  it('says "writable" when the caller can write, and the reason when it cannot', async () => {
    const yes = await runJiraCommand('status', Object.freeze({ ...options, writable: () => '本会话可以写' }))
    assert.match(yes.text, /可写：本会话可以写/u)
    const no = await runJiraCommand('status', Object.freeze({ ...options, writable: () => '不能写（read-only）' }))
    assert.match(no.text, /可写：不能写（read-only）/u)
    // Without the callback the line is absent — never a hardcoded yes.
    const unknown = await runJiraCommand('status', options)
    assert.equal(/可写：/u.test(unknown.text), false)
  })
})

describe('/jira: status names the last failed push (decision 191)', () => {
  it('shows the failure when there is one, and says nothing when the push went out', async () => {
    const failed = await runJiraCommand('status', Object.freeze({
      ...options,
      pushStatus: async () => '上次推送失败（2026-10-19T13:14:00Z）：rejected: non-fast-forward',
    }))
    assert.match(failed.text, /上次推送失败/u)
    assert.match(failed.text, /non-fast-forward/u)
    const clean = await runJiraCommand('status', Object.freeze({ ...options, pushStatus: async () => undefined }))
    assert.equal(/上次推送失败/u.test(clean.text), false)
  })
})
