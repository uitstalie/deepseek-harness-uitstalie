# 面向所有会话的记忆与工作区信息：静态提示词、一套工具集、只留全局记忆

[English](memory-scoping.md) | 中文

状态：评审稿。篇幅：不受 12 页上限约束，以内容完整为准；本稿约 11,100 汉字（约 18 页）。

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

约有 50 到 60 条是派发或会话状态：“已派发给会话 X”“等待回执”“会话已中止”“第三个任务暂缓”。派发账本已经持有这些状态，记忆里的副本只是第二个、而且是会过期的来源。

### 1.5 每轮追加的注入是最大成本

每次摘要都会追加一条快照，每次显式写入都会追加一条更新通知。结果是 812 条快照（216 KiB）、350 条 “Memory updated” 通知、149 条 checkpoint（含 704 条条目文本，240 KiB）。这些都不是有界、可查询的视图，而是随会话生命周期不断增长的追加流，模型把它当上下文读。它是会话表面无限增长的主要原因，必须删除，而不是调参。

### 1.6 丢数据缺陷：超上限的条目被直接丢弃，不写归档

`pruneSessionEntries`（`memory-file.ts:2857-2928`）用“丢弃最旧的整段 section + 丢弃完全重复文本”来执行每会话 40 条上限。它返回的是计数，不是归档记录；`retainDocument`（`memory-file.ts:2591`）把这个计数丢掉；写入路径只归档字节预算与清理产生的删除（`memory-file.ts:1358-1374`）。因此被丢的条目没有留下任何痕迹。

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
- 除新增工作区工具集与迁移投递外，不重做会话、账本、JIRA 的工具契约。
- 不改全局配置。
- 除删除每轮注入外，不做快照或前缀缓存优化。
- 不提供按会话类型恢复快照、更新通知或 checkpoint 的开关或特例。
- 不保留 JIRA 兼容层：JIRA 已废弃，按停用处理，后续重新设计；`jiraKey` 与账本兼容都不保留。
- 不重排 personality、JIRA、`.dsh` 存储这三类工具；那是一个独立设计项（见 2.3）。

### 2.3 关联设计（不在本文件范围）

- `personality`、`jira`、`dsh` 工具的重新排布是独立设计项；本文件只声明依赖与冲突点。
- `jira` 工具已废弃：按停用处理，不保留兼容层；下线与后续重新设计是另一个设计项。
- 跨文档结论（细节归工具面设计）：
  - 命名空间归属：不改 `dsh_*`；`tool-dsh-store` 保留名字；
  - `superagent_*` 与 `workspace_tasks`：编排工具迁到 `workspace_*`；本文件的表在批准后修订；
  - personality 存储：不合并；`memory_*` 收窄后画像与写作规则仍分开；
  - `.dsh` 工具：`tool-dsh-store` 仍是唯一经校验的入口；产物引用它，而不是取代它；
  - JIRA：已废弃，不保留兼容层。
- 本文件不修改这三类工具的契约。

## 3. 关键决策

### 3.1 提示词只带静态工作区目录

提示词里每个已注册工作区一行：标题、id、目录。它在会话启动时由工作区注册表生成，不随轮次变化。只列已注册工作区；子目录不是工作区，会话试图创建或寻址子目录时会被拒绝，并提示先注册该目录。

为什么：提示词是固定契约。任何动态内容要么迫使重写提示词，要么变成追加消息，812 条快照正是这样堆出来的。状态、进展、任务、产物一直在变，属于查询，不属于提示词。

代价：模型必须调用工具才知道某个工作区在做什么。这是从“全部推送”到“按需拉取”的有意转变。同一份静态清单对所有会话生效；普通工作区会话与 super agent 使用同一套契约。

### 3.2 一套工作区信息工具集负责状态、任务、消息与产物

同一组工具回答：有哪些会话、每个在做什么、有哪些派发任务及其回执、怎么向会话发消息或追问、某个会话或任务的产物在哪里。

为什么：这些问题天然带范围，工具可以从调用会话派生并强制这个范围；记忆条目做不到，它只是一份没有主人、没有过期的副本。

代价：工具调用变多，需要维护新的工具面，还要在工具集、JIRA 账本与会话存储之间划清归属。

### 3.3 记忆只留 `global`

记忆只保留跨工作区的事实与约定：共享服务器地址、harness 默认模型、统一规矩、跨工作区用户偏好。派发状态与业务事实在写入时就被拒绝。

为什么：在 3.1 与 3.2 之后，记忆唯一还剩的独特价值，就是“处处适用、又没有更合适主人”的事实。

代价：不再自动回忆业务结论；模型必须查询，而查询可能比读一条注入条目慢。

### 3.4 删除每轮记忆注入

记忆快照、`memory-state` 提示词段、以及 “Memory updated” 通知全部删除，而且对所有会话生效，不只 super agent。上下文压缩保留；它只在 compaction 边界发生，并且不是记忆消息。默认在上下文预算用到 40% 时触发 compaction；阈值可配置，super agent 可以对不同 agent 用不同预置（默认 40%，可调）。

为什么：812 条快照与 350 条更新就是洪水；调小体积或降低频率只是让它慢一点。

代价：模型失去一份“一直在眼前”的最近工作摘要，这部分信息改由 `workspace_sessions` 与 `session_event_read` 提供。上下文压缩仍需要 compaction 路径，所以现有 checkpoint 机制只保留为 compaction 行为，不再作为每轮记忆功能。

