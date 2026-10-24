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

import * as messages from '@deepseek-ai/dsh-jira-core/messages.ts'

/**
 * The two human surfaces, read as source. The CLI side is split across `main.ts`, `runtime.ts`
 * and `commands/*.ts` (decision 187), so its surface is the concatenation — a sentence spelled
 * out in *any* command file is still a second copy.
 */
const CLI_ROOT = new URL('../../jira-cli/src/', import.meta.url)
const CLI_FILES = [
  new URL('main.ts', CLI_ROOT),
  new URL('runtime.ts', CLI_ROOT),
  ...readdirSync(new URL('commands/', CLI_ROOT))
    .filter(name => name.endsWith('.ts'))
    .map(name => new URL(`commands/${name}`, CLI_ROOT)),
]
const SURFACES: readonly (readonly [string, string])[] = Object.freeze([
  ['jira-cli', CLI_FILES.map(url => readFileSync(url, 'utf8')).join('\n')],
  ['jira-agent/src/command.ts', readFileSync(new URL('./command.ts', import.meta.url), 'utf8')],
])

/**
 * Every message, with the fragment(s) that may not appear in a surface's source. Hand-picked so
 * each is long enough to be unambiguous (`需要` alone is in a dozen other messages; the whole
 * sentence is not).
 */
const CASES: readonly (readonly [string, readonly string[]])[] = Object.freeze([
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
])

describe('messages: one home per sentence (decision 184)', () => {
  it('covers every export, so a message added tomorrow is guarded too', () => {
    assert.deepEqual(Object.keys(messages).sort(), CASES.map(([name]) => name).sort())
  })

  it('no surface carries a second literal copy of any message', () => {
    const leaks: string[] = []
    for (const [name, fragments] of CASES) {
      for (const [path, source] of SURFACES) {
        for (const fragment of fragments) {
          if (source.includes(fragment)) leaks.push(`${name}: "${fragment}" also appears literally in ${path}`)
        }
      }
    }
    assert.deepEqual(leaks, [], 'a sentence spelled out twice is how the two surfaces drift')
  })

  it('both surfaces import the module rather than spelling the sentences out', () => {
    for (const [path, source] of SURFACES) {
      assert.match(source, /from '@deepseek-ai\/dsh-jira-core\/messages\.ts'/u, `${path} does not import core/messages`)
    }
  })
})
