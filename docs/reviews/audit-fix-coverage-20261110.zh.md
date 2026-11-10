# super agent 变更后的审计修复覆盖

[English](audit-fix-coverage-20261110.md) | 中文

## 概述

本次复核以当前工作源码核对 2026-11-09 Windows 评测、其独立复审与 Jira 审计，不从提交说明或文件搬迁推断修复。四个原始 P0 中，三项已修、一项部分修。六个 P1 中，两项已修、三项部分修、一项无法验证；五个 P2 中，一项已修、三项部分修、一项无法验证。

## 目录

- [证据与命令](#evidence-and-commands)
- [Windows 评测 P0 与 P1](#windows-evaluation-p0-and-p1-findings)
- [Windows 评测 P2](#windows-evaluation-p2-findings)
- [独立复审的纠正](#independent-re-review-corrections)
- [Jira 审计与五组修复](#jira-audit-and-its-five-repair-groups)
- [第 8 节验收建议](#section-8-acceptance-recommendations)
- [看似已修但证据偏弱的条目](#fixed-looking-items-with-weaker-evidence)
- [开发备注](#dev-note)

<a id="evidence-and-commands"></a>
## 证据与命令

证据取自 2026-11-10 报告循环与 dispatch domain 迁包后的当前源码。本次复核没有修改实现。当前行号证明机制存在，不代表已经实机跑过真实 Host 生命周期。

主要行为命令为：

```sh
pnpm exec tsx --test --test-isolation=none packages/jira/jira-agent/src/schema.test.ts packages/jira/jira-agent/src/index.test.ts packages/jira/jira-agent/src/dispatch-reports.test.ts packages/superagent/superagent-core/src/dispatch-store.test.ts packages/jira/jira-agent/src/superagent.test.ts packages/superagent/superagent-core/src/index.test.ts
```

该命令通过 **175 tests、0 failed、0 skipped**，包含下文引用的具名测试。迁移后的 dispatch-store 路径取代旧 Jira 路径。另一次包级运行曾在 `creates a tag through the tool, then tags an issue with it` 遇到临时 Git `index.lock` 失败；测试 teardown 删除了临时目录，同一用例在上述 175 项运行中通过。这不是 dispatch 变更的证据，也没有修改 fixture 或断言。

sandbox 命令为 `pnpm exec vitest run --config .dsh/vitest-sandbox-local.config.ts`；`acl-disabled.spec.ts` 通过 **2 tests、0 failed**。这些测试注入 Windows 平台，证明拒绝且不创建 grant，不证明已有替代 Windows 隔离后端，也不证明历史 ACE 的归因。

本次没有运行真实双 Host 投递、进程崩溃/重启、生产失败注入、当前 Host UI 检查或 live ACL 归因实验。下文“无法验证”表示本次缺少所需证据，不否定静态代码事实。

<a id="windows-evaluation-p0-and-p1-findings"></a>
## Windows 评测 P0 与 P1

| 编号 | 原结论 | 当前状态 | 证据（当前 file:line 或实跑测试） | 剩余风险 |
|---|---|---|---|---|
| P0-1 | 独立 Host 可领取并投递同一报告，因为 journal 跨进程领取不原子。 | 已修 | `packages/superagent/superagent-core/src/index.ts:202-252` 以 `wx` 获取每任务 owner/TTL 锁，只释放自己的锁；`:347-379` 在 journal claim 全程持有锁。`lets exactly one of two independent Node processes claim the same task` 实测输出 `claimed, refused; attempts=1`；`reclaims an expired claim lease after its owner disappears` 通过。 | 对抗测试使用两个真实 Node 进程，不是两个组合 Host；共享/网络文件系统语义及 claim、投递、结算之间的崩溃仍未验证。 |
| P0-2 | 没有 assistant 文本的已完成 turn 被自动记录为 returned 业务结果。 | 已修 | `packages/jira/jira-agent/src/superagent.ts:3771-3785` 记录 `failed` 与 `empty-output` 原因；`:4211-4214` 在诊断投递后投影失败。`marks an empty completed turn failed while retaining its no-output diagnostic` 通过，断言 `result=failed`、账本 `status=failed`，不是 returned。 | 诊断仍按要求投递；不会由诊断文本推断任务成功。其他完成语义不变。 |
| P0-3 | 投递失败是不可见终态，没有重试或启动恢复。 | 部分修 | `packages/superagent/superagent-core/src/index.ts:398-413` 列出失败/未结算报告并仅重试已保存文本；`packages/superagent/superagent-core/src/recovery.ts:34-81` 恢复已保存的 pending/delivering 报告；`packages/jira/jira-agent/src/superagent.ts:5293-5312` 等待有界恢复与 domain 关闭。`preserves a failed saved report with its failure reason on the next initialization` 保留 failed 与注入原因且零重复投递；`waits for startup recovery during dispose and preserves the original recipient` 通过。 | 真实 Host 重启仍未验证。failed 不会被静默重开；无文本 pending 仍被跳过。未在测试 harness 之外注入生产失败，也未测恢复超时。 |
| P0-4 | abort 后继续没有新报告绑定，未接受的恢复仍可能显示 resumed。 | 已修 | `packages/jira/jira-agent/src/superagent.ts:3274-3343` 等待 idle、记录新 request 绑定、拒绝未接受恢复并返回投递结果；`packages/superagent/superagent-core/src/dispatch-store.ts:405-416` 将旧记录保留为 orphaned。`aborts a running Session, reports the scene and continues it` 在 175 项运行中通过。 | 这是源码与定向测试证据，不是真实长 turn 崩溃/归档竞态。P0-1 与结算窗口仍可让迟到结算造成重复投递。 |
| P1-1 | dispatch domain 没有打开，所有工作都使用 Markdown。 | 已修 | 原结论已被复审撤回；当前 `packages/superagent/superagent-core/src/dispatch-store.ts:173-194` 打开组合中的 domain，`:297-306` 写入权威表。`round-trips records, arrays and statuses through the storage domain and Markdown projection` 与 `falls back to the Markdown path when no storage domain is composed` 通过。 | 这证明当前源码机制，不是新的 live Windows Host 检查。domain 可用性只在构造时采样，fallback 仍受支持。 |
| P1-2 | `start` 非原子，可能留下没有预定工作的新 Session。 | 部分修 | `packages/jira/jira-agent/src/superagent.ts:2967-3023` 先创建 Session，再处理权限、模型、标题、绑定与 prompt；`:3044-3068` 报错但不删除已建 Session。`lists all action requirements together before doing any Session work` 与 `preflights every combined-action rule before any registry or Session write` 通过。 | 参数和组合 preflight 会在创建前拒绝，但后续创建/设置失败仍留下 Session；没有清理或事务式 start。 |
| P1-3 | `inspect` 只对 live Session 工作，不提供有用的冷 Session 结果。 | 未修 | `packages/jira/jira-agent/src/superagent.ts:3174-3184` 在 live Agent 缺失时直接拒绝；`:3185-3207` 只读取 live Agent 的活动与上轮错误。`inspects a running Session and refuses an idle abort` 通过，但不覆盖冷 Session。 | 列表能显示冷 Session，inspect 仍不能提供它的最近失败或下一步。 |
| P1-4 | sandbox `home-write` 在工作区留下 Low 标签与删除拒绝 ACE。 | 部分修 | `packages/sandbox/sandbox-local/src/index.ts:159-165` 让生产 Windows 链为空；`packages/sandbox/sandbox-windows-acl/src/index.ts:46-54` 拒绝旧直接后端。两个 `disabled built-in Windows ACL backend` 测试通过，且不创建 grant 或临时目录。 | 当前源码禁用有害后端，但没有替代 Windows 隔离，也不能证明历史标签的写入者或时间。本次未做 ACL 清理实验。 |
| P1-5 | returned 后的投影无法重放，因为 artifacts/decisions 补充被短路。 | 已修 | `packages/superagent/superagent-core/src/dispatch-store.ts:313-356` 比较完整结果并独立于投影更新 domain；`:143-155` 比较所有投影字段，`:221-234` 对变化结果进行协调。`round-trips records, arrays and statuses through the storage domain and Markdown projection`、`allows a human to correct a failed task to returned and projects the result`、`records a domain result when its Markdown task projection is missing` 通过。 | Markdown reader 仍只有固定 100 条窗口且只读直接文件（`packages/jira/jira-agent/src/dispatch-ledger.ts:337-353`）。递归清理、live 字段逐项核对与多 Host 恢复仍未验证。 |
| P1-6 | 默认 memory 检索不可用；将其降为 P2 会掩盖检索失败。 | 无法验证 | `packages/uitstalie/memory/src/tools.ts:241-262` 仍直接调用组合中的 `sessionQuery.searchSessions`，没有本地检索 fallback。本次没有运行当前默认组合的 memory 检索。 | 源码保留依赖且无 fallback；实际可用性取决于当前部署的检索配置。严重度纠正属于原评审，不是本次已证明的运行时修复。 |

<a id="windows-evaluation-p2-findings"></a>
## Windows 评测 P2

| 编号 | 原结论 | 当前状态 | 证据（当前 file:line 或实跑测试） | 剩余风险 |
|---|---|---|---|---|
| P2-1 | `superagent_ledger` 隐藏结果来自 domain 还是降级 Markdown 及原因。 | 未修 | `packages/jira/jira-agent/src/superagent.ts:3550-3563` 用同一 envelope 返回 domain 或 Markdown 查询；`packages/superagent/superagent-core/src/dispatch-store.ts:187-196` 仅打开一次 domain。 | 工具结果与投影都不标来源或降级原因；服务晚到后不会重新评估。 |
| P2-2 | 权限变更与投递失败可能静默失败或留下 orphaned pending 报告。 | 部分修 | `packages/jira/jira-agent/src/superagent-permission.ts:179-223` 核对生效 knob 并拒绝不完整变更；`packages/jira/jira-agent/src/superagent.ts:3133-3145` 将未接受的 follow-up 置失败，`:3580-3622` 暴露已保存报告重试。`reports a committed preset only when its effective knobs match` 与 `lists a failed delivery and retries the exact saved report without another child turn` 通过。 | 新绑定先于 prompt 记录，拒绝准入会置 failed，但两操作之间的崩溃未验证；未检查 UI。 |
| P2-3 | 陈旧 monitor、无标题 Session、默认路由和错误模型/effort 让继续工作成本高且含糊。 | 部分修 | `packages/jira/jira-agent/src/superagent.ts:2622-2648` 返回投递接受、实际模式与插入 seq；`:3369-3410` 暴露标题、模型、最近任务、cwd、blank 与 usage。`queues by default and falls back when interrupt meets an idle Session`、`steers an interrupt into a running Session and reports where it landed`、`preflights every combined-action rule before any registry or Session write` 通过。 | `start` 仍先创建再设置标题/模型与绑定；monitor 仍按请求刷新，不是订阅；未观察 Host UI。 |
| P2-4 | 权限、not-found 与 I/O 都变成 INVALID_INPUT，嵌套错误也不正确。 | 已修 | `packages/jira/jira-agent/src/superagent.ts:3576-3587` 使用只读/not-found 结果；`:3562-3572` 与 `:3704-3705` 使用 I/O 失败结果；`packages/jira/jira-core/src/errors.ts:80-111` 定义这些 code。175 项运行通过覆盖这些分支的 schema 与输出 envelope 测试，包括 `carries every field the output schema requires`。 | 输入校验仍有意使用 INVALID_INPUT；这不证明所有无关工具的 error 都已重分类。 |
| P2-5 | 旧 memory 文档断言及其证据映射需要纠正。 | 无法验证 | 原报告撤回了那条具体 memory 漂移断言；本次没有独立比较当前文档与实现。 | 本次没有确立当前漂移结论；默认检索问题另见 P1-6。 |

<a id="independent-re-review-corrections"></a>
## 独立复审的纠正

| 编号 | 原纠正或部分接受结论 | 当前状态 | 证据（当前 file:line 或实跑测试） | 剩余风险 |
|---|---|---|---|---|
| K-1 | 撤回错误的 domain 未开启结论；WAL 已有当日写入。 | 已修 | P1-1 引用的当前 domain 机制与测试确认纠正后的源码路径。 | 不构成新的 live Windows Host 测量。 |
| K-2 | 收窄 ACL 表述：有限探针无 EPERM 不能解释同日构建拒绝。 | 无法验证 | 当前源码在 `packages/sandbox/sandbox-local/src/index.ts:159-165` 禁用 Windows 链；两个 ACL-disabled 测试通过。 | 本次未调查 live ACL 写入者、进程 token、时间戳或构建失败。 |
| K-3 | 保留跨进程领取缺陷，但区分合成实验与真实双 Host 投递。 | 已修 | P0-1 现有 owner 校验的每任务文件锁，真实双进程测试恰好一个成功、一个拒绝。 | 两个组合 Host 与崩溃时投递/结算竞态未验证；不声称分布式 exactly-once。 |
| K-4 | 空输出证据有效，但 delivered 诊断文本不能证明业务成功。 | 已修 | `packages/jira/jira-agent/src/superagent.ts:3771-3785` 现以 `empty-output` 记录失败；空 turn 定向测试通过。 | 诊断投递与业务结果保持分离。 |
| K-5 | 失败/重试与启动恢复曾被夸大；需要真实 remount/restart 证据。 | 部分修 | P0-3 的已保存文本重试、有界 dispose 与失败注入测试现已存在并通过。 | 真实 Host 重启仍未验证；failed 保留原因而非静默重开。 |
| K-6 | abort 继续需要新绑定，拒绝恢复不得声称成功。 | 已修 | P0-4 的 abort 代码与定向测试确立新绑定和未接受 prompt 的失败。 | live abort/archive 竞态与迟到投递结算仍未验证。 |
| K-7 | 可见生命周期纠正需要真实状态变化，而非只有名称。 | 已修 | `packages/superagent/superagent-core/src/dispatch-store.ts:327-356` 持久化变化，`:143-155` 比较投影字段；`allows a human to correct a failed task to returned and projects the result` 通过。 | 未测试跨进程协调与 live UI 状态。 |
| K-8 | start/stop 与恢复建议需要原子性或明确可见的部分行为。 | 部分修 | preflight 测试通过，但 `packages/jira/jira-agent/src/superagent.ts:2991-3023` 的创建后设置仍非事务；`:5293-5312` 现有有界恢复等待。 | 已创建但未工作的 Session 与真实重启时序仍未验证。 |
| K-9 | source-only、ACL、memory 与严重度的证据边界必须明确。 | 已修 | 本报告记录实际执行的 175 项与 2 项命令，未运行的 live 场景均标未验证。 | 这是文档纠正，不是新的产品行为。 |

<a id="jira-audit-and-its-five-repair-groups"></a>
## Jira 审计与五组修复

第一张表覆盖主审计的全部实质缺陷行，而不仅是五组实施项。第二张表明确标出五组。实现修复不等于建议的 Phase 2 架构已经完成。

| 编号 | 原结论 | 当前状态 | 证据（当前 file:line 或实跑测试） | 剩余风险 |
|---|---|---|---|---|
| J-01 | returned/failed 后补 outcome、artifacts、decisions 被静默丢弃。 | 已修 | `packages/superagent/superagent-core/src/dispatch-store.ts:327-356` 修补 domain 结果；`:143-155` 比较全部投影字段。人工纠正与 domain 往返测试通过。 | live 协调与递归 Markdown 文件未覆盖。 |
| J-02 | batch close 与 tag 创建渲染成无信息的 ok。 | 已修 | `packages/jira/jira-agent/src/tools.ts:198-201` 渲染部分失败；`:241-248` 渲染 tag 名称与提交状态。`batch close shows partial writes` 与 `keeps create and tag commit failures visible` 通过。 | 包级运行曾出现无关的临时 tag 锁失败；teardown 删除临时目录后，同项在引用运行中通过；未改锁语义。 |
| J-03 | 嵌套 properties/items 与非法数组成员没有递归校验。 | 已修 | `packages/jira/jira-core/src/schema.ts:118-190` 校验 required/未知字段、嵌套对象、oneOf 与数组成员，并给出完整路径。schema 的嵌套校验测试通过。 | 这是参数校验，不是任意持久 payload 的递归校验。 |
| J-04 | 成功结果丢失 rejected/message/partial 与 mirror 失败。 | 已修 | `packages/jira/jira-agent/src/tools.ts:176-193` 追加 partial 消息、rejected 原因与 mirror 失败。`names the unreadable file and warns that the answer is partial` 与 `shows the issue whose kb_refs could not be updated` 通过。 | renderer 不修复底层 I/O 或 mirror 失败。 |
| J-05 | issue get 丢失评论。 | 已修 | `packages/jira/jira-agent/src/tools.ts:198-201` 选择真实 comments 字段；`shows comments returned by issue get` 通过。 | 未运行 live GitHub source 交互。 |
| J-06 | KB get 丢失正文。 | 已修 | `packages/jira/jira-agent/src/tools.ts:258-266` 使用完整 KB renderer；`starts empty, creates a knowledge entry, then reads and searches it` 通过。 | 未测试外部知识后端。 |
| J-07 | Markdown resolve 只查最近 100 条任务。 | 已修 | `packages/jira/jira-agent/src/dispatch-ledger.ts:336-364` 读取所有直接 ledger 文件并按 id 查找，不做展示切片。`finds and corrects a Markdown task older than the 100-row display window` 通过。 | `pendingDispatchForSession` 有意保留旧式 100 条 FIFO 限制（`packages/jira/jira-agent/src/superagent.ts:3910-3915`）；报告使用 request id。 |
| J-08 | dispatch list 没有 matched/remaining/truncated 计数。 | 已修 | `packages/jira/jira-agent/src/dispatch-ledger.ts:366-387` 返回 counts、remaining、truncation 与 limit；domain 在 `packages/superagent/superagent-core/src/dispatch-store.ts:218-234` 使用同一结构。`returns a bounded DispatchLedgerList from query` 通过。 | 大 ledger 扫描仍有性能成本，这不是结果丢失的修复。 |
| J-09 | domain 的 artifact/decision 变化不刷新 Markdown。 | 已修 | `packages/superagent/superagent-core/src/dispatch-store.ts:143-155` 比较全部投影字段，`:327-356` 追加变化。domain 往返与纠正测试通过。 | 未运行多进程投影竞态与 live 字段逐项比较。 |
| J-10 | resolve 允许含糊的起始状态、outcome 与 file 语义。 | 已修 | `packages/jira/jira-agent/src/superagent.ts:3664-3695` 仅接受 returned/failed、要求首次 outcome 非空并保留纠正；`:1070-1080` 同时提供目录与文件字段。纠正测试通过。 | 独立旧式 FIFO 查询仍有限制，见 J-07。 |
| J-11 | 权限、not-found 与 I/O 全是 INVALID_INPUT。 | 已修 | P2-4 引用的当前构造器与分支区分 READ_ONLY_SESSION、NOT_FOUND 与 WRITE_FAILED；类型化 error 与输出 envelope 测试通过。 | 本次不声称已审计所有无关 error 位置。 |
| J-12 | 旧 claim 第二次 mutation 失败会留下 todo 加 lease。 | 未修 | `packages/jira/jira-agent/src/superagent.ts:1390-1393` 仍将 assignee 与 switch_state 作为两次 mutation。 | 单事务 claim 尚未实现。 |
| J-13 | 报告绑定必须独立台账、在 prompt 前按 request id 对齐。 | 已修 | `packages/jira/jira-agent/src/superagent.ts:982-1007` 记录独立绑定；`:3107-3145` 在 follow-up 准入前绑定并将拒绝置失败；`:3021-3026` 在 start prompt 前绑定。绑定、重试、重复 turn 与恢复测试通过。 | 进程内 journal ownership 不解决 P0-1。 |
| J-14 | 业务 returned/failed 与报告投递会混淆或顺序颠倒。 | 已修 | `packages/jira/jira-agent/src/superagent.ts:3771-3785` 在投递前保存业务结果；`:4211-4214` 在结算后追加人读投影。`recovers a pending report binding when the in-memory map is empty` 与空输出失败测试通过。 | 两个存储不是一个原子事务；空输出现在明确失败。 |
| J-15 | 失败报告不可见、不可重试、启动不恢复。 | 部分修 | P0-3 的当前状态/重试与有界启动路径已实现，定向测试通过。 | 未保存的 pending 与真实进程/Host 恢复仍未验证。 |
| J-16 | super agent 控制面仍耦合 Jira。 | 部分修 | `packages/superagent/superagent-core/src/dispatch-types.ts:1-71` 定义无 Jira 类型，`packages/superagent/superagent-core/src/dispatch-store.ts:13-18` 仅依赖 storage/domain；Jira 包仍在 `packages/jira/jira-agent/src/superagent.ts:4750-5308` 承担控制编排。 | 没有无 Jira 的组合 dispatch/report 生命周期，也没有独立 Remote/UI。 |
| J-17 | 失败 envelope 缺 `me`，可能被输出 schema 拒绝。 | 已修 | `packages/jira/jira-agent/src/superagent.ts:2622-2648` 构造结果 envelope；`carries every field the output schema requires` 通过。 | 这证明 envelope 形状，不证明底层动作成功。 |
| J-18 | 交付的 worker preset 需要真实组合检查。 | 已修 | `runs the whole loop: proposal, confirmation, claim, dispatch, delivery` 在 175 项运行中通过，覆盖当前组合。 | 不证明独立部署 Host 的实际配置。 |
| J-19 | 历史文档与当前行为漂移。 | 部分修 | 当前包与评审文档已同步，前置文档工作中的配对门通过；本次没有重新审计每项历史承诺。 | 历史文档仍是历史记录，不是当前实现规格。 |
| J-20 | daemon/dispose、模块级 journal 与 domain close 没有 quiescent teardown。 | 部分修 | `packages/jira/jira-agent/src/superagent.ts:5293-5312` 现在等待有界恢复与 domain 关闭，恢复/dispose 测试通过。进程级 journal map 仍在 `:946-961`。 | 真实 Host 重启与挂起恢复的超时未实测。 |
| J-21 | create/tag 的 commit 失败细节不完整。 | 已修 | `packages/jira/jira-agent/src/toolIssue.ts:161-170` 与 `:213-215` 保留 commit error；`keeps create and tag commit failures visible` 通过。 | 独立的临时 tag 锁观察仍是测试可靠性问题。 |
| J-22 | 默认值、expected_revision、limit/top_k 与 skill 表述需要统一词汇。 | 部分修 | `packages/jira/jira-agent/src/toolIssue.ts:286-298` 保留 expected_revision；`packages/jira/jira-agent/src/toolList.ts:90-109` 与 `toolKb.ts:89` 保留各自 limit。 | 原先合并的低风险词汇工作明确未完成；未做完整措辞审计。 |

| 组 | 范围 | 当前状态 | 证据与剩余风险 |
|---|---|---|---|
| 五组 1 | 结果渲染：batch/tag、成功警告、issue 评论、KB 正文。 | 已修 | J-02 至 J-06；引用的 renderer 与读取测试通过。 |
| 五组 2 | 递归参数校验与完整错误路径。 | 已修 | J-03；schema 测试通过。 |
| 五组 3 | dispatch 按 id 查询、计数、纠正与全字段投影。 | 已修 | J-01、J-07 至 J-10；domain、Markdown 与纠正测试通过。旧 FIFO 有意不变。 |
| 五组 4 | 类型化 error、报告绑定、结果/投递顺序与重试可见性。 | 部分修 | J-11、J-13 至 J-15；类型化 error 与绑定已修，恢复与生命周期覆盖仍不完整。 |
| 五组 5 | 旧 claim 原子性、quiescent teardown 与控制面拆分。 | 未修 | J-12、J-16、J-20。仍是架构与生命周期工作，不是完成的修复。 |

<a id="section-8-acceptance-recommendations"></a>
## 第 8 节验收建议

| 编号 | 建议 | 当前状态 | 证据（当前 file:line 或实跑测试） | 剩余风险 |
|---|---|---|---|---|
| A-1 | 跨两个 Host 原子领取报告并 exactly-once 投递。 | 已修 | P0-1 现用 owner/TTL 每任务文件锁；双进程对抗测试证明一个成功、一个拒绝。 | 真实 Host 级 exactly-once 投递与崩溃结算仍未验证。 |
| A-2 | 区分业务结果与报告投递，包括空输出。 | 已修 | P0-3 分离已保存结果与投递，P0-2 现将 `empty-output` 记为 failed。 | 不从诊断投递推断结构化成功；更广结果校验不在本次范围。 |
| A-3 | 失败投递可见、可重试，启动恢复可收敛。 | 部分修 | P0-3 提供状态、显式重试、有界 dispose 与失败注入测试，证明保留 failed 且无重复投递。 | 真实 Host 重启仍未验证；未保存 pending 重建与超时行为未覆盖。 |
| A-4 | abort/继续具有新绑定，且不产生虚假 resumed。 | 已修 | P0-4 当前代码与定向测试确立该行为。 | 真实归档/进行中竞态未验证。 |
| A-5 | 纠正后的任务结果可在投影中重放。 | 已修 | P1-5 的 domain/投影比较与三个当前测试确立机制。 | 递归文件与 live 多进程协调未覆盖。 |
| A-6 | start/清理在失败后不留下未工作的 Session。 | 部分修 | preflight 测试在创建前拒绝非法调用，但创建后序列仍非事务。 | 已创建 Session 的清理仍缺失。 |
| A-7 | memory 检索失败与权限/检索缺陷有当前运行时证据。 | 无法验证 | 当前源码保留直接 session-query 依赖；未运行当前默认 memory 检索。 | 未测量部署配置与实际可用性。 |
| A-8 | 历史 ACL 副作用已清理，且写入者/根因已识别。 | 部分修 | 有害后端禁用，两个 fail-closed 测试通过。 | 未调查历史残留与归因；没有替代后端。 |
| A-9 | domain 与 Markdown 可字段逐项协调，包括旧任务。 | 已修 | J-07/J-09 与当前测试证明超出展示窗口的 id 查询及字段变化投影。 | 兼容 reader 仍只读直接文件，旧 FIFO 仍是 100 条窗口。 |
| A-10 | 真实 remount/restart、失败注入与 Windows Host 证据覆盖生命周期。 | 无法验证 | 只执行了上述源码测试与 sandbox 测试。 | 没有真实 Host 重启、注入投递失败、live UI 或双 Host 证据。 |

<a id="fixed-looking-items-with-weaker-evidence"></a>
## 看似已修但证据偏弱的条目

- **P0-4 / K-6 / A-4：** 新绑定与拒绝准入处理直接存在，具名测试通过；但真实长 turn abort 后接崩溃、归档或迟到结算没有实跑。
- **P1-3 未修：** 列表暴露了更多字段，但 `inspect` 仍拒绝没有 live Agent 的 Session；运行中 Session 测试不覆盖冷 Session。
- **P1-5 / K-7 / A-5 / A-9：** 当前 domain/投影测试通过，但 live 字段逐项比较与多进程恢复未运行。
- **J-18：** 真实组合测试通过，但不测量独立部署 Host 的有效配置。
- **P0-3 刻意保持部分修而非已修：** 已保存报告恢复与有界 dispose 真实存在，失败注入测试通过。真实 Host 重启仍未验证；没有文本的 pending 绑定仍被跳过。

剩余风险是真实 Host 崩溃/重启及 claim/settlement 竞态、非事务式 Session 创建和来源可观测性缺失。跨进程领取与空输出分类已有直接实现和对抗测试证据，但真实 Host 重启与生产生命周期时序仍未验证。

<a id="dev-note"></a>
## 开发备注

无。
