# Super agent 调研：概念、原型与我们这边能怎么接

本文件是"把 super agent 整合进 dafeiyu"这项工作的调研底稿。结论先放最前面：**super agent 不是一个"能力"，而是一台常驻的、带授权模型的异步工作机**——它可以作为 dafeiyu 的一个 capability 出现在能力列表里，但它的主体（Source 轮询、Ticket 生命周期、执行器 Session、面板、状态库）必须由它自己的 host 插件承担，dafeiyu 只负责"开关 + 模型面"。

调研时间：2026-11-01。代码与文档取自 `deepseek-ai/dsh-superagent-prototype`（MIT，2026-10-31 09:32 UTC 建仓，当日 12:05 UTC 唯一一次推送；截至调研时 4401 star / 406 fork / 0 open issue / 216 文件）。

## 1. 这个词指的是什么

DeepSeek Harness Team 在开源原型的同时发了一篇设计文章 *Exploring Super-agent Design: Towards a More Autonomous Agent System*（文章本身没有公开的独立链接，仓库 README 与 `docs/` 是它的落地版本；[README](https://github.com/deepseek-ai/dsh-superagent-prototype) 明确说明"文章里的部分设计是未来方向、原型未实现"，且公开版与内部版并不逐字相同）。

它给出的定义不是"更强的单体 Agent"，而是**一个替整个团队接活、并且按注意力成本自我约束的 Agent 系统**：

- 一个常驻 Agent 同时面对聊天（飞书）、GitHub 通知/Issue/PR/CI 等多个事件源；
- 人的请求先过"准入"（这个人有没有资格让它干活），只有被授权的请求才变成工单；
- 工单在**自己的 Session 和自己的目录**里执行，执行完回到原对话交付（例如提 PR）；
- 一个 Web 面板只回答三个问题：**现在需要我吗 / 系统健康吗 / 这件工作的历史是什么**；
- 核心判据写死在哲学文档里：*Take as little human attention as possible, and give as much value as possible*。

与"给单个 Session 加更多工具"（我们现有的 dafeiyu 能力、subagent、workflow）相比，它补的是另外三样东西：

1. **授权模型**：凭什么让 Agent 干这件事、能到哪、谁批的、按哪版规则批的（Mandate + Policy 版本化）。
2. **异步生命周期**：工单可以跨轮次、跨进程重启、跨执行器接力，人的一句话可以唤醒已结束的工单。
3. **注意力预算**：默认什么都不做（`observe`），默认不说话，默认只问一个问题。

## 2. 设计要点（读完 `docs/000`–`008` 的提炼）

### 2.1 哲学（000）

- 每条消息、每个通知、每个问题、每个设置项、每个面板元素、每段文档都有注意力成本，给不出更多价值就删掉。
- 对 Agent 的五条要求：只在被请求或书面规则允许时行动；只在"人必须行动或能用上结果"时说话；一次只问一个具体问题；按影响面停（本地改动做到可评审，需要设计决策就带着问题停）；诚实报告（未完成就标未完成，失败就报失败）。
- 对设计的四条要求：少概念（业务需求变成某个概念的属性或一段提示词，不新增概念）；少设置（默认值替代设置）；面板只显示需要人的东西；文档必须按编号顺序读。

### 2.2 领域模型（001）

核心概念 11 个：Source、Trigger、Thread、Correlation、Channel、Policy、Eval、Mandate、Ticket、Assignment、Subscription。

- **Mandate（授权凭证）**：一次 accept 固化成"哪版 Policy、范围、强度、匹配到的规则、发送者在该 Source 的身份、该 Source 以什么方式收到 Trigger"。不可变；范围扩大要开新 Ticket；工单结束不等于凭证失效，只有人明确叫停或重新校验失败才收回。
- **Policy 版本化**：规则 + accept 模式 + 每个 Source 的白名单共同构成版本；Mandate 记录版本。版本变更会丢弃进行中的 Eval、给受影响的在途工单送 `policy-changed`，但**不会立刻吊销**（宁可在途工作跑完，也不制造半成品）。
- **Subscription 与授权分离**：工单可以订阅任意多个 Thread 收上下文，**订阅消息绕过 gate，但不授予任何新权限**；只有人的消息能唤醒已结束的工单（机器人/CI 消息不唤醒）。
- **"人"不是领域实体**：Trigger 带 Source 给的身份，跨 Source 的身份映射交给提示词里的团队知识——避免维护一张必然漂移的全局身份表。
- 文档里有一张 11 行的"被否决的概念"表，理由都是同一类判断（例如"一个 Thread 最多一个活跃 Ticket"、"从报告自由文本推断在等人"都被否决）。

### 2.3 授权（002）

Eval 分两层：**gate（代码）**判断谁可以、以什么强度；**assessment（模型）**判断"这段话算不算一个要被实现的请求"。

- 默认准入表（按接收范围分格）：名单内但没 @ → `inferred`；名单外但 @ 了 → **`ignore`**；名单外且没 @ → `ignore`。只有"名单内 + 明确点名"才是 explicit。
- accept 模式三档：`off` / **`observe`（默认）** / `auto`。`observe` 下评估照做，但结论只记为 "would accept"，**不真的开工**。
- 每个 Source 有自己的白名单/机器人名单/准入表；CI 这类无人发送者的行只提供一种格子。
- 接受时必须同时成立三件事（针对本项目、表达了实现具体改动的意图、方向已定到可做小范围本地改动），并且要把判断连同原文引用写进 `intent_evidence`——提示词明说这些是语义判断、不是 schema 提供的证明。
- 最终拒绝：Eval 超时两次重试后第三次 `unavailable`；策略变更/基于旧策略的决定也 `unavailable` 并立即按当前版本重排。
- 状态机变更只有三个操作能动 Mandate：accept 创建、人的 stop 收回、重新校验失败吊销。

### 2.4 执行（003）

- **Ticket 阶段表**：`person/delivery` → `person/answer` → `person/review` → `person/blocked|failed` → `working/queued` → `idle` → `working`，自上而下第一个匹配的算数；`person/*` 一律意味着"没有人的输入就走不下去"。
- **执行器**：每个 Ticket 一个 `worker-<ticket id>` Session 和一个独立目录；执行器 Session **不经过审批、以 operator 的系统账号跑命令**；前台命令 5 秒后转后台，好让下一步能收到新消息；轮末后台工作最多再跑 30 分钟，到点杀 job、转 waiting、报告写明杀了什么。
- 主 Session 用 `dsh-superagent-router`（只有路由工具，且禁止 sleep/长 timeout/长等待，避免挡住新请求）；执行器用 `dsh-superagent-worker`；worker 的 subagent 用 DSH `standard` preset。
- **并发槽**：配置的并发上限之外**额外留一个槽**给人继续已有工单，保证"人不会被新工作饿死"。
- **重启恢复**：运行中的 Assignment 以 "host restarted" 结束，新 Assignment 带恢复提示，要求执行器**先检查目录、git 历史和 GitHub 再决定是否重复外部动作**，按 Ticket 从旧到新处理。
- 合并策略不在宿主代码里，而在 **Delivery requirements 提示词**里（默认自动合并关，且默认要求用另一个账号的 CLI 开启，避免 GitHub 把合并记到 Agent 自己头上）。

### 2.5 提示词（004）

- 团队可改三段：**Communication**（何时说话、怎么说、GitHub 消息开头的自动 Agent 声明、review bot 名单）、**Ticket scope**（继续干 vs 带半成品停）、**Delivery requirements**（PR 证据、自动合并条件与行数阈值、commit 身份）；另可加团队技能。
- 内置部分可被覆盖，但**覆盖记录"基于哪一版默认"**；上游默认变化时面板标 **Default updated** 并排比较新旧默认。
- 分层优先级：工具/宿主强制的事实 > 内置与生成段 > 匹配规则的流程与沟通 > 团队段与团队技能 > 外部文本（消息/引用/文档，永远只是数据）。
- 一句关键边界：**改提示词只改模型读到什么，改不动 gate、Mandate、工具校验和账号边界——那些在代码里。**

### 2.6 面板（005）

六个页签（Overview/Source/Trigger/Eval/Execution/Settings）+ 三条原则：每个元素必须回答三个问题之一；标签说"在等谁、要什么"而不是内部状态码；健康状态不占空间。

### 2.7 架构（007）

- `Runtime` 是组合根（锁目录、开 Store、建组件、注册路由、跑 Setup），`Engine` 是唯一写 Trigger/Thread/Decision/Ticket/Assignment 的地方，内部拆成 `Intake` / `Evals` / `Tickets` / `Assignments` / `Replies` 五个部分。
- 端口：`Repositories`、`Policy`、`SourceScope`、`Assessor`、`Executor`、`Outbox`；Source 插件通过 `orchestrator` 服务 + `SourceHost`/`SourceContext` 接入，只拿自己 kind 的那份能力。
- 外部动作"先落盘、后执行"（effects + outbox + 回执），失败按 2s 起步翻倍到 1min（消息发送 5s 到 300s）重试；同一工单到同一对话的消息保序。
- 健康面板按责任分组（runtime/models/evals/assessment/launch/delivery/relay/notice/reply/worker/github/feishu/history/sync:<id>），连续失败 3 次才升级为系统问题。
- 模型面：主 Session 14 个 `orchestrator_*` 工具，执行器 6 个工具；读资源有固定分页/截断预算；消息经 DSH inbox 注入到 Session 的下一步。
- 持久化：SQLite（`orchestrator.sqlite`），schema 只增不减，新库启旧版会拒绝。
- 仓库自身：`src/core` 零宿主依赖（只 import Node 哈希），`src/sources` 不 import `src/app`，面板只 import 宿主类型 + 少量纯值模块。

## 3. 公开数字与外部评价

- 仓库是**研究原型**：216 文件、177 个 TS/TSX、65 个测试文件、文档约 186 KB、源码约 1.08 MB；README 明确"不是官方产品、可能仍有 bug、工程实践可能不一致"。
- 一篇二手解读给出的、明确标注为"厂商自报"的模拟数据：约 300 条消息 / 20 个请求、每种配置跑 5 次，super agent 中位 12.4 分钟、p95 15.7 分钟；传统单 Session + subagent 的 p95 是 29.5 分钟；去掉 direct-pass（订阅直达执行器）后路由器决策数 +30%、缓存 token 读取 +37%。这些数字只能当方向参考，不是可复现基准。
- 该解读同时提到文章里的"投机执行 / 异步 ReAct / watchdog"等想法；按仓库 README 的免责声明，其中一部分属于**文章的研究方向而非本原型已实现**，不要把文章当代码说明书。
- 外部批评集中在：单 commit 无演进史；5 小时 754 star 只是热度；安全边界在操作系统层（执行器不审批、用 operator 账号，靠独立账号/机器隔离）；"不确定就安静忽略"意味着漏判不可见；跨 Source 身份一致性靠提示词；规模上限未披露。

## 4. 与我们这边的关系

### 4.1 环境核对（本 checkout）

- 根版本 `0.2.1-rc.3`；原型的 `engines.dsh` 是 `^0.2.1-alpha.2`，semver 上覆盖。原型 `inject` 需要的宿主服务在我们的树里都有：`agents`、`sessionController`、`sessionPersistence`、`workspaceRegistry`、`permissionPresets`、`tools`、`systemPrompt`、`skills`、`webServer`、`llm`、`subprocess`、`settings`（`settings.configure` / `presetForSession` / `agents.roots()` 也都能检索到）。
- 它用到的包（`dsh-settings`、`dsh-workspace`、`dsh-agent-preset`、`dsh-permission-presets`、`dsh-subprocess`、`dsh-client-ui-sidebar`、`dsh-client-ui-workspace`、`dsh-host-webserver` 等）在本仓都有对应 workspace 包。
- 但它没有发布到 npm（`private: true`），要用只能 **vendor 进仓**（或作为独立 checkout 链接进 profile）。

### 4.2 结构错配：它不是 dafeiyu 语义下的 capability

dafeiyu 的 capability v2 契约是：`{ id, contractVersion: 2, label, description, enabledByDefault, create(runtime) → contribution }`，contribution 只能贡献 `scope` / `tools(agent)` / `promptSections(agent)` / `onAgentCreated` / `onTurnEnd` / `dispose`，开关只会撤销这些贡献。

super agent 的主体是：**自己的 Source 轮询循环、自己的 SQLite 状态、自己的 HTTP 路由、自己创建和恢复 DSH Session、改进程级 `PATH`/git 配置、要独立 profile 与端口**。这些都不是"模型面贡献"，dafeiyu 的开关管不到，也不该硬塞进去。

但两者可以这样合：

- **dafeiyu 负责能力列表与模型面开关**：给 super agent 一个 capability（`superagent`），它的 `create()` 启动/接管 Runtime，`contribution` 只贡献主 Session 的 `orchestrator_*` 工具与提示词段；`dispose()` 优雅停 Runtime（等价于它的 stop）。开关关掉 = 模型面上看不见这套工具、后台轮询也停。
- **super agent 自己的 host row** 负责其余一切（routes、store、sources、sessions、panel）。它和 dafeiyu 行一起挂；没有 dafeiyu 时它也可以单独跑（降级为"没有面板/工具"或"仍跑但模型面不可见"需要定）。

### 4.3 三种接法

| 方案 | 做法 | 优点 | 代价 |
| --- | --- | --- | --- |
| **A. 原样 vendor 成独立 profile 应用**（不碰 dafeiyu） | 把原型作为独立 bundle 包 vendor 进仓，按它的部署文档起独立 profile（独立端口/stateDir），dafeiyu 里只登记一个"外部能力"状态条目 | 改动最小、最忠于原型；它自己的面板/文档/测试可直接用 | 与"挂在现有 GUI 里"的目标不符；独立进程/profile、独立端口；两套 Agent 身份与模型配置 |
| **B. 在 dafeiyu 里重新实现一个能力化版本** | 新包 `packages/uitstalie/super-agent`，capability `superagent`：工单/授权/订阅的最小领域模型 + turn-end 驱动的 pass 循环；Source 先接 jira 账本（我们已有 jira-service 与 ledger），GitHub 后接；执行器先用 subagent（spawn/fork）而不是独立 DSH Session；状态放 `.dsh/super-agent/` | 完全贴合本分支的 capability/权限/测试体系；可增量；无进程级副作用 | 与原型差距大（没有独立 worker Session/目录、没有 HTTP 管理面、Feishu 不支持）；等于重写领域层 |
| **C. vendor 领域核心 + 能力化外壳**（推荐） | vendor 原型的 `src/core`（纯领域、零宿主依赖）+ `src/app` 的 Store/Effects/Outbox 等无 HTTP 部分；用 dafeiyu capability 包一层：`create()` 启动一个精简 Runtime（sources 换成我们的 provider，executor 先用 subagent，面板暂不移植），贡献 `orchestrator_*` 工具与提示词；后续再把原型的 panel/HTTP 作为独立 client 插件接进来 | 领域规则（Mandate/Policy/Eval/Stage/恢复语义）直接复用，风险最高、最容易写错的部分不重写；外壳贴合本分支 | 需要裁剪原型的 app 层依赖（webServer/sessionController/permissionPresets 等），并定义"执行器 = subagent"与原型"执行器 = 独立 Session"的语义差异；需要 vendor + 适配 + 测试三块工作 |

### 4.4 必须先定的问题（给用户）

1. **定位**：要的是"在我们现在这个 GUI/会话里多一个能力"，还是"另起一个常驻服务（独立 profile、独立端口）"？前者只能走 B/C，后者 A 最省。
2. **事件源**：第一版接哪个？jira 账本（我们已有、闭环最短）、GitHub（原型的主场景）、还是飞书？原型默认单 GitHub 仓库。
3. **执行器**：沿用原型的"每 Ticket 一个独立 DSH Session + 目录"（更强、更贵、要动 Session 预设），还是先落到 subagent（便宜、好接、但缺"独立目录/长跑恢复"的语义）？
4. **安全边界**：原型执行器不审批、用 operator 账号。我们分支有 approval/sandbox 体系，第一版是否强制走审批（会牺牲"无人值守"体验），以及是否接受"Agent 用独立 GitHub 账号"这一前提。
5. **面板**：第一版是否要 Web 面板？如果要，是移植原型的 React 面板（工作量大，需适配我们的 client 插件规范），还是先只做能力列表里的一行状态 + 少量只读视图。

## 5. 建议的下一步

先按 **C** 的方向做一次"最小可跑"的可行性验证（不改现有行为）：

1. vendor 原型的 `src/core` 与 `docs/` 到分支新包（MIT，保留声明），跑通它的纯领域测试；
2. 写一个 dafeiyu capability 外壳：`create()` 里只做"读配置 → 建内存 Store → 注册 `orchestrator_read`/`orchestrator_route`/`orchestrator_report` 三个工具 + 一段提示词"，turn-end 时跑一次 pass；
3. Source 先接 jira 账本（读未完成 issue、评论），执行器先用 subagent 跑一个真实小任务，验证"接受 → 工单 → 执行 → 交付 → 人回复 → 复活"这条闭环；
4. 闭环跑通后，再决定要不要把原型的面板、HTTP API、独立 Session 执行器逐块移植。

验收这一轮只要求：能力可在 dafeiyu 列表里开关、开关能停掉模型面与后台 pass、闭环在测试里可重复、且不改变现有能力的任何行为。
