# Super agent 调研：概念、原型与我们这边能怎么接

本文件是"把 super agent 整合进 dafeiyu"这项工作的调研底稿。结论先放最前面：**super agent 不是一个"能力"，而是一台常驻的、带授权模型的异步工作机**——它可以作为 dafeiyu 的一个 capability 出现在能力列表里，但它的主体（Source 轮询、Ticket 生命周期、执行器 Session、面板、状态库）必须由它自己的 host 插件承担，dafeiyu 只负责"开关 + 模型面"。

调研时间：2026-11-01。代码与文档取自 `deepseek-ai/dsh-superagent-prototype`（MIT，2026-10-31 09:32 UTC 建仓，当日 12:05 UTC 唯一一次推送；截至调研时 4401 star / 406 fork / 0 open issue / 216 文件）。

## 0. 目的拆解：它想解决的问题

### 0.1 自述的目的

README 的三句话就是目的陈述，其余都是推论：

1. "a proactive coding agent for one GitHub repository"——**从被动变成常驻**；
2. "An agent that can act for a whole team can also waste a whole team's attention"——**能力放大，成本同倍放大**，这是全部设计的出发点；
3. "Take as little human attention as possible, and give as much value as possible"——判据是**价值／注意力**这个比值，不是能力上限。

所以目的不是"把 agent 做得更强"，而是：**在不增加人类注意力负担的前提下，把一个 agent 的服务半径从一个会话里的一个人，扩到一支团队和一台常驻机器**。能力是手段，半径和成本才是命题。

一句话概括这个矛盾：agent 的价值随"能接多少活"增长，注意力成本随"说多少话"增长，而传统做法把两条曲线都压在同一个人身上。原型的全部设计，就是把第二条曲线从人身上挪到系统身上（授权模型、工单生命周期、恢复协议、面板纪律），人只保留"批准"和"回答"两处最小介入。

### 0.2 五个层次

一个 agent 要从"你打字我干活"变成"替团队常驻接活"，必须依次回答五个新问题。层次**从外到内，且后者依赖前者**：没有入口就无所谓授权，没有授权就谈不上无人值守的执行。原型 `docs/` 按 000→008 编号、声明"每篇只依赖前面已引入的概念"，就是这层顺序的体现。

| 层 | 要解决的问题 | 同步对话里为什么不需要解决 | 原型的回答 |
| --- | --- | --- | --- |
| **1 入口** | 请求从哪来：事件是并发的、异步的、常常没有人在线上；同一件事会在多个通道重复出现，需要收敛成一个请求 | 请求永远是"当前会话里的下一句话"，来源唯一、时机由人控制 | Source / Trigger / Thread / Correlation（跨 Thread 关联，只加证据不改路由）+ 批量 Eval |
| **2 授权** | 凭什么做、做到哪、按哪版规则：同意发生时人不在场，没人能当场确认 | 人发指令即同意，模型每一步还能再问一句；会话结束等于同意作废 | gate（代码判谁/多强）+ assessment（模型判这算不算请求）+ Mandate（把一次同意固化成凭证）+ Policy 版本化 |
| **3 执行** | 一件活怎么活过一轮对话、一个进程、一次重启、和人睡觉的时间；且对外副作用不能重复 | 一轮对话内干完；干不完人再补一句；"持久"根本不存在 | Ticket 阶段机 + 每 Ticket 独立 Session/目录 + Assignment 接力 + 恢复协议 + 先落盘后执行 + 30 分钟后台上限 + 额外一个人工槽 |
| **4 注意力** | 什么时候可以说话：产出通道本身就是成本，能力放大 N 倍，噪音也放大 N 倍 | 人只看自己问的那一个回答，噪音被会话边界天然隔离 | 默认 `observe`（只记录不执行）、默认沉默、一次一个问题、按影响面停、诚实报告、面板只列需要人的 |
| **5 运营** | 三个月后还讲不讲理：模型换版、prompt 被改、规则升级、账号变化、schema 演进，每件都不当场崩，但会慢慢变成"没人知道它为什么这么做" | 不需要——会话是一次性的，人记不住也没关系 | prompt 分层 + 覆盖记录"基于哪版默认" + `Default updated` 并排比较 + 健康面板按责任分组 + schema 只增 + 决策留 reason code |

每层都有一个"不做会怎样"，而且**层的价值是递减可见的**：

- 缺第 1 层：agent 只能响应正在打字的人，谈不上替团队；
- 缺第 2 层：只剩两个坏选项——永远等确认（退化成聊天），或凭模型自觉（无人可审计）；
- 缺第 3 层：一重启全丢，或重复提 PR；
- 缺第 4 层：技术上跑得动，但团队会把它关掉——**这是最常见的死法**；
- 缺第 5 层：不敢改、不敢信，最后停用。

