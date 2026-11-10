# memory / jira 插件实现审查报告

[English](2026-11-07-memory-jira-implementation-review.md) | 中文


> 审查对象：`D:\dqc\deepseek-harness-uitstalie-dev`，分支 `cli-desktop`，HEAD 为审查当日的 `cli-desktop` 基线 审查方式：只读代码审查 + 只读测试运行；**未修改任何被审查代码或配置，未 commit、未 push**。 审查日期：2026-11-07

---

## 0. 结论摘要

### memory — 评级 **C**（可用但有缺口；HEAD 上测试是红的）

`@deepseek-ai/dsh-memory` 与 `@deepseek-ai/dsh-client-ui-memory` 已把声明的能力基本落地：三个工具、append-only 快照、`detail/brief/forget` 三级迁移、`/memory` 的 7 个子命令、history 侧车、版本守卫、job 去重都有真实实现，不是一个骨架。但它当前存在一个**可在 HEAD 稳定复现的正确性缺陷**，加上文档与实现大面积互相矛盾，因此给 C 而不是 B。

最关键 3 个问题：

1. **被取消/出错的 turn 也会启动摘要 job，并写入「Memory summary failed」用户消息。** 组织者对所有 `turn/end` 派发（`packages/uitstalie/dafeiyu/src/index.ts#L336`），memory 的 `onTurnEnd` 不检查 `reason.kind`（`packages/uitstalie/memory/src/index.ts#L257`），而 `readTurnConversation` 只认 `completed` 并抛错（`packages/uitstalie/memory/src/summary.ts#L448`、`packages/uitstalie/memory/src/summary.ts#L455`）→ 失败分支写 notice（`packages/uitstalie/memory/src/summary.ts#L374`）。memory 自己的测试就断言「aborted turn 不启动 job」，**该测试在 HEAD 上稳定失败**（`packages/uitstalie/memory/tests/summary.spec.ts#L236`）。
2. **文档把已经改掉的语义写成现状，且中英/同文互相矛盾。** 英文 README 仍写 `refreshMemorySnapshot`「原地 replace 快照、`surfaceOp: replace`」（`packages/uitstalie/memory/README.md#L67`、`packages/uitstalie/memory/README.md#L88`），实现早已改成 `surfaceOp: 'append'` 且注释明确「never replaced in place」（`packages/uitstalie/memory/src/snapshot.ts#L420`-`packages/uitstalie/memory/src/snapshot.ts#L427`）；README 内部 `packages/uitstalie/memory/README.md#L134`、`packages/uitstalie/memory/README.md#L148` 又是新语义。迁移顺序、`onTurnEnd` 契约、`Window:` 字样也同样是旧描述。
3. **配置/依赖面有漂移，且一处运行期配置切换会静默失效。** `inject` 声明了从未使用的 `ctx.fs`（`packages/uitstalie/memory/src/index.ts#L34`），`package.json` 缺 `dsh-llm`/`dsh-session` 运行依赖（`packages/uitstalie/memory/package.json#L26`-`packages/uitstalie/memory/package.json#L32`）；`snapshotPosition` 改为 `prompt` 后，已接线 agent 的 `promptSections` 不会重算，而 `syncMemorySnapshot` 在 prompt 模式直接 return（`packages/uitstalie/memory/src/snapshot.ts#L226`）→ 该会话从此收不到任何快照，且不报错。

### jira — 评级 **B**（实现完整；superagent 子系统可用但有缺口）

台账本体（`jira-core` / `jira-service` / `jira-agent` / `jira-cli` / `ui-jira`）已经完整落地：单写者服务、`ctx.jira`、`remote.jira`、三个常驻工具 + 执行者 `issue_work`、写守卫、`/jira`、三个技能、推送队列与 settle 都有真实实现和厚测试。**node 套件 774 个测试全绿**。扣分主要在 superagent 子系统的失败路径、交付组合的可达性，以及一个 4350 行单文件带来的维护成本。

最关键 3 个问题：

1. **`toolFailure` 违反自己声明的 output schema。** `SUPERAGENT_OUTPUT_SCHEMA` 把 `me` 列为 required（`packages/jira/jira-agent/src/superagent.ts#L928`），而 `toolFailure` 只返回 `ok/error/writable`（`packages/jira/jira-agent/src/superagent.ts#L1729`-`packages/jira/jira-agent/src/superagent.ts#L1734`）。它被 `runSessionTool` 的兜底 catch 使用（`packages/jira/jira-agent/src/superagent.ts#L2451`），于是「本意是可读失败」的分支会被宿主的 `ToolOutputError` 覆盖。
2. **交付组合里整条派发链不可达。** `superagent` 能力默认关（`enabledByDefault: homeProblem === undefined`，`packages/jira/jira-agent/src/index.ts#L228`），行 patch 没有配置 `superagent_home`（`packages/bundle/web-app/cordis.patch.uitstalie.yml#L35`），也没有配置 `superagent_worker_preset`；而 `superagentDispatch` 在 preset 未设置时直接拒绝（`packages/jira/jira-agent/src/superagent.ts#L3700` 附近）。UI 的 setup 只会写 `superagent_home`（`packages/jira/jira-service/src/superagent-setup.ts#L111`-`packages/jira/jira-service/src/superagent-setup.ts#L115`），用户无法从界面补上 worker preset。`packages/bundle/web-app/presets/jira-worker.patch.yml` 定义了 `jira-worker` preset，但没有接上。
3. **结构债与文档债叠加。** `superagent.ts` 4350 行（含 653 行 `runSessionTool`、505 行 `createSuperagentContribution`）；同时 `jira-service` README 仍称「唯一的写是 `superagentConfirm`」（`packages/jira/jira-service/README.md#L55`），而 `superagentSetup` 会建目录、注册 workspace、写 profile 配置（`packages/jira/jira-service/src/remote.ts#L230`-`packages/jira/jira-service/src/remote.ts#L259`）。`HANDOVER.md` 整篇仍是外部仓的单包结构（`src/core`、`dist/`、702 测试）。

---

## 1. 审查范围、方法与“哪些不是本次审查对象”

### 1.1 状态切分

| 类别 | 内容 | 处理 |
|---|---|---|
| 已提交在 HEAD | memory 两包、jira 五包及组级测试、`cordis.patch.uitstalie.yml`、`jira-worker.patch.yml`、jira 文档四件套 | **本次审查对象** |
| 工作树未提交改动 | 审查开始时 `git status` 共 78 项（不含本报告），集中在 `packages/core/session*`、`agent-loop`、`session-query`、`session-persistence*`、`packages/sandbox/*`、`docs/persistence*`、`tool-cordis/api-catalog.ts` | **与 memory/jira 无关，未审查**；仅作为“测试运行时环境”披露 |
| 未跟踪文件 | `.dsh/`、`_tmp/`、两个 sandbox 测试、`.dsh-probe.txt` | 与本次审查无关 |
| 历史/实验文档 | `packages/jira/DESIGN.md`、`HANDOVER.md`、`MIGRATION.md`、`ARCHIVE-SOURCE.md` 从外部仓迁入；`packages/jira/tests/*` 是组级套件 | 作为“文档过时”的审查对象，但**不作为当前实现规格** |

