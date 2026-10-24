/**
 * cli/main — the command line (decision 83: the CLI is a superset of the tool).
 *
 * §3.1 ①: nothing here reads `process.argv`, `process.env` or the console directly — the bin
 * wrapper injects them (including `cwd`, decision 187), so the whole surface is testable
 * without spawning a process. The flag parser is `core/args.ts` (strict: an unknown flag names
 * itself), and every command goes through the same `core` functions the tool uses, so the two
 * cannot drift.
 *
 * Decision 187: the command bodies live in `commands/*.ts` — one file per command — sharing
 * the wiring from `runtime.ts`. This module keeps only the spec table, the preflight and the
 * dispatch.
 *
 * Exit codes: 0 success, 1 a store-level failure (not found, refused write), 2 usage.
 */

import { parseArgs, type FlagSpec } from '@deepseek-ai/dsh-jira-core/args.ts'
import { type JiraError, invalidInput } from '@deepseek-ai/dsh-jira-core/errors.ts'
import { type Issue, type IssueKey, asIssueKey } from '@deepseek-ai/dsh-jira-core/entity.ts'
import { type Result, err, ok } from '@deepseek-ai/dsh-jira-core/result.ts'
import { createStore, readIssueText } from '@deepseek-ai/dsh-jira-core/store.ts'
import { system } from '@deepseek-ai/dsh-jira-core/system/index.ts'
import { HANDLERS } from './commands/index.ts'
import { type CliRequest, buildContext, fail, resolveRoot } from './runtime.ts'

// The request/response types live in runtime.ts with the context they describe; the re-exports
// keep `import { runCli, type CliEnv } from './main.ts'` working for the bin and the tests.
export { type CliEnv, type CliIo, type CliRequest, resolveRoot } from './runtime.ts'

export const USAGE = `jira — 跨机器 issue 账本

用法:
  jira init                                            初始化账本（可选 --remote 加入共享仓库）
  jira get <KEY> [--json]                              读一条 issue
  jira list [--project P] [--status S] [--tag T] [--all]
                                                       列 issue（默认 20 条，最多 100）
  jira board [--html [--out FILE]] [--project P]       看板；--html 出单文件静态页
  jira new --project P --summary S [--type T] [--priority P] [--tags a,b] [--note N] [--body B]
                                                       新建；不给 --project 时从当前工作区推
  jira update <KEY> [--summary S] [--priority P] [--tags a,b] [--note N] [--body B] [--kb-refs KB-1,KB-2]
                                                       改字段（--expected-revision 可做 CAS）
  jira link <KEY> --type TYPE --target KEY [--remove]  加/删链接
  jira assignee <KEY> [--set self|none] [--override]   认领（起租约）/ 释放；--override 用于仍被阻塞时
  jira comment <KEY> --body TEXT                       追加评论（不可删）
  jira switch <KEY> --to STATUS [--resolution R] [--resolution-note N]
  jira close <KEY> --resolution R [--comment C] [--to STATUS]
  jira batch <KEY…> --resolution R                                   多键一次调用：全成或全不成
                                                       关闭并把评论一起写进同一次提交
                                                       走声明的状态迁移
  jira generate [--check]                              重新生成派生文件（--check 供 CI）
  jira sync                                            推送（推送前先 pull --rebase）
  jira kb search <QUERY> [--top-k N] [--json]          知识库检索
  jira kb get <KEY> [--json]                           读一条知识
  jira kb create --domain D --type T --title TEXT [--tags a,b] [--body B] [--issues DH-1,DH-2]
                                                       新建知识条目
  jira kb update <KEY> [--title T] [--type T] [--tags a,b] [--body B]
                                                       改知识条目
  jira lint [--json] [--keys [--compare OTHER_ROOT]]   结构自检；--keys 看 key 账
  jira tags lint [--json]                              标签自检（缺描述、几乎重名）
  jira tag-create NAME --description TEXT [--alias A]  注册一个标签（描述必填）
  jira project [list|bind --key P [--path DIR] [--remote URL] [--name N]|rebind --from A --to B [--path DIR]]
                                                       管理项目与工作区绑定
  jira verify-commit-msg <FILE>                        校验提交信息绑定
  jira hooks [status|install|uninstall|prepare-commit-msg <FILE>]
                                                       管理 git 钩子
  jira machines [list|label --name LABEL [--note TEXT] [--os OS]]
                                                       管理机器身份
  jira doctor [--json]                                 体检（结构与一致性）
  jira help                                            这份帮助

选项:
  --root <path>   账本根目录（依次：$JIRA_ROOT、$DSH_HOME/jira、<用户目录>/.dsh/jira）
  --json          机器可读输出
  -h, --help      这份帮助`

