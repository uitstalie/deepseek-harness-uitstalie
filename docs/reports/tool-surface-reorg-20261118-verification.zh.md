# 工具面重排 — 验证报告（2026-11-18）

[English](tool-surface-reorg-20261118-verification.md) | 中文

`docs/reports/` 由本报告引入，作为验证报告目录。

验证对象：报告时 `cli-desktop` 的最新提交（紧接持久化记录之后的退场提交）。报告时工作树干净。

## 1. 最终动作清单

### `workspace_sessions`

来源：`packages/uitstalie/workspace-tools/src/sessions.ts`。

- 读取：`list`、`get`。
- 生命周期：`start`、`append`、`prompt`、`stop`、`abort`、`fork`、`archive`、`compact`、`delete`。
- 生命周期写入要求 `super` 角色；读取对工作区内所有 agent 开放。

### `workspace_tasks`

来源：`packages/uitstalie/workspace-tools/src/tasks.ts`。

- 动作：`list`、`get`、`create`、`update`、`receipt`。

### `workspace_message`

来源：`packages/uitstalie/workspace-tools/src/messages.ts`。

- 动作：`send`、`read`、`status`、`retry`。

### 投递失败可见与重发

- 读取失败状态是 `workspace_message.status`：返回消息的 `status`、`error`、`attempts`、引用与回执。
- 重发是 `workspace_message.retry`：用同一 message id、请求标识、正文、优先级、引用与目标重发失败消息。
- 失败测试一：`a thrown delivery failure is persisted as failed and retry delivers exactly once`（`packages/uitstalie/workspace-tools/tests/delivery.spec.ts`）。控制器抛 `target inbox is closed` 后，`status`/`read` 读回持久化的 `failed` 与 `attempts=1`；切换成功控制器后 `retry` 返回 `delivered`、`attempts=2`，同一 request id 只被接受一次。
- 失败测试二：`a declined delivery keeps its reason, advances attempts, and retry then delivers`（同文件）。覆盖 `accepted:false` 的 `recipient inbox is full`，失败重试把原因与尝试次数更新为 2，随后成功重试为 `attempts=3`。
- 命令/结果：`pnpm exec vitest run packages/uitstalie/workspace-tools --maxWorkers=2` → 41/41 通过，18:16:53–18:17:09（16 秒）。

## 2. 新增或改动的测试

| 文件 | 用例 | 结果 | 证据 |
|---|---|---|---|
| `packages/uitstalie/workspace-tools/tests/lifecycle.spec.ts` | 2 | 通过 | super agent 在工作区 B 启动后 append/prompt/stop/abort/fork/archive/compact/delete；普通 root 的每个生命周期动作都被拒绝 |
| `packages/uitstalie/workspace-tools/tests/sessions-lifecycle.spec.ts` | 7 | 通过 | 在另一个工作区 start；append/prompt 投递模式；stop/abort；fork/archive/compact/delete；无 delete API；普通 agent 拒绝 |
| `packages/uitstalie/workspace-tools/tests/delivery.spec.ts` | 11 | 通过 | 含上述两条失败/重发测试；共 11 |
| `packages/uitstalie/personality/tests/provider.spec.ts` | — | 通过 | 合并后的 `personality_apply`；不再注册 `write_like_human` |
| `packages/core/tools/tests/role-visibility.spec.ts` | 1 | 通过 | 角色矩阵移除退场名称；agent 30 / super 30 / subagent 18 |
| `packages/uitstalie/dafeiyu/tests/composition.spec.ts` | 1 | 通过 | 组合仍接入 memory/personality/store |
| `packages/client/ui-settings-general/tests/shell.client.spec.ts` | 10 | 通过 | roster 不再有 JIRA 设置段 |
| `packages/test-support/client-runtime/tests/**` | 136（135 通过 + 1 预期失败） | 通过 | 无 JIRA 行的完整 web-app roster |

本轮复跑的包级结果：

| 命令 | 用例 | 结果 | 起止 | 秒 |
|---|---|---|---|---|
| `pnpm exec vitest run packages/uitstalie/workspace-tools --maxWorkers=2` | 6 文件 / 41 | 41 通过 | 18:16:53–18:17:09 | 16 |
| `pnpm exec vitest run packages/uitstalie/personality --maxWorkers=2` | 8 文件 / 107 | 107 通过 | 18:17:12–18:17:26 | 14 |
| `pnpm exec vitest run packages/uitstalie/memory --maxWorkers=2` | 7 文件 / 116 | 116 通过 | 18:17:30–18:17:47 | 17 |
| `pnpm exec vitest run packages/core/tools/tests/role-visibility.spec.ts --maxWorkers=2` | 1 | 1 通过 | 18:17:51–18:17:57 | 6 |
| `pnpm exec vitest run packages/uitstalie/dafeiyu/tests/composition.spec.ts --maxWorkers=2` | 1 | 1 通过 | 18:18:01–18:18:11 | 10 |
| `pnpm exec vitest run packages/client/ui-settings-general/tests/shell.client.spec.ts --maxWorkers=2` | 10 | 10 通过 | 18:18:15–18:19:29 | 75 |
| `pnpm exec vitest run packages/test-support/client-runtime --maxWorkers=2` | 14 文件 / 136 | 135 通过 + 1 预期失败 | 18:19:34–18:20:30 | 56 |

## 3. 删除名称的残留证明

命令：`git grep -l -E 'superagent_control|superagent_ledger|issue_work|jira_issue|jira_kb|jira_list' -- .` → 0 个文件。覆盖源码、提示词、技能、评测集、角色矩阵与文档。

