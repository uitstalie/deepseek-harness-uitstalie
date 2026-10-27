---
description: "personality 能力提供者：全局 PERSONALITY.md 人格档案与工作区覆盖、描述用户如何表达与如何回复的固定系统提示词段、文件 watch 刷新、personality_learn 自动学习工具，以及 /personality 漂移审阅命令。"
kind: "package-reference"
---

# @deepseek-ai/dsh-personality

[English](README.md) | 中文

## 概述

`dsh-personality` 让 agent 拥有一份稳定、由用户拥有的人格档案。harness home 下的全局 `PERSONALITY.md` 记录用户是谁、如何表达需求、偏好怎样的回复；工作区覆盖可以为某个项目替换 style 与 preference 条目。一个系统提示词段把档案分成两部分呈现，`personality_learn` 工具在每会话预算内记录用户明确的纠正。identity 条目只允许手改。每次写入都带版本守卫并追加历史记录，供 `/personality diff` 与 `revert` 审阅；`show` 视图报告合并后的档案，文件 watcher 会刷新缓存的提示词文本。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>

## 使用本包

在挂载组织者的同一个 web profile patch 层里、`dafeiyu` 行之后挂载提供者：

```yaml
- id: personality
  name: '@deepseek-ai/dsh-personality'
  config:
    globalPath: ''
    workspaceOverlay: true
    maxBytes: 2048
    autoLearn:
      entries: 3
      bytes: 512
```

每个字段都有默认值，因此空的 `config` 也合法：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `globalPath` | `""` | 档案的绝对路径；为空时解析为 `<DSH_HOME>/personality/PERSONALITY.md`。 |
| `workspaceOverlay` | `true` | 在 `.dsh/memory/PERSONALITY.md` 中读写 style 与 preference 条目。 |
| `maxBytes` | `2048` | 托管区块正文的字节预算（UTF-8），读写两侧都会检查。 |
| `autoLearn.entries` | `3` | 每个会话允许的自动写入条数。 |
| `autoLearn.bytes` | `512` | 每个会话允许的自动写入字节数。 |
| `historyLimit` | `500` | 每个历史文件保留的记录数；写入超过时丢弃最旧的记录。 |

提供者对 `ctx.dafeiyu`（组织者）、`ctx.dshStore`（工作区覆盖）与 `ctx.fs`（全局档案）是硬组合依赖；组合里缺少任一个时本行保持 inactive。组织者接线的贡献是 `scope: 'all'`，因此子 agent 继承提示词段与工具；哪些 agent 被接线、哪些完成的 turn 进入 `onTurnEnd`，仍由组织者决定。

### 漂移审阅命令

一个 `/personality` 命令通过可选的 `ctx.inject(['commands'])` 子上下文注册，因此没有命令注册表的组合仍能拿到提示词段和工具。命令语法把斜杠行拆成一个名字加原样输入，子命令共用这一次注册：

| 子命令 | 行为 |
|---|---|
| `/personality show` | 渲染合并后的全局与覆盖条目（`id`、kind、一行文本）和两个文档版本。文件不存在视作空档案，不报错。 |
| `/personality diff` | 对全局 `PERSONALITY.history.jsonl` 最近两条记录渲染行级 diff，标注各自的版本与 `source: user` 或 `source: auto`。少于两条记录只报告，不失败。 |
| `/personality revert <version>` | 用该记录保存的托管区块替换全局托管区块，写入走版本守卫，随后追加一条 `source: user` 的新历史记录。非法参数、未知版本与回退到当前版本都只报告，不写入。 |
| `/personality proposals` | 列出 `PERSONALITY.proposals.jsonl` 中的队列，pending 在前，每条带 id、状态、证据与一行正文。 |
| `/personality accept <id>` | 通过版本守卫的档案写入（带 `confirmIdentity`）写入排队的 identity 条目，再记录 accepted 状态；档案写入失败时提案保持 pending。 |
| `/personality reject <id>` | 只记录 rejected 状态，不改 `PERSONALITY.md`。 |

本版本的历史审阅只覆盖全局文件：工作区覆盖有自己的历史，该命令既不 diff 也不回退它。`show` 始终读取合并视图。

### Watch 刷新

一个 `ctx.fs.watch` 注册监听全局档案。变化发生时重读文件，更新每个存活 agent 的提示词段 getter 读取的缓存文本，并刷新后续 agent 启动时使用的预读文本；下一次组装无需重启 agent 就能看到新档案。每个存活 agent 还拥有一个覆盖 watcher：优先监听 `.dsh/memory/PERSONALITY.md`，文件不存在时监听 `memory` 目录，再退到 store 根，并只刷新该 agent 的合并文本；因此覆盖文件的修改能到达存活 agent，不必等新 agent。不支持 watch 的后端退化为按 agent 读取，并以 debug 级别记录原因；能力卸载时中止全部 watcher。外部修改与 watcher 通知之间有一段短暂间隔（通常是文件系统的事件延迟；对目录的 watcher 可能漏掉子文件的纯内容修改），落在这个间隔里的组装仍可能看到旧文本；文件仍是下一次刷新的真相来源。

