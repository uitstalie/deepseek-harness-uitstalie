# super agent 变更后的审计修复覆盖

[English](audit-fix-coverage-20261110.md) | 中文

## 概述

本次复核以当前工作源码核对 2026-11-09 Windows 评测、其独立复审与 Jira 审计，不从提交说明或文件搬迁推断修复。四个原始 P0 中，三项已修、一项部分修。六个 P1 中，六项已修、0 部分修、0 无法验证；五个 P2 中，两项已修、两项部分修、一项无法验证。P 表合计 **11 已修 / 3 部分修 / 0 未修 / 1 无法验证**（P2-5）。J 表为 **18 已修 / 3 部分修（J-15、J-19、J-20）/ 0 未修**，J-16 单列不计入。

## 目录

- [证据与命令](#evidence-and-commands)
- [Windows 评测 P0 与 P1](#windows-evaluation-p0-and-p1-findings)
- [Windows 评测 P2](#windows-evaluation-p2-findings)
- [独立复审的纠正](#independent-re-review-corrections)
- [Jira 审计与五组修复](#jira-audit-and-its-five-repair-groups)
- [第 8 节验收建议](#section-8-acceptance-recommendations)
- [看似已修但证据偏弱的条目](#fixed-looking-items-with-weaker-evidence)
- [范围：仅单 Host](#scope-single-host-only)
- [开发备注](#dev-note)

<a id="scope-single-host-only"></a>
## 范围：仅单 Host

DSH 不提供 Host 间协调。`packages/api/gateway/README.md` 定义 Client-to-Host 调用与流；`packages/api/remotes/README.md` 为 Client consumers 组装类型化 Host 能力；`packages/api/remote-access/README.md` 的 Peer 指客户端主体。这些 API 不协调两个 Host。

所有权证据一致：`packages/superagent/superagent-core/README.md:58` 明确单实例不是跨进程锁；`packages/experimental/liveshare/README.md:164` 明确跨 Host 不协调、每个 home 只应有一个活跃 Owner Host；`goal/jira-ledger-assessment-2026-11-08.md:317` 描述 Windows 命名内核信号量并警告不要让两个宿主写同一 Session；`packages/schedule/schedule/tests/targets.spec.ts:480` 的 `session/writer-held` / "another Host writes it" 说明第二写者被拒。

多 Host 共享同一 home 属不支持配置；本项目唯一保证形态是单 Host，故“双 Host 端到端验证”属范围外、不是欠账。

P0-1 的范围是单 Host journal 及其每任务租约，不承诺分布式 exactly-once。P1-4 的 ACL 后端已禁用、已被替代方案超越，不再标 Partial。

<a id="evidence-and-commands"></a>
## 证据与命令

证据取自 2026-11-10 报告循环与 dispatch domain 迁包后的当前源码。本次复核没有修改实现。当前行号证明机制存在，不代表已经实机跑过真实 Host 生命周期。

主要行为命令为：

```sh
pnpm exec tsx --test --test-isolation=none packages/jira/jira-agent/src/schema.test.ts packages/jira/jira-agent/src/index.test.ts packages/jira/jira-agent/src/dispatch-reports.test.ts packages/superagent/superagent-core/src/dispatch-store.test.ts packages/jira/jira-agent/src/superagent.test.ts packages/superagent/superagent-core/src/index.test.ts
```

该命令通过 **206 tests、0 failed、0 skipped**，包含下文引用的具名测试。迁移后的 dispatch-store 路径取代旧 Jira 路径。另一次包级运行曾在 `creates a tag through the tool, then tags an issue with it` 遇到临时 Git `index.lock` 失败；测试 teardown 删除了临时目录，同一用例在上述 206 项运行中通过。这不是 dispatch 变更的证据，也没有修改 fixture 或断言。

sandbox 命令为 `pnpm exec vitest run --config .dsh/vitest-sandbox-local.config.ts`；`acl-disabled.spec.ts` 通过 **2 tests、0 failed**。这些测试注入 Windows 平台，证明拒绝且不创建 grant，不证明已有替代 Windows 隔离后端，也不证明历史 ACE 的归因。

本次没有运行进程崩溃/重启、生产失败注入、当前 Host UI 检查或 live ACL 归因实验。下文“无法验证”表示本次缺少所需证据，不否定静态代码事实。双 Host 验证超出受支持部署范围，不是欠账。

<a id="windows-evaluation-p0-and-p1-findings"></a>
## Windows 评测 P0 与 P1

| 编号 | 原结论 | 当前状态 | 证据（当前 file:line 或实跑测试） | 剩余风险 |
|---|---|---|---|---|
| P0-1 | 独立 Host 可领取并投递同一报告，因为 journal 跨进程领取不原子。 | 已修 | `packages/superagent/superagent-core/src/index.ts:202-252` 以 `wx` 获取每任务 owner/TTL 锁，只释放自己的锁；`:347-379` 在 journal claim 全程持有锁。`lets exactly one of two independent Node processes claim the same task` 实测输出 `claimed, refused; attempts=1`；`reclaims an expired claim lease after its owner disappears` 通过。 | 范围是单 Host journal 及其每任务租约，不承诺分布式 exactly-once；见[范围：仅单 Host](#scope-single-host-only)。 |
| P0-2 | 没有 assistant 文本的已完成 turn 被自动记录为 returned 业务结果。 | 已修 | `packages/jira/jira-agent/src/superagent.ts:3771-3785` 记录 `failed` 与 `empty-output` 原因；`:4211-4214` 在诊断投递后投影失败。`marks an empty completed turn failed while retaining its no-output diagnostic` 通过，断言 `result=failed`、账本 `status=failed`，不是 returned。 | 诊断仍按要求投递；不会由诊断文本推断任务成功。其他完成语义不变。 |
| P0-3 | 投递失败是不可见终态，没有重试或启动恢复。 | 部分修 | `packages/superagent/superagent-core/src/index.ts:548` 列出失败/未结算报告并仅重试已保存文本；`packages/superagent/superagent-core/src/recovery.ts:12-80` 恢复已保存的 pending/delivering 报告并处置 24h stale pending；`packages/jira/jira-agent/src/superagent.ts:5313` 启动恢复调用。`preserves a failed saved report with its failure reason on the next initialization` 保留 failed 与注入原因且零重复投递；`waits for startup recovery during dispose and preserves the original recipient` 通过。 | 真实 Host 重启仍未验证。failed 不会被静默重开；超过 24h 且无文本的 pending 现由启动恢复 settle failed 并 warn，迟到 turn-end 不再可投递。未在测试 harness 之外注入生产失败，也未测恢复超时。 |
| P0-4 | abort 后继续没有新报告绑定，未接受的恢复仍可能显示 resumed。 | 已修 | `packages/jira/jira-agent/src/superagent.ts:3274-3343` 等待 idle、记录新 request 绑定、拒绝未接受恢复并返回投递结果；`packages/superagent/superagent-core/src/dispatch-store.ts:405-416` 将旧记录保留为 orphaned。`aborts a running Session, reports the scene and continues it` 在 206 项运行中通过。 | 这是源码与定向测试证据，不是真实长 turn 崩溃/归档竞态。P0-1 与结算窗口仍可让迟到结算造成重复投递。 |
| P1-1 | dispatch domain 没有打开，所有工作都使用 Markdown。 | 已修 | 原结论已被复审撤回；当前 `packages/superagent/superagent-core/src/dispatch-store.ts:173-194` 打开组合中的 domain，`:297-306` 写入权威表。`round-trips records, arrays and statuses through the storage domain and Markdown projection` 与 `falls back to the Markdown path when no storage domain is composed` 通过。 | 这证明当前源码机制，不是新的 live Windows Host 检查。domain 可用性只在构造时采样，fallback 仍受支持。 |
| P1-2 | `start` 非原子，可能留下没有预定工作的新 Session。 | 已修 | `packages/jira/jira-agent/src/superagent.ts:3048-3146` 返回 `start.stage`（created/configured/admitted/prompted）；prompt 未准入时归档新 Session 并报告 cleanup，准入后失败保留。四条 `superagent: start stage cleanup` 测试分别覆盖权限、绑定、prompt 失败归档与准入后保留。 | 归档是 best-effort（host 无 archive API 时只报告原因），不是事务回滚；已准入的 Session 永不被清理。 |
| P1-3 | `inspect` 只对 live Session 工作，不提供有用的冷 Session 结果。 | 已修 | `packages/jira/jira-agent/src/superagent.ts` 在没有 live Agent 时使用 `sessionQuery.observeSession`，返回持久标题、最近活动时间、近期事件摘要和最近错误，并标记冷会话。`inspects a running Session and refuses an idle abort` 写入并关闭真实 JSONL fixture，再通过 query service 读取。 | 冷读是只读操作，不创建 live Agent；没有 `sessionQuery` 的部署明确报告读取器不可用。 |
| P1-4 | sandbox `home-write` 在工作区留下 Low 标签与删除拒绝 ACE。 | 已修 | ACL 后端已禁用、已被替代方案超越：`packages/sandbox/sandbox-local/src/index.ts:183/200` 让生产 Windows 链为空；`packages/sandbox/sandbox-windows-acl/src/index.ts:204-217` 拒绝旧直接后端。两个 `disabled built-in Windows ACL backend` 测试通过，且不创建 grant 或临时目录。 | 这不是部分修，也不声称存在替代 Windows 隔离；部署边界见[范围：仅单 Host](#scope-single-host-only)。 |
| P1-5 | returned 后的投影无法重放，因为 artifacts/decisions 补充被短路。 | 已修 | `packages/superagent/superagent-core/src/dispatch-store.ts:313-356` 比较完整结果并独立于投影更新 domain；`:143-155` 比较所有投影字段，`:221-234` 对变化结果进行协调。`round-trips records, arrays and statuses through the storage domain and Markdown projection`、`allows a human to correct a failed task to returned and projects the result`、`records a domain result when its Markdown task projection is missing` 通过。 | Markdown reader 仍只有固定 100 条窗口且只读直接文件（`packages/jira/jira-agent/src/dispatch-ledger.ts:337-353`）。递归清理、live 字段逐项核对与多 Host 恢复仍未验证。 |
| P1-6 | 默认 memory 检索不可用；将其降为 P2 会掩盖检索失败。 | 已修 | `packages/bundle/base/cordis.patch.yml:157-161` 与 `packages/bundle/web-app/cordis.patch.yml:27-30` 默认改为 `openAt: first-search`；`packages/uitstalie/memory/src/tools.ts:241-258` 的 `never` 指引保留。默认组合首搜实测建索引、二次命中；`refuses search in never mode` 证明 opt-out 仍拒绝，`memory_search explains a disabled...` 证明指引。 | 本机实测默认 `:memory:`：首搜约 7ms、第二次约 2ms、1 条命中；无磁盘文件（索引在内存）。durable `path` 示例：首搜 17ms、二搜 1ms、4096 B 文件。生产若需跨进程复用应配置 durable `path`。 |

<a id="windows-evaluation-p2-findings"></a>
## Windows 评测 P2

| 编号 | 原结论 | 当前状态 | 证据（当前 file:line 或实跑测试） | 剩余风险 |
|---|---|---|---|---|
| P2-1 | `superagent_ledger` 隐藏结果来自 domain 还是降级 Markdown 及原因。 | 已修 | `packages/jira/jira-agent/src/superagent.ts:3708-3730` 返回 `source: domain|markdown` 与 `degradeReason`；`:5441-5444` 在模型可见文本显示来源。`records a pending dispatch automatically, then resolves and lists it` 覆盖 Markdown 来源与渲染；J-14 用例覆盖 domain 来源。 | 服务晚到后仍不会自动重评估，但当前查询会明确标出来源/降级原因。 |
| P2-2 | 权限变更与投递失败可能静默失败或留下 orphaned pending 报告。 | 部分修（deferred：下一次大改） | `packages/jira/jira-agent/src/superagent-permission.ts:226-267` 核对生效 knob 并拒绝不完整变更；`packages/jira/jira-agent/src/superagent.ts:2987` 先绑定、`:3003`/`:3238` 将拒绝准入置 failed，`:3739-3781` 暴露已保存报告重试。`reports a committed preset only when its effective knobs match` 与 `lists a failed delivery and retries the exact saved report without another child turn` 通过。 | **下一次大改**：绑定→prompt 之间的崩溃窗口未验证；触发条件是要求崩溃后可恢复的准入；大改时把绑定与准入做成可恢复事务（WAL/两阶段）。当前拒绝准入已置 failed，不会静默 orphan。 |
| P2-3 | 陈旧 monitor、无标题 Session、默认路由和错误模型/effort 让继续工作成本高且含糊。 | 部分修（deferred：下一次大改） | `packages/jira/jira-agent/src/superagent.ts:3528-3575` 扫描标题、模型、最近任务、cwd、blank、usage 与 longRunning；`restores titles from the live Session log and marks only truly untitled rows` 验证标题恢复与 `(untitled)` 回退；路由与 preflight 测试也通过。 | **下一次大改**：monitor 仍按请求刷新，不是事件订阅；触发条件是要求实时/UI 生命周期；大改时改为订阅并在 Host UI 观测。start 的 create 顺序另见 P1-2。 |
| P2-4 | 权限、not-found 与 I/O 都变成 INVALID_INPUT，嵌套错误也不正确。 | 已修 | `packages/jira/jira-agent/src/superagent.ts:603/2824/2897/3050/3585` 使用只读/not-found 结果；`:3562-3572` 与 `:3704-3705` 使用 I/O 失败结果；`packages/jira/jira-core/src/errors.ts:80-111` 定义这些 code。206 项运行通过覆盖这些分支的 schema 与输出 envelope 测试，包括 `carries every field the output schema requires`。 | 输入校验仍有意使用 INVALID_INPUT；这不证明所有无关工具的 error 都已重分类。 |
| P2-5 | 旧 memory 文档断言及其证据映射需要纠正。 | 无法验证 | 原报告撤回了那条具体 memory 漂移断言；本次没有独立比较当前文档与实现。 | 本次没有确立当前漂移结论；默认检索问题已由 P1-6 修复（first-search）。 |

<a id="independent-re-review-corrections"></a>
## 独立复审的纠正

| 编号 | 原纠正或部分接受结论 | 当前状态 | 证据（当前 file:line 或实跑测试） | 剩余风险 |
|---|---|---|---|---|
| K-1 | 撤回错误的 domain 未开启结论；WAL 已有当日写入。 | 已修 | P1-1 引用的当前 domain 机制与测试确认纠正后的源码路径。 | 不构成新的 live Windows Host 测量。 |
| K-2 | 收窄 ACL 表述：有限探针无 EPERM 不能解释同日构建拒绝。 | 无法验证（deferred：下一次大改） | 当前源码在 `packages/sandbox/sandbox-local/src/index.ts:183/200` 禁用 Windows 链；两个 ACL-disabled 测试通过。 | **下一次大改**：live ACL 写入者/时间未定位；触发条件是重新启用 ACL 或再次复现 EPERM；大改时做 token/路径/时间取证。当前后端已禁用、fail-closed 保留，不影响现有默认组合。 |
| K-3 | 保留跨进程领取缺陷，但区分合成实验与真实双 Host 投递。 | 已修 | P0-1 现有 owner 校验的每任务文件锁，真实双进程测试恰好一个成功、一个拒绝。 | 不声称分布式 exactly-once；双 Host 端到端验证属范围外，不是欠账。 |
| K-4 | 空输出证据有效，但 delivered 诊断文本不能证明业务成功。 | 已修 | `packages/jira/jira-agent/src/superagent.ts:3771-3785` 现以 `empty-output` 记录失败；空 turn 定向测试通过。 | 诊断投递与业务结果保持分离。 |
| K-5 | 失败/重试与启动恢复曾被夸大；需要真实 remount/restart 证据。 | 部分修 | P0-3 的已保存文本重试、有界 dispose 与失败注入测试现已存在并通过。 | 真实 Host 重启仍未验证；failed 保留原因而非静默重开，24h stale pending 现 settle failed。 |
| K-6 | abort 继续需要新绑定，拒绝恢复不得声称成功。 | 已修 | P0-4 的 abort 代码与定向测试确立新绑定和未接受 prompt 的失败。 | live abort/archive 竞态与迟到投递结算仍未验证。 |
| K-7 | 可见生命周期纠正需要真实状态变化，而非只有名称。 | 已修 | `packages/superagent/superagent-core/src/dispatch-store.ts:327-356` 持久化变化，`:143-155` 比较投影字段；`allows a human to correct a failed task to returned and projects the result` 通过。 | 未测试跨进程协调与 live UI 状态。 |
| K-8 | start/stop 与恢复建议需要原子性或明确可见的部分行为。 | 已修 | `packages/jira/jira-agent/src/superagent.ts:3048-3146` 的 `start.stage` 与未准入归档给出明确可见的失败行为；`:5313` 保持有界恢复等待。`superagent: start stage cleanup` 四条测试通过。 | 归档 best-effort，已准入的 Session 保留；真实重启时序仍未验证（K-5）。 |
| K-9 | source-only、ACL、memory 与严重度的证据边界必须明确。 | 已修 | 本报告记录实际执行的 206 项与 2 项命令，未运行的 live 场景均标未验证。 | 这是文档纠正，不是新的产品行为。 |

<a id="jira-audit-and-its-five-repair-groups"></a>
## Jira 审计与五组修复

第一张表覆盖主审计的全部实质缺陷行，而不仅是五组实施项。第二张表明确标出五组。实现修复不等于建议的 Phase 2 架构已经完成。

> **2026-11-13 复核：** J 表 **18 已修 / 3 部分修（J-15、J-19、J-20）/ 0 未修**；J-16 单列为架构项（部分修），不计入这个分母。原结论列保留；证据前的 `[本轮核过]` 表示当前源码位置与测试名已核对，行为由本轮 206 项行为套件统一执行。

| 编号 | 原结论 | 当前状态 | 证据（当前 file:line 或实跑测试） | 剩余风险 |
|---|---|---|---|---|
| J-01 | returned/failed 后补 outcome、artifacts、decisions 被静默丢弃。 | 已修 | `[本轮核过]` `packages/superagent/superagent-core/src/dispatch-store.ts:327-357` 修补 domain 结果；`:144-155` 比较全部投影字段。`allows a human to correct a failed task to returned and projects the result` 与 domain 往返测试通过。 | live 协调与递归 Markdown 文件未覆盖。 |
| J-02 | batch close 与 tag 创建渲染成无信息的 ok。 | 已修 | `[本轮核过]` `packages/jira/jira-agent/src/tools.ts:97-110` 渲染 batch close 的部分失败与 tag 名称/提交状态；`:89-94` 追加 partial 警告；`:224-236` 走 issue renderer。`batch close shows partial writes` 与 `keeps create and tag commit failures visible` 通过。 | 未改锁语义；未跑 live tag 注册。 |
| J-03 | 嵌套 properties/items 与非法数组成员没有递归校验。 | 已修 | `[本轮核过]` `packages/jira/jira-core/src/schema.ts:118-190` 校验 required/未知字段、嵌套对象、oneOf 与数组成员，并给出完整路径。schema 的嵌套校验测试通过。 | 这是参数校验，不是任意持久 payload 的递归校验。 |
| J-04 | 成功结果丢失 rejected/message/partial 与 mirror 失败。 | 已修 | `[本轮核过]` `packages/jira/jira-agent/src/tools.ts:89-94` 追加 message/rejected；`:113-117` 渲染 mirror 失败。`names the unreadable file and warns that the answer is partial` 与 `shows the issue whose kb_refs could not be updated` 通过。 | renderer 不修复底层 I/O 或 mirror 失败。 |
| J-05 | issue get 丢失评论。 | 已修 | `[本轮核过]` `packages/jira/jira-agent/src/tools.ts:232-235` 把 `typed.comments` 交给 issue renderer；`shows comments returned by issue get` 通过。 | 未运行 live GitHub source 交互。 |
| J-06 | KB get 丢失正文。 | 已修 | `[本轮核过]` `packages/jira/jira-agent/src/tools.ts:268-282` 使用完整 `renderKbEntry` 并附带 mirror 失败；`starts empty, creates a knowledge entry, then reads and searches it` 通过。 | 未测试外部知识后端。 |
| J-07 | Markdown resolve 只查最近 100 条任务。 | 已修 | `[本轮核过]` `packages/jira/jira-agent/src/dispatch-ledger.ts:357-364` 用 `latestTasks` 读取全部任务并按 id 查找，不做展示切片。`finds and corrects a Markdown task older than the 100-row display window` 通过。 | 旧式 `pendingDispatchForSession` 已删除，不再保留 100 条 FIFO 路径。 |
| J-08 | dispatch list 没有 matched/remaining/truncated 计数。 | 已修 | `[本轮核过]` `packages/jira/jira-agent/src/dispatch-ledger.ts:367-388` 返回 counts/remaining/truncated/limit；domain 在 `packages/superagent/superagent-core/src/dispatch-store.ts:245-251` 复用同一 query。`returns a bounded DispatchLedgerList from query` 通过。 | 大 ledger 扫描仍有性能成本，这不是结果丢失的修复。 |
| J-09 | domain 的 artifact/decision 变化不刷新 Markdown。 | 已修 | `[本轮核过]` `packages/superagent/superagent-core/src/dispatch-store.ts:144-155` 比较全部投影字段，`:327-357` 追加变化。domain 往返与纠正测试通过。 | 未运行多进程投影竞态与 live 字段逐项比较。 |
| J-10 | resolve 允许含糊的起始状态、outcome 与 file 语义。 | 已修 | `[本轮核过]` `packages/jira/jira-agent/src/superagent.ts:3832-3875` 仅接受 returned/failed、要求首次 outcome 非空并保留纠正；返回同时带 `task` 与 `file`。纠正测试通过。 | 旧式 FIFO 查询已删；这不是对任意历史的迁移承诺。 |
| J-11 | 权限、not-found 与 I/O 全是 INVALID_INPUT。 | 已修 | `[本轮核过]` `packages/jira/jira-agent/src/superagent.ts:603` 只读写操作、`:2824` 会话写 guard 返回 `READ_ONLY_SESSION`；`:2897`/`:3050` 未登记 workspace 返回 `NOT_FOUND`；`:3585` 列表 I/O 返回 `WRITE_FAILED`。对应定向测试通过。 | 不声称所有无关工具的 error 都已重分类。 |
| J-12 | 旧 claim 第二次 mutation 失败会留下 todo 加 lease。 | 已修 | `[本轮核过]` `packages/jira/jira-service/src/index.ts:484-491` 在既有 `mutateIssue` 内用一次 core transaction 组合 `applyAssignee` + `applyTransition`；`packages/jira/jira-agent/src/superagent.ts:1446` 只调用一次 `{ action: 'claim' }`。`claims assignee and in_progress in one commit`、失败字节不变、二次 claim 拒绝三条通过。 | project write policy、锁内 blockers、CAS 与审计身份仍在原路径；不新增服务方法。 |
| J-13 | 报告绑定必须独立台账、在 prompt 前按 request id 对齐。 | 已修 | `[本轮核过]` `packages/jira/jira-agent/src/superagent.ts:1034` 定义独立 binding；`:2987`、`:3128`、`:3222` 分别在 append/start/prompt 前记录，拒绝准入时置 failed。绑定、重试、重复 turn 与恢复测试通过。 | 进程内 journal ownership 不解决 P0-1。 |
| J-14 | 业务 returned/failed 与报告投递会混淆或顺序颠倒。 | 已修 | `[本轮核过]` `packages/jira/jira-agent/src/superagent.ts:4118` 投递前以 `project:false` 记录 domain；`packages/jira/jira-agent/src/superagent.ts:4330` 是投影 helper，`:4548` 投递成功后才写人读投影。`recovers a pending report binding when the in-memory map is empty` 与空输出失败测试通过。 | 两个存储不是一个原子事务；空输出明确 failure。 |
| J-15 | 失败报告不可见、不可重试、启动不恢复。 | 部分修 | `[本轮核过]` `packages/superagent/superagent-core/src/recovery.ts:12` 定义 24h 阈值，`:55-63` 对超阈值且无 `reportText` 的 pending 记录 `settle(failed)` 并 warn；`packages/jira/jira-agent/src/superagent.ts:5313` 在启动恢复调用它。新测试 `settles a stale pending report without text as failed and warns` 覆盖 stale/fresh/saved 三态。 | 真实 Host 重启仍未验证；迟到 turn-end 的报告在阈值后无法投递，这是有意代价。 |
| J-16 | super agent 控制面仍耦合 Jira。 | 部分修（单列，不计入 18/3/0） | `[本轮核过]` `packages/jira/jira-agent/src/superagent.ts:4715` 的 dispatch/control 与 `:5135` 的 contribution 仍在 Jira 包；core 侧只有 storage/domain 的 dispatch 类型。 | 没有无 Jira 的组合 dispatch/report 生命周期，也没有独立 Remote/UI；属架构项。 |
| J-17 | 失败 envelope 缺 `me`，可能被输出 schema 拒绝。 | 已修 | `[本轮核过]` `packages/jira/jira-agent/src/envelope.ts:124` 的 failure 与 `:211` 的 okValue 都带 `me`；`carries every field the output schema requires` 通过。 | 证明 envelope 形状，不证明底层动作成功。 |
| J-18 | 交付的 worker preset 需要真实组合检查。 | 已修 | `[本轮核过]` `runs the whole loop: proposal, confirmation, claim, dispatch, delivery` 在本轮 206 项行为套件中通过，覆盖当前组合。 | 不证明独立部署 Host 的实际配置。 |
| J-19 | 历史文档与当前行为漂移。 | 部分修 | `[本轮核过]` 本节已按 2026-11-13 当前源码重写；J 表、五组表与 P0-3/A-3 的数字/行号同步更新；英文对照也同步重录 pairing。 | 其余历史文档仍不是当前实现规格；本轮没有逐份重审全部历史承诺。 |
| J-20 | daemon/dispose、模块级 journal 与 domain close 没有 quiescent teardown。 | 部分修 | `[本轮核过]` `packages/jira/jira-agent/src/superagent.ts:990-999` 明确 `reportJournals` 为进程级、文件存储不持句柄并保留的理由；`:5744` 的 dispose 等待有界恢复与 domain close。 | **有意保留**，不是已修：claim/lease + 确定性 requestId 已挡重复投递；dispose 无法取消在途 turn-end；触发条件是 Host 长期累积 root 或要求真正 quiescent teardown。真实重启/挂起恢复超时未实测。 |
| J-21 | create/tag 的 commit 失败细节不完整。 | 已修 | `[本轮核过]` `packages/jira/jira-agent/src/toolIssue.ts:168`、`:213`、`:300` 保留 commit error；`keeps create and tag commit failures visible` 通过。 | 临时 tag 锁观察仍是测试可靠性问题。 |
| J-22 | 默认值、expected_revision、limit/top_k 与 skill 表述需要统一词汇。 | 已修 | `[本轮核过]` `packages/jira/jira-agent/src/toolIssue.ts:88` 的 expected_revision 无默认值；`toolList.ts:24` 的 limit 20/100；`toolKb.ts:31` 的 top_k 10/50；`schema.test.ts:206` 的 `pins expected_revision, limit and top_k names, defaults and descriptions` 从 schema 派生默认值/上限。 | **纠正事实：`jira_kb` 没有 `limit` 参数，只有 `top_k`**；旧审计行说 `toolKb.ts:89` “保留各自 limit”是错的。 |


| 组 | 范围 | 当前状态 | 证据与剩余风险 |
|---|---|---|---|
| 五组 1 | 结果渲染：batch/tag、成功警告、issue 评论、KB 正文。 | 已修 | J-02 至 J-06；引用的 renderer 与读取测试通过。 |
| 五组 2 | 递归参数校验与完整错误路径。 | 已修 | J-03；schema 测试通过。 |
| 五组 3 | dispatch 按 id 查询、计数、纠正与全字段投影。 | 已修 | J-01、J-07 至 J-10；domain、Markdown 与纠正测试通过。旧 FIFO 有意不变。 |
| 五组 4 | 类型化 error、报告绑定、结果/投递顺序与重试可见性。 | 部分修 | J-11、J-13、J-14 已修；J-15 已补 24h stale pending 处置，但真实 Host 重启仍未验证。 |
| 五组 5 | 旧 claim 原子性、quiescent teardown 与控制面拆分。 | 部分修 | J-12 已修为单事务；J-20 有意保留（非已修）；J-16 单列为架构项。quiescent teardown 仍未实现。 |

<a id="section-8-acceptance-recommendations"></a>
## 第 8 节验收建议

| 编号 | 建议 | 当前状态 | 证据（当前 file:line 或实跑测试） | 剩余风险 |
|---|---|---|---|---|
| A-1 | 跨两个 Host 原子领取报告并 exactly-once 投递。 | 已修 | P0-1 现用 owner/TTL 每任务文件锁；双进程对抗测试证明一个成功、一个拒绝。 | 保证单 Host 所有权；双 Host 端到端验证属范围外，不是欠账。 |
| A-2 | 区分业务结果与报告投递，包括空输出。 | 已修 | P0-3 分离已保存结果与投递，P0-2 现将 `empty-output` 记为 failed。 | 不从诊断投递推断结构化成功；更广结果校验不在本次范围。 |
| A-3 | 失败投递可见、可重试，启动恢复可收敛。 | 部分修 | P0-3 提供状态、显式重试、有界 dispose 与失败注入测试，证明保留 failed 且无重复投递。 | 真实 Host 重启仍未验证；24h stale pending 与既有 reportText 恢复已覆盖，超时行为未覆盖。 |
| A-4 | abort/继续具有新绑定，且不产生虚假 resumed。 | 已修 | P0-4 当前代码与定向测试确立该行为。 | 真实归档/进行中竞态未验证。 |
| A-5 | 纠正后的任务结果可在投影中重放。 | 已修 | P1-5 的 domain/投影比较与三个当前测试确立机制。 | 递归文件与 live 多进程协调未覆盖。 |
| A-6 | start/清理在失败后不留下未工作的 Session。 | 部分修 | preflight 测试在创建前拒绝非法调用，但创建后序列仍非事务。 | 已创建 Session 的清理仍缺失。 |
| A-7 | memory 检索失败与权限/检索缺陷有当前运行时证据。 | 无法验证 | 当前源码保留直接 session-query 依赖；未运行当前默认 memory 检索。 | 未测量部署配置与实际可用性。 |
| A-8 | 历史 ACL 副作用已清理，且写入者/根因已识别。 | 已修 | ACL 后端已禁用、已被替代方案超越；两个 fail-closed 测试通过。 | 这是已解决的后端处置，不是部分修，也不声称存在替代 Windows 隔离。 |
| A-9 | domain 与 Markdown 可字段逐项协调，包括旧任务。 | 已修 | J-07/J-09 与当前测试证明超出展示窗口的 id 查询及字段变化投影。 | 兼容 reader 仍只读直接文件，旧 FIFO 仍是 100 条窗口。 |
| A-10 | 真实 remount/restart、失败注入与 Windows Host 证据覆盖生命周期。 | 无法验证 | 只执行了上述源码测试与 sandbox 测试。 | 真实 Host 重启、注入投递失败与 live UI 仍未验证；双 Host 验证属范围外。 |

<a id="fixed-looking-items-with-weaker-evidence"></a>
## 看似已修但证据偏弱的条目

- **P0-4 / K-6 / A-4：** 新绑定与拒绝准入处理直接存在，具名测试通过；但真实长 turn abort 后接崩溃、归档或迟到结算没有实跑。
- **P1-5 / K-7 / A-5 / A-9：** 当前 domain/投影测试通过，但 live 字段逐项比较与多进程恢复未运行。
- **J-18：** 真实组合测试通过，但不测量独立部署 Host 的有效配置。
- **P0-3 刻意保持部分修而非已修：** 已保存报告恢复与有界 dispose 真实存在，失败注入测试通过。真实 Host 重启仍未验证；超过 24h 的无文本 pending 现 settle failed，迟到 turn-end 不可投递。

剩余风险是真实 Host 崩溃/重启及 claim/settlement 竞态、非事务式 Session 创建和来源可观测性缺失。跨进程领取与空输出分类已有直接实现和对抗测试证据，但真实 Host 重启与生产生命周期时序仍未验证。

<a id="dev-note"></a>
## 开发备注

无。
