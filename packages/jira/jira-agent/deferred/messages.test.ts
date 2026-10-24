/**
 * Tests for core/messages — decision 184: one home per command-level sentence.
 *
 * The failure mode this guards: the CLI and the `/jira` command each kept a literal copy of the
 * same sentence, and they drifted ("config.md" vs "config.md 词表"). So the test reads both
 * surfaces' source and proves neither contains the literal text of any message defined here —
 * the only way to say the sentence is to import it.
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { describe, it } from 'node:test'

import * as messages from './messages.ts'

/**
 * The two human surfaces, read as source (tests run from the repository root). The CLI side is
 * split across `main.ts`, `runtime.ts` and `commands/*.ts` (decision 187), so its surface is the
 * concatenation — a sentence spelled out in *any* command file is still a second copy.
 */
const CLI_FILES = [
  'packages/jira/jira-cli/src/main.ts',
  'packages/jira/jira-cli/src/runtime.ts',
  ...readdirSync('packages/jira/jira-cli/src/commands').filter(name => name.endsWith('.ts')).map(name => `packages/jira/jira-cli/src/commands/${name}`),
]
const SURFACES: readonly (readonly [string, string])[] = [
  ['src/cli', CLI_FILES.map(path => readFileSync(path, 'utf8')).join('\n')],
  ['packages/jira/jira-agent/src/command.ts', readFileSync('packages/jira/jira-agent/src/command.ts', 'utf8')],
]

/**
 * Every message, with the fragment(s) that may not appear in a surface's source. Hand-picked so
 * each is long enough to be unambiguous (`需要` alone is in a dozen other messages; the whole
 * sentence is not).
 */
const CASES: readonly (readonly [string, readonly string[]])[] = [
  ['BOARD_NEEDS_VOCAB', ['看板需要可读的 config.md 词表']],
  ['NEW_NEEDS_SUMMARY', ['new 需要 --summary']],
  ['invalidProjectKey', ['不合法（形如 DH：字母数字，至多六位）']],
  ['committedSuffix', ['并已提交']],
  ['createdMessage', ['已创建并已提交']],
  ['updatedMessage', ['已更新并已提交']],
  ['registeredMessage', ['已注册并已提交']],
  ['hiddenIssuesNote', ['条 issue 被隐藏 —— 已关闭或被过滤；用 --all 显示']],
  ['syncPushLine', ['推送：']],
  ['CLOSE_NEEDS_RESOLUTION', ['close 需要 --resolution']],
  ['unknownTagsAction', ['未知的 tags 动作', '（可选 lint）']],
]

describe('messages: one home per sentence (decision 184)', () => {
  it('covers every export, so a message added tomorrow is guarded too', () => {
    assert.deepEqual(Object.keys(messages).sort(), [...CASES.map(([name]) => name)].sort())
  })

  it('no surface carries a second literal copy of any message', () => {
    const leaks: string[] = []
    for (const [name, fragments] of CASES) {
      for (const [path, source] of SURFACES) {
        for (const fragment of fragments) {
          if (source.includes(fragment)) {
            leaks.push(`${name}: "${fragment}" also appears literally in ${path}`)
          }
        }
      }
    }
    assert.deepEqual(leaks, [], 'a sentence spelled out twice is how the two surfaces drift')
  })

  it('both surfaces import the module rather than spelling the sentences out', () => {
    // The CLI's commands live one directory deeper (decision 187), so the import path has one
    // more `../` — the assertion is "imports the module", not "from exactly this depth".
    for (const [path, source] of SURFACES) {
      assert.ok(/from '(?:\.\.\/)+core\/messages\.ts'/u.test(source), `${path} does not import core/messages`)
    }
  })
})