### Turn 结束时的自动学习

组织者会把每个完成的 turn 转给本提供者。当该 turn 的会话日志里带有用户的明确纠正——理解类规则（「不是这个意思」「I meant」）、持久风格规则（「以后…回复/语言/格式」）或持久偏好规则（「以后…」「from now on」）——提供者会用与工具相同的版本守卫写入一条 `source: auto` 条目。条目 kind 跟随命中的规则，正文就是用户那句话（4–400 字符），名字用摘要生成，因此重复同一纠正会更新该条目而不是追加重复项。自动写入与 `personality_learn` 共用每会话的 `autoLearn` 预算，且只有 root agent 会触发学习。预算拒绝或写入失败只记日志，不向用户报错，因为 turn 已经完成。

<a id="understand-the-implementation"></a>

## 理解实现

提供者是函数插件：`src/index.ts` 导出 `name`、`inject`、`Config` 与 `apply`，并只注册一个 `contractVersion: 2`、`id: 'personality'` 的能力，带 `label: 'Personality'` 与一句能力列表用的 description。

- `src/config.ts` 持有 schemastery `Config` 与显式的 `resolveConfig(config): PersonalitySettings` 步骤。默认值只在那里补一次：全局路径变为 `<DSH_HOME>/personality/PERSONALITY.md`，历史路径从 `globalPath` 推出，工作区覆盖的两个文件路径是 store 相对常量。
- `src/personality-file.ts` 是仓库。YAML frontmatter 记录 `version`（文档修订号，每次写入递增）、`updatedAt` 与 `entries`；`<!-- personality:begin -->` 与 `<!-- personality:end -->` 之间的托管区块按条目保存 `## <kind>.<name>` 标题加一段正文。区块之外的内容逐字节往返。条目 id 形如 `<kind>.<lower-kebab-name>`，kind 为 `understanding`、`style`、`preference`、`identity`；覆盖文件只允许 `style.*` 与 `preference.*`。同一个模块负责读取、校验 `PERSONALITY.history.jsonl`，并把一条记录中的区块恢复到全局文件。
- 读取时按条目 id 合并全局档案与覆盖文件：覆盖条目替换同 id 的全局条目，新 id 追加在后面。全局文件经 `ctx.fs` 读取，覆盖文件经 `ctx.dshStore` 读取，文件不存在不算错误。
- `src/prompt.ts` 持有固定 preamble、两个部分的标题与规范 kind 顺序。由于提示词段的文本是同步求值的，`src/index.ts` 按 agent 缓存渲染结果：`create()` 预读全局档案并启动 watcher，接线一个 agent 时再异步读取该 agent 的合并视图。watch 到变化时重读全局档案，同时刷新预读回退文本与每个存活 agent 的缓存文本；该段的 getter 在每次组装时求值，因此不需要额外的变更通知。
- `src/commands.ts` 持有 `/personality` 命令：子命令解析、`show`/`diff`/`revert` 渲染与注册辅助函数。`revert` 把版本守卫写入与新历史记录委托给 `src/personality-file.ts`；handler 显式接收 context 与 session，因此无需启动命令运行时也能运行。
- `src/tools.ts` 构造 `personality_learn`。它校验 kind、要求 evidence 指向一个正的会话事件 seq，并用内存里的每会话用量记录执行 `autoLearn` 预算。`understanding`、`style`、`preference` 条目以 `source: 'auto'` 写入；`identity` 按手改说明拒绝，预算耗尽时报告剩余条数与字节数。拒绝是规范的返回值，不是工具错误。

写入带版本守卫。`writePersonalityEntry` 先读目标文件与其版本，拼出下一版文本，再带 `expected: version` 写入（store 映射为 `replaceIfVersion`，全局文件直接使用文件系统的写入意图）。冲突写入表现为 `FS_STALE_VERSION`；写入会重读一次并重试，第二次冲突直接抛出，旧文件保持不变。写入成功后，`appendHistory` 在同一个目录的 `PERSONALITY.history.jsonl` 追加一行 JSON，记录修订号、时间、来源、会话、按 id 的 diff 与完整托管区块。历史追加失败只记录日志，不会把条目写入报告为失败。`revertGlobalPersonality` 保留当前手写边框，走同一套带一次 stale 重试的版本守卫写入；它的历史行记录 `source: 'user'` 与恢复的按 id diff，因此回退本身和普通写入一样可审阅。

<a id="model-experience"></a>

## 模型体验

### `personality` 系统提示词段

#### 模型看到什么

