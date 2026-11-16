# Superagent `control` 不再到达普通 agent 会话（2026-11-14）

[English](superagent-control-role-leak-20261114.md) | 中文

状态：**已修复** — 重启后在真机复现；普通 root 分支现在完全不再产生 `control`。修复提交为 `origin/cli-desktop` 上的 `fix(jira): hide superagent_control from ordinary agent roots`。

## 现象

重启后，以 `agent` 角色运行的普通工作区会话，其模型可见工具清单里出现了 `superagent_control`；`superagent_ledger` 与 `superagent_permission` 不在。这不是从报告推断的：清单直接读取自在线会话的工具目录。

修复前的复现：

1. 打开一个普通（非 super）工作区会话，角色必须是 `agent`。
2. 读取该会话的实际工具清单（系统提示/工具目录），不是声明矩阵。
3. 看到 `superagent_control` 存在，`superagent_ledger`/`superagent_permission` 不存在。

## 代码定位

- `packages/jira/jira-agent/src/superagent.ts:5587` 定义合并工具，`name = CONTROL_TOOL_NAME`；`CONTROL_TOOL_NAME` 即 `superagent_control`（`:335`）。
- Jira capability 的分支在 `:5785-5804`：
  - executor 会话 → `[]`（DH-703）；
  - super 会话 → 五个工具，含 `control`，每个都套 `withMinRole(tool, 'super')`（`:5790-5795`）；
  - 普通 root → `source`、`scan`、`claim`、`status`、`dispatcher`，不再包含 `control`（`:5797-5803`）。
- `ToolRegistry` 只有存在 `ToolDefinition.minRole` 时才隐藏工具（`packages/core/tools/src/role.ts`）。普通分支不再产生 `control`，因此不存在依赖 role 过滤的旁路。

## 与 role 模型意图的冲突

`:5781-5784` 的注释写明了预期分工：

- DH-703：executor 会话也是 root，只靠 scope 会把 dispatcher 动词交给它；它一个都不给。
- DH-716：super agent 也是 root 且负责派单；它保留 workspace roster，丢掉会把它拉进 claim 循环的 ledger 动词。

普通工作区 root 既不是 executor，也不是 super agent，不应拿到 dispatcher/工作区管理面。已批准的 role 矩阵把 `superagent_control`、`ledger`、`deliver`、`permission` 都标为 `super`；普通分支现在与矩阵一致。

`superagent_control` 不是只读 roster 工具。它的动作是：

`roster`、`orphans`、`ensure`、`remove_workspace`、`rename_workspace`、`start`、`append`、`prompt`、`list`、`inspect`、`stop`、`abort`、`fork`、`archive`、`compact`、`delete`。

## 修复前的影响面

普通 `agent` 会话可以：

- 注册、注销或重命名工作区（`ensure`、`remove_workspace`、`rename_workspace`）；
- 在其它工作区启动会话，对它们 append/prompt/stop/abort、fork、archive 或 delete；
- 通过新的 preset compaction bridge 对别的会话触发 `compact`；
- 查看其它会话的工作区/会话状态。

这是真实的权限提升：普通工作区 agent 可以操作自己任务之外的会话和工作区。销毁动作（`remove_workspace`、`delete`）需要确认字符串，但这不是授权边界。`superagent_ledger`、`superagent_permission` 被隐藏只是因为普通分支没包含它们，而不是 role 门控保护了 `control`。

## 修复

采用方案 1：从普通 root 分支移除 `control`。普通 root 只保留 `superagent_source`、`superagent_scan`、`superagent_claim`、`superagent_status`、`superagent_dispatch`；super 分支仍是 `superagent_control`（以及其它 super-only 工具）的唯一生产者。executor 分支仍为 `[]`。没有保留“工具可见、运行时拒绝”的旁路：普通 root 既看不到也拿不到该工具。

能力现在共注册十个工具：普通 root 五个、super 专属五个，两个集合不相交。

## 测试影响

`packages/core/tools/tests/role-visibility.spec.ts` 快照的是**已批准矩阵**，不是 jira contribution 的真实接线。它本来就把 `superagent_control` 声明为 `super`，因此 `agent` 仍为 **32** 条、`super` 仍为 **36** 条；现在额外断言 agent 集合不含 `superagent_control`、super 集合含它。原记录“agent 的 32 条包含 `superagent_control`”的说法不正确。

真实接线由 `packages/jira/jira-agent/src/superagent.test.ts` 覆盖：普通 root 恰好五个名字且不含任何 super-only 工具，super agent 拿到全部五个 super 工具；新增回归测试名为 `hides every super-only workspace tool from an ordinary root`。README 的工具总数与普通 root 数量已从九/六修正为十/五。

## 范围

本记录只记录现象与已应用的修复；运行时 checkout 未重建、未重启。
