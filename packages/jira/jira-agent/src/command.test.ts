/**
 * Tests for `/jira` — the command surface, driven in-process against a real temp store.
 *
 * The command must answer the questions a person asks *about* the ledger, and it must never
 * disagree with the CLI (they share `core`); these tests check the answers, not the wording.
 */

import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { removeTree } from '@deepseek-ai/dsh-jira-core/testing/removeTree.ts'
import { runGit } from '@deepseek-ai/dsh-jira-core/git.ts'
import { applyTransition } from '@deepseek-ai/dsh-jira-core/mutate.ts'
import { scaffoldStore } from '@deepseek-ai/dsh-jira-core/scaffold.ts'
import { createStore, transact } from '@deepseek-ai/dsh-jira-core/store.ts'
import { runJiraCommand, type CommandOptions } from './command.ts'

let root = ''
let options: CommandOptions

const run = async (rawInput: string) => runJiraCommand(rawInput, options)

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-jira-command-'))
  const scaffolded = await scaffoldStore(root)
  assert.equal(scaffolded.ok, true)
  await runGit(root, ['config', '--local', 'user.name', 'tester'])
  await runGit(root, ['config', '--local', 'user.email', 'tester@example.invalid'])
  options = Object.freeze({
    root: () => ({ ok: true, value: root } as const),
    machineId: () => 'command-machine',
    host: 'command-host',
    identity: () => 'human:tester',
    now: () => '2026-10-15T12:00:00Z',
  })
})

after(async () => {
  if (root !== '') await removeTree(root)
})

describe('/jira: creating and reading back', () => {
  it('creates an issue and reports its key', async () => {
    const created = await run('new --project DH --summary "first from the command"')
    assert.equal(created.kind, 'success')
    assert.match(created.text, /^DH-1 已创建/)

    const second = await run('new --project DH --summary second')
    assert.equal(second.kind, 'success')
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
    assert.equal(status.kind, 'success')
    assert.match(status.text, /词表：\d+ 个状态，\d+ 条迁移/)
    assert.match(status.text, /issue：2 条，分布在 1 个项目/)
  })
})

describe('/jira: health, sync and mistakes', () => {
  it('reports health and pushes nothing without a remote', async () => {
    const doctor = await run('doctor')
    assert.equal(doctor.kind, 'success')
    assert.match(doctor.text, /结果：/)

    const sync = await run('sync')
    assert.equal(sync.kind, 'success')
    assert.match(sync.text, /remote：无/)
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

  it('answers a broken store configuration instead of throwing', async () => {
    const broken = Object.freeze({ ...options, root: () => ({ ok: false as const, error: { code: 'INVALID_INPUT' as const, message: 'no root' } }) })
    const result = await runJiraCommand('status', broken)
    assert.equal(result.kind, 'error')
    assert.match(result.text, /no root/)
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
    assert.equal(after.stdout, '', 'and the tree was clean to begin with')
    assert.equal(headAfter.stdout, head.stdout, 'and it must not commit anything either')

    const bad = await run('tags nope')
    assert.equal(bad.kind, 'error')
    assert.match(bad.text, /未知的 tags 动作 "nope"（可选 lint）/u, 'the same sentence the CLI prints (decision 184)')
  })
})

describe('/jira: sync goes through the service\'s own queue (decision 166)', () => {
  it('asks the ledger service to flush, which is what makes the push safe', async () => {
    // A second queue here meant `/jira sync` neither rebased nor refreshed the derived files, and
    // it did not cancel the debounce the last write had armed. The service owns the one queue.
    let asked = 0
    const result = await runJiraCommand('sync', {
      ...options,
      sync: async () => {
        asked += 1
        return Object.freeze({ ok: true, value: Object.freeze({ kind: 'nothing-to-do', reason: 'the store has no remote' }) } as const)
      },
    })
    assert.equal(result.kind, 'success', result.text)
    assert.equal(asked, 1, 'the flush went through the service')
    assert.match(result.text, /推送：/u)
  })
})

describe('/jira: status reports what the caller may do (decision 177)', () => {
  it('says "writable" when the caller can write, and the reason when it cannot', async () => {
    const yes = await runJiraCommand('status', { ...options, writable: () => '本会话可以写' })
    assert.match(yes.text, /可写：本会话可以写/u)
    const no = await runJiraCommand('status', { ...options, writable: () => '不能写（read-only）' })
    assert.match(no.text, /可写：不能写（read-only）/u)
    // Without the callback the line is absent — never a hardcoded yes.
    const unknown = await runJiraCommand('status', options)
    assert.equal(/可写：/u.test(unknown.text), false)
  })
})

describe('/jira: status names the last failed push (decision 191)', () => {
  it('shows the failure when there is one, and says nothing when the push went out', async () => {
    const failed = await runJiraCommand('status', {
      ...options,
      pushStatus: async () => '上次推送失败（2026-10-19T13:14:00Z）：rejected: non-fast-forward',
    })
    assert.match(failed.text, /上次推送失败/u)
    assert.match(failed.text, /non-fast-forward/u)
    const clean = await runJiraCommand('status', { ...options, pushStatus: async () => undefined })
    assert.equal(/上次推送失败/u.test(clean.text), false)
  })
})
