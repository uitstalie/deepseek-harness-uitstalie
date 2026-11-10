# Super agent 实现审查：从长期 Fedora 反馈到可恢复的控制面

调查日期：2026-11-08。源码基线为 dev checkout 当时的版本；运行中的 runtime checkout 未包含报告 journal 修复。本文整合 Jira 台账、memory 与定制隔离性审查，重点回答 super agent 如何可靠地派发、观察、恢复和收尾，不重复三份审查的完整细节。

> **Fedora 实机反馈**：本评估基于 Fedora（Linux）实机反馈，Windows 复跑后可能不同；后续以 Windows 复跑为准。

## 0. 结论先行

1. **当前最大问题不是“派不出去”，而是任务完成后没有可见、可恢复的闭环。** 隔离性、Jira、memory 三个调查均完成，但旧 runtime 都没有自动回传。当前源码虽新增独立报告 journal，却仍在投递前把 ledger 写成 returned/failed；投递失败后是终态、不会自动重试，也没有工具或 UI 展示。必须先把“业务结果、报告投递、人工处理”建成一个可见状态机，而不是继续靠人工读日志和补 resolve。
2. **super agent 仍把通用 Session 操作、Jira 工作流和跨机控制面塞在同一实现中。** `superagent.ts` 有 5,006 行，`start` 的多步失败会留下空 Session，`abort` 后续任务无报告绑定，局部选模型还会更新全局默认；permission、提问、部署均缺少按任务编排。先拆出独立控制面，再做面板、等待和部署，避免扩大同步热点。
3. **增强与收敛必须同时进行。** 保留真实 Session、按 prompt 绑定报告、queue/interrupt、compact、inspect 等已有能力；新增标题/权限/提问/结构化结果/等待原语；同时让 ledger 变为只读投影，任务正文与报告全文留在 Session/产物文件，Jira 仅保留可选 issue 引用，memory 仅保存可淘汰结论。目标不是再建一本更完整的账，而是消除人工搬运。

### 优先落地顺序

| 阶段 | 必须得到的结果 |
|---|---|
| 先正确 | 任一任务均能看出 pending/running/result-ready/delivered/failed；失败有原因、可重试；abort/archive/start 失败不留下不可恢复状态 |
| 再收敛 | 一个任务状态权威；ledger/memory/Jira 不再重复任务正文和状态；报告提交与业务结算有明确提交顺序 |
| 再好用 | 标题和用途可恢复、权限与模型默认可控、提问不 abort、等待替代轮询、面板直接显示健康和下一步 |
| 最后编排 | 受控部署、回滚与版本验收；在 Windows 实机验证，而不是把 Fedora 的路径/时序经验照搬 |

## 1. 调查口径、证据与版本限制

### 1.1 数据来源

- 超管自评原文：super session `session-e00351a8-2a4e-48f1-ad6e-e107d926d723`，2026-11-08 23:18:45，解压 JSONL 行 3366/seq 3364。自评是调查输入；下文逐项区分日志事实、当前源码事实和待验证判断。
- 实际 session：同一 super session；dev 的隔离性/Jira/memory 调查；Rockstar 的 `session-b32abb08…`；MTool 的 `session-88469918…`。
- 当前实现：`jira-agent/src/superagent.ts`、`dispatch-reports.ts`、`dispatch-store.ts`、`jira-service` 与 `ui-jira`，并按需追溯 Session Controller、permission、user-questions 与 workspace archive。
- 整合材料：`goal/jira-ledger-assessment-2026-11-08.md`、`goal/memory-plugin-assessment-2026-11-08.md`，以及隔离性调查的父层回读报告。

### 1.2 统计与证据标准

日志只读解压，工具调用按 `toolCallId` 对齐结果；“行”为解压 JSONL 行，“seq”为持久 Session 事件号。时间为 Asia/Shanghai。没有调用业务写工具、启动/关闭服务或修改 runtime。当前源码问题由实现证明，历史日志只证明当时版本的可观察行为。

本次没有运行代码测试或 Windows 实验。对多进程 journal、路径别名、权限切换和部署回滚只给复跑矩阵，不把静态推断写成实机结论。

### 1.3 运行版本必须单独记录