已核实：`git status --porcelain -- packages/jira packages/uitstalie` 为空，`git ls-files --others` 在两组下也为空。**因此两个插件的审查结论完全对应当日 HEAD，不受工作树改动影响。**

### 1.2 实际运行过的验证

| 命令 | 结果 |
|---|---|
| `node node_modules/vitest/vitest.mjs run packages/uitstalie/memory packages/uitstalie/ui-memory` | **1 failed / 118 passed**（失败：`summary.spec.ts` 的 “an aborted turn does not start a summary job”，`expected length 0, got 1`） |
| 同上，只跑 `packages/uitstalie/memory/tests/summary.spec.ts` | **稳定复现同一失败**（15 passed / 1 failed），排除测试顺序影响 |
| `node node_modules/vitest/vitest.mjs run packages/jira` | **1 failed / 93 passed**；失败是 `packages/jira/tests/superagent-real-loop.spec.ts:162` 的 60s 超时（真 Session 控制器用例） |
| `pnpm run test:jira:node` | **774 passed**（`jira-agent` 171、`jira-cli` 38、`jira-core` 565） |

未运行：全仓 `pnpm test`（受本工作树其他未提交改动影响，且耗时）、GUI 真机组合、`verify-translation-pairing` 等文档门禁。详见 §9。

---

## 2. 逐维度发现

### 2.1 维度 1：实现程度

#### memory

| 声明能力 | 状态 | 证据与说明 |
|---|---|---|
| 固定 prompt section | 已实现 | `packages/uitstalie/memory/src/prompt.ts` + `packages/uitstalie/memory/src/index.ts#L239` |
| `memory_write` / `memory_search` / `memory_read` | 已实现 | `packages/uitstalie/memory/src/tools.ts#L109`、`packages/uitstalie/memory/src/tools.ts#L192`、`packages/uitstalie/memory/src/tools.ts#L268` 起 |
| 快照（depth-0 消息 / `memory-state` section） | 已实现，**运行期切换有洞** | `packages/uitstalie/memory/src/snapshot.ts#L209`-`packages/uitstalie/memory/src/snapshot.ts#L232`；见 2.2 |
| `detail`/`brief`/`forget` 三级迁移 | 已实现，生产受 compaction 门控 | `packages/uitstalie/memory/src/summary.ts#L327`-`packages/uitstalie/memory/src/summary.ts#L330`、`packages/uitstalie/memory/src/summary.ts#L349` |
| `/memory summaries\|stats\|prune\|pause\|resume\|edit\|revert` | 已实现 | `packages/uitstalie/memory/src/commands.ts#L67`-`packages/uitstalie/memory/src/commands.ts#L198` |
| `MEMORY.history.json` 侧车 | 已实现 | `packages/uitstalie/memory/src/memory-file.ts#L784`、`packages/uitstalie/memory/src/memory-file.ts#L508` |
| 版本守卫 + 一次重试 | 已实现 | `packages/uitstalie/memory/src/memory-file.ts#L755`、`packages/uitstalie/memory/src/memory-file.ts#L858` |
| 每会话单 job + pending 合并 | 已实现 | `packages/uitstalie/memory/src/summary.ts#L206`-`packages/uitstalie/memory/src/summary.ts#L290` |
| 失败 notice | **部分实现（触发条件错误）** | `packages/uitstalie/memory/src/summary.ts#L374`-`packages/uitstalie/memory/src/summary.ts#L386`；见 2.1「看起来有但不工作」 |
| 会话半边搜索 | 已实现但**无测试覆盖** | 测试的 `SessionQueryEngine` 恒返回空（`packages/uitstalie/memory/tests/harness.ts#L47`-`packages/uitstalie/memory/tests/harness.ts#L55`） |

“看起来有但不工作 / 只有 happy path”：

- **aborted/errored turn 的失败 notice**（上文）。这不只是“多一条消息”：每个被取消的 turn 都会占一个 job、跑一次失败路径，并可能在用户只是按了取消之后给出「Memory summary failed」的误导性提示。
- **含首条 snapshot 的 turn 永远无法折叠**：`rawTurnTarget` 明确拒绝包含 memory snapshot 的区间（`packages/uitstalie/memory/src/checkpoint.ts#L185`-`packages/uitstalie/memory/src/checkpoint.ts#L191`）；而会话第一次 `memory_write` 在没有既有快照时会追加一条完整快照（`packages/uitstalie/memory/src/tools.ts#L158`-`packages/uitstalie/memory/src/tools.ts#L171`）→ 该 turn 的区间永久不可替换，每个后续 pass 都会重试并打 debug 日志。README 的“重试”说法没有说明“有些区间永远不会成功”。
- **`jobs` 缺失分支不可达**：`inject` 已声明 `jobs`（`packages/uitstalie/memory/src/index.ts#L34`），`summary.ts` 里 `ctx.get('jobs') === undefined` 的分支（`packages/uitstalie/memory/src/summary.ts#L236`）在真实宿主里不会出现；对应测试只证明了“没有 jobs 时插件不激活”，不是该分支。
- **`/memory revert <turn> 多余文字` 静默接受**：`revertOne` 只取 `parsed.turn`（`packages/uitstalie/memory/src/commands.ts#L187`-`packages/uitstalie/memory/src/commands.ts#L190`），多余参数被丢弃而不是报错。

结论：memory **可用但有缺口**；主流程完整，失败路径和一个静默死路径是短板。评级 C。

#### jira

| 声明能力 | 状态 | 证据与说明 |
|---|---|---|
| `jira_issue` 十动词 | 已实现 | `packages/jira/jira-agent/src/toolIssue.ts` 的 `ISSUE_PARAMETERS`；组级 parity 测试守护动词映射 |
| `jira_list` / `jira_kb` | 已实现 | `packages/jira/jira-agent/src/toolList.ts`、`packages/jira/jira-agent/src/toolKb.ts` |
| 执行者 `issue_work` | 已实现 | `packages/jira/jira-agent/src/workIssue.ts`；`scope: 'all'` + worker 分流（`packages/jira/jira-agent/src/contribution.ts#L174`-`packages/jira/jira-agent/src/contribution.ts#L180`） |
| `jira:store` 运行时上下文 | 已实现 | `packages/jira/jira-agent/src/contribution.ts#L151`-`packages/jira/jira-agent/src/contribution.ts#L172` |
| 单调写守卫 | **部分实现** | 只拦 `jira_issue`（`packages/jira/jira-agent/src/wiring.ts#L35`-`packages/jira/jira-agent/src/wiring.ts#L42`）；`jira_kb` 的写由 handler 自查（`packages/jira/jira-agent/src/toolKb.ts#L82`），不是 guard 兜底 |
| `/jira` + 三技能 | 已实现 | `packages/jira/jira-agent/src/wiring.ts#L57`、`packages/jira/jira-agent/src/wiring.ts#L89` |
| turn-end settle + 推送队列 | 已实现 | `packages/jira/jira-agent/src/contribution.ts#L104`-`packages/jira/jira-agent/src/contribution.ts#L124`；`packages/jira/jira-service/src/index.ts#L928` |
| superagent 10 个工具 | 已实现，但**每个 agent 只拿到 6 或 5 个** | 普通 root：source/scan/claim/workspace/status/dispatch（`packages/jira/jira-agent/src/superagent.ts#L4494`-`packages/jira/jira-agent/src/superagent.ts#L4501`）；super agent：workspace/session/ledger/models/deliver（`packages/jira/jira-agent/src/superagent.ts#L4486`-`packages/jira/jira-agent/src/superagent.ts#L4493`） |
| daemon（无会话 dispatcher） | 已实现，opt-in | `packages/jira/jira-agent/src/superagent.ts#L4101`-`packages/jira/jira-agent/src/superagent.ts#L4124` |
| dispatch / recover | 已实现，**交付组合不可达** | 见结论摘要第 2 条 |

