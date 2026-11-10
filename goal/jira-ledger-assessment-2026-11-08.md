# Jira 台账体系评估：与 superagent 的现状、摩擦与替换边界

> **Fedora 实机反馈**：本评估基于 Fedora（Linux）实机反馈，Windows 复跑后可能不同；后续以 Windows 复跑为准。

调查日期：2026-11-08。源码基线为当前 dev checkout 当时的版本，其中报告解耦已完成。本文是只读调查，不是实施方案；所有写入/状态建议都需要另行验证。

## 0. 结论先行

1. **Jira 台账与 superagent 已经分成两类事实，但代码没有按这个边界分层。** 通用 issue、评论、KB、机器身份、跨机同步仍适合单人跨机任务追踪；`superagent_session` 的 workspace 路由、报告绑定与去重则已是独立运行机制。后者现在由 `.superagent/reports.jsonl` 负责，不再依赖 issue 状态或 Markdown 台账。剩余问题主要是 dispatch 的语义记录、UI/权限和工具注册仍全部位于 `jira-agent` / `jira-service`。
2. **本机实际使用中，superagent 的主要动作不是 Jira issue 工作流，而是派 Session、读回报告、再手工补 dispatch 台账。** 22 个排除本次调查树的相关 session 中，17 个没有 `jira_*` 或 `superagent_*` 调用；5 个有调用的 session 共产生 282 次调用，其中 `superagent_session` 96 次、`superagent_ledger` 74 次，而 `jira_issue/list/kb` 共 100 次。Jira issue 写入高度集中于一个长期 dev session，并非每个工作区都在用。
3. **面向插件重写，应先保留通用任务/知识/审计能力，再把 superagent 控制面迁出，而不是继续扩张同一个插件。** 优先级最高的是让可见工具结果与实际写入一致，并消除多重权威：当前存在“成功后补写被静默忽略”“写 `failed` 仍显示 `returned`”“schema 有嵌套类型但运行时没有递归校验”“警告/正文在渲染时消失”等问题。报告 journal 已完成正确的方向性拆分；还需把 `superagent_ledger`、workspace/session 工具及相关 Remote/UI 从 Jira 包搬出，Jira 只留可选 issue 引用和投递后的人读投影。

### 推荐的最终职责

| 事实 | 唯一权威 | Jira 应保留的关系 |
|---|---|---|
| 通用工作项的需求、状态、阻塞、人工复核 | 可替换的任务台账接口；现实现为 Jira git 仓 | 主体 |
| 旧 issue claim loop 的认领、执行者与恢复 | 当前仍是 Jira issue/assignee/dispatch 评论；重写时应迁入 superagent 的任务适配层 | 当前主体，属于尚未拆出的旧控制面 |
| 跨机同步、issue/comment 历史、机器与身份 | Jira git 仓及本机 machine-id | 主体 |
| 可复用经验、出处、关联 issue | KB 或独立知识接口；现实现为 Jira KB | 主体 |
| workspace 目录、标题、Session 归属 | DSH workspaceRegistry / Session | 不复制 |
| 一次派发的 task、目标 workspace/Session、业务结果 | superagent dispatch domain；兼容部署才退回 Markdown | 可选 `issue` 引用，不复制状态 |
| 报告发给谁、绑定哪个 turn、是否已投递/重试 | superagent `.superagent/reports.jsonl` | 不参与判断；投递后 best-effort 人读投影 |
| 长期对话结论 | memory | 不复制 dispatch 状态；按任务 id/ issue key 引用 |
| 定时唤醒 | DSH schedule 或 superagent 自己的 timer | 不用 issue 状态表达时间性等待 |

## 1. 调查范围、口径与限制

### 1.1 数据来源

- 源码：`packages/jira/jira-core`、`jira-cli`、`jira-service`、`jira-agent`、`ui-jira`，以及 `packages/bundle/base/cordis.patch.yml` 的 storage 路由。
- 本机配置：`/home/uitstalie/.dsh/profiles/web/cordis.patch.yml`。
- 实际 issue 仓：`/home/uitstalie/桌面/dsh/dsh-plugin-multidevice-jira-cloudstore`。
- 本机状态：`/home/uitstalie/.dsh/dsh-jira` 与 `/home/uitstalie/.dsh/storages/superagent.sqlite`。
- super workspace：`/home/uitstalie/桌面/dsh/superagent/.superagent` 与其 `.dsh/memory`。
- 日志：`/home/uitstalie/.dsh/sessions` 下 dev、superagent、MTool、Rockstar Games 的压缩 JSONL。

为避免混淆，下文将三种东西都写全称：**Jira issue 台账**是共享 git 仓；**dispatch 台账**是 `superagent_ledger` 所读的 dispatch domain/Markdown；**报告 journal**是 `.superagent/reports.jsonl`。`~/.dsh/dsh-jira` 不是当前 issue 仓，只保存机器 id、扫描 watermark 等本机状态；真实 issue 仓位置由 web profile 的 `jira-service.config.root` 指定。

### 1.2 Session 统计口径

只读解压 `session.v4.jsonl.zstd`，仅计真正落盘的 `type:"tool/call"`，不把 prompt、工具目录或 assistant 草稿中的工具名计入。共扫描 27 个相关 JSONL；排除本次调查的父 session 和 4 个调查子 session 后，统计 22 个：dev 13、superagent 6、MTool 1、Rockstar Games 2。

“写”按调用意图分类，不代表调用成功。例如 `jira_issue comment/create/assignee/switch_state`、`superagent_ledger resolve`、`superagent_session append/start` 记写；list/get/search/inspect/roster 记读。错误用 `isError:true` 或模型可见正文以 `error:` / `Error:` 开头双重判断。任务本身报告 `status:"failed"` 不等于工具调用失败。

这些数字是本机现有日志的横截面，不是频率基准：一个 session 可跨多天、可多次恢复，旧日志还包含已经修复的实现；因此本文把“真实发生的调用/错误”与“当前源码仍有风险”分开写。

### 1.3 证据限制

- 未调用任何 Jira/superagent 写工具，未启动服务或游戏，未改源码。
- 没有运行 `jira sync`、`generate` 或 CLI 写操作；本机 cloudstore 的 push 在 profile 中显式为 `enabled:false`。
- 调查时运行中的部署未必已加载报告 journal 修复：实际 super workspace 尚无 `reports.jsonl`，但 `.superagent/ledger` 继续变化。因此新 journal 的结论来自当前源码、提交说明和测试设计，不声称已在运行实例中验收。
- 存储 SQLite 只确认了实际文件和 bundle 路由；没有借助提升权限绕过本机沙箱读取数据库。涉及 domain 的结论来自源码和 dispatch Markdown，而非 SQL 内容统计。

