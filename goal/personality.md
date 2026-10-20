# personality 设计（草案，2026/10/20）

状态：草案。与 [memory.md](memory.md) 同属能力提供者，由 `dsh-dafeiyu` 组织启用；memory 调研见 [memory-research.md](memory-research.md)。

## 定位

personality = 稳定的**人格、用户偏好与表达风格**。与 memory 正交：memory 记“发生过什么”，personality 记“我是谁、用户是谁、怎么说话”。

## 与 memory 的关系

- 都是能力提供者：暴露服务与贡献描述（system prompt 段 / source / 工具），不自己决定挂载与启用。
- 最终会与 memory 合并成一个大插件：personality 的内容作为 memory 条目模型里的稳定 `kind`（如 `persona`、`preference`、`style`），共享存储与审计，但注入位置不同（system prompt 段 vs pre-step 的 source）。
- 提升路径：memory 里反复遗忘、反复被提醒的点 → 用户确认 → 上升为 personality 条目、rules 或 jira KB。

## 内容边界

- **收**：沟通风格、语言与称呼偏好、工作习惯、用户身份/角色设定、长期偏好。
- **不收**：任务事实、项目决策、临时上下文（属于 memory/KB）；密钥等敏感信息。

## 存储（建议）

- 用户级：`$DSH_HOME/personality/PERSONALITY.md`（跨工作区；Markdown + frontmatter + 条目 kind）。
- 工作区覆盖：`.dsh/memory/PERSONALITY.md`，或 MEMORY.md 中的 `kind: style` 条目（项目特定的表达偏好）。
- 文件即真相；插件只写 `<!-- personality:begin/end -->` 托管区块，手写内容不动。

## 注入（建议）

- **system prompt 稳定段**（`ctx.systemPrompt.section`，约 1–2 KiB），不随 turn 变化，不破坏 KV cache。
- 与 memory 的 pre-step source 分开：personality 只在文件变化时重建 system prompt 段。
- 固定文案只陈述事实（“以下是与该用户协作的长期偏好”），不做行为条件判断。

## 写入（建议）

- 用户显式设置（设置页/命令）为主。
- 模型可**提议**，经 `ask_user` 确认后写入；不允许静默自动改写人格。
- 每次写入保留来源（session id、时间、变更摘要），设置页或轨迹页可回看。

## 能力接口（草案）

- 服务 `ctx.personality`：`read()`、`resolve({ workspace })`、`contribute()`（system prompt 段）、`propose(entry)`。
- 贡献描述：`{ id: 'personality', systemPrompt: { name, order, text }, configSchema }`，由 dafeiyu 注册。
- 配置（dafeiyu 聚合）：`personality: { enabled, globalPath?, maxBytes?, allowModelProposal? }`。

## 与 dafeiyu 的接线

- dafeiyu 按配置启用 provider，注册 system prompt 段；禁用时撤销（Cordis effect 管理）。
- 子 agent 建议**继承** personality（人格是全局的），memory 不继承（任务确定）；待确认。

## 待确认

1. 存哪里：`$DSH_HOME/personality/PERSONALITY.md` + 工作区覆盖，还是只工作区？
2. 作用域：用户级（跨工作区）还是工作区级？
3. 写入：用户显式 + 模型提议确认，还是允许自动学习？
4. 内容边界：只放风格/偏好，还是也放角色身份设定？

## 实现计划

1. 本文定稿 → 包骨架（provider + 贡献描述）。
2. dafeiyu 的能力注册表、配置聚合、启用/禁用。
3. memory 条目模型支持 personality kinds（为合并做准备）。
4. 设置页编辑入口（后续）。
