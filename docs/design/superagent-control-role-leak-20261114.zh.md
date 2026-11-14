# Superagent `control` 泄漏给普通 agent 会话（2026-11-14）

[English](superagent-control-role-leak-20261114.md) | 中文

状态：**open** — 重启后在真机复现；本次只写文档，未在本机修复。

## 现象

重启后，以 `agent` 角色运行的普通工作区会话，其模型可见工具清单里出现了 `superagent_control`；`superagent_ledger` 与 `superagent_permission` 不在。这不是从报告推断的：清单直接读取自在线会话的工具目录。

复现：

1. 打开一个普通（非 super）工作区会话，角色必须是 `agent`。
2. 读取该会话的实际工具清单（系统提示/工具目录），不是声明矩阵。
3. 看到 `superagent_control` 存在，`superagent_ledger`/`superagent_permission` 不存在。

## 代码定位

- `packages/jira/jira-agent/src/superagent.ts:5586-5587` 定义合并工具，`name = CONTROL_TOOL_NAME`；`CONTROL_TOOL_NAME` 即 `superagent_control`（`:335`）。
- Jira capability 的分支在 `:5781-5805`：
  - executor 会话 → `[]`（DH-703）；
  - super 会话 → 五个工具，含 `control`，每个都套 `withMinRole(tool, 'super')`（`:5789-5795`）；
  - 普通 root → `source`、`scan`、`claim`、`control`、`status`、`dispatcher`，**没有 `minRole`**（`:5796-5803`）。
- `ToolRegistry` 只有存在 `ToolDefinition.minRole` 时才隐藏工具（`packages/core/tools/src/role.ts`）；普通分支从未声明它，role 过滤无法移除 `control`。

## 与 role 模型意图的冲突

`:5781-5785` 的注释写明了预期分工：

- DH-703：executor 会话也是 root，只靠 scope 会把 dispatcher 动词交给它；它一个都不给。
- DH-716：super agent 也是 root 且负责派单；它保留 workspace roster，丢掉会把它拉进 claim 循环的 ledger 动词。

普通工作区 root 既不是 executor，也不是 super agent，不应拿到 dispatcher/工作区管理面。已批准的 role 矩阵把 `superagent_control`、`ledger`、`deliver`、`permission` 都标为 `super`；普通分支与矩阵矛盾。

`superagent_control` 不是只读 roster 工具。它的动作是：

`roster`、`orphans`、`ensure`、`remove_workspace`、`rename_workspace`、`start`、`append`、`prompt`、`list`、`inspect`、`stop`、`abort`、`fork`、`archive`、`compact`、`delete`。

## 影响面

普通 `agent` 会话可以：

- 注册、注销或重命名工作区（`ensure`、`remove_workspace`、`rename_workspace`）；
- 在其它工作区启动会话，对它们 append/prompt/stop/abort、fork、archive 或 delete；
- 通过新的 preset compaction bridge 对别的会话触发 `compact`；
- 查看其它会话的工作区/会话状态。

这是真实的权限提升：普通工作区 agent 可以操作自己任务之外的会话和工作区。销毁动作（`remove_workspace`、`delete`）需要确认字符串，但这不是授权边界。`superagent_ledger`、`superagent_permission` 被隐藏只是因为普通分支没包含它们，而不是 role 门控保护了 `control`。

## 修复选项与决策点

本 checkout 有意不修。选项：

1. **从普通分支移除 `control`（推荐）。** 普通 root 只保留自己的 jira 工具；super 分支继续是 `control` 的唯一生产者。恢复 DH-716 原意。
2. **拆工具。** 普通 root 只保留窄的只读 roster/list，所有生命周期/工作区写动作移到 super-only 工具。需要决定普通 root 是否还需要任何 roster 可见性。
3. **保留可见、运行时校验。** 这仍会在工具目录里泄漏能力，并继续宣传 role 模型认为不该存在的动作面；只能当临时防御，不是矩阵修复。

需要人决策：普通 root 是否需要 workspace roster 的任何部分，还是不应得到 `superagent_control` 的任何动词？DH-703/DH-716 的注释倾向 **一个都不给**。

## 测试影响

`packages/core/tools/tests/role-visibility.spec.ts` 当前断言 `agent` 快照 **32** 条，包含 `superagent_control`；`super` 是 36 条。按选项 1 从普通分支移除 `control` 后，agent 集合变为 **31**，必须更新预期条数与集合。拆分工具会得到另一组名字。未决定产品行为前不要改快照。

## 范围

本记录只记录现象与代码路径；不改变实现、测试、快照、profile 或运行时。接力机器需实现选定方案、增加“普通 agent 看不到也不能调用 super-only 面”的回归测试，并重建/重启。
