# dafeiyu personality 插件设计（2026-11-13）

[English](dafeiyu-personality-plugin.md) | 中文

状态：已实施（Phase 4–6，2026-11-13）。2.1.1 的删除清单记录本次重写删掉的面；2.2 的旧数据处理规则仍然有效，§12 列出不在本次范围内的内容。

## 0. 7 条裁决与对应改动

| 裁决 | 本设计的落地 | 已删除的旧方案 |
|---|---|---|
| 1. personality 只放全局 `.dsh`，禁止工作区 override | 读取、写入、备份、提示都只认 `<DSH_HOME>/personality/`；工作区 `.dsh/memory/PERSONALITY.md` 一律不读不写，发现时每个工作区只警告一次 | 删除 overlay、`scope`、workspace 写入、全局/工作区合并规则 |
| 2. 取消 turn-end 自动学习 | 删除正则和 `onTurnEnd` 学习；改为工具扫描会话记录，产出候选与证据 | 删除自动学习、`autoLearn` 预算、`personality_learn` 的自动写入路径 |
| 3. 用户可主动调用分析 | `personality_analyze` 工具，按当前/指定/最近 N 个会话分析，只返回候选，不改文件；用户说跑才跑 | 删除“只在 turn end 后台学习”的隐式路径 |
| 4. 旧 personality 直接 drop | 旧代码移除；旧 `PERSONALITY.md` 移动到只读 legacy 备份后不再解析、不迁移；新实现从空开始 | 删除“在旧实现上加 scope/兼容层/旧数据迁移”的方案 |
| 5. dispatch 规则并入 super agent 系统提示词/规则 | 直接写进现有 `SUPERAGENT_SECTION`（702），与现有规则同层 | 不新增独立 `703` section、独立数据文件或第二套 brief 注入机制；HEAD 中也没有这些对象 |
| 6. write-like-human 改为可定制 prompt 规则的工具 | 新工具 `write_like_human` 管理全局规则文件，规则注入 prompt；工具负责增删改查/启停/预览 | HEAD 中没有 skill-only 实现或黑名单文件；write-like-human 是新增工具，不是把旧 skill 改名 |
| 7. 配置统一用 `output-style` | 配置对象、文件名、section 名、测试 fixture 全部用 `output-style`/`outputStyle`；`persona` 仍是 deployment persona 前缀和 persona-card 的概念，不是这个配置 | `output-summary` 不是当前名字；不要引入它，也不要重命名独立的 `persona` 概念 |

## 1. 结论

四个模块仍保留职责划分，但形态全部改为“全局 personality 能力 + 工具 + 固定 prompt 规则”，不再有工作区人格、不再有后台自动学习、不再有独立 dispatch section，也不再把 write-like-human 做成 skill。

| 模块 | 形态 | 位置 |
|---|---|---|
| user-input | 全局 personality 数据 + `personality_analyze` / `personality_apply` 工具 | `PERSONALITY.md`，section 100 |
| super-agent-dispatch | 现有 super agent 静态规则的一部分 | `SUPERAGENT_SECTION`，section 702 |
| write-like-human | 工具 + 规则文件 + 注入 section | `WRITING_RULES.yaml`，section 695 |
| output-style | 全局配置 + 注入 section | `OUTPUT_STYLE.yaml`，section 690 |

**全局只有一个根：** 所有 personality 数据都在 `<DSH_HOME>/personality/` 下；`<DSH_HOME>` 由现有 home 解析逻辑产生，不写死任何机器目录。工作区没有 personality 文件，也没有 override 读取路径。

## 2. 旧实现退出

### 2.1 代码层

当前实现是维护中的能力，不是无人维护的草稿：它注册 contract v2，保留全局档案和工作区覆盖，并带版本守卫历史、identity 提案、设置页和 50 个测试（`packages/uitstalie/personality`、`packages/uitstalie/ui-personality`）。本设计是有意替换它；旧测试不能作为新实现的验收。移除范围：

- `packages/uitstalie/personality` 的旧 provider、`personality_learn`、`personality_propose`、proposal 队列、`/personality` 命令、旧 prompt section、overlay watcher、旧 version/history 逻辑。
- `packages/uitstalie/ui-personality` 的旧 proposal 页面和旧设置字段。
- `packages/bundle/web-app/cordis.patch.uitstalie.yml` 中挂载旧 provider/UI 的行；新实现重新决定挂载点，不复用旧 config 字段。
- 旧 package 的导出 API 不保留兼容别名；需要新设计的工具名、section 名和数据文件。

### 2.1.1 实施时删掉的面