### 3.5 投递改成工具调用，不保留回合结束兜底

发送消息、追问、传文件引用，都改成显式的 `workspace_message` 或 `workspace_artifacts` 调用。回合结束投递路径删除，不保留兜底。

为什么：隐式的回合结束投递分不清“新问题”和“旧问题”，没有引用模型，也没法在会话之间传文件或引用。显式调用可以携带产物引用、幂等键与投递回执。

代价：模型忘记调工具就什么都不发，所以提示词必须教它什么时候回、怎么回。回复要短：结论、依据、下一步，不写报告式长文。

## 4. 数据模型

### 4.1 记忆：只有 global 条目

一条记忆有四个字段：`topic`、`source_session_id`、`created_at`、`text`。`topic` 来自封闭白名单：`global-model`、`global-server`、`global-convention`、`global-account`、`global-tooling`。没有 `workspace_id`，没有 `dispatch`，没有过期时间，没有 `tags`，也没有作为作用域键的 `kind`。

- 同主题的新条目归档旧条目。
- 存在 `$DSH_HOME/memory/GLOBAL.md`，经全局 store 读写（`store-atom/src/service.ts:107-113`、`store-atom/src/service.ts:193-213`）；整文件上限 8 KiB。
- 状态只有 `active` 与 `archived`，没有任何按工作区区分的状态。

### 4.2 工具集记录

工具集自己持有它返回的记录，记忆不复制它们。

| 记录 | 逻辑字段 | 归属 |
|---|---|---|
| 会话进展 | 会话 id、标题、状态、当前 turn、当前活动、最近进展时间、最新进展一行 | 会话存储，由工具汇总 |
| 派发任务 | 任务 id、工作区、标题、目标、验收、状态、负责人、创建/更新时间、回执、产物引用 | 派发账本；非 JIRA 工作另有一份通用任务日志 |
| 消息 | 消息 id、目标会话、正文、类型（消息或追问）、投递状态、回执、产物引用 | 会话 inbox 与消息日志 |
| 产物引用 | 产物 id、工作区、路径、sha256、大小、版本、类型、会话 id、任务 id、创建时间、摘要 | 工作区产物索引 |

工具集不得复制账本、会话存储或工作区文件已经持有的事实。它只做聚合与变更，通用任务日志只覆盖 JIRA 账本没有的工作。

### 4.3 提示词数据

每个已注册工作区一行：`- <标题> (<id>) · <目录>`。清单在会话内静态，不含状态、不含记忆、不含任务数据。只列已注册工作区；子目录被拒绝，不当作工作区。

## 5. 工作区信息工具集

### 5.1 公共范围规则

- 调用会话所在工作区是默认范围。跨工作区查询必须显式给 `workspace` id，且该 id 必须在工作区注册表里；该调用会被记录。
- 目标是已注册工作区的子目录时，按“未知工作区”拒绝；绝不把子目录自动注册成新工作区。
- 查询只返回属于指定工作区的记录。不做隐式的跨工作区聚合；跨工作区视图必须显式列出工作区 id。
- 结果都是有界摘要：不返回文件内容，不返回完整转录，并带游标分页。原始内容仍走 `read`、`session_event_read`，以及第 6 节的产物引用解析。
- 读取对工作区内任何 agent 开放。创建任务与修改状态需要派发方角色；会话可以更新自己的任务、追加自己的回执。
- 每个变更都带请求 id，重试不会重复创建任务、消息或回执。

### 5.2 `workspace_sessions`

列出工作区里的会话，并报告每个会话在做什么。

输入：

```
{ action: 'list' | 'get', workspace?, sessionId?, status?, cursor?, limit? }
```

输出（`list`）：`{ items: [{ sessionId, title, status, currentTurn, currentActivity, lastProgressAt, latestProgress, taskId? }], nextCursor? }`。

输出（`get`）：同样的字段，外加 `recentProgress: [{ at, summary }]`、`pendingInbox`、`artifactCount`。

范围：只返回与解析后范围匹配的工作区会话。`status` 取 `running`、`idle`、`blocked`、`done`。`currentActivity` 是从当前 turn 派生的有界一行摘要，不是完整转录。

### 5.3 `workspace_tasks`

创建、读取、更新派发任务及其回执。

输入：

```
{ action: 'list' | 'get' | 'create' | 'update' | 'receipt',
  workspace?, taskId?, status?, targetSessionId?, title?, goal?, acceptance?, boundaries?,
  intentId?, intentVersion?, taskType?, alignment?, note?, cursor?, limit? }
```

- `create` 返回 `{ taskId, status, createdAt }`；`goal` 与 `acceptance` 必填；`targetSessionId` 可选。`create` 还必须带 `intentId` 与 `intentVersion`；缺失、过期或未确认的版本拒绝派发（见 11 节）。`taskType` 必填，取 11.6 节的六类封闭清单。
- `update` 接受 `status`、`note`、`assignee`；允许的迁移是 `pending → in_progress → waiting_review → done | blocked | cancelled`，任何状态都可以回到 `in_progress`。
- 上面的词表就是新体系的词表。旧任务数据不迁移：旧状态作为历史文本保留，不做映射。以后确实需要时用一次性脚本转换；该脚本不在本设计内。
- `receipt` 追加 `{ status, note }`，返回 `{ receiptId, at }`。
- `get` 返回任务、回执、目标会话与产物引用。
- `list` 按工作区、状态、负责人过滤。

