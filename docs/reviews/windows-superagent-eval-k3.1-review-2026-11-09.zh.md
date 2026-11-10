# Windows super agent 评测独立复审（k3.1）

[English](windows-superagent-eval-k3.1-review-2026-11-09.md) | 中文


日期：2026-11-09。复审对象：[Windows 实机评测报告](windows-superagent-eval-2026-11-09.zh.md)及其[交接文件](windows-superagent-eval-handoff-2026-11-09.zh.md)。本复审只读原报告、源码、配置、日志和数据库；未修改原报告、生产代码或配置，未 commit/push。独立竞态复跑只创建过 `.tmp-eval/journal-race-k31-review/` 合成 journal，未完成后已终止并删除该目录。

## 1. 复审结论

**部分接受。接受 C+ 与原报告列出的四项 P0，P0 保留 4 项、降级 0 项；不接受 dispatch domain“未打开/全走 Markdown”的结论，也不接受 memory 默认检索仅为 P2 的降级。** C+ 所表达的“正常路径可用，但完整性、失败恢复和生命周期尚未闭合”与证据自洽，不要求把评级降为 C，也不支持升为 B。

四项 P0 的证据等级不同：空输出自动写 `returned` 有完整 live 因果链；跨进程 claim 有合理合成实验和确定性的源码依据，但原始 stdout 未保留，26/6 尚未由本复审独立重现；投递失败与 abort 是确定性的代码缺陷，不应标成 Windows 实机复现。实机未制造后两种失败降低的是“实机证据覆盖率”，不降低这些确定性缺陷的严重度。

最需要优先修正的三处证据问题是：

1. SQLite WAL 中已有报告截点之前的当日写入，domain 故障项属于事实错误，应撤销，而不是降级保留。
2. “历史 EPERM 未复现”只能限定到本次 ACL 探针；同机 02:22 已有 esbuild 临时文件 `Access is denied` 的构建证据，且写入者、token 与根因均未确定。
3. 26/6 缺原始竞态日志和真正双 Host 的端到端投递证据；“remount 恢复”单测只直接调用 turn-end handler，不能证明启动恢复。

## 2. 逐条 P0 核验表