- 当前 dev 包含报告绑定修复及后续文档；实际 runtime 不含 `DispatchReportStore` 和 `.superagent/reports.jsonl`。
- 本机 super workspace 在调查时没有报告 journal 文件。因此三个调查报告没有自动回传是旧运行链路的实机证据；不能据此断言新 journal 已被实机验证或仍会产生同样的根因。
- “代码已提交/push”与“GUI 已加载该代码”是两个独立事实。报告中的“当前源码仍有”与“旧 runtime 已发生”不能互换。

## 2. 现状与时间线证据

### 2.1 三次调查都完成了，但报告没有到达超管

| 工作 | 子 Session 完成证据 | 超管实际收尾 | 结论 |
|---|---|---|---|
| 定制隔离性审查 | `session-2b11d864…`：2026-11-08 19:54:24，行 103/seq 101 有完整报告，行 105/seq 103 completed | super 行 2306/seq 2304 于 19:58:56 仍 pending；行 2321/seq 2319 于 19:59:15 手工 resolve | 丢的是投递，不是工作结果 |
| Jira 台账审查 | `session-00f47534…`：21:15:54 行 710 提交报告，21:16:43 行 736 核实远端，行 751/seq 749 completed | super 行 3091、3100 于 21:30 用 list/bash/git 人工确认 | 工具能列出 idle，但不能找回报告状态 |
| Memory 审查 | `session-ab1fe725…`：22:46:08 行 624 核实本地/远端，行 636/seq 634 completed | super 没有 task-report；行 3220/3219 于 22:43 inspect running，行 3360/3358 于 23:18 才发现 idle | 长任务监视替代不了完成通知 |

隔离性调查还暴露当时的实际根因：报告绑定依赖 Jira Markdown 回退，多行正文截断了解析区间，session/request 字段丢失。当前 journal 的“dispatch 前先绑定、turn 内按 rpcId 匹配”正是针对该问题的合理修复方向；但下文指出的失败可见性、投递顺序和生命周期仍是当前源码问题。

### 2.2 多本账是真实工作量，不是所有副本都同权

在本次 super session 的日志横截面中，有 51 次 `superagent_session`、38 次 `superagent_ledger`、33 次 `memory_write`，包括 28 次 append、10 次 inspect、7 次 start、6 次 list。报告、手工 resolve 和 memory 收尾反复出现，说明超管在承担系统未完成的集成工作。

但这不证明“四套存储都该合并”：Session 是原始证据，journal 是路由/投递，dispatch domain 是业务结果，Jira/memory 分别是审计知识与可淘汰结论。错误在于这些记录含相同正文、状态和责任，且没有一个面向用户的统一视图。重复案例是：

- dev 修复报告在 super 行 2623/seq 2621 与 2644/seq 2642，于 20:22:56 和 20:23:10 以**不同 task id**重复到达，正文相同；对应手工 resolve 也称重复。
- MTool 启动报告在行 2552/seq 2550 与 2574/seq 2572，同样是不同 task id、相同正文。
- Rockstar 的同一 abort 在行 1744/seq 1742 又发一次失败通知；超管已在行 1732/seq 1730 手工写 failed。

因此去重不能只按 task id：还需要内容/结果身份、父任务关联和状态变化抑制。不能把它误写成“当前同一 id 的重放仍重复”；当前源码已有按 id 防重。

### 2.3 命名、路由和空 Session 有可量化现场

21:30 的 dev `list`（super 行 3090/3091、seq 3088/3089）有 7 个 Session，其中 4 个 untitled，而不是自评概括的“8+ untitled”。三次调查的新 `start` 均传了 title，说明现有功能有效；问题是 title 可省略，且历史/失败 Session 没有可恢复的用途视图。

当前 `start` 在 create 后才选模型、rename、写 binding、prompt。模型/effort 拒绝、rename 失败或 binding 失败均会留下未执行任务的 Session。它没有统一的 `created/titled/admitted` 部分状态，也没有自动清理或“继续这个未启动 Session”的恢复入口。频繁 start 的 7 次记录证明创建数量，不证明每个新 Session 都应复用；应根据标题、用途和活跃任务判断。

### 2.4 提问中断与长任务自检不足

Rockstar `session-b32abb08…` 在 2026-11-07 23:09:51 行 644/seq 642 调 `ask_user_question`；行 645/seq 643 返回 `Error: the user cancelled ask_user_question`，行 651/seq 649 以 aborted(user) 结束。super 行 1388/seq 1386 的 inspect 显示 last error `UserQuestionError`。

