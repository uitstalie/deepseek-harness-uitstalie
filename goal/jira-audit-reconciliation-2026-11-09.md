# Jira 审计对账与本轮边界（2026-11-09）

## 基线与权限

- 初始对账基于 `7174ff024d`；权限工具链完成后，本轮继续修复的基线为 `50b1714df5`，HEAD 与 `origin/cli-desktop` 一致。
- 最终实际 file policy 为 `danger-full-access`。早期沙盒阻断已在后续完全权限下用 source-only 测试复跑；没有把受阻运行写成通过。
- 审计基线 `7e844355` 之后，Jira 运行代码没有消除下表所列缺陷；`574de923a3` 的报告 journal 已存在，并已有绑定先于 prompt、requestId 对齐、重载与重复 turn-end 的测试。
- 工作树原有改动不涉及 `packages/jira`。本轮不改、不 stash、不清理无关文件。

## 主审计逐项对账

| 审计问题 | 当前状态与证据 | 本轮处理 |
|---|---|---|
| 已 returned/failed 后补 outcome/artifacts/decisions 静默丢失 | 仍存在：`dispatch-store.ts:275-309` 对非 pending 直接返回旧值，普通 `resolve` 未授权修正。 | 做：明确人工 resolve 可补充与修正，所有字段变化都持久化并投影；重复无变化不写新段。 |
| batch_close/tag_create 渲染成 ok | 仍存在：`tools.ts:194-201` 对没有 `issue.key` 的 payload 只输出 `ok`；batch 的 `partial` 和 tag 的 `committed` 不可见。 | 做：渲染 closed、partial.failed、tag、committed 及原因。 |
| 嵌套 properties/items 不递归校验，错误数组成员被吞 | 仍存在：`schema.ts:118-149` 只校验顶层；`asStringList` 将非法数组变成 undefined。 | 做：递归校验对象、数组、oneOf、required 与闭合对象，一次报告完整路径。 |
| 成功结果丢 rejected/message/partial | 仍存在：`tools.ts:158-167` 成功后不渲染警告；KB mirror.failed 也不可见。 | 做：共享成功渲染出口保留警告、partial 与 mirror 失败。 |
| jira_issue get 丢评论 | 仍存在：runner 返回 comments，`tools.ts:194-201` 固定传空数组。 | 做：渲染真实 comments，并加正文断言。 |
| jira_kb get 丢正文 | 仍存在：`tools.ts:245-251` 只渲染元数据。 | 做：复用 core 的完整 KB renderer。 |
| Markdown resolve 只查最新 100 条 | 仍存在：`superagent.ts:3455-3458` 先 limit 100 再按 id 找。 | 做：按 id 全量查最新记录；补超过 100 条的回归。 |
| dispatch list 无 matched/remaining/truncated | 仍存在：domain 与 Markdown 都直接 slice，工具只返回 entries。 | 做：两后端返回同一计数结构，模型可见文本提示 remaining。 |
| domain 只改 artifacts/decisions 不刷新 Markdown | 仍存在：`dispatch-store.ts:302-308` 只比较 status/outcome。 | 做：完整字段变化触发投影，补 Windows 实跑测试。 |
| resolve 起始状态、outcome/decisions、file 语义混乱 | 仍存在：schema 接受 pending/returned/failed，描述却只写 returned/failed；自动派发 file 是目录，手工操作 file 是文件。 | 做：限定人工 resolve 为 returned/failed，首次终结要求非空 outcome；允许终结后补充/修正；自动结果改报目录字段，具体 file 保持文件。 |
| 权限、not-found、I/O 全为 INVALID_INPUT | 仍存在：`superagent.ts:3378-3470`。 | 做：复用 READ_ONLY_SESSION、NOT_FOUND、WRITE_FAILED。 |
| 旧 claim 两笔事务留下 todo + lease | 仍存在：`superagent.ts:1262-1265` 先 assignee 后 switch_state。 | 不在本轮硬改事务模型；Phase 2 迁入任务适配器并提供单事务 claim。当前补明确风险，不宣称修复。 |
| 报告 journal 独立、绑定先于 prompt、按 requestId 对齐 | 已修：`dispatch-reports.ts` 与 `superagent.ts`；现有测试覆盖重载、错挂与重复 turn-end。 | 保留，不回退；本轮运行相关 Windows 测试。 |
| 投递与业务结果可同时 returned/failed | 仍存在：`handleTaskTurnEnd` 先 project 再 deliver；project 还以 Markdown 存在为 domain 写入前提。 | 做最小语义闭环：domain 先记录业务结果，成功投递后才更新人读投影；移除 domain 对 Markdown 的读取依赖；完整跨存储事务与失败重试列入 Phase 2。 |
| 报告 failed 不可见、不可重试、启动不恢复 | 部分修复：journal 保存 reportText/result/outcome，`report_status` 显示失败，`retry_report` 显式重投；无启动恢复扫描、ack 或 UI。 | 本轮闭环失败可见与人工重试；启动恢复、UI、多 Host 与生命周期仍归 Phase 2。 |
| superagent 控制面仍在 Jira 包 | 仍存在：`jira-agent` 强制 inject jira，service/Remote/UI 混有 superagent。 | Phase 2 只出拆包、依赖边界、迁移顺序与无 Jira 验收方案。 |

