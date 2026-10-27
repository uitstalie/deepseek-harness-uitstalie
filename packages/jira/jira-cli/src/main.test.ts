/**
 * Tests for the CLI, driven in-process against a real temp store (decision 83 + §3.1 ①).
 *
 * The path exercised here is the one a person actually walks: `init` → `new` → `list` →
 * `board` → `comment` → `switch` → `doctor` → `sync`, with `--json` checked as its own
 * contract because agents read it.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { runCli, type CliEnv } from './main.ts'
import { runGit } from '@deepseek-ai/dsh-jira-core/git.ts'
import { removeTree } from '@deepseek-ai/dsh-jira-core/testing/removeTree.ts'

let root = ''
let env: CliEnv = {}

const run = async (argv: readonly string[]): Promise<{ code: number; out: string[]; err: string[] }> => {
  const out: string[] = []
  const err: string[] = []
  // Decision 187: `cwd` is part of the request now. Passing the real one keeps these tests exactly
  // as they were — the workspace resolution tests exercise the repository root either way.
  const code = await runCli({ argv, env, cwd: process.cwd(), io: { out: line => out.push(line), err: line => err.push(line) } })
  return { code, out, err }
}

/** Every temp directory this file makes, so `after` can remove them (decision 170). */
const tempDirs: string[] = []
const tempDir = async (prefix: string): Promise<string> => {
  const made = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(made)
  return made
}

before(async () => {
  root = await tempDir('dsh-jira-cli-')
  env = { DSH_MACHINE_ID: 'cli-machine' }
})

after(async () => {
  // Decision 170: every temp store this file made is removed — they used to be left behind in %TEMP%
  // (seven of them, each with a `.git`), so a full run leaked a small repository per test. The
  // shared removeTree retries the ENOTEMPTY a still-finishing git helper can cause (DPMJ-201).
  for (const dir of tempDirs) await removeTree(dir)
})

describe('cli: usage and mistakes', () => {
  it('prints the usage with no arguments', async () => {
    const result = await run([])
    assert.equal(result.code, 0)
    // Decision 55: the help is the human surface, so it speaks Chinese.
    assert.match(result.out.join('\n'), /jira — 跨机器 issue 账本/)
  })

  it('names an unknown command and an unknown flag', async () => {
    const command = await run(['frobnicate'])
    assert.equal(command.code, 2)
    assert.match(command.err.join('\n'), /未知命令 "frobnicate"/)

    const flag = await run(['list', '--porject', 'DH', '--root', root])
    assert.equal(flag.code, 2)
    assert.match(flag.err.join('\n'), /未知的 flag --porject/)
  })

  it('refuses to guess the store root', async () => {
    const result = await run(['list'])
    assert.equal(result.code, 2)
    assert.match(result.err.join('\n'), /无法确定账本根目录/)
  })
})