结论：jira 台账本体 **完整**；superagent **可用但有缺口**；整体 B。

### 2.2 维度 2：设计方案是否符合预期

#### memory

memory 没有独立的设计文档，**README 本身承担设计规格**（“Understand the implementation” + “Model Experience”）。把 README 当作设计意图对照，结论是：**核心设计意图（append-only、KV-cache 友好、compaction 边界折叠、分级遗忘）在实现里成立，但文档停留在上一版语义，导致“设计意图”与“实现”在纸面上冲突。**

| 设计意图（README） | 实际实现 | 差距 |
|---|---|---|
| 快照原地 replace，保持前缀不变（`packages/uitstalie/memory/README.md#L67`、`packages/uitstalie/memory/README.md#L88`、`packages/uitstalie/memory/README.md#L142`） | `appendSnapshot` 只 append（`packages/uitstalie/memory/src/snapshot.ts#L425`），注释解释 replace 会击穿 KV cache | **文档错误**；同一 README 的 `packages/uitstalie/memory/README.md#L134`、`packages/uitstalie/memory/README.md#L148` 已是新语义 |
| 迁移在 detail append 之后运行（`packages/uitstalie/memory/README.md#L84`） | 先 `migrateMemoryTiers` 再 `appendTurnSummary`（`packages/uitstalie/memory/src/summary.ts#L331`-`packages/uitstalie/memory/src/summary.ts#L360`），即 DH-710 | **文档错误** |
| `onTurnEnd` 只收 completed root turn（`packages/uitstalie/memory/README.md#L76`） | 组织者对所有 `turn/end` 派发（dafeiyu `packages/uitstalie/dafeiyu/src/index.ts#L336`） | **文档错误**，且实现没有补上过滤 |
| `snapshotPosition` / `snapshotTemplate` 改动是 row reload（`packages/uitstalie/memory/README.md#L188`） | 二者都是 `.volatile()`（`packages/uitstalie/memory/src/config.ts#L75`-`packages/uitstalie/memory/src/config.ts#L76`），模板下一次刷新即生效；`position` 则因为接线时已固定而“改了不生效也不报错” | **文档错误 + 实现缺陷** |
| 快照每次请求最多 16 KiB（`packages/uitstalie/memory/README.md#L138`） | 每个摘要 pass 都可能追加一条新快照（`packages/uitstalie/memory/src/summary.ts#L361` → `packages/uitstalie/memory/src/snapshot.ts#L230`），只与“上一条快照”做整串相等去重 | **语义漂移**：单条 ≤16 KiB，但 surface 上会累积多条 |
| `Window:` 清单（`packages/uitstalie/memory/README.md#L90`） | 实际渲染 `Archived:`（`packages/uitstalie/memory/src/snapshot.ts#L403`、`packages/uitstalie/memory/src/snapshot.ts#L409`）；代码注释解释了改名原因 | **文档错误** |

判断：memory 的设计意图与实现没有**架构级**冲突；问题在于 DH-723/724 改语义后文档没有同步，导致 README 既不能当规格也不能当用户说明。

#### jira

jira 的设计意图主要在三处：`DESIGN.md`（决策日志，1–223 条）、`MIGRATION.md`（三层拆分目标形状）、各包 README（当前行为）。

对齐结果：

| 设计意图 | 实际实现 | 差距 |
|---|---|---|
| MIGRATION：一个 bundle + 五个包，四种表面只依赖 `ctx.jira` | 五包齐全；`jira-agent` 只 type-only import `jira-service`；`ui-jira` 走 `remote.jira`；CLI 直接驱动 core | **符合**；但 `jira-agent` 的运行器仍绕过服务直接读 jira-core（见 README:107，已与实际不符） |
| DESIGN 64/108：单包、适配层零宿主依赖 | 已拆成五包；`jira-agent/src` 有 102 处 `@deepseek-ai/*` import | **被 MIGRATION 取代**；文档未标注 |
| DESIGN 141/96：恰好一个写守卫，覆盖“写动作 × 不可写会话” | 守卫只判断 `jira_issue` 的 `action`（`packages/jira/jira-agent/src/wiring.ts#L36`-`packages/jira/jira-agent/src/wiring.ts#L38`） | **范围窄于设计表述**；`jira_kb` 写靠 handler，`issue_work` 靠 claim |
| DESIGN 200–223：superagent 派发链 | 工具、daemon、dispatch、recover、ledger 都有实现 | **实现超越设计文档的细节覆盖**，但交付组合未接线（见 2.6） |
| DESIGN 15/148：推送前 settle，保证推出去的与源一致 | `sync()` 用 `flushNow({ settle: true })`（`packages/jira/jira-service/src/index.ts#L907`-`packages/jira/jira-service/src/index.ts#L921`）；`settle()` 重生成并提交（`packages/jira/jira-service/src/index.ts#L928`-`packages/jira/jira-service/src/index.ts#L936`） | **符合** |

另外，`jira-service/src/index.ts` 的 `reconfigure()` 有一段**逐字重复的赋值**（`packages/jira/jira-service/src/index.ts#L253`-`packages/jira/jira-service/src/index.ts#L255` 与 `packages/jira/jira-service/src/index.ts#L257`-`packages/jira/jira-service/src/index.ts#L259`），是实现期遗留的复制粘贴，不影响行为但说明该路径缺少审阅。

### 2.3 维度 3：代码简洁性与复用性

#### memory