| 删除的面 | 细节 |
|---|---|
| 旧源码模块 | `commands.ts`、`proposals.ts`、`remote.ts`、`types.ts`、`tools.ts`、`prompt.ts`、`personality-file.ts`、`config.ts` |
| 旧测试 | `tests/commands.spec.ts`、`tests/personality-file.spec.ts` |
| 旧 UI 包 | `packages/uitstalie/ui-personality`（27 个受版本控制的文件，含 README 与 locale） |
| 包导出 | `./remote`、`./types`、`./typert`、`./locale/*.json` |
| 配置 | `Config` 删除；`workspaceOverlay`、`maxBytes`、`autoLearn`、`historyLimit` 不再读取。仍带这些键的 profile 行可以加载，因为 Loader 不拒绝未知键，值会被忽略。 |
| 依赖 | `@deepseek-ai/dsh-commands` peer、`@deepseek-ai/schemastery`、`diff`、`@deepseek-ai/dsh-typert-protocol` |
| 挂载与工程引用 | `cordis.patch.uitstalie.yml` 的 `ui-personality` 行、它在 `tsconfig.host.json` / `tsconfig.client.json` / `tsconfig.base.json` 的引用，以及生成的 slot catalog 条目 |
| 模型面 | `personality_learn`、`personality_propose`、`/personality` 命令、proposal Remote，以及 turn-end 学习钩子 |

**删除的是实现，不是用户数据。** 数据按 2.2 处理。

### 2.2 数据层

旧数据文件保留一份只读备份，之后不再解析、不迁移：

| 旧文件 | 处理 |
|---|---|
| `<DSH_HOME>/personality/PERSONALITY.md` | 首次启动新实现时，用 `ctx.fs.moveFile` 把旧文件**移动**到 `<DSH_HOME>/personality/legacy/PERSONALITY.<YYYYMMDDTHHMMSSZ>.md`（UTC，不含冒号；冲突时加 `-1`、`-2`），并用观察到的源版本守卫。若后端不能 move，则按 read → 以 `createIfAbsent` 写 legacy → 重读并比较 hash → 删除旧文件的顺序回退；任一步失败都保留旧文件、不创建新 `PERSONALITY.md`，报错并阻止写入。若崩溃后两个文件都在，下次启动比较 hash：相同则补删旧文件，不同则都保留并报告。 |
| `<DSH_HOME>/personality/PERSONALITY.history.jsonl` | 不解析、不读取、不删除、不改名；留在原处作为历史证据。新实现不创建 history 文件，也永不复用这个文件名。 |
| `<DSH_HOME>/personality/PERSONALITY.proposals.jsonl` | 不解析、不读取、不删除；留在原处作为历史证据。本次重写不提供排队或已接受 identity 条目的导入器。 |
| `<workspace>/.dsh/memory/PERSONALITY.md` | 不读、不写、不删；每个工作区首次发现时给一条一次性警告，说明“只支持全局 personality，工作区文件被忽略”。 |

**为什么不直接删旧数据：** 旧文件可能是用户唯一的人格记录；删除不可逆。设计只授权“备份 + 忽略”，不授权删除。若用户明确要求删数据，另开一个显式清理操作，不在本轮做。

### 2.3 兼容性影响

旧实现的直接消费者：

| 消费者 | 影响 |
|---|---|
| `packages/uitstalie/personality` 自身及其测试 | 删除/重写；旧测试不能作为新实现验收 |
| `packages/uitstalie/ui-personality` | 旧 proposal/设置页移除；新的 output-style/writing-rules 页面另做 |
| `packages/bundle/web-app/cordis.patch.uitstalie.yml` | 旧挂载行移除或替换；旧 profile 中手工添加的 personality 行需要迁移到新行 |
| 旧 `personality_learn` / `personality_propose` 调用方 | 工具消失；新工具是 `personality_analyze` / `personality_apply`，没有自动写入 |
| 从其它工作区包 import `@deepseek-ai/dsh-personality` 的消费者 | 旧导出 API 删除；这是破坏性变更，需要发布说明/升级指南 |
| 读 `<workspace>/.dsh/memory/PERSONALITY.md` 的外部脚本 | 新实现不再读它；脚本不会得到提示，只能靠一次性警告或文档 |

旧数据不迁移、旧 API 不兼容、旧工作区文件不读，是这次设计的明确代价。

## 3. 全局数据与文件

### 3.1 目录

