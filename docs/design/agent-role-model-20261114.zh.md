# Agent 角色模型与工具矩阵草案（2026-11-14）

[English](agent-role-model-20261114.md) | 中文

状态：**角色字段与 section 门控已实现；本轮不改变工具可见性。** 本页是后续工具配置的评审草案。

## 1. 角色分类

| 角色 | 含义 |
|---|---|
| `subagent` | 被委派的子级，或任何具有子级血缘的 Session；权限最小。 |
| `agent` | 普通的 root/workspace Session；承担常规工作。 |
| `super` | 负责调度工作的 super-agent 根；权限最大。 |

角色类型与读取函数位于 `packages/core/agent/src/runtime-types.ts` 和 `packages/core/agent/src/role.ts`：`AgentRole`、`agentRoleOf`。feature 包通过 `@deepseek-ai/dsh-tools`（`withMinRole` / `toolMinRole`）声明工具门槛，不需要 import dafeiyu；organizer 只负责未来的注册面过滤。

## 2. 声明来源与默认值

- 唯一来源是 `agent.options.role`（通过 Session/agent 创建选项声明；创建该 Agent 的 preset/config 必须设置它）。不存在基于 cwd、workspace 标题、preset 名称或工具存在性的推断。
- **当前启用缺口：** 没有任何已发布的 preset 或 profile 行设置 `role: 'super'`；super Session 必须用 `agentOptions: { role: 'super' }` 创建（或由某个 preset 传入）。在接通之前，`SUPERAGENT_OUTPUT_STYLE.yaml` 仅由显式构造的 super Agent 读取。现有 profile 未被修改。
- 未声明的 **root** 解析为 `agent`，而不是 `super`。这是普通 workspace Session 的安全默认值：`super` 从不被隐式授予，而 root 必须保留正常的 workspace 能力才能运作。
- 未声明的 **child** 解析为 `subagent`，判定依据是持久血缘（`origin: 'subagent'`、`parentSession` 或 `delegationDepth > 0`）。子级血缘优先于已声明的值，因此子级无法自我提升。
- `agent.options.role` 是实时的 agent 配置。恢复的 Session 若需要 `super`，必须以相同的声明重新创建；此阶段没有持久化的角色字段。

## 3. 父子规则

`agentRoleOf` 首先检查血缘；如果该 Agent 是子级，则返回 `subagent`，无论 `agent.options.role` 为何。因此 subagent **不是**其父级的 super 能力副本，也无法选择加入 `super`。未声明的普通 root 是 `agent`；只有声明 `super` 的 root 才能获得 super 角色。

## 4. 现有隐式判断与未来替换

| 当前判断 | 位置 | 未来的角色替换 |
|---|---|---|
| 能力 `scope: 'root'` | `dafeiyu/src/index.ts:318-320` | 非工具资源保留 scope；工具可见性应使用 `agentRoleOf`。 |
| Personality 工具过滤 | `personality/src/index.ts:122` | 现有行为：subagent 只获得 analyze。未来：通过共享接口按工具声明 `minRole`。 |
| Jira worker 测试 | `jira-agent/src/contribution.ts:146-179` | 当前 `isWorker`（subagent 或 executor preset）仍控制工具；未改变。 |
| Super-agent 测试 | `jira-agent/src/superagent.ts:418-424`、`:5752-5769` | 当前基于 cwd 的 `isSuperAgentSession`；未来使用 `roleOf === 'super'`。 |
| Memory 能力 scope | `memory/src/index.ts:296` | 未来做工具级角色声明；当前行为不变。 |
| Schedule 运行时拒绝 | `schedule/tool-schedule/src/index.ts:307` | 当前拒绝 subagent 调用；可见性不变。 |

角色字段是共享来源；每个消费方分别迁移。本轮**不会**替换上述任何行为。

## 5. 690 门控与配额

- 对 `subagent` 会省略 section 690；普通 root 与 super root 使用彼此独立的 `OUTPUT_STYLE.yaml` 和 `SUPERAGENT_OUTPUT_STYLE.yaml` 槽位。现有的普通文件继续照常工作。
- 写入规则：100 条规则 / 240 字符 / 共 32 KiB；只有前 40 条已启用的规则会常驻。第 41 条会被省略并附上 `N rule(s) not injected: resident limit is 40.`；不做检索。这些已实现并通过测试。

## 6. 工具矩阵草案