- `packages/jira` 存在：`False`。
- `packages/superagent` 存在：`False`。
- 生成目录：`packages/extensions/tool-cordis/src/api-catalog.ts` 与 `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts` 中六个名字命中 0。
- 现有构建产物：
  - `packages/uitstalie/workspace-tools/lib` 77 个文件，命中 0。
  - `packages/core/tools/lib` 45 个文件，命中 0。
  - `packages/test-support/client-runtime/lib` 81 个文件，命中 0。
  - `packages/client/ui-settings-general/lib` 78 个文件，命中 0。
  - 不存在 `packages/jira` 的构建产物。
- 全量 build 在本次窗口内通过（10/10 gate），产物中没有退场名字；`packages/jira` 无产物可检查。

## 4. 设计文档终态

`docs/design/tool-surface-reorg.md`：

- 第 5 行：状态说明 JIRA 产品退场，会话生命周期归 `workspace_sessions`，投递失败/重发归 `workspace_message`。
- 第 27 行：`## 3. Session lifecycle and delivery state move into `workspace_*``。
- 第 39 行：`workspace_message` 的 `status`/`retry` 行为。
- 第 59 行：“No parallel task or delivery API remains.”
- 旧的“两个工具暂留”结论不存在；对 `two tools|remain|暂留` 的检索没有该结论行。

`docs/design/tool-surface-reorg.zh.md`：

- 第 5 行：状态：已实现；会话生命周期由 `workspace_sessions` 承载，投递失败与重发由 `workspace_message` 承载。
- 第 27 行：`## 3. 会话生命周期与投递状态搬进 `workspace_*``。
- 第 39 行：`workspace_message` 的 `status`/`retry`。
- 第 59 行：不再保留并行的任务或投递 API。

升级指南 `docs/upgrade-guide/v0.2.2-rc.4/tool-surface-reorg/guide.md` 第 17 行：本地 JIRA 账本与派发历史“cannot be restored”。中文对侧第 17 行：“它们不可恢复”。

## 5. 合入主检出后处理（未动）

以下是运行中安装的数据，不应在本检出删除：

1. `C:\Users\TS\.dsh\dsh-jira` — 90 个文件；存在。
2. `D:\dqc\superAgent\.superagent\ledger` — 2 个文件；存在。
3. `D:\dqc\superAgent\.superagent\reports.jsonl` — 87,601 字节；存在。
4. 导出快照仍在 `D:\dqc\_exports\tool-surface-reorg-20261118`（未修改、未重导）。

运行中的 GUI 仍是旧构建，删除后仍可能重建 `.superagent` 文件；重启/升级属于合入步骤，不属于本检出。

## 6. 静态门禁（一次一条）

| 命令 | 结果 | 通过/失败 | 起止 | 秒 |
|---|---|---|---|---|
| `pnpm run typecheck` | 5/5 gate 通过 | 通过 | 18:11:07–18:12:23 | 76 |
| `pnpm run verify-config-catalog` | 3 个产物最新 | 通过 | 18:12:27–18:12:40 | 13 |
| `pnpm run verify-plugin-packages` | 最新 | 通过 | 18:12:44–18:12:53 | 9 |
| `pnpm run verify-cordis-catalog` | 133 个产物最新 | 通过 | 18:12:56–18:14:50 | 114 |
| `pnpm run verify-package-paths` | 8,302 个文件可解析 | 通过 | 18:14:55–18:15:03 | 8 |
| `pnpm run verify-upgrade-guides` | conform | 通过 | 18:15:07–18:15:10 | 3 |
| `pnpm run verify-translation-pairing` | 1,391 对一致 | 通过 | 18:15:14–18:16:49 | 95 |

本次窗口的全量结果：

| 命令 | 结果 | 起止 | 秒 |
|---|---|---|---|
| `pnpm run clean` | 移除 425 个路径 | 18:21:40–18:22:03 | 23 |
| `pnpm run build` | 10/10 gate 通过 | 18:22:07–18:29:39 | 452 |
| `pnpm run check:all` | 超过 20 分钟上限，被停止，未得到最终汇总 | 18:29:44–约 18:50 | 约 1,200 |
| `pnpm run doc-sync` | 修复后 43/43 通过 | 18:57:47–19:02:06 | 259 |
| `pnpm run test` | 超过 20 分钟上限，被停止，无最终汇总 | 19:02:10–约 19:22 | 约 1,200 |
| `pnpm run verify-persistence-formats --write` | 刷新 3 个文件 | 18:55:12–18:55:24 | 12 |
| `pnpm run verify-persistence-formats` | v0–v4 通过 | 18:55:12–18:55:24 | 12 |
| `pnpm run verify-repository-references` | 无禁止引用 | 18:55:35–18:55:47 | 12 |

`doc-sync` 的两个失败已在窗口内修复（补充持久化格式事实、从报告移除提交哈希）；修复后分别单独复跑通过。`check:all` 未完成，不能声明全量门禁通过。

## 7. 本轮未跑门禁

- `check:all` 跑到 20 分钟上限被停止，未取得最终汇总；不能声明全量通过。
- 全量 `vitest`（`pnpm test`）跑到 20 分钟上限被停止，无最终汇总；改动包的路径已逐个跑过并全过。
- `doc-sync` 修复后 43/43 通过（18:57:47–19:02:06，259 秒）。
- `verify-md-links`、`verify-package-readme-model-experience`、`verify-module-graph`、`verify-persistence-changes`：已由 43/43 的 `doc-sync` 覆盖，未再逐条复跑。

## 8. 未完成

- 运行中安装的 JIRA 账本/派发数据未删除；清单见第 5 节，必须等主检出升级/重启后处理。
- 设计终态已提交并推送，但运行中的 GUI（旧构建）在重启前仍暴露退场工具。
- 本报告不声称 `check:all` 或全量 `vitest` 全绿；它声称第 6 节列出的静态门禁、43/43 doc-sync 与包测试结果。
