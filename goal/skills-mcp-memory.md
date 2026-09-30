# skills / MCP / memory：现有能力盘点与复用路线

本文件回答「这三个方向现在到底已有什么、模型看到什么、缺什么、下一步怎么用最小新增接上」，服务于 [task14](mission/task14.md) 的 `.dsh/` 工作区存储与紧随其后的目录形式 rules 加载器。结论先行，逐项证据在后。

## 结论摘要

| 方向 | 现状 | 模型看到什么 | 关键缺口 | 主要复用点 |
|---|---|---|---|---|
| **skills** | 完整：多根发现 + 注册表分层 + catalog 注入 + 按需正文 + watcher 刷新 | 一段 `<system-reminder><available_skills>` 目录；正文靠 `skill` 工具或 `/name` 手势 | 没有 always-apply、没有预算、没有目录 glob / per-file 作用域 | `ctx.skills.registerProvider`、`renderSkillContent`、`tool-skill` 的 pre-step 注入模式 |
| **MCP** | 完整客户端 + 资源消费者；**服务声明只在 profile 补丁行** | 远端工具并进同一工具表（`mcp__<server>__<tool>`）；resources 有 3 个读取工具；无 prompts | 无运行时增删、无管理面、无 per-server 过滤、无 prompts/subscription | `mcp-client` 的 `Config`/`apply`/`startConnection`/`syncTools`、`mcp-resources` 的注册面、ACP 的声明挂载范例 |
| **memory** | **不存在**：无任何 memory/recall/knowledge 包或工具；goal/todo/compaction/title/feedback 全是 session 作用域 | — | 没有 agent 可写、跨会话存活、之后能回注的存储 | `storage-domain` 的 `defineDomain`/`DomainFacility.open`、`ctx.systemPrompt.context()`、`agent-instructions` 的注入模式 |

一条贯穿三者的判断：**skills 是"按需加载"，rules 需要的是"always-on"**。所以目录形式 rules 的同构对象是 `agent-instructions`（全文 baseline + 预算 + 变更通知），不是 skills。skills 提供的是**发现/刷新/注册**这三层可借用结构。

## 一、skills

### 现状

- 发现根与优先级（rank 小者先）：`<projectRoot>/.dsh/skills` 100 → `<projectRoot>/.agents/skills` 200 → `customSkillDirs` 300 → `$DSH_HOME/skills` 400 → `$AGENTS_HOME/skills` 500 → bundled 600；运行期注册 250（[skill-filesystem/src/index.ts:245](../packages/skill/skill-filesystem/src/index.ts:245)、[skill/src/index.ts:28](../packages/skill/skill/src/index.ts:28)）。项目根 = 从 cwd 向上找第一个含 `.git` 的目录，找不到退化为 cwd（同文件 :945）。
- 磁盘格式：目录 → `<dir>/SKILL.md`，扁平 → 根目录下直接 `*.md`（[index.ts:723](../packages/skill/skill-filesystem/src/index.ts:723)，已抽验）。front-matter 必填 `name`（kebab-case）与 `description`；可选 `whenToUse`、`metadata`（**当前无消费者**）；开关 `disable-model-invocation`（默认 false）、`user-invocable`（默认 true），旧驼峰键硬拒绝（[index.ts:1000](../packages/skill/skill-filesystem/src/index.ts:1000)，已抽验）。
- 两条进入模型的路径：① catalog —— pre-step 发布一条 durable user 消息，`<system-reminder><available_skills>` + 每行 `- \`name\`: description`，仅在 `skill` 工具可见且快照完整时（[tool-skill/src/index.ts:213](../packages/skill/tool-skill/src/index.ts:213)）；② 正文 —— 模型调 `skill` 工具，`renderSkillContent` 包成 `<skill_content name>`/`<skill_instructions>`（[skill/src/index.ts:170](../packages/skill/skill/src/index.ts:170)）。`/name` 手势是 `disable-model-invocation` 技能的唯一入口。
- 刷新：每个根一个 chokidar（`depth: 1`、`awaitWriteFinish`），缺失根挂在最近存在的祖先上；首方 `write`/`edit` 经 `fs/observed` 失效；失效 → revision++ → 下一次 pre-step 重发/替换/撤下 catalog（[index.ts:491](../packages/skill/skill-filesystem/src/index.ts:491)、[tool-skill/src/index.ts:229](../packages/skill/tool-skill/src/index.ts:229)）。正文不缓存，每次调用重读。

### 缺口（对 rules 而言）

无 glob/applyTo/路径作用域（rank 是每根常量）；无 always-apply；链上**没有任何预算**（对比 `agent-instructions` 的 `maxBytes: 65536` / `maxSourceBytes` 1 MiB），只有 description 截断 500；无去重与截断通知；非 Markdown 不支持（bundle 必须是 `SKILL.md`，扁平必须是根下 `*.md`，**发现与 watcher 都只有 depth 1**）；`.git` 标记硬编码不可配；`metadata` 是无消费方的死负载。