- **长函数/大类**：`MemorySummaryRunner` 从 `packages/uitstalie/memory/src/summary.ts#L184` 到 `packages/uitstalie/memory/src/summary.ts#L399`，约 216 行；其中 `runPass` 约 95 行（`packages/uitstalie/memory/src/summary.ts#L293`-`packages/uitstalie/memory/src/summary.ts#L387`）。`apply` 约 72 行（`packages/uitstalie/memory/src/index.ts#L201`-`packages/uitstalie/memory/src/index.ts#L272`），把“读配置、注册能力、注册命令、快照缓存”四件事放在一个函数里。
- **复制粘贴（已核实定义处）**：`truncateToBytes` 3 份（`packages/uitstalie/memory/src/read.ts#L295`、`packages/uitstalie/memory/src/snapshot.ts#L471`、`packages/uitstalie/memory/src/summary.ts#L724`）；`byteLength` 3 份（`packages/uitstalie/memory/src/read.ts#L309`、`packages/uitstalie/memory/src/snapshot.ts#L466`、`packages/uitstalie/memory/src/summary.ts#L712`）；`errorMessage` 4 份（`packages/uitstalie/memory/src/checkpoint.ts#L230`、`packages/uitstalie/memory/src/memory-file.ts#L2197`、`packages/uitstalie/memory/src/snapshot.ts#L486`、`packages/uitstalie/memory/src/summary.ts#L739`）。这些是纯文本工具，抽一个 `text.ts` 即可，风险很低。
- **隐式状态**：`snapshotTexts` 是 `apply` 闭包里的 `Map`（`packages/uitstalie/memory/src/index.ts#L223`-`packages/uitstalie/memory/src/index.ts#L227`），只增不减，`dispose` 不清理；`MemorySummaryRunner` 的 `sessions`/`noticed` 同理（`packages/uitstalie/memory/src/summary.ts#L185`-`packages/uitstalie/memory/src/summary.ts#L187`）。它们有界于“进程内见过的 session 数”，不是泄漏级，但属于“状态没有单一所有者”。
- **错误模型不一致**：`memory-file.ts` 用 `MemoryDocumentError`，其余模块大量用裸 `Error`（`packages/uitstalie/memory/src/config.ts#L116`、`packages/uitstalie/memory/src/summary.ts#L455`、`packages/uitstalie/memory/src/tools.ts#L155` 等）。对“文档损坏”与“参数非法”无法在上层区分。
- **手写 mini 格式**：`memory-file.ts` 用 5 条正则解析条目后缀并逆序剥离（`packages/uitstalie/memory/src/memory-file.ts#L326`-`packages/uitstalie/memory/src/memory-file.ts#L341`）；`parseSummaryJson` 用“第一个 `[`/`{` 到最后一个 `]`/`}`”的启发式（`packages/uitstalie/memory/src/summary.ts#L658`-`packages/uitstalie/memory/src/summary.ts#L670`）。managed block 是自造格式，可以接受；但对模型输出做括号切片在含 `}` 的散文上不稳。
- **无意义抽象**：`MEMORY_ENTRY_LABELS = MEMORY_ENTRY_KINDS`（`packages/uitstalie/memory/src/commands.ts#L32`）只是别名；`findSection`/`sameSection` 与 `findContainingSection` 是两套查找（`packages/uitstalie/memory/src/memory-file.ts#L1124`、`packages/uitstalie/memory/src/memory-file.ts#L1337`）。

#### jira

- **单文件过大**：`superagent.ts` 4350 行。最长函数：`createSuperagentContribution` `packages/jira/jira-agent/src/superagent.ts#L4048`-`packages/jira/jira-agent/src/superagent.ts#L4552`（505 行）、`runSessionTool` `packages/jira/jira-agent/src/superagent.ts#L2405`-`packages/jira/jira-agent/src/superagent.ts#L3057`（653 行）。
- **同一信封手写多次**：`toolFailure` 之外，`{ ok: true, writable, me, ... }` 在多个 runner 里重复展开；`verdictOf`（`packages/jira/jira-agent/src/superagent.ts#L725`）只被 models 一个工具使用，其余位置没有用它。
- **`createSuperagentContribution` 职责混杂**：同一个函数里做 fs roots 授权（`packages/jira/jira-agent/src/superagent.ts#L4072`-`packages/jira/jira-agent/src/superagent.ts#L4077`）、systemPrompt 注入（`packages/jira/jira-agent/src/superagent.ts#L4081`-`packages/jira/jira-agent/src/superagent.ts#L4100`）、domain/事件订阅（`packages/jira/jira-agent/src/superagent.ts#L4129`-`packages/jira/jira-agent/src/superagent.ts#L4161`）、定时器（`packages/jira/jira-agent/src/superagent.ts#L4163`）和 10 个 spec 的定义与渲染。这是“注册 + IO + 业务 + 渲染”四合一。
- **服务层重复赋值**：`reconfigure()` 的 6 行重复（见 2.2）。
- **UI 的 staged-form 控制器重复**：`ui-memory/src/client/settings.ts:119` 的 `MemorySettingsController` 与 `ui-personality/src/client/settings-form.ts:112` 的 `PersonalitySettingsController` 结构逐项对应（`FIELDS`/`NUMERIC`/`EMPTY`/`UNAVAILABLE`/`draftOf`/`validNumber`/`edit`/`discard`/`save`）；这是两个插件而不是一个插件内部，但“配置表单控制器”本可以抽到 `ui-primitives` 或共享基类。
- **死 JSDoc**：`ledger-settings.ts:226` 的「Publish the current projection」被挂在 `accepted()` 前面，`publish()` 本体在 `packages/jira/ui-jira/src/client/ledger-settings.ts#L232` 且无注释（`packages/jira/ui-jira/src/client/ledger-settings.ts#L226`-`packages/jira/ui-jira/src/client/ledger-settings.ts#L232`）。
- **`result.ts` 的 13 个组合子**：`map/mapErr/andThen/orElse/unwrapOr/collect/partition/pipe/isOk/isErr` 只在 `result.ts` 与 `result.test.ts` 里出现，生产代码只用 `ok`/`err`/`Result`（grep 全组确认）。这是一个**没有消费者的公共 API**，测试在为它维持成本。

类型与错误处理（jira）：`JiraError` + `Result` 模型在 core 里非常一致（非测试源码零 `throw`），这是本项目最好的部分之一；问题只在 agent 适配层的信封与 UI 边界。

### 2.4 维度 4：是否重复造轮子

判断标准：**有明确平台/离线理由且行为正确的封装**算“合理封装”；**仓库里已有同能力、同语义设施**才算重复造轮子。

