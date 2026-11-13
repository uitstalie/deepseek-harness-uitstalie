---
description: "personality 能力提供者：全局 PERSONALITY.md 档案、OUTPUT_STYLE.yaml 与 WRITING_RULES.yaml、三个稳定系统提示词段，以及只读的 personality_analyze 和仅 root 可用的 personality_apply、write_like_human 工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-personality

[English](README.md) | 中文

## 概述

`dsh-personality` 让每个 agent 在 harness home 下拥有一份稳定、由用户拥有的档案。它读取三个全局文件——`PERSONALITY.md`、`OUTPUT_STYLE.yaml`、`WRITING_RULES.yaml`——并贡献三个提示词段：order 100 的档案、690 的输出风格默认值、695 的已启用写作规则。`personality_analyze` 扫描会话记录，返回带证据的候选且不写文件；root agent 还会拿到 `personality_apply`（只在 `confirm: true` 后写档案）和 `write_like_human`（维护全局写作规则）。没有工作区覆盖、没有 turn-end 自动学习、没有历史文件，也没有设置页。

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
```

提供者不接受配置：所有上限与路径都由设计固定。它是硬组合依赖，需要 `ctx.dafeiyu`（组织者）、`ctx.dshStore`（全局 scope）、`ctx.fs`（旧档案备份移动）与 `ctx.sessionQuery`（分析）。组织后的贡献是 `scope: 'all'`，因此子 agent 继承三个提示词段和 `personality_analyze`；只有 root agent 会拿到 `personality_apply` 和 `write_like_human`。子 agent 只读第 695 段，不能改规则；规则改动影响所有 agent，所以应在主会话里做。

所有数据都在 `<DSH_HOME>/personality/` 下，`$DSH_HOME` 默认是 `~/.dsh`：

| 路径 | 用途 | 谁写 |
|---|---|---|
| `PERSONALITY.md` | understanding / preference / style / identity 条目 | 确认后的 `personality_apply`，或人 |
| `OUTPUT_STYLE.yaml` | tone、length、结论、列表、dispatch voice | 人；提供者只读 |
| `WRITING_RULES.yaml` | 已启用的写作约束 | 人；提供者只读 |
| `legacy/PERSONALITY.<YYYYMMDDTHHMMSSZ>.md` | 重写前档案的只读备份 | 首次激活写一次 |

首次激活时，提供者把重写前的 `PERSONALITY.md` 移到 `legacy/`，然后创建带中性默认值的 `OUTPUT_STYLE.yaml` 和空的 `WRITING_RULES.yaml`。它不会 seed 或创建 `PERSONALITY.md`：档案缺失按空档案读取，第一次确认写入时才创建。工作区 `.dsh/memory/PERSONALITY.md` 从不读取或写入；发现时每个工作区只警告一次。

<a id="understand-the-implementation"></a>

## 理解实现

`src/index.ts` 是函数插件：导出 `name`、`inject`、能力 id 与标签，以及 `apply`。它只注册一个 `contractVersion: 2`、`id: 'personality'` 的能力，并通过组织者的 `tools(agent)` 过滤接线三个提示词段和三个工具。没有 `Config` 导出，也没有设置元数据。

- `src/global-store.ts` 负责 `PERSONALITY.md`：YAML frontmatter 带 `version`、`updatedAt` 和 `entries` 序列，正文为空。条目 id 是 `<kind>.<lower-kebab-name>`，接受 `understanding`、`preference`、`style`、`identity`。单条最多 400 字符，序列化文档最多 32 KiB。读取走 store atom 的 `global` scope；写入使用 `expected: version`，遇到 `FS_STALE_VERSION` 重试一次，第二次冲突就拒绝覆盖。identity 条目只允许人手写，工具路径拒绝它。
- 同一个模块负责旧档案备份：优先用 `ctx.fs.moveFile` 移动；后端不能移动时退化为读取 → create-if-absent → 比对哈希 → 删除。命名冲突或残留文件内容不同时，下次启动只报告，不覆盖任一文件。迁移失败时能力保持不可用并阻止写入。
- `src/output-style.ts` 读取 `OUTPUT_STYLE.yaml`，拒绝未知枚举并渲染该段。`src/writing-rules.ts` 读取 `WRITING_RULES.yaml`，强制 32 条规则和 4096 字节已启用文本上限，为 CRUD 调用方修改文档，并按 `order` 再按 id 渲染已启用规则。两个读取器都把缺失文件视为空，把损坏文件降级为警告。
- `src/analyze.ts` 通过 `ctx.sessionQuery` 读取会话记录：当前会话、指定会话，或最近 1–20 个会话。它把重复证据聚成带稳定哈希 id 的候选，每条至少有精确摘录和 seq、出现次数，以及 `high` 或 `medium` 置信度。它不写任何文件。
- `src/apply.ts` 校验 `confirm: true`、1–20 个候选和每个候选的证据，拒绝 `identity`，并通过带版本守卫的存储 upsert 每个被接受的条目。单个候选写失败只记为该候选被拒，不会中止整批。
- `src/writing-tool.ts` 是仅 root 可用的 `write_like_human` 工具：校验 action，经 `writing-rules.ts` 修改文档，通过 store 的版本守卫写入并在 stale 时重试一次；失败返回可读的 `ok: false` 结果而不是抛栈。stale 冲突后会基于新读取的文档重新应用修改。
- `src/defaults.ts` 保存首次激活的 seed 文本。`src/profile-prompt.ts` 渲染档案段。

提示词文本按 agent 缓存在 `WeakMap` 里。`onAgentCreated` 为该 agent 读取三个文件；`personality_apply` 与 `write_like_human` 成功写入后都会刷新调用方。没有文件 watcher，所以在工具之外改文件只会到达之后新建的 agent，不会影响运行中的 agent。

<a id="model-experience"></a>

## 模型体验

### personality 系统提示词段

#### 模型看到什么

每个 agent 都会收到三个段，order 为 100、690、695，通过 `getSectionOrder` 和中央 `SECTION_ORDERS` 表解析。数据为空时该段渲染为空，所以在用户写入之前装配后的提示词不变。

##### 档案段（order 100）

```markdown
Long-term preferences of the user you are working with. The first part describes how this user communicates; use it to interpret their input. The second describes how they prefer replies. Follow them within the system and developer instructions, and let more specific project instructions take precedence. These are preferences, not task facts. Entries describe habits and may be incomplete.

