/**
 * End-to-end smoke for the jira CLI against a throwaway ledger.
 *
 * The external plugin's `scripts/smoke.mjs` cloned the real ledger and walked 33
 * steps through the built CLI. This port scaffolds a fixture ledger with the
 * store functions, drives the CLI in-process, and keeps the steps that describe
 * the shipped behavior; the two steps that need a live plugin host or a built
 * CLI are recorded in ARCHIVE-SOURCE.md.
 */

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { asIdentity, type Identity, type Timestamp } from '@deepseek-ai/dsh-jira-core/entity.ts'
import { runGit } from '@deepseek-ai/dsh-jira-core/git.ts'
import { writeTextAtomic } from '@deepseek-ai/dsh-jira-core/io.ts'
import { type Result } from '@deepseek-ai/dsh-jira-core/result.ts'
import { scaffoldStore } from '@deepseek-ai/dsh-jira-core/scaffold.ts'
import { createInStore, createStore, storePaths } from '@deepseek-ai/dsh-jira-core/store.ts'
import { removeTree } from '@deepseek-ai/dsh-jira-core/testing/removeTree.ts'
import { runCli, type CliEnv } from '../src/main.ts'

/** One in-process CLI invocation's exit code and captured output. */
interface CliResult {
  code: number
  out: readonly string[]
  err: readonly string[]
}

const CONFIG_FIXTURE = await readFile(new URL('../../jira-core/fixtures/config.md', import.meta.url), 'utf8')
const TAG_FIXTURE = '---\ntype: tag\nname: demo\ndescription: demo tag\n---\n'
const SMOKE_IDENTITY = asIdentity('human:smoke')
if (SMOKE_IDENTITY === undefined) throw new Error('the smoke identity must be a human identity')
const ACTOR: Readonly<{ by: Identity; at: Timestamp }> = Object.freeze({
  by: SMOKE_IDENTITY,
  at: '2026-10-26T00:00:00Z' as Timestamp,
})

/** Unwrap a store result, naming the error when it refused. */
const valueOf = <T>(result: Result<T, unknown>): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error))
  return result.value
}

/** Read the one key a command printed, or fail the test. */
const keyOf = (text: string, pattern: RegExp): string => {
  const key = pattern.exec(text)?.[1]
  if (key === undefined) throw new Error(`no key in: ${text}`)
  return key
}

const work = await mkdtemp(join(tmpdir(), 'dsh-jira-smoke-'))
const root = join(work, 'store')
const otherRoot = join(work, 'other-store')
let env: CliEnv = {}
let seededOne = ''
let seededTwo = ''
let createdKey = ''
let knowledgeKey = ''

const run = async (argv: readonly string[]): Promise<CliResult> => {
  const out: string[] = []
  const err: string[] = []
  const code = await runCli({ argv, env, cwd: process.cwd(), io: { out: line => out.push(line), err: line => err.push(line) } })
  return { code, out, err }
}

const text = (result: CliResult): string => [...result.out, ...result.err].join('\n')

beforeAll(async () => {
  const home = join(work, 'home')
  await mkdir(home, { recursive: true })
  env = { DSH_HOME: home, DSH_MACHINE_ID: 'smoke-machine' }

  valueOf(await scaffoldStore(root))
  valueOf(await scaffoldStore(otherRoot))
  await writeTextAtomic(storePaths.config(root), CONFIG_FIXTURE)
  await mkdir(join(root, 'tags'), { recursive: true })
  await writeTextAtomic(join(root, 'tags', 'demo.md'), TAG_FIXTURE)
  expect((await runGit(root, ['config', '--local', 'user.name', 'smoke'])).code).toBe(0)
  expect((await runGit(root, ['config', '--local', 'user.email', 'smoke@example.invalid'])).code).toBe(0)

  const store = createStore({ root, machineId: 'smoke-machine' })
  seededOne = String(valueOf(await createInStore(store, 'SMOKE', ACTOR, {
    issueType: 'task',
    summary: 'seeded one',
    tags: ['demo'],
    body: 'body\n',
  })).key)
  seededTwo = String(valueOf(await createInStore(store, 'SMOKE', ACTOR, {
    issueType: 'bug',
    summary: 'seeded two',
  })).key)
}, 60_000)

afterAll(async () => {
  await removeTree(work)
})