| 项目 | 核验结果 | 严重度决定 | 证据需补与表述修正 |
|---|---|---|---|
| **P0-1 跨进程 claim 无原子性** | **结论保留，证据需补。** `.tmp-eval/claim-child.mjs:9-15` 每个独立 Node 进程各调用两次 `store.claim()`，只输出实际返回的 claim；父脚本 `journal-race.mjs:44-51` 对返回数组计一次，不存在父进程重复读取同一结果冒充领取。`dispatch-reports.ts:239-258` 确实是读全表后追加，`:172-176` 只串行化单实例。3000 行只是增加读成本，barrier 也不保证 12 个子进程均已完成启动。 | **保留 P0。** 两进程可合法交错并重复 claim；共享 superHome 时可使核心报告重复投递。 | 原报告未保存 26/6 的原始 stdout 或逐子进程结果，本复审无法重算原数字。独立复跑首次遇 esbuild `spawn EPERM`，文件策略调整后第 0 轮卡住约 5 分钟且 journal 未新增 claim，候选原因是子进程 stdout pipe，未单独确诊；终止后本次没有重现 26/6。应把“实机复现”精确改为“Windows 合成多进程 store 实验”，不能写成线上双 Host 已重复投递。补 barrier 就绪协议、原始结果、每个 id 的 journal attempts/最终行数，以及两个真实 Host 的 claim→deliver→settle 实验。 |
| **P0-2 空输出 turn 自动写 returned** | **证据成立。** 子 Session turn 10 的 seq 3149 是 reasoning+tool-call，seq 3160 只有 reasoning；seq 3163 为 `turn/end {turn:10, reason:{kind:"completed"}}`，没有 assistant text block。super seq 856 收到“produced no assistant text”的诊断报告；Markdown `544e144b-….md:6050,6096-6100` 在 02:12:12 自动写 returned，`:6102` 才是 02:12:52 人工 failed，super seq 911-912 与之对应。`superagent.ts:3881-3885,3923-3927` 对 completed 且无文本仍选 returned 并先投影。 | **保留 P0。** 自动业务状态可把无产出表示为 returned，人工 resolve 不修复 journal，也不能替代自动判定。 | journal 的 `delivered` 仅表示诊断消息已排队，不表示业务成功，三者不能混为同一状态。该 turn 的工具错误是否导致空输出仍属另一个根因问题；`turn/end completed` 本身不能证明用户目标失败，只能证明无文本被映射为 returned。现有空文本单测 `superagent.test.ts:909-927` 只检查诊断和 journal delivered，未断言 ledger 应为 failed/unknown，需补负例。 |
| **P0-3 投递失败不可重试、无启动恢复** | **代码与测试足以支持设计缺陷，未实机制造失败。** `superagent.ts:3938-3957` deliver=false 后 settle failed；`dispatch-reports.ts:239-249` 不领 failed；ledger resolve 只改业务台账，不能重投 journal。capability `:4477-4504` 不扫描，`:4969-4977` 只由 turn-end 进入处理。测试 `:929-948` 只验证一次失败后 warning+failed，不验证 retry/restart。 | **保留 P0。** 已完成工作的报告可成为没有恢复入口的 failed 终态，符合所给尺度“核心报告错误终结”。实机未注入失败不改变静态状态机的确定性。 | “下一次 turn-end 可恢复”须限定为相应子 Session 再次结束，且 requestId 匹配，或无 identity 时进入 FIFO；不是任意 turn-end 扫描全部积压。`:857-888` 的 remount 测试只是空 Map 下直接调用 handler，不是实际 mount/remount，更不是启动扫描。补真实接收方拒绝、进程退出、重启和无新 turn 的验收。 |
| **P0-4 abort 后继续没有新报告绑定** | **静态结论成立，必须保持未实跑标注。** `superagent.ts:3113-3169` cancel、等待 idle 后仅以新 `superagent-recover-*` requestId prompt；没有 `newDispatchReportId`、`recordDispatchReport`、ledger pending 或 task record。`:1846-1877` 单测只断言 cancel/idle/prompt/resumed，没有 journal 或报告断言。 | **保留 P0。** 公开“中止并继续”操作让新 instruction 失去任务身份和正常报告闭环。 | 旧 binding 仍可能被 aborted 旧 turn 按旧 requestId 合法领取并发送失败报告；它不会给 recovery 新 turn 建立绑定。建议“续跑不会按新任务回报”，不要写成“abort 后任何报告都绝不会出现”。补旧 turn 与 recovery 的时序、新 binding、报告恰好一次和 prompt `accepted:false` 负例。 |

### P0-1 的统计口径

报告的 `26/6` 在算法上是“6 个唯一 pending id 应各成功 claim 一次，实际子进程获得 26 个非空 claim”，不是“重复投递 26 次”。它也不是 journal 损坏计数；`0 损坏行` 只说明追加文本可解析，不证明状态转换合法。3000 个 seed id、12 个子进程和 3 轮没有覆盖崩溃、settle、接收方去重或真实 Cordis Host，因此不能外推线上故障率。

### P0-3 的恢复语义

失败可以是持久、可见的业务状态，但必须有显式 retry 或受控自动恢复；`failed` 不应等于不可再操作。启动恢复也不能无条件把所有 pending 当作“刚完成”：应从持久 turn/end 与 requestId 重建可报告结果。崩溃发生在 queue 成功而 settle 之前时，仅靠文件锁不能提供端到端 exactly-once；还需稳定报告身份、接收方幂等或明确的 at-least-once 语义。

## 3. 版本与口径问题

### 3.1 版本边界基本合格