这个排序还有一层含义：**第 1、3 层是"看得见的能力"，第 2、4、5 层是"看不见的约束"**。外部热度集中在第 1 层（proactive），外部批评集中在第 2、4 层（安全边界在操作系统层；"不确定就安静忽略"意味着漏判不可见）。这个不对称对我们是个警告：只抄看得见的层，得到的是一个会自己干活、但没人能审计的东西——比不做更危险。

### 0.3 第二个轴：时间尺度

层次是"问题空间"，时间尺度是"机制空间"。三种尺度不能共用一套机制：

| 尺度 | 要回答的问题 | 机制 | 混用的典型错误 |
| --- | --- | --- | --- |
| 秒级 | 这一批新事件要不要接 | Eval（gate + assessment） | 用长期规则代替逐次判断：要么什么都接，要么什么都拒 |
| 分钟–小时 | 这件活干到哪、下一步该谁 | Ticket 阶段 / Assignment | 用一次对话解决几小时的活：干到一半丢状态 |
| 天–周 | 规则、身份、默认值漂移了怎么办 | Policy 版本 / prompt 覆盖 / 健康面板 | 用秒级判断补长期漂移：每次都要人重新解释规则 |

### 0.4 第三个轴：谁承担判断

每个问题最终必须落在三种执行者之一，**落错位置就是一个注定的 bug**：

- "这段文字算不算一个要被实现的请求"——只有**模型**能做（语义判断），所以原型强制把判断连同原文引用写进 `intent_evidence`，因为它不可复现；
- "谁可以、以什么强度、在不在白名单"——只有**代码**能做，否则模型能自我放宽；这也是"改提示词改不动 gate、Mandate、工具校验和账号边界"那句话的真实含义；
- "做过什么、为什么、什么时候结束"——只有**持久化**能做，靠模型记忆等于每重启一次编一次。

三种典型落错：**用 prompt 实现授权**（不可审计）、**用代码实现语义判断**（做不到，只能退化成关键词或正则）、**用模型记忆代替 store**（不可恢复）。

### 0.5 它明确不解决什么

拆目的时这一节和上面同样重要，因为它划出"我们不必跟着做"的范围：

- 不提高单任务的模型质量（那是模型的事）；
- 不做多 agent 协商或编排（没有 agent 间协议；subagent 只是执行手段）；
- 不做通用平台/SDK（一个 GitHub 仓库、一支团队、单一 GitHub Source）；
- 云端共享与交付一律走 GitHub（仓库、PR、issue）；不接 IM 或其它云端通道；
- 不替人做决定——几乎全部设计都在定义"停在哪、问什么、问到什么粒度"；
- 不降低部署成本：执行器不审批、以 operator 系统账号跑，等于**把安全成本转嫁给部署方**，靠独立账号/独立机器隔离。

### 0.6 对我们意味着什么

把目的拆到这一层，"怎么整合"就不再是"接 GitHub 还是接 jira"的问题了。真正的结论是：

- **本质只有两层：入口（1）与授权（2）。** 第 3 层的机器我们平台已有大半（Session、持久化、重启恢复、沙箱、审批、subagent）；第 4 层是纪律而非代码，可以直接借它的行为规范；第 5 层是时间问题，急不来。
- **我们缺的恰恰是那两层。** 平台没有"人不在场也能开出一件活"的通用入口（现有驱动力是人的话轮，或 capability 的 `onTurnEnd`）；审批是**逐动作、同步、绑定在场的活人**的——没有"跨会话、跨重启、模型自己无法扩大"的授权凭证。所以两个真问题不是"接哪个源"，而是：**我们的 Trigger 从哪来，我们的 Mandate 长什么样。**

## 1. 这个词指的是什么