| 文件 | 作用 | 谁可写 |
|---|---|---|
| `<DSH_HOME>/personality/PERSONALITY.md` | user-input 条目：understanding / preference / style；identity 仅人工编辑 | `personality_apply`（需确认）或人 |
| `<DSH_HOME>/personality/OUTPUT_STYLE.yaml` | 普通 root 的输出风格：tone/length/结论/列表/派活口吻 | 人；工具只读 |
| `<DSH_HOME>/personality/SUPERAGENT_OUTPUT_STYLE.yaml` | super root 的独立输出风格槽 | 人；工具只读 |
| `<DSH_HOME>/personality/WRITING_RULES.yaml` | write-like-human 的规则集合 | `write_like_human` 工具（用户要求时）或人 |
| `<DSH_HOME>/personality/legacy/PERSONALITY.<YYYYMMDDTHHMMSSZ>.md` | 旧文件只读备份 | 新实现一次性写入，之后不再写 |

不存在工作区 personality 文件；所有工具都只写上述全局路径。

首次激活时，实现按 3.3 的默认值创建 `OUTPUT_STYLE.yaml`，并创建空的 `WRITING_RULES.yaml`；不创建也不 seed `PERSONALITY.md`。

### 3.2 `PERSONALITY.md` 数据结构

新实现从空文件开始，不解析旧格式。新格式：

```markdown
---
version: 1
updatedAt: <UTC ISO-8601>
entries:
  - id: understanding.role-prefix
    kind: understanding
    text: The prefix names the executor; the rest is the task.
  - id: preference.scope
    kind: preference
    text: Act only on the objects the user names and their direct implications.
---
```

```ts
type PersonalityEntryKind = 'understanding' | 'preference' | 'style' | 'identity'

interface PersonalityEntry {
  readonly id: string                 // <kind>.<lower-kebab-name>, unique
  readonly kind: PersonalityEntryKind
  readonly text: string               // one paragraph, max 400 chars
}

interface PersonalityDocument {
  readonly version: number            // positive integer; version-guarded write
  readonly updatedAt: string          // UTC ISO-8601
  readonly entries: readonly PersonalityEntry[]  // sorted by kind, then id
}
```

- `understanding` 只描述“怎么读用户输入”；`preference` 描述“怎么做事”；`style` 描述“回复具体规则”；`identity` 只允许人工编辑，工具拒绝写，本次重写也不提供旧 identity 条目的导入器。
- 所有条目全局；没有同名工作区覆盖，也没有 overlay 合并。
- 写入使用 version guard；失败不覆盖旧文件。运行时删除 history/revert；旧 `PERSONALITY.history.jsonl` 原样不动，新实现不创建、不读取、不复用这个文件名。
- 文档正文上限为 32 KiB UTF-8；超过上限的写入被拒绝且不覆盖旧文件。

### 3.3 `OUTPUT_STYLE.yaml` 数据结构

```yaml
version: 1
tone: direct          # direct | dry | warm | neutral
length: terse         # terse | normal | detailed
leadWithConclusion: true
lists: comparisons    # never | comparisons | steps
dispatchVoice: terse  # terse | coaching | neutral
```

```ts
type OutputTone = 'direct' | 'dry' | 'warm' | 'neutral'
type OutputLength = 'terse' | 'normal' | 'detailed'
type OutputListStyle = 'never' | 'comparisons' | 'steps'
type OutputDispatchVoice = 'terse' | 'coaching' | 'neutral'

interface OutputStyleConfig {
  readonly version: 1
  readonly tone: OutputTone
  readonly length: OutputLength
  readonly leadWithConclusion: boolean
  readonly lists: OutputListStyle
  readonly dispatchVoice: OutputDispatchVoice
}
```

### 3.4 `WRITING_RULES.yaml` 数据结构

```yaml
version: 1
rules:
  - id: no-em-dash
    text: 面向人的正文不用 em dash；代码、路径、引用原文除外。
    enabled: true
    order: 10
  - id: no-not-x-but-y
    text: 避免“不是……而是……”的对偶句；直接说结论。
    enabled: true
    order: 20
```

```ts
interface WritingRule {
  readonly id: string                 // lower-kebab, unique
  readonly text: string               // one rule, 1..240 chars
  readonly enabled: boolean
  readonly order: number              // integer; smaller first
}

interface WritingRulesDocument {
  readonly version: 1
  readonly rules: readonly WritingRule[]  // max 100; total text <= 32 KiB
}
```

- `WRITING_RULES.yaml` 只由工具或人写；模型不能直接改文件。
- 规则是“可执行写作约束”，不是技能正文；没有 skill catalog 依赖，也没有独立黑名单文件。

## 4. 注入顺序与缓存

### 4.1 顺序表