| 重复实现 | 位置 | 已有替代 | 判断与建议 |
|---|---|---|---|
| 原子写（tmp + rename + 3 次退避） | `packages/jira/jira-core/src/io.ts#L178` `writeTextAtomic`；重试常量在 `packages/jira/jira-core/src/system/policy.ts#L17` | `packages/util/atomic-write` 的 `writeFileAtomic` / `withFileLock`，被 `boot/config-editor`、`credentials-local`、`boot/plugin-manager` 等 10+ 生产包使用 | **重复造轮子**。若保留 jira 的“零依赖/离线拷贝”前提，至少应复用同一套重试与错误语义；在 monorepo 里该前提已弱化 |
| 跨进程锁（mkdir + owner + 心跳/回收） | `packages/jira/jira-core/src/lock.ts#L1`-`packages/jira/jira-core/src/lock.ts#L50` | `atomic-write` 的 `withFileLock`；`session-persistence-jsonl` 的 lease/flock | **合理封装 + 部分重复**：mkdir 锁有 Windows 反杀软的真实理由（决策 59），但仓库已有两套锁，第三套应至少共享接口与超时语义 |
| 受限 YAML/frontmatter 解析 | `packages/jira/jira-core/src/frontmatter.ts#L1`-`packages/jira/jira-core/src/frontmatter.ts#L40` | `yaml` 已是 workspace 依赖并被 `store-atom`、`personality` 等使用；memory 也直接用 `yaml` | **有理由的封装**（严格拒绝、文本真相、决策 105），但“必须离线拷贝、零运行时依赖”（决策 65）在五包 monorepo 里已不成立；建议在文档里更新理由，不建议现在重写 |
| 手写 JSON Schema 子集 + 参数校验 | `packages/jira/jira-core/src/schema.ts#L1`-`packages/jira/jira-core/src/schema.ts#L15`、`validate.ts` | `zod@4.4.3` 已是 `jira-agent` 的直接依赖（`packages/jira/jira-agent/package.json#L33`），`z.toJSONSchema` 可产出宿主方言；`schemastery` 也在用 | **重复造轮子**（最硬的一条）。理由仍是“适配层不 import 宿主”，但 `jira-agent` 本来就 import 宿主；建议把参数校验移到 agent 适配层用 zod，core 只保留输出形状 |
| home/`~` 解析 | `packages/jira/jira-core/src/system/env.ts`、`superagent-setup.ts:55` | `@deepseek-ai/dsh-home-paths` 的 `resolveDshHome` | **合理封装但已漂移一次**（HANDOVER 记录过）；建议复用或加交叉测试 |
| tag 文件的正则读取 | `packages/jira/jira-core/src/store.ts#L114`-`packages/jira/jira-core/src/store.ts#L130` | 同包 `tagstore.ts` 的 `decodeTag` | **内部重复**，应合并；同一文件两种解码器迟早漂移 |
| session 事件派生（标题/活动/缓存/最近任务） | `superagent.ts` 的 `activityOf`/`cacheHitOf`/`sessionTitleOf`/`lastTaskOf` | `session-stats`、`session-turn-outline`、Session projections | **部分重复**（静态阅读判定）：superagent 需要“跨 workspace 的会话概览”，现有包未直接提供；但重放 `snapshotEvents()` 并硬编码事件名，长期会与 session 事件词表脱节 |
| UI 配置表单控制器 | `packages/uitstalie/ui-memory/src/client/settings.ts#L119` vs `packages/uitstalie/ui-personality/src/client/settings-form.ts#L112` | 无共享基类 | **复制粘贴**，建议抽 `StagedConfigFormController` |
| `.superagent` 路径规则与 home 校验 | `packages/jira/jira-service/src/superagent-setup.ts#L67`、`packages/jira/jira-service/src/superagent-setup.ts#L87` vs `packages/jira/jira-agent/src/superagent.ts#L324`、`packages/jira/jira-agent/src/superagent.ts#L366` | 两份实现 | **重复且已漂移**：agent 侧用 `realpathSync`，service 侧用 `resolve` 的词法比较；两个入口对“同一个目录”的判断可能不同 |

“合理封装，不算重复”的部分：`jira-core` 的 `Result`/`JiraError` 模型、`git.ts` 的 `runGit`、`system/*` 的平台适配、`boardHtml.ts` 的离线单文件看板、`ui-jira` 的 `remote.jira` 读模型。

### 2.5 维度 5：解耦程度

#### memory

| 耦合点 | 证据 | 影响 |
|---|---|---|
| 多声明未使用的 `fs` | `inject` 含 `fs`（`packages/uitstalie/memory/src/index.ts#L34`）；`ctx.fs` 只在测试里被 spy（`checkpoint.spec.ts:167` 等），生产代码从不读 | 缺 `fs` 的合法组合会被拒绝，能力被不必要地绑死在 fs 上 |
| 隐藏依赖 `tool-jobs` 的 controller | `jobs.start` 可用但 controller 必须由 `tool-jobs` attach（`summary.ts:236` 只判 `jobs` 存在） | 组合里没有 `tool-jobs` 时摘要静默跳过，`inject` 无法表达这层依赖 |
| 直接读 Agent 内部 | `agent.options`、`agent.session.requestHeader()`（`packages/uitstalie/memory/src/summary.ts#L426`-`packages/uitstalie/memory/src/summary.ts#L431`）、`agent.session.surface.nodes`（`packages/uitstalie/memory/src/index.ts#L250`） | 宿主 Agent/Session 结构变化会直接打穿 provider；没有适配层 |
| 硬编码存储路径写进提示词 | prompt 文本与工具描述写 `.dsh/memory`（`packages/uitstalie/memory/src/prompt.ts#L21`、`packages/uitstalie/memory/src/tools.ts#L115`），与 `store-atom` 的 `STORE_DIR_NAME` 是第二份真相 | 换存储根/改目录名时，模型提示会撒谎 |
| UI 与 host 的配置字段双写 | `ui-memory` 的 7 个字段名（`packages/uitstalie/ui-memory/src/client/settings.ts#L35`-`packages/uitstalie/ui-memory/src/client/settings.ts#L43`）与 host 的 10 字段（`packages/uitstalie/memory/src/config.ts#L66`-`packages/uitstalie/memory/src/config.ts#L77`）各写一份；sectionId/order 也在两处（`packages/uitstalie/memory/src/index.ts#L40`、`packages/uitstalie/ui-memory/src/section.ts#L7`） | 改字段名不会编译报错，只表现为空值或保存被拒 |
| 换存储 / 换 provider | 存储走 `ctx.dshStore` + `dsh-fs` 的 `FS_STALE_VERSION`；模型走 `ctx.llm` + 路由回退 | 换存储要重写 `memory-file` 的版本冲突判断；换 provider 无影响（设计正确） |

#### jira

- **好的边界**：`jira-core` 真的零宿主 import（`boundaries.spec.ts` + 我的复核）；`jira-service` 是唯一写者；`ui-jira` 只走 `remote.jira`；`jira-cli` 不依赖 `jira-agent`。
- **agent 对宿主的直接依赖**：9 个 duck-typed 服务（`sessionController`、`workspaceRegistry`、`llm`、`agents`、`tokenMeter`、`compaction`、`sandboxPolicy`、`permissionPresets`、`storageDomain`）；以及 `agent.ctx.effect`（`packages/jira/jira-agent/src/superagent.ts#L4507`）、`session.snapshotEvents`、`agent.cancel({..})`、`whenIdle` 等 Agent 内部 API。缺席即静默降级，没有类型检查。
- **为绕过 `inject` 而做的 cast**：`contribution.ts:152`、`superagent.ts:4081` 把 `ctx` 断言成 `{ inject?: ... }` 再手工调用，而不是用 Cordis 的 `ctx.inject` 声明。能工作，但把生命周期交给了调用者（见 2.6）。
- **UI 绕过 typert 类型**：`ui-jira/src/client/index.ts:157`、`packages/jira/ui-jira/src/client/index.ts#L174` 用 `as unknown as` 访问 `superagentSetup` / `superagentState`，而 `store.ts` 的 `JiraWire` 没有这两个方法（`packages/jira/ui-jira/src/client/store.ts#L32`-`packages/jira/ui-jira/src/client/store.ts#L49`）。协议变更不会在这里报错。
- **硬编码**：`.superagent/ledger`（`dispatch-ledger.ts:20`）、`Super agent` 标题、`workspace-write` 默认、`~/.dsh/sessions`、`$DSH_HOME/attachments`。这些是产品选择，但都散落在代码而不是一个配置/常量模块。
- **循环依赖**：无。`jira-agent` 只 type-only import `jira-service`；`jira-service` 不 import `jira-agent`。但 `jira-agent/package.json` 把 `jira-service` 放在 `devDependencies`（`packages/jira/jira-agent/package.json#L43`），而 `tools.ts:25` 的类型会出现在发布的 `lib/types` 里 —— 对消费者来说这是一个未声明的类型依赖。