范围：一个任务只属于一个工作区。变更必须来自派发方，或来自被指派该任务的会话。跨工作区列任务必须显式给工作区 id。

### 5.4 `workspace_message`

向一个会话发送消息或追问，并读取投递回执。完整的投递与引用设计在第 6 节。

输入：

```
{ action: 'send' | 'read', targetSessionId?, messageId?, text?, kind?: 'message' | 'followup',
  priority?: 'normal' | 'urgent', replyTo?, references?, taskId?, requestId? }
```

- `send` 返回 `{ messageId, deliveredAt, status: 'queued' | 'delivered' | 'interrupted' | 'target_archived' }`。重复的 `requestId` 返回第一次的结果。
- `read` 返回消息及其回执：`{ messageId, targetSessionId, text, references, receipts: [{ at, status }], nextCursor? }`。
- `priority` 默认 `normal`；`urgent` 只限下面三种情况。
- `replyTo` 把回复挂到它回答的消息上。
- 范围：同一工作区的会话可以互发；跨工作区经 super agent，不直发。目标必须是授权工作区里的会话；不支持广播；正文限制在一屏内。

正常与紧急：普通消息排队，在目标的下一个 turn 边界到达。紧急消息只限三种：纠正目标正在执行的错误结论；停止危险或不可逆操作；用户指令变更使当前工作失效。发送方（任何 agent）显式标 `priority: 'urgent'`，工具按这三种情形校验；super agent 在这里没有特殊性，它只是当前最早的派发方。紧急消息插入到目标的下一次工具调用之前，并可以中断当前步骤。现在所有消息都走正常追加，紧急纠正排在队列后面，错误结论可以一路跑完；这就是紧急通道要修的缺陷。

回复指引：普通 agent 在请求完成或受阻时，用 `workspace_message.send` 加 `replyTo` 回复。回复是结论、依据、下一步，几行，不写报告；文件用引用，不粘贴正文。提示词要写明这一点，因为普通 agent 不会自己推断工具契约。

ask user 与用户批准是独立的可靠性设计项，见 7.5。

在 `send` 上挂 `references` 就是推路径；见 6.6 节。

这个工具不是子代理树的消息工具。它面向工作区会话，包括调用方没有启动过的会话。

### 5.5 `workspace_artifacts`

发布、引用、请求、解析某个会话或任务产出的文件与报告。

输入：

```
{ action: 'publish' | 'reference' | 'request' | 'grant' | 'resolve' | 'list',
  workspace?, path?, sessionId?, taskId?, artifactId?, requestId?, approve?, reason?,
  kind?, summary?, pathPrefix?, cursor?, limit? }
```

- `publish` 登记一个文件并返回产物引用；不复制文件。
- `reference` 把已有产物引用挂到消息或任务上；不复制文件。
- `request` 是拉路径：需求方请求一个引用或路径，返回 `{ requestId, status: 'granted' | 'pending' | 'denied', grant? }`。同工作区策略可以立即授权；跨工作区请求默认 pending，等持有方授权。
- `grant` 是持有方或工作区策略对 pending 请求的决定：`{ requestId, approve }` 返回 `granted` 或 `denied`；只有持有方或策略可以调用。
- `resolve` 报告引用是否仍匹配、调用方是否持有授权；不返回内容。
- `list` 只返回引用；没有记录产物的任务返回空列表，不做猜测。

范围：路径必须落在工作区根内。工具只返回引用，不返回内容；调用方拿到有效授权后再用 `read` 读内容。引用模型在 6.4 节；拉与推的检查点在 6.6 节。

### 5.6 什么时候调哪个

| 问题 | 工具 |
|---|---|
| 这个工作区有哪些会话，分别在做什么？ | `workspace_sessions`，`action: 'list'` |
| 这个会话在做什么，最近发生了什么？ | `workspace_sessions`，`action: 'get'` |
| 创建一个派发任务，或改它的状态 | `workspace_tasks`，`action: 'create'` 或 `'update'` |
| 任务状态如何，执行方回了什么？ | `workspace_tasks`，`action: 'get'` |
| 带引用发一条消息或追问 | `workspace_message`，`action: 'send'` |
| 对方收到了吗？ | `workspace_message`，`action: 'read'` |
| 这个会话或任务产出的报告/文件在哪里？ | `workspace_artifacts`，`action: 'list'` 或 `'resolve'` |
| 这个会话在某一轮到底说了什么？ | `session_event_read` |
| 按内容找更早的会话 | `session_search` |
| 共享服务器地址、默认模型是什么？ | 记忆里的 `global` 条目 |
| 有哪些工作区？ | 提示词里的静态清单，不用调工具 |

### 5.7 看板读同一套工具集

未来的看板需要会话、进展、任务、回执、消息、产物。它们全部来自 `workspace_sessions`、`workspace_tasks`、`workspace_message`、`workspace_artifacts`。记忆不为看板贡献任何内容；看板不会向记忆查询会话、进展或任务。

## 6. 工具重新整合与投递改成工具调用

### 6.1 为什么工具要重排