runtime `D:\dqc\deepseek-harness-uitstalie` 与 dev 的 HEAD 均复核为 `2026-11-09 权限修复基线`；PID 5084 仍于 09:45:03 以 `node --import tsx/esm apps/cli/src/bin.ts web` 启动，runtime 工作树为 0 个 status 条目。故源码判断应以 runtime 干净树为准，不能引用 dev 未提交的 73 个 tracked 改动作为已加载行为。原报告对这一点限定清楚。

同 HEAD 仍不等于全部运行条件相同：profile、可选服务挂载时序、进程 token、日志截点与持续变化的 journal/SQLite 必须单独固定。本复审读取了实际 `web/cordis.patch.yml`、base bundle 的 storage 路由和 live Inspect；`storageDomain` 服务与 `include:storage-domain`/`include:jira-agent` 条目均存在。profile 当前 mtime 晚于启动时间，因此现存配置不能单独证明启动时每个字段的原值，需结合 bundle 与 live 行为。

### 3.2 Fedora、旧 runtime 与当前 Windows 没有系统性混用

原报告 §5 明确把 Fedora 的“根本不回传”作为旧 runtime 历史，并用当前 Windows journal 反证；没有直接把 Fedora 数字当 Windows 数字。应把“推翻旧结论”限定为：**当前 Windows runtime 的已观察 happy path 已自动回传，旧 runtime 的普遍丢报告结论不能继续套用。** 不是证明所有正常路径、重启路径或多 Host 路径均可靠。

原截点的 10 delivered/10 task-report 可复核；复审时 journal 已增长为 14 个 id、12 delivered/2 pending，super 日志也有 12 条对应当日 `[task-report]`。样本来自当天既有真实任务而非随机抽样，足以证明自动回传能力存在，但存在明显选择边界：单 Host、已绑定 superSession、无注入失败、无 abort、无重启，且包含一条无文本诊断报告。它不能支持“10/10 所以闭环完成”或“不会样本偏差”的更强结论。

### 3.3 memory 严重度与所给尺度不一致

原报告把默认 `memory_search` 不可用列为 P2，但 `goal/memory-plugin-assessment-2026-11-08.md:138-144` 明确把同一问题列为 **P1**，交接文件也将默认检索不可用列为 P1。应按该尺度恢复 P1；`memory_read` 不区分 interrupted/failed 可保持 P2。memory 报告 §6 将若干修复建议列为 P0，不等于 Windows 本轮已经复现这些故障，不应未经复测就新增实机 P0。连续 turn 摘要覆盖、stale 维护覆盖和 checkpoint 半提交是当前源码问题/既有建议，本报告至少应列为未验证缺口，而不是静默省略。

## 4. Windows 特有观察的准确性

### 4.1 dispatch domain：原结论为事实错误，应撤销 P1-1

当前只读 SQL 查询显示：`u_superagent_dispatch_dispatches` 有 **89** 行，状态为 **62 returned / 23 pending / 4 failed**，最新 `dispatchedAt=2026-11-09T02:26:14Z`，当日 **14** 行。更重要的是，当日行的时间早于报告落盘：`task-mw8lnutt` 在 01:45:59 创建、01:50:57 returned，`task-mw8lxomm` 在 02:02:01 returned，`task-mw8m5yg4` 在 02:12:52 与人工 resolve 同步变为 failed。这些不是复审后才出现的变化。

主数据库 mtime 仍为 09:31:48，但 WAL 已有约 247 KB 且持续更新。**WAL 模式下只看主库 mtime 会漏掉已提交写入。** 原报告曾记录 WAL 0 B，也不能抵消同一数据库中已经存在的当日记录。

`superagent_ledger list` 返回 Markdown 中存在的任务不能证明“Markdown 独有”。`dispatch-store.ts:179-187,204-227` 会迁移 Markdown 并同步投影；`:234-249` 的 durable 查询本来就会返回相同任务。原报告没有对 seq 863 的结果做数据源标记，也没有先查该 id 是否已在 SQLite，因而“list 返回 ⇒ store.list undefined ⇒ table undefined”的推理前提不成立。P0-2 的 SQLite 最终 failed 与 super seq 911-912 精确一致，反而证明至少该次人工 resolve 使用了 domain。