| 顺序 | 名称 | 类型 | 范围 | 说明 |
|---:|---|---|---|---|
| -1000 | `harness:identity` | section | all | 平台身份 |
| 0 | `deployment:persona-prefix` | section | all | 部署人格前缀（平台既有 section，不是 output-style 配置） |
| 100 | `personality` | section | all | understanding / preference / style / identity 条目 |
| 500 | `PLAN_POLICY` | section | all | 计划策略 |
| 600 | `TEAM_POLICY` | section | all | 团队策略 |
| 690 | `personality:output-style` | section | all | output-style 默认表达 |
| 695 | `personality:writing-rules` | section | all | 已启用的 write-like-human 规则 |
| 702 | `superagent:dispatcher` | section | super agent | 现有规则 + 并入的 brief 规则 |
| 704 | `superagent:workspaces` | runtime context | super agent | 注册工作区，每请求重建 |
| 705 | `superagent:conventions` | runtime context | super agent | 工作区约定，文件变化时更新 |
| 706 | `superagent:running` | runtime context | super agent | 长任务状态，每请求重建 |
| 1000+ | 工具 section | section | all | 工具说明 |

**HEAD 中没有 703，也没有 `dispatch-brief.md`。** 不要新增独立 section 或数据文件。三个新名字是 `PERSONALITY`（100）、`PERSONALITY_OUTPUT_STYLE`（690）、`PERSONALITY_WRITING_RULES`（695）；三者都加进 `SECTION_ORDERS`，并通过 `getSectionOrder` 解析。

### 4.2 缓存影响

| 变化 | 失效范围 | 设计取舍 |
|---|---|---|
| `PERSONALITY.md` 条目变化 | 从 100 起 | 只在用户确认 `personality_apply` 后发生，低频；无后台自动写 |
| `OUTPUT_STYLE.yaml` 变化 | 从 690 起 | 人编辑，低频 |
| `WRITING_RULES.yaml` 变化 | 从 695 起 | 工具 CRUD，受体积上限约束；只有启用/顺序/文本变化才失效 |
| `SUPERAGENT_SECTION` 变化 | 从 702 起 | 静态规则，部署级变化 |
| runtime context | 704–706 | 每请求重建，不影响 system prefix |

规则文件不允许时间戳、seq、当前任务名等易变内容；这些只放工具结果或 runtime context。

## 5. user-input：工具化收集与确认

### 5.1 数据与分类

复用 `PERSONALITY.md` 的 `understanding` / `preference` / `style`；`identity` 只人工编辑。没有工作区副本。

A–E 与表达习惯两张表是分析目标，不是 seed 数据；`PERSONALITY.md` 从空开始。

- `understanding`：句式、用词、语气词、角色前缀、省略/反问的解读。
- `preference`：A–E 工作偏好（范围、授权、抽象、简化、一致性、对账）。
- `style`：具体的回复风格规则；由 output-style 管理默认值，`style` 条目覆盖具体场景。
- 一个条目只能属于一类；混合内容拆成两条或拒绝。

A–E 分析候选：

| 根因 | 条目 id | 规则 |
|---|---|---|
| A 越界 | `preference.scope`、`preference.authorization` | 只做点名对象及直接推导；授权内自决，改变边界才问 |
| B 抽象化 | `preference.no-invented-abstractions` | 不造代号/中间结构；引用用单号或 `doc_id《标题》` |
| C 简化 | `preference.no-overinterpretation` | 不把“整理”当“解读”；只写到可证明层级 |
| D 默认保守 | `preference.consistency-first` | 不一致时目标是消除不一致，不是保留现状 |
| E 漏对账 | `preference.inventory-sources` | 多来源任务先列已审/已改/未改对象 |

表达习惯候选：

| 习惯 | 条目 id | 解读 |
|---|---|---|
| `<角色>：<指令>` | `understanding.role-prefix` | 前缀指定执行方，后半才是任务 |
| 省略主语/宾语 | `understanding.ellipsis` | 取最近上下文；必要时一行确认，不反问一串 |
| 反问表肯定 | `understanding.rhetorical-question` | 通常是结论通知，不是提问 |
| 中英混用 | `understanding.mixed-terms` | skill/MR/KB/log/app 是通用词，不翻译 |
| 先/等之后 | `understanding.sequence` | 顺序是硬约束，前一动作完成是前置 |

### 5.2 `personality_analyze`

用途：用户说“分析一下我最近的表达/偏好”或明确要求时，扫描会话记录，产出候选和证据；**只读，不写文件**。