现在 memory 工具兼着会话读取职责，super agent 工具只服务 JIRA 账本，出站信息靠回合结束机制而不是工具投递。这个拆法让跨会话、跨工作区交接很难：消息带不了文件引用，报告引用不了另一份报告，接收方也没法校验自己收到的是什么。

目标归属是：会话、任务、消息、产物归一套工作区工具集；记忆缩到只做全局事实；回合结束投递删除。这一节给迁移映射，以及投递与引用的契约。

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
| `superagent_scan`、`superagent_status` | 读 JIRA 账本就绪度与计数 | JIRA 账本视图 | 随 JIRA 废弃；不保留兼容（见 2.3） |
| `superagent_claim`、`superagent_dispatch` | 认领单据、启动执行会话 | JIRA 账本动作 | 随 JIRA 废弃；不保留兼容（见 2.3） |
| `workspace_sessions` | 列会话、状态、当前活动、最近进展 | 工作区工具集 | 新增 |
| `workspace_tasks` | 通用派发任务与回执 | 工作区工具集 | 新增 |
| `workspace_message` | 发消息、追问、引用；读回执 | 工作区工具集 | 新增 |
| `workspace_artifacts` | 发布、引用、解析产物 | 工作区工具集 | 新增 |
| `send_message`、`wait_agent` | 子代理树内消息 | 子代理树 | 保留；不在本轮范围 |
| 回合结束投递 | 回合结束后隐式发出消息 | 删除；不留兜底 | 删除 |
| `read`、`glob`、`grep` | 读工作区内容 | 内容工具 | 保留 |
| `tool-dsh-store` | 读 `.dsh` 内容 | 存储工具 | 不在本文范围；不改（见 2.3） |

`workspace_tasks` 不带 JIRA 兼容字段。JIRA 已废弃，任何 `jiraKey` 或账本委托都直接去掉，不做桥接；`superagent_status` 不再作为 JIRA 汇总保留。`.dsh` 这一行是依赖，不是决定；边界归 2.3。

### 6.3 投递改成工具调用

`workspace_message.send` 是主投递路径：

输入：`{ targetSessionId, kind: 'message' | 'followup', text, priority?: 'normal' | 'urgent', replyTo?, references?, taskId?, requestId }`。

- `text` 限制在一屏内。schema 上限 600 字符，提示词要求三段：结论、依据、下一步，最多六行。
- `references` 是产物引用列表。消息体里永远不放文件内容。
- `taskId` 在消息是状态更新或追问时，把消息挂到任务上。
- `priority: 'urgent'` 由发送方（任何 agent）标记，工具按 5.4 节的三种情况校验；它插入到目标的下一次工具调用之前，并可以中断当前步骤。
- `replyTo` 标记这是对某条消息的回复。
- `requestId` 是幂等键。重复调用返回第一次的结果。

输出：`{ messageId, deliveredAt, status: 'queued' | 'delivered' | 'interrupted' | 'target_archived', references }`。

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
- 授权按“一个产物版本 + 一个请求方”限定，并且会过期。推附件只对目标会话有效。新版本需要新授权；旧授权不会跟随新内容。
- 跨会话引用默认在同一工作区内解析。来自别的工作区的引用必须显式给 `workspace` id；无权限时返回 `denied`，绝不返回 `missing`。
- 删除文件不会删除产物索引条目；`resolve` 返回 `missing`，引用保留以便审计。同一路径重新发布会生成新版本；旧引用解析为 `changed`，不会静默跟随新内容。
- 报告可以用产物 id 引用另一份报告。引用就是引用，报告不复制另一份报告的正文。

### 6.5 不保留回合结束兜底；重试与回复形态

没有回合结束投递路径。每条出站消息都是显式的 `workspace_message.send`；一个 turn 不发就什么都不投递。`requestId` 仍然去重重试；因为只有一条投递路径，同一内容不可能投两次，“新问题”也不会被误当成“旧问题”。

工具调用失败时，模型用同一个 `requestId` 重试或报告失败；它不能假设有自动投递。回复要短：结论、依据、下一步；文件用引用；不写报告式长文。挂引用就是推路径；检查点见 6.6 节。

### 6.6 产物访问：拉与推

产物访问有两种模式，由先执行哪个工具决定。

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

- `memory_write` 只接受 global 事实或约定；业务事实与派发状态一律拒绝，并指向工作区工具。
- `memory_search` 只搜 global 条目；会话语料那一半删除。
- `memory_read` 删除；会话上下文用 `session_event_read` 或 `workspace_sessions`。
- `memory_forget` 按主题或条目 id 遗忘 global 条目；随 dispatch 命名空间一起删除会话、turn、kind 过滤器。
- `memory_resolve` 删除；不再有 open 或 dispatch 条目可结。
- `/memory` 命令只保留 global 的列出、统计、遗忘；summary、pause、prune 与会话编辑子命令迁到转录清理，或删除。

### 6.8 整合后的工具集风险

- 投递可靠性：重试使用 `requestId`；结果区分 queued、delivered、interrupted、failed；不保留兜底，唯一路径就是显式调用。
- 重复投递：两条路径共享一个幂等键与一份日志；第二次写入是空操作。
- 引用失效：`changed`、`missing`、`denied` 三种状态分开；引用不可变；不静默跟随新版本。
- 权限：谁能给哪个会话发消息、谁能读谁的产物。跨工作区读取显式且留痕；`denied` 不是 `missing`。
- 会话生命周期：给已归档会话发消息返回 `target_archived`，不创建待处理 inbox；会话归档后产物引用仍可解析。
- 删除工具带来的破坏：删除 `memory_read` 与 `memory_resolve` 会改变提示词与工具目录；提示词、工具描述与快照必须在同一步一起改。