## 2. 当前实际承担什么

### 2.1 22 个 session 的调用统计

| 工具 | 读 | 写 | 合计 | 动作明细 |
|---|---:|---:|---:|---|
| `jira_issue` | 9 | 71 | 80 | get 9；create 15；comment 29；assignee 10；switch_state 17 |
| `jira_list` | 19 | 0 | 19 | 默认列表查询 |
| `jira_kb` | 1 | 0 | 1 | 仅 search，没有 create/update |
| `superagent_ledger` | 26 | 48 | 74 | list 26；resolve 48；无 record |
| `superagent_session` | 31 | 65 | 96 | list 20；inspect 11；start 8；append 56；prompt 1 |
| `superagent_workspace` | 5 | 1 | 6 | roster 4；orphans 1；ensure 1 |
| `superagent_models` | 6 | 0 | 6 | 模型/effort 查询 |
| **合计** | **92** | **190** | **282** | — |

有调用的 5 个 session：

| Session | 角色与规模 | 相关调用 |
|---|---|---:|
| `session-486d5296-3fd8-4158-84c7-fb5abc42257c` | dev，长期跨多次任务；2150 个工具调用 | 95 |
| `6005a837-6cc0-42f9-89e5-048569442255` | superagent 子会话；只读一次 `jira_list` | 1 |
| `session-3f77ab15-21eb-437c-a6e9-942e0a26381e` | superagent；含错挂后的手工修正 | 33 |
| `session-56e66d2e-dbe6-40ac-98c6-2a4ef3840ea8` | superagent；24 次手工 resolve | 78 |
| `session-e00351a8-2a4e-48f1-ad6e-e107d926d723` | superagent；20 次手工 resolve | 75 |

关键解读：

- 78 次 `jira_issue` 出现在同一个长期 dev session；它承担建单、登记设计、认领、状态迁移和评论，是本分支“先建 DH issue、用 key 关联原生修改”的工作流。
- 3 个主要 superagent session 的 `superagent_ledger` 动作全部是 26 次 list 和 48 次 resolve，没有手工 record。自动派发已经覆盖 pending 创建，额外成本主要在回读后补结果。
- 当前 super workspace 明确禁止从超级会话运行 issue claim loop：`packages/jira/jira-agent/src/superagent.ts:129-131`。旧 issue claim 的 scan/claim/dispatch/source/status 与现在的 workspace Session 派遣是两条不同路径，不能把工具总数当成它们都在被使用。
- `jira_kb` 仅一次 search，且没有通过工具新增知识；本机现有 KB 的维护并不等于 agent 日常频繁读写 KB。

### 2.2 哪些工作完全不碰台账

17/22 个 session 没有相关调用：dev 12/13、superagent 2/6、MTool 1/1、Rockstar 2/2。

| Session | 实际调用 | 含义 |
|---|---|---|
| MTool `session-88469918-e849-410a-a896-c6b4152b1252` | 120 个工具调用，其中 bash 等 120，Jira/superagent 0 | 能完成 GPU 诊断；父 superagent 负责回读/补记 |
| Rockstar `session-b32abb08-ffee-4a26-8d48-3a69f41053fe` | 158 个工具调用，相关 0 | 工作区 Session 不需要知道 issue 系统 |
| Rockstar `session-0e8d563d-2670-46f7-a785-ab2a8788e639` | 663 个工具调用，相关 0 | 长会话同样可完全绕开台账 |
| dev `session-2b11d864-a1f7-426e-85cf-1952112f05af` | bash 13、read 4、todo 2，相关 0 | 派遣给子 Session 的修复任务不直接写 issue |
| dev `session-390341c3-0508-4e01-ab10-6ccc67271095` | 288 个工具调用，相关 0，另有 memory_write 6 | 实际工程执行和 memory 可与 Jira 分离 |

这证明“工作区执行者无需直接操作台账”，不证明“无需任何记录”：父层仍需可靠投递，真正跨机任务仍需要任务和结论的持久关联。

### 2.3 实际记录了什么

**Jira issue 仓**：139 个 issue 文件、138 个 comment 文件、5 个 KB 条目、13 个 session 文件；issue 为 DH 82、DPMJ 41、KB 8、QQ 4、DEMO 3、HU 1。状态为 closed 121、cancelled 2、in_progress 2、in_review 5、todo 12。记录覆盖需求正文、设计、状态/认领、验证评论、KB 来源、机器和 Session 身份。

**dispatch 台账**：本机 6 个 Markdown 文件合计 1,460,220 bytes、283 个任务段、53 个不同 task id；按同 id 最后一段计算为 46 returned、5 pending、3 failed。段数大于任务数是设计使然，但重复密度很高：3 个 id 有 17 段、4 个有 20 段、9 个有 6 段；另有 24 个 id 有 3 段。283 段中没有一条 `- issue:`，所以“issue 与派遣只引用不复制”的约定在当前实际数据里也没有形成关联。

**session 记录**：首次 Jira create 时才写 `sessions/<id>.md`，字段为 tool/model/machine/started_at/tool_evidence，没有工作区、任务内容或结束结果。当前工具只在 create 分支调用 recorder（`jira-agent/src/toolIssue.ts:168-170`），update/comment/close 不调用，因此“首次写”承诺与实现不一致。源码搜索显示生产读者只有 recorder 的幂等检查与 doctor/listSessions，没有跨 Session 恢复消费者；共享 session 文件与 DSH 原始日志形成重复但信息量更低的副本。

**本机扫描**：28 个 watermark JSON 合计记录 762 次 scans；每次可写 root 的 turn end 都 settle 并扫描（`contribution.ts:104-123`），即使没有任何 issue 写入。这解释了“完全不碰 Jira 工具”不等于“插件没有后台工作”。

### 2.4 四类反例：记录存在但不可靠

以下均来自真实落盘日志。`行`指 zstd 解压后的 JSONL 行，`seq` 是 Session 事件编号；时间为 Asia/Shanghai。