### 2.6 维度 6：组合性

#### memory

- **可单独禁用**：Loader 行可整行关闭；`/memory` 用 `ctx.inject(['commands'])` 可选挂载（`packages/uitstalie/memory/src/index.ts#L269`-`packages/uitstalie/memory/src/index.ts#L271`），这是正确的组合写法。
- **声明不准确**：`inject` 6 项里 `fs` 未用；`jobs` 只是“存在”，真正可用还依赖 `tool-jobs` attach controller。两者都让“可选能力”实际上不可选。
- **配置暴露不全**：10 个字段里 UI 只编辑 7 个（缺 `maxEntries`、`snapshotTemplate`、`snapshotPosition`）；后两者只能改 profile YAML。
- **section 契约无交叉校验**：host 的 `MEMORY_SETTINGS_SECTION/ORDER` 与 UI 的 `section.ts` 各写一份，改一处不会编译失败。

#### jira

- **两个能力独立 gate 是优点**：`jira` 与 `superagent` 分别注册、分别 `enabledByDefault`，dafeiyu 可按 id 开关（`packages/jira/jira-agent/src/index.ts#L205`-`packages/jira/jira-agent/src/index.ts#L249`）。
- **但默认值与组合不一致**：`jira` 在交付 patch 里被显式打开（`packages/bundle/web-app/cordis.patch.uitstalie.yml#L9`-`packages/bundle/web-app/cordis.patch.uitstalie.yml#L13`）；`superagent` 没有条目，按 `enabledByDefault`（home 未配置 → false）关闭。`jira-worker` preset 已经随 bundle 发布（`presets/jira-worker.patch.yml`），却没有任何行配置把它与 `superagent_worker_preset` 连起来 → **“preset 存在但派发永远拒绝”**。
- **“个人分支层”被塞进公开 bundle**：`@deepseek-ai/dsh-web-app` 的 `dsh.bundle.patch` 无条件列出 `./cordis.patch.uitstalie.yml`（`packages/bundle/web-app/package.json#L50`-`packages/bundle/web-app/package.json#L57`），于是安装这个公开包的人会一并挂上 memory、jira、persona-card 等分支插件；要关掉只能改 patch。组合边界是“分支层”而不是“可选 bundle”。
- **依赖声明**：`jira-core` 声明了 `peerDependencies: cordis`（`packages/jira/jira-core/package.json#L23`-`packages/jira/jira-core/package.json#L25`），但它零宿主 import，这个 peer 是空的；memory 则相反，缺了两个实际运行依赖。两种方向的“声明不准”都存在。
- **生命周期**：`createSuperagentContribution` 的 `dispose` 是同步的（`CapabilityContribution.dispose?(): void`，dafeiyu `packages/uitstalie/dafeiyu/src/types.ts#L98`），所以 `void dispatchStore?.close()`（`packages/jira/jira-agent/src/superagent.ts#L4544`）无法被等待；同时 `poll()` 没有 `disposed` 标志，定时器清掉后**已启动的一轮 pass 仍会继续**（`packages/jira/jira-agent/src/superagent.ts#L4103`-`packages/jira/jira-agent/src/superagent.ts#L4124`）。dafeiyu 的 `contain` 对返回的 Promise 只做 `catch`、不 `await`（`packages/uitstalie/dafeiyu/src/index.ts#L526`-`packages/uitstalie/dafeiyu/src/index.ts#L535`）。影响：禁用能力后仍可能产生一条 proposal 评论；关闭 dispatch store 与 storageDomain 撤出并发。属于**契约限制下的未收口**，不是必现数据损坏。

### 2.7 维度 7：文档是否过时

原则：**“文档缺失”与“文档错误”分开列**。

#### 文档错误（可指到代码）