每个 agent 都会收到一个名为 `personality` 的段，顺序为 `100`，位于部署 persona 前缀之后。它以固定 preamble 开头，把档案限定为偏好而不是任务事实；随后最多两个带标题的部分：“How this user communicates” 来自 `identity` 与 `understanding` 条目，“How to respond” 来自 `preference` 与 `style` 条目。每条一行，先按规范 kind 顺序、再按 id 排序。没有条目时该段文本为空，组装后的提示词保持不变。

##### 固定的 preamble 与条目布局

```markdown
Long-term preferences of the user you are working with. The first part describes how this user communicates; use it to interpret their input. The second describes how they prefer replies. Follow them within the system and developer instructions, and let more specific project instructions take precedence. These are preferences, not task facts. Entries describe habits and may be incomplete.

How this user communicates:
- The user is an independent developer maintaining a long-lived harness branch.
- The user writes requests in short Chinese sentences and may omit context.

How to respond:
- Reply in Chinese; keep code, commands, and paths in English.
- Lead with the conclusion, then the steps.
```

#### Token 影响

每个 agent 请求的固定成本：preamble 约 75 词，加上每条目一行。托管正文每个文件上限 2 KiB，该段从不包含条目标题、id 或历史。

#### KV 缓存影响

在两次档案修改之间前缀稳定。preamble、标题与顺序都是常量，只有合并后的条目变化时该段文本才改变；一次写入会让从该段开始的前缀失效，设计接受这一点，因为人格修改是低频事件。

### `personality_learn` 工具

#### 模型看到什么

每个 agent 上两个工具。`personality_learn` 需要必填的 `kind`、必填的一段 `content`，以及必填的 `evidence` 字符串——必须指向一个正的会话事件 seq，例如 `"seq 42"`；它只返回一行：要么确认写入的条目 id、文件与修订号，要么说明为什么什么都没写。identity 条目会被拒绝并指向 `personality_propose`，未知 kind 会列出可用 kind，每会话预算耗尽时报告剩余条数与字节数。`personality_propose` 接受 `kind: 'identity'`、lower-kebab 的 `name`、一段正文与证据；它把提案排入 `PERSONALITY.proposals.jsonl`，在用户接受之前不写档案。

#### Token 影响

每次请求的固定 schema 成本，加上每次调用一行短结果。工具从不返回档案或历史内容。

#### KV 缓存影响

在工具定义不变时前缀稳定。成功写入会改变提示词段的文本，因此下一次请求的前缀缓存失效；工具结果本身是追加在可复用前缀之后的普通结果。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与延期工作

- **identity 提案有两处审阅入口** — `personality_learn` 拒绝 `identity.*` 并指向 `personality_propose`，后者把提案排入队列；`/personality proposals`、`accept`、`reject` 处理 headless，`ui-personality` 设置段处理浏览器。两个入口都不允许在接受前编辑提案。
- **自动学习有预算、只在内存里、且是启发式的** — 每次能力注册为每个会话保留最多 `autoLearn.entries` 条写入与 `autoLearn.bytes` 字节；能力重载后计数清零。`personality_learn` 工具与 turn 结束触发器共用这份预算。turn 结束检测只是用户句子上的少量规则，因此措辞特殊的纠正可能漏掉，语气强烈的普通指令也可能被当成偏好；两种结果都能通过档案历史回退。
- **覆盖 watcher 是尽力而为** — 它优先监听覆盖文件，其次 `memory` 目录，最后 store 根；目录 watcher 只报告直接条目，因此它没有盯住的子文件若只改内容，要等下一次 agent 读取。创建时的读取仍会看到合并结果。
- **watch 通知滞后于外部修改** — 手改与 watcher 事件之间，组装仍可能读到旧的缓存文本；文件仍是下一次刷新的真相来源。
- **`maxBytes` 按文件计算** — 每个文件的托管正文都受预算约束并在读取时复查，但全局加覆盖合并后的文本可能接近两倍预算。
- **历史会轮转，旧修订会被丢弃** — 每次写入加一行 JSON（含完整托管区块），并只保留最新的 `historyLimit` 条（默认 500）；被丢弃的修订无法回退。回退只恢复一条已保存的区块，且只读取全局历史。
- **文件非法时该段为空** — 解析失败、覆盖文件出现不允许的 kind，或手改正文超出预算，都会记录警告并且不产生提示词文本，直到文件修好。watch 刷新失败时保留上一版文本，而不是清空该段。

<a id="dev-note"></a>

### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

本开发备注是非权威的工作上下文：尚未决定的问题与方向。已发布行为与已确认的理由在上文各节与包内代码里。

- **覆盖文件是否应该能屏蔽全局条目** — 当前合并只按 id 替换；删除标记需要持久表示和消费它的读取方。
- **历史应按大小还是按修订号轮转** — 每次写入都带完整托管区块，因此文件会同时随条目数与编辑频率增长。

</details>