1. **记了没人看/未消费**：`session-e00351a8-2a4e-48f1-ad6e-e107d926d723` 行 2321、seq 2319，2026-11-08 19:59:15，手工 resolve 写：“审查已完成……最终报告在会话日志里，但未自动回传 superagent、台账仍 pending”。较早的 `session-56e66d2e-dbe6-40ac-98c6-2a4ef3840ea8` 行 1859、seq 1857，2026-11-07 00:47:14，也记录“报告未送达……绑定只在内存”。
2. **记了却查不到**：`session-3f77ab15-21eb-437c-a6e9-942e0a26381e` 行 96/seq 94 列表含 `task-mw6egua0-eb906eb7 pending … 同步这个工作区的远程修改。`；行 131/seq 129 用该原句查询，行 132/seq 130 却返回 `the dispatch ledger has no matching task`。当前代码的过滤位于 `dispatch-ledger.ts:355-370`，list 没有截断计数，具体历史根因不能只靠两条结果断言。
3. **错挂**：上述 session 行 258/seq 256 写：“自动回传把本结果错挂到 task-mw6encz3；本任务实际是同步”；行 321/seq 319 又给真正 FsError 任务补正确结论。持久文件中 `7515b01c-….md` 的 `task-mw6encz3` 有 20 个 returned 段，直接展示重复结算成本。
4. **同一 id 写不同报告**：`session-56e66d2e…` 行 2128/seq 2126 给 `task-mw58be0n-a58194da` 写 density-review 结果；行 2188/seq 2186 又给同 id 写 plugin-tools-review 结果，两次成功。
5. **重复记录**：`session-e00351a8…` 行 2580/seq 2578 明确写“重复的准备确认……无新增结论”；行 2650/seq 2648 明确写“与 task-mw7s9bqc 相同的修复报告（重复投递/复述）”。旧 Stardew `task-mw52eap9-452333b9` 也有 pending 和两段 returned（`0324c9a0-….md:5,26,101`）。
6. **状态修正无效**：`session-e00351a8…` 行 1494/seq 1492 请求将 `task-mw6j88z1-ebd8c83f` 置 failed；下一行返回 returned，随后查询仍 returned。当前源码解释见 §4.1：已终结记录的普通 resolve 直接返回旧值。

这些案例解释报告解耦的必要性：报告路由不能等待一个人读 Markdown 系统正确解析和结算。但这些历史案例不能作为“新报告 journal 已发生同样故障”的证据。

## 3. Jira 本身的数据模型与分层

### 3.1 五包职责与真实边界

| 包 | 当前职责 | 需要注意的边界 |
|---|---|---|
| `jira-core` | 实体、Markdown/frontmatter 编解码、词表、锁、CAS、git、同步、KB、session close-out | 不含 DSH 服务，但含通用任务与本机 IO 的完整实现 |
| `jira-service` | `ctx.jira`、Store/queue 生命周期、Remote、superagent 状态/确认/setup | 通用服务已直接含 `superagentStatus/Confirm/Triggers/History`（`types.ts:289-315`） |
| `jira-agent` | 三个 Jira 工具、issue_work、skills、命令、turn-end settle，以及整套 superagent | `superagent.ts` 单文件 5006 行；两个能力共用同一 row（`index.ts:205-239`） |
| `jira-cli` | 人面 CLI，直接创建 core Store 和 push queue | 不经 `ctx.jira`；与运行中 service 不共享事件/队列 |
| `ui-jira` | 看板、详情、KB、设置、superagent 面板与侧栏 | 通用 issue/KB 基本只读，但 superagent 确认和 setup 是写操作 |

五包拆分清了“核心/服务/模型/CLI/UI”的技术层，却没有拆清“通用任务台账/superagent 控制面”的业务层。后者是将来整体替换时的主要成本。

### 3.2 Issue、状态机、tags 与评论

`Issue` 当前字段完整定义于 `jira-core/src/entity.ts:165-201`：key/project/type/status、summary/priority/tags/links、note/resolution、revision/时间/reporter、assignee/两小时 lease、kbRefs/conflicted 和 Markdown body。key 由文件名决定，不写进 frontmatter；磁盘 snake_case、代码 camelCase。

状态由仓内 `config.md` 驱动，不是工具 schema 的固定枚举。当前为 `todo → in_progress → in_review → closed/cancelled`，另有声明的打回/重开边；closed 和 cancelled 都要 resolution，limitation 还要 resolution_note。非法转换错误会列合法目标，设计清楚。默认 priority S3，列表按 project/status order/priority/updated 排列，blocked 由 `is_blocked_by` 链接派生而非状态。

Tag 有独立注册文件、描述和 aliases；issue 使用未注册 tag 会被拒。KB tag 只校验命名形状，不共享注册表闭集，这是实际语义差异。评论保存为每个 issue 的追加文件，id 含机器短码，多机追加依赖 `merge=union`；公开 API 目前只能追加，不能把设计里的“可编辑不可删”误写为已实现的编辑功能。

### 3.3 KB 与 evidence

KB 位于 `knowledge/<domain>/KB-<n>.md`，有 runbook/pitfall/howto/concept、tags、机器/OS/工具/捕获时间、可选 source 和 source_sha256、关联 issues 和正文。文件来源必须带 hash；双向引用在 KB 与 issue 间镜像，但不是跨文件事务，部分失败通过 `mirror.failed` 表达。检索是 title/body 的子串扫描，不含向量/RAG，默认 10、最大 50，snippet 200 字并返回文件绝对行号（`kbsearch.ts:19-24,107-167`）。

通用 issue **没有独立 `evidence[]` 或 verification 字段**。验证证据主要写在评论、正文和 git commit；`issue_work deliver` 只强制非空报告评论并进入 in_review。KB 的 source/hash 是来源谱系，不是 issue 验收结构。若重写需要结构化验收，应作为新增领域能力评估，不能声称当前已有。

### 3.4 为单人跨机服务的设计

- 项目身份以规范化 git remote 为主，本地 paths 只是缓存；换机不换项目 key（`jira-core/src/project.ts`）。
- 每机 `counters/<machine>.json` 预留 100 个号，配合现存文件最大值，支持离线分配；当前三个 counter 文件证明多机号段确实在使用。
- `mkdir` 锁协调同一 clone 内的进程；CAS 避免同 issue 覆盖；跨机不是分布式锁，而靠 git rebase、机器化 comment id 和 conflicted 标记。
- 写操作本地 commit；开启 push 后 debounce，sync 是 `pull --rebase → settle → push`，失败保留本地数据并记录告警（`push.ts:1-12`）。
- 真正的 machine id 放在 `$DSH_HOME/dsh-jira/machine-id`，不随仓同步；`machines/*.md` 是共享人读记录。
- `DH-601` 的评论历史有 Windows 与 Fedora 机器身份交替写入，说明跨机交接不是只有设计。