DeepSeek Harness Team 在开源原型的同时发了一篇设计文章 *Exploring Super-agent Design: Towards a More Autonomous Agent System*（文章本身没有公开的独立链接，仓库 README 与 `docs/` 是它的落地版本；[README](https://github.com/deepseek-ai/dsh-superagent-prototype) 明确说明"文章里的部分设计是未来方向、原型未实现"，且公开版与内部版并不逐字相同）。

它给出的定义不是"更强的单体 Agent"，而是**一个替整个团队接活、并且按注意力成本自我约束的 Agent 系统**：

- 一个常驻 Agent 同时面对 GitHub 通知/Issue/PR/CI 等多个事件源；
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
| **B. 在 dafeiyu 里重新实现一个能力化版本** | 新包 `packages/uitstalie/super-agent`，capability `superagent`：工单/授权/订阅的最小领域模型 + turn-end 驱动的 pass 循环；Source 先接 jira 账本（我们已有 jira-service 与 ledger），GitHub 后接；执行器先用 subagent（spawn/fork）而不是独立 DSH Session；状态放 `.dsh/super-agent/` | 完全贴合本分支的 capability/权限/测试体系；可增量；无进程级副作用 | 与原型差距大（没有独立 worker Session/目录、没有 HTTP 管理面、不支持多 Source）；等于重写领域层 |
| **C. vendor 领域核心 + 能力化外壳**（推荐） | vendor 原型的 `src/core`（纯领域、零宿主依赖）+ `src/app` 的 Store/Effects/Outbox 等无 HTTP 部分；用 dafeiyu capability 包一层：`create()` 启动一个精简 Runtime（sources 换成我们的 provider，executor 先用 subagent，面板暂不移植），贡献 `orchestrator_*` 工具与提示词；后续再把原型的 panel/HTTP 作为独立 client 插件接进来 | 领域规则（Mandate/Policy/Eval/Stage/恢复语义）直接复用，风险最高、最容易写错的部分不重写；外壳贴合本分支 | 需要裁剪原型的 app 层依赖（webServer/sessionController/permissionPresets 等），并定义"执行器 = subagent"与原型"执行器 = 独立 Session"的语义差异；需要 vendor + 适配 + 测试三块工作 |

### 4.4 必须先定的问题（给用户）

1. **定位**：要的是"在我们现在这个 GUI/会话里多一个能力"，还是"另起一个常驻服务（独立 profile、独立端口）"？前者只能走 B/C，后者 A 最省。
2. **事件源**：第一版接哪个？jira 账本（我们已有、闭环最短），还是 GitHub（原型的主场景）？原型默认单 GitHub 仓库。
3. **执行器**：沿用原型的"每 Ticket 一个独立 DSH Session + 目录"（更强、更贵、要动 Session 预设），还是先落到 subagent（便宜、好接、但缺"独立目录/长跑恢复"的语义）？
4. **安全边界**：原型执行器不审批、用 operator 账号。我们分支有 approval/sandbox 体系，第一版是否强制走审批（会牺牲"无人值守"体验），以及是否接受"Agent 用独立 GitHub 账号"这一前提。
5. **面板**：第一版是否要 Web 面板？如果要，是移植原型的 React 面板（工作量大，需适配我们的 client 插件规范），还是先只做能力列表里的一行状态 + 少量只读视图。

### 4.5 账本（jira）已经解决到哪一层

对照 §0.2 的五层，账本已经把"记录"和"协作"做得相当完整，缺的恰好是"驱动"和"凭证"：

| 层 | 账本已有的 | 仍然缺的 | 依据 |
| --- | --- | --- | --- |
| 1 入口 | 事件在账本里是**结构化**的（新建 / 改状态 / 评论 / assignee）；评论 append-only 且 `merge=union`，多机追加零冲突 | **没有轮询者，也没有推送**：账本自述"是记录，不是调度器"，注入的只有一行"存储存在且可读" | `DESIGN.md` §6.4 |
| 2 授权 | 写权限按 project 挂 `agent_write_policy`（跨机只读 + 类型化错误）；状态机只接受声明的流转；CAS `revision`；`assignee` + 2h 租约 | 没有**范围与强度**，没有"按哪版规则批准"的不可变凭证；租约被明确声明为 advisory（"不要把 assignee 当互斥锁"） | §4.7 / §4.8 / §4.11 |
| 3 执行 | 记录本身活过会话、进程、机器：git 当审计、每机 `sessions/`/`machines/`、离线块分配 key | 没有执行器、没有"被重启打断"的事实、没有后台时限与恢复协议；时间性等待被明确拒绝落字段 | §4.5 / §5 |
| 4 注意力 | 已有同一套注意力哲学：看板、`in_review` = 等人确认、关闭必填 `resolution`、健康不占位 | 只有**拉**没有**推**：没有"现在需要你"的通道 | `config.md` / §7.3 |
| 5 运营 | 比原型更强：git 历史、`git revert` 即撤销、schema 只增、真冲突按字段性质裁决并打 `conflicted` | — | §5 / §4.13 |

两个后果：

1. **坏消息：账本天生是"拉"的。** 推送防抖 + 会话结束推、pull 只在会话启动或显式 sync，跨机是"最终一致 + 人工裁决"而不是队列；离线独立实例只出差异报告、不自动合并。想让它"自己接活"，缺的不是源，是**没有会话也在跑的轮询者**，以及"两台机器都想跑循环时谁算数"的租约。
2. **好消息：可能不需要造那台 daemon。** 账本 §1 的四条价值里第 2 条写的是"**工作队列**——人可预先排入工作，agent 下次开工自行领取"，但至今没有机制实现它（"自行领取"一直是人在指派）。把它做实，就是 super agent 第 1 层的最小形态：**会话启动（或每个 turn 结束）时从账本领一件 ready 的活，并带着一张不可扩大的 Grant 记录**。

所以第一版要写的只有两样，都不大：**一个最小调度（谁在什么时候领哪条）+ 一张 Grant（谁批的、批到哪、按哪版规则）**。原型值得 vendor 的正是第二样的语义（Mandate 的不可变、Policy 版本化导致"在途不吊销"），而不是它的 Source、面板或执行器。

## 5. 建议的下一步

按 §4.5 的结论，第一版不再是"vendor 原型跑闭环"，而是**把账本已经承诺的第 2 条价值做实**，且不引入常驻进程：

1. **最小调度**：由会话启动或 capability 的 turn-end 触发一次 pass——扫账本里 `status: todo`、无 `is_blocked_by`、无活跃 `assignee` 的条目，按 priority 与更新时间排出一条并认领（`assignee: self` + 租约），而不是等人指派。第一版允许"一个会话只跑一次"，不追求秒级。
2. **Grant 凭证**：认领时写一条**不可扩大**的授权记录——批的是哪条、范围（可动哪些路径/哪些动作）、强度（只读 / 可改 / 可开 PR）、按哪版规则、发送者身份。语义取自 `docs/002` 的 Mandate，形态用账本已有的"评论 + 提交"（git 保证改不动历史）。
3. **执行器**：先用 subagent，不引入独立 Session/目录；验收点是"它自己领到了活，且能说清凭什么领"。
4. 面板、独立 Session 执行器、以及 vendor 原型的 `src/core` 继续后置——只在确认这条闭环有价值后再做。

验收这一轮只要求：能在账本里看到"它是自己领的、凭哪条 Grant 领的"；重复/并发认领有明确行为（要么靠租约挡住，要么接受重复并证明幂等）；不改变现有能力的任何行为。

## 6. 第一阶段形态：super workspace + 账本

阶段一思路（用户提出）：保留 workspace 概念；super agent 属于一个特殊的"超级 workspace"，它可以创建实体 workspace（与用户协商路径）、指挥 subagent 或派遣具体 agent 到对应 workspace 工作，自身是全局调度器与经验共享器；工作与知识继续依赖 jira 插件。

这条思路成立，因为三份状态正好正交：

| 真相源 | 只放 | 不放 |
| --- | --- | --- |
| `workspaceRegistry` | 目录、标题、会话归属 | 工作内容 |
| jira 账本 | issue / 状态 / 认领 / Grant / 知识（KB） | 会话归属、目录 |
| super workspace 自己的目录 | 编排状态（最近一次 pass、Grant 索引、租约） | 工作内容（避免第三份状态） |

关联键只有一个：`issue key ↔ workspace id`。

### 6.1 从实际 API 读出来的硬事实

- `workspaceRegistry.create(path, title?)` 要求**目录已存在**并走 `fs.realpath`；相对路径、不存在、非目录一律拒绝，它不负责建目录。→ "虚拟 workspace"只能是"一个不是代码项目的真实目录"。
- 身份是 **canonical path**，不是标题：同路径重复 create 返回已有实体且**不改标题**；不同路径可以同名。→ 协商路径就是协商身份，改路径 = 新 workspace。
- **会话归属由 cwd 决定**：`attachSession` 校验 `header.cwd === workspace.path`，不符报 `its cwd resolves to …`。→ "派遣到 workspace X"必须在**启动时**用 `cwd = X` 决定，不能事后挪。
- `status(): 'ok' | 'missing-dir'` 已存在 → 目录被删/移走可检测，健康检查白送。
- 全仓没有 `workspace_*` 工具 → 建 workspace 目前只能走 UI；要让 agent 做，必须新加工具（正是 capability 该贡献的）。

### 6.2 两种"派遣"不是一回事

| | `subagent(cwd: X)` | 真实 Session（cwd: X） |
| --- | --- | --- |
| 成本 | 低，一次性 | 高：要预设、并发槽、生命周期 |
| 可见性 | 不占 workspace 会话列表，事后不可追溯 | 出现在 workspace 里，可恢复、可接管 |
| 失败 | 静默消失 | 可记录"被重启打断" |

第一版用 subagent，并用账本补足可追溯性：派谁、去哪个 workspace、改了什么，全部回写 issue 评论。

### 6.3 "经验共享"不造新机制

账本已有 `knowledge/<domain>/KB-*.md` + `kb_refs[]` 双向引用 + 来源指纹（machine/os/tool/captured_at/source_sha256）。所以经验共享 = 两个已有动作被编排进流程：**领活前 `jira_kb search`，交付时写/补 KB 并 `kb_refs` 挂回 issue**。这属于 §0.3 的"周级"尺度。

### 6.4 阶段一的四件东西

1. 一个固定路径的 super workspace 登记进 registry。建议放 `%DSH_HOME%` 下，不进任何代码仓：不进 git、不会被误当项目、也不会和"被派遣的 workspace"混。
2. capability 贡献三件表面：`superagent_scan`（读：可领候选与原因）、`superagent_claim`（写：`propose`/`claim`，`claim` 返回 `dispatch { key, cwd, instruction }`）、`superagent_workspace`（读 `roster` / 写 `ensure`）。派活本身不需要专工具：拿到 `dispatch` 后模型用自带的 `subagent(cwd)` 起执行者。
3. **Grant 记录落在账本**：谁批的、哪个 path、允许什么动作、按哪版规则。它天然产生在一个人类介入点上（协商路径），所以第一版不需要额外的授权 UI。
4. 领活仍由"会话内动作 / turn-end 一次 pass"触发，**不引入常驻轮询**；真 Session 执行器、面板、vendor 原型 `src/core` 继续后置。

验收：workspace 列表里能看到 super workspace；能建一个真实 workspace 并拿到 Grant；能派一个 subagent 进去改文件，且在 issue 上留下"谁派的、哪个 workspace、改了什么"。

## 7. 认领闭环：三道人类门，全部落在既有原语上

结论（用户裁定）：第一阶段就要"**自己领活**"，但需要人**确认**与**复核**。这两道门几乎不需要新机制——账本里已经有现成落点：

- `todo → in_progress`：2026-10-19 起**没有** todo→closed，理由原话是"否则'谁做的'在审计上说不清"；
- `in_review`：原话是"**等人确认**——agent 认为做完了，但结论要人点头"；
- `assignee: self` + 租约 + `is_blocked_by`（对 agent 显式拒绝认领，除非 override 并写评论）；
- CAS `expected_revision`（两人同时确认，第二个拿 `STALE_REVISION`，绝不静默覆盖）；
- **commit ⇄ issue 绑定已实现**（`jira verify-commit-msg` / `jira hooks install` / 分支名 `KEY-…` 自动前缀 / `[no-issue]` 显式旁路 / CI 查全 range）。

闭环：

```
pass 扫描 → 候选（只读，不动账本）
   ↓ 提案：issue 上留一条评论（would claim + 理由 + 证据原文 + 范围 + 强度）
[门 1：人确认]        ← 唯一能动 assignee 的路径
   ↓ assignee: self（expected_revision）+ switch_state → in_progress
派活：subagent(cwd = workspace) 改代码 / 跑测试，只返回报告
   ↓ 父会话写：comment（改了什么、哪个 workspace、怎么验证）+ switch_state → in_review
[门 2：人复核]        → closed + fixed / 打回 in_progress
```

**已落地**（DH-512 / DH-513 / DH-514，提交 `5b19fbc99b` / `271dc5a708` / `a9e74d5236` + `3ad9b9e4be`；执行者边界、派遣记录与人类确认于 2026-11-03 按复审补全）：两端都在 `jira-agent` 里，各开各的能力门。

- 执行者端 `issue_work`：授权是**派遣记录绑定**，不是父会话——`[dispatch:session] <session>` 在首个 prompt 之前写进 issue，`issue_work` 要求调用者的 Session 就是最新记录里的那个；`deliver` 一次事务完成"交回复审 + 证据"；`blocked` 只留 `[blocked:person|dependency]` 标记，不造状态。子 agent 与执行者会话都另有三个账本读工具与一段常驻 `jira:executor` 说明；执行者会话被 `describeCaller` 判为 `writable: false, reason: 'executor'`，普通 `jira_issue` 写在 guard 层被拒，turn-end 也不再提案。
- 调度端 `superagent_scan` / `superagent_claim`：提案是 `[claim-proposal]` 评论；`claim` 要求 issue 的**最新一条评论是人类作者（`human:`）的 `[claim-approved]`**，状态迁移随后花掉这条凭据。`claim` 返回 `dispatch { key, cwd, instruction }`。
- 派遣记录带生命周期：`starting → started / failed`；记录先于 prompt 落地，写失败就不启动；重启后的 `recover` 以记录里的 Session 与 `running` 状态决定是否重派。
- `superagent_workspace`：`roster` / `ensure`，`ensure` 返回 canonical path 供派遣当 `cwd`；`workspaceRegistry` 走鸭子类型，缺席时如实拒绝。
- **worker preset 行已落地**（`jira-worker`，order 5）：只放执行者需要的 shell / 文件 / 后台 job / compaction，不放 delegation、goal、planning 与 `ask_user_question`；`SessionHeader.agentPreset` 是执行者的身份来源。
- **GitHub source 已落地**（只读 `gh issue list`，未配置 repo 时可读拒绝）；**进程级定时 pass 已落地**（unref timer，随 dispose 清除）；**无会话 daemon 已落地**（DH-714：合成 dispatcher 身份，无 writable 会话时提案，确认后自己 claim + dispatch，默认关闭）。
- **仍未做**：vendor 原型 `src/core`。多 Source 不做（用户裁定只做 GitHub，决策 207），不在本分支待办里。

（门 0 是 §6.4 的 `workspace_ensure`：人协商路径，同时产生 Grant。）

### 7.1 三条已核实的约束，会改写实现细节

1. **subagent 对账本只读**（决策 89/93/96，由 `ctx.tools.guard` 在工具层拦截）。所以派出去的执行者**不能自己写账本**——父会话是唯一写者。这反而是对的：执行者只产出"代码 + 报告"，记录只由调度器写，不会出现两份账。
2. **复核可以自动挂靠**：目标 workspace 装了 `jira hooks`、分支名带 key，则每次提交自动绑定 issue，复核就是 `git log --grep <KEY>` + issue 评论，不用人肉对 diff。所以 `workspace_ensure` 应顺带 `jira hooks install`（幂等，会备份并链式调用已有 hook）——但它**改的是用户的仓库**，必须算进门 0 的确认。
3. **被阻塞的不能进提案**：`is_blocked_by` 未关闭时 `assignee: self` 会被拒（`jira_list` 也把 blocked 单独成组）。扫描阶段就过滤，别让它出现在候选里。

### 7.2 唯一待定：确认落在哪

| | 会话里问一句 | 账本里留一条待确认 |
| --- | --- | --- |
| 成本 | 最低 | 一次写 |
| 存活 | 跟会话，会话没了就没了 | 跨会话、跨机器、可批量 |
| 适合 | 人在场、立刻决定 | 人不在场时先积累，回来一次批完 |

建议**两者是同一件事的两半**：提案始终写进账本（成本一条评论），会话里只是顺带问一句以加速。人不在，提案留在账本等下次 pass；人在，一句话批完。不需要面板、不需要常驻进程，也不会把"它想做什么"丢在聊天记录里。

落地取"账本里留一条"：人类确认是 **`human:` 作者、以 `[claim-approved]` 开头的评论**，模型无法伪造（决策 210）；`claim` 只在这条评论是 issue 最新评论时执行，状态迁移随后花掉它。

驳回也要留痕（否则"漏判不可见"，这是原型被公开批评的点之一）：驳回 = 一条 `declined` 评论 + 理由，同一 issue 在一个时间窗内不再重复提案。

### 7.3 pass 的触发与节流

会话启动 + turn-end 各跑一次；**每轮最多一条提案**；当前会话已有未完成的工作就不提案（不打断，对应原型的"默认沉默"）。

## 8. 执行者的表面：一个"解单流程"工具，而不是放宽 `jira_issue`

先纠正一个事实：**账本工具没有"删除 issue"这个动作**。`jira_issue` 的 action 只有 `get / create / update / switch_state / comment / assignee / link / tag_create / close / batch_close`，`WRITE_ACTIONS` 是"除 get 之外的全部"。所以"只读"挡掉的真正风险不是删单，而是 `update`（改别人写的 summary/description）、`close` / `batch_close`（把不该关的关掉）、`create` / `tag_create`（造垃圾单和垃圾 tag）——这三类确实都不该给执行者。

但"只读"把 `comment` 和 `switch_state` 也一起挡了，而这两件恰恰是解单必需的。结论：**不放宽 `jira_issue`，给执行者换一个更窄的工具**。

### 8.1 子代理能不能指定工具：能，两条路

1. **agent preset（收窄"看得见什么"）**：`tool-subagent` 支持 `agent_preset` —— 配置里 `agentPreset` 强制指定，或 `allowedAgentPresets` 暴露给模型选。"The selected preset owns persona and tool composition." 两个限制：**只有 `spawn` provider 支持独立 preset**（`fork` 会直接报 `does not support independent agent preset selection`）；preset 只管可见面。
2. **工具层授权（收窄"写得了什么"）**：`installWriteGuard` 是**单调拦截点**，只认 `jira_issue`，所以它挡不到一个新工具；新工具的可写面必须由它自己的 scope check 决定，而不是把 `writable: boolean` 扩成能力集。

**实现结果**（DH-512，提交 `5b19fbc99b`；2026-11-03 复审后修正授权）：只做了第 2 条的 scope check，**没动 guard 的语义边界，也没把执行者做成可写 root**——能力的 scope 由 `root` 改成 `all` 并按 agent 分流：root 拿完整工具，子 agent / 执行者只拿读工具 + `issue_work`。授权 = issue 的最新 `[dispatch:session]` 记录里的 Session 等于调用者的 `SessionHeader`；拒绝复用 `READ_ONLY_SESSION`，`reason` 说清是哪一种。执行者会话的 `writable` 为 false（`reason: 'executor'`），普通写由 guard 拒绝。

### 8.2 解单流程的三个动词

新工具 `issue_work`（能力在子 agent 上只挂这一个工具），动作空间封闭：

| 动词 | 参数 | 账本上发生什么 |
| --- | --- | --- |
| `progress` | `body` | 追加一条评论 |
| `deliver` | `body`（证据：改了什么、怎么验证） | 评论 + `switch_state → in_review`，一次提交 |
| `blocked` | `waiting_for: 'person' \| 'dependency'`、`reason` | 评论 + 结构化标记 |

`deliver` 不是两次写：它复用决策 193 的复合（`close` 动词带 `to: 'in_review'` + `comment`），迁移与证据在同一个事务里，不会只落一半。

三个理由：

- **权限按流程切比按工具切安全**：动作空间封闭在三个动词里，**没有** update/create/close 的能力，也就不需要"维护一张允许清单再防绕过"。
- **模型看到的工具表就是流程本身**：worker preset 里只有读工具 + `issue_work`（原型正是这么做的：worker 6 个工具 vs router 14 个）。
- **结构化在调用处，不在正文里**：`blocked` 的 `waiting_for` 是 schema 参数，不需要父会话从自由文本里猜。原型否掉"从报告自由文本推断在等人"，理由正是这个。

`blocked` 不设状态：账本的约定是"被阻塞不是状态，是 link"，而 link 由父会话决定——执行者只报告事实。执行者也**不能直接找人**：那等于绕过调度器，而"一次只问一个问题"必须由父会话统一持有。

### 8.3 落在哪个包

落在 **jira 侧**（新工具 + guard 扩成能力集），不放在 super-agent 侧。理由：它本质是账本写操作的收窄，复用身份（`agent:model|dsh|machine|session`）、提交、批次与 guard；放另一边则要把账本语义复制第二份。代价是 jira 包多认识一个"受限写者"角色——但它已经认识"只读会话"和"子代理"了，这是延续不是新概念。

## 9. 阶段一决定与实现状态（2026/11/01）

**决定：选方案 B（在 dafeiyu 里做最小能力化版本），A/C 后置。** 理由：

- 当前实现已经证明账本的"拉"可以补成"提案 + 人确认 + 认领"，不需要常驻进程、独立 profile 或新端口；
- 原型的核心价值（Mandate/Policy 语义）在第一版只需要"一条不可扩大的 Grant 记录"，账本的评论 + git 历史已经能承担，先不 vendor 一个单 commit 的研究原型；
- 方案 C 的 vendor 成本主要花在原型 app 层（webServer/sessionController/panel）的适配上，这部分正是第一版不需要的；等闭环被验证有价值后再做。

**阶段一已落地**：

- 独立 dafeiyu 能力 `superagent`（`enabledByDefault: false`），root 六个工具（scan / claim / dispatch / workspace / status / source），子 agent 与执行者只带读工具 + `issue_work`；
- 认领闭环：提案 → **人类 `[claim-approved]` 评论** → claim → 派遣（真实 Session，`jira-worker` preset）→ 执行者 `issue_work` `deliver` 回 `in_review`；
- **派遣记录**：`[dispatch:session] <session> starting|started|failed` 先于 prompt 落地，recover 按记录与 running 状态决定重派；
- **turn-end pass**：先恢复丢失的执行者，再以 observe 模式提案第一条 ready 的 issue，只写一条 `[claim-proposal]` 评论，永不自行认领；执行者会话跳过该 pass；
- **`superagent_status`**：只读汇总 ready / proposed / in-progress / in-review / blocked，并列出需要人确认或复核的条目；`ui-jira` 的 Superagent 面板消费同一份只读数据，并提供唯一的人类动作——确认提案（写与 CLI 相同的 `human:` `[claim-approved]` 评论，DH-713）；
- **进程级定时 pass**：能力启用时每 5 分钟跑一次；timer 是 unref 的，随 dispose 清除；有 writable 会话时由该会话的 pass 提案（它的提案可由它自己认领），没有会话时交给无会话 daemon（下一条）；
- **无会话 daemon**（DH-714，默认关闭）：配置 `superagent_daemon` + `superagent_daemon_workspace` 后，定时器在没有 writable 会话时以 `agent:daemon|dsh|<machine>|superagent-daemon` 提案；人类确认后同一身份 claim + dispatch（决策 210 要求提案人 = 认领人），并先 `recover` 自己丢失的执行者。缺少 workspace、worker preset 或 session controller 时完全惰性，不写任何东西；
- **GitHub 导入**（只读）与 **重启恢复** 均已落地；
- 测试覆盖纯谓词、工具面与**真实装配**的完整闭环：`packages/jira/tests/superagent-real-loop.spec.ts` 用真实的 `SessionController` 与 AgentLoop 派遣执行者（只有模型是脚本化的），覆盖提案 → 人类确认 → 认领 → 派遣 → 执行者 `issue_work` 交付 → `in_review`，以及执行者身份/工具面、guard 拒写、派遣记录 `starting → started` 与空闲执行者的 `recover`；pass 的"只提一次"等其余语义由单测覆盖。

**仍未做（有意后置）**：vendor 原型 `src/core`。多 Source 不做（用户裁定只做 GitHub，决策 207）；无会话 daemon 已落地但默认关闭（DH-714）；这些在闭环价值被验证后再开；不阻塞阶段一验收。

**对 dafeiyu 的结论**：super agent 适合拆成"能力列表里的一行 + 自己的 host row"，但不适合把整台异步机器塞进 capability contribution。第一版把它收在 jira-agent 的同一 row 里，用独立 capability id 门控，是 B 的最小形态；若后续要独立 host row，`superagent` 这个 id/工具面可以原样迁出。

## 10. 阶段二：超级 workspace + 派遣（2026/11/04，DH-716）

**目标形态（用户）**：人只跟超级 workspace 里的 agent 对话；具体活儿由它派子 agent 到各个 workspace 去做（调研、写代码、写文档、杂活都算）；人能看见被创建的工作区，并保留与这些执行者对话、控制它们的能力（对齐现在每个 workspace agent 的 subagent 体验）。

**第一步已落地**（决策 213）：

- 配置 `superagent_home`（jira-agent 行）；挂载时 `mkdir` + `workspaceRegistry.create` 登记一次，超级 workspace 因此出现在 workspace 列表里、可被打开，不引入第二份状态；
- **身份 = cwd**：会话的 `SessionHeader.cwd` 落在超级 workspace 就是超级 agent，不需要每次选预设；从这里派出去的子 agent 跑在目标目录，不会被误判；
- 超级 agent 的账本工具表只剩 `superagent_workspace`（roster / ensure），claim / dispatch / source 被移除，turn-end 也不再提案——它派遣，不跑账本闭环；
- 常驻指令段 `superagent:dispatcher`：先与用户协商路径再 `ensure`；用宿主的 `subagent(cwd=…)` 派活，brief 自带验收标准和报告格式；运行中用 `list_agents` / `send_message` / `interrupt_agent` 控制；回来只给一句汇总，不贴全文；
- 报告链路不用新机制：`subagent` 的完成结果本来就会回到发起者；执行者出现在超级 agent 的 delegation 视图里，用户可查看、可停止。

**仍未做（阶段二后续）**：按 workspace 的 Grant（可写范围/强度，人批一次可复用）；任务账（值得跟踪的派遣才落 jira issue，杂活不落）；长任务升级为真实 Session（可恢复、出现在目标 workspace 的会话列表）；面板按 workspace 分组展示派遣与状态；daemon 常驻（人不在时继续派发/收报告）。

**安全加固（DH-718，用户裁定）**：超级 workspace 的位置不再有默认值——`superagent_home` 必填，且拒绝相对路径、文件系统根、`$DSH_HOME` 之下的任何目录（那里是设置/会话/memory，不能让持有写沙箱的 agent 落在其中）；不满足时只警告、不注册也不创建目录。登记成功后把它 `insertBefore` 到工作区顺序第一位（幂等），保证唯一的对话入口始终在侧栏最上面。超级 agent 在 wire 时被钉到 `superagent_permission_preset`（默认 `workspace-write`），不继承比自身 workspace 更宽的权限 bundle；人显式放宽仍是人的选择。

**侧栏构建入口（DH-718 第二步）**：左侧栏底部新增一个 "Super agent" 动作（折叠时仅 ◆）。点它打开系统目录选择器，host 端依次校验路径 → 建目录 → 注册并置顶 → 把 `superagent_home` 写回 jira-agent 行（该行重载后按新 home 幂等 ensure）。`remote.jira.superagentState()` 只读当前配置与 registry，供入口显示状态；失败原因就地显示在按钮上（侧栏 action 没有可跳转的页面）。

**工作区分组（DH-718 第三步）**：ui-workspace 新增 `ctx.workspaceGroups` 注册表，别家插件可以把某个工作区登记为"特殊组"（id + label + workspaceId）。ui-jira 在状态就绪时把超级 workspace 注册进去，浏览器把它从普通列表里摘出来，在上方用独立小节标题（"超级工作区"）渲染，其余工作区保持原列表；label 由注册方提供，ui-workspace 不认识 jira。注册表可选：没有该插件的组合（以及测试）照旧渲染单一列表。

**全局与工作区分流（DH-720）**：按"工作属于谁"分流——工作区的代码/文档/数据走 `append`/`start` 该工作区会话；harness 级事务（系统环境、DSH 与插件设置、全局配置、跨工作区命令）由超级 agent 在超级工作区自己做，不派给工作区（跨沙箱既多余又容易踩权限）。全局修改需要本工作区之外的文件时，先说清文件与原因、申请一次；能用宿主设置通道就不动文件。超级 agent 的权限仍由 `superagent_permission_preset` 决定（默认 workspace-write）；后续可能改回"受限制的完全权限"，配置可改、代码不写死。

**真实 Session 执行者（DH-719）**：super agent 不再用 `subagent(cwd)` 派活，而是用 `superagent_session` 在目标工作区创建**真实 Session**（按 `workspaceId` 挂到工作区，所以人能在该工作区下看到、继续、归档、分支它）；该 Session 自己决定再派 subagent 还是自己干完。它每轮结束由 host 读取最后一条 assistant 文本，以 `[task-report] <session> in <workspace>` 消息 queue 回发起它的 super 会话（新回合，不阻塞对话）。

**跟进优先追加（DH-719 后续，用户裁定）**：同一工作区的跟进工作默认进**已有会话**——`append` 继续该工作区最近活跃的 Session，`start` 只在人明确要新会话或工作区还没有会话时使用；目标 Session 正在跑时用 `append`/`prompt` 让消息排队，不为同一批文件开并行 Session（并发编辑冲突由"一个工作区一个会话"这条规则避免）。用户点名某会话时先 `list` 再 `prompt`/`fork`/`archive`。

启动 Session 的 preset 由 `superagent_agent_preset` 决定（缺省用部署默认）。