结论应为：**当前 runtime 的 domain 已打开并被 dispatch/resolve 使用；撤销“根本没打开、全程 Markdown、今日 0 条、75 行”的故障项及“接近 P0”表述。** `dispatch-store.ts:169-171` 构造时单次采样 `ctx.get('storageDomain')` 仍是静态晚到服务风险，但不是本次实机根因。可另列 P2 的“工具不暴露 domain/Markdown 来源和降级原因”；若产品要求永远使用唯一权威，再单独评估其 P1 必要性。

### 4.2 ACL 与 Low：当前状态准确，归因与历史关系需改写

只读 `icacls` 复核确认：`deepseek-harness-uitstalie-dev`、`superAgent`、`system_img` 根均有 `Everyone:(CI)(DENY)(S,DC)` 和 `Low Mandatory Level:(OI)(CI)(NW)`；`analyze` 无该 DENY 且为 Medium。这与原报告的当前状态表一致。本复审未重新创建继承探针，因此不新增“所有新文件均为 Low”的独立证明。

handoff 的“已清理”有 11-07 的现场记录：台账 `:4023-4069` 写明当时清除 15 个路径 DENY、9 个目录 Low→Medium，并在 7 个工作区验证普通权限操作；`:4075-4083` 又记录代码不再写 Low/DENY、旧后端默认禁用并 fail-closed。**当时清理成功与当前三个根再次呈现 Low+DENY 可以同时成立，不应简单说 handoff 造假或从未清理。** ACE 无时间戳，当前状态不能区分未清净、后续旧进程重写或本次打开工作区时重新施加；`analyze` 为 Medium 也不证明“未打开”是唯一原因。

因此 P1-2 可保留为“当前残留或重新出现持久 ACL/完整性副作用，写入者与时间未定”，但标题不应直接写成“Windows 沙箱仍改 ACL”。要证明归因，需要受控前后快照、实际写入日志或文件系统审计，而不是仅凭三个根的相关性。

### 4.3 EPERM：探针未复现不等于本轮没有权限故障

`.tmp-eval/acl-probe.mjs` 只覆盖根文件 write/rename/unlink、根目录 mkdir/rename/rm 及一次子文件写入。即使这些操作当时全部成功，也只能说明该 token、路径和操作集合未报错。报告“Deny DeleteChild 不生效”的表述过于绝对：继承标志、父目录 DELETE_CHILD、目标 DELETE、目录与文件差异以及 restricted token 都需分别验证，不能用根对象的 FullControl 解释所有删除路径。

同机台账 `:6294-6312,6396-6397` 已在 02:22 记录全仓 build 9/10，Web 阶段删除 `%TEMP%\esbuild-*` 时 `Access is denied`，且三次重试、改 TEMP 和脱离 Vite 的最小复现仍失败。这发生在评测报告 10:25 落盘之前，却被 §3.5 缩写成“历史 EPERM 本轮没有复现”，是重要口径遗漏。应改为：

> 本次 ACL 根目录探针未复现历史 rename EPERM；同日 Web/esbuild 删除临时文件已出现 Access denied，普通构建未通过。两类错误的进程 token、路径和根因不同，不能相互证明或否定，也不能未经证据统一归因于 Low/DENY。

建议将该构建权限故障单列 P1 环境调查；本复审独立竞态命令也观察到 esbuild `spawn EPERM`，但这只支持“当前执行环境存在权限限制”，不是对 esbuild 删除失败或沙箱写入者的根因判定。

## 5. 遗漏项与过度结论

### 5.1 应补的生命周期风险

