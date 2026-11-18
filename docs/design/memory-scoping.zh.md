# 面向所有会话的记忆与工作区信息：静态提示词、一套工具集、只留全局记忆

[English](memory-scoping.md) | 中文

状态：评审稿；第 0–4 步已实现。第 0 步（超上限归档修复）、第 1 步（读侧工作区工具集）、第 2 步（意图卡与任务创建）、第 3 步（投递改成工具调用、删除每轮记忆注入）与第 4 步（只留 global 记忆并迁移）已在 `cli-desktop` 上。JIRA 已整体退场：只保留 GitHub 上的 cloudstore 仓库及其内容与历史，按数据原样保留，不接入任何工具或流程；JIRA 的工具、CLI、技能、面板、本地账本、派发历史与 superagent 工具全部移除，因此不存在回合结束投递。任务绑定的跨工作区回传与 `task.dispatcherSessionId` 已实现（6.5 节）。工作区请求是通用能力；本工作区的建任务、意图卡写入与会话生命周期写动作对任何 agent 开放，跨工作区写仍要求 super agent；意图卡只在需要正式任务记录时使用。旧的按工作区记忆读取器、它的清理与窗口模块，以及 `memory` 设置行作为迁移兼容面保留；它们不是活的写入或注入路径，12.1 节记录这一点。篇幅：不受 12 页上限约束，以内容完整为准。

## 1. 背景与问题

除特别说明外，下面的计数来自 2026-11-17 17:14 的冻结快照与该会话的事件日志。

一个 super agent 会话累积了 406 条记忆（40 条活动、366 条归档），并在自己的会话表面写入了 1,312 条记忆消息（737 KiB）：812 条快照、149 条 checkpoint（承载 704 条条目文本）、350 条写入通知。同一会话调用 `memory_write` 352 次，运行记忆摘要作业 818 次。由此可以直接观察到五种失效模式，外加一个正在丢数据的缺陷。

这些机制在所有工作区会话里都会运行，不只是 super agent；这个会话只是目前观察到的最大样本。因此本次改造对所有会话统一生效，没有开关，也没有按会话类型的特例。

### 1.1 同一结论被写多次

352 次显式写入中，有 39 次在同一 turn 被自动摘要作业逐字重写。另有一类重复被语言拆开：turn 824 的结论中文、英文各存一条；归档里 turn 666 的 `is_default` 结论也是中文、英文各一条。

清理流程接不住这些重复。去重只在同一 turn、同一会话、同一种类内运行，且只认 commit 哈希或单个文件路径（`cleanup.ts:196-227`、`cleanup.ts:301-310`）；完全相同的文本反而被明确排除（`cleanup.ts:302`）。366 条归档中只有 9 条按重复删除，全部是 `open` 或 `files`，没有一条 `decision`。

### 1.2 已被推翻的结论与新结论并存

`supersedes` 只对 `open` 与 `files` 生效（`cleanup.ts:169`），且只在同一会话内匹配（`cleanup.ts:175`）。352 次调用里它被用过 1 次，没有归档任何条目。最需要被取代的 `decision` 从不参与。

结果就是可见的矛盾：一条旧的“自动化不能读图”与“本地 `read_image` 实测能读 PNG”的纠正同时活动；一条旧的“生产链路窄结论”与“该结论被错误外推”的纠正同时活动。容量压力也修不了它：366 条归档里 356 条是字节预算删除，按时间删，不按矛盾删。

### 1.3 别的工作区事实混入

工作区为 `D:\dqc\superAgent` 的会话，记录了本属于 `D:\dqc\analyze` 与 `D:\dqc\system_img` 的结论；这两个工作区的记忆里能找出 6 对重复。条目只有 `kind`、`text`、`turn`、`tags`（`memory-file.ts:236-249`），写入会话的工作目录按会话记录（`memory-file.ts:2552`），而事实主语属于哪个工作区完全没有记录。

### 1.4 派发与会话状态被当成记忆

约有 50 到 60 条是派发或会话状态：“已派发给会话 X”“等待回执”“会话已中止”“第三个任务暂缓”。派发账本当时已经持有这些状态，记忆里的副本只是第二个、而且是会过期的来源。

### 1.5 每轮追加的注入是最大成本

每次摘要都会追加一条快照，每次显式写入都会追加一条更新通知。结果是 812 条快照（216 KiB）、350 条 “Memory updated” 通知、149 条 checkpoint（含 704 条条目文本，240 KiB）。这些都不是有界、可查询的视图，而是随会话生命周期不断增长的追加流，模型把它当上下文读。它是会话表面无限增长的主要原因，必须删除，而不是调参。

### 1.6 丢数据缺陷：超上限的条目曾被直接丢弃，不写归档

`pruneSessionEntries`（`memory-file.ts:2857-2928`）用“丢弃最旧的整段 section + 丢弃完全重复文本”来执行每会话 40 条上限。事故发生时，它返回的是计数，不是归档记录；`retainDocument`（`memory-file.ts:2591`）把这个计数丢掉；写入路径只归档字节预算与清理产生的删除（`memory-file.ts:1358-1374`）。因此被丢的条目没有留下任何痕迹。Step 0（超上限归档修复）已修复：每次超上限删除与完全重复删除都会产生归档记录，附 `over-cap` 或 `duplicate` 原因，并在所有写入路径上先于活动文件写入。

一个直接观察到的实例：

- 16:04，活动块里还有 turn 816–817，包括“记忆条目必须带工作区、来源会话、来源 turn”和“无法判定归属的条目标 unassigned、不注入”这两条决定。
- 17:13，这些条目已从 `MEMORY.md` 消失。`MEMORY.archive.md` 里没有副本：在活动文件与归档文件里搜 `workspace_id` 都是 0 命中，归档文件的修改时间仍是 15:37。frontmatter 里 turn 810–817 的记录也一并消失。

这不是有记录的正常淘汰，而是最近的设计决定被静默丢弃。正因如此，止血修复不能等这份设计走完。

## 2. 目标与非目标

### 2.1 目标

1. 面向所有会话，把提示词缩成一份静态的工作区名称、id 与目录清单。不注入记忆快照、会话索引或派发状态，也不追加任何每轮记忆消息。
2. 把工作区信息与投递收进一套工具集：会话与进展、派发任务与回执、消息与确认、产物引用；每个工具都用调用会话可验证的范围来限定查询。投递是一次显式工具调用，不是回合结束后的隐式副作用。
3. 把记忆缩到只剩 `global`：跨工作区的事实与约定。派发状态与业务事实永不进记忆；先修掉现有的静默丢弃缺陷。

### 2.2 非目标

- 本次不做看板或卡片界面。
- 不做记忆卡片流，也不做记忆的事件日志存储。
- 不做工作区业务记忆模型，不加工作区记忆字段，不建工作区主题库。
- 不把业务或派发事实迁进记忆；这些事实留在各自的工具与存储里。
- 除新增工作区工具集与迁移投递外，不重做会话与 memory 的工具契约。
- 不改全局配置。
- 除删除每轮注入外，不做快照或前缀缓存优化。
- 不提供按会话类型恢复快照、更新通知或 checkpoint 的开关或特例。
- 不保留 JIRA 兼容层：JIRA 已整体退场，没有替代的 JIRA 工具面；`jiraKey` 与账本兼容都不保留。
- 不重排 personality 与 `.dsh` 存储这两类工具；那是一个独立设计项（见 2.3）。

### 2.3 关联设计（不在本文件范围）

- `personality` 与 `dsh` 工具的重新排布是独立设计项；本文件只声明依赖与冲突点。
- JIRA 一步退场：模型工具、技能、面板、CLI、本地账本、派发历史与 superagent 工具全部移除，不保留兼容层。只保留 GitHub 上的 cloudstore 仓库及其内容与历史，按数据原样保留，不接入任何工具或流程，不作为设计能力，也不需要凭据或 remote 接入说明。
- 跨文档结论（细节归工具面设计）：
  - 命名空间归属：不改 `dsh_*`；`tool-dsh-store` 保留名字并仍是唯一经校验的 `.dsh` 入口；`workspace_artifacts` 发布或解析 `.dsh` 路径时必须走该 store 的路径与命名空间检查；
  - `workspace_*` 取代退场的 super agent 编排面：会话生命周期归 `workspace_sessions`（`list`、`get`、`start`、`append`、`prompt`、`stop`、`abort`、`fork`、`archive`、`compact`、`delete`），投递失败状态与重发归 `workspace_message`（`status`、`retry`），任务状态归 `workspace_tasks`。不再有并行的任务或投递 API；`workspace_tasks` 从新开始；
  - 文件复制：随 super agent 工具移除；改由 `workspace_message.send` 携带的产物引用表达；
  - personality 存储：不合并；画像与写作规则仍分开，合并后的 `personality_apply` 是它们唯一的模型面写入者；
  - `.dsh` 工具：`tool-dsh-store` 仍是唯一经校验的入口；产物引用它，而不是取代它；
  - JIRA：只保留云端数据仓（数据原样，不接入），其余全部移除；本地账本与派发历史被删除，没有工具读取它们。
  - 意图卡：工作区记录，归工作区工具集；一张卡属于一个工作区，跨工作区请求拆成每个工作区一张卡。它既不是记忆，也不是宿主全局存储。
- 本文件不修改这两类工具的契约。

## 3. 关键决策

### 3.1 提示词只带静态工作区目录

提示词里每个已注册工作区一行：标题、id、目录。它在提示词组装时由工作区注册表渲染；不随轮次变化，只有注册表本身变化时才会变。只列已注册工作区；子目录不是工作区，会话试图创建或寻址子目录时会被拒绝，并提示先注册该目录。

为什么：提示词是固定契约。任何动态内容要么迫使重写提示词，要么变成追加消息，812 条快照正是这样堆出来的。状态、进展、任务、产物一直在变，属于查询，不属于提示词。

代价：模型必须调用工具才知道某个工作区在做什么。这是从“全部推送”到“按需拉取”的有意转变。同一份静态清单对所有会话生效；普通工作区会话与 super agent 使用同一套契约。

### 3.2 一套工作区信息工具集负责状态、任务、消息、产物与意图卡

同一组工具回答：有哪些会话、每个在做什么、有哪些派发任务及其回执、用户要什么以及哪些部分是推断的、怎么向会话发消息或追问、某个会话或任务的产物在哪里。

为什么：这些问题天然带范围，工具可以从调用会话派生并强制这个范围；记忆条目做不到，它只是一份没有主人、没有过期的副本。

代价：工具调用变多，需要维护新的工具面，还要在工具集与会话存储之间划清归属。

### 3.3 记忆只留 `global`

记忆只保留跨工作区的事实与约定：共享服务器地址、harness 默认模型、统一规矩、跨工作区用户偏好。派发状态与业务事实在写入时就被拒绝。

为什么：在 3.1 与 3.2 之后，记忆唯一还剩的独特价值，就是“处处适用、又没有更合适主人”的事实。