这证明提问导致整轮结束，不能仅凭这些行证明“NO_PROVIDER 是唯一根因”。通用服务确实以 `NO_PROVIDER` 拒绝无人接受的提问；superagent 缺少的是把子 Session 的未决问题可靠地展示给超管/用户并继续，而不是让该问题变成任务终点。

MTool 的 `session-88469918…` 则显示两层自检缺口：

1. 21:34 的报告（super 行 3124/seq 3122）承认旧采样只有 MTool、没有游戏，实际约 1 秒一轮而非 100ms，不能判断掉帧；
2. 22:53 的等待报告（行 3258/seq 3256）显示十分钟超时；用户随后指出实际是 `game.exe`，行 3305/seq 3303 才记录正确的 Game.exe/GPU/renderer PID。

这些不是 superagent 代码自身的采样 bug，而是“启动条件没有验收、turn 结束与后台 job 分离、超时没有恢复策略”的编排证据。任务已返回并写入 returned，不代表用户目标已完成。

### 2.5 Monitor 有用，但不能替代状态订阅

当前 super session 中有 29 条 task-report、24 条含 monitor 的上下文消息。Jira 调查在 20:57:48–21:12:29 有 13 条 monitor（super 行 2884–3044），memory 调查在 22:41:47–22:43:26 有 7 条（行 3181–3244）。后者反复报告 71–72 分钟，但多数仍有 bash/edit 活动，不能据此判断卡死。

当前工具只有 inspect/list 和消息通知，没有 block-until-report；inspect 对冷 Session 直接拒绝。monitor 是每次模型请求时计算的提示，不是独立轮询守护；其“是否再次发生/是否已确认”没有状态。它适合提醒，不适合充当长任务恢复机制。

## 3. 当前实现的问题清单（按严重度）

严重度：P0 表示核心报告/任务状态可错误终结或产生不可恢复的工作；P1 表示重要操作缺少可靠边界、扩大副作用或显著增加人工成本；P2 表示观测、易用性和文档/组合缺口。未实测的安全/Windows 假设单独标注。

### 3.1 P0：报告失败不可见且永不自动重试

`DispatchReportStore.claim` 不领取 delivered/failed；turn-end 只选 pending/delivering。投递失败后 `handleTaskTurnEnd` 写 warning 和 failed，随后不再选它。journal 只有按子 Session 读取的接口，没有面向 UI/状态工具的列表、重试或人工确认接口。

`ui-jira` 的 superagent 面板展示的是 issue 计数、needsPerson、trigger 和 git history，不显示子 Session 投递状态。用户只能读日志或手工 resolve。即使新 journal 解决绑定丢失，也无法解决“消息发出失败之后无人知道”。

崩溃遗留的 delivering 只有再次发生 turn-end 才会按 lease 重试；当前没有确认的启动时恢复扫描。多 Host 也没有跨进程原子 claim：单实例 Promise 队列不能阻止两个进程同时读取并投递。

### 3.2 P0：业务结果在报告投递前写成 returned/failed

`handleTaskTurnEnd` 的顺序是 `projectReportToLedger` → `deliverTaskReport` → `settleReport`。所以 ledger 可以 returned，而报告 journal 是 failed；这与模块注释所称“报告投递后再投影”相反，也把“子 turn 完成”和“超管已收到”混成一个状态。

投影还有额外缺口：它先读 Markdown，找不到 task 就直接返回，甚至不调用存在的 domain store；domain 写入成功而 Markdown 失败时，pending 可永久保留。需要把业务结果、报告投递和投影分开建模，并给三者显式状态与可重放投影，不可用一个 `returned` 冒充全链路成功。

### 3.3 P0：abort、archive 和唯一超管 Session 的生命周期不闭合

- `abort` 在 cancel→idle 后直接 prompt，没有新 taskId、报告 binding 或 ledger pending。新任务完成后不会按新任务回传；`resumed:true` 只证明 prompt 返回。
- archive/stop 只把 pending 报告置 failed，不处理 delivering；后续 turn-end 仍可能在 lease 到期后重领并投递。domain 只加 `orphanedAt` 而保留 status=pending，列表又不显示该字段。
- super home 中每个普通 root Session 都获得 dispatcher 工具；报告接收者缺失时选择最近更新的 super Session，而非原派遣者。所谓“single conversation”没有唯一身份或归属锁。
- `reportJournals` 是模块级 Map，dispose 不清理；它不只是代码风格问题，还使多 contribution/进程共享文件的生命周期缺少明确 owner。

