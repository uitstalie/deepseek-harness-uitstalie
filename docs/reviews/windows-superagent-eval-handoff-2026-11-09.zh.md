# Windows 上 super agent 评价交接

[English](windows-superagent-eval-handoff-2026-11-09.md) | 中文


日期：2026-11-09 用途：交给 dev 按既有评估尺度在 Windows 复测，再由 kimi k3.1 复审。 性质：**待复测的初步评价 + 证据索引**，不是最终结论。

## 0. 来源与限制

- 主要来源：本 super agent 会话 `session-ecc925ac-d736-45f2-b1f6-8e84a8abe0ec` 的可见历史与归档摘要；此前相关会话 `session-a835d6fa-92cd-4f66-8847-f335d410a6c2`。
- 评价尺度参考：
  - `goal/superagent-implementation-assessment-2026-11-08.md`
  - `goal/memory-plugin-assessment-2026-11-08.md`
  - `goal/jira-ledger-assessment-2026-11-08.md`
  - `goal/linux-sandbox-audit.md`（仅作平台差异参考）
- 三份 2026-11-08 评估的实机证据来自 Fedora，文档明确要求 Windows 复跑；本文件不把 Fedora 数字当 Windows 事实。
- 原始 session log 曾因未知事件 `agent/tool-pair-repair` 被旧读取端拒读；dev 已修复解析器，但当前运行 runtime 未必已加载该修复。因此本次以可见历史和归档摘要为准，dev 复测时应同时用新代码复读原始日志。

## 1. 初步评价（Windows，待验证）

**总体：可以完成派发、文件操作和任务执行，但“完成 → 报告 → 可见 → 可恢复”的闭环仍未证明成立；按既有尺度，P0 不能判定为已关闭。**

初步判断按文档尺度：

| 级别 | 判断 | 依据 |
|---|---|---|
| P0 | 报告/任务状态闭环仍不可靠 | 历史中多次出现任务已 completed 但 super 侧仍 pending、需手工 resolve；同一报告以不同 task id 重复到达；abort 后无新 taskId/报告绑定。 |
| P0 | Windows 沙箱副作用会破坏工作环境 | `home-write` 曾在用户目录/工作区打 Low 完整性标签，并在 workspace 根写 `Everyone:(CI)(DENY)(S,DC)`，导致普通权限 `rename` EPERM、编译必须管理员 PowerShell。旧 ACL 后端已禁用并 fail-closed。 |
| P1 | Session 路由/生命周期仍有操作成本 | 大量 untitled Session；`start` 多步失败可留下空 Session；`inspect` 只对运行中有效；monitor 仍是请求时提示，不是状态订阅。 |
| P1 | 默认检索不可用 | `session-query` 默认 `openAt: "never"`，`memory_search` 直接报 `SESSION_QUERY_SEARCH_DISABLED`；当前 Windows 同样受影响。 |
| P1 | 提问/权限与任务状态未编排 | 子 Session 的 `ask_user_question` 可取消并 abort 整轮；permission/effort 仍可能变成人工往返。 |
| P2 | 观测与文档 | 面板不显示报告投递状态；审计文档部分数字/README 条目已过时（如 memory §4.8、`superagent.ts` 行数已从 4350 变 5006）。 |

## 2. Windows 侧已观察到的证据

### 2.1 报告与台账

- 多个任务在子 Session 已完成，但 super 侧 ledger 仍 pending，最后靠人工 `resolve`。
- 同一份报告以不同 task id 重复到达；仅按 task id 去重不够，需要内容/结果身份。
- `abort` 后继续 prompt 时不产生新 taskId/报告 binding，新任务不会按新任务回传。
- monitor 只能提示“运行很久”，不能 block-until-report；长任务结束后可能没有自动回传。

### 2.2 Session 与路由

- `list` 中存在多个 untitled Session；`append` 必须显式指定 session，路由容易退化。
- `start` 的 create → selectModel → rename → bind → prompt 不是原子操作；中途失败会留下无任务 Session。
- `inspect` 对冷 Session 直接拒绝；无法用统一接口看“上次失败/上次报告/下一步”。

### 2.3 Windows 沙箱与构建

- `home-write` 曾对 `C:\Users\TS`、盘根、workspace 打 Low 完整性标签并继承到子树。
- workspace 根上的 `Everyone:(CI)(DENY)(S,DC)` 禁止删除子项，Node `fs.rename()` 因此 EPERM；`pnpm build` 必须管理员 PowerShell。
- 已现场清理 Low 标签和 DENY ACE；旧 Windows ACL 后端已禁用并 `SANDBOX_UNAVAILABLE` fail-closed。普通权限 write/rename/mkdir/unlink 已在 7 个工作区验证。
- 最新同步后全仓 `pnpm run build` 的唯一失败是本地 sandbox 测试的 4 个未使用 import（TS6133），不是远程基线或 Windows 平台问题；清理后应 10/10 gate 通过。

### 2.4 memory / 检索

- `memory_search` 默认因 `openAt: "never"` 失败，没有局部降级。
- 记忆写入量高，但真实 search/read 闭环少；自动摘要与派发结论存在重复。
- 需要 Windows 复测：文件锁、junction、ACL、真实 compaction 中断、并发写同一 MEMORY.md。

## 3. 复测矩阵（按既有尺度）

至少覆盖：

1. **报告闭环**
   - 子 Session 正常完成、无报告、报告投递失败、重复报告、abort 后继续。
   - 检查 ledger、journal、domain、UI 是否能显示同一状态；失败是否可重试/可见。
2. **生命周期**
   - `start` 在各步骤失败时的残留；`abort`/`archive` 后 pending/delivering 的处理；唯一 super Session 的 recipient 选择。
3. **Session 路由**
   - untitled/重名 Session 的 `append` 行为；显式 session 缺失时是否拒绝；`list`/`inspect` 是否能提供足够用途信息。
4. **提问/权限**
   - 子 Session `ask_user_question` 取消/超时；permission preset 是否按任务生效；effort 是否仍强制人工往返。
5. **Windows 环境**
   - ACL 清理后普通权限构建；junction/路径别名；多进程 journal；文件锁；并发写 memory。
6. **memory 检索**
   - 默认配置下 `memory_search` 行为；`memory_read` 对 aborted/failed turn 的处理；search 降级路径。

## 4. 产物要求

- Windows 评测报告：建议 `docs/reviews/windows-superagent-eval-2026-11-09.md`。
- 必须记录：runtime/HEAD、Windows 版本、是否管理员、使用的工作区、复现步骤、原始错误、P0/P1/P2 判定。
- 区分“代码已提交”“runtime 已加载”“Windows 实机复现”三种事实。
- 不修改被评测的生产代码；测试产生的临时文件放工作区临时目录，结束后清理或注明。
- kimi k3.1 复审时，重点检查：P0 是否被证据支撑、是否把 Fedora/旧 runtime 事实当 Windows 事实、报告闭环是否真正验证、是否有未复现的静态推断。

## 5. 给 dev 的一句话

先读三份评估文档的判定尺度和本文件，再在当前 Windows runtime 上按矩阵复测；不要直接沿用 Fedora 的调用统计/路径/cloudstore 结论。完成后把报告交给 kimi k3.1 做独立复审。