代价：不再自动回忆业务结论；模型必须查询，而查询可能比读一条注入条目慢。

### 3.4 删除每轮记忆注入

记忆快照、`memory-state` 提示词段、以及 “Memory updated” 通知全部删除，而且对所有会话生效，不只 super agent。上下文压缩保留；它只在 compaction 边界发生，并且不是记忆消息。默认在上下文预算用到 40% 时触发 compaction；阈值可配置，super agent 可以对不同 agent 用不同预置（默认 40%，可调）。

为什么：812 条快照与 350 条更新就是洪水；调小体积或降低频率只是让它慢一点。

代价：模型失去一份“一直在眼前”的最近工作摘要，这部分信息改由 `workspace_sessions` 与 `session_event_read` 提供。上下文压缩仍需要 compaction 路径，所以现有 checkpoint 机制只保留为 compaction 行为，不再作为每轮记忆功能。

### 3.5 投递改成工具调用，不保留回合结束兜底

发送消息、追问、传文件引用，都改成显式的 `workspace_message` 或 `workspace_artifacts` 调用。回合结束投递路径删除，不保留兜底，也不保留按部署配置启用的例外。

为什么：隐式的回合结束投递分不清“新问题”和“旧问题”，没有引用模型，也没法在会话之间传文件或引用。显式调用可以携带产物引用、幂等键与投递回执。

代价：模型忘记调工具就什么都不发，所以提示词必须教它什么时候回、怎么回。回复要短：结论、依据、下一步，不写报告式长文。

## 4. 数据模型

### 4.1 记忆：只有 global 条目

一条记忆有四个逻辑字段——`topic`、`sourceSessionId`、`createdAt`、`text`——文件另外保存一个派生 `id`（`gm-` 加 `topic`、`createdAt`、`text` 的 SHA-256 前 12 个十六进制字符）与文档 revision。`topic` 来自封闭白名单：`global-model`、`global-server`、`global-convention`、`global-account`、`global-tooling`。没有 `workspace_id`，没有 `dispatch`，没有过期时间，没有 `tags`，也没有作为作用域键的 `kind`。

- 同主题的新条目把旧条目归档：旧条目移入 `GLOBAL.archive.md`，带 `archivedAt`、`reason`（`superseded`、`manual-forget`、`migration`）与可读 `detail`。
- 存在 `$DSH_HOME/memory/GLOBAL.md`，经 `.dsh` store 的 `global` 作用域（`ctx.dshStore`）读写；文件是 YAML frontmatter（`version`、`updatedAt`、`entries`），整文件上限 8 KiB。
- 条目在 `GLOBAL.md` 里就是 active，移入 `GLOBAL.archive.md` 后就是 archived；没有单独的状态字段，也没有按工作区区分的状态。

### 4.2 工具集记录

工具集自己持有它返回的记录，记忆不复制它们。

| 记录 | 逻辑字段 | 归属 |
|---|---|---|
| 会话进展 | 会话 id、标题、状态、当前 turn、当前活动、最近进展时间、最新进展一行 | 会话存储，由工具汇总 |
| 派发任务 | 任务 id、工作区、标题、目标、验收、状态、负责人、创建/更新时间、回执、产物引用 | 工作区任务存储，`workspace_tasks` 是唯一写入者 |
| 意图卡 | 意图 id、工作区、版本、状态、用户原话、带来源标注的目标/验收/边界/产出形式、来源会话与 turn、创建与确认时间 | 工作区意图存储；一张卡一个工作区 |
| 消息 | 消息 id、目标会话、正文、类型（消息或追问）、投递状态、回执、产物引用 | 会话 inbox 与消息日志 |
| 产物引用 | 产物 id、工作区、路径、sha256、大小、版本、类型、会话 id、任务 id、创建时间、摘要 | 工作区产物索引 |

工具集不得复制会话存储或工作区文件已经持有的事实。它只做聚合与变更。第 4 步之后的当前状态：记忆就是 4.1 节的全局存储——`$DSH_HOME/memory/GLOBAL.md`、它的 `GLOBAL.archive.md`，除此之外没有别的。没有工作区记忆条目被写入或注入：每轮摘要作业已移除，旧的按工作区文件只由一次性迁移与旧文件读取器读取。工作区工具集在 `$DSH_HOME/workspaces/<workspace-id>/` 下写任务、回执、消息、产物引用与意图卡；`workspace_message.send` 是它唯一的出站投递路径，`workspace_artifacts.publish`/`reference` 是它唯一的引用路径。消息或任务引用在发送时保存产物 id、版本与 SHA-256；文件本身仍在工作区里。任务只有一个主人：`workspace_tasks`。任务记录只在需要正式任务记录时创建：active 意图卡 → `workspace_tasks.create` → 可选的 `workspace_sessions.start`/`prompt` 交付；简单的或明确的动作不建卡、不建任务，直接执行或直接发请求。没有派发历史副本，也没有第二份任务列表。需要记录时，卡缺失、proposed、stale、属于别的工作区，或 brief 漏掉卡上的点，都在 `workspace_tasks.create` 被拒绝。`workspace_sessions.start` 只接收首个任务文本与标题，不检查意图卡。工作区请求的通用能力、写动作门控与回传契约在 6.5 节。

意图卡是工作区记录，不是记忆条目。一张卡只属于一个工作区。跨工作区请求会在每个目标工作区各建一张卡，每张卡都逐字保留用户原话。派发方为每个工作区各调用一次 `workspace_intents.create` 建卡：工具只接受单个 `workspace`，没有多工作区清单。卡 id 由工作区与原话派生，因此同一工作区重复 create 会复用该卡。卡随工作区工具集状态存放：`$DSH_HOME/workspaces/<workspace-id>/intents/<intentId>/`（`index.json`、`versions/<n>.json`），不在宿主全局意图存储里。版本文件不可变；`index.json` 记录每个版本的当前状态、确认与拒绝元数据，所以旧版本被 supersede 后仍可读。

### 4.3 提示词数据

每个已注册工作区一行：`- <标题> (<id>) · <目录>`。清单不随轮次变化；只有工作区注册表变化时才会变。它不含状态、不含记忆、不含任务数据。只列已注册工作区；子目录被拒绝，不当作工作区。

## 5. 工作区信息工具集

### 5.1 公共范围规则

- 调用会话所在工作区是默认范围。跨工作区查询必须显式给 `workspace` id，且该 id 必须在工作区注册表里；该调用会被记录。
- `workspace_intents` 遵循同一范围。一张卡只属于一个工作区。跨工作区请求由派发方拆成每个工作区一张卡——每个工作区各调一次 `create`，原话逐字保留，因为工具只接受单个 `workspace`，没有多工作区参数；从别的工作区读卡必须显式给工作区 id，并留痕。
- 目标是已注册工作区的子目录时，按“未知工作区”拒绝；绝不把子目录自动注册成新工作区。
- 查询只返回属于指定工作区的记录。不做隐式的跨工作区聚合；跨工作区视图必须显式列出工作区 id。
- 结果都是有界摘要：不返回文件内容，不返回完整转录，并带游标分页。原始内容仍走 `read`、`session_event_read`，以及第 6 节的产物引用解析。
- 读取对工作区内任何 agent 开放。创建任务与修改状态对工作区内任何 agent 开放，跨工作区写要求 super agent；被指定的目标会话可以更新自己的任务、追加自己的回执。
- 每个变更都带请求 id，重试不会重复创建任务、消息或回执。

### 5.2 `workspace_sessions`

列出工作区里的会话并报告每个会话在做什么，或管理真实会话的生命周期。

输入：

```
{ action: 'list' | 'get' | 'start' | 'append' | 'prompt' | 'stop' | 'abort' | 'fork' | 'archive' | 'compact' | 'delete',
  workspace?, sessionId?, session?, task?, title?, text?, delivery?: 'queue' | 'interrupt', atSeq?, confirm?,
  provider?, model?, reasoning_effort?, status?, cursor?, limit? }
```

输出（`list`）：`{ items: [{ sessionId, title, status, currentTurn, currentActivity, lastProgressAt, latestProgress, taskId? }], nextCursor? }`。

输出（`get`）：同样的字段，外加 `recentProgress: [{ at, summary }]`、`pendingInbox`、`artifactCount`。

- `start` 在指定的已注册工作区新开一个 Session，接收首个任务文本与持久标题；它不检查意图卡，需要正式任务记录时卡校验在 `workspace_tasks.create`（6.5 节）。普通请求不需要先建任务。
- `append` 继续指定会话或最近更新的会话；`prompt` 只面向明确的 Session id；`delivery` 取 `queue` 或 `interrupt`。
- `stop` 切断运行中的 turn 且不投递文本；`abort` 切断后再投递后续文本；`fork`、`archive`、`compact` 与 `delete` 保留 Host 生命周期语义，`delete` 要求精确重复 Session id。
- 生命周期写动作对工作区内任何 agent 开放；跨工作区写要求 super agent。`list` 与 `get` 对工作区内任何 agent 开放。

范围：只返回与解析后范围匹配的工作区会话。`status` 取 `running`、`idle`、`blocked`、`done`。`currentActivity` 是从当前 turn 派生的有界一行摘要，不是完整转录。

### 5.3 `workspace_tasks`

创建、读取、更新派发任务及其回执。

输入：

```
{ action: 'list' | 'get' | 'create' | 'update' | 'receipt',
  workspace?, taskId?, status?, targetSessionId?, title?, goal?, acceptance?, boundaries?,
  outputForm?, intentId?, intentVersion?, coverage?, nonCoverage?, taskType?, alignment?,
  assignee?, note?, requestId?, cursor?, limit? }
```

- `create` 返回 `{ taskId, status, createdAt }`；`workspace`、`goal`、`acceptance`、`boundaries`、`intentId`、`intentVersion`、`taskType` 与 `requestId` 必填；`targetSessionId` 可选。缺字段、缺卡或缺卡版本返回 `INTENT_INCOMPLETE`；`proposed` 版本返回 `INTENT_UNCONFIRMED`；被 supersede 或不是当前版本的返回 `INTENT_STALE`；卡属于别的工作区返回 `INTENT_SCOPE_MISMATCH`（见 11.4 节）。`taskType` 取 11.7 节的六类封闭清单，且卡里每个点都需要一条 `coverage` 映射或一条显式 `nonCoverage` 理由。
- `update` 接受 `status`、`note`、`assignee`；允许的迁移是 `pending → in_progress → waiting_review → done | blocked | cancelled`，任何状态都可以回到 `in_progress`。只有任务拥有覆盖全部卡点的完整对齐清单，且没有 `not_satisfied` 的验收点、没有 `violated` 的边界，才允许迁移到 `done`。
- 上面的词表就是新体系的词表。旧任务数据不迁移：旧状态作为历史文本保留，不做映射。以后确实需要时用一次性脚本转换；该脚本不在本设计内。
- `receipt` 追加 `{ status, note, alignment }`，返回 `{ receiptId, at, status }`。`alignment` 写明任务的 `intentId`/`intentVersion`，并为卡里每个点带一种状态与一条证据；缺清单或清单不完整分别以 `INTENT_ALIGNMENT_MISSING`、`INTENT_ALIGNMENT_INCOMPLETE` 拒绝，`not_satisfied` 的验收点或 `violated` 的边界以 `INTENT_ALIGNMENT_UNSATISFIED` 拒绝 `done`，并把任务移到 `waiting_review` 或 `blocked` 并带回偏差清单。`out_of_scope` 的验收点与 `not_matched` 的产出形式点不阻止 `done`。
- `get` 返回任务（含 `coverage` 与 `nonCoverage`）、带对齐清单的回执、目标会话与产物引用。
- `list` 按工作区、状态、负责人过滤。

