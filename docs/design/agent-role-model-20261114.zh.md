# Agent 角色模型与工具矩阵草案（2026-11-14）

[English](agent-role-model-20261114.md) | 中文

状态：**角色字段、section 门控以及已批准的工具门槛均已实现。** 工具可见性由工具注册表统一执行一次；JIRA 与 super agent 专用工具已退场，已批准矩阵的每一行都在 `agent` 或更低角色上。已批准矩阵快照为 `subagent`/`agent`/`super` 各 18/30/30 条（`packages/core/tools/tests/role-visibility.spec.ts`）。工作区工具集的写动作已对工作区内 agent 开放，跨工作区写仍要求 super agent。

## 1. 角色分类

| 角色 | 含义 |
|---|---|
| `subagent` | 被委派的子级，或任何具有子级血缘的 Session；权限最小。 |
| `agent` | 普通的 root/workspace Session；承担常规工作。 |
| `super` | 从超级工作区派发工作的 super-agent 根；权限最大，承担跨工作区写的角色门控。 |

角色类型与读取函数位于 `packages/core/agent/src/runtime-types.ts` 和 `packages/core/agent/src/role.ts`：`AgentRole`、`agentRoleOf`。feature 包通过 `@deepseek-ai/dsh-tools`（`withMinRole` / `toolMinRole`）声明工具门槛；没有任何 feature 包为角色而 import dafeiyu。organizer 只负责把工具挂到 agent 上，角色过滤由工具注册表执行。

## 2. 声明来源与默认值

- 持久来源是 Workspace 记录的 `role` 字段（`agent` 或 `super`；缺省/未知 -> `agent`）。`SessionController.createSession` 按 canonical cwd 解析并合并进 `agentOptions`；客户端请求体不能设置它。
- 解析是精确的 canonical workspace 路径匹配（`workspaceRegistry.resolveByPath`）；cwd 位于 `super` 工作区子目录的 Session 不会继承该角色，会落回 `agent`。
- 普通 workspace 默认 `agent`；super workspace 在 Workspace store 里一次性标记为 `super`（`<DSH_HOME>/storages/workspace.json`，表 `workspaces`，字段 `role`）。没有该字段的旧记录保持 `agent`；任何非 `super` 的值也解析为 `agent`。模型其余部分读取的仍是 `agent.options.role`。
- 未声明的 **root** 解析为 `agent`，而不是 `super`。这是普通 workspace Session 的安全默认值：`super` 从不被隐式授予，而 root 必须保留正常的 workspace 能力才能运作。
- 未声明的 **child** 会解析为 `subagent`，其依据是持久血缘（`origin: 'subagent'`、`parentSession` 或 `delegationDepth > 0`）。子级血缘优先于已声明的值，因此子级无法自我提升。
- `agent.options.role` 是运行时的 agent 配置。恢复 Session 时会从 Workspace 记录重新解析角色；持久角色在 Workspace 上，不在 Session header 上。

## 3. 父子规则

`agentRoleOf` 首先检查血缘；如果该 Agent 是子级，则返回 `subagent`，无论 `agent.options.role` 为何。因此 subagent **不是**其父级的 super 能力副本，也无法选择加入 `super`。未声明的普通 root 是 `agent`；只有声明 `super` 的 root 才能获得 super 角色。

## 4. 现有隐式判断与未来替换

| 当前判断 | 位置 | 未来的角色替换 |
|---|---|---|
| 能力 `scope: 'root'` | `dafeiyu/src/api.ts:325` | 非工具资源保留 scope；工具可见性由注册表的 `minRole` 执行。 |
| Personality 工具过滤 | `personality/src/api.ts:120` | 已迁移：analyze 声明 `minRole: subagent`，apply 声明 `minRole: agent`。 |
| Memory 能力 scope | `memory/src/tools.ts:42-44` | 已迁移：三个记忆工具各自声明 `minRole`。 |
| Schedule 运行时拒绝 | `schedule/tool-schedule/src/index.ts:298-315` | subagent 调用仍被运行时拒绝；可见性由 `minRole` 给出。 |