这些不是边缘清理项：它们会导致报告错投、任务悬挂和已归档 Session 继续产生影响。

### 3.4 P1：start 的多步操作留下空 Session，失败不能恢复

当前 create→selectModel→rename→record binding→prompt 的每一步都可能失败，但后一步失败不撤销或标记前面状态。尤其是非法 effort 可创建一个无标题、无任务、无报告绑定的可见 Session，正好加重命名/膨胀问题。

应在创建前解析模型、标题、权限、预算和报告存储能力；无法避免的部分失败要产生统一的 `created/configured/admitted/failed` 记录和可恢复动作。不能简单用“失败即删除”掩盖审计与正在运行的并发行为。

### 3.5 P1：子 Session 模型选择有全局副作用，effort 策略又增加往返

Session Controller 的 `selectModel` 除选择当前 Agent 的模型外，还异步 `agentDefaultModel.saveSelection`。superagent 的一次局部派发会改变后续新会话默认；保存失败只写 warning。接口没有“仅此 Session”的选项，现有 superagent 测试也没有检查该副作用。

effort 缺失时工具明确要求“ask the person”，本机隔离性派发在 19:46:40（super 行 2204/seq 2202）实际问过 effort，19:48:59 才回答 high。该单个实例不能证明每次都问；它证明当前策略会把派发的内部细节暴露成人工往返。应支持经用户预设的任务级默认，例如 review=high，同时保留非默认/高成本选择的人工授权。effort 查询失败目前还被吞成“无列表”，可能绕过原本的要求，需显式区分不可用和无需选择。

### 3.6 P1：权限与提问没有按子 Session 编排

superagent 的 `superagent_agent_preset` 能转发工具组合，但 `permissionPresets` 只用于固定 super 自身；`start` 没有 permission preset 参数。DSH 已有 `permissionPresets.resolve/set`，不需要另造权限系统，但必须经用户选择/预设并回读实际 sandbox+approval 生效状态。

提问服务有 NO_PROVIDER、DELEGATED_CALLER、timed pending/late reply 等机制，但 superagent 没有把这些接入任务状态。普通 root 子 Session 不必然没有 answerer；本例不应仅凭取消文本判定根因。目标应是“问题成为可见的 waiting-for-person 状态，回答继续同一任务”，而不是取消/abort 后再派新任务。

### 3.7 P1：报告只取最后 assistant 文本，没有结构化结果与后台工作状态

自动报告/ledger outcome 是该 turn 最后 assistant text；artifacts/decisions 由 super 模型事后手工 resolve。长报告会整段进入 super 上下文，当前没有结论/证据/产物/待决的结构化提交，也没有“超长落文件，回报路径”的统一通道。

后台 job 可以在 turn 结束后继续运行，但报告不含 job 是否完成、采样是否覆盖目标、产物是否可信等检查。MTool 案例说明“返回了报告”和“任务达成了验收条件”是不同状态。应由子 Session 提交结构化结果和证据引用，控制面保留后台工作/后续任务关系。

### 3.8 P2：面板、等待、通知和部署仍是人工流程

- `list` 的 title/model/lastTask/usage 大多来自 live Agent；冷 Session 的投影 hints 没有被工具展开。重启后信息退化是源码支持的待验证推断，不是本轮实测。
- 没有 block-until-report、按任务订阅、已确认 monitor 或状态变化去重；反复 inspect 是主要替代路径。
- superagent setup 只配置 home/register/pin；没有版本选择、pull/build/restart、回滚、运行版本验证和状态回报。运行实例与源码漂移正是本报告的核心事实。
- 报告模板要求 memory_write+resolve，super workspace 指令再重复一次；任务正文又写进 journal 和 ledger。文字重复既是 prompt 成本，也是多本账的直接来源。
- 大目录/长日志噪音在 MTool/采样时间线可见，但本轮没有跨工具量化；不能把工具输出问题都归给 superagent，应在通用工具预算和结构化产物层处理。

## 4. 增强与收敛建议（优先级/收益/成本）

### 4.1 建议的任务状态与权威分配

将“任务结果”和“报告投递”保持为两个相关但不同的事实，而不是再把它们混成一本账：