范围：一个任务只属于一个工作区。创建或变更任务对工作区内任何 agent 开放，跨工作区写要求 super agent；被指定为任务目标会话的会话可以更新该任务并追加自己的回执。每次变更都带 `requestId`，因此重试不会重复创建任务或回执。跨工作区列任务必须显式给工作区 id。

### 5.4 `workspace_message`

向一个会话发送消息或追问，并读取投递回执。完整的投递与引用设计在第 6 节。

输入：

```
{ action: 'send' | 'read', workspace?, targetSessionId?, messageId?, text?, kind?: 'message' | 'followup',
  priority?: 'normal' | 'urgent', urgentReason?: 'wrong-conclusion' | 'stop-order' | 'instruction-change',
  replyTo?, references?, taskId?, requestId? }
```

- `send` 返回 `{ messageId, targetSessionId, status: 'queued' | 'delivered' | 'interrupted' | 'target_archived', deliveredAt?, references }`。重复的 `requestId` 返回第一次的结果。
- `read` 返回消息及其回执：`{ messageId, targetSessionId, text, references, receipts: [{ at, status }], nextCursor? }`。
- `priority` 默认 `normal`；`urgent` 只限下面三种情况。
- `replyTo` 把回复挂到它回答的消息上。
- 范围：同一工作区的会话可以互发（任何 agent）；跨工作区发送只按任务绑定放行：任务在调用者工作区、`targetSessionId` 是调用者、`dispatcherSessionId` 是发送目标（已实现，6.5 节）。目标必须是该工作区里的会话；不支持广播；正文限制在一屏内。

正常与紧急：普通消息排队，在目标的下一个 turn 边界到达。紧急消息只限三种：纠正目标正在执行的错误结论；停止危险或不可逆操作；用户指令变更使当前工作失效。发送方（任何 agent）显式标 `priority: 'urgent'`，并用 `urgentReason` 给出三种情形之一；没有它的 urgent 消息被工具拒绝。super agent 在这里没有特殊性，它只是当前最早的派发方。紧急消息插入到目标的下一次工具调用之前，并可以中断当前步骤。第 3 步之前所有消息都走正常追加，紧急纠正排在队列后面，错误结论可以一路跑完；这就是紧急通道要修的缺陷。第 3 步用 `steer` 发送紧急消息，目标空闲时回退为排队。

回复指引：普通 agent 在请求完成或受阻时，用 `workspace_message.send` 加 `replyTo` 回复。回复是结论、依据、下一步，几行，不写报告；文件用引用，不粘贴正文。`workspace_message.send` 的工具描述写明这一点，因为普通 agent 不会自己推断工具契约；目前没有提示词段承载它。

在 `send` 上挂 `references` 就是推路径；见 6.6 节。

这个工具不是子代理树的消息工具。它面向工作区会话，包括调用方没有启动过的会话。

### 5.5 `workspace_artifacts`

发布、引用、列出并解析某个会话或任务产出的文件与报告。拉路径（`request`/`grant`）尚未实现。

输入：

```
{ action: 'publish' | 'reference' | 'list' | 'resolve',
  workspace?, path?, sessionId?, taskId?, artifactId?, version?, messageId?,
  kind?, summary?, pathPrefix?, requestId?, cursor?, limit? }
```

- `publish` 登记一个文件并返回产物引用；不复制文件。它接收 `path`、`kind` 与可选的 `summary`/`taskId`；同一 `requestId` 幂等。
- `reference` 把已有产物引用挂到消息或任务上；不复制文件。它接收 `artifactId`、可选 `version`，以及 `messageId` 或 `taskId`。
- `request` 与 `grant` 未实现：action 枚举只接受 `publish`、`reference`、`list`、`resolve`。下面的拉契约是后续改动的目标；`pending` 与 `expired` 当前不可达。
- `resolve` 报告记录引用是否仍与文件匹配，不返回内容；它不检查授权（当前访问限制见 6.4 节）。
- `list` 只返回引用；没有记录产物的任务返回空列表，不做猜测。

范围：路径必须落在工作区根内。工具只返回引用，不返回内容。产物的跨工作区读取不做成员或角色检查：只要显式给工作区 id（并留痕）即可；角色模型本身由[agent 角色模型](agent-role-model-20261114.zh.md)定义，产物访问不在其中。`denied` 现在的含义是记录路径解析到工作区根之外，或目标不是普通文件。引用模型在 6.4 节；拉与推的检查点在 6.6 节。

### 5.6 什么时候调哪个

| 问题 | 工具 |
|---|---|
| 这个工作区有哪些会话，分别在做什么？ | `workspace_sessions`，`action: 'list'` |
| 这个会话在做什么，最近发生了什么？ | `workspace_sessions`，`action: 'get'` |
| 启动执行会话并交付首个任务 | `workspace_sessions`，`action: 'start'` |
| 需要正式任务记录时，创建一个任务或改它的状态（需要 active 意图卡） | `workspace_tasks`，`action: 'create'` 或 `'update'` |
| 简单或明确的请求 | 直接执行，或 `workspace_message.send` / `workspace_sessions.start` 直接发起 |
| 任务状态如何，执行方回了什么？ | `workspace_tasks`，`action: 'get'` |
| 用户要什么，哪些条目是推断的？ | `workspace_intents`，`action: 'get'` |
| 确认一个含推断项的卡版本 | `workspace_intents`，`action: 'confirm'` |
| 记录对卡的纠正 | `workspace_intents`，`action: 'correct'` |
| 带引用发一条消息或追问 | `workspace_message`，`action: 'send'` |
| 对方收到了吗？ | `workspace_message`，`action: 'read'` |
| 这个会话或任务产出的报告/文件在哪里？ | `workspace_artifacts`，`action: 'list'` 或 `'resolve'` |
| 这个会话在某一轮到底说了什么？ | `session_event_read` |
| 按内容找更早的会话 | `session_search` |
| 共享服务器地址、默认模型是什么？ | 记忆里的 `global` 条目 |
| 有哪些工作区？ | 提示词里的静态清单，不用调工具 |

### 5.7 看板读同一套工具集

未来的看板需要会话、进展、任务、回执、消息、产物。它们全部来自 `workspace_sessions`、`workspace_tasks`、`workspace_message`、`workspace_artifacts`。第五个成员 `workspace_intents` 提供派发上下文；看板不会向记忆查询。

## 6. 工具重新整合与投递改成工具调用

### 6.1 为什么工具要重排

本设计开始时，memory 工具兼着会话读取职责，super agent 工具只服务 JIRA 账本，出站信息靠回合结束机制而不是工具投递。这个拆法让跨会话、跨工作区交接很难：消息带不了文件引用，报告引用不了另一份报告，接收方也没法校验自己收到的是什么。

目标归属是：会话、任务、消息、产物与意图卡归一套工作区工具集；记忆缩到只做全局事实；回合结束投递删除。这一节给迁移映射，以及投递与引用的契约。

### 6.2 现有工具到新归属

| 现有工具或路径 | 当前职责 | 新归属 | 动作 |
|---|---|---|---|
| `memory_write` | 写入任何持久条目，包括业务事实 | 记忆，只写 global | 保留，收窄 |
| `memory_search` | 搜记忆条目与会话历史 | 记忆，只搜 global | 保留，收窄 |
| `memory_read` | 把某一轮会话读成转录 | 会话查询：`session_event_read`、`workspace_sessions` | 删除 |
| `memory_forget` | 按会话、turn、kind、tag 遗忘条目 | 记忆，只处理 global | 保留，收窄 |
| `memory_resolve` | 结掉 open 工作项 | 不再有 open 或 dispatch 记忆条目 | 删除 |
| `session_search` | 在调用方工作区里搜历史会话 | 会话查询 | 保留 |
| `session_event_search`、`session_event_read`、`session_trace`、`session_event_trace` | 读授权会话的事件与血缘 | 会话查询 | 保留 |
| `superagent_scan`、`superagent_status` | 读 JIRA 账本就绪度与计数 | 无新归属；JIRA 账本被删除 | 随 JIRA 移除；不保留兼容（见 2.3） |
| `superagent_claim`、`superagent_dispatch` | 认领单据、启动执行会话 | 无新归属；JIRA 工作下线 | 随 JIRA 移除；不保留兼容（见 2.3） |
| `superagent_source` | 把 GitHub 开放 issue 导入 JIRA 账本 | 无新归属；云端数据仓按数据保留，不接入 | 移除；不保留兼容 |
| super agent 会话控制工具（已移除） | 注册表与会话生命周期：`start`、`append`、`prompt`、`inspect`、`stop`、`abort`、`fork`、`archive`、`compact`、`delete`，以及工作区 `roster`/`orphans`/`ensure`/`remove_workspace`/`rename_workspace` | 会话生命周期归 `workspace_sessions`；注册表动作随 JIRA 退场 | 移除；不留别名 |
| super agent 派发账本工具（已移除） | 读写派发账本投影；报告状态与重试 | 投递状态归 `workspace_message`（`status`、`retry`）；任务状态归 `workspace_tasks`；派发历史丢弃 | 移除；不留别名 |
| `superagent_deliver` | 把文件复制到另一个工作区 | `workspace_artifacts` 发布引用，`workspace_message.send` 携带它 | 移除；引用取代复制 |
| `superagent_permission` | 切换调用方会话的权限预设 | 权限预设服务与 Host 设置拥有预设 | 移除；不留别名 |
| `superagent_models` | 列出 provider、模型与推理档位 | 模型设置拥有模型路由 | 移除；不留别名 |
| `workspace_sessions` | 列出、读取并控制会话：`list`、`get`、`start`、`append`、`prompt`、`stop`、`abort`、`fork`、`archive`、`compact`、`delete` | 工作区工具集 | 新增；生命周期取代退场的会话控制工具 |
| `workspace_intents` | 创建、读取、确认、纠正、版本化工作区意图卡 | 工作区工具集 | 新增 |
| `workspace_tasks` | 通用派发任务与回执 | 工作区工具集 | 新增 |
| `workspace_message` | 发消息、追问、引用；读回执；`status` 报告投递失败，`retry` 重发 | 工作区工具集 | 新增；投递状态取代退场的账本报告动作 |
| `workspace_artifacts` | 发布、引用、解析产物；`.dsh` 路径走 store 检查 | 工作区工具集 | 新增 |
| `send_message`、`wait_agent` | 子代理树内消息 | 子代理树 | 保留；不在本轮范围 |
| 回合结束投递 | 回合结束后隐式发出消息 | 删除；不留兜底 | 删除 |
| `read`、`glob`、`grep` | 读工作区内容 | 内容工具 | 保留 |
| `tool-dsh-store` | 规则、技能与其它 store 内容的唯一模型面 `.dsh` 入口 | 存储工具 | 保留；`workspace_artifacts` 的 `.dsh` 路径走它的路径与命名空间检查 |
| `JIRA issue tool`、`JIRA knowledge tool`、`JIRA list tool` | 读取或修改本地 JIRA 账本 | 无新归属；账本被删除 | 随 JIRA 移除；不保留兼容 |
| JIRA 技能 `jira-work`、`jira-board`、`jira-triage` | 基于 JIRA 账本的过程 | 无新归属 | 随工具移除 |
| JIRA 本地账本 `$DSH_HOME/jira` | 单据与知识存储 | 已删除；没有工具读取它 | 删除；不可恢复 |
| 派发账本 `.superagent/ledger` | 派发历史的投影 | `workspace_tasks` 从新开始 | 丢弃；不迁移、不导入 |