## 7. 提示词、写入与注入规则

### 7.1 记忆写入规则

- 唯一接受的条目是 `global` 事实或约定。`memory_write` 接收 `topic`、`text`、`source_session_id`；`topic` 必须在白名单里。
- 正文含绝对工作区路径、JIRA 单号、版本或 commit、设备或镜像、派发状态、分析结论时拒写。拒绝码为 `NOT_GLOBAL_MEMORY`，错误信息点名该用哪个工作区工具。
- 没有 `dispatch` 命名空间，也没有每轮自动记忆条目。摘要作业不再写记忆。
- 业务或派发写入被拒；调用方被指向 `workspace_tasks`、`workspace_sessions`、`workspace_message`、`workspace_artifacts`、`session_event_read` 或 `read`。

### 7.2 提示词与注入规则

- 提示词只有一段静态工作区目录。它不按轮次重写，不含状态、不含记忆、不含任务。
- 记忆快照、`memory-state` 提示词段（`api.ts:303-312`）、`appendMemoryUpdate` 通知（`snapshot.ts:442-449`）全部删除。
- 跨会话索引（`snapshot.ts:343-374`）一并删除。
- 会话发生 compaction 时，仍可用摘要替换旧 turn。那是 compaction 行为：它不追加每轮记忆消息，也不在会话启动时注入。
- 提示词写明回复契约：结论、依据、下一步，最多六行或 600 字符，文件用引用。
- 提示词写明三种紧急情况，并说明普通消息不紧急。
- 提示词要求 worker 说明缺什么信息并停下；只有 root 或 super agent 去问用户。
- 提示词写明只有已注册工作区；子目录被拒绝。
- 默认在上下文预算用到 40% 时触发 compaction；阈值可配置，super agent 可以对不同 agent 用不同预置（默认 40%，可调）。
- 写入后不再追加任何其他记忆消息。

### 7.3 检索与读取规则

- `memory_search` 只搜全局记忆。会话语料那一半删除（`tools.ts:490-506`）；会话检索交给 `session_search`。
- `memory_read` 从模型可见工具里删除；会话上下文用 `session_event_read` 或 `workspace_sessions`。
- 归档的全局条目在显式请求时可查，但永不注入。

### 7.4 所有会话，没有例外

提示词改动、删除每轮记忆消息、以及记忆规则统一生效：普通工作区会话与 super agent 得到同一份静态工作区清单、同一套工具集、同一套只留全局的记忆规则。不提供按会话类型恢复快照的开关，因为洪水是机制本身的性质，不是 agent 角色的性质。

普通会话的验收测量：

- 改造前：每次摘要追加 1 条快照，每次显式写入追加 1 条 “Memory updated”，每个 tier 边界最多 1 条 checkpoint。上面这个 super agent 会话因此产生 812 条快照、350 条更新通知、149 条 checkpoint（704 条条目文本），合计 737 KiB。
- 改造后：稳态下每轮记忆消息数为 0，每轮记忆字节数为 0。上下文只来自提示词里的静态工作区清单与工具调用结果。compaction 摘要不属于记忆消息，单独计量。

“上一轮做了什么”正是过去靠每轮通知覆盖的场景。改造后，`workspace_sessions` 的 `action: 'get'` 返回该会话的 `recentProgress` 与 `currentActivity`，提示词里的“去哪里查”地图会点名这个工具。验收测试先移除通知，再问会话“上一轮做了什么”，并断言答案来自 `workspace_sessions`（原始 turn 则用 `session_event_read`），而不是来自记忆消息。

这项测试属于第 2 步，并且在一个普通工作区会话上运行，不是 super agent。

### 7.5 确认通道：ask user 与用户批准

旧的 ask user/审批路径现在直接移除，不做过渡。它基本没真正执行过：请求卡住、无人应答、失败是静默的。留着当兜底只会保留这些失败模式。

链路是：

```
worker agent --(blocked; states what is missing)--> super agent
super agent --(one consolidated question, options, deadline)--> user
user --(decision)--> super agent
super agent --(explicit instruction)--> worker agent
```

worker 不自己弹确认。它说明缺什么信息然后停下。super agent（没有 super agent 时是会话的 root agent）是唯一去问用户的一方。super agent 下的是明确指令，不是开放式问题。

每个请求都有状态：`pending`、`answered`、`expired`、`denied`，界面可见。到截止时间没有答案，请求变为 `expired`，把后果返回给发起方；worker 必须停下或使用预先声明的安全默认值，绝不静默继续。链路断了（发起方没了、目标没了）就把请求标为 `failed`；不允许静默挂起。

旧路径在同一版本移除；没有双路径，也不迁移存量数据。测试覆盖已回答、过期、拒绝、链路断开四种情况。

## 8. 迁移与止血修复

### 8.1 止血修复：先合，独立于本设计

让 `pruneSessionEntries` 为每一次超上限删除与完全重复删除返回归档记录；新增 `over-cap` 与 `duplicate` 两种移除原因；`retainDocument` 收集这些记录；所有写入路径在写活动文件之前先归档；归档失败时保留条目，而不是丢弃。