```ts
type AnalysisScope =
  | { readonly kind: 'current' }
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'recent'; readonly limit: number }  // 1..20

interface AnalyzeInput {
  readonly scope: AnalysisScope                 // required
  readonly kinds?: readonly PersonalityEntryKind[]  // optional; identity rejected
  readonly maxCandidates?: number               // optional, 1..20, default 10
}

interface EvidenceRef {
  readonly sessionId: string
  readonly seq: number                          // positive
  readonly quote: string                        // exact excerpt, max 400 chars
  readonly turn?: number
}

interface PersonalityCandidate {
  readonly candidateId: string                  // stable hash of kind+name+text
  readonly kind: Exclude<PersonalityEntryKind, 'identity'>
  readonly name: string                         // lower-kebab
  readonly text: string                         // proposed entry text
  readonly evidence: readonly EvidenceRef[]     // at least one
  readonly occurrences: number                  // across scanned sessions
  readonly confidence: 'high' | 'medium'
}

interface AnalyzeResult {
  readonly candidates: readonly PersonalityCandidate[]
  readonly sessionsScanned: number
  readonly truncated: boolean
  readonly warnings: readonly string[]          // legacy workspace files, unreadable sessions
}
```

- `scope: current` 只读当前 Session；`session` 读指定 id；`recent` 读最近 N 个可读 Session。
- 证据必须是具体片段和 seq；不能只给“用户经常这样说”的概括。
- 不调用 `memory_search` 作为必需步骤；直接读会话记录。检索不可用时返回 `warnings`，不编造证据。
- 不写文件、不改 prompt、不自动应用。

### 5.3 `personality_apply`

用途：用户看过候选后明确说“写入/应用”，或人工确认时，写入全局 `PERSONALITY.md`。

```ts
interface ApplyCandidate {
  readonly kind: Exclude<PersonalityEntryKind, 'identity'>
  readonly name: string
  readonly text: string
  readonly evidence: readonly EvidenceRef[]     // at least one
}

interface ApplyInput {
  readonly candidates: readonly ApplyCandidate[]  // 1..20
  readonly confirm: true                          // required literal
}

interface ApplyResult {
  readonly applied: readonly string[]             // entry ids
  readonly rejected: readonly { readonly name: string; readonly reason: string }[]
  readonly path: string                           // global PERSONALITY.md
  readonly revision: number
}
```

- `confirm` 必须是字面 `true`；工具描述要求“只在用户明确要求应用后调用”。
- 只写 `<DSH_HOME>/personality/PERSONALITY.md`；发现工作区旧文件只给 warning，不读取、不写。
- `identity` 拒绝；identity 只能人手工编辑。
- 同一 `id` 是更新，不是新增；`name` 稳定用于去重。
- 没有自动调用路径：没有 turn-end hook，没有正则，没有预算计数器。

### 5.4 验收（3 条）

1. **分析范围**：`current`/`session`/`recent` 三个 fixture 的 `sessionsScanned` 正确；每个候选至少一个 `EvidenceRef`，`quote` 来自该 session 的真实片段；`personality_analyze` 前后 `PERSONALITY.md` 不变。
2. **确认门**：`confirm` 缺失或为 false 时拒绝且不写；`identity` 候选被拒绝；同一 `id` 两次 apply 只保留一条并更新文本。
3. **全局唯一**：构造 `workspace/.dsh/memory/PERSONALITY.md`，`personality_analyze`/`apply` 不读不写它，只返回一次 warning；所有写入路径都匹配 `<DSH_HOME>/personality/PERSONALITY.md`。

### 5.5 风险

- 分析可能从一次性任务里提炼出“伪偏好”；证据不足时只给 `medium`，并要求人工确认。
- 会话很多时 `recent` 的读取成本高；限制 20 个、结果截断并给 `truncated`。
- 全局单文件没有 overlay，工作区特殊偏好只能靠当前轮指令；这是裁决 1 的明确代价。

## 6. super-agent-dispatch：并入现有规则

### 6.1 形态

**直接修改现有 `SUPERAGENT_SECTION`（order 702）的文本**，把 brief 模板写进同一节。没有独立 section、没有 `dispatch-brief.md`、没有新的注入机制。

### 6.2 规则内容

在现有“brief 只有两个来源、不许发明标准”的规则后，追加固定模板：

```text
Brief slots (fill every slot; no slot has a default):
目标: <one objective; quote the person>
验收: <what proves it; person or destination AGENTS.md#superagent:conventions only>
边界: <in scope / out of scope / stop conditions>
证据来源: <workspace-relative paths, commands, convention anchors>

Result contract:
- First line: status: done | blocked | failed | unverified · task_id: <only when supplied>
- Last line: artifacts: <workspace-relative paths> · checks: <commands actually run>
- No report or no artifact means not done.
- Do not use interactive ask_user_question in a dispatched task; return one blocking question instead.
- Do not require memory_search; do not modify ACLs, admin permissions, or system directories.
```