`workspace_tasks` 不带 JIRA 兼容字段。JIRA 已移除，任何 `jiraKey` 或账本委托都直接去掉，不做桥接；`superagent_status` 不再作为 JIRA 汇总保留。工作区工具集有五个成员：`workspace_sessions`、`workspace_intents`、`workspace_tasks`、`workspace_message`、`workspace_artifacts`。`.dsh` 这一行是依赖，不是决定；边界归 2.3。工具面改动后的当前状态：`workspace_sessions`（`list`/`get`/`start`/`append`/`prompt`/`stop`/`abort`/`fork`/`archive`/`compact`/`delete`）、`workspace_intents`、`workspace_tasks`（`list`/`get`/`create`/`update`/`receipt`）、`workspace_message`（`send`/`read`/`status`/`retry`）与 `workspace_artifacts`（`publish`/`reference`/`list`/`resolve`）已交付，静态 `workspace-directory` 提示词段已接到每个 agent。`memory_read` 已删除（第 1 步），`memory_resolve` 随 dispatch 命名空间在第 4 步删除；memory 工具面只剩 `memory_write`、`memory_forget` 与 `memory_search`。产物的 `request`/`grant` 未实现，因此 `pending` 与 `expired` 仍不可达。JIRA 模型工具、执行器账本工具、认领/派发工具、super agent 控制与账本工具、三个 JIRA 技能、面板与 CLI 已移除；会话生命周期与投递状态分别归 `workspace_sessions` 与 `workspace_message`。本地 JIRA 账本与派发账本已删除；`workspace_tasks` 从空白开始。JIRA 只保留云端数据仓，按数据原样，不接入工具或流程。不再有 JIRA 包。

### 6.3 投递改成工具调用

`workspace_message.send` 是主投递路径：

输入：`{ workspace?, targetSessionId, kind: 'message' | 'followup', text, priority?: 'normal' | 'urgent', urgentReason?, replyTo?, references?, taskId?, requestId }`。urgent 消息必须用 `urgentReason` 给出 5.4 节三种情况之一，这是工具对三种情况的机器可校验实现。`workspace` 指定别的工作区目标时按任务绑定放行（6.5 节）；省略时用调用者自己的工作区。

- `text` 限制在一屏内。schema 上限 600 字符，工具描述要求三段：结论、依据、下一步，最多六行。
- `references` 是产物引用列表。消息体里永远不放文件内容。
- `taskId` 在消息是状态更新或追问时，把消息挂到任务上。
- `priority: 'urgent'` 由发送方（任何 agent）标记，工具按 5.4 节的三种情况校验；它插入到目标的下一次工具调用之前，并可以中断当前步骤。
- `replyTo` 标记这是对某条消息的回复。
- `requestId` 是幂等键。重复调用返回第一次的结果。

输出：`{ messageId, targetSessionId, status: 'queued' | 'delivered' | 'interrupted' | 'target_archived', deliveredAt?, references }`。

回复要短：结论、依据、下一步；文件用引用；不写报告式长文。

`workspace_artifacts.publish` 登记文件并返回引用。`workspace_artifacts.reference` 把引用挂到消息或任务上，不复制文件。接收方先用 `workspace_artifacts.resolve` 校验引用，再用 `read` 读内容。消息、任务、报告之间靠产物 id 互相引用，不粘贴正文。

### 6.4 引用模型

产物引用在发送时是不可变的：

```
ArtifactRef = { artifactId, workspaceId, path, sha256, size, version,
                kind, sessionId, taskId?, createdAt }
```

- `artifactId` 按逻辑产物稳定：`artifact-<sha256(workspaceId|path|kind)[:16]>`。
- 同一路径再次发布时 `version` 递增；`sha256` 与 `size` 描述发布时的内容。
- 消息或任务在发送时存下引用的 `artifactId`、`version`、`sha256`，之后的变化不会改写它。
- `resolve` 把记录的哈希、当前文件与调用方授权一起检查，返回六种状态之一：
  - `ok`：文件存在、哈希一致，且调用方持有有效授权或推附件。
  - `changed`：文件存在但哈希不同；这是“文件变了”，不是“文件没了”。
  - `missing`：路径已不存在；这是“文件没了”。
  - `denied`：调用方无权读该工作区或该产物，或持有方拒绝。
  - `pending`：拉请求存在，但还没有授权或拒绝。
  - `expired`：授权窗口已过。
- 第 4 步之后的当前状态：`resolve` 已实现 `ok`、`changed`、`missing` 与 `denied`；`pending` 与 `expired` 虽然声明，但在 `workspace_artifacts.request`/`grant` 交付之前不可达。产物的跨工作区 `resolve` 不做成员或角色检查：只要显式给工作区 id（并留痕）即可，`denied` 现在的含义是记录路径解析到工作区根之外，或目标不是普通文件。下面的授权规则是目标契约，不是已交付行为。
- 授权按“一个产物版本 + 一个请求方”限定，并且会过期。推附件只对目标会话有效。新版本需要新授权；旧授权不会跟随新内容。
- 跨会话引用默认在同一工作区内解析。来自别的工作区的引用必须显式给 `workspace` id；无权限时返回 `denied`，绝不返回 `missing`。
- 删除文件不会删除产物索引条目；`resolve` 返回 `missing`，引用保留以便审计。同一路径重新发布会生成新版本；旧引用解析为 `changed`，不会静默跟随新内容。
- 报告可以用产物 id 引用另一份报告。引用就是引用，报告不复制另一份报告的正文。

### 6.5 不保留回合结束兜底；工作区请求与回传契约

工作区工具集没有回合结束投递路径。它的每条出站消息都是显式的 `workspace_message.send`；一个 turn 不发就什么都不投递。JIRA 的回合结束投递已随 JIRA 退场删除，不存在任何角色、任何部署配置下的隐式出站路径。`requestId` 仍然去重重试；同一内容不可能通过它投两次，“新问题”也不会被误当成“旧问题”。

工作区请求是通用能力，不是某个角色的专属流程。任意 agent 都可以经 `workspace_message`（`send`/`read`/`status`/`retry`）向同一工作区的其他 agent/session 发起请求，也可以经 `workspace_sessions` 的 `start`/`append`/`prompt` 启动或继续会话。意图卡与 `workspace_tasks` 只在需要正式任务记录、需要规范 session 信息沟通与管理时使用；简单的或明确的动作直接执行或直接发请求，不需要单独发卡，也不存在所有动作都必须经过的固定顺序。`append`、`prompt` 与 `abort` 继续已有会话，不创建第二条任务。不确定的范围先向人确认（全局人设提示词规则）。

写动作门控（已实现）：本工作区内的写动作对任何 agent 开放——`workspace_tasks.create`/`update`/`receipt`、`workspace_intents.create`/`confirm`/`correct` 与 `workspace_sessions` 的生命周期写动作都只要求调用者在目标工作区内；跨工作区写仍要求 super agent。跨工作区发送不按角色放行，只按下一段的回传契约放行。

回传契约（已实现）：`workspace_tasks.create` 把调用者会话 id 记入任务的 `dispatcherSessionId`；执行者用 `workspace_message.send` 带 `taskId` 回传给发起该任务的会话，消息记录保存 `taskId`、`requestId` 与产物引用，`requestId` 幂等，重复调用返回第一次的结果。跨工作区发送只在任务绑定时放行：任务在调用者工作区，`targetSessionId` 是调用者，`dispatcherSessionId` 是发送目标；给出 `taskId` 时按它定位任务，未给出时按 caller=`targetSessionId` 查找绑定任务。同工作区发送不受此限制。`status` 报告投递状态、失败原因与尝试次数；`retry` 用同一身份重发 `failed` 消息，跨工作区 `retry` 与 `send` 使用同一任务绑定；任务状态只经 `workspace_tasks` 的 `update` 与 `receipt`，消息投递不改变任务状态。

工具调用失败时，模型用同一个 `requestId` 重试或报告失败；它不能假设有自动投递。回复要短：结论、依据、下一步；文件用引用；不写报告式长文。挂引用就是推路径；检查点见 6.6 节。

### 6.6 产物访问：拉与推

产物访问有两种模式，由先执行哪个工具决定。拉尚未实现：`workspace_artifacts.request` 与 `grant` 不存在，所以下面的拉检查点是目标契约；经 `workspace_message.send` 引用的推路径已交付。

**拉。** 需求方调用 `workspace_artifacts.request`。检查点按顺序：

1. 需求方对目标工作区的访问权（成员与角色）。
2. 产物是否存在、版本号；只在访问通过后检查。跨工作区调用方访问不通过时返回 `denied`，绝不返回 `missing`，避免泄漏产物是否存在。
3. 持有方授权或工作区策略。同工作区策略可以自动授权；跨工作区请求默认 `pending`，等持有方授权。
4. 读取：授权仍有效，版本与哈希一致。

失败表现：`denied`（无权限或被拒）、`pending`（还没有决定）、`expired`（截止时间已过）、`missing`（文件没了）、`changed`（哈希或版本变了）。

**推。** 发送方调用 `workspace_message.send` 并挂引用。检查点按顺序：

1. 发送方对每个产物的分享权限。
2. 目标会话在工作区里的成员资格。
3. 发送时引用是否存在、版本号。无效引用让整条消息原子失败，不会发出带坏引用的消息。
4. 接收方：附件就是授权；`resolve` 检查版本与哈希，按上面的规则返回 `changed` 或 `missing`。