| 状态/事实 | 权威与最低字段 | 消费方式 |
|---|---|---|
| 任务定义与执行身份 | task store：taskId、workspaceId、childSessionId、parent/turn/request 引用、标题、权限/模型预设 | UI/工具按 id 查，不复制完整 prompt |
| 执行与结果 | running/result-ready/blocked/completed/failed；结论/证据/产物/待决；验收状态 | 子 Session 提交结构化结果，原文留 Session/文件 |
| 报告投递 | pending/delivering/delivered/failed；attempt、error、nextRetry、recipient | UI 显示失败、可重试；turn-end/启动恢复共用 |
| 人工等待 | waiting-for-person；question callId、超时、恢复入口 | 回答继续同一任务，不 abort |
| 人读审计 | dispatch ledger 为只读投影；Jira 可选 issue；memory 可淘汰结论 | 不参与路由、锁定或结算 |

这里的“一个任务状态权威”不意味着删除 journal 的投递字段：它们记录不同事实，但同一接口和 UI 必须联合显示，不能让用户在四处猜哪份最新。报告提交与业务结算需要明确的事务/提交顺序和幂等恢复；若底层跨存储无法原子，必须显示部分提交而非宣称事务成功。

### 4.2 分优先级实施

| 优先级 | 建议 | 收益 | 成本与验收 |
|---|---|---|---|
| P0 | 给报告失败/积压建立列表、告警、显式 retry；启动恢复 pending/delivering；失败不是不可操作的静默终态 | 任一完成任务都能被找回，不再人工读日志 | 中高；关闭接收方、进程崩溃、重启、重复 turn-end、多 Host 均有可预测状态 |
| P0 | 修正结果/投递/投影顺序；domain 不依赖 Markdown 才能 resolve；分离业务完成与投递状态 | 消除 returned+failed、永久 pending | 中；投递失败、domain 成功/投影失败、重放均断言状态一致 |
| P0 | 补齐 abort/archive/start 的绑定与恢复；固定 super recipient，禁止“最新 super”替代原派遣者 | 防止错投、悬挂、空 Session | 中高；逐步失败、归档竞态、多个 super Session 有明确归属 |
| P0 | 把 superagent 控制面从 jira-agent/service/ui 拆出；Jira claim loop 变可选适配器 | 降低替换成本和上游冲突 | 高；无 Jira 组合可完成 dispatch→result→report→retry |
| P1 | 子 Session 提交结构化结果（结论/证据/产物/待决/验收）；长文落文件并回传路径 | 降低上下文与重复转述 | 中；结果校验、缺失字段、超长、后台未完成均有负例 |
| P1 | 标题/用途、permission、模型/effort 默认在派发前解析并回读；局部模型不保存全局默认 | 减少空/untitled Session、权限误配和人工询问 | 中；复用现有 permission/model 服务，非法配置不创建 Session |
| P1 | 增加 waiting-for-person 与 block-until-report（超时/取消/可重订阅）；复用 timed question | 去掉轮询 inspect 与提问 abort | 中高；冷/热 Session、重启、迟到回答、超时均保持任务身份 |
| P1 | 面板展示任务、健康度、最近报告、待决与下一步；继续/compact/archive 走现有服务 | 让状态可见且可操作 | 中；覆盖冷 Session、投递失败、后台 job、权限失败 |
| P1 | 受控部署编排：固定 runtime、锁、pull/build/restart、健康检查、回滚和状态回报 | 消除“已修但未部署” | 高；失败不中断无关服务，旧版本可恢复，用户明确授权 |
| P2 | 状态变化才通知；关联同父任务/同结果内容，抑制陈旧 monitor 和重复报告 | 减少噪音与重复转述 | 中；不按 id 之外误合并真正不同的重试结果 |
| P2 | 通用工具输出按类型/预算截断并给持久路径；memory 先做本地可用检索与去重，不接管任务状态 | 降低大输出和重复记忆 | 中；检索失败有 partial 状态，报告正文不再复制到 memory |

不建议先做“功能更全的大面板”或“把 journal/domain/Markdown 合并为一个可写存储”来掩盖问题。先定义每个状态的 owner、恢复和失败可见性，再决定投影存储。

## 5. 与三份审查的整合

### 5.1 Jira 台账审查：保留跨机审计，迁出运行控制