验收：把上限降到 3 条、再写第 4 轮，每一条被丢条目都必须有归档记录；归档失败时条目仍在；版本冲突重试不会产生重复归档。

### 8.2 迁移规则

| 类别 | 判定 | 处理 |
|---|---|---|
| `global` | 跨工作区的事实或约定：共享服务器地址、harness 默认模型、统一规矩、跨工作区偏好 | 需人工确认后转为 global 条目 |
| `dispatch` | 点名 task、session 或账本路径，且描述方案、下一步或进展 | 归档；持久归属是任务工具与账本 |
| `business` | 分析结论、设备或镜像、生产版本或 HEAD、代码路径或 commit、测试结果、报告内容、工作区配置 | 归档，永不注入；如需指针，指针放在任务或账本里，不放在记忆里 |
| `unclassified` | 无来源会话、无 turn、归属无法判定 | 归档，进报告清单，永不注入，不猜 |

dry-run 报告逐文件逐条列出：类别、建议的 global 主题、原因，以及如有需要的指针目标。global 候选单独列出，供人确认。应用需要报告哈希，先写备份，先归档再写活动文件，并可通过还原备份回滚。

每个工作区的记忆文件都按同一套规则迁移；普通会话不是特例。它的文件同样得到报告、备份、先归档再写、以及回滚。

对当前 406 条按规则粗分，约 15 条 global 候选（评审时多数应被否掉）、约 50 条派发、约 340 条业务事实或无法判定。这些数字只用于排期估算，最终以报告为准。

## 9. 里程碑

| 步骤 | 做什么 | 验收什么 |
|---|---|---|
| 0 | 超上限路径的止血修复 | 上限与归档测试通过；无静默丢失；可独立发布，回滚只需还原该提交 |
| 1 | 整合工具的读侧：`workspace_sessions`、`workspace_tasks` 读取、`workspace_artifacts` 列/解析、`workspace_message` 读取；收窄 memory 工具；提示词与注入暂不动 | 工作区 A 的会话只看得到 A；没有显式 id 的跨工作区调用失败；memory 工具不再读会话；结果有界并分页 |
| 2 | 投递改成工具调用，并在同一版本删除洪水：`workspace_message.send`、产物发布/引用、静态提示词，且不再有快照、更新通知、跨会话索引、回合结束投递 | 消息与引用能往返；重试不重复；一个 turn 不发就什么都不投递；普通会话每轮记忆消息数为 0、字节数为 0；“上一轮做了什么”由 `workspace_sessions` 回答 |
| 3 | 记忆变为只留 global，并迁移旧条目 | 业务或派发写入被拒并给出工具提示；产出 dry-run 报告；只有确认过的 global 条目仍被注入；备份与回滚已验证 |

每一步都可独立上线、可回滚。第 0 步先合。第 1 到 3 步不依赖看板方向。

顺序：读侧先落，模型在任何东西被删除之前就能查询。删洪水与投递工具放在同一版本，避免出现“旧注入已删、新投递路径还没上”的空窗。记忆迁移最后做，因为它改写用户数据，并且需要稳定的工具集。

回滚方式：第 0 步只需还原一个提交。第 1 到 3 步保留能解析上一版文件的读取路径，并在任何迁移前写逐文件备份；因此回滚代码后既有文件仍可读，第 3 步可以还原自己的备份。归档保持追加式，回滚不会丢失“删过什么”的记录。

所有会话的验收：改造前，普通会话每次摘要收到 1 条快照、每次写入收到 1 条更新，每个 tier 边界最多 1 条 checkpoint；第 2 步之后，它的每轮记忆消息数为 0，每轮记忆字节数为 0。7.4 节里的“上一轮做了什么”测试在该会话上通过 `workspace_sessions` 完成。

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
- 一个任务两个主人：工具集必须包住现有账本与日志，而不是再造一份任务清单。
- 消息优先级：紧急消息可以中断一个步骤。三种紧急情况很窄，普通消息永远不紧急；误判紧急是缺陷，要评审。
- 引用失效：changed、missing、denied、pending、expired 分开；授权按版本限定，新版本需要新授权；跨工作区拒绝不泄漏产物是否存在。
- 跨工作区授权：显式工作区 id、注册表成员校验、调用留痕；拉先查接收方，推先查发送方；不做隐式聚合。
- 丢失上下文压缩：compaction 预置太激进会丢上下文；把它做成可配置，用长会话测试，并保留上一版值以便回滚。
- 确认通道：旧路径已移除；新链路有截止时间与可见状态，链路断开标为 failed，不静默挂起。
- 迁移误分类：dry-run、人工确认、备份、回滚；被误归档的 global 事实可以重新加回。
- 所有会话的爆炸半径：提示词或工具集的缺陷现在会波及普通会话。上线顺序按“先工具集、再切提示词与删注入”，并保留上一版提示词作为一版构建期回滚。

### 10.4 本轮确认