角色字段是共享来源；工具可见性统一由注册表的 `minRole` 执行，非工具判断保留在各自能力里。

## 5. 690 门控与配额

- 对 `subagent` 会省略 section 690；普通 root 与 super root 使用彼此独立的 `OUTPUT_STYLE.yaml` 和 `SUPERAGENT_OUTPUT_STYLE.yaml` 槽位。现有的普通文件继续照常工作。
- 写入规则：100 条规则 / 240 字符 / 共 32 KiB；只有前 40 条已启用的规则会常驻。第 41 条会被省略并附上 `N rule(s) not injected: resident limit is 40.`；不做检索。这些已实现并通过测试。

## 6. 工具矩阵草案

“当前”指本代码树中执行的可见性；标记为“新增”的行是在本轮迁移的。JIRA 与 super agent 专用工具已退场；JIRA 只保留 GitHub 上的 cloudstore 数据仓，按数据原样保留，不接入任何工具或流程，不作为设计能力，也不需要凭据或 remote 接入说明。

| 工具族 | 当前可见性（过滤位置） | 建议角色 | 理由 | subagent 会失去什么 |
|---|---|---|---|---|
| `personality_analyze` | 所有 agent；`personality/src/api.ts:120` | `subagent`+ | 只读研究 | 无 |
| `personality_apply` / `write_like_human` | 排除 subagent；`personality/src/api.ts:120` | `agent`+ | 全局写入 | 无写权限（本来就没有） |
| `tool-dsh-store` | agent+（新增）；`minRole: agent` | `agent` | 规则/技能管理 | 对 subagent 隐藏 |
| `memory_write` / `memory_forget` | agent+（新增）；`memory/src/tools.ts:42-43` `minRole: agent` | `agent` | 单一写入者 | 无写权限（新近隐藏） |
| `memory_search` | subagent+（新增）；`memory/src/api.ts:273` scope 为 `all`，工具携带 `minRole: subagent`（`memory/src/tools.ts:44`） | `subagent` | 研究可能需要历史 | 现在可用；无损失 |
| `workspace_sessions` / `workspace_intents` / `workspace_tasks` / `workspace_message` / `workspace_artifacts` | subagent+（新增）；`minRole: subagent`（`packages/uitstalie/workspace-tools/src/tools.ts:27-31`），动作级角色检查在各工具内 | `subagent` | 读对工作区内所有 agent 开放；写动作对工作区内任何 agent 开放：生命周期、卡写入与任务 create/update/receipt 均可用，跨工作区写要求 super；跨工作区发送由任务绑定、super 角色或回复一条已记录的投递放行 | 现在可用；本工作区可写，跨工作区写受门控 |
| `schedule_create/edit/list/view` | agent+（新增）；`minRole: agent`，保留运行时防护 | `agent` | subagent 无法触达下一次触发 | 对 subagent 隐藏；运行时拒绝仍然存在 |
| `plugin_manager` | agent+（新增）；`minRole: agent` | `agent` | 全局 profile 管理 | 对 subagent 隐藏 |
| `subagent` / `subagent_fork` / `workflow` | agent+（新增）；`minRole: agent` | `agent` | 不支持嵌套扇出 | 对 subagent 隐藏；深度防护仍然存在 |
| `send_message` / `list_agents` / `wait_agent` | subagent+（新增）；`minRole: subagent` | `subagent` | 子级需要与父级通信 | 保留；无损失 |
| `read` / `write` / `edit` / `glob` / `grep` / `pwsh` / … | 所有 agent | `subagent`+ | 基础执行 | 无；移除会破坏工作 |

## 7. 接口预留

`withMinRole(tool, role)` 与 `toolMinRole(tool)` 位于 `packages/core/tools/src/role.ts`，由 `@deepseek-ai/dsh-tools` 导出；feature 包声明门槛不需要 import dafeiyu。`ToolRegistry.register` 与 `ToolRegistry.definitions` 集中执行 `ToolDefinition.minRole`（`core/tools/src/index.ts:133-138` 和 `:313-320`）。预期的消费方签名是：