describe('cli: the walk a person takes', () => {
  it('initialises a store, and says what it created', async () => {
    const result = await run(['init', '--root', root])
    assert.equal(result.code, 0)
    assert.match(result.out.join('\n'), /动作：scaffolded/)
    assert.match(result.out.join('\n'), /remote: 无（仅本地）/)
    assert.match(result.out.join('\n'), /本机：/)

    const json = await run(['init', '--root', root, '--json'])
    const value = JSON.parse(json.out[0] ?? '{}') as { action: string; remote?: string; machine: string }
    assert.equal(value.action, 'unchanged', 'the second run changes nothing')
    assert.equal(value.remote, undefined)
    assert.match(value.machine, /^[a-z0-9-]+$/)
  })

  it('creates an issue and prints its key', async () => {
    const result = await run(['new', '--root', root, '--project', 'DH', '--summary', 'first one', '--priority', 'S1'])
    assert.equal(result.code, 0, result.err.join('\n'))
    assert.match(result.out.join('\n'), /^DH-1 已创建/)

    const second = await run(['new', '--root', root, '--project', 'DH', '--summary', 'second one'])
    assert.equal(second.code, 0)
    assert.match(second.out.join('\n'), /DH-2 已创建/)
  })

  it('lists open issues and, with --all, the closed ones too', async () => {
    const open = await run(['list', '--root', root])
    assert.match(open.out.join('\n'), /DH-1\s+todo\s+S1\s+first one/)

    await run(['switch', '--root', root, 'DH-2', '--to', 'closed', '--resolution', 'fixed'])
    const stillOpen = await run(['list', '--root', root])
    assert.equal(stillOpen.out.join('\n').includes('DH-2'), false, 'closed issues are out of the default list')

    const all = await run(['list', '--root', root, '--all'])
    assert.equal(all.out.join('\n').includes('DH-2'), true)

    const filtered = await run(['list', '--root', root, '--status', 'closed', '--all'])
    assert.equal(filtered.out.join('\n').includes('DH-1'), false)
    assert.equal(filtered.out.join('\n').includes('DH-2'), true)
  })

  it('renders the board in the vocabulary\'s column order', async () => {
    const result = await run(['board', '--root', root])
    const lines = result.out.join('\n').split('\n')
    assert.match(lines[0] ?? '', /^todo（1）$/)
    assert.ok(lines.findIndex(line => line.startsWith('closed（')) > lines.findIndex(line => line.startsWith('todo（')))
  })

  it('reads one issue back, as text and as JSON', async () => {
    const text = await run(['get', '--root', root, 'DH-1'])
    assert.equal(text.code, 0)
    assert.match(text.out.join('\n'), /DH-1/)
    // Decision 55: the CLI is the human surface, so the labels are Chinese and the data is not.
    assert.match(text.out.join('\n'), /项目：DH {3}类型：task/)
    assert.match(text.out.join('\n'), /认领：（未认领）/)

    const json = await run(['get', '--root', root, 'DH-1', '--json'])
    const issue = JSON.parse(json.out[0] ?? '{}') as { key: string; status: string; revision: number }
    assert.equal(issue.key, 'DH-1')
    assert.equal(issue.status, 'todo')
    assert.equal(issue.revision, 1)
  })

  it('comments, and then refuses an illegal transition with the legal ones named', async () => {
    const comment = await run(['comment', '--root', root, 'DH-1', '--body', 'a note from the CLI'])
    assert.equal(comment.code, 0, comment.err.join('\n'))
    assert.match(comment.out.join('\n'), /已在 DH-1 上追加评论/)

    const illegal = await run(['switch', '--root', root, 'DH-1', '--to', 'in_review'])
    assert.equal(illegal.code, 1)
    assert.match(illegal.err.join('\n'), /INVALID_TRANSITION/)

    const noResolution = await run(['switch', '--root', root, 'DH-1', '--to', 'closed'])
    assert.equal(noResolution.code, 1)
    assert.match(noResolution.err.join('\n'), /RESOLUTION_REQUIRED/)
  })

  it('refuses a project key that is a path traversal, and creates nothing (decision 162)', async () => {
    // No `new` with a *valid* key here on purpose: this store is shared by the whole walk, and one more
    // issue would change the counts the later tests assert.
    const traversal = await run(['new', '--root', root, '--project', '../../tmp/escaped', '--summary', 'nope'])
    assert.equal(traversal.code, 2, traversal.err.join('\n'))
    assert.match(traversal.err.join('\n'), /不合法/u)

    // The key is a path segment: if it got through, `projects/../../tmp/escaped/issues` would exist.
    assert.equal(existsSync(join(root, 'projects', '..', '..', 'tmp', 'escaped')), false, 'nothing escaped the store')
  })

  it('says the machine has no label once, and never in --json (decisions 91/150)', async () => {
    const first = await run(['machines', 'list', '--root', root])
    assert.equal(first.code, 0, first.err.join('\n'))
    assert.match(first.out.join('\n'), /本机：cli-machine/)
    assert.match(first.out.join('\n'), /本机还没有 label/, 'an unnamed machine is told how to name it')

    // The point of the marker: a line that repeats is a line a human learns to skip.
    const second = await run(['machines', 'list', '--root', root])
    assert.equal(second.out.join('\n').includes('本机还没有 label'), false, 'the hint is once per machine')

    // …and stdout stays parseable in JSON mode.
    const json = await run(['machines', 'list', '--root', root, '--json'])
    assert.equal(json.code, 0)
    assert.equal(json.out.join('\n').includes('提示'), false)
  })

  it('reports a store that is not found and a key that is not a key', async () => {
    const missing = await run(['get', '--root', root, 'DH-99'])
    assert.equal(missing.code, 1)
    assert.match(missing.err.join('\n'), /NOT_FOUND/)

    const bad = await run(['get', '--root', root, 'nope'])
    assert.equal(bad.code, 2)
    assert.match(bad.err.join('\n'), /不是 issue key/)
  })

  it('generates the fixed files and every bundle, then says they are up to date', async () => {
    const fresh = await run(['generate', '--root', root])
    assert.equal(fresh.code, 0, fresh.err.join('\n'))
    assert.match(fresh.out.join('\n'), /已生成 6 个文件，0 个已是最新/)

    const again = await run(['generate', '--root', root])
    assert.match(again.out.join('\n'), /已生成 0 个文件，6 个已是最新/, 'regenerating is a no-op')

    for (const name of ['BOARD.md', 'index.md', 'log.md']) {
      const text = await readFile(join(root, name), 'utf8')
      assert.match(text, /generated by dsh-jira — do not edit by hand/)
      assert.match(text, /source_tree: [0-9a-f]{64}/)
    }
    assert.match(await readFile(join(root, 'tags', 'index.md'), 'utf8'), /source_tree: [0-9a-f]{64}/)

    const check = await run(['generate', '--root', root, '--check'])
    assert.equal(check.code, 0)
    assert.match(check.out.join('\n'), /派生文件已是最新/)
  })

  it('fails generate --check once an input moved, and names the file', async () => {
    const stalePaths = async (): Promise<readonly string[]> => {
      const check = await run(['generate', '--root', root, '--check', '--json'])
      const value = JSON.parse(check.out[0] ?? '{}') as { stale: readonly { path: string; reason: string }[] }
      return value.stale.map(entry => entry.path)
    }

    // A comment does not change the issue (decision 44) and is not a generated input, so only
    // `log.md` moves — its input is the commit the comment created (decision 120's asymmetry).
    assert.equal((await run(['comment', '--root', root, 'DH-1', '--body', 'a change that moves nothing else'])).code, 0)
    // Decision 79: every bundle keeps its own commit log, so a commit moves all of them.
    assert.deepEqual(await stalePaths(), ['log.md', 'projects/DH/log.md'])

    // Changing a field the board shows does make BOARD.md stale, and the exit code says so.
    assert.equal((await run(['switch', '--root', root, 'DH-1', '--to', 'in_progress'])).code, 0)
    const check = await run(['generate', '--root', root, '--check'])
    assert.equal(check.code, 1, 'CI reads this exit code')
    assert.match(check.out.join('\n'), /BOARD\.md（stale）/)

    assert.equal((await run(['generate', '--root', root])).code, 0)
    assert.deepEqual(await stalePaths(), [], 'clean again')
  })

  it('reports generated files in the doctor, and not the freshness it cannot prove', async () => {
    const doctor = await run(['doctor', '--root', root, '--json'])
    const report = JSON.parse(doctor.out[0] ?? '{}') as { problems: readonly { code: string }[]; summary: { generated_stale: number } }
    assert.equal(report.summary.generated_stale, 0)
    assert.equal(report.problems.some(problem => problem.code.startsWith('generated-')), false)

    await rm(join(root, 'index.md'))
    const after = JSON.parse((await run(['doctor', '--root', root, '--json'])).out[0] ?? '{}') as { problems: readonly { code: string; path?: string }[] }
    assert.ok(after.problems.some(problem => problem.code === 'generated-missing' && problem.path === 'index.md'))
    await run(['generate', '--root', root])
  })

  it('warns a human before a manual push when the derived files are stale (decision 179)', async () => {
    // Decision 148's settle step lives in the plugin queue and `jira sync`; a manual `git push`
    // skips both, so the only defence is a warning a human will actually read.
    assert.equal((await run(['generate', '--root', root])).code, 0)
    assert.equal((await run(['update', '--root', root, 'DH-1', '--summary', 'moves the board'])).code, 0)
    const stale = await run(['doctor', '--root', root])
    assert.match(stale.out.join('\n'), /派生文件已过期：推送前先 `jira sync`/)
    assert.match(stale.out.join('\n'), /手工 `git push` 不会重生成/)

    assert.equal((await run(['generate', '--root', root])).code, 0)
    const fresh = await run(['doctor', '--root', root])
    assert.equal(/派生文件已过期/u.test(fresh.out.join('\n')), false, 'no warning once the files are fresh')
  })
  it('updates an issue, including the kb_refs side of the cross reference', async () => {
    const updated = await run(['update', '--root', root, 'DH-1', '--summary', 'renamed by the CLI', '--kb-refs', 'KB-1,KB-2'])
    assert.equal(updated.code, 0, updated.err.join('\n'))
    assert.match(updated.out.join('\n'), /DH-1 已更新（版本 \d+）/)

    const read = JSON.parse((await run(['get', '--root', root, 'DH-1', '--json'])).out[0] ?? '{}') as {
      summary: string
      kb_refs: readonly string[]
    }
    assert.equal(read.summary, 'renamed by the CLI')
    assert.deepEqual(read.kb_refs, ['KB-1', 'KB-2'])
  })

  it('refuses a kb_ref that is not a knowledge key', async () => {
    const bad = await run(['update', '--root', root, 'DH-1', '--kb-refs', 'DH-2'])
    assert.equal(bad.code, 1)
    assert.match(bad.err.join('\n'), /is not a knowledge key/)
  })

  it('walks the knowledge base from the command line', async () => {
    const created = await run([
      'kb', 'create', '--root', root, '--domain', 'cli', '--type', 'howto',
      '--title', '用 CLI 写知识条目', '--tags', 'cli', '--body', '一行正文，含关键词 mkdir。\n',
      '--issues', 'DH-1',
    ])
    assert.equal(created.code, 0, created.err.join('\n'))
    assert.match(created.out.join('\n'), /^KB-1 已创建/)

    const listed = await run(['kb', 'search', '--root', root, 'mkdir'])
    assert.equal(listed.code, 0)
    assert.match(listed.out.join('\n'), /KB-1/)
    assert.match(listed.out.join('\n'), /knowledge\/cli\/KB-1\.md:1/)

    // The human surface answers in Chinese (decision 55); the same renderer's English is the
    // `jira_kb` tool's view and is pinned by core/kbsearch.test.ts.
    const nothing = await run(['kb', 'search', '--root', root, '--query', 'zzz-not-here'])
    assert.equal(nothing.code, 0)
    assert.match(nothing.out.join('\n'), /没有匹配的知识条目/)

    const asJson = await run(['kb', 'search', '--root', root, '--query', 'mkdir', '--json'])
    const hits = JSON.parse(asJson.out[0] ?? '{}') as { hits: readonly { key: string; file: string; line: number; snippet: string }[]; counts: { matched: number } }
    assert.equal(hits.hits.length, 1)
    assert.equal(hits.hits[0]?.file, 'knowledge/cli/KB-1.md')
    assert.equal(Object.hasOwn(hits.hits[0] ?? {}, 'body'), false)

    const got = await run(['kb', 'get', '--root', root, 'KB-1'])
    assert.equal(got.code, 0)
    assert.match(got.out.join('\n'), /\[howto\]/)
    assert.match(got.out.join('\n'), /issues: DH-1/)

    const changed = await run(['kb', 'update', '--root', root, 'KB-1', '--title', '改过的标题'])
    assert.equal(changed.code, 0, changed.err.join('\n'))
    assert.match(changed.out.join('\n'), /KB-1 已更新/)
  })

  it('names the mistakes a knowledge command can make', async () => {
    const noQuery = await run(['kb', 'search', '--root', root])
    assert.equal(noQuery.code, 2)
    assert.match(noQuery.err.join('\n'), /kb search 需要检索词/)

    const noKey = await run(['kb', 'get', '--root', root])
    assert.equal(noKey.code, 2)
    assert.match(noKey.err.join('\n'), /kb get 需要一个 <KEY>/)

    const badKey = await run(['kb', 'get', '--root', root, 'DH-1'])
    assert.equal(badKey.code, 2)
    assert.match(badKey.err.join('\n'), /kb get 需要一个 <KEY>/)

    const unknown = await run(['kb', 'frobnicate', '--root', root, 'KB-1'])
    assert.equal(unknown.code, 2)
    assert.match(unknown.err.join('\n'), /未知的 kb 动作 "frobnicate"/)

    const missing = await run(['kb', 'get', '--root', root, 'KB-99'])
    assert.equal(missing.code, 1)
    assert.match(missing.err.join('\n'), /knowledge entry KB-99 not found/)
  })
  it('lists the keys, and compares two stores without merging anything', async () => {
    const other = await tempDir('dsh-jira-cli-keys-')
    assert.equal((await run(['init', '--root', other])).code, 0)

    const here = await tempDir('dsh-jira-cli-keys-here-')
    assert.equal((await run(['init', '--root', here])).code, 0)
    await run(['new', '--root', here, '--project', 'DH', '--summary', 'only here'])
    await run(['new', '--root', other, '--project', 'DH', '--summary', 'only there'])

    const inventory = await run(['lint', '--root', here, '--keys'])
    assert.equal(inventory.code, 0, inventory.err.join('\n'))
    assert.match(inventory.out.join('\n'), /DH（1）：/)
    assert.match(inventory.out.join('\n'), /本账本：1 个 key/)

    const comparison = await run(['lint', '--root', here, '--keys', '--compare', other])
    assert.equal(comparison.code, 0, comparison.err.join('\n'))
    const text = comparison.out.join('\n')
    assert.match(text, /同 key 但 summary 不同（1）/, 'DH-1 exists on both sides with different summaries')
    assert.match(text, /只在 本账本（0）/)
    assert.match(comparison.out.join('\n'), /映射表写到 _merge\/<UTC>-from-<machine_id>\.md/u)
  })

  it('emits a self-contained HTML board, and writes it where it is told', async () => {
    const own = await tempDir('dsh-jira-cli-html-')
    assert.equal((await run(['init', '--root', own])).code, 0)
    // A summary carrying markup: the board must escape it, not render it.
    assert.equal((await run(['new', '--root', own, '--project', 'DH', '--summary', 'a <b>bold</b> request'])).code, 0)

    const printed = await run(['board', '--root', own, '--html', '--all'])
    assert.equal(printed.code, 0, printed.err.join('\n'))
    const html = printed.out.join('\n')
    assert.match(html, /^<!doctype html>/)
    assert.equal(html.includes('<script'), false)
    assert.match(html, /&lt;b&gt;bold&lt;\/b&gt;/, 'store text is escaped')

    const target = join(own, 'board-out.html')
    const written = await run(['board', '--root', own, '--html', '--all', '--out', target])
    assert.equal(written.code, 0, written.err.join('\n'))
    assert.match(written.out.join('\n'), /board-out\.html 已写出/)
    assert.match(await readFile(target, 'utf8'), /^<!doctype html>/)
  })
  it('links two issues and takes the link away again', async () => {
    // Its own store: these tests create issues, and the shared store's counts are asserted above.
    const own = await tempDir('dsh-jira-cli-link-')
    assert.equal((await run(['init', '--root', own])).code, 0)
    const first = await run(['new', '--root', own, '--project', 'DH', '--summary', 'the blocker'])
    assert.equal(first.code, 0, first.err.join('\n'))
    const second = await run(['new', '--root', own, '--project', 'DH', '--summary', 'the blocked one'])
    assert.equal(second.code, 0, second.err.join('\n'))
    const blocked = /(DH-\d+)/.exec(second.out.join('\n'))?.[1]
    const blocker = /(DH-\d+)/.exec(first.out.join('\n'))?.[1]
    assert.ok(blocked !== undefined && blocker !== undefined)

    const linked = await run(['link', '--root', own, blocked, '--type', 'is_blocked_by', '--target', blocker])
    assert.equal(linked.code, 0, linked.err.join('\n'))
    assert.match(linked.out.join('\n'), new RegExp(`${blocked} 已链接到 ${blocker}（is_blocked_by）`))

    const read = await run(['get', '--root', own, blocked, '--json'])
    const issue = JSON.parse(read.out[0] ?? '{}') as { links: readonly { type: string; target: string }[] }
    assert.deepEqual(issue.links.map(entry => [entry.type, entry.target]), [['is_blocked_by', blocker]])

    const removed = await run(['link', '--root', own, blocked, '--type', 'is_blocked_by', '--target', blocker, '--remove'])
    assert.equal(removed.code, 0, removed.err.join('\n'))
    assert.match(removed.out.join('\n'), /已解除链接/)
    const after = await run(['get', '--root', own, blocked, '--json'])
    assert.deepEqual((JSON.parse(after.out[0] ?? '{}') as { links: unknown[] }).links, [])
  })

  it('claims and releases an issue, and names the mistakes it can make', async () => {
    const own = await tempDir('dsh-jira-cli-assignee-')
    assert.equal((await run(['init', '--root', own])).code, 0)
    const created = await run(['new', '--root', own, '--project', 'DH', '--summary', 'claimable'])
    const key = /(DH-\d+)/.exec(created.out.join('\n'))?.[1]
    assert.ok(key !== undefined)

    const claimed = await run(['assignee', '--root', own, key])
    assert.equal(claimed.code, 0, claimed.err.join('\n'))
    assert.match(claimed.out.join('\n'), /已认领给 human:/)

    const released = await run(['assignee', '--root', own, key, '--set', 'none'])
    assert.equal(released.code, 0)
    assert.match(released.out.join('\n'), /已释放/)

    const bad = await run(['assignee', '--root', own, key, '--set', 'someone'])
    assert.equal(bad.code, 2)
    assert.match(bad.err.join('\n'), /assignee --set 只接受 "self" 或 "none"，不接受 "someone"/)

    // DPMJ-5: `--override` used to be a *sibling* of `flags` in the command table, so the parser called
    // it an unknown flag and decision 24's "claim anyway" was unreachable from the CLI — while the usage
    // text still advertised it. An unblocked issue is enough to prove the flag exists and parses.
    const override = await run(['assignee', '--root', own, key, '--override'])
    assert.equal(override.code, 0, override.err.join('\n'))
    assert.match(override.out.join('\n'), /已认领/u)

    assert.equal((await run(['link', '--root', own, key, '--type', 'is_blocked_by'])).code, 2, 'link needs --target')
    assert.equal((await run(['link', '--root', own, key, '--target', 'DH-1'])).code, 2, 'link needs --type')
    assert.equal((await run(['link', '--root', own, key, '--type', 'is_blocked_by', '--target', 'nope'])).code, 2)
  })
  it('refuses a write whose expected revision is stale, with the typed code (decision 44)', async () => {
    const own = await tempDir('dsh-jira-cli-cas-')
    assert.equal((await run(['init', '--root', own])).code, 0)
    const created = await run(['new', '--root', own, '--project', 'DH', '--summary', 'first'])
    const key = /(DH-\d+)/.exec(created.out.join('\n'))?.[1]
    assert.ok(key !== undefined)

    // The current revision is 1, so expecting 99 must fail with STALE_REVISION and change nothing.
    const stale = await run(['update', '--root', own, key, '--summary', 'renamed', '--expected-revision', '99'])
    assert.equal(stale.code, 1)
    assert.match(stale.err.join('\n'), /STALE_REVISION/)
    assert.match((await run(['get', '--root', own, key, '--json'])).out.join('\n'), /"summary": "first"/)

    // Expecting the current revision succeeds.
    const fresh = await run(['update', '--root', own, key, '--summary', 'renamed', '--expected-revision', '1'])
    assert.equal(fresh.code, 0, fresh.err.join('\n'))
    assert.match((await run(['get', '--root', own, key, '--json'])).out.join('\n'), /"summary": "renamed"/)
  })
  it('refuses a commit message that names no issue, and explains the fix', async () => {
    const file = join(root, 'COMMIT_EDITMSG')
    await writeFile(file, 'fix something\n', 'utf8')
    const refused = await run(['verify-commit-msg', '--root', root, file])
    assert.equal(refused.code, 1)
    assert.match(refused.err.join('\n'), /no issue key/)
    assert.match(refused.err.join('\n'), /\[no-issue\] on the first line/)

    await writeFile(file, 'DH-1: fix something\n', 'utf8')
    assert.equal((await run(['verify-commit-msg', '--root', root, file])).code, 0)

    await writeFile(file, 'chore: bump the toolchain [no-issue]\n', 'utf8')
    assert.equal((await run(['verify-commit-msg', '--root', root, file])).code, 0)

    await writeFile(file, 'Merge branch main\n', 'utf8')
    assert.equal((await run(['verify-commit-msg', '--root', root, file])).code, 0, 'git wrote this one')

    await writeFile(file, '# a comment only\n', 'utf8')
    assert.equal((await run(['verify-commit-msg', '--root', root, file])).code, 1, 'comments are not the message')

    await writeFile(file, 'DH-404: does not exist\n', 'utf8')
    const unknown = await run(['verify-commit-msg', '--root', root, file])
    assert.equal(unknown.code, 1)
    assert.match(unknown.err.join('\n'), /do not exist: DH-404/)
  })

  it('accepts a knowledge key, because the ledger includes the library', async () => {
    const file = join(root, 'KBMSG')
    await writeFile(file, 'KB-1: kb create\n', 'utf8')
    assert.equal((await run(['verify-commit-msg', '--root', root, file])).code, 0)
  })

  it('accepts the three arguments git passes to prepare-commit-msg', async () => {
    // git calls `prepare-commit-msg <file> <source> <sha>`. A strict positional limit made
    // `git commit -C HEAD` abort with "expected at most 3 argument(s), got 4" — a broken commit, not
    // a broken message. This test is the regression for that.
    const file = join(root, 'PREPARE_ARGS')
    await writeFile(file, 'fix the wake lock\n', 'utf8')
    assert.equal((await run(['hooks', 'prepare-commit-msg', '--root', root, file, 'commit', 'HEAD'])).code, 0)
    assert.equal((await run(['hooks', 'prepare-commit-msg', '--root', root, file, 'merge', ''])).code, 0)
    assert.equal(await readFile(file, 'utf8'), 'fix the wake lock\n', 'branch main carries no key, so nothing is prefixed')

    // And `verify-commit-msg` tolerates the optional source, while still refusing a keyless subject.
    const message = join(root, 'VERIFY_ARGS')
    await writeFile(message, 'no key at all\n', 'utf8')
    assert.equal((await run(['verify-commit-msg', '--root', root, message, 'commit'])).code, 1)
    await writeFile(message, 'chore: bump [no-issue]\n', 'utf8')
    assert.equal((await run(['verify-commit-msg', '--root', root, message, 'commit'])).code, 0)
  })
  it('installs, reports and removes the commit-msg hooks', async () => {
    const installed = await run(['hooks', 'install', '--root', root])
    assert.equal(installed.code, 0, installed.err.join('\n'))
    assert.match(installed.out.join('\n'), /已安装 commit-msg, prepare-commit-msg/)

    const status = await run(['hooks', 'status', '--root', root, '--json'])
    const states = JSON.parse(status.out[0] ?? '[]') as readonly { kind: string; installed: boolean }[]
    assert.deepEqual(states.map(state => state.installed), [true, true])

    const removed = await run(['hooks', 'uninstall', '--root', root])
    assert.equal(removed.code, 0)
    assert.match(removed.out.join('\n'), /已恢复：commit-msg, prepare-commit-msg/)
    assert.equal((await run(['hooks', 'frobnicate', '--root', root])).code, 2)
  })

  it('prepares a commit message from the branch name', async () => {
    const file = join(root, 'PREPARE')
    await writeFile(file, 'fix the wake lock\n', 'utf8')
    // The store's own repository is on whatever branch this checkout uses; branch `main` carries no
    // key, so nothing is prefixed and the file is left alone.
    assert.equal((await run(['hooks', 'prepare-commit-msg', '--root', root, file])).code, 0)
    assert.equal(await readFile(file, 'utf8'), 'fix the wake lock\n')
  })

  it('lints the tag registry in three sections, and never rewrites it', async () => {
    const headBefore = (await runGit(root, ['rev-parse', 'HEAD'])).stdout
    const statusBefore = (await runGit(root, ['status', '--porcelain'])).stdout
    const report = await run(['tags', 'lint', '--root', root])
    assert.equal(report.code, 0)
    const text = report.out.join('\n')
    assert.match(text, /只用过一次/)
    assert.match(text, /缺少 description/)
    assert.match(text, /相似对，Dice ≥ 0.7/)
    assert.match(text, /只报告，绝不改写/)

    // "只报告，绝不改写"需要证据，不是文案：HEAD 不动、工作树不新增任何东西
    // （基线里已有钩子测试留下的未跟踪文件，所以比的是**前后一致**，不是空）。
    assert.equal((await runGit(root, ['rev-parse', 'HEAD'])).stdout, headBefore, 'lint commits nothing')
    assert.equal((await runGit(root, ['status', '--porcelain'])).stdout, statusBefore, 'lint writes nothing')

    const asJson = await run(['tags', 'lint', '--root', root, '--json'])
    const parsed = JSON.parse(asJson.out[0] ?? '{}') as { counts: { tags: number } }
    assert.equal(parsed.counts.tags, 0, '注册表是空的——`cli` 只是被用过（出现在「只用过一次」段），从未注册')
  })

  it('lists, binds and rebinds projects', async () => {
    const bound = await run(['project', 'bind', '--root', root, '--key', 'DH', '--path', 'D:/Work/DH', '--remote', 'git@github.com:o/r.git', '--name', 'ledger'])
    assert.equal(bound.code, 0, bound.err.join('\n'))
    assert.match(bound.out.join('\n'), /DH 已绑定到/)
    assert.match(bound.out.join('\n'), /身份：github\.com\/o\/r/)

    const listed = await run(['project', 'list', '--root', root])
    assert.match(listed.out.join('\n'), /身份：github\.com\/o\/r/)

    const other = await run(['project', 'bind', '--root', root, '--key', 'OTHER', '--path', 'D:/Work/Other'])
    assert.equal(other.code, 0)
    const rebound = await run(['project', 'rebind', '--root', root, '--from', 'DH', '--to', 'OTHER', '--path', 'D:/Work/DH'])
    assert.equal(rebound.code, 0, rebound.err.join('\n'))
    assert.match(rebound.out.join('\n'), /已移动/)

    assert.equal((await run(['project', 'bind', '--root', root])).code, 2, 'bind needs --key')
    assert.equal((await run(['project', 'frobnicate', '--root', root])).code, 2)
  })
  it('syncs without a remote, and says why nothing was pushed', async () => {
    const result = await run(['sync', '--root', root, '--json'])
    const value = JSON.parse(result.out[0] ?? '{}') as { pushed: boolean; remote: boolean; detail: string }
    assert.equal(value.pushed, false)
    assert.equal(value.remote, false)
    assert.match(value.detail, /no remote/)
    assert.equal(result.code, 0, 'no remote is not a failure')
  })

  it('fails the command when a sync cannot push (DH-306)', async () => {
    // Its own store: adding a remote to the shared one would change the walk's later answers.
    const own = await tempDir('dsh-jira-cli-syncfail-')
    assert.equal((await run(['init', '--root', own])).code, 0)
    // Pull and settle still work; only the push URL is gone, so the exit code must say "failed".
    await runGit(own, ['remote', 'add', 'origin', join(own, 'missing.git')])
    const failed = await run(['sync', '--root', own])
    assert.equal(failed.code, 1, failed.out.join('\n'))
  })

  it('checks the store it just built', async () => {
    const result = await run(['doctor', '--root', root, '--json'])
    const report = JSON.parse(result.out[0] ?? '{}') as { ok: boolean; problems: { code: string }[]; summary: { issues: number } }
    assert.equal(report.summary.issues, 2)
    assert.equal(report.problems.filter(problem => problem.code === 'config-missing').length, 0)
    assert.equal(result.code, 0, JSON.stringify(report.problems))
  })

  it('prints the doctor report for a human too', async () => {
    const result = await run(['doctor', '--root', root])
    assert.match(result.out.join('\n'), /账本：1 个项目，2 条 issue/)
    assert.match(result.out.join('\n'), /结果：正常/)
  })
})