- 任务状态：只用新词表；旧任务数据不迁移；以后需要时用一次性脚本。
- 发消息：同工作区可互发；跨工作区经 super agent；发送方（任何 agent）标紧急，工具按三种情况校验；提示词教短回复。
- 回复格式：结论、依据、下一步；最多 6 行或 600 字符；文件用引用。
- 任务类型：分析定位、修复、测试验证、迁移部署、设计文档、其他；封闭清单，只由评审改动。
- 产物访问：拉用 `request`/`grant`，推用消息引用；由工具先执行哪个决定；同工作区策略可自动授权；跨工作区读取需要显式授权；denied、pending、expired、missing、changed 分开。
- ask user 与用户批准：旧路径现在移除；链路是 worker → super agent → 用户 → super agent → worker；worker 说明缺什么信息并停下；expired、denied、failed 可见；不静默挂起。
- 工作区清单：只列已注册工作区；子目录被拒绝，并提示注册。
- compaction：保留；默认在上下文预算用到 40% 时触发；可配置；super agent 可用不同 agent 预置（默认 40%，可调）。
- 回合结束投递：删除；不留兜底；回复是结论、依据、下一步，不写报告。
- JIRA：现在移除；只留 GitHub 凭据相关代码/配置；其余 JIRA cloud 配置删除；不保留兼容层。
- JIRA 本地数据：删除；删除前可选一次静态导出；不可恢复。
- 派发账本：丢弃；不迁移、不导入；`workspace_tasks` 从新开始。
- JIRA 技能与 `superagent_session`/`superagent_workspace` 别名：移除；不保留别名。
- 意图卡：每次派发都要有；纠正追加版本；回执带对齐清单；偏差率被统计。

## 11. 意图卡：派发对齐

### 11.1 要修的失败

super agent 把用户需求拆成任务时，需求会在拆解里被重新表述，每次重新表述都可能走样；用户纠正后，下一次任务又丢掉纠正，同样的偏差再出现。提示词只能降低概率，不能让意图持久：任务带的是转述，不是用户原话；派发前没人检查任务，执行后也没人对照结果。

这是结构性问题，所以修法是一个结构对象：意图卡。super agent 写一次；任务必须引用；派发时校验；回执逐条对照；用户纠正以追加方式写回。

### 11.2 意图卡

| 字段 | 含义 |
|---|---|
| `intentId` | 一次用户请求的稳定 id |
| `version` | 1、2、3……；每次纠正追加新版本 |
| `workspaceId` | 这次请求所属的工作区 |
| `sourceSessionId`、`sourceTurn` | 用户在哪里提出请求 |
| `rawUserText` | 用户原话，逐字保留 |
| `goal` | 用户要达成的结果 |
| `acceptance` | 可逐条检查的验收点，有序 |
| `boundaries` | 不能碰的东西：文件、权限、环境、数据 |
| `outputForm` | 期望产出形式：代码、报告、补丁、决定等 |
| `status` | `proposed`、`active`、`superseded` |
| `createdAt`、`author` | 这一版何时、由谁创建 |

存储：`$DSH_HOME/intents/<intentId>/`，含 `index.json`（最新版本与状态）和 `versions/<n>.json`。存储是追加式：纠正写新版本，旧版本永不改写或删除。它是宿主级控制面状态，不是工作区业务内容，也不是记忆。

归属：意图归用户。super agent 可以按用户请求建 `proposed` 草稿，但必须让用户确认成 `active`；用户纠正时追加一个新的 `active` 版本，并把上一版标为 `superseded`。普通 agent 只读，不改。super agent 不能静默改写 active 版本。

### 11.3 派发前校验

`workspace_tasks.create` 必须带 `intentId`、`intentVersion`、`workspace`（目标）、`acceptance`、`boundaries`。缺任一项返回 `INTENT_INCOMPLETE`。版本不是最新 active 时返回 `INTENT_STALE`，调用方必须重读卡。

服务随后做覆盖检查：卡里的每个 goal、验收点、边界、产出形式，都必须映射到任务简报里的一项。缺映射返回 `INTENT_COVERAGE_MISSING`，除非调用方提供 `nonCoverage: [{ point, reason }]` 且 super agent 确认。不允许默认通过，也不允许“假设已覆盖”。

schema 与服务强制这件事；提示词只说顺序：先读卡，再读任务，再写覆盖清单。忘了卡的模型无法派发。

### 11.4 执行后对齐

任务返回时，super agent 用任务引用的同一个 `intentId` 与 `intentVersion` 核对回执。每一项得到一种状态：

- 验收点：`satisfied`、`not_satisfied`、`out_of_scope`；
- 边界：`respected`、`violated`；
- 产出形式：`matched`、`not_matched`。

每个状态都带证据：改动的文件、测试、报告行，或缺了哪一项。对齐由 super agent 或校验方产出，不是执行方自证。只要有 `not_satisfied` 或 `violated`，任务不能进 `done`，而是进 `waiting_review` 或 `blocked`，并带清单。给用户的回执包含这份清单，走样以列表出现，而不是等用户发现。

### 11.5 纠正沉淀与重复

每次用户纠正追加一个新意图版本，带 `reason`、纠正消息、改动点。用户原话、目标、验收、边界、产出形式都版本化；历史不可变。下一次派发自动读最新 active 版本；没有人靠记忆转述意图。

重复纠正同一个点时，两个版本都记录该点。存储按 `(intent point, correction reason)` 跨任务统计重复，让反复出现的偏差变成数字，而不是印象。

### 11.6 度量

偏差率 = 用户纠正次数 / 派发任务数，按工作区与任务类型、7 天与 30 天滚动窗口计算。一次用户纠正产生一个新意图版本，算一次纠正事件；同一次纠正改多个点只算一次。重复率 = 窗口内“该点以前已被纠正过”的纠正数 / 窗口内纠正数。