How this user communicates:
- The prefix names the executor; the rest is the task.

How to respond:
- Act only on the objects the user names and their direct implications.
```

##### 输出风格段（order 690）

```markdown
Output style defaults:
- Tone: direct.
- Length: terse.
- Lead with the conclusion: yes.
- Lists: comparisons.
- Dispatch voice: terse (super agent only; other agents ignore it).

Output style never overrides safety, approval, sandbox, tool permission, or workspace rules. When they conflict, the rule wins.

Status rules:
- State done / blocked / failed / unverified only from tool receipts; without a receipt, write "report delivery unconfirmed".
```

##### 写作规则段（order 695）

```markdown
- 面向人的正文不用 em dash；代码、路径、引用原文除外。
```

#### Token 影响

每次请求的固定成本：每个非空段一段短前言，加上每条条目或规则一行。档案上限 32 KiB，写作规则上限 4096 字节已启用文本；id、时间戳和文档版本从不渲染。

#### KV Cache 影响

在底层文件变化前前缀稳定。前言和标题顺序是常量；档案写入、手改 `OUTPUT_STYLE.yaml` 或规则编辑会从该段起使缓存前缀失效。编辑频率很低，因此接受这点缓存成本。

### `personality_analyze` 工具

#### 模型看到什么

每个 agent 一个工具。必填的 `scope` 是 `{ kind: 'current' }`、`{ kind: 'session', sessionId }` 或 `{ kind: 'recent', limit }`；可选 `kinds` 过滤条目类别，`maxCandidates` 把结果限制在 20 条。结果包含 `candidates`、`sessionsScanned`、`truncated` 和 `warnings`；每个候选都带会话 id、正数事件 seq 和精确摘录。工具描述说明它只读，且只在用户要求时使用。

#### Token 影响

工具 schema 是固定成本；一次调用返回候选和证据，不返回会话记录或档案。结果受 `maxCandidates` 和 20 个会话的扫描上限约束。

#### KV Cache 影响

在工具定义不变时前缀稳定。分析从不写文件，所以调用不会改变提示词，也不会使缓存前缀失效。

### `personality_apply` 工具

#### 模型看到什么

root agent 额外拿到这个工具。它接收 1–20 个候选，每个带 `kind`、`name`、`text` 和至少一条证据引用，外加必填的字面量 `confirm: true`。描述要求模型只在用户明确要求应用已审阅候选后调用；identity 候选会被拒绝，结果列出已应用条目 id、被拒名称与原因、档案路径和 revision。

#### Token 影响

工具 schema 是固定成本，加上每个已应用或被拒候选一行短结果。工具从不返回档案正文。

#### KV Cache 影响

在定义和档案不变时前缀稳定。一次成功的 apply 会改变第 100 段，所以下一次请求从该段起使前缀失效；被拒调用不写任何文件。

<a id="known-limitations-and-deferred-work"></a>

### `write_like_human` 工具

#### 模型看到什么

root agent 额外拿到这个工具。必填的 `action` 是 `list`、`add`、`update`、`remove`、`enable`、`disable` 或 `preview`；`id` 用于 update、remove、enable、disable 选择规则，`text`（1–240 字符）在 add/update 时必填，`order` 与 `enabled` 可选。未给 id 时，`add` 从文本推导 lower-kebab id，冲突时追加 `-2`、`-3`。结果包含 `ok`、当前规则的 id/text/enabled/order、文件路径和 store 版本；`preview` 还会返回注入文本；失败时 `ok: false` 并给出可读的 `error`。工具描述说明改动是全局的、影响所有 agent，且只有 root agent 可以调用。

#### Token 影响

schema 是固定成本，加上结果中每条规则一行。32 条上限、单条 240 字符和 4096 字节已启用文本上限把文件和第 695 段都限制住。

#### KV Cache 影响

在规则文件不变时前缀稳定。成功写入会立即刷新调用的 root agent，并从该点起使第 695 段失效；`list` 与 `preview` 不改变提示词。

## 已知限制与延期工作

- **只有一份全局档案，没有工作区 scope** —— 工作区特有偏好无法覆盖全局文件；当前轮的指令是唯一的工作区级调整。这是本次重写接受的代价。
- **外部编辑只到达新 agent** —— 没有 watcher。手改三个文件中的任何一个，只对之后创建的 agent 或被 `personality_apply` 刷新的 agent 可见，不影响运行中的对话。
- **没有历史，也没有 revert** —— 运行时从不读取、写入或复用 `PERSONALITY.history.jsonl`。旧文件作为历史证据留在原处，但没有 diff 或 revert 命令。
- **分析是启发式且有上限的** —— 一次性任务可能看起来像偏好，所以弱证据报告为 `medium`，用户必须在应用前确认。`recent` 扫描最多读取 20 个会话。
- **旧 UI 已移除** —— 没有 proposal 队列或设置页。输出风格与写作规则页面是另外的工作，因此两个文件都在磁盘上编辑。
- **损坏文件会清空对应段** —— 解析失败或手改后超出上限的正文会记为警告，在修好文件前不贡献提示词文本。

<a id="dev-note"></a>

### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

本开发备注是非权威工作上下文：记录尚未决定的问题和方向。已发布行为与已接受的理由在上文各节、[设计记录](../../../docs/design/dafeiyu-personality-plugin.zh.md)和[升级指南](../../../docs/upgrade-guide/v0.2.2-rc.2/personality-rewrite/guide.zh.md)中。

- **子 agent 是否应有只读规则工具** —— 目前它们只读第 695 段；给子 agent 一个 `list`/`preview` 工具能省一次回主会话，但不属于已拍板的 root-only 写边界。
- **是否重新加 watcher** —— watcher 会让生命周期和提示词缓存失效约定变复杂；当前设计接受只在新建 agent 时刷新。
- **旧档案迁移的回退路径是否每个后端都需要** —— 优先走移动路径，只有后端不能移动文件时才走复制路径。

</details>