### 可复用点

`ctx.skills.registerProvider` / `SkillProvider` / `SkillCandidate` / `SkillInvocationPolicy` / `SkillCatalogSnapshot`（[skill/src/index.ts:390](../packages/skill/skill/src/index.ts:390)）；`renderSkillContent`、`escapeText`、`isModelInvocable`（同文件 :170、:226、:126）；pre-step 注入 + `createUserMessage` + `MessageSourceMap` 声明合并（[tool-skill/src/index.ts:211](../packages/skill/tool-skill/src/index.ts:211)）；watcher 全套结构（chokidar 参数、祖先挂载、LRU 上限、`fs/observed` 失效）。注意：`parseSkillFile`/`discoverRoot`/`SkillWatchManager` **未导出**，新插件要么自己解析 front-matter，要么只用已导出的 provider 接口。

## 二、MCP

### 现状

- 唯一客户端是函数式插件 `@deepseek-ai/dsh-mcp-client`（`name`/`inject=['tools']`/`Config`/`apply`）；`Config` 是 `stdio`（`serverName` + `command`/`args`/`env`/`cwd`）与 `streamable-http`（`serverName` + `url`/`headers`）的判别联合，公共项 `toolCallTimeoutMs: 60000`、`maxInstructionBytes: 32768`、`failOnStartupError: false`、`reconnect{500/30000/10}`（[index.ts:119](../packages/mcp/mcp-client/src/index.ts:119)、[connection.ts:41](../packages/mcp/mcp-client/src/connection.ts:41)）。
- 声明位置：**只在 profile 的 `cordis.patch.yml` 行**（[app-boot/src/profile.ts:40](../packages/boot/app-boot/src/profile.ts:40)），不在 settings、没有 GUI 可编辑。出厂 composition 只挂 `mcp-resources` 消费者，**没有 server 行**（[base/cordis.patch.yml:501](../packages/bundle/base/cordis.patch.yml:501)，CLI 测试亦有断言）。模板见 `packages/preset/agent-preset/skills/cordis-plugin-development/templates/mcp/cordis.patch.yml`。
- 第二条声明通道：ACP `session/new {mcpServers}` 校验后逐个 `agentCtx.plugin(McpClient, config)`（[acp/src/mcp.ts:26](../packages/acp/acp/src/mcp.ts:26)）——**这是"外部声明 → 挂 client fiber"的现成范例**。
- 工具并入同一个 `ctx.tools.register`，命名 `mcp__<serverName>__<rawName>`（非法字符/超长会替换并追加哈希）；整代同步，冲突回滚；`listChanged` 触发再同步。资源侧有 `list_mcp_resources` / `list_mcp_resource_templates` / `read_mcp_resource` 三个工具（都要求显式 `server`），服务器名经 `MCP_SERVERS=3100` 段落进 system prompt。
- 生命周期：`startConnection` 拥有世代、退避重连、工具注册；超过 `maxAttempts` 就卸载工具并停止（只能靠 reload/restart 恢复）；dispose 关连接并注销。失败只经 `ctx.logger`。

### 缺口

无 MCP prompts（全域无 `prompts/list`/`prompts/get`）；无 resource subscription（只订阅 tools listChanged）；无运行时增删 server（改补丁后靠 HMR/重启），**没有任何 MCP 管理 UI/CLI**；无 per-server allow/deny/前缀（只能靠通用 `tools.restrict` 或子 agent `toolFilter`）；无 OAuth，只有静态 headers；无 SSE-only/WebSocket；无 session 事件或用户可见的失败面。

### 可复用点

`apply`/`Config`（`ctx.plugin(McpClient, McpClient.Config({...}))`）；`startConnection` / `resolveReconnectPolicy` / `createTransport` / `registerServerContext`；`publicToolName` / `syncTools` / `createMcpToolDefinition`（非传输型 provider 适配器，Cua Driver 在用）；`mcp-resources` 的 `ctx.mcpResources.register(server, provider)` 与 `registerResourceTools` / `renderResourceResult`；声明校验范例 `mountAcpMcpServers`。

## 三、memory

**不存在一等能力**：`packages/**` 下没有 memory/recall/knowledge 命名的包或工具（glob 零命中，已抽验），工具清单里也没有记忆工具。

现存最接近的机制及其作用域：