当前 cloudstore 本地 main 比 origin/main 领先 2 个提交且 push 被配置关闭，所以“有 git remote”不等于“跨机已经及时一致”。数据仓 1440 个提交中 456 个是派生物重生成，14 个是 session 记录；治理成本真实存在。

### 3.5 Superagent 特有与混杂点

**特有**：`[claim-proposal]`/`[claim-approved]`、worker preset 与 issue_work、dispatch marker、并发槽、daemon、GitHub import、workspace 路由、Session inspect/abort/compact、跨 workspace 文件投递、报告 journal。这些都不应成为通用 Jira core 的隐含依赖。

**混杂**：上述功能实际都编译进 `jira-agent`；`jira-service` 的通用 API 和 Remote 直接暴露 superagent 方法；`ui-jira` 同时承担通用看板与 superagent 控制面板；`superagent_home` 也是 Jira agent row 的配置。即使替换底层 issue store，仍必须迁移/重写这些宿主组件，而不只是实现几个 `jira_*` 工具。

## 4. 工具设计与 agent 反馈

### 4.1 高优先级：成功结果与实际写入不一致

| 严重度 | 问题与证据 | 后果 |
|---|---|---|
| P1 | 自动 turn-end 已把 dispatch 置 returned/failed；super workspace 指令却要求随后 resolve 补 artifacts/decisions（`super-workspace-definition.ts:39-48`）。domain 对非 pending 且未 `correctResolved` 的调用直接返回旧值（`dispatch-store.ts:275-300`），普通工具未传该选项（`superagent.ts:3446`） | 补充的结论/产物/待决项静默丢失，仍返回成功和 memory 建议。session 中 failed→returned 的实例与此一致 |
| P1 | `batch_close` 把 closed/partial 放在 `issue` 内，tag_create 同理；renderer 看不到 `issue.key` 就只显示 `ok`（`toolIssue.ts:179-210`、`tools.ts:194-201`） | 模型不知道关了哪些项；批量写阶段部分失败也会显示 ok。底层 batch 只有预检是全量，写入逐项提交，并非绝对原子（`jira-core/src/batch.ts:85-125`） |
| P1 | `validateArgs` 只检查顶层未知字段/类型/enum，不递归 properties/items（`jira-core/src/schema.ts:118-149`）；Jira 直接构造 ToolDefinition（`tools.ts:147-175`）；`asStringList` 遇到错误成员返回 undefined（`envelope.ts:161-164`） | 错误 tags/kb_refs/artifacts/decisions 会被当作“没传”，其他字段继续写入。schema 给模型的严格保证与运行时不一致 |
| P1 | envelope 产生 `rejected/message`，成功 renderer 却不显示它们（`tools.ts:158-167`）；issue commitError 位于 rejected（`toolIssue.ts:287-290`） | 模型可把部分 board 当完整结果，或把“文件已写但 commit 失败”当已入账；KB mirror.failed 同样不可见 |

### 4.2 中优先级：读取、检索与修正的可用性

| 严重度 | 问题与证据 | 后果 |
|---|---|---|
| P2 | `jira_issue get` runner 返回 comments，renderer 固定传空数组（`toolIssue.ts:216-220`、`tools.ts:194-201`） | 技能声称 get 返回评论，模型可见文本却没有；claim/dispatch marker 也难审阅 |
| P2 | `jira_kb get` runner 有完整 entry，renderer 只显示 key/type/title/lineage/issues（`tools.ts:245-251`） | 搜索后 get 仍没有知识正文；技能“one entry, whole”不成立 |
| P2 | Markdown resolve 只在最新 100 条里找 id（`superagent.ts:3455-3460`），domain 按 id 全表查；list 无 matched/remaining/truncated（`superagent.ts:3366-3377`） | 旧任务可误报 not found；空结果不区分“无匹配”与“默认窗口外还有”；两个后端行为不同 |
| P2 | domain 更新 artifacts/decisions，却只有 status/outcome 改变才追加 Markdown（`dispatch-store.ts:291-308`） | domain 与人读投影分歧，直到后续 syncProjection 才可能补偿 |
| P2 | resolve 允许 pending/returned/failed，outcome 可选；描述却称 returned/failed 修正；返回 `ledger.file` 在自动派发是目录、手工 record 是具体文件（`superagent.ts:738-767,965-971`） | 首次终结、补充、回退的语义混乱；同名 file 字段类型含义不同 |
| P2 | ledger 的权限、I/O、not-found 多统一成 INVALID_INPUT（`superagent.ts:3378-3470`） | 调用者不能按错误码区分修正参数、无权限和可重试后端失败 |
| P2 | 旧 claim 是先 assignee 再 switch_state 两笔独立事务（`superagent.ts:1262-1264`）；非法 transition 等第二步失败可留下“有 lease 但 todo” | 活跃 lease 会让下一次 claimability 拒绝，需要人工恢复；这不是当前 workspace Session 派遣路径的核心，但重写旧闭环时必须处理 |

### 4.3 低优先级与参数经验

- `jira_issue create` 的 project 可从 cwd 推断，issue_type 默认 task；`close` 可缺省目标为第一个 closed 状态；这些在参数说明中不清楚。
- `expected_revision` 接受 number 而非 integer；无意义的小数/负数会进入服务后失败。
- `jira_list`/KB 的非正 limit/top_k 回默认值，ledger 则 clamp 为 1；三套无效值行为不同。
- `jira-board` 主要讲 `/jira`/CLI，未明确指出纯 agent 用 `jira_list`；`jira-triage` 的 `--all` 对应工具 `include_closed:true`。blocked link 关闭后只是不再阻塞，不会自动删除链接。
- “every write is a commit”不准确：写盘成功而 commit 失败是显式支持的降级路径。评论不推进 issue revision，但可续租，所以“comment never changes issue”只适用于正文/revision。

### 4.4 真实错误原文与根因

22 个样本中识别 10 次失败/误用，只有 2 次 `isError:true`，另外 8 次错误在文本中而 `isError:false`。这意味着工具监控若只看布尔标志会漏掉 80% 的本组错误；根因之一是业务失败统一被渲染成普通 `error:` 文本。