失败表现：发送时的 `denied` 让消息失败并点名引用；接收时的 `changed` 或 `missing` 保留消息，并标记该引用。

谁发起会改变检查顺序：拉先查接收方访问，再查产物是否存在；推先查发送方分享权限，再查目标成员资格。授权按版本限定且会过期；新版本需要新授权。

### 6.7 拆分后的 memory 工具

- `memory_write` 只接受 global 事实或约定；业务事实、派发状态与人格/风格说明一律拒绝，并点名拥有该文本的工具。
- `memory_search` 只搜 global 条目（`GLOBAL.md`，设了 `includeArchived` 时加 `GLOBAL.archive.md`）；会话语料那一半删除。
- `memory_read` 删除；会话上下文用 `session_event_read` 或 `workspace_sessions`。
- `memory_forget` 按 `topic` 或 `entryId` 遗忘 global 条目；随 dispatch 命名空间一起删除会话、turn、kind 过滤器。
- `memory_resolve` 删除；不再有 open 或 dispatch 条目可结。
- `/memory` 命令只保留 `list`、`stats` 与 `forget --topic`/`--id`；summary、pause、prune 与会话编辑子命令随每工作区摘要作业一起删除。

### 6.8 整合后的工具集风险

- 投递可靠性：重试使用 `requestId`；结果区分 queued、delivered、interrupted、failed；不保留兜底，唯一路径就是显式调用。
- 重复投递：唯一投递路径用 `requestId` 去重；第二次写入是空操作。
- 引用失效：`changed`、`missing`、`denied` 三种状态分开；引用不可变；不静默跟随新版本。
- 权限：谁能给哪个会话发消息、谁能读谁的产物。跨工作区读取显式且留痕；`denied` 不是 `missing`。
- 会话生命周期：给已归档会话发消息返回 `target_archived`，不创建待处理 inbox；会话归档后产物引用仍可解析。
- 删除工具带来的破坏：删除 `memory_read` 与 `memory_resolve` 会改变提示词与工具目录；提示词、工具描述与快照必须在同一步一起改。

## 7. 提示词、写入与注入规则

### 7.1 记忆写入规则

- 唯一接受的条目是 `global` 事实或约定。`memory_write` 接收 `topic` 与 `text`；`topic` 必须在白名单里。调用者的会话 id 记录为 `sourceSessionId`，模型不传这个字段。
- 正文含绝对工作区路径、JIRA 单号、版本或 commit、设备或镜像、派发状态、分析结论或人格/风格说明时拒写。拒绝码为 `NOT_GLOBAL_MEMORY`，错误信息点名拥有该文本的工具：工作区工具、`session_event_read`/`read`，或 `personality_apply`/`write_like_human`。
- 没有 `dispatch` 命名空间，也没有每轮自动记忆条目。每轮摘要作业已移除。
- 业务、派发或人格写入被拒；调用方被告知该文本归哪个工具。

### 7.2 提示词与注入规则

- 提示词只有一段静态 `workspace-directory`。它不按轮次重写，不含状态、不含记忆、不含任务。
- 记忆快照模块、`memory-state` 提示词段、`appendMemoryUpdate` 通知与跨会话索引都不再存在；第 3 步删除了它们。
- 会话发生 compaction 时，仍可用摘要替换旧 turn。那是 compaction 行为：它不追加每轮记忆消息，也不在会话启动时注入。
- 回复契约（结论、依据、下一步，最多 600 字符）写在 `workspace_message.send` 的工具描述与 `text` 参数里，不在系统提示词段里。
- 三种紧急情况写在 `workspace_message.send` 的参数说明里；没有单独的提示词段承载它们。
- 询问用户的规则由全局人设提示词承载（`PERSONALITY.md`），对所有 agent 生效；工作区工具集不按角色限制提问。
- 静态段的标题写明只有已注册工作区，子目录不是工作区。
- 默认在上下文预算用到 40% 时触发 compaction；阈值可配置，super agent 可以对不同 agent 用不同预置（默认 40%，可调）。
- 写入后不再追加任何记忆消息。

### 7.3 检索与读取规则

- `memory_search` 搜 `GLOBAL.md`，设了 `includeArchived: true` 时也搜 `GLOBAL.archive.md`；会话检索交给 `session_search`。
- `memory_read` 从模型可见工具里删除；会话上下文用 `session_event_read` 或 `workspace_sessions`。
- 归档的全局条目只在设置 `includeArchived` 时返回，且永不注入。

### 7.4 所有会话，没有例外

提示词改动、删除每轮记忆消息、以及记忆规则统一生效：普通工作区会话与 super agent 得到同一份静态工作区清单、同一套工具集、同一套只留全局的记忆规则。不提供按会话类型恢复快照的开关，因为洪水是机制本身的性质，不是 agent 角色的性质。

普通会话的验收测量：

- 改造前：每次摘要追加 1 条快照，每次显式写入追加 1 条 “Memory updated”，每个 tier 边界最多 1 条 checkpoint。上面这个 super agent 会话因此产生 812 条快照、350 条更新通知、149 条 checkpoint（704 条条目文本），合计 737 KiB。
- 改造后：稳态下每轮记忆消息数为 0，每轮记忆字节数为 0。上下文只来自提示词里的静态工作区清单与工具调用结果。compaction 摘要不属于记忆消息，单独计量。

“上一轮做了什么”正是过去靠每轮通知覆盖的场景。改造后，`workspace_sessions` 的 `action: 'get'` 返回该会话的 `recentProgress` 与 `currentActivity`，它就是模型回答这个问题应使用的工具。自动化测试断言写入一次并完成一个 turn 后的注入面：没有记忆消息，也没有 `memory-state` 段。多轮零字节测量与真实普通会话上的“上一轮做了什么”属于 14.1 节的部署检查。

## 8. 迁移与止血修复

### 8.1 止血修复：先合，独立于本设计

Step 0 已独立于本设计的其余部分合并。`pruneSessionEntries` 现在为每一次超上限删除与完全重复删除返回归档记录，新增 `over-cap` 与 `duplicate` 两种移除原因；`retainDocument` 收集这些记录；所有写入路径在写活动文件之前先归档；归档失败时保留条目，而不是丢弃。

验收：把上限降到 3 条、再写第 4 轮，每一条被丢条目都必须有归档记录；归档失败时条目仍在；版本冲突重试不会产生重复归档。

### 8.2 迁移规则

| 类别 | 判定 | 处理 |
|---|---|---|
| `global` | 跨工作区的事实或约定：共享服务器地址、harness 默认模型、统一规矩、跨工作区偏好 | 需人工确认后转为 global 条目 |
| `dispatch` | 点名 task、session 或账本路径，且描述方案、下一步或进展 | 归档；持久归属是 `workspace_tasks` |
| `business` | 分析结论、设备或镜像、生产版本或 HEAD、代码路径或 commit、测试结果、报告内容、工作区配置 | 归档，永不注入；如需指针，指针放在任务或工作区记录里，不放在记忆里 |
| `persona` | 人格或写作风格说明 | 归档，永不注入；归 personality 与写作规则所有 |
| `unclassified` | 无来源会话、无 turn、归属无法判定 | 归档，进报告清单，永不注入，不猜 |

dry-run 报告逐文件逐条列出：类别、建议的 global 主题、原因、字节数，以及目标路径。global 候选单独列出，供人确认。报告自身的 SHA-256 哈希就是确认令牌：`--apply <哈希>` 会重新扫描，哈希不再匹配就拒绝，因此不能在报告读完之后文件又变了的情况下应用。应用会在第一次写入之前给每个被改文件写备份，在重写活动文件之前追加迁移归档记录，把每条已处理条目记入日志，使重复 dry-run 收敛，并可用 `--rollback <run-id>` 回滚。重写后的活动文件保持版本 1 格式，旧解析器仍能读，代码回滚后也仍可读。人类使用的命令是 `packages/uitstalie/memory/scripts/migrate-global-memory.ts`，背后的模块是 `packages/uitstalie/memory/src/migration.ts`。

每个工作区的记忆文件都按同一套规则迁移；普通会话不是特例。它的文件同样得到报告、备份、先归档再写、以及回滚。

对当前 406 条按规则粗分，约 15 条 global 候选（评审时多数应被否掉）、约 50 条派发、约 340 条业务事实、人格说明或无法判定。这些数字只用于排期估算，最终以报告为准。

## 9. 里程碑

| 步骤 | 做什么 | 验收什么 |
|---|---|---|
| 0 | 超上限路径的止血修复 | 上限与归档测试通过；无静默丢失；可独立发布，回滚只需还原该提交 |
| 1 | 整合工具的读侧：`workspace_sessions`、`workspace_tasks` 读取、`workspace_artifacts` 列/解析、`workspace_message` 读取；收窄 memory 工具；提示词与注入暂不动 | 工作区 A 的会话只看得到 A；没有显式 id 的跨工作区调用失败；memory 工具不再读会话；结果有界并分页 |
| 2 | 任务创建 + 意图卡：`workspace_intents`（工作区记录、来源标注、按版本确认）与要求 active 卡的 `workspace_tasks.create`；保留覆盖检查与回执门 | 可追溯的卡直接 active 并能派发；含推断项的卡保持 proposed，派发返回 `INTENT_UNCONFIRMED`，直到一次汇总确认；跨工作区请求为每个工作区各建一张卡，原话逐字保留；纠正追加版本，旧版本仍可读；漏覆盖点返回 `INTENT_COVERAGE_MISSING`；回执有未满足项不能 `done` |
| 3 | 投递改成工具调用，并在同一版本删除洪水：`workspace_message.send`、产物发布/引用、静态提示词，且不再有快照、更新通知、跨会话索引、回合结束投递 | 消息与引用能往返；重试不重复；一个 turn 不发就什么都不投递；普通会话每轮记忆消息数为 0、字节数为 0；“上一轮做了什么”由 `workspace_sessions` 回答 |
| 4 | 记忆变为只留 global，并迁移旧条目 | 业务或派发写入被拒并给出工具提示；产出 dry-run 报告；只有确认过的 global 条目仍被注入；备份与回滚已验证 |

已完成：第 0–4 步。第 3 步交付了 `workspace_message.send`、产物 `publish`/`reference`、静态工作区目录，并删除了记忆快照、`memory-state` 段、“Memory updated”通知与跨会话索引。一个不发 send 的 turn 不会经工作区工具集投递任何东西：唯一会调用宿主会话控制器的路径是 `workspace_message.send`。第 4 步交付了只留全局的存储（`$DSH_HOME/memory/GLOBAL.md` 与 `GLOBAL.archive.md`）、三件工具（`memory_write`、`memory_forget`、`memory_search`）、带工具指针的 `NOT_GLOBAL_MEMORY` 拒绝、每轮摘要作业的移除，以及带备份、日志与回滚的报告哈希迁移。`memory_resolve`、工作区摘要类命令、实时 TTL 清理与跨会话索引都已从模型面与人类面消失。已完成：任务绑定的跨工作区回传与 `task.dispatcherSessionId`（见 6.5 节）。未开始：产物的 `request`/`grant`。

