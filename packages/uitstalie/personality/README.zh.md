---
description: "personality 能力提供者：全局 PERSONALITY.md 人格档案与工作区覆盖、描述用户如何表达与如何回复的固定系统提示词段，以及 personality_learn 自动学习工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-personality

[English](README.md) | 中文

## 概述

`dsh-personality` 让 agent 拥有一份稳定、由用户拥有的人格档案。harness home 下的全局 `PERSONALITY.md` 记录用户是谁、如何表达需求、偏好怎样的回复；工作区覆盖可以为某个项目替换 style 与 preference 条目。一个系统提示词段把档案分成两部分呈现，`personality_learn` 工具在每会话预算内记录用户明确的纠正。identity 条目只允许手改。每次写入都带版本守卫，并向 `PERSONALITY.history.jsonl` 追加一行，供后续漂移审阅。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

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

提供者对 `ctx.dafeiyu`（组织者）、`ctx.dshStore`（工作区覆盖）与 `ctx.fs`（全局档案）是硬组合依赖；组合里缺少任一个时本行保持 inactive。组织者接线的贡献是 `scope: 'all'`，因此子 agent 继承提示词段与工具；哪些 agent 被接线、哪些完成的 turn 进入 `onTurnEnd`，仍由组织者决定。

## 理解实现

提供者是函数插件：`src/index.ts` 导出 `name`、`inject`、`Config` 与 `apply`，并只注册一个 `contractVersion: 1`、`id: 'personality'` 的能力。

- `src/config.ts` 持有 schemastery `Config` 与显式的 `resolveConfig(config): PersonalitySettings` 步骤。默认值只在那里补一次：全局路径变为 `<DSH_HOME>/personality/PERSONALITY.md`，历史路径从 `globalPath` 推出，工作区覆盖的两个文件路径是 store 相对常量。
- `src/personality-file.ts` 是仓库。YAML frontmatter 记录 `version`（文档修订号，每次写入递增）、`updatedAt` 与 `entries`；`<!-- personality:begin -->` 与 `<!-- personality:end -->` 之间的托管区块按条目保存 `## <kind>.<name>` 标题加一段正文。区块之外的内容逐字节往返。条目 id 形如 `<kind>.<lower-kebab-name>`，kind 为 `understanding`、`style`、`preference`、`identity`；覆盖文件只允许 `style.*` 与 `preference.*`。
- 读取时按条目 id 合并全局档案与覆盖文件：覆盖条目替换同 id 的全局条目，新 id 追加在后面。全局文件经 `ctx.fs` 读取，覆盖文件经 `ctx.dshStore` 读取，文件不存在不算错误。
- `src/prompt.ts` 持有固定 preamble、两个部分的标题与规范 kind 顺序。由于提示词段的文本是同步求值的，`src/index.ts` 按 agent 缓存渲染结果：`create()` 预读全局档案，让第一次组装就能看到内容；接线一个 agent 时再异步读取该 agent 的合并视图。
- `src/tools.ts` 构造 `personality_learn`。它校验 kind、要求 evidence 指向一个正的会话事件 seq，并用内存里的每会话用量记录执行 `autoLearn` 预算。`understanding`、`style`、`preference` 条目以 `source: 'auto'` 写入；`identity` 按手改说明拒绝，预算耗尽时报告剩余条数与字节数。拒绝是规范的返回值，不是工具错误。

写入带版本守卫。`writePersonalityEntry` 先读目标文件与其版本，拼出下一版文本，再带 `expected: version` 写入（store 映射为 `replaceIfVersion`，全局文件直接使用文件系统的写入意图）。冲突写入表现为 `FS_STALE_VERSION`；写入会重读一次并重试，第二次冲突直接抛出，旧文件保持不变。写入成功后，`appendHistory` 在同一个目录的 `PERSONALITY.history.jsonl` 追加一行 JSON，记录修订号、时间、来源、会话、按 id 的 diff 与完整托管区块。历史追加失败只记录日志，不会把条目写入报告为失败。

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

每个 agent 上一个工具。它需要必填的 `kind`、必填的一段 `content`，以及必填的 `evidence` 字符串——必须指向一个正的会话事件 seq，例如 `"seq 42"`。它只返回一行：要么确认写入的条目 id、文件与修订号，要么说明为什么什么都没写。identity 条目按手改说明拒绝，未知 kind 会列出可用 kind，每会话预算耗尽时报告剩余条数与字节数。

#### Token 影响

每次请求的固定 schema 成本，加上每次调用一行短结果。工具从不返回档案或历史内容。

#### KV 缓存影响

在工具定义不变时前缀稳定。成功写入会改变提示词段的文本，因此下一次请求的前缀缓存失效；工具结果本身是追加在可复用前缀之后的普通结果。

## 已知限制与延期工作

- **identity 条目必须手改** — `personality_learn` 拒绝 `identity.*`；提案与接受流程等设置页。
- **自动学习有预算且只在内存里** — 每次能力注册为每个会话保留最多 `autoLearn.entries` 条写入与 `autoLearn.bytes` 字节；能力重载后计数清零。
- **还没有命令或设置页** — `/personality show`、`diff` 与 `revert` 延期，也没有审阅自动学习条目的界面。
- **没有文件 watch** — 外部修改两个文件后，要等下一个 agent 创建时才被读取，agent 存活期间不会刷新。新 agent 的覆盖读取是异步的，与它竞争的组装只能看到预读的全局档案。
- **`maxBytes` 按文件计算** — 每个文件的托管正文都受预算约束并在读取时复查，但全局加覆盖合并后的文本可能接近两倍预算。
- **历史只追加、无上限** — 每次写入都会加一行 JSON，内含完整托管区块；还没有轮转、保留上限或回退实现。
- **文件非法时该段为空** — 解析失败、覆盖文件出现不允许的 kind，或手改正文超出预算，都会记录警告并且不产生提示词文本，直到文件修好。

### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

本开发备注是非权威的工作上下文：尚未决定的问题与方向。已发布行为与已确认的理由在上文各节与包内代码里。

- **覆盖文件是否应该能屏蔽全局条目** — 当前合并只按 id 替换；删除标记需要持久表示和消费它的读取方。
- **历史应按大小还是按修订号轮转** — 每次写入都带完整托管区块，因此文件会同时随条目数与编辑频率增长。

</details>