| 文档位置 | 过时内容 | 代码现状 | 应改成 |
|---|---|---|---|
| `packages/uitstalie/memory/README.md#L67`、`packages/uitstalie/memory/README.md#L88`、`packages/uitstalie/memory/README.md#L142` | 快照“append or replace”“原地 replace、`surfaceOp: replace`” | 只 append（`packages/uitstalie/memory/src/snapshot.ts#L425`、`packages/uitstalie/memory/src/snapshot.ts#L420`-`packages/uitstalie/memory/src/snapshot.ts#L424` 注释） | 改为 append-only；删掉 `surfaceOp: replace` |
| `packages/uitstalie/memory/README.md#L84` | “迁移在 detail append 之后” | 先迁移后 append（`packages/uitstalie/memory/src/summary.ts#L331`-`packages/uitstalie/memory/src/summary.ts#L360`） | 按 DH-710 顺序改写 |
| `packages/uitstalie/memory/README.md#L76` | `onTurnEnd` 只对 completed 调用 | dafeiyu 对所有 `turn/end` 派发（`packages/uitstalie/dafeiyu/src/index.ts#L336`） | 要么改代码加过滤，要么改文档并处理非 completed |
| `packages/uitstalie/memory/README.md#L90` | “`Window:` manifest” | 实际是 `Archived:`（`packages/uitstalie/memory/src/snapshot.ts#L403`、`packages/uitstalie/memory/src/snapshot.ts#L409`） | 改字样 |
| `packages/uitstalie/memory/README.md#L54` | “六个硬依赖，含 `ctx.fs`” | `ctx.fs` 生产未用；`dsh-llm`/`dsh-session` 才是缺声明的运行依赖 | 改依赖列表，并补 manifest |
| `packages/uitstalie/memory/README.md#L138` | “每次请求最多 16 KiB” | 每个摘要 pass 可追加一条新快照（`packages/uitstalie/memory/src/summary.ts#L361`） | 改为“单条 ≤16 KiB，surface 可累积多条” |
| `packages/uitstalie/memory/README.md#L188` | “position/template 改动是 row reload” | 两者都是 volatile；position 运行期切换不重接 | 改文档 + 修切换 |
| `packages/jira/jira-agent/README.md#L12` | “两个能力都 `enabledByDefault: false`” | superagent 是 `homeProblem === undefined`（`packages/jira/jira-agent/src/index.ts#L228`） | 改为“jira 默认关；superagent 由 home 是否配置决定” |
| `packages/jira/jira-agent/README.md#L90`、`packages/jira/jira-agent/README.md#L95` | “root agent 带 10 个工具”“每次请求 10 个 schema” | 普通 root 6 个、super agent 5 个（`packages/jira/jira-agent/src/superagent.ts#L4484`-`packages/jira/jira-agent/src/superagent.ts#L4501`） | 按 6/5 分流改写，或调整实现 |
| `packages/jira/jira-agent/README.md#L107` | “runner 仍按深路径 import jira-core / 走 `ctx.jira.store()`” | 无深路径 import；`JiraServiceApi` 没有 `store()`（`types.ts` 方法表） | 删除该限制 |
| `packages/jira/jira-service/README.md#L55` | “浏览器面唯一的写是 `superagentConfirm`” | `superagentSetup` 会 `mkdir`、注册 workspace、写 profile（`packages/jira/jira-service/src/remote.ts#L230`-`packages/jira/jira-service/src/remote.ts#L259`） | 补第二个写并说明权限边界 |
| `packages/jira/jira-service/README.md#L32` 的服务方法枚举 / `packages/jira/jira-service/README.md#L42` 的 remote 表 | 服务枚举漏 `status/snapshot/queryIssues/tagsLint/syncState`；remote 表漏 `superagentState/superagentSetup` | `types.ts` 的 `JiraServiceApi` 与 `remote.ts` 的 `@Remote` | 按当前 API 重列 |
| `packages/jira/README.md#L12`、`packages/jira/README.md#L32` | jira-agent 只写“three tools”；ui-jira 只写状态/看板/详情/KB | 另有 `issue_work` + 10 个 `superagent_*`；UI 还有 superagent 面板与 sidebar setup（`packages/jira/ui-jira/src/client/index.ts#L125`-`packages/jira/ui-jira/src/client/index.ts#L167`） | 同步工具数与 UI 能力 |
| `packages/jira/HANDOVER.md#L3`、`packages/jira/HANDOVER.md#L20`、`packages/jira/HANDOVER.md#L83`、`packages/jira/HANDOVER.md#L284`、`packages/jira/HANDOVER.md#L400` | 199 决策、702 测试、`src/core`/`src/cli`/`src/plugin`、`dist/plugin/index.js`、`pnpm build` 必做 | 五包 monorepo；入口为 `lib/index.js`；node 测试 774；DESIGN 已有 223 条 | 页首标“历史文档”；或移入 `archive/` |
| `packages/jira/DESIGN.md#L3` | 状态栏“82 条已确认决策”、讨论稿 v3 | §8 实际编号 1–223（脚本统计 310 行，最大 223） | 更新状态行；标注被 MIGRATION 取代的布局 |
| `packages/jira/DESIGN.md#L177`-`packages/jira/DESIGN.md#L179` | 单包 `src/core`/`src/cli`/`src/plugin` 树 | 五包 | 加“历史布局，见 MIGRATION.md” |
| `packages/jira/DESIGN.md#L33` | 核对基线 `@deepseek-ai/dsh-root@0.2.1-alpha.2` | 根 `package.json` 版本 `0.2.2-alpha.3` | 重核并更新基线 |
| `packages/jira/ARCHIVE-SOURCE.md#L27` + `packages/jira/README.md#L43` | 声明 HANDOVER“正文未改”，同时把 HANDOVER 作为“current state / open work”链接 | HANDOVER 全篇是迁移前结构 | 两者之一：加横幅，或停止在 README 里称其为当前交接 |
| `packages/jira/MIGRATION.md#L5`、`packages/jira/MIGRATION.md#L15` | 目标包名 `@uitstalie/*`、计划形态 | 实际 `@deepseek-ai/dsh-*`，已落地 | 页首已注明“计划值”，建议在 §2.1 也加同一句 |

#### 文档缺失

- 没有 `docs/subsystems/memory.md` / `docs/subsystems/jira.md`，也没有产品级用户页；只有生成目录（`docs/config-catalog.md`、`module-graph.md`）覆盖配置与包图。`ctx.jira` / `remote.jira` 的契约目前只存在于包 README 与 `types.ts`。
- `docs/user/guide/mcp-memory.md` 是第三方 MCP memory 服务，与 `dsh-memory` 同名不同物，容易被误读为同一能力。
- 没有“当前态”的运维页：五包怎么 build/test/smoke、怎么在 profile 里开关 superagent、怎么设置 worker preset，散落在旧 HANDOVER 与源码里。
- `jira-agent` 的 11 个 `superagent_*` 行配置没有包级配置表（只有 `index.ts` 的 JSDoc 与生成目录）。

---

## 3. 重复与可复用清单（汇总）

| # | 重复实现位置 | 已有替代 | 建议动作 | 优先级 |
|---|---|---|---|---|
| 1 | `jira-core/src/io.ts:178` 原子写 | `packages/util/atomic-write` `writeFileAtomic` | 复用；至少共享重试/错误语义 | P2 |
| 2 | `jira-core/src/lock.ts` mkdir 锁 | `atomic-write` `withFileLock`、session lease | 保留 mkdir 理由，抽出统一接口 | P2 |
| 3 | `jira-core/src/schema.ts` 手写 JSON Schema/校验 | `zod@4.4.3`（已在 agent）、`schemastery` | 适配层改 zod，core 只留形状 | P2 |
| 4 | `jira-core/src/frontmatter.ts` 受限 YAML | `yaml`（memory 已用） | 保留；更新“离线零依赖”理由 | P2 |
| 5 | `jira-core/src/store.ts:114` 正则读 tag | 同包 `tagstore.decodeTag` | 立即合并 | P2 |
| 6 | `jira-core/src/result.ts:61-163` 组合子 | 无生产调用者 | 删除或标注内部 | P2 |
| 7 | memory 的 `truncateToBytes`×3 / `byteLength`×3 / `errorMessage`×4 | 无 | 抽 `text.ts` | P2 |
| 8 | `ui-memory/settings.ts:119` vs `ui-personality/settings-form.ts:112` | 无共享基类 | 抽 staged config controller | P2 |
| 9 | `superagent-setup.ts:67,87` vs `superagent.ts:324,366` | 两份 home/path 规则 | 合并为一份（注意 realpath vs 词法） | P1 |
| 10 | `jira-service/src/index.ts:253-259` 重复赋值 | 自身 | 删除重复块 | P2 |
| 11 | `.superagent/ledger`、`Super agent`、`workspace-write` 等硬编码 | 无 | 收到一个常量/配置模块 | P2 |

---

## 4. 设计符合度对照表（汇总）