任务类型是六类封闭清单：分析定位、修复、测试验证、迁移部署、设计文档、其他。增加或改名需要评审，模型不能自选。

输入在三个点采集：意图版本追加、任务派发、回执对齐。任何指标都不依赖记忆或模型自报。

### 11.7 工具面

`workspace_intents` 提供 `create`、`get`、`correct`、`history`、`metrics`。用户或界面创建与确认；super agent 可以建 `proposed` 草稿并读取；普通 agent 只读。`workspace_tasks.create` 必须带意图引用；`workspace_tasks.receipt` 接收对齐清单；有未满足项时状态机拒绝 `done`。

### 11.8 不做什么

这不是更强的提示词。提示词只说去哪里查、按什么顺序：读意图卡，再读任务，再写覆盖清单。约束在 schema、覆盖检查、回执门与版本存储里。它也不把意图卡放进记忆；意图卡是控制面状态。

### 11.9 验收测试

1. 故意含糊的需求无法派发：`workspace_tasks.create` 没带意图卡时返回 `INTENT_INCOMPLETE`，不创建任务。
2. 简报漏掉一个验收点时返回 `INTENT_COVERAGE_MISSING`；补上该点或给出显式不覆盖理由后才放行。
3. 执行后偏离的任务产出清单，标出 `not_satisfied` 或 `violated`，任务不能进 `done`。
4. 用户纠正一次后，下一次任务自动引用新版本；旧版本仍可读且未被改写。
5. 同一个点重复被纠正时，重复计数增加，偏差率出现在 `workspace_intents.metrics` 的工作区与任务类型下。

## 12. 能力盘点：memory 与 super agent

本节列出两个界面今天提供的能力、新设计是否保留、以及不保留时的替代。

### 12.1 memory 能力

| 能力 | 今天解决的问题 | 还需要吗？ | 新归属 / 替代 | 动作 |
|---|---|---|---|---|
| 写入 | 记录任何持久结论，包括业务事实 | 只留全局事实与约定 | `memory_write` 只写 global | 改造 |
| 检索 | 搜记忆条目与会话历史 | 只搜记忆 | `memory_search`；会话检索是 `session_search` | 改造 |
| 读取 | 把某一轮会话读成转录 | 不要 | `session_event_read`、`workspace_sessions` | 删除 |
| 忘记 | 按会话、turn、kind、tag 遗忘 | 只处理 global | `memory_forget` 去掉会话过滤 | 改造 |
| 归档 | 让被移除的条目仍可搜 | 只留 global | 全局归档；业务历史留在工作区 | 改造 |
| TTL 与过期 | `open`/`files` 3/14 天过期 | 不要 | 随 dispatch 命名空间删除 | 删除 |
| 快照注入 | 每轮记忆快照 | 不要 | 静态提示词 + 工具查询 | 删除 |
| 摘要生成 | 写每轮业务条目 | 不写记忆条目 | 只做 compaction 摘要，不做记忆 | 改造 |
| 跨会话索引 | “Recent sessions” 概要 | 不要 | `workspace_sessions` | 删除 |
| 全局与个人偏好共享 | 把跨工作区事实与画像/风格混在一起 | 拆开 | 全局记忆放事实；personality 放画像与风格 | 改造 |

### 12.2 super agent 能力

| 能力 | 今天解决的问题 | 还需要吗？ | 新归属 / 替代 | 动作 |
|---|---|---|---|---|
| 工作区注册与清单 | 提示词里注入静态清单 | 需要 | 保留注册表；提示词静态；状态用 `workspace_sessions` | 保留、改造 |
| 会话创建、复用、归档 | `superagent_session` 与会话工具 | 需要 | 会话服务；`workspace_sessions`；不复制进记忆 | 下移 |
| 派发 | `superagent_dispatch` 加 JIRA 认领 | 需要 | `workspace_tasks`；JIRA 认领与派发下线 | 下移 |
| 账本与回执 | `.superagent/ledger`、`superagent_ledger` | 需要 | `workspace_tasks` 日志与回执；从新开始，不迁移 | 下移 |
| 投递 | `superagent_deliver` 加回合结束路径 | 需要 | `workspace_message`；不保留回合结束兜底 | 下移 |
| 报告呈现 | `reports.jsonl` 与投递 | 需要 | `workspace_artifacts` 引用加 `workspace_message`；界面渲染 | 下移 |
| 权限切换 | `superagent_permission` | 需要 | 权限预设服务 | 下移 |
| 长任务监控 | 会话状态与 JIRA 状态 | 需要 | `workspace_sessions` 状态与进展，加写租约 | 下移 |
| 跨工作区协作 | 派发，以及把事实复制进记忆 | 需要 | `workspace_tasks`、`workspace_message`、`workspace_artifacts` 显式范围；永不进记忆 | 下移 |

## 13. 附录：未来方向

看板是以后可能出现的界面。它的数据来自 `workspace_sessions`、`workspace_tasks`、`workspace_message`、`workspace_artifacts`；记忆只贡献全局事实，从不被看板用于查询会话、进展或任务。记忆卡片流、按工作区的记忆索引、事件日志存储都明确不在范围内；如果看板以后需要，那是在同一套工具集上的新设计，不是对记忆模型的修改。