“当前”指本代码树中的行为；本轮未改动此表中的任何一行。

| 工具族 | 当前可见性（过滤位置） | 建议角色 | 理由 | subagent 会失去什么 |
|---|---|---|---|---|
| `personality_analyze` | 所有 agent；`personality/index.ts:122` | `subagent`+ | 只读研究 | 无 |
| `personality_apply` / `write_like_human` | 排除 subagent；`personality/index.ts:122` | `agent`+ | 全局写入 | 无写权限（本来就没有） |
| `jira_issue` / `jira_list` / `jira_kb` | worker/subagent 可获得；`jira/contribution.ts:179` | `agent`+ | 账本身份属于主/workspace Session | **待定**：将失去账本读/写/搜索 |
| jira `issue_work` | worker/subagent；`jira/contribution.ts:179` | `agent`+ | worker executor 就是一个 agent root | **待定**：将失去 worker 写入 |
| `tool-dsh-store` | 所有 agent；`tool-dsh-store/index.ts:51` | `agent`+ | 规则/技能管理 | **待定**：将失去 `.dsh` 管理 |
| `memory_write` / `forget` / `resolve` | subagent 均无；`memory/index.ts:296`（scope root） | `agent`+ | 单一写入者 | 无（本来就不可用） |
| `memory_search` / `read` | subagent 均无；同上 | **待定**：允许 `subagent` | 研究可能需要历史 | 若被拒绝，只剩父级摘要 |
| `superagent_control` / `ledger` / `deliver` / `permission` | 通过 cwd + root 仅限 super；`superagent.ts:5752-5769` | `super` | 调度/账本/交付 | 无（本来就不可用） |
| `schedule_create/edit/list/view` | 对所有人可见；运行时拒绝 subagent（`tool-schedule:307`） | `agent`+ | subagent 无法触达下一次触发 | 待定：只是隐藏 schema，调用已被拒绝 |
| `plugin_manager` | 所有 agent；无角色检查（`plugin-manager/tools.ts:87`） | `agent`+ | 全局 profile 管理 | 待定 |
| `subagent` / `subagent_fork` / `workflow` | 所有 agent；直接注册（`tool-subagent:338`、`tool-workflow:331`） | `agent`+ | 不支持嵌套扇出 | 待定：目前只有深度限制 |
| `send_message` / `list_agents` / `wait_agent` | 所有 agent；直接注册（`tool-subagent-control:84`、`list-agents.ts:46`、`wait-agent.ts:91`） | `subagent`+ | 子级需要与父级通信 | 若移除，将无法回复/查询父级 |
| `read` / `write` / `edit` / `glob` / `grep` / `pwsh` / … | 所有 agent | `subagent`+ | 基础执行 | 无；移除会破坏工作 |

## 7. 接口预留

`withMinRole(tool, role)` 与 `toolMinRole(tool)` 位于 `packages/core/tools/src/role.ts`，由 `@deepseek-ai/dsh-tools` 导出；feature 包声明门槛不需要依赖 dafeiyu。本轮 organizer **不会**调用它们；没有任何工具定义携带 `minRole`，注册循环保持不变。预期的消费方签名是：

```ts
tools(agent) -> ToolDefinition[] // each may carry minRole; the organizer filters roleAllows(agentRoleOf(agent), minRole)
```

这只是设计预留。此处没有迁移任何 provider。

## 8. 文件命名与默认理由

`SUPERAGENT_OUTPUT_STYLE.yaml` 沿用现有的 `SUPERAGENT_*` 常量前缀，并与 `OUTPUT_STYLE.yaml` 并列；本包没有 agent 类型后缀的命名惯例，因此显式的 super 前缀是现有惯例中最清晰的一种。普通槽位保留其现有文件名，因此已有的 `OUTPUT_STYLE.yaml` 不受影响。

未声明的 root 默认是 `agent`，而不是 `subagent`：root 是普通的 workspace Session，必须保留普通的 workspace 能力；`subagent` 是血缘派生的角色，不是 root 的安全默认值。`super` 从不隐式授予。

## 9. 验证与非目标

- 现有测试：personality 105/105、tool-dsh-store 19/19、jira superagent 125/125、typecheck 5/5。
- 本轮未改变任何工具可见性。只实现了已经批准的 690 门控与写入规则配额/常驻行为。
- 本轮不包括：702 抽取、本地化、工具配置、memory 读取策略、schedule/delegation/plugin 的可见性。