1. **settle 失败残留 delivering**：`superagent.ts:3716-3733` 将 journal settle 写失败仅记 warning。实际已送达但 delivered 未落盘时，之后可能在 lease 后重发；启动仍不扫描。属于 P0-3 的静态扩展，不是新增实机故障。
2. **archive/stop 的 delivering 竞态**：`dispatch-reports.ts:271-279` 只处理 pending；`:4570-4607` 不等待在途 deliver/settle，归档后仍可能迟到发送。原报告写“lease 后重领”还不完整。
3. **abort 与 accepted=false**：`:3157-3168` 未检查 `admitted.accepted` 就写 `resumed:true`；正常 append/prompt 也可能在 accepted=false 后留下 pending binding。应纳入 P0-4 验收，而非只检查是否调用 prompt。
4. **recipient fallback**：`:3670-3703` 在 superSession 为空时选择最近更新的 super root Session，可能不是原派遣者。今日报告都有显式 recipient，故只是静态风险；goal 已把它列入 P0 生命周期，应作为 P0-4 关联项保留。
5. **模块级 journal owner 与 quiescence**：`:836-851` 的 `reportJournals` 是模块级 Map，`:4985-5004` dispose 不清 Map，也不等待已开始的 report 处理。应按 Cordis 生命周期单列静态风险，补 dispose 后不得迟发/迟写的确定性测试。

这些补充不改变“四项原 P0 保留”的计数；它们归入现有 P0-3/P0-4 的证据扩展，待独立复现后再决定是否新增条目。

### 5.2 其他需要修正或降限的结论

- **domain 权威缺失**：撤销，见 §4.1；不要再把 UI/Remote“必然看到两天前状态”当实机影响。
- **P2-4 与 P0-3 的可见性**：失败只写宿主 logger 对恢复而言是核心缺口，不宜仅作为低优先级可观测性点缀。P0-3 的验收必须同时断言用户/模型可见 failed、原因和 retry 入口。
- **重复台账段**：`:5347` 自动 returned 与 `:5462` 人工补充 returned 是追加式修正/投影历史，不等于同一报告重复投递。真正需要修的是后续 artifacts/decisions 在 domain 已 returned 时被 `dispatch-store.ts:282-289` 静默短路，以及投影不能重放。
- **P1-4 历史递归文件名**：当前文件存在证明历史污染，不证明当前入口仍在生成。原报告已有限定，建议保持历史数据问题，不升级为当前路由 P0。
- **测试记录**：`nodetest` 日志支持 dispatch 15/15、superagent 83/83；`vitest-dispatch.log:8-10` 实际是 “No test files found, exit 1”，不能把该通道计为通过。
- **源码注释与实现相反**：`dispatch-reports.ts:11-12` 声称 projection 在 delivered 后，`superagent.ts:3923-3950` 实际先投影再 deliver/settle；`superagent.test.ts:883` 也有相反注释。报告引用实现顺序是对的，但应把注释/测试语义漂移列为修复验收的一部分。
- **memory §4.8 文档漂移**：既有 goal 文档的中文 README 说法已被其子任务证明过时；Windows 报告继续把“memory §4.8”列为当前漂移，没有重新核对所有者。应撤销这条或改为“goal 评估自身的过时陈述”。

### 5.3 不支持的更强结论

当前证据不支持“线上已发生重复报告 26 次”“所有正常报告闭环均可靠”“domain 当前未打开”“ACL 当前一定由本次 boot 写入”“Deny DeleteChild 对所有删除均不生效”“EPERM 本轮完全不存在”“空输出等价于 turn 执行失败”“memory 默认检索只是 P2”。这些应分别按事实错误、证据不足、结论过度或表述过宽处理，而非统一降低整个评测可信度。

## 6. 建议的最终评级与下一步

### 6.1 最终评级

**维持 C+，P0 未关闭；原四项 P0 全保留，无降级。** 正常回传和当前 domain 写入是真实进步，足以反驳“Windows 报告根本回不来”和“domain 当前停用”两种说法；但重复 claim、错误业务终结、不可恢复投递和 abort 身份断裂仍阻止 B 级“闭环可靠”的判断。撤销错误的 domain P1-1 不会抵消这些核心问题。

建议最终问题口径为：P0-1～P0-4；P1 包括默认 memory 检索、当前 ACL/Low 持久副作用调查、esbuild/构建权限故障、start 部分失败、投影修正与权威一致性；domain 数据源可观测性可列 P2，单次采样只列静态生命周期风险。