每一步都可独立上线、可回滚。第 0 步先合。第 1 到 4 步不依赖看板方向。

顺序：读侧先落，模型在任何东西被删除之前就能查询。任务创建与意图卡紧接着落，需要正式任务记录时才有工作区记录可校验。删洪水与投递工具放在同一版本，避免出现“旧注入已删、新投递路径还没上”的空窗。记忆迁移最后做，因为它改写用户数据，并且需要稳定的工具集。

回滚方式：第 0 步只需还原一个提交。第 1 到 4 步保留能解析上一版文件的读取路径，并在任何迁移前写逐文件备份；因此回滚代码后既有文件仍可读，第 4 步可以还原自己的备份。第 2 步的卡按工作区、追加式存放；停用 `workspace_intents` 后文件仍可读，已派发的任务保留记录下来的 `intentId` 与 `intentVersion`，但新任务不再过卡校验。归档保持追加式，回滚不会丢失“删过什么”的记录。

所有会话的验收：改造前，普通会话每次摘要收到 1 条快照、每次写入收到 1 条更新，每个 tier 边界最多 1 条 checkpoint；第 3 步之后，它的每轮记忆消息数为 0，每轮记忆字节数为 0。7.4 节里的“上一轮做了什么”测试在该会话上通过 `workspace_sessions` 完成。

## 10. 风险与未决问题

### 10.1 未决项

无。上面的决定都是结论，实现数值已定：40% compaction、六类任务类型、600 字符回复上限。

### 10.2 留到后续

- 看板界面及其渲染。
- 任务与消息的事件日志存储；工具集可以先跑在现有存储上。
- 归档保留策略与体积预算。
- 模型依赖工具集拿进展之后的延迟预算。

### 10.3 风险

- 工具调用延迟与成本：结果保持有界，并在提示词里放一张简短的“去哪里查”地图。
- 一个任务一个主人：任务记录只由 `workspace_tasks` 写。需要正式任务记录时，顺序是 active 意图卡 → `workspace_tasks.create` → 可选的 `workspace_sessions.start`/`prompt`；简单或明确的动作不建卡、不建任务。没有派发历史副本，也没有第二份任务列表。回传只经 `workspace_message.send`，任务状态只经 `workspace_tasks`。
- 消息优先级：紧急消息可以中断一个步骤。`workspace_message.send` 在标记 urgent 时要求给出 `urgentReason`（三种已命名情况之一），目标在运行时 steer 当前步骤，目标空闲时回退为排队。三种紧急情况很窄，普通消息永远不紧急；误判紧急是缺陷，要评审。
- 引用失效：`publish`/`reference`/`send` 已交付，changed、missing、denied 可达且分开；引用在发送时固定，新版本需要新的引用。产物的 `request`/`grant` 交付之前，`pending` 与 `expired` 不可达；跨工作区拒绝不泄漏产物是否存在。
- 跨工作区授权：显式工作区 id、注册表成员校验、调用留痕。跨工作区发送只按任务绑定放行；没有绑定时，任何角色的调用都被拒绝。拉先查接收方，推先查发送方；不做隐式聚合。
- 丢失上下文压缩：compaction 预置太激进会丢上下文；把它做成可配置，用长会话测试，并保留上一版值以便回滚。
- 确认通道：不确定的范围先向人确认（全局人设提示词规则）；确认请求有截止时间与可见状态，链路断开标为 `failed`，不静默挂起。
- 迁移误分类：dry-run 逐条列出候选的类别、原因、主题、字节数与目标；apply 拒绝过期的报告哈希；备份让错误迁移可逆，日志让重复 dry-run 收敛。被误归档的 global 事实可以重新加回，代码回滚后仍能解析重写过的版本 1 文件。
- 旧记忆外壳：按工作区的 `MEMORY.md` 读取器（`memory-file.ts`）、它的清理、窗口与 checkpoint 模块，以及 `memory` 设置行作为旧文件与迁移的兼容代码保留。它们没有活的写入或注入路径；等迁移在部署数据上跑过再删除。
- 所有会话的爆炸半径：提示词或工具集的缺陷现在会波及普通会话。第 3 步按“先工具集、再切静态提示词与删注入”的顺序上线，并保留上一版提示词作为一版构建期回滚。零注入回归测试就是门禁：只要有一轮记忆消息被追加，构建自己的测试就会红。
- 回传的任务绑定已实现：跨工作区发送要求任务在调用者工作区、`targetSessionId` 是调用者、`dispatcherSessionId` 是目标；`task.dispatcherSessionId` 由 `create` 写入。没有绑定的跨工作区发送（包括 super agent）一律拒绝。

### 10.4 本轮确认

- 任务状态：只用新词表；旧任务数据不迁移；以后需要时用一次性脚本。
- 发消息：同工作区可互发（任何 agent）；跨工作区只按任务绑定回传放行（已实现）；发送方（任何 agent）标紧急，工具按三种情况校验；提示词教短回复。
- 回复格式：结论、依据、下一步；最多 6 行或 600 字符；文件用引用。
- 任务类型：分析定位、修复、测试验证、迁移部署、设计文档、其他；封闭清单，只由评审改动。
- 产物访问：拉用 `request`/`grant`，推用消息引用；由工具先执行哪个决定；同工作区策略可自动授权；跨工作区读取需要显式授权；denied、pending、expired、missing、changed 分开。
- ask user 与用户批准：不确定的范围先向人确认（全局人设提示词规则），对所有 agent 生效；请求状态可见，不静默挂起。
- 工作区清单：只列已注册工作区；子目录被拒绝，并提示注册。
- compaction：保留；默认在上下文预算用到 40% 时触发；可配置；super agent 可用不同 agent 预置（默认 40%，可调）。
- 回合结束投递：删除；不留兜底；回复是结论、依据、下一步，不写报告。
- JIRA：已整体退场，只保留 GitHub 上的 cloudstore 数据仓，按数据原样保留，不接入任何工具或流程，不作为设计能力，也不需要凭据或 remote 接入说明。
- JIRA 本地数据：本地账本与派发历史已删除，不可恢复；没有工具读取它们。
- 派发历史：丢弃；不迁移、不导入；`workspace_tasks` 从空白开始。
- JIRA 技能与 super agent 会话别名：移除；不保留别名。
- 意图卡：只在需要正式任务记录、规范 session 信息沟通与管理时使用；简单或明确的动作不需要单独发卡。工作区记录，一张卡一个工作区；跨工作区请求由发起方拆成每个工作区一张卡，原话逐字保留（每个工作区各调一次 `create`，因为工具没有多工作区参数）；每一项都标来源；全可追溯版本直接 active；含推断项的版本为 proposed，建任务前确认一次；active 版本复用，不再确认；纠正追加版本并 supersede 上一版。

## 11. 意图卡：派发对齐

### 11.1 要修的失败

把用户需求拆成任务时，需求会在拆解里被重新表述，每次重新表述都可能走样；用户纠正后，下一次任务又丢掉纠正，同样的偏差再出现。提示词只能降低概率，不能让意图持久：任务带的是转述，不是用户原话；建任务前没人检查任务，执行后也没人对照结果。

这是结构性问题，所以修法是一个工作区记录：意图卡。需要正式任务记录时，发起方写一次；任务引用它；建任务时校验；回执逐条对照；用户纠正以追加方式写回。卡属于工作发生的那个工作区，不属于宿主，也不属于记忆；简单或明确的动作不建卡。

### 11.2 意图卡

意图卡是一个工作区对一次用户请求的记录。它有一个稳定 id 和追加式版本。

| 字段 | 含义 |
|---|---|
| `intentId` | 工作区内这次请求的稳定 id |
| `workspaceId` | 这张卡所属的唯一工作区 |
| `version` | 1、2、3……；每次纠正追加新版本 |
| `status` | 不可变版本文件里是 `proposed` 或 `active`；`superseded` 是 `index.json` 记录的当前状态 |
| `rawUserText` | 用户原话，逐字保留 |
| `items` | 目标、验收点、边界、产出形式；每一项都带来源标注 |
| `sourceSessionId`、`sourceTurn` | 用户在哪里提出请求 |
| `createdAt`、`author` | 这一版何时、由谁创建 |
| `confirmedAt`、`confirmedBy` | 推断项何时、由谁确认；记录在 `index.json` 的版本摘要上，不在版本文件里 |
| `supersedesVersion` | 这一版替换的上一版（若有） |
| `requestId` | 写入这一版的 create 或纠正的幂等键 |
| `reason`、`correctionText` | 纠正原因与用户的纠正消息，版本 2 起才有 |
| `changedPoints`、`changedPointRefs` | 改动项文本与稳定的 `kind[index]` 点身份，用于重复率 |
| `taskType` | 纠正时能确定归属的六类任务类型 |

每一项是 `{ text, source, anchor?: { path, heading? }, reason? }`，出现在 `goal`、`acceptance`、`boundaries` 或 `outputForm` 里。`rawUserText` 不是条目；它逐字保存，永不被转述。点身份（`goal[0]`、`acceptance[1]`……）是派生的，不落盘。`confirmedAt` 不存放在版本条目上；工具从 `index.json` 的版本摘要把它投影到返回的每个推断项上。

- `user-verbatim`：条目文字从 `rawUserText` 原样复制，没有转述。可追溯。
- `user-anchor`：用户点名了一个工作区文档或章节；`anchor` 记录工作区相对路径与标题，条目引用该锚点。可追溯。
- `inference`：发起方按自己的理解写的条目。不可追溯，需要确认。

存储：`$DSH_HOME/workspaces/<workspace-id>/intents/<intentId>/`，含 `index.json`（追加式版本列表，以及每个版本的当前状态、确认与拒绝元数据）和 `versions/<n>.json`。版本文件不可变：纠正写新版本，旧版本永不改写或删除。它是工作区状态，与任务、消息、产物记录放在一起，不是宿主全局意图目录，也不是记忆。

归属：意图归用户。发起方可以按请求创建版本并标注每一项；工作区内任何 agent 都可以写卡，跨工作区写要求 super agent。所有条目都可追溯的版本直接创建为 `active`；含推断项的版本创建为 `proposed`。用户确认推断项或追加纠正。任何人都不能静默改写 active 版本。

### 11.3 按版本确认

确认按版本进行，而且只针对推断项。