- 该模板与现有规则同层；`SUPERAGENT_SECTION` 仍是唯一来源。
- 2026-11-14 用户裁定：方案比较、选型与 A/B 评估的验收必须按维度给结论和数值依据，写明哪个维度变好/变差及条件，测不出来的维度写“未测 + 原因”；禁止单一“综合更好”结论。
- 2026-11-14 用户批评：不许在派单里给实现路径、命令或步骤清单；只给目标、验收和边界，只有工作区明确说不知道怎么下手时才给做法。
- 与 `superagent:workspaces`（704）、`superagent:conventions`（705）、`superagent:running`（706）的关系：702 是静态规则；704 提供工作区身份；705 提供目标工作区约定，702 要求引用它；706 提供长任务状态。没有新 order。
- 冲突时 702 的“两个来源、不许发明标准”优先于模板的任何措辞；模板只是执行形式。

### 6.3 验收（3 条）

1. `SUPERAGENT_SECTION` 文本包含四个槽位、`status/task_id`、`artifacts/checks`、`interactive ask` 禁止、`memory_search` 非必需、ACL 禁止；普通工作区 agent 的 prompt 没有这些 super agent 规则。
2. 没有新增 `703` section；section 顺序仍是 702，runtime context 仍 704–706；测试断言 assembly 中没有 `superagent:brief-template`。
3. 现有 `superagent-brief.test.ts` 的硬规则仍全部匹配；新增 fixture 写“counts only, no names”仍被“never invent a standard”覆盖。

### 6.4 风险

- 规则文本变长，super agent 每请求固定成本增加；这是把模板并入 702 的代价。
- 702 已经很大；实现时只追加必要槽位和失败约束，不再复制 `superagent:conventions` 的内容。

## 7. write-like-human：规则工具

### 7.1 形态

**工具 `write_like_human` + 全局 `WRITING_RULES.yaml` + prompt section 695。** 不是 skill，不依赖 skill catalog，不再有独立黑名单文件。它实现在 `src/writing-tool.ts`，通过组织者的 `tools(agent)` 过滤只注册给 root agent；section 695 仍对所有 agent 注入。

### 7.2 工具接口

```ts
type WritingRuleAction = 'list' | 'add' | 'update' | 'remove' | 'enable' | 'disable' | 'preview'

interface WriteLikeHumanInput {
  readonly action: WritingRuleAction                 // required
  readonly id?: string                               // required for update/remove/enable/disable
  readonly text?: string                             // required for add/update; 1..240 chars
  readonly order?: number                            // optional for add/update
  readonly enabled?: boolean                         // optional for add/update
}

interface WritingRuleView {
  readonly id: string
  readonly text: string
  readonly enabled: boolean
  readonly order: number
}

interface WriteLikeHumanResult {
  readonly action: WritingRuleAction
  readonly rules: readonly WritingRuleView[]         // current list, sorted by order then id
  readonly promptSection?: string                    // preview only; enabled rules joined
  readonly path: string                              // global WRITING_RULES.yaml
  readonly revision: number
}
```

- `add` 自动生成 lower-kebab id（或接受显式 id），拒绝重复；`update` 保留 id；`remove` 删除；`enable/disable` 切换。
- `preview` 只返回注入文本，不写文件。
- 所有写操作只写 `<DSH_HOME>/personality/WRITING_RULES.yaml`；没有工作区路径。
- 工具只在用户要求时修改；没有自动生成规则。

### 7.3 注入

`personality:writing-rules`，order **695**，所有 agent。

文本只包含启用规则，按 `order` 升序、同 order 按 id；空集合时 section 为空（assembly 丢弃）。每条一行，不渲染 id/时间戳。

体积上限：

- 最多 100 条规则；每条 1–240 字符；启用规则正文合计 ≤ 32 KiB UTF-8 bytes。只有前 40 条启用规则常驻；其余保留并给出遗漏提示。
- 超过上限：工具拒绝写入并给出当前字节数/条数；不静默截断。
- 注入文本超过 32 KiB 时拒绝保存；40 条常驻上限保证 section 有界。

### 7.4 优先级

从高到低：

1. 平台/系统/审批/沙箱。
2. 当前轮用户明确指令（“这次不用那条规则”）。
3. superagent 硬规则与工作区约定（702/705）。
4. writing rules（695）——具体输出规则。
5. `PERSONALITY.md` 的 `style` 条目（100）——具体场景规则。
6. output-style 默认值（690）。

writing rules 不能覆盖前两层；与 output-style 冲突时具体 writing rule 赢；与 `style` 条目同级时，id 更具体的规则在前，section 文本明确“更具体规则优先”。

### 7.5 验收（3 条）