既有 Jira 报告已证明 superagent 的实际主路径是 Session 派发而非 issue 工作流。本报告新增的投递顺序、失败不可见、生命周期和多 recipient 问题进一步支持其拆分建议：控制面应独立，Jira 只保留任务适配、可选 issue 引用与审计投影。

但 Jira 的 issue/comment/KB、机器身份、跨机同步不能因“多本账”就被一并删除。它们回答的是任务审计与知识复用，不是报告当前是否送达。

### 5.2 Memory 审查：减少记录，不把 memory 变成第二任务库

Memory 报告中的默认检索失败、每轮快照、淘汰和重复结论会直接恶化超管体验。本报告建议的结构化结果/引用应与 memory 的 append/recall/read 最小接口配合：memory 只保留值得恢复的经验和 task/issue 引用，不保存 pending、recipient、报告正文或 job 状态。

本机 super session 的 33 次 memory_write 与反复 ledger resolve 是冗余工作量证据；本地 grep 可以作为调查时的补救，但不应成为长期跨工作区权限绕过。Memory 修复与 superagent 控制面应分别验收。

### 5.3 定制隔离性审查：新增功能必须落在扩展点而非更大热点文件

隔离性回读结论为 B−：1,075 个差异文件中 875 新增、199 修改、1 删除，独立包占多数；但 workspace 接线、注册/组合/生成物和核心文件是重复同步热点。当前 `superagent.ts` 5,006 行、Jira service/UI 同时含 superagent 状态，正是这个结构性风险的实例。

报告的所有增强均应优先复用 Session Controller、workspace、permission、user-questions、storage 和 UI slots；新增 dispatcher/control-plane 包，而不是继续在 Jira 模块追加数千行。保留 merge-forward 的现实约束，不把大规模重写与 rebase 同时当作一次操作。

### 5.4 合并后的目标

一个独立 superagent 控制面 + DSH 自有 Session/workspace/permission/question/compaction 原语 + 可替换 Jira 任务/KB + 可淘汰 memory。任务是唯一业务对象，报告是其可恢复输出，其他文档都是投影或证据，不再由超管手工搬运。

## 6. Windows 复跑差异与验收矩阵

### 6.1 必须固定的部署事实

- 分别记录源码 commit、runtime commit、实际 build 与 capability active 状态；不能从 dev HEAD 推断 GUI 行为。Fedora 本报告的失败时间线只代表旧 runtime。
- 使用 Windows 自己的 super home、workspace 与 DSH_HOME 绝对路径；记录 case/尾分隔符/junction/realpath。superagent 的 sameCheckout 有 Windows 处理，但 memory 的 cwd 精确比较是另一套语义，不能混用结论。
- 明确 storage route、journal 文件、Session JSONL、task store 与 profile 的备份关系。不要让两台机器/两个 Host 把同一 journal 当分布式锁。
- 本机 Windows 不跑已知必红的 snapshot 通道；用 focused 行为测试、真实 Session 与实机 UI 记录，平台快照归 macOS/Linux CI。

### 6.2 报告与生命周期的 Windows 验收

1. **基线投递**：start/append/prompt 均先绑定再 prompt；即时 turn-end、排队任务、重启后各恰好一次报告。
2. **失败恢复**：关闭接收方/制造写失败/进程退出；UI 显示 failed 和原因，显式 retry 后 delivered；重启能恢复 pending/delivering，不需要新 turn。
3. **状态一致性**：业务 result-ready 但投递 failed 时 ledger/UI 不冒充 returned；Markdown 不可写不影响 domain，投影可重放。
4. **生命周期**：abort 新任务有 binding；archive/stop 同时处理 pending/delivering；不向已归档或另一 super Session 错投；两个 Host 不重复 claim。
5. **start 负例**：非法模型/effort、rename、权限和 binding 失败不会留下无身份、不可恢复的空 Session；局部模型选择不改全局默认。
6. **提问与等待**：子 Session 提问显示 waiting-for-person；超时/取消/迟到回答可恢复；block-until-report 支持超时和重启，不轮询 inspect。
7. **部署**：受控 pull/build/restart 在真实 Windows 权限下执行，锁与回滚有效；运行版本健康检查失败可见。不得借测试启动无关服务或游戏。
8. **跨机**：Windows/Fedora 各自写任务证据，使用可移植 task/issue/session 引用；journal 不跨机同时写，权限/approval 变化按机器审计。