- `workspace_intents.create` 根据来源标注计算状态。所有条目可追溯就是 `active`，不需要用户交互。
- 只要有一项推断，状态就是 `proposed`。create 结果带一个汇总确认请求：`{ requestId, items: [{ point, text, reason }] }`。何时向人确认由全局人设提示词规则决定；工具只产生一个汇总请求，不分项重复提问。
- `workspace_intents.confirm` 接收 `{ intentId, version, decision: 'confirm' | 'reject', note?, requestId }`。确认更新 `index.json` 里该版本的摘要（`status: 'active'`、`confirmedAt`、`confirmedBy`、`confirmedPoints`），版本文件 `versions/<n>.json` 不改；工具在返回时把 `confirmedAt` 投影到每个推断项上，并保留来源标注以便追溯。拒绝在摘要上记录 `rejectedAt`/`rejectedBy`，版本保持 `proposed`，派发继续被拦。
- 一个 `active` 版本会被之后每次派发复用，不再确认。纠正会追加新版本；上一版本在 `index.json` 里变为 `superseded`。
- 引用 `proposed` 版本的任务返回 `INTENT_UNCONFIRMED` 和待确认 id；它不会为每一项单独产生确认。

### 11.4 派发前校验

`workspace_tasks.create` 必须带 `workspace`（目标）、`goal`、`acceptance`、`boundaries`、`intentId`、`intentVersion`、`taskType` 与 `requestId`。缺任一项返回 `INTENT_INCOMPLETE`。缺卡，或卡里没有这个版本，也返回 `INTENT_INCOMPLETE`。`proposed` 版本返回 `INTENT_UNCONFIRMED`。被 supersede 或不是最新 active 的版本返回 `INTENT_STALE`，调用方必须重读卡。卡属于别的工作区时返回 `INTENT_SCOPE_MISMATCH`；任务必须引用自己工作区的卡。

服务随后做覆盖检查：卡里的每个目标、验收点、边界、产出形式，都必须映射到任务简报里的一项。调用方提供 `coverage: [{ point, brief, note? }]`，其中 `point` 是卡的点身份（例如 `acceptance[0]`），`brief` 必须与对应字段的任务简报项在空白归一后一致；缺映射返回 `INTENT_COVERAGE_MISSING`。唯一豁免是派发方作为派发确认提供的、带非空原因的显式 `nonCoverage: [{ point, reason }]`（当前阶段由 super agent 承担）。不允许默认通过，也不允许“假设已覆盖”。

schema 与服务强制这件事；提示词只说顺序：先读卡，再读任务，再写覆盖清单。忘了卡的模型无法派发。

### 11.5 执行后对齐

任务返回时，发起方用任务引用的同一个 `intentId` 与 `intentVersion` 核对回执。每一项得到一种状态：

- 验收点：`satisfied`、`not_satisfied`、`out_of_scope`；
- 边界：`respected`、`violated`；
- 产出形式：`matched`、`not_matched`。

每个状态都带证据：改动的文件、测试、报告行，或缺了哪一项。对齐由发起方或校验方产出，不是执行方自证。`done` 迁移要求覆盖全部卡点的完整对齐清单：缺清单以 `INTENT_ALIGNMENT_MISSING` 拒绝，清单漏点以 `INTENT_ALIGNMENT_INCOMPLETE` 拒绝，出现 `not_satisfied` 验收点或 `violated` 边界则以 `INTENT_ALIGNMENT_UNSATISFIED` 拒绝，并把任务移到 `waiting_review` 或 `blocked` 并带回偏差清单。`out_of_scope` 的验收点与 `not_matched` 的产出形式点不阻止 `done`。给用户的回执包含清单与偏差，走样以列表出现，而不是等用户发现。任务执行期间出现新卡版本，不改变这个任务对照的版本。

### 11.6 纠正沉淀与重复

每次用户纠正追加一个新意图版本，带 `reason`、纠正消息（`correctionText`）与改动项（文本在 `changedPoints`，稳定的 `kind[index]` 点身份在 `changedPointRefs`）。上一 active 版本在 `index.json` 里变为 `superseded`，仍可读。新版本遵循同样的来源规则：可追溯条目让它直接 `active`；含推断项则先 `proposed`，等确认。

下一次需要正式任务记录时自动读最新 active 版本；没有人靠记忆转述意图。重复纠正同一个点时，两个版本都记录该点。存储按跨纠正的卡点身份统计重复，让反复出现的偏差变成数字，而不是印象。

### 11.7 度量

偏差率 = 用户纠正次数 / 派发任务数。`metrics` 动作返回两个全工作区窗口（7 天与 30 天），以及按任务类型分组的同样窗口（`byTaskType`，只列有记录的类型）；分母为 0 时比率为 `null`。一次用户纠正产生一个新意图版本，算一次纠正事件；同一次纠正改多个点只算一次。重复率 = 窗口内“该点身份以前已被纠正过”的纠正数 / 窗口内纠正数。

任务类型是六类封闭清单：分析定位、修复、测试验证、迁移部署、设计文档、其他。增加或改名需要评审，模型不能自选。

输入在三个点采集：意图版本追加、任务派发、回执对齐。任何指标都不依赖记忆或模型自报。

### 11.8 工具面

`workspace_intents` 是工作区工具集的第五个成员，排在会话、任务、消息、产物之后。它提供 `create`、`get`、`confirm`、`correct`、`history`、`metrics`。它遵循 5.1 节的作用域规则：默认调用方工作区；跨工作区调用必须显式给工作区 id，并留痕。意图卡对普通 agent 开放：`create`、`confirm` 与 `correct` 对工作区内任何 agent 开放，跨工作区写要求 super agent。

`workspace_tasks.create` 必须带 active 卡引用；`workspace_tasks.receipt` 接收对齐清单；缺完整清单，或有 `not_satisfied` 验收点、`violated` 边界时，状态机拒绝 `done`。

正式任务入口是 `workspace_tasks.create`，需要交付会话时再调用 `workspace_sessions.start`/`prompt`：按 active 卡版本建任务（卡引用、brief 的验收与边界、任务类型、覆盖映射、`requestId`），任务落盘之后启动会话，首个任务文本就是这条任务的工作内容；`start` 本身不检查卡。简单或明确的动作不建卡，直接执行或经 `workspace_message` 发请求。`append`、`prompt`、`abort` 只是继续一个已启动的会话，不创建第二条任务。工作区工具集挂在同一组合里，因此 `workspace_intents` 与 `workspace_tasks` 在每个 agent 上；写动作对每个 agent 的工作区开放，跨工作区写要求 super agent。卡校验、覆盖检查与幂等规则只实现一次，同一实现经 `ctx.workspaceTasks` 服务暴露给派发方；该服务不是模型面，也不自己做角色检查。

第 4 步之后的当前状态：工具已经强制任务拒绝码、覆盖检查、回执门、静态工作区目录、消息作用域与幂等规则，以及产物发布/引用。`workspace_message.send` 与 `workspace_artifacts.publish`/`reference` 已交付；产物的 `request`/`grant` 尚未。卡片 UI 出现之前，`create`、`confirm` 与 `correct` 对工作区内任何 agent 开放；跨工作区写要求 super agent。`nonCoverage` 条目是派发确认的显式豁免，连同理由记录在任务上；它不是默认通过。

### 11.9 不做什么

这不是更强的提示词，也不是所有动作的必经流程。需要正式任务记录时，提示词只说去哪里查、按什么顺序：读意图卡，再读任务，再写覆盖清单；简单或明确的动作直接执行。约束在 schema、确认状态、覆盖检查、回执门与工作区存储里。

它也不把意图卡放进记忆、放进宿主全局意图目录，或额外建一个工作区索引。它不要求全可追溯版本走确认，也不对 active 版本重复确认。

### 11.10 验收测试

1. 可追溯的卡不经确认即可派发：`workspace_intents.create` 只含 `user-verbatim` 与 `user-anchor` 条目时返回 `status: 'active'`；`workspace_tasks.create` 不调用确认也能成功。
2. 含推断项的卡在确认前被拦：有一条 `inference` 的卡返回 `status: 'proposed'`；`workspace_tasks.create` 返回 `INTENT_UNCONFIRMED`；`workspace_intents.confirm` 确认该版本后变 active；同一版本随后可派发，第二个任务复用它且不再确认。
3. 跨工作区请求拆卡：派发方为每个目标工作区各调一次 `workspace_intents.create`（工具只接受单个工作区，没有多工作区清单），各建一张卡；两张卡的 `rawUserText` 逐字节一致；A 里的任务引用 A 的卡；在 A 里引用 B 的卡返回 `INTENT_SCOPE_MISMATCH`。
4. 纠正追加版本：`workspace_intents.correct` 创建版本 2，把版本 1 标为 `superseded`，版本 1 及其原始条目仍可读；下一个任务引用版本 2。
5. 覆盖检查生效：简报漏掉一个验收点时返回 `INTENT_COVERAGE_MISSING`；补上该点或给出显式不覆盖理由后才放行。
6. 有偏差的回执被门控：没有对齐清单的任务返回 `INTENT_ALIGNMENT_MISSING`，清单漏点返回 `INTENT_ALIGNMENT_INCOMPLETE`，对齐含 `not_satisfied` 或 `violated` 时返回 `INTENT_ALIGNMENT_UNSATISFIED`，任务不能进 `done`。

这些测试在 `packages/uitstalie/workspace-tools/tests/intents.spec.ts` 中运行；同一文件还覆盖 `INTENT_INCOMPLETE`、`INTENT_STALE`、`INTENT_SCOPE_MISMATCH`、角色拒绝、子目录拒绝、`requestId` 重试与 history cursor。

## 12. 能力盘点：memory 与 super agent

本节列出两个界面今天提供的能力、新设计是否保留、以及不保留时的替代。

### 12.1 memory 能力

| 能力 | 今天解决的问题 | 还需要吗？ | 新归属 / 替代 | 动作 |
|---|---|---|---|---|
| 写入 | 记录任何持久结论，包括业务事实 | 只留全局事实与约定 | `memory_write` 只写 global | 已实现：只收五个 global 主题；业务、派发与 persona 文本以 `NOT_GLOBAL_MEMORY` 加工具提示拒绝 |
| 检索 | 搜记忆条目与会话历史 | 只搜记忆 | `memory_search`；会话检索是 `session_search` | 已实现：只搜 `GLOBAL.md` 与 `GLOBAL.archive.md` |
| 读取 | 把某一轮会话读成转录 | 不要 | `session_event_read`、`workspace_sessions` | 已实现：工具集中不存在 |
| 忘记 | 按会话、turn、kind、tag 遗忘 | 只处理 global | `memory_forget` 去掉会话过滤 | 已实现：只按 `topic` 或 `entryId` |
| 归档 | 让被移除的条目仍可搜 | 只留 global | 全局归档；业务历史留在工作区 | 已实现：`GLOBAL.archive.md`；工作区归档只是旧数据 |
| TTL 与过期 | `open`/`files` 3/14 天过期 | 不要 | 随 dispatch 命名空间删除 | 删除：没有活的路径；旧读取器只为解析旧文件保留该规则 |
| 快照注入 | 每轮记忆快照 | 不要 | 静态提示词 + 工具查询 | 已实现：已删除；注入面为空 |
| 摘要生成 | 写每轮业务条目 | 不写记忆条目 | 只做 compaction 摘要，不做记忆 | 已实现：每轮摘要作业已移除 |
| 跨会话索引 | “Recent sessions” 概要 | 不要 | `workspace_sessions` | 已实现：随快照在第 3 步删除 |
| 全局与个人偏好共享 | 把跨工作区事实与画像/风格混在一起 | 拆开 | 全局记忆放事实；personality 放画像与风格 | 已实现：画像与风格归 `personality_apply` / `write_like_human` |