| Session / 事件 / 时间 | 调用 | 原文 | 判断 |
|---|---|---|---|
| `session-486d5296…` 行 1645/1646，2026-10-26 22:29:02 | `jira_list` | `error: INVALID_INPUT: the store has no readable config.md vocabulary ({"root":"/home/uitstalie/.dsh/jira","reason":"missing"})` | 默认 root 与后来显式 cloudstore 不同；Windows 复跑必须先固定 root |
| 同上，行 1839/1840，22:33:18 | `jira_list` | `Error: unknown tool "jira_list"` | 部署/能力未装载，不是数据问题 |
| 同上，行 4818/4819，2026-10-27 00:46:31 | `jira_issue switch_state` | `error: INVALID_TRANSITION: cannot move from "todo" to "closed" ({"from":"todo","to":"closed","allowed":["in_progress","cancelled"]})` | 状态机拒绝清楚；agent 未先走 in_progress |
| 同上，行 10262/10263，2026-11-04 22:44:47 | `jira_list` | `Error: unknown tool "jira_list"` | 又一次运行时能力不可见 |
| `session-56e66d2e…` 行 1223/1224，2026-11-06 22:25:03 | `superagent_ledger resolve` | `error: INVALID_INPUT: resolve needs \`status\` of pending, returned or failed` | 必填只在运行时，schema 不提示；语义又不清楚 |
| 同上，行 2392/2393，2026-11-07 01:39:43 | `superagent_session append compact:true` | `error: INVALID_INPUT: the context was not compacted, so the follow-up was not sent: this deployment has no compaction seam ...` | 能力缺席有明确拒绝；跨机部署需核 composition |
| `session-e00351a8…` 行 154/156，2026-11-07 21:36:06 | `jira_issue get DH-904` | `error: NOT_FOUND: issue DH-904 not found ({"key":"DH-904","kind":"issue"})` | 本地 ledger 停在前两天而代码/文档已有新 issue；读取陈旧副本 |
| 同上，行 155/157 | `jira_issue get DH-725` | 同类 `NOT_FOUND` | 同上，不应当作 issue 从未存在 |
| 同上，行 1324/1325，23:02:11 | `superagent_session append` | `error: INVALID_INPUT: "" is not a registered workspace; run superagent_workspace roster first` | 把 append 当 start，未给 workspace；动作必填分散 |
| 同上，行 1331/1332，23:02:15 | 同上 | `error: INVALID_INPUT: append needs \`text\`: the follow-up instruction` | 仍把正文放在 task；第二次才暴露下一项，增加往返 |

积极面也应保留：状态错误给合法目标、tag/CAS 错误可行动；list 的 counts 基于截断前全集并提示 remaining（`jira-core/src/list.ts:175-190,217-238`）；KB search 有 snippet 和 file:line；读工具普遍开放、写权限默认拒绝；schema/结果都有统一 envelope。这些比重写一套模糊自由文本协议更有价值。

## 5. 报告解耦后的真实数据流与剩余冗余

### 5.1 报告解耦改了什么

提交说明给出的实际根因是：Markdown fallback 漏掉 requestId，多行 task 自带的 `##` 让 reader 丢掉 session/dispatched 字段，turn end 找不到候选而静默丢报告。

当前实现：

1. `superagent_session start/append/prompt` 先向 `DispatchReportStore` 写 task id、child sessionId、superSession、requestId 和 workspace，再接纳 child prompt（`superagent.ts:872-897`）。写 binding 失败则拒绝派发。
2. journal 在 `<super>/.superagent/reports.jsonl` 追加完整状态记录，最新同 id 行生效；状态为 pending/delivering/delivered/failed，delivering 五分钟 lease 后可重试（`dispatch-reports.ts:14-17,38-94,239-305`）。
3. turn end 按 child Session 的候选与本轮 `user/message.source.rpcId` 对齐；已 delivered 不重复发，失败写 failed 并告警（`superagent.ts:3814-3874,3885-3960`）。
4. ledger 坐标只是 opaque ref；人读 dispatch 台账的 outcome 在报告构建后 best-effort 投影，失败不改投递（`superagent.ts:3736-3787`）。

这里有两个需要准确描述的顺序：`dispatch-reports.ts:12` 说 after a report is delivered，`superagent.ts:3926-3927` 实际在 deliver 前做 projection，因此可能出现 dispatch 已 returned、报告却投递 failed 的分离；projection 仍不参与 claim/deliver/settle，不影响报告路由权威性。另一个顺序是 pending 台账在 prompt admitted 后才 best-effort 写入（start `superagent.ts:2861-2891`），先于 prompt 的硬保证属于报告 journal，不属于 dispatch 台账。

报告 journal 也不保存回答正文：正文与 turn 边界仍来自 Session 事件/活 Agent（`superagent.ts:3477-3501`）。旧 Markdown 任务不会自动迁入新报告 journal；现有 domain migrate 只处理 dispatch domain。首次投递失败会置 failed 而不再被 claim，且 queue 成功与 delivered 结算之间的进程崩溃仍可能在 lease 后重投。当前 `DispatchReportStore` 的 Promise 队列只序列化单实例写（`dispatch-reports.ts:156-181`），没有跨进程原子 claim，不能把它称为多进程 exactly-once。

### 5.2 同一事实的多处记录

| 事实 | 当前副本 | 判断 |
|---|---|---|
| task/目标/Session/request/时间 | report journal、dispatch domain、Markdown、DSH Session 的 user/message | journal 保留路由必需字段；domain 保留业务任务结果；Markdown 应是可丢弃投影；Session 是原始证据。四份都当权威不可接受 |
| pending/完成/失败 | journal 的 pending/delivering/delivered/failed 与 dispatch 的 pending/returned/failed | 语义不同可共存，但名字相似且都称台账；UI/工具必须明确“投递状态”与“工作结果” |
| outcome/artifacts/decisions | Session assistant、dispatch domain/Markdown、memory | Session 是原始报告；dispatch 是运维结果；memory 只保留提炼结论。当前 prompt 要求重复写，且 domain 的后续补充会丢失 |
| workspace/path/Session 归属 | DSH registry/controller、dispatch、journal | DSH 是身份权威；其他记录按 workspace/session id 引用，path 只是生成报告时的快照 |
| issue 与 commit | Jira issue/comment、git commit、DSH Session | Jira 适合保留审计关联；自动 session 文件没有新增恢复价值，close-out 评论需与 git 证据比较价值 |
| 定时工作 | DSH schedule 与 superagent 自己 5 分钟 timer | 当前 superagent 并未调用 schedule 工具；timer 是宿主生命周期内的轮询，不是 schedule 的持久规则。跨机不要同时启用两个调度器 |
| 本机状态 | `$DSH_HOME/dsh-jira` watermark/push alarm 与共享 git 仓 | 本机私有/共享审计分离合理；Windows 需避免丢失 home 后换机器身份 |