const GLOBAL: Readonly<Record<string, FlagSpec>> = Object.freeze({
  root: { type: 'string', description: '账本根目录' },
  json: { type: 'boolean', description: '机器可读输出' },
  'expected-revision': { type: 'number', description: '仅当 issue 处于该 revision 时才允许写（决策 44 的 CAS）' },
})

const COMMANDS: Readonly<Record<string, Readonly<{ maxPositionals: number; flags: Readonly<Record<string, FlagSpec>> }>>> = Object.freeze({
  // Decision 26: registering a tag is its own action — it is not work on an issue.
  'tag-create': {
    maxPositionals: 1,
    flags: {
      description: { type: 'string', description: '这个标签为什么存在（必填）' },
      alias: { type: 'string', description: '标签的别名' },
    },
  },
  init: {
    maxPositionals: 0,
    flags: {
      remote: { type: 'string', description: '要克隆/加入的共享数据仓库' },
      pull: { type: 'boolean', description: '对已有克隆做快进' },
    },
  },
  get: { maxPositionals: 1, flags: {} },
  list: {
    maxPositionals: 0,
    flags: {
      project: { type: 'string', description: '只看这个项目' },
      status: { type: 'string', description: '只看这个状态' },
      tag: { type: 'string', description: '只看带这个标签的 issue' },
      assignee: { type: 'string', description: '只看认领给这个身份的 issue' },
      'linked-to': { type: 'string', description: '只看链接到这个 key 的 issue（配合 --link-type）' },
      'link-type': { type: 'string', description: '--linked-to 使用的链接类型' },
      limit: { type: 'number', description: '打印多少条（默认 20，最多 100）' },
      all: { type: 'boolean', description: '包含已关闭的 issue' },
    },
  },
  board: {
    maxPositionals: 0,
    flags: {
      project: { type: 'string', description: '只看这个项目' },
      status: { type: 'string', description: '只看这个状态' },
      tag: { type: 'string', description: '只看带这个标签的 issue' },
      all: { type: 'boolean', description: '包含已关闭的 issue' },
      html: { type: 'boolean', description: '输出单文件静态 HTML 看板（决策 87）' },
      out: { type: 'string', description: '配合 --html：写进这个文件而不是标准输出' },
    },
  },
  new: {
    maxPositionals: 0,
    flags: {
      project: { type: 'string', description: '项目 key，例如 DH（不给则从工作区推）' },
      summary: { type: 'string', description: '一句话摘要（必填）' },
      type: { type: 'string', description: 'issue_type，默认 task' },
      priority: { type: 'string', description: '优先级，默认 S3' },
      tags: { type: 'string', description: '逗号分隔的标签' },
      note: { type: 'string', description: '留给下一个读者的一句话' },
      body: { type: 'string', description: 'Markdown 正文' },
    },
  },
  update: {
    maxPositionals: 1,
    flags: {
      summary: { type: 'string', description: '替换摘要' },
      priority: { type: 'string', description: '替换优先级' },
      tags: { type: 'string', description: '替换标签（逗号分隔）' },
      note: { type: 'string', description: '替换备注' },
      body: { type: 'string', description: '替换 Markdown 正文' },
      'kb-refs': { type: 'string', description: '替换 kb_refs（逗号分隔的知识 key）' },
    },
  },
  link: {
    maxPositionals: 1,
    flags: {
      type: { type: 'string', description: '链接类型，例如 is_blocked_by（必填）' },
      target: { type: 'string', description: '另一条 issue 的 key（必填）' },
      remove: { type: 'boolean', description: '删除该链接而不是添加' },
    },
  },
  assignee: {
    maxPositionals: 1,
    flags: {
      set: { type: 'string', description: 'self（默认）认领，none 释放' },
      override: { type: 'boolean', description: '仍被阻塞时也认领（决策 24；会写成一条评论）' },
    },
  },
  comment: { maxPositionals: 1, flags: { body: { type: 'string', description: '评论内容（必填）' } } },
  kb: {
    maxPositionals: 2,
    flags: {
      query: { type: 'string', description: '检索：要找的文字' },
      'top-k': { type: 'number', description: '检索：返回多少条（默认 10，最多 50）' },
      domain: { type: 'string', description: '新建：知识域目录名' },
      type: { type: 'string', description: '新建/修改：kb_type' },
      title: { type: 'string', description: '新建/修改：标题' },
      tags: { type: 'string', description: '新建/修改：标签（逗号分隔）' },
      body: { type: 'string', description: '新建/修改：Markdown 正文' },
      issues: { type: 'string', description: '新建/修改：来源 issue key' },
      source: { type: 'string', description: '新建/修改：来自哪里（路径或 URL）' },
      'source-sha256': { type: 'string', description: '新建/修改：source 是文件时必填' },
    },
  },
  batch: {
    maxPositionals: 50,
    flags: {
      resolution: { type: 'string', description: '结论（必填）：所有键同一个结论' },
      to: { type: 'string', description: '进入哪个已关闭状态（默认词表里的第一个）' },
      'resolution-note': { type: 'string', description: 'resolution 为 limitation 时必填' },
      comment: { type: 'string', description: '每条都追加的评论（与关闭同一次提交）' },
    },
  },
  close: {
    maxPositionals: 1,
    flags: {
      resolution: { type: 'string', description: '结论（必填）：fixed / invalid / limitation' },
      to: { type: 'string', description: '进入哪个已关闭状态（默认词表里的第一个）' },
      'resolution-note': { type: 'string', description: 'resolution 为 limitation 时必填' },
      comment: { type: 'string', description: '关闭时一并追加的评论（与关闭同一次提交）' },
    },
  },
  switch: {
    maxPositionals: 1,
    flags: {
      to: { type: 'string', description: '目标状态（必填）' },
      resolution: { type: 'string', description: '目标是已关闭状态时必填' },
      'resolution-note': { type: 'string', description: 'resolution 为 limitation 时必填' },
    },
  },
  generate: {
    maxPositionals: 0,
    flags: {
      check: { type: 'boolean', description: '派生文件过期时退出码 1（供 CI）' },
    },
  },
  lint: {
    maxPositionals: 0,
    flags: {
      keys: { type: 'boolean', description: '只列 key，不做结构自检' },
      compare: { type: 'string', description: '配合 --keys：另一份账本根目录用于对比' },
    },
  },
  tags: { maxPositionals: 1, flags: {} },
  project: {
    maxPositionals: 1,
    flags: {
      key: { type: 'string', description: 'bind：项目 key（也就是目录名）' },
      path: { type: 'string', description: 'bind/rebind：工作区目录（默认当前目录）' },
      remote: { type: 'string', description: 'bind：要记录的 remote URL（入库前规范化）' },
      name: { type: 'string', description: 'bind：人可读的项目名' },
      from: { type: 'string', description: 'rebind: the project the checkout leaves' },
      to: { type: 'string', description: 'rebind: the project the checkout joins' },
    },
  },
  // git's commit-msg hook takes one argument today; accepting the optional source keeps an
  // argument-count change on git's side from aborting commits.
  'verify-commit-msg': { maxPositionals: 2, flags: {} },
  // prepare-commit-msg receives three arguments from git (file, source, sha); git commit -C is the
  // case that made a strict limit abort real commits.
  hooks: { maxPositionals: 4, flags: {} },
  machines: {
    maxPositionals: 1,
    flags: {
      name: { type: 'string', description: 'label: the human-readable name for this machine' },
      note: { type: 'string', description: 'label: a free-text note' },
      os: { type: 'string', description: 'label: the operating system' },
    },
  },
  sync: { maxPositionals: 0, flags: {} },
  doctor: { maxPositionals: 0, flags: {} },
  help: { maxPositionals: 0, flags: {} },
})