### 6.3 输出与观测的跨平台差异

- 长路径、进程名、PowerShell 与 Windows 文件占用会改变日志、任务输出和 archive 行为；不要复用 Fedora 的 `game.exe`/`/proc` 案例作为 superagent 自检实现。
- 验证报告大小限制、长文落文件和结构化字段在 UTF-8/CRLF 下保持一致；不要把字节数与字符数混用。
- 对 monitor/后台 job 使用可控时钟和事件等待，避免 Windows CI 用固定 sleep 制造时序偶发；归档/停止需等真实 quiescence，不能只等工具调用返回。

## 7. 附录：证据索引

### 7.1 关键源码

| 主题 | 当前 dev 路径与行 |
|---|---|
| dispatcher 指令、title/模型/权限/工具参数 | `packages/jira/jira-agent/src/superagent.ts:98-134,497-572` |
| super 自身权限与 role 识别 | 同上 `:315-455` |
| start 的 create/select/rename/bind/prompt 顺序 | 同上 `:2817-2908` |
| abort 无新报告绑定 | 同上 `:3113-3169` |
| list/inspect/archive 的实际能力 | 同上 `:3014-3048,3190-3267` |
| monitor 与 runtime context | 同上 `:2078-2397,4514-4535` |
| 模型 effort 与选择 | 同上 `:1800-1961` |
| 报告正文、投递和 turn-end 状态 | 同上 `:3477-3614,3789-3960` |
| 报告 journal、claim/settle/failed 终态 | `packages/jira/jira-agent/src/dispatch-reports.ts:38-94,153-305` |
| domain 与 Markdown 投影、orphan | `packages/jira/jira-agent/src/dispatch-store.ts:251-309,338-352` |
| superagent 仍与 Jira 同包注册 | `packages/jira/jira-agent/src/index.ts:65-139,205-249` |
| UI 只看 Jira 提案/历史 | `packages/jira/ui-jira/src/client/SuperagentPanel.tsx:65-218` |
| 模型选择的全局默认副作用 | `packages/api/session-controller/src/commands.ts:161-195` |
| 冷 Session 列表只有投影 hints | `packages/api/session-controller/src/types.ts:153-167` |
| permission 可复用 resolve/set | `packages/interaction/permission-presets/src/index.ts:382-437` |
| question 的 NO_PROVIDER/delegated/timed 边界 | `packages/interaction/user-questions/src/index.ts:137-149,239-274,291-360` |
| timed pending/late reply 原语 | `packages/interaction/tool-ask-user/src/timed.ts:27-46,107-210` |

### 7.2 关键 Session 文件

所有路径均在 `/home/uitstalie/.dsh/sessions/`，文件均为 `session.v4.jsonl.zstd`；行号为解压后的 JSONL 行。

| 用途 | 工作区目录 / session / 位置 |
|---|---|
| 超管自评与全部主要时间线 | `--home-uitstalie-~684C~9762-dsh-superagent--/session-e00351a8-2a4e-48f1-ad6e-e107d926d723`；自评行 3366/seq 3364 |
| 隔离性报告完成但 pending | 同上；super 行 2211/2212 派发，行 2306 pending，行 2321/2322 手工 resolve；dev 目录 `session-2b11d864-a1f7-426e-85cf-1952112f05af` 行 103/105 |
| Jira 报告人工确认 | 同上；super 行 2804/2805 派发，行 3091/3100 人工查；dev 目录 `session-00f47534-2649-4cb1-beff-eba64b1a8a35` 行 710、736、751 |
| Memory 报告未回传与重复 inspect | 同上；super 行 3106/3107 派发，行 3220/3221、3359/3360 inspect；dev 目录 `session-ab1fe725-0901-4a53-889a-2cc959733cbe` 行 624、636 |
| 重复正文是不同 task id | 同上；super 行 2552/2574、2623/2644；Rockstar abort 再通知行 1744/seq 1742 |
| untitled 与 monitor 量化 | 同上；super 行 3090/3091 的 dev list，行 2884–3044、3181–3244 的 monitor |
| effort 人工询问实例 | 同上；super 行 2204/seq 2202 提问，行 2205/seq 2203 回答 high |
| 提问取消与整轮 abort | Rockstar 目录 `session-b32abb08-ffee-4a26-8d48-3a69f41053fe` 行 644/645/651；super inspect 行 1388/seq 1386 |
| 采样目标/超时/修正 | MTool 目录 `session-88469918-e849-410a-a896-c6b4152b1252`；super 对应报告行 3124、3258、3305，体现 turn 与后台工作分离 |