意图卡不是记忆能力；它是工作区记录，永不进入全局记忆存储。

第 4 步之后的实现状态：每一行都按 Action 列所述实现。注入面为空，所以没有任何记忆条目——global 或旧工作区——被注入；已确认的 global 条目只能通过 `memory_search` 读取。10.3 节点名的旧模块为迁移与旧文件解析而保留，`memory` 设置行保留但暂不生效，直到旧外壳删除。

### 12.2 super agent 能力

| 能力 | 今天解决的问题 | 还需要吗？ | 新归属 / 替代 | 动作 |
|---|---|---|---|---|
| 工作区注册与清单 | 提示词里注入静态清单 | 需要 | 保留注册表；提示词静态；状态用 `workspace_sessions` | 保留、改造 |
| 会话创建、复用、归档 | super agent 会话工具 | 需要 | 会话服务；`workspace_sessions`；不复制进记忆 | 下移 |
| 派发 | 认领/派发工具加 JIRA 认领 | 需要 | `workspace_message`/`workspace_sessions` 直接发起；需要正式记录时用 `workspace_tasks`；JIRA 认领与派发下线 | 下移 |
| 意图捕获与对齐 | 请求在拆成任务时被重新表述，可能走样 | 需要 | `workspace_intents` 作为工作区记录，加 `workspace_tasks` 覆盖检查与回执 | 新增 |
| 派发记录与回执 | 派发历史与手工账本 | 需要 | `workspace_tasks` 的任务与回执；从空白开始，不迁移 | 下移 |
| 投递 | super agent 交付工具加回合结束路径 | 需要 | `workspace_message`；不保留回合结束兜底 | 下移 |
| 报告呈现 | 报告文件与投递 | 需要 | `workspace_artifacts` 引用加 `workspace_message`；界面渲染 | 下移 |
| 权限切换 | 权限切换工具 | 需要 | 权限预设服务 | 下移 |
| 长任务监控 | 会话状态与 JIRA 状态 | 需要 | `workspace_sessions` 状态与进展，加写租约 | 下移 |
| 跨工作区协作 | 派发，以及把事实复制进记忆 | 需要 | `workspace_tasks`、`workspace_message`、`workspace_artifacts`、`workspace_intents` 显式范围；永不进记忆 | 下移 |

第 4 步之后的当前状态：`workspace_intents`、任务创建、覆盖检查、回执门、`workspace_message.send`、产物发布/引用与静态工作区目录已经实现；JIRA 及其工具、回合结束投递都不存在。任务创建、意图卡写入与会话生命周期写动作对工作区内的 agent 开放；跨工作区写仍限 super agent（已实现）。本表记录的是目标归属，已实现的行就是本代码树已交付的状态。

## 13. 附录：未来方向

看板是以后可能出现的界面。它的数据来自工作区工具集：`workspace_sessions`、`workspace_tasks`、`workspace_message`、`workspace_artifacts`；`workspace_intents` 提供派发上下文，记忆只贡献全局事实。记忆卡片流、按工作区的记忆索引、事件日志存储都明确不在范围内；如果看板以后需要，那是在同一套工具集上的新设计，不是对记忆模型的修改。意图卡是工作区记录，不是记忆。

## 14. 第 3 步与第 4 步的部署验收

本节没有任何一项已经在部署后的 Windows 主机上验过。它给的是明天同步这个分支、部署、继续工作的人用的清单。**CI** 表示本分支的自动化套件已经覆盖该项；**Deploy** 表示必须由真实进程、真实会话或运行中的 GUI 确认，或必须在真实 `$DSH_HOME` 与真实工作区上执行，测试套件证明不了。不要只凭测试套件勾选 **Deploy** 项，也不要在勾选之前汇报“第 3–4 步已部署验收”。

自动化的一半是 `pnpm exec vitest run packages/uitstalie/memory packages/uitstalie/workspace-tools`。

### 14.1 普通会话：没有每轮记忆注入

- [ ] 一个全新的普通工作区会话，在至少三个 turn、其中至少一次 `memory_write` 之后，持久日志里 `source.kind` 为 `memory` 的 `user/message` 事件数为 0，记忆字节数为 0。CI：注入测试（`neither a legacy workspace file nor the global file is injected per turn`，`packages/uitstalie/memory/tests/provider.spec.ts`）断言写入一次并完成一个 turn 后没有记忆消息；多轮计数是 Deploy 项。Deploy：读真实会话的日志或表面并计数。
- [ ] 组装后的系统提示词里没有名为 `memory-state` 的段。CI：同一 spec 断言组装结果。Deploy：在运行中的宿主里检查提示词。
- [ ] 在已有 `MEMORY.md` 的工作区里恢复会话，不会收到快照。CI：没有专门的恢复测试；快照代码与启动钩子已删除，注入测试断言新会话没有记忆消息。Deploy：在 `MEMORY.md` 已有条目的工作区打开一个会话。
- [ ] 写入后不出现“Memory updated”消息，完成的 turn 后不出现“Memory snapshot”消息。CI：注入测试断言一次写入与一个完成 turn 后记忆消息数为 0，两个字面字符串随快照模块一起删除。Deploy：在 GUI 里做一次写入、完成一个 turn。

每轮摘要作业已移除，所以不再追加摘要失败通知。如果仍看到 `form: 'notice'` 的记忆消息，那是残留代码路径，应当按注入回归处理。

### 14.2 只有工具能投递

- [ ] 一个不调用 send 的 turn 什么都不投递：没有消息记录，也没有 prompt 进入别的会话。CI：`a turn with no send delivers nothing`（`packages/uitstalie/workspace-tools/tests/delivery.spec.ts`）。Deploy：在会话 A 跑一个 turn，确认会话 B 的收件箱没变、也没有写入 `messages/*.json`。
- [ ] 消息与产物引用能往返。CI：`a message round-trips with its artifact reference`。Deploy：从 super agent 发给工作区会话并读回。
- [ ] 用同一个 `requestId` 重试发送，返回第一条消息且不追加第二条。CI：`a repeated requestId returns the first message without a second delivery`。Deploy：重复调用并比较 id。
- [ ] `workspace_sessions` 能回答“上一轮做了什么”。CI：`"what did I do last turn" is answered by workspace_sessions`。Deploy：在一个真实 turn 之后提问，确认答案是会话自己的进度，而不是记忆通知。
- [ ] 跨工作区发送只在任务绑定时放行：非绑定发送（普通 agent 或 super agent）被拒绝，绑定发送成功且调用留痕。CI：`a cross-workspace send is allowed only as a task-bound return`。Deploy：两种都试一次。
- [ ] 发布工作区根外的路径被拒绝。CI：`publish refuses a path outside the workspace root and a missing file`。Deploy：用相对 `..` 路径重复一次。
- [ ] 静态 `workspace-directory` 提示词段列出已注册工作区，且不含状态、任务或记忆数据。CI：`every session gets the same static workspace directory section`。Deploy：比较两个会话与 super agent 的提示词。

### 14.3 已验证：任务绑定的跨工作区回传

- [ ] 执行者用 `workspace_message.send` 带 `taskId` 回传给发起会话；`workspace_tasks.create` 已写入 `dispatcherSessionId`，跨工作区发送只在任务绑定时放行（`targetSessionId` 是调用者、`dispatcherSessionId` 是目标）。CI：`a cross-workspace send is allowed only as a task-bound return` 覆盖绑定成功、非绑定拒绝与 `dispatcherSessionId` 回读；`delivery.spec.ts` 同时覆盖同工作区回传。Deploy：在真实派发上确认回传只走 `workspace_message.send`，不出现任何回合结束投递。

### 14.4 第 4 步：只留 global 记忆并迁移

- [ ] dry-run 报告逐文件逐条列出类别、建议主题、原因、字节数与目标路径，并且不写任何记忆数据。CI：`the dry run reports files, entries, classes, bytes, and the target without writing data`（`packages/uitstalie/memory/tests/migration.spec.ts`）。Deploy：对每个已注册工作区运行 `migrate-global-memory.ts --workspace <dir> ...`，确认 `$DSH_HOME/memory` 未被改动。
- [ ] apply 拒绝与最新扫描不符的报告哈希，拒绝时不写任何东西。CI：`apply refuses a report hash from another scan`。Deploy：用过期哈希重试 apply。
- [ ] 每个被改文件在第一次写入之前都有备份，回滚能还原完全相同的字节；旧 `MEMORY.md` 在 apply 前、apply 后与回滚后都能解析。CI：`apply migrates only confirmed global entries, backs up every changed file, and keeps old files parseable`、`rollback restores the exact original bytes and makes the first report reproducible`。Deploy：检查 `$DSH_HOME/memory/migration/runs/<run-id>/`，在一个真实工作区的副本上 apply 再回滚。
- [ ] `$DSH_HOME/memory/GLOBAL.md` 只含已确认的 global 条目；业务、派发、persona 与无法判定的文本不在其中，并在报告里列为已丢弃。CI：同一 apply spec。Deploy：真实 apply 后读全局文件。
- [ ] 注入面不含任何记忆条目：在旧 `MEMORY.md` 与已写入的 `GLOBAL.md` 同时存在时，会话收不到任何记忆来源的消息，也没有 `memory-state` 段。CI：`neither a legacy workspace file nor the global file is injected per turn`（`packages/uitstalie/memory/tests/provider.spec.ts`）。Deploy：打开一个会话检查提示词与日志。
- [ ] 业务写入以 `NOT_GLOBAL_MEMORY` 加工具提示拒绝，完成的 turn 不写任何记忆条目。CI：`a business write is refused with the workspace tool hints`、`a completed turn writes no memory job, no MEMORY.md, and no memory message`。Deploy：用业务事实调用 `memory_write`，再完成一个 turn。

dry-run 已在七个真实工作区上跑过；[dry-run 复核](memory-migration-dryrun-review-20261118.zh.md)记录 27 条 global 候选里有 23 条不属于 global 类，以及业务历史的检索缺口，因此上面的 apply 项仍未勾选。

### 14.5 CI 证明不了的部分

- 真实 Windows 部署、GUI、进程重启与恢复、真实的多工作区注册表，以及真实记忆文件都在套件之外。上面标 **Deploy** 的项就是人工门禁；在部署主机上勾选之前，它们保持未勾选。
- 迁移故意不在 CI 里对真实数据运行。它的报告、备份与回滚只在临时 `$DSH_HOME` 与临时工作区上验证；真实 apply 仍是需要人确认的一步，不是自动部署动作。