// Decision 163: the table is typed as a `Record`, so TypeScript cannot see an extra key on one entry
// (an excess-property check does not apply through an index signature). That is exactly how
// `assignee.override` ended up beside `flags` instead of inside it: `--override` became an "unknown
// flag" for a year of releases while the usage text still advertised it. A malformed table is a
// programming error, so it fails at import — every entry point and the whole test suite trips on it.
for (const [name, spec] of Object.entries(COMMANDS)) {
  const extra = Object.keys(spec).filter(key => key !== 'maxPositionals' && key !== 'flags')
  if (extra.length > 0) {
    throw new Error(`cli table: command "${name}" has unexpected key(s) ${extra.join(', ')} — only maxPositionals and flags belong there`)
  }
}
/** Every command name, exported so the docs and the tests can compare against it (C5). */
export const COMMAND_NAMES: readonly string[] = Object.freeze(Object.keys(COMMANDS))

export const runCli = async (request: CliRequest): Promise<number> => {
  const { argv, env, io } = request

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    io.out(USAGE)
    return 0
  }

  const command = argv[0] ?? ''
  const spec = COMMANDS[command]
  if (spec === undefined) {
    io.err(`未知命令 "${command}"`)
    io.out(USAGE)
    return 2
  }
  if (command === 'help') {
    io.out(USAGE)
    return 0
  }

  const parsed = parseArgs(argv.slice(1), { ...GLOBAL, ...spec.flags }, spec.maxPositionals)
  if (!parsed.ok) return fail(io, parsed.error, 2)

  const root = resolveRoot(parsed.value.flags, env)
  // decision 60, the two halves: **past the platform limit** is a refusal, raised where the root
  // is resolved (`core/config`, so the plugin gets it too); **near it** (240 chars) is a warning here,
  // because such a path still works — it just will not survive a deeper project name.
  // The root is only the prefix: the longest thing the store appends is
  // `projects/<6>/comments/<KEY>.md`, about forty characters. Warning on the root alone would let a
  // store sail past the limit on its very first issue (decision 167).
  const LONGEST_INNER_PATH = 40
  const longest = root.ok ? root.value.length + LONGEST_INNER_PATH : 0
  if (root.ok && system.approachesPathLimit('x'.repeat(longest))) {
    io.err('警告：账本根目录 ' + String(root.value.length) + ' 个字符 + 内部最长路径约 '
      + String(LONGEST_INNER_PATH) + ' 字符，已接近 ' + system.facts.platform + ' 的提醒阈值 / 上限（'
      + String(system.facts.pathLengthWarn) + ' / ' + String(system.facts.longPathLimit) + '），建议换一个更短的目录')
  }
  if (!root.ok) return fail(io, root.error, 2)

  const ctx = await buildContext(request, parsed.value, root.value)
  const handler = HANDLERS[command]
  /* v8 ignore next 3 -- the consistency guard keeps the table and the registry in lockstep */
  if (handler === undefined) return fail(io, invalidInput(`未处理的命令 "${command}"`), 2)
  return handler(ctx)
}

/** Locate one issue by key, for callers that only need the entity. */
export const getIssue = async (root: string, key: string): Promise<Result<Issue, JiraError>> => {
  const parsedKey = asIssueKey(key)
  if (parsedKey === undefined) return err(invalidInput(`"${key}" is not an issue key`))
  const text = await readIssueText(createStore({ root, machineId: 'cli' }), parsedKey as IssueKey)
  if (!text.ok) return text
  const { decodeIssue } = await import('@deepseek-ai/dsh-jira-core/codec.ts')
  const decoded = decodeIssue(text.value, parsedKey as IssueKey)
  return decoded.ok ? ok(decoded.value.issue) : decoded
}