### 7.3 整合材料与复跑记录要求

- `goal/jira-ledger-assessment-2026-11-08.md`：Jira 职责、工具问题、dispatch/report 数据流和跨机边界。
- `goal/memory-plugin-assessment-2026-11-08.md`：memory 实际调用、检索/快照/淘汰问题与 Windows 注意。
- 隔离性结论的可复核回读在上述 super session 行 2330/seq 2328；它不是一篇独立落盘的 goal 报告，本文没有伪造不存在的文件。
- 报告只写当前调查证据；当前新任务后续是否完成不属于本报告事前事实。复跑必须另存 runtime/build 身份和真实报告状态，不能只比较文件是否存在。

## 2026-11-10 进展

基线说明：本节记录基于此前基线加本地 Stage A/B/C 的后续进展；原审查及其 Fedora 证据保持不变。`docs/reviews/windows-superagent-eval-2026-11-09.md` 的「失败不可重试」描述评测时的基线，不代表当前 HEAD。

### 已修

- **journal 与 dispatch domain/store 已迁出 Jira 实现。** Stage A 对应阶段基线 将报告 journal 放入 `@deepseek-ai/dsh-superagent-core`；Stage B 对应阶段基线 迁入 dispatch 域与 store，以 `DispatchProjection` 接口注入 Jira Markdown 行为。证据：`packages/superagent/superagent-core/src/index.ts:22-24`、`dispatch-types.ts`、`dispatch-store.ts`。
- **Stage C 对应阶段基线 已落地并验证限定的报告生命周期。** journal 支持 pending→delivering→delivered/failed、list/ack 和重复投递保护；初始化扫描重投有正文的 pending/delivering，failed 保持可见且不自动循环。abort 后续 prompt 有新任务绑定，缺失/归档 recipient 不改投最新 super Session，stop 的 turn-end 被抑制。证据：`packages/superagent/superagent-core/src/recovery.ts:31-78`、`packages/jira/jira-agent/src/superagent.ts:3326-3348,4094-4097,4873-4890`。
- **source-only 回归已通过。** core journal/domain 26/26、Jira superagent 95/95；相关测试包括 `recovers saved pending reports once without reopening delivered or failed work`、`takes over a fresh delivering claim during startup recovery and preserves acknowledged work`、`refuses a missing or archived recipient rather than rerouting to the latest super Session` 和 `stop cuts a running turn off: nothing is admitted, the queue is cleared`。
- **Windows 相关修复已进入当前基线。** 对应阶段基线 修复 Jira 工具结果与实际写入不一致；对应阶段基线 保留非关键未知 Session 事件；对应阶段基线 使 Windows ACL 后端 fail-closed 禁用，对应阶段基线/对应阶段基线 又加固直接构造与导出边界。这些 Windows 修复未在 Fedora 上做对应实机复测；对应阶段基线 的工具合并是独立变更。

### 部分修

- **启动恢复已有初始化调用与 core 单测，但没有真实组合下的独立启动恢复集成测试。** dispose 会取消恢复，不等待已接纳恢复完成；这只证明本轮 source-only 范围，不证明崩溃时序已闭合。证据：`packages/jira/jira-agent/src/superagent.ts:4873-4890,5278-5282`、对应阶段基线 提交正文。
- **archive/stop 现在覆盖 pending 与 delivering 的可见失败状态，但只验证了绑定、recipient 和 turn-end 抑制路径。** 没有声称真实 Windows 进程、跨 Host 归档竞态或 UI 已验收。证据：`packages/superagent/superagent-core/src/index.ts:341-352`。

### 未处理 / 未验证

- **控制面完整拆分仍未做。** `superagent.ts` 仍为约 5k 行的 Jira 控制面；无 Jira composition 的 dispatch→result→report→retry、Remote/UI、结构化结果和权限/提问编排不在 A–C 范围。
- **多 Host 重复投递与生命周期残留风险仍在。** 没有跨进程原子 claim，dispose 未等待恢复结算；不得把本轮幂等测试解释为跨 Host exactly-once。证据：对应阶段基线 提交正文及 core README 的限制段。