### 5.3 替换 Jira 时 superagent 应保留的最小依赖

**不应保留**：Jira `Issue` 类型、`ctx.jira`、Markdown parser、issue 状态字面量、lease 字段、comment marker 作为 Session 路由依据；这些都不能进入 `superagent_session` 和 report journal。

**应保留**：

- superagent 自有 `DispatchReportStore` 的 record/forSession/claim/settle/failPendingForSessions，及其纯字符串 record 类型；若换成 domain，claim 必须新增跨进程原子保证；
- 中性的调用者身份与显式 superHome：当前普通工具仍从 `ctx.jira.machineId` 取 machine（`tools.ts:90-120`），报告记录默认从 caller.cwd 定 root（`superagent.ts:872-896`）；
- 可选的 dispatch 审计接口 record/list/resolve/markArchivedSessions；若彻底不要 Markdown，projection 应按 taskId 直接 resolve，而不是像当前 `projectReportToLedger` 先读 Markdown（`superagent.ts:3750-3780`）；
- dispatch domain 的 task/workspace/session/request/outcome/artifacts/decisions 记录与查询；
- DSH 的 workspaceRegistry、SessionController、agents、preset/permission、storageDomain 接口；
- 可选的任务适配器：`get/list` 任务、`propose/claim/dispatch` 所需状态操作、`appendEvidence/deliverReview`；这些只服务旧 issue claim loop，不应与 workspace Session 报告耦合；
- 可选 `issueKey` 作为不透明字符串，以及 `Projector.projectDelivered(report)` 之类的单向通知接口。没有 Jira 时不注册 projector，报告流程完全不变。

**源码迁移前提**：先把 `superagent.ts`、dispatch-store/reports/ledger、workspace setup 和 superagent Remote/UI 从 `jira-agent/service/ui-jira` 分成独立包。否则即使报告模块本身零 Jira import，整体部署仍因 `inject=['jira','tools','dafeiyu']` 而强制需要 Jira service（`jira-agent/src/index.ts:65`）。

## 6. 面向重写的优化建议

| 优先级 | 建议 | 收益 | 成本/验收 |
|---|---|---|---|
| P0 | 保持报告 journal 独立；为 start/append/prompt、rpcId 对齐、重载、重复 turn end、投递失败建立 Windows 实机验收 | 防止最关键的丢报告/重复报告回退 | 中；无 Jira/坏 Markdown 时仍必须准确投递一次，失败显式可见；多宿主场景另需跨进程原子 claim |
| P0 | 将 superagent 控制面迁出 Jira 包，配置与 Remote 不再挂在 `ctx.jira`；保留可选任务适配器和 projector | 使整体替换成为真实可部署能力，而不是只拆一个文件 | 高；用无 Jira composition 启动并完成 dispatch→report |
| P0 | 统一 dispatch 权威：domain 负责任务结果，Markdown 仅可再生成视图；修正已 returned 后补 outcome/artifacts/decisions 的路径，project 所有字段变化 | 消除手工 resolve 静默丢数据和双后端差异 | 中；覆盖 pending→returned→补充、failed 修正、domain/Markdown 一致性 |
| P1 | 成功 renderer 显示错误/警告/partial；get 返回评论与 KB 正文；batch/tag 输出真实结果；工具失败保留可机读错误 | 减少“表面成功”与额外读取 | 低中；逐条 snapshot 验证模型可见文本，不只测结构化值 |
| P1 | 对嵌套参数做真正递归校验，动作级必填一次列全；错误数组拒绝而非省略；统一 limit/status/file 语义 | 减少误写与多轮试错 | 中；用错误 tags/artifacts、append 缺 workspace/text、无效 revision 做负例 |
| P1 | 区分“投递状态”和“业务结果”，工具命名/字段说明不都称 ledger；list 返回 matched/remaining/truncated，并支持按 id 直接查 | 减少错挂、误判空结果 | 中；旧任务超过 100 条仍可读/修正 |
| P1 | 评估删除自动 session 文件和每轮 close-out scan，或改为按真实需求显式关联 issue/commit | 降低 762 次扫描与派生提交成本，去掉低值重复记录 | 中；先确认人机审计消费者，保留必要的 git 审计关联 |
| P2 | 保留通用 issue/KB/git 同步核心，收敛 tags、KB 引用、状态机与 commit 绑定的实际使用场景 | 保留单人跨机的真正价值 | 中；先量化跨机读取/交接，不以工具存在证明价值 |
| P2 | 多机 superagent 不共享本机 journal/domain 作为运行锁；明确同一时刻哪台机器拥有 super workspace | 避免报告重复/路由错乱 | 高；需要部署级 ownership，不应借用 Jira issue lease 冒充分布式互斥 |

不建议把“重写为另一个大插件”当目标。更合理的最小形态是：一个可替换的任务/知识仓 + 一个独立的 Session dispatcher + DSH 自身日志/memory/schedule。Markdown 适合作审计导出，不适合再承担并发运行时绑定。

## 7. Windows 复跑注意事项

### 7.1 先固定本机事实，不能照搬 Linux 路径

本机 profile 显式写死：

- Jira root：`/home/uitstalie/桌面/dsh/dsh-plugin-multidevice-jira-cloudstore`；
- super home：`/home/uitstalie/桌面/dsh/superagent`；
- `push.enabled:false`。

Windows 要改为自己 clone 的绝对路径，不能依赖 Linux 日志中的目录名推导。root 优先级为 row config → JIRA_ROOT → `$DSH_HOME/jira` → `<home>/.dsh/jira`（`jira-core/src/config.ts:56-76`）。DSH 可能自己解析 home 却不导出 DSH_HOME，所以复跑报告必须同时记录进程 env 与实际 profile root。`DH-904/DH-725 NOT_FOUND` 和早期 `.dsh/jira` 缺 config 已证明“读到另一个/陈旧 root”会制造假结论。

### 7.2 路径与机器身份