### 6.2 按顺序执行的最小复现与验收

| 顺序 | 最小复现 | 必须达到的验收标准 |
|---|---|---|
| **1. P0-1** | 用独立临时 superHome，两个真实 Host 加载同一 runtime composition；用 barrier 确保双方完成启动，再对同一 pending binding 同时 turn-end。分别记录 claim 返回值、journal attempts、`[task-report]` 的 task/request identity 和接收消息数。另测 claim 后崩溃、queue 后 settle 前崩溃。 | 同一报告在正常双 Host 下只有一个有效 delivery claim；journal 不出现并发重复有效 claim。崩溃恢复明确采用幂等 exactly-once 可见效果，或明示 at-least-once 且接收方按稳定 id 去重。保存原始 stdout、逐 id 状态与 Host 身份；合成 store 压测只作补充。 |
| **2. P0-2** | 通过真实 controller 让绑定 turn 以 completed 结束但没有 text；另测 deliver=false、非 completed turn、正常 text、projection 写失败。分别读取 journal、domain、Markdown 和模型可见结果。 | 无文本不会自动成为 returned；采用 failed 或明确 unknown/needs-review，并说明原因。delivered 只表示诊断/报告送达。业务结果、投递状态、投影状态分别可见；人工 resolve 不作为自动判定通过的条件。加入会失败的 returned 断言和 projection→deliver 顺序负例。 |
| **3. P0-3** | 首次 `controller.prompt` 注入可恢复拒绝，断言 failed 可见后执行 retry；再分别制造 pending、delivering、queue 已接受但 settle 未写、进程退出，重启且不发送任何新 turn。 | 用户或 super 模型可看到失败原因与可执行 retry；retry 不复制业务任务，最终恰好一条有效报告。重启能依据持久 turn/end+requestId 恢复可报告项，无新 turn 也能收敛；无法重建的项显示 unknown/needs-person，不静默 pending。测试真实 contribution remount，而非直接调用 handler。 |
| **4. P0-4** | 在可控长 turn 中 abort，立即发送 recovery instruction；覆盖旧 aborted turn 尚未回报、已回报、recovery accepted=false、archive 与在途投递交错。 | recovery 在 prompt 前获得新 taskId、journal binding、ledger pending 和原 recipient；完成后按新 requestId 回报一次，不冒用旧 binding。旧 turn 有明确终态，归档/stop 后不再迟发；accepted=false 不显示 resumed=true，也不留下无解释 pending。 |
| **5. Windows 环境** | 对四个根保留只读 ACL 快照；在另行授权的临时目录中按 Medium/Low/restricted token、根/子目录/文件分别做 rename/delete。esbuild 失败保留具体临时文件、ACL、进程 token、TEMP 与最小命令。domain 增加只读 source/available 诊断后再验证晚到服务。 | 不使用管理员权限或改生产 ACL 也能确定触发条件；成功/失败与 token、路径、操作一一对应。构建在同一权限语境连续通过，失败保留原始错误。抓到 ACL 写入者后才能归因；domain 晚到服务可恢复或明确拒绝，不再靠 mtime/list 猜来源。 |

### 6.3 复审方法与限制

本复审完整读取了原报告、交接和三份评价尺度；核对了 runtime 的 `dispatch-reports.ts`、`superagent.ts`、`dispatch-store.ts`、相关测试、profile/base storage 路由、live Inspect、journal、Markdown、super/子 Session 原始 zstd 日志、SQLite 与只读 ACL。未重启 3080、未注入真实投递失败、未触发 abort、未改 ACL、未打开需要凭据的 UI，因此这些项目仍保持静态或未验证状态。

原 26/6 数字没有原始日志可重算；独立复跑因执行环境限制未完成，不能记作通过或复现。当前 journal/SQLite 会继续增长，本复审用当日任务 id 和时间戳区分原截点与后续状态，未把后续 12 delivered 当作原报告当时的 10 delivered。