1. **CRUD**：`add` → `list` → `update` → `disable` → `remove` 后文件只保留预期规则；`disable` 的规则不出现在 `preview`/section；`remove` 后 section 不含该条。
2. **上限/注入**：100 条/32 KiB 边界内可写，超出拒绝且文件不变；section order 695，按 order/id 排序，空集合不产生文本。
3. **冲突**：fixture 同时有 output-style “terse” 与 writing rule “详细解释”，section 文本规定 writing rule 优先；fixture 同时有 superagent 硬规则与 writing rule，硬规则优先。工具不修改 702。

### 7.6 风险

- 规则是人写的，可能互相矛盾；工具只能排序，不能判断语义冲突；冲突由 section 的优先级和人工 review 处理。
- 32 KiB 上限会限制规则数量；只有 40 条常驻，因此大库需要 curation，不能无限常驻增长。
- 所有 agent 都注入，规则太泛会污染工具型输出；规则文本明确“仅用户可见正文”，代码/JSON 不改。

## 8. output-style：全局配置

### 8.1 形态

**全局 `OUTPUT_STYLE.yaml` + section 690。** 名称统一为 `output-style`；没有 `output-summary`；`persona` 是 deployment persona 前缀和 persona-card 的概念，不是这个配置字段。

### 8.2 配置与注入

数据见 3.3。section `personality:output-style`，order **690**，所有 agent。

```ts
interface OutputStyleRenderInput {
  readonly config: OutputStyleConfig
  readonly styleEntries: readonly PersonalityEntry[]  // from PERSONALITY.md at 100
  readonly dispatch: boolean                          // true for super agent
}
```

- 字段固定顺序：`tone` → `length` → `leadWithConclusion` → `lists` → `dispatchVoice`。
- 具体 `style` 条目（100）优先于 output-style 默认值；section 文本明确这一点。
- `dispatchVoice` 写成条件句，只有 super agent 实际执行。

固定硬边界：

```text
Output style never overrides safety, approval, sandbox, tool permission, or workspace rules. When they conflict, the rule wins.
```

固定状态约束（不随配置关闭）：

- 只按工具回执说 `done / blocked / failed / unverified`；没有回执写“报告投递未确认”。
- 不说“我会监控/稍后自动汇报”；monitor 是查询，不是订阅。
- 未拿到 `start.stage=prompted` 不写“已启动/已派发”。
- 重复报告标 `duplicate`；路由写 `→ reuse <title> (<id>)` 或 `→ new <title>, reason: …`。
- 需要人决定时只问一个必要问题；不把 `ask_user_question` 取消整轮包装成“等待中”。

### 8.3 验收（3 条）

1. **命名**：代码、配置、section、fixture 用 `output-style`/`outputStyle`；不得出现 `output-summary`；`persona` 只允许用于既有 deployment persona 前缀和 persona-card 概念。`outputStyle` 字段全部可解析，未知 enum 拒绝。
2. **顺序/范围**：section order 690，所有 agent 都有；在 `SUPERAGENT_SECTION`（702）之前；`style` 条目在 100，具体规则优先。
3. **硬边界/状态**：section 匹配“never overrides safety, approval, sandbox, tool permission, or workspace rules”；给“报告 pending”fixture，固定状态约束禁止“已完成/已报告”。

### 8.4 风险

- 全局默认风格不能按工作区变化；这是裁决 1 的代价，工作区差异只能靠具体 `style` 条目或当前轮指令。
- `dispatchVoice` 对所有 agent 可见但只有 super agent 执行，产生少量无关 token；若测量证明浪费，再拆，但本轮不新增目标判定。

## 9. 数据流

```text
用户要求分析
  → personality_analyze(scope=current|session|recent)
      → 读取会话记录，产出 candidates + evidence
      → 不写文件

用户确认
  → personality_apply(candidates, confirm=true)
      → 只写 <DSH_HOME>/personality/PERSONALITY.md
      → section 100 下次 assembly 生效

用户维护写作规则
  → write_like_human(add/update/remove/enable/disable)
      → 只写 <DSH_HOME>/personality/WRITING_RULES.yaml
      → section 695 下次 assembly 生效

用户编辑输出风格
  → OUTPUT_STYLE.yaml
      → section 690 下次 assembly 生效

super agent 派发
  → SUPERAGENT_SECTION 702（含 brief 模板）
  → runtime context 704–706（工作区/约定/长任务）
```

## 10. 实施顺序