- 通用 core 用 POSIX 相对 git pathspec，再转平台原生绝对路径（`entity.ts:67-72`）；不要在 Windows 调查中手工拼接反斜杠 git pathspec。
- Windows 比较路径要 realpath/大小写归一；super workspace 的 sameCheckout 已处理 junction/symlink/case（`superagent.ts:315-336`）。复跑应覆盖同一目录的大小写、斜杠和 junction 写法。
- MAX_PATH 检查与 240 字预警是代码辅助，不是实际长路径写成功证明；用真实深目录测试。
- 不把 super home 放在 DSH_HOME 下；保持绝对、非根目录。
- 确认 `%DSH_HOME%/dsh-jira/machine-id` 不被同步/重建覆盖。实际 `machines/m-f11f376e.md` 记录了 Windows 上 DSH_HOME 丢失后误建身份的遗留，说明这不是理论问题。
- 本地路径不能跨机当项目身份；核对 remote 绑定，paths[] 只是缓存。不同机器的 session id/机器 id 也应分开比较。

### 7.3 Session 日志调查方式

- 当前样本都是 `session.v4.jsonl.zstd`，事件有 `seq/time/type/data`；调用在 `tool/call.data.{name,arguments}`，结果在 `tool/result.data.message`，以 callId 对齐。
- Windows 不一定有 `zstd`、`jq`、GNU find/awk。用 Node 脚本读目录并经项目自带/明确安装的 zstd 解码到 stdout/内存，不要把 Bash 管道原样搬进 PowerShell。
- 不把路径编码目录名当 cwd 真相；读 Session header/meta。文件名只选择当前 canonical generation，不排除将来 v5 或不同压缩形态。
- 时间戳是 epoch 毫秒，转 ISO 后再转 Asia/Shanghai；不要直接 `todate` 当本地时间。
- 排除正在写的本次调查 session；活跃文件可能变化，记录调查开始/结束和文件快照信息。错误分类同时看 isError 与文本，不能只看工具是否抛异常。

### 7.4 存储与服务部署

- 正常 bundle 把 `superagent_dispatch` 路由到 `$DSH_HOME/storages/superagent.sqlite`（`packages/bundle/base/cordis.patch.yml:179-200`）；report journal 却在 super workspace，不在 SQLite。备份/复跑必须分别处理两者。
- domain 不可用时会退回 Markdown；工具仍可能“可用”但语义不同。复跑必须记录实际 route 和是否发生 fallback，不能只比较最终文件。
- 当前运行实例可能落后于源码；必须先记录 runtime 实际 commit/build，再在受控部署后验收。不要从 dev HEAD 推断正在跑的插件行为。
- CLI 直接走 core，不触发运行中 `ctx.jira.changed`；跨进程/跨机 UI 不是即时刷新。Windows 复跑时把“CLI 已写”“服务已见”“另一机已同步”分成三个独立断言。
- 网络 sync、SSH、git hooks、文件锁/重命名与 CRLF 需要真实 Windows 验证；源码有 mkdir 锁、写入重试、LF/CR 防护，但 Linux 审阅不能替代这些测试。Jira 直接 spawn 平台上的 `git`，需确认 Git 在宿主 PATH（`jira-core/src/git.ts:62-78`）。
- 不要把 SQLite/domain 或报告 journal 放进云同步目录让两台机器同时写。SQLite 默认 WAL；不支持 WAL shared-memory 的网络挂载需选 delete/truncate/persist（`storage-sqlite/src/index.ts:36-47`）。journal 没有跨进程锁，共享 superHome 双宿主可能交错 claim。
- Windows Session 写锁是路径派生的 named kernel semaphore，不存在可删除的 `session.lock` 锁文件；POSIX 才使用 flock（`session-persistence-jsonl/src/lease.ts:1-19`）。不要让两个宿主同时写同一 Session。
- superagent 自己有 5 分钟 timer；若另配 DSH schedule 或第二台机器的 dispatcher，需要明确唯一运行者，避免重复提案/报告。capability 的同步 dispose 不等待 dispatch domain close（`superagent.ts:4985-5002`）；复制/清理存储前必须等宿主进程完全退出。

### 7.5 建议的 Windows 最小复跑矩阵

1. **基线**：记录 checkout commit、runtime commit、profile root、DSH_HOME、machine-id、storage route、能力开关；保留未跟踪文件。
2. **无 Jira 控制面**：只挂独立 superagent，执行 start/append/prompt，验证 journal 先于 prompt、报告按 rpcId 恰好一次；这是拆分后的目标验收，不是当前包已支持的事实。
3. **坏投影**：删除/破坏 Markdown 投影、关闭 Jira，报告仍须到达；projection 失败可见但不改 journal delivered/failed。
4. **修正语义**：自动 returned 后补 artifacts/decisions；failed 后纠正；旧 id 超过 100 条仍可查；domain 与导出一致。
5. **工具负例**：非法嵌套数组、append 缺 text/workspace、todo→closed、写盘/commit 部分失败；模型可见文本须与结构化结果一致。
6. **跨机**：Windows 与 Fedora 分别写 issue/KB/comment，验证 key 不撞、身份不换、同步后双方可读；另验证 CLI 写不会伪装成宿主即时事件。
7. **重启**：插件 remount/进程重启后恢复 pending/delivering，重复 turn end 不重复投递；归档/停止 child 会失败结算 pending binding。

## 8. 附录：证据索引

### 8.1 关键源码

| 主题 | 当前 dev 路径与行 |
|---|---|
| Issue/comment/project/machine 字段 | `packages/jira/jira-core/src/entity.ts:138-235` |
| 数据驱动词表 | `packages/jira/jira-core/src/vocab.ts:22-36,59-143` |
| 实际状态与 transitions | `/home/uitstalie/桌面/dsh/dsh-plugin-multidevice-jira-cloudstore/config.md:15-70` |
| KB 来源/关联 | `packages/jira/jira-core/src/kb.ts:54-86` |
| 工具参数与动作 | `packages/jira/jira-agent/src/toolIssue.ts:17-103`、`toolList.ts:17-54`、`toolKb.ts:17-45` |
| 模型可见渲染 | `packages/jira/jira-agent/src/tools.ts:147-175,183-256` |
| 顶层-only 参数校验 | `packages/jira/jira-core/src/schema.ts:118-149` |
| dispatch 字段与 Markdown parser | `packages/jira/jira-agent/src/dispatch-ledger.ts:19-99,125-236,328-409` |
| domain 权威与 Markdown fallback | `packages/jira/jira-agent/src/dispatch-store.ts:1-8,153-227,251-309` |
| 报告 journal | `packages/jira/jira-agent/src/dispatch-reports.ts:1-17,38-94,147-305` |
| 报告按 turn/rpcId 绑定 | `packages/jira/jira-agent/src/superagent.ts:3789-3960` |
| ledger 工具与错误 | `packages/jira/jira-agent/src/superagent.ts:734-767,3337-3475,4733-4754` |
| 自动返回后补写的指令 | `packages/jira/jira-agent/src/super-workspace-definition.ts:37-57` |
| turn-end settle/scan | `packages/jira/jira-agent/src/contribution.ts:78-123` |
| session 文件与 watermark | `packages/jira/jira-core/src/session.ts:1-20,34-200,256-325` |
| Jira 与 superagent 同 row | `packages/jira/jira-agent/src/index.ts:65-139,205-239` |
| superagent 混入 service API | `packages/jira/jira-service/src/types.ts:289-315` |
| SQLite route | `packages/bundle/base/cordis.patch.yml:179-200` |
| 历史故障与修复动机 | 报告解耦提交的说明与测试 |