## 2026-11-07 实现审查对账

| 问题 | 当前状态与证据 | 本轮处理 |
|---|---|---|
| toolFailure 缺 me，兜底被 output schema 覆盖 | 已修：现 `sessionActionFailure` 返回 ok/error/writable/me；已有直接测试。 | 保留；本轮用真实 schema/工具路径验证相关负例。 |
| worker preset 未接交付组合 | 已有组合测试断言 `superagent_worker_preset: jira-worker`，需以最终配置对账复核运行条件。 | 不重复盲改；缺少的运行验收明确记录。 |
| README/HANDOVER 与当前实现漂移 | 多处仍存在；审计之后又只改过部分 README。 | 只更新本轮实际改变的行为及直接错误承诺；历史文档大整理不做。 |
| daemon/dispose、模块级 reportJournals、domain close 未收口 | 仍存在。 | Phase 2 生命周期方案，不在本轮混拆。 |
| create/tag commitError 上送不完整 | 仍存在：create/tag 路径没有与 mutate 相同的 rejected 细节。 | 随成功渲染修复一并补齐并测试。 |
| create/close 默认值、expected_revision、limit/top_k、技能表述 | 仍存在；最终限定范围内没有修改 expected_revision 或默认值。 | 未做：跨工具词汇统一与低风险说明留待独立文档/参数修正，不在本轮扩大。 |

## 不做与验收限制

- 不实施控制面完整拆包、不设计第二套分布式锁、不修改无关 sandbox/session 文件。
- Windows 本机只运行定向行为测试，不运行分支规则禁止的 snapshot 通道。
- 测试统一使用 `pnpm exec tsx` 的 source-only 路径；没有用旧 `lib/dist` 结果充当本轮验证，也没有运行 Windows 禁止的 snapshot 通道。
- 最终定向实测：递归 schema 9/9；renderer 与相关参数 8/8；dispatch 参数与报告恢复 13/13；journal/domain 21/21；真实 Loader/Session 组合 4/4。全量 typecheck 5/5。
- 五个相关文件合跑最初有 8 条失败：两条错误文案/git fixture 与六条 start mock 权限服务缺口均已只改测试修复。最终按同一命令复跑为 **158/158、0 fail、0 skipped**，192.83s；完整 `index.test.ts` 另跑为 35/35 通过。
- 分组 diff 按工具结果/读取、参数校验、dispatch/投影三个关注点组织；未经用户确认不提交、不 push。
- `pendingDispatchForSession` 的旧 FIFO 兼容读取仍取最多 100 条；报告 journal 的真实路由不依赖它，本轮只保证 resolve/list 的按 id 与计数语义。

## Phase 2 结构方案

### 依赖边界

1. 新建独立 superagent 控制面包，拥有 dispatch task、report journal、recipient、重试和恢复；依赖 DSH 的 workspaceRegistry、SessionController、agents、storageDomain、permission 与 question 能力，不 import Jira 类型、`ctx.jira` 或 Jira Markdown parser。
2. dispatch domain 是任务定义、执行身份与业务结果的唯一权威。Markdown 只能从 domain 再生成，不是迁移、查找或投递的前置条件。
3. report journal 只拥有 pending/delivering/delivered/failed、attempt/error/recipient 等投递事实。业务 result-ready 与投递 delivered 分别返回，不能相互冒充。
4. Jira 保留 issue/comment/KB/git 同步；旧 claim loop 移入可选任务适配器。Jira projector 只接收可选 issue 引用与投递后人读通知，缺席不影响 dispatch/report。
5. 独立 UI/Remote 使用 superagent 自有服务，不挂在 `remote.jira`；面板联合显示业务结果与投递状态，并提供失败原因、显式 retry 和人工接管。

### 迁移顺序

1. 先冻结并测试当前字段、状态转换和失败语义，抽出无 Jira 的 dispatch/report 类型与存储实现；保持旧工具适配层可用。
2. 将 session/workspace 工具、dispatch domain、report journal 和恢复循环迁到独立包；同时迁移路由、权限与生命周期测试，不在搬移时夹带行为变更。
3. 将 Remote/UI 切到 superagent 服务；Jira 侧只保留旧 issue claim 适配器与可选 projector。
4. 增加 report list/retry/ack 和启动恢复；pending/delivering 可恢复，failed 可人工重试。多 Host 在取得跨进程原子 claim 前必须明确禁止共享同一 superHome。
5. 旧 claim 用一次服务事务完成 assignee + switch_state，失败不留下活跃 lease；最后才移除旧控制面导出与 Markdown 回退。

### 验收标准

- 无 Jira composition 能完成 start/append/prompt → 业务结果 → 报告投递 → 失败重试。
- 自动 returned 后补 artifacts/decisions、failed 修正、超过 100 条旧任务均按 task id 工作；domain 与再生成 Markdown 一致。
- 投递失败时业务结果仍可查，UI/工具显示 failed 与原因；重试和重启不会重复 delivered 报告。
- abort/archive/stop 处理 pending 与 delivering，不向 archived Session 或另一 recipient 错投。
- Windows 实机覆盖路径大小写/斜杠/junction、journal 追加与重载、锁和进程退出；多宿主未具备原子 claim 时部署层拒绝第二个写者。