| 顺序 | 工作 | 为什么 | 前置 |
|---:|---|---|---|
| 1 | 移除旧 personality 实现；实现 legacy 备份/工作区警告 | 防止旧工具和旧数据继续产生行为；先定义边界 | 无 |
| 2 | 新建全局 `PERSONALITY.md` 数据层 + `personality_analyze` / `personality_apply` + section 100 | user-input 是新设计的基础，其他模块依赖全局数据模型 | 1 |
| 3 | `output-style` 配置 + section 690 | 依赖全局配置和 section 顺序；独立于工具 | 2 |
| 4 | `write_like_human` 工具 + `WRITING_RULES.yaml` + section 695 | 需要 section 顺序与全局写入路径；可独立测 CRUD | 2 |
| 5 | 把 brief 模板并入 `SUPERAGENT_SECTION` | 只改 702 文本，依赖现有 superagent 规则和 runtime context | 无（可与 2–4 并行，但最后测冲突） |
| 6 | 集成测试：注入顺序、缓存、全局路径、旧数据备份/警告 | 单模块测试不能证明优先级和全局约束 | 1–5 |

先做 1，因为“旧实现直接 drop”是最高约束；如果旧代码还在，其他模块会被旧工具/旧 section 污染。

## 11. 在另一台电脑上实现的前置条件

### 11.1 包与改点

| 需要改/复用 | 包路径 | 说明 |
|---|---|---|
| 旧 personality 实现 | `packages/uitstalie/personality` | 删除旧 provider/tools/commands/proposals/overlay；新实现放同一包或新包，按裁决 4 不复用旧 API |
| 旧 UI | `packages/uitstalie/ui-personality` | 旧 proposal 页/设置字段移除；新 output-style/writing-rules 页面另做 |
| 组织者 | `packages/uitstalie/dafeiyu` | 新 personality 仍可注册为 capability；工具和 section 走现有 contribution |
| prompt 顺序 | `packages/core/system-prompt` | 100/690/695/702 沿用/新增固定 order；不改固定表以外的机制 |
| super agent 规则 | `packages/jira/jira-agent` | 只改 `SUPERAGENT_SECTION` 文本；不新增 section、不加 `703` |
| 全局文件服务 | `packages/uitstalie/store-atom`、`packages/fs/fs` | 全局 `$DSH_HOME` 读写、version guard、文件监听 |
| web 挂载 | `packages/bundle/web-app/cordis.patch.uitstalie.yml` | 替换旧 personality/UI 行；新工具和页面需要新行 |

不需要新 skill 目录，不需要 `skill-filesystem`/`tool-skill` 的改动；write-like-human 是普通工具。

### 11.2 实现顺序的前置

- 先决定 `PERSONALITY.md` 新格式和 legacy 备份路径，再写工具；否则 `personality_apply` 会写出旧格式兼容代码。
- 旧数据备份必须在第一次新写入前完成；备份失败时禁止新写入。
- 工作区旧文件警告是进程内一次性的（每个 workspace path 一次）；不要每次请求都刷日志。
- 工具可见性：`personality_analyze` 对所有 agent 可见；`personality_apply` 与 `write_like_human` 仅 root，通过 dafeiyu `tools(agent)` 过滤，不靠提示。section 695 仍对所有 agent 注入，所以子 agent 能读规则、不能改。
- `write_like_human` 修改全局规则，只对 root agent 开放。规则 section 对所有 agent 注入，读权限不依赖该工具。

### 11.3 数据与路径

- 所有路径用 `<DSH_HOME>/personality/...`；不要写本机盘符、用户目录、session id、进程号或临时目录。
- 不给工作区创建 personality 文件；旧工作区文件只警告。
- 旧全局文件/历史/proposal 不迁移；备份后不解析。

## 12. 本次重写不做

- 新的 output-style/writing-rules UI 页面不在本次重写范围内。
- 不做工作区 override/overlay/scope；不写工作区 personality。
- 不做 turn-end 自动学习、正则、后台扫描、自动写入。
- 不迁移旧数据；不删除旧数据；不保留旧 API 兼容别名。
- 不做独立 dispatch section/数据文件/`703`。
- 不做 skill-only write-like-human；不新增 skill 目录。
- 不改 `SUPERAGENT_SECTION` 之外的 superagent runtime context 机制。
- 不删除 `PERSONALITY.history.jsonl` / `PERSONALITY.proposals.jsonl`；只留在原处。
- 不做多用户/多 workspace 人格隔离。

## 13. 待拍板

1. 旧数据是否要在备份后**删除**？本设计只备份、不删除；如果用户要删，需单独的显式清理命令。
2. Loader 对未知 config key 是否报错？若报错，`workspaceOverlay` 保留一版 ignored deprecated key，并在 config catalog 里注明；否则删字段。
3. 已定：`write_like_human` 工具只给 root agent，通过 `tools(agent)` 过滤；子 agent 只拿到 section 695 作为只读上下文。
