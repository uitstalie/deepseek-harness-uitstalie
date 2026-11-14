# Agent 角色模型与工具矩阵草案（2026-11-14）

[English](agent-role-model-20261114.md) | 中文

状态：**角色字段、section 门控以及已批准的工具门槛均已实现。** 工具可见性由工具注册表统一执行一次；superagent 仍是唯一未迁移的族。

## 1. 角色分类

| 角色 | 含义 |
|---|---|
| `subagent` | 被委派的子级，或任何具有子级血缘的 Session；权限最小。 |
| `agent` | 普通的 root/workspace Session；承担常规工作。 |
| `super` | 负责调度工作的 super-agent 根；权限最大。 |

角色类型与读取函数位于 `packages/core/agent/src/runtime-types.ts` 和 `packages/core/agent/src/role.ts`：`AgentRole`、`agentRoleOf`。feature 包通过 `@deepseek-ai/dsh-tools`（`withMinRole` / `toolMinRole`）声明工具门槛；没有任何 feature 包为角色而 import dafeiyu。organizer 只负责未来的注册过滤。

## 2. 声明来源与默认值

- 唯一来源是 `agent.options.role`（通过 Session/agent 创建选项声明；创建该 Agent 的 preset/config 必须设置它）。不存在基于 cwd、workspace 标题、preset 名称或工具存在性的推断。
- **当前启用缺口：** 没有任何已发布的 preset 或 profile 行设置 `role: 'super'`；super Session 必须用 `agentOptions: { role: 'super' }` 创建（或由某个传入该值的 preset 创建）。在接通之前，`SUPERAGENT_OUTPUT_STYLE.yaml` 仅由显式构造的 super Agent 读取。现有 profile 未被修改。
- 未声明的 **root** 解析为 `agent`，而不是 `super`。这是普通 workspace Session 的安全默认值：`super` 从不被隐式授予，而 root 必须保留正常的 workspace 能力才能运作。
- 未声明的 **child** 会解析为 `subagent`，其依据是持久血缘（`origin: 'subagent'`、`parentSession` 或 `delegationDepth > 0`）。子级血缘优先于已声明的值，因此子级无法自我提升。
- `agent.options.role` 是运行时的 agent 配置。恢复的 Session 若需要 `super`，必须以相同的声明重新创建；此阶段没有持久化的角色字段。

## 3. 父子规则

`agentRoleOf` 首先检查血缘；如果该 Agent 是子级，则返回 `subagent`，无论 `agent.options.role` 为何。因此 subagent **不是**其父级的 super 能力副本，也无法选择加入 `super`。未声明的普通 root 是 `agent`；只有声明 `super` 的 root 才能获得 super 角色。

## 4. 现有隐式判断与未来替换

| 当前判断 | 位置 | 未来的角色替换 |
|---|---|---|
| 能力 `scope: 'root'` | `dafeiyu/src/index.ts:318-320` | 非工具资源保留 scope；工具可见性应使用 `agentRoleOf`。 |
| Personality 工具过滤 | `personality/src/index.ts:122` | 现有行为：subagent 只获得 analyze；本轮不迁移到 minRole。 |
| Jira worker 测试 | `jira-agent/src/contribution.ts:146-179` | `isWorker` 继续选择 worker 工具集；每个返回的工具同时带 `minRole: agent`，由 role 拦住 subagent。 |
| Super-agent 测试 | `jira-agent/src/superagent.ts:418-424`、`:5752-5769` | 当前基于 cwd 的 `isSuperAgentSession`；未来使用 `agentRoleOf === 'super'`。 |
| Memory 能力 scope | `memory/src/index.ts:296` | 未来做工具级角色声明；当前行为不变。 |
| Schedule 运行时拒绝 | `schedule/tool-schedule/src/index.ts:307` | 当前拒绝 subagent 调用；可见性不变。 |

角色字段是共享来源；每个消费方分别迁移。本轮**不会**替换上述任何行为。

## 5. 690 门控与配额

- 对 `subagent` 会省略 section 690；普通 root 与 super root 使用彼此独立的 `OUTPUT_STYLE.yaml` 和 `SUPERAGENT_OUTPUT_STYLE.yaml` 槽位。现有的普通文件继续照常工作。
- 写入规则：100 条规则 / 240 字符 / 共 32 KiB；只有前 40 条已启用的规则会常驻。第 41 条会被省略并附上 `N rule(s) not injected: resident limit is 40.`；不做检索。这些已实现并通过测试。