```text
tools(agent) -> ToolDefinition[] // each may carry minRole; the organizer filters roleAllows(agentRoleOf(agent), minRole)
```

注册表集中执行这些声明；已批准的矩阵已完全迁移。

## 8. 文件命名与默认理由

`SUPERAGENT_OUTPUT_STYLE.yaml` 沿用现有的 `SUPERAGENT_*` 常量前缀，并与 `OUTPUT_STYLE.yaml` 并列；本包没有 agent 类型后缀的命名惯例，因此显式的 super 前缀是现有惯例中最清晰的一种。普通槽位保留其现有文件名，因此已有的 `OUTPUT_STYLE.yaml` 不受影响。

未声明的 root 默认是 `agent`，而不是 `subagent`：root 是普通的 workspace Session，必须保留普通的 workspace 能力；`subagent` 是血缘派生的角色，不是 root 的安全默认值。`super` 从不隐式授予。

## 9. 验证与非目标

- 现有测试：`role-visibility.spec.ts` 断言 18/30/30 的已批准矩阵；personality、tool-dsh-store 与 workspace-tools 套件通过；typecheck 通过。
- 工具可见性现在恰好对标记为“新增”的行发生变化：memory 读写拆分、通信保留，schedule/plugin/delegation/.dsh 对 subagent 隐藏；没有 super 专用工具行。
- 本轮不包括：702 抽取、本地化，以及任何配额变更。

## 10. 部署验收：侧边栏里的超级工作区

持久角色现在会到达浏览器，侧边栏把 `super` 工作区渲染在普通 checkout 之上的独立分组里。**CI** 表示分支的自动化套件已覆盖该项；**Deploy** 表示需要运行中的 GUI 或真实 `<DSH_HOME>`，套件无法证明。不要只凭套件勾选 **Deploy** 项。本节只验收侧边栏改动；第 6 节面向模型的行保持各自的覆盖。

- [ ] `WorkspaceView` 在 follow 基线与之后每次角色变更里都携带持久角色，没有 `role` 的记录投影为 `agent`。CI：`projects the durable Workspace role in the baseline and in later role changes`（`packages/api/workspace-controller/tests/workspace-controller.host.spec.ts`）。Deploy：读取一条没有 `role` 记录的工作区 feed 行。
- [ ] 客户端从工作区快照注册一个 `super` 分组，角色消失或工作区消失时移除它，普通快照不注册任何分组。CI：`lifts the durable super workspace into its own sidebar section and follows the Workspace list`（`packages/client/ui-workspace/tests/apply.client.spec.ts`）。Deploy：确认 `<DSH_HOME>/storages/workspace.json` 只有一条 `role: super` 记录，且侧边栏只有一个特殊分组。
- [ ] 浏览器把注册的工作区放在普通列表之上的独立标题下，没有注册时不画特殊标题。CI：`renders a registered special Workspace in its own section above the ordinary list` 与 `renders no special section without a registered group`（`packages/client/ui-workspace/tests/workspace-browser.client.spec.tsx`）。Deploy：默认的分组视图里「超级工作区」在「普通工作区」之上。
- [ ] 分组跟随记录而不是标题：标题像家的、但记录为 `agent` 的工作区留在普通分组；`super` 记录的工作区无论标题是什么都进特殊分组。Deploy：重命名超级工作区、重启宿主，确认分组不变。
- [ ] 清掉持久角色后工作区回到普通分组，新会话的角色变成 `agent`。Deploy：从 `<DSH_HOME>/storages/workspace.json` 该记录里删掉 `role`、重启宿主，确认分组消失。
- [ ] 分节只属于分组视图：单列表视图没有工作区行，也不画标题；切回去分组恢复。Deploy：在 GUI 里来回切换两种视图。

人在 2026-11-19 的 3080 宿主上确认过分节；其余 **Deploy** 项在该宿主上逐条走过之前保持未勾选。