### 8.2 关键 Session 文件

所有路径均在 `/home/uitstalie/.dsh/sessions/` 下，文件名均为 `session.v4.jsonl.zstd`。

| 用途 | 工作区目录 / session |
|---|---|
| 长期 Jira issue 使用与 4 个错误 | `--home-uitstalie-~684C~9762-dsh-deepseek-harness-uitstalie-dev--/session-486d5296-3fd8-4158-84c7-fb5abc42257c` |
| 查不到、错挂与修正 | `--home-uitstalie-~684C~9762-dsh-superagent--/session-3f77ab15-21eb-437c-a6e9-942e0a26381e` |
| 同 id 异报告、重复 resolve | `--home-uitstalie-~684C~9762-dsh-superagent--/session-56e66d2e-dbe6-40ac-98c6-2a4ef3840ea8` |
| 丢报告、重复记录、failed 未生效、append 参数错 | `--home-uitstalie-~684C~9762-dsh-superagent--/session-e00351a8-2a4e-48f1-ad6e-e107d926d723` |
| MTool 零台账对照 | `--home-uitstalie-~684C~9762-steam-MTool-Tool--/session-88469918-e849-410a-a896-c6b4152b1252` |
| Rockstar 零台账对照 | `--home-uitstalie-Games-grand-theft-auto-san-andreas-drive_c-Program~0020Files~0020~0028x86~0029-Rockstar~0020Games--/session-b32abb08-ffee-4a26-8d48-3a69f41053fe` 与同目录 `session-0e8d563d-2670-46f7-a785-ab2a8788e639` |
| dev 修复执行零台账对照 | dev 目录 `session-2b11d864-a1f7-426e-85cf-1952112f05af` 与 `session-390341c3-0508-4e01-ab10-6ccc67271095` |

### 8.3 本机数据快照

- cloudstore HEAD 为当时的本地基线，最近提交时间 2026-11-06 01:15:57 +08:00；当时工作树干净、main 领先 origin/main 2。
- `$DSH_HOME/dsh-jira/machine-id` 当前为 `m-596433ad`；共享 machines 文件还保留 Windows 与误建身份的记录。
- dispatch Markdown 路径：`/home/uitstalie/桌面/dsh/superagent/.superagent/ledger/`；错挂示例在 `7515b01c-6587-4cd2-ab3f-9f129d2561c6.md:2446-2534`，同 id 多段可从该文件后续 returned 标题复核。
- 报告解耦新增 journal 的源码在调查时已提交；实际 super home 下尚无 `reports.jsonl`，所以 Windows 复跑必须另做新链路的实机验证。

## 2026-11-10 进展

基线说明：本节记录基于此前基线加本地 Stage A/B/C 的后续进展；原审查及其 Fedora 证据保持不变。`docs/reviews/windows-superagent-eval-2026-11-09.md` 的「失败不可重试」描述评测时的基线，不代表当前 HEAD。

### 已修

- **报告 journal 已独立于 Jira 台账。** Stage A 对应阶段基线 将 journal 移入 `@deepseek-ai/dsh-superagent-core`，Jira 保留兼容 re-export；报告绑定、投递与重试不再以 issue/Markdown 台账为前置条件。证据：`packages/superagent/superagent-core/src/index.ts:1-24`。
- **dispatch 业务域与存储已迁入 core。** Stage B 对应阶段基线 用 core 自有类型和 `DispatchProjection` 接口替代 Jira 类型/parser 依赖，Jira 注入 Markdown 投影并保留旧导入路径。证据：`packages/superagent/superagent-core/src/dispatch-types.ts`、`packages/jira/jira-agent/src/dispatch-projection.ts`。
- **Stage C 对应阶段基线 补齐已验证的投递查询与生命周期路径。** journal 提供 `list` 与 `ack`，记录 attempt/error/recipient/时间，并防止已 delivered 报告被重复 claim；启动扫描重投已保存的 pending/delivering 报告，failed 不自动重试。abort 后续建立新绑定，缺失/归档 recipient 不错投到其他 super Session，stop 的 turn-end 不投递。证据：`packages/superagent/superagent-core/src/index.ts:241-262`、`recovery.ts:31-78`、`packages/jira/jira-agent/src/superagent.ts:3326-3348,3786-3877,4094-4097,4873-4890,5203`。
- **Windows 工具面修复已入基线。** 对应阶段基线 修复 Jira 结果渲染、嵌套校验、dispatch resolve/列表计数及失败可见性；这些是 Windows 侧修复，未在 Fedora 上对同一实机场景复测。证据：对应阶段基线 及 `packages/jira/jira-agent/src/index.test.ts` 的 35 个真实组合测试。

### 部分修

- **报告可见性和恢复仍限单实例验证。** Stage C source-only 验证为 core journal/domain 26/26、Jira superagent 95/95；尚无独立的真实组合启动恢复集成测试，dispose 取消恢复但不等待其结算。证据：对应阶段基线 的提交正文及上述测试。
- **业务结果与投递分离已落到 domain/journal 和投影接口，但控制面仍在 Jira 包。** `superagent.ts`、工具注册、recipient 路由与 UI 尚未迁入独立控制服务；本轮不是无 Jira 组合验收。

### 未处理 / 未验证

- **多 Host 不是 exactly-once。** journal 的 Promise 队列和 claim 仍是单实例/进程内保护，自动接管 delivering 没有跨进程原子锁；Windows 合成多进程实验的旧风险仍然成立，未宣称已解决。证据：对应阶段基线 提交正文、`packages/superagent/superagent-core/README.md:37-41`。
- **Jira 包内控制面、旧 claim 事务、UI、旧导出/Markdown 回退移除均未完成。** Windows 的九个后续提交没有改变本轮 memory 或这些控制面边界；Stage C 也未做 Windows/Fedora 实机重启验证。