## 6. 工具矩阵草案

“当前”指本代码树中执行的可见性；标记为“新增”的行是在本轮迁移的。

| 工具族 | 当前可见性（过滤位置） | 建议角色 | 理由 | subagent 会失去什么 |
|---|---|---|---|---|
| `personality_analyze` | 所有 agent；`personality/index.ts:122` | `subagent`+ | 只读研究 | 无 |
| `personality_apply` / `write_like_human` | 排除 subagent；`personality/index.ts:122` | `agent`+ | 全局写入 | 无写权限（本来就没有） |
| `jira_issue` / `jira_list` / `jira_kb` | agent+（新增）；`minRole: agent` | `agent` | 账本身份属于主/workspace Session | 对 subagent 隐藏 |
| jira `issue_work` | agent+（新增）；`minRole: agent` | `agent` | worker executor 就是一个 agent root | 对 subagent 隐藏 |
| `tool-dsh-store` | agent+（新增）；`minRole: agent` | `agent` | 规则/技能管理 | 对 subagent 隐藏 |
| `memory_write` / `forget` / `resolve` | agent+（新增）；`memory/src/tools.ts` `minRole: agent` | `agent` | 单一写入者 | 无写权限（新近隐藏） |
| `memory_search` / `read` | subagent+（新增）；`memory/src/index.ts` scope 现为 `all`，工具携带 `minRole: subagent` | `subagent` | 研究可能需要历史 | 现在可用；无损失 |
| `superagent_control` / `ledger` / `deliver` / `permission` | 通过 cwd + root 仅限 super；`superagent.ts:5752-5769` | `super` | 调度/账本/交付 | 无（本来就不可用） |
| `schedule_create/edit/list/view` | agent+（新增）；`minRole: agent`，保留运行时防护 | `agent` | subagent 无法触达下一次触发 | 对 subagent 隐藏；运行时拒绝仍然存在 |
| `plugin_manager` | agent+（新增）；`minRole: agent` | `agent` | 全局 profile 管理 | 对 subagent 隐藏 |
| `subagent` / `subagent_fork` / `workflow` | agent+（新增）；`minRole: agent` | `agent` | 不支持嵌套扇出 | 对 subagent 隐藏；深度防护仍然存在 |
| `send_message` / `list_agents` / `wait_agent` | subagent+（新增）；`minRole: subagent` | `subagent` | 子级需要与父级通信 | 保留；无损失 |
| `read` / `write` / `edit` / `glob` / `grep` / `pwsh` / … | 所有 agent | `subagent`+ | 基础执行 | 无；移除会破坏工作 |

## 7. 接口预留

`withMinRole(tool, role)` 与 `toolMinRole(tool)` 位于 `packages/core/tools/src/role.ts`，由 `@deepseek-ai/dsh-tools` 导出；feature 包声明门槛不需要 import dafeiyu。`ToolRegistry.register` 与 `ToolRegistry.definitions` 集中执行 `ToolDefinition.minRole`（`core/tools/src/index.ts:128` 和 `:312`）。预期的消费方签名是：

```ts
tools(agent) -> ToolDefinition[] // each may carry minRole; the organizer filters roleAllows(agentRoleOf(agent), minRole)
```

注册表集中执行这些声明；只有 superagent 仍未迁移。

## 8. 文件命名与默认理由

`SUPERAGENT_OUTPUT_STYLE.yaml` 沿用现有的 `SUPERAGENT_*` 常量前缀，并与 `OUTPUT_STYLE.yaml` 并列；本包没有 agent 类型后缀的命名惯例，因此显式的 super 前缀是现有惯例中最清晰的一种。普通槽位保留其现有文件名，因此已有的 `OUTPUT_STYLE.yaml` 不受影响。

未声明的 root 默认是 `agent`，而不是 `subagent`：root 是普通的 workspace Session，必须保留普通的 workspace 能力；`subagent` 是血缘派生的角色，不是 root 的安全默认值。`super` 从不隐式授予。

## 9. 验证与非目标

- 现有测试：personality 105/105、tool-dsh-store 19/19、jira superagent 125/125、typecheck 5/5。
- 工具可见性现在恰好对标记为“新增”的行发生变化：memory 读写拆分、通信保留，schedule/plugin/delegation/jira/.dsh 对 subagent 隐藏。只有 superagent 仍待处理。
- 本轮不包括：702 抽取、本地化、superagent 工具门控，以及任何配额变更。