| 设计意图来源 | 意图 | 实现 | 差距等级 |
|---|---|---|---|
| memory README | 快照只追加、KV-cache 友好 | 只 append（`snapshot.ts:425`） | **实现符合，文档错** |
| memory README | 迁移在 append 之后 | 先迁移后 append（`summary.ts:331-360`） | **实现符合，文档错** |
| memory README | `onTurnEnd` 只收 completed | 收所有 turn end（`dafeiyu:336`） | **实现缺陷** |
| memory config JSDoc | 10 个 volatile 字段即改即生效 | `snapshotPosition` 切换不重接 | **实现缺陷** |
| MIGRATION.md | 一个 bundle + 五包，四表面只依赖 `ctx.jira` | 五包、服务单写者、remote 读模型 | **符合** |
| DESIGN 141 | 一个 guard 覆盖写动作 × 不可写会话 | 只覆盖 `jira_issue` | **实现窄于设计** |
| DESIGN 148 | settle 在 pull 后、push 前 | `flushNow({ settle: true })` + `settle()` | **符合** |
| DESIGN 200–223 | 真实 Session 派发 + preset 隔离 | dispatch/recover/daemon 都在 | **实现符合，交付组合未接线** |
| jira-agent README | 10 个工具都在 root agent 上 | 6/5 分流 | **文档错** |
| jira-service README | 唯一写是 `superagentConfirm` | 另有 `superagentSetup` | **文档错** |

---

## 5. 优先级建议

排序原则：正确性 > 安全/数据 > 可维护性 > 风格。

### P0（应当马上处理）

1. **memory：被取消/出错的 turn 不再启动摘要 job、不写失败 notice。** 在 `onTurnEnd` 检查 `input.event.data.reason.kind !== 'completed'` 直接返回（或在 `runPass` 里把“没有 completed turn”当作正常跳过而不是失败）。同时把 dafeiyu 与 memory 的 README 改成“所有 turn end 都会到达，由 provider 自己判断”。验收：`summary.spec.ts:236` 转绿，且新增“aborted turn 不写 notice、不产生 job”的断言。
2. **jira：`toolFailure` 补 `me`（以及 `writable` 的语义）。** 否则 `runSessionTool` 的兜底失败会被 `ToolOutputError` 二次覆盖（`superagent.ts:1729` vs `:928`）。验收：用一个抛错的假 controller 触发 catch，断言返回值通过 output schema。

### P1（本轮或下一轮）

3. **jira：把 `superagent_worker_preset` 接进交付组合**（或在未配置时让 `superagent` 能力整体不可见，而不是“有工具但必拒”）。并让 UI setup 能同时写 worker preset，或在 README/UI 明说需要手工改行。
4. **memory：`snapshotPosition` 运行期切换要么重接 agent，要么拒绝写并报错**；不要把“切换后收不到快照”变成静默行为。
5. **memory：修正英文 README 的 replace/顺序/`Window:`/六依赖/16 KiB 表述**，并让中英一致；补 `dsh-llm`/`dsh-session` 运行依赖、删掉未用的 `fs` inject。
6. **jira：`jira-service` 的 `reconfigure()` 去重 + README 的“唯一写”修正**；`HANDOVER.md` 加历史横幅或移入 `archive/`。
7. **jira：`createSuperagentContribution` 的 teardown 收口**：加 `disposed` 标志让 `poll()` 在每步前退出；`dispose` 至少记录 close 的失败（当前 `void ... .catch(log)` 可以，但无法等待）。若 dafeiyu 的 `dispose` 契约不能改，至少把“未等待 close”写进注释。
8. **memory：快照累积的预算/去重策略**（例如只保留最后一条 snapshot，或把旧 snapshot 标记为 `superseded` 并在 compaction 边界清理），否则长会话的 context 会线性增长，和 README 的 token 承诺不符。

### P2（可维护性/风格，按需）

9. jira：把 `superagent.ts` 按 `claim / workspace / session / dispatch / ledger-report / source / contribution` 拆文件；先拆 653 行的 `runSessionTool`。
10. jira：`jira-core` 的原子写/锁/schema/tag 解码复用与合并；删除 `result.ts` 的死组合子。
11. jira：两份 home/path 规则合并（realpath vs 词法）。
12. memory：抽 `text.ts` 消掉 3×3×4 的重复 helper；`snapshotTexts`/`sessions` 在 session dispose 时清理。
13. UI：`MemorySection.tsx:48` / `JiraSection.tsx:53-57` 的条件 hook 与提前 return 违反 hooks 规则，提到 return 之前；`ui-memory` 改用 `useSnapshot` 注入而不是直接 `useSyncExternalStore`。
14. 文档：DESIGN 状态行/基线版本/旧布局标注；jira/README 的工具数；MIGRATION 的计划包名。
15. CLI/agent 参数词汇（`--tag`/`--all` vs `tags`/`include_closed`）纳入 parity 测试或统一。

---

## 6. 未验证事项（诚实边界）

| 判断 | 来源 | 说明 |
|---|---|---|
| memory 的 aborted-turn 缺陷 | **运行验证** | 同一测试单独重跑仍失败；根因由静态代码解释 |
| jira node 测试全绿 | **运行验证** | `pnpm run test:jira:node` → 774 passed |
| jira 组级 vitest 唯一失败是超时 | **运行验证（部分）** | 只看到 `60s` 超时，未判断是环境慢还是真实回归；该文件没有为真 Session 用例抬高 timeout |
| `toolFailure` 会触发 `ToolOutputError` | **静态阅读** | 依赖宿主 `pipeline.ts` 的 schema 校验；未写复现用例 |
| dispatch 在交付组合不可达 | **静态阅读 + 配置核对** | 未在 GUI 里实际点开 superagent 开关验证 |
| append/prompt 分支复制、N×2 重放等 superagent 内部细节 | **静态阅读（子代理）** | 未逐条复核所有行号，报告中只保留了可交叉验证的部分 |
| daemon/poll 的 teardown 影响 | **静态阅读** | 未构造“禁用时恰好有一轮 pass 在跑”的复现 |
| UI hooks 违规会崩溃 | **静态阅读** | 需要 props 从缺失变为完整才会触发；装配路径通常一次性给全 |
| 文档门禁（`verify-translation-pairing`） | **未运行** | 本机 `pnpm` 在沙箱下报 `unable to open database file`；后改 full access 只跑了测试，没有跑文档门禁 |
| 全仓 `pnpm test` | **未运行** | 工作树有 78 项与本次无关的未提交改动，跑全仓无法归因 |
| 工作树中的 session/persistence/sandbox 改动 | **未审查** | 明确不属于本次对象 |

---

## 7. 附：本次审查的证据索引（主要文件）

- memory：`packages/uitstalie/memory/src/{index,config,summary,snapshot,checkpoint,tools,commands,memory-file}.ts`、`tests/summary.spec.ts`、`tests/harness.ts`、`README.md`/`README.zh.md`
- memory UI：`packages/uitstalie/ui-memory/src/client/{MemorySection.tsx,settings.ts,index.ts}`、`src/section.ts`
- 组织者：`packages/uitstalie/dafeiyu/src/{index.ts,types.ts}`、`README.md`
- jira：`packages/jira/{jira-agent,jira-service,jira-core,jira-cli,ui-jira}/src`、`packages/jira/tests/*.spec.ts`
- 组合：`packages/bundle/web-app/{cordis.patch.uitstalie.yml,presets/jira-worker.patch.yml,package.json}`
- 文档：`packages/jira/{README,DESIGN,HANDOVER,MIGRATION,ARCHIVE-SOURCE}.md`、各包 README

> 本报告只读产出，未修改任何被审查代码或配置；未创建 commit、未 push。