| 机制 | 存什么 | 落盘 | 作用域 | 回到模型 |
|---|---|---|---|---|
| `agent-instructions` | AGENTS.md/CLAUDE.md 全文 | 磁盘（`$DSH_HOME` + 项目链） | user + project | pre-step 注入 durable user 消息 |
| `skills` | SKILL.md 集合 | 磁盘（多根） | user + project | catalog 注入 + 按需正文 |
| `session-reference` | 另一会话的只读快照 | 来自 session log | 跨会话只读 | `session-reference` 源消息（`form: 'recall'`） |
| `goal` / `todo` / `compaction` / `session-title` / `message-feedback` | 目标、待办、摘要、标题、评分 | session log | **仅 session** | 各自方式（goal 有 system prompt 段与续跑 prompt） |
| `storage-domain` | 通用持久 KV（seam，非能力） | JSON/SQLite | 由消费者定 | 无 |
| `settings` | 各插件 Config | `$DSH_HOME/profiles/<name>/cordis.patch.yml` | user(profile) | 插件自行读取 |

缺口：**没有任何"agent 可写 → 跨会话存活 → 之后自动回注"的存储**；没有写入工具、没有 project/user 级 note store、没有去重/合并/衰减策略。

最小新增（若要做）＝ 写工具 + 持久域 + 回注点：持久化用 `defineDomain` + `DomainFacility.open`（[storage-domain/src/spec.ts:107](../packages/storage/storage-domain/src/spec.ts:107)）；回注优先 `ctx.systemPrompt.context()`（[system-prompt/src/index.ts:489](../packages/core/system-prompt/src/index.ts:489)），或照 `agent-instructions` 的 pre-step 模式；导出 schemastery `Config` 即自动获得设置表单。**约束**：新增消息 source kind 必须在 `packages/session/session-format-v3-to-v4/src/sources.ts` 登记（model-visible ⟺ logged）。

## 四、复用优先的落地路线

排序原则：**能借的一律借，只有"语义或原语缺失"才新增。**

| 步骤 | 做什么 | 复用 | 必须新增（无法复用） |
|---|---|---|---|
| 1（已计划，task14） | `.dsh/` 工作区存储：创建/查询/删除文件与文件夹 | `ctx.fs` 的 resolve/contains/stat/listDir/readText/writeText（写自带建父目录）；`@deepseek-ai/dsh-home-paths` 的 `DSH_HOME_DIR_NAME`/`expandHomePath`/`dshHomePath`/`canonicalizeWatchPath`；`defineTool` + `ctx.systemPrompt.section` | **建空目录**与**删除**两个原语（`ctx.fs` 服务定义没有），以及 `.dsh/` 归属判定 |
| 2 | `.dsh/rules/**` always-on 加载器 | `renderAgentInstructions`（框架/预算/去重/转义一次到位，[index.ts:43](../packages/context/agent-instructions/src/index.ts:43)）；`agent-instructions` 的 pre-step 注入与变更/移除通知模式；`skill-filesystem` 的 watcher 结构与 `fs/observed` 失效 | 目录形式的发现（现有候选过滤丢弃含分隔符的名字，skills 只有 depth 1 + 固定文件名）；always-on 语义本身 |
| 3（可选） | 工作区级 MCP：`.dsh/mcp.json` → 运行时挂 client | `mcp-client` 的 `Config`/`apply`/`startConnection`/`syncTools`/`publicToolName`；`mcp-resources` 的资源工具；`mountAcpMcpServers` 的校验写法；`ctx.plugin` 可在运行时挂 fiber（本仓库测试与 ACP 均有先例） | 读取声明文件 → 校验 → 挂/卸 fiber 的桥（MCP 没有运行时声明通道）；变更时的 dispose+重建 |
| 4（可选） | memory：可写、跨会话、自动回注 | `storage-domain` 或直接 `.dsh/` 文件；`ctx.systemPrompt.context()`；`defineTool`；schemastery `Config` → 设置表单 | 写入工具与 note store 本身（不存在） |

三处"自建注入"的替代方案（更省事但违反分支「只走新增路径」）：给 `agent-instructions` 加"目录候选/glob"，或给 `FileSystem` 服务定义加 `mkdir`/`remove`。二者都适合作为**上游提案**，本分支先按上表新增，把它们记成待办。

## 五、需要拍板

1. 步骤 2 的形态：新插件（零原生改动，自己实现发现 + 变更跟踪）还是给 `agent-instructions` 加目录候选（改原生，功能更省，rebase 面更大）？
2. 步骤 3 要不要做：MCP 走**用户级 profile 补丁**（现状、跨工作区）还是**项目级 `.dsh/mcp.json` + 运行时挂载**（新桥接，零原生改动）？
3. 步骤 4 要不要现在做：memory 若做，落在 `.dsh/` 文件（与 rules 同一存储面、可被 git 管理）还是 `storage-domain`（结构化、带变更事件）？
4. 是否接受把"目录候选"和"`FileSystem.mkdir/remove`"两个原生扩展整理成上游提案（单独任务单）。