describe('jira CLI smoke', () => {
  it('reads the seeded ledger without writing a byte', async () => {
    expect((await runGit(root, ['status', '--porcelain'])).stdout.trim()).toBe('')

    const all = await run(['list', '--root', root, '--all'])
    expect(all.code).toBe(0)
    expect(text(all)).toContain(seededOne)
    expect(text(all)).toContain(seededTwo)

    for (const argv of [
      ['lint', '--root', root],
      ['lint', '--root', root, '--keys'],
      ['doctor', '--root', root],
      ['tags', 'lint', '--root', root],
      ['project', 'list', '--root', root],
      ['machines', 'list', '--root', root],
      ['hooks', 'status', '--root', root],
      ['kb', 'search', '--root', root, '--query', 'a'],
    ]) {
      const result = await run(argv)
      expect(result.code, `${argv.join(' ')}: ${text(result)}`).toBe(0)
    }

    const board = await run(['board', '--root', root, '--all'])
    expect(board.code).toBe(0)
    expect(text(board)).toContain('todo')

    const htmlPath = join(work, 'board.html')
    const html = await run(['board', '--root', root, '--html', '--all', '--out', htmlPath])
    expect(html.code).toBe(0)
    expect(existsSync(htmlPath)).toBe(true)
    const rendered = await readFile(htmlPath, 'utf8')
    expect(/(?:src|href)\s*=\s*["']?(?:https?:)?\/\//iu.test(rendered)).toBe(false)

    const listed = await run(['list', '--root', root, '--all', '--json'])
    const parsed = JSON.parse(listed.out[0] ?? '[]') as readonly { key: string }[]
    const firstKey = parsed[0]?.key
    expect(firstKey).toBeDefined()
    const one = await run(['get', '--root', root, String(firstKey)])
    expect(one.code).toBe(0)
    expect(text(one)).toContain(String(firstKey))

    const json = await run(['get', '--root', root, seededOne, '--json'])
    const issue = JSON.parse(json.out[0] ?? '{}') as { key: string; status: string }
    expect(issue.key).toBe(seededOne)
    expect(issue.status).toBe('todo')

    // Decision 38: the read surface leaves the store untouched.
    expect((await runGit(root, ['status', '--porcelain'])).stdout.trim()).toBe('')
  }, 60_000)

  it('runs the write lifecycle: create, comment, transition, assign, knowledge, close', async () => {
    const created = await run(['new', '--root', root, '--project', 'SMOKE', '--summary', 'smoke: end to end'])
    expect(created.code).toBe(0)
    createdKey = keyOf(text(created), /(SMOKE-\d+)/u)

    expect((await run(['comment', '--root', root, createdKey, '--body', 'smoke comment'])).code).toBe(0)

    // The fixture vocabulary has no `todo → closed`; the refusal names the legal targets.
    const illegal = await run(['switch', '--root', root, seededTwo, '--to', 'closed', '--resolution', 'fixed'])
    expect(illegal.code).toBe(1)
    expect(text(illegal)).toContain('INVALID_TRANSITION')
    expect((await run(['switch', '--root', root, seededTwo, '--to', 'in_progress'])).code).toBe(0)

    expect((await run(['switch', '--root', root, createdKey, '--to', 'in_progress'])).code).toBe(0)
    expect((await run(['assignee', '--root', root, createdKey])).code).toBe(0)

    const knowledge = await run(['kb', 'create', '--root', root, '--domain', 'smoke', '--type', 'howto',
      '--title', 'smoke entry', '--body', 'smoke body with mkdir.', '--issues', createdKey])
    expect(knowledge.code).toBe(0)
    knowledgeKey = keyOf(text(knowledge), /(KB-\d+)/u)

    expect((await run(['kb', 'update', '--root', root, knowledgeKey, '--title', 'smoke entry (edited)'])).code).toBe(0)
    expect((await run(['update', '--root', root, createdKey, '--kb-refs', knowledgeKey])).code).toBe(0)
    expect((await run(['switch', '--root', root, createdKey, '--to', 'closed', '--resolution', 'fixed'])).code).toBe(0)

    const found = await run(['kb', 'search', '--root', root, '--query', 'mkdir'])
    expect(found.code).toBe(0)
    expect(text(found)).toContain(knowledgeKey)

    const closed = await run(['get', '--root', root, createdKey])
    expect(text(closed)).toContain('closed')
  }, 60_000)

  it('regenerates derived files and passes its own checks', async () => {
    expect((await run(['generate', '--root', root])).code).toBe(0)
    expect((await run(['generate', '--root', root, '--check'])).code).toBe(0)
    expect((await run(['lint', '--root', root])).code).toBe(0)
    expect((await run(['doctor', '--root', root])).code).toBe(0)

    const compared = await run(['lint', '--root', root, '--keys', '--compare', otherRoot])
    expect(compared.code).toBe(0)
    expect(text(compared)).toContain('只在 本账本')
  }, 60_000)

  it('binds commit messages to an existing issue key', async () => {
    const valid = join(work, 'valid-msg.txt')
    const missing = join(work, 'missing-msg.txt')
    const unknown = join(work, 'unknown-msg.txt')
    await writeFile(valid, `${seededOne}: fix the wake lock\n`, 'utf8')
    await writeFile(missing, 'no key here\n', 'utf8')
    await writeFile(unknown, 'SMOKE-9999: fix the wake lock\n', 'utf8')

    expect((await run(['verify-commit-msg', '--root', root, valid])).code).toBe(0)
    const refused = await run(['verify-commit-msg', '--root', root, missing])
    expect(refused.code).toBe(1)
    expect(text(refused)).toContain('commit refused')
    const absent = await run(['verify-commit-msg', '--root', root, unknown])
    expect(absent.code).toBe(1)
    expect(text(absent)).toContain('these keys do not exist')

    // The decision-67 binding as history: every commit this walk made names a key or opts out.
    const subjects = (await runGit(root, ['log', '--format=%s'])).stdout.trim().split('\n').filter(Boolean)
    expect(subjects.length).toBeGreaterThan(3)
    for (const subject of subjects) {
      expect(/\b[A-Z][A-Z0-9]{1,5}-\d+\b/u.test(subject) || subject.includes('[no-issue]'), subject).toBe(true)
    }
  }, 60_000)

  it('installs, reports and removes the git hooks', async () => {
    const installed = await run(['hooks', 'install', '--root', root])
    expect(installed.code).toBe(0)
    expect(text(installed)).toContain('已安装')
    const shim = await readFile(join(root, '.git', 'hooks', 'commit-msg'), 'utf8')
    expect(shim).toContain('dsh-jira hook shim')
    expect(shim).toContain('verify-commit-msg')
    expect(text(await run(['hooks', 'status', '--root', root]))).toContain('✓ commit-msg')
    expect((await run(['hooks', 'uninstall', '--root', root])).code).toBe(0)
    expect(text(await run(['hooks', 'status', '--root', root]))).not.toContain('✓ commit-msg')
  }, 60_000)
})
