/**
 * cli/commands/hooks — `jira hooks [status|install|uninstall|prepare-commit-msg]`.
 *
 * git calls `prepare-commit-msg` with (file, source, sha): `merge` and `squash` messages are not
 * the author's, so they are left exactly as git wrote them (decision 67's exemption).
 */

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { invalidInput } from '@deepseek-ai/dsh-jira-core/errors.ts'
import { applyBranchPrefix } from '@deepseek-ai/dsh-jira-core/commitmsg.ts'
import { runGit } from '@deepseek-ai/dsh-jira-core/git.ts'
import { hookStatus, installHooks, renderHookStatus, uninstallHooks } from '@deepseek-ai/dsh-jira-core/hooks.ts'
import { fail, type CommandContext, type Handler } from '../runtime.ts'

const statusAction = async (ctx: CommandContext): Promise<number> => {
  const states = await hookStatus(ctx.root)
  ctx.say(ctx.json ? states : renderHookStatus(states))
  return 0
}

const installAction = async (ctx: CommandContext): Promise<number> => {
  // The hook calls the CLI entry point, not this module, so the shim keeps working when the
  // build is refreshed. `JIRA_CLI` overrides it for a developer with two checkouts.
  const cliPath = fileURLToPath(new URL('../index.js', import.meta.url))
  const installed = await installHooks(ctx.root, cliPath)
  if (!installed.ok) return fail(ctx.io, installed.error, 1)
  ctx.say(ctx.json
    ? installed.value
    : `已安装 ${installed.value.installed.join(', ')}，目录 ${installed.value.directory}`
      + (installed.value.backedUp.length === 0 ? '' : `\n已保留并串联：${installed.value.backedUp.map(kind => `${kind}.jira-backup`).join(', ')}`))
  return 0
}

const uninstallAction = async (ctx: CommandContext): Promise<number> => {
  const restored = await uninstallHooks(ctx.root)
  if (!restored.ok) return fail(ctx.io, restored.error, 1)
  ctx.say(ctx.json ? restored.value : restored.value.length === 0 ? '没有安装过 dsh-jira 的钩子' : `已恢复：${restored.value.join(', ')}`)
  return 0
}

const prepareCommitMsgAction = async (ctx: CommandContext): Promise<number> => {
  const file = ctx.positionals[1]
  const source = ctx.positionals[2]
  if (file === undefined) return fail(ctx.io, invalidInput('prepare-commit-msg 需要提交信息文件路径'), 2)
  if (source === 'merge' || source === 'squash') return 0
  const text = await readFile(file, 'utf8').catch(() => undefined)
  if (text === undefined) return fail(ctx.io, invalidInput(`读不到 ${file}`, { file }), 1)
  const branch = (await runGit(ctx.root, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout
  const prefixed = applyBranchPrefix(text, branch)
  if (prefixed !== text) await writeFile(file, prefixed, 'utf8')
  return 0
}

const ACTIONS: Readonly<Record<string, (ctx: CommandContext) => Promise<number>>> = Object.freeze({
  status: statusAction,
  install: installAction,
  uninstall: uninstallAction,
  'prepare-commit-msg': prepareCommitMsgAction,
})

export const hooksCommand: Handler = async (ctx) => {
  const action = ctx.positionals[0] ?? 'status'
  const handler = ACTIONS[action]
  if (handler === undefined) return fail(ctx.io, invalidInput(`未知的 hooks 动作 "${action}"（可选 status/install/uninstall/prepare-commit-msg）`), 2)
  return handler(ctx)
}
