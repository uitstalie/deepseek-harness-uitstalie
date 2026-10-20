# memory 层调研（2026/10/20）

调研对象：GitHub 上 coding agent 的持久记忆插件/框架，以及与本分支已有能力（jira 台账、`.dsh` 存储、`agentContextSources` 切面）的映射。状态：调研完成，设计未定；任务见 jira `DH-7`。

## 一句话结论

生态里没有唯一正确的 memory 形态，反复出现的是五种模式：文件即记忆、压缩式情景记忆、抽取式事实记忆、图/时序记忆、自编辑上下文。coding agent 场景的主流起点是「Markdown/本地库 + 分层检索 + 摘要注入」，纯向量库不是起点。我们已有的 jira KB 是**策展型全局记忆**，memory 层应补**工作/情景记忆**，并复用 Markdown、存储服务与常驻注入切面，而不是另起一套向量记忆。

## 盘点

| 项目 | 形态 | 存储 | 写入 | 读取 | 治理 |
|---|---|---|---|---|---|
| CLAUDE.md / AGENTS.md | 仓库文件 | Markdown | 人或 agent 编辑 | 每次请求常驻前缀 | git review，人工维护 |
| Cline Memory Bank | 自定义指令 + 6 个 md | 仓库内 `memory-bank/` | agent 按指令维护 | 会话开始读全部文件 | 人工可改，靠指令纪律 |
| Basic Memory | MCP 服务 + 本地库 | Markdown + frontmatter，SQLite 索引 | 工具写笔记（observations/relations） | 工具检索、memory URL | 文件与索引双向同步，用户拥有数据 |
| claude-mem | Claude Code 插件 | SQLite（FTS5）+ 可选 Chroma | 生命周期 hooks 捕获 → worker 用 LLM 压缩 | SessionStart 注入近 10 个会话摘要 + MCP 三层检索 | `<private>` 标签、Web viewer、按项目隔离 |
| memsearch | 轻量 Claude Code 插件 | Markdown + Milvus | 写入记忆文件 | 语义检索 | — |
| mem0 | 库/自托管服务 | 向量库（可选图） | LLM 抽取事实 + ADD/UPDATE/DELETE/NOOP 合并 | 检索 API | scope（user/agent/run）、metadata、TTL、rerank |
| Letta（MemGPT） | agent runtime | 核心记忆块 + archival/recall | agent 用工具自编辑核心块 | 常驻块 + 向量检索 | 字符预算、共享块、睡眠期整理 |
| Zep / Graphiti | 记忆服务/引擎 | 时序知识图 | 从 episode 抽取实体与事实 | 语义 + BM25 + 图遍历 | 事实有效期与失效（valid_at/invalid_at） |
| Cognee | 记忆管道 | 图 + 向量 | ECL 管道（抽取-构建-加载） | 图/向量检索 | 管道可重跑 |
| Anthropic memory tool（API beta） | 工具协议 | 客户端 `/memories` 目录 | 模型显式调用 view/create/str_replace/insert/delete/rename | 模型按需读目录 | 客户端持有数据、可审计 |
| Cursor / Windsurf Memories | 产品内建 | 厂商私有 | 对话中自动生成 | 自动注入 | 用户可查看/编辑/删除 |

## 五种模式

1. **文件即记忆**（CLAUDE.md、Memory Bank、Basic Memory、Anthropic memory tool）：透明、可 review、可 git 版本化；弱点是写入门槛与漂移，检索能力取决于文件组织。
2. **压缩式情景记忆**（claude-mem）：hook 捕获工具观察 → 后台 LLM 压缩成结构化 observation → 会话摘要注入 + 三层检索（search → timeline → get_observations）。强在自动化与连续性，弱在后台服务、LLM 成本与隐私面。
3. **抽取式事实记忆**（mem0）：LLM 从对话抽取事实，再与既有记忆比对做增量合并；强在去重与演化，弱在抽取错误会累积。
4. **图/时序记忆**（Zep/Graphiti、Cognee）：实体-关系-时间，冲突事实按有效期失效；强在多跳与冲突消解，弱在构建与运维复杂度。
5. **自编辑上下文**（Letta）：少量核心记忆块常驻上下文，agent 用工具自己改；强在即时可控，弱在容量、遗忘与审计。

## 设计维度

- **存储**：Markdown 优先（可审查、git、与 `.dsh` 一致）；索引后置（FTS5/SQLite），向量只在召回证据不足时引入。
- **写入**：显式工具（模型或用户"记住"）优先；自动抽取只放在高价值节点（会话结束、压缩前），且先生成草稿待确认。
- **读取**：常驻小预算（pinned/核心记忆，约 2–4 KiB）+ 按需检索工具；分层披露（索引 → 细节），不要全量注入。
- **作用域**：global（用户偏好）、project（仓库事实）、session（临时）；与 AGENTS.md、rules、jira KB 的边界要写清。
- **治理**：来源与时间戳、内容 hash 去重、冲突/失效、TTL/衰减、用户可编辑可删除、隐私标签。
- **Token/KV**：常驻记忆改动会破坏前缀缓存；默认只注入少量钉住条目，其余靠检索。

## 与本分支的映射

已有能力：

- `agentContextSources`（DH-5）：常驻注入切面，memory 可作为其中一个 source。
- `dshStore`（DH-5）：`.dsh` 基础接口，新增 `memory` 命名空间即可读写项目记忆。
- jira 台账 KB（`knowledge/<domain>/KB-<n>.md`）：策展型全局记忆，带 tags、issues、lineage 与全文检索，已经是"一部分全局 memory"。
- session-query：跨会话检索的现成后端，可先于自建索引使用。
- skills：流程性知识，不属于 memory。

建议分层：

- **全局策展记忆** = jira KB（事实、决策、runbook；人工/agent 共同策展）。
- **项目记忆** = `.dsh/memory/*.md`（frontmatter：id/scope/tags/source/updated），经 `dshStore` 的 memory 命名空间读写。
- **工作/情景记忆** = 会话摘要与"最近决策"，由显式 memory 工具写入，或会话结束钩子生成草稿待确认。
- **注入** = `agentContextSources` 的 memory 源（只注入 pinned/top-N）+ `memory_search` 工具（先用关键词/FTS，后续按证据加向量）。
- **边界**：rules 是"怎么做事"的规范；memory 是"发生过什么/用户是谁"的事实；jira KB 是"已验证的知识"。

不建议 v1 引入向量库或图数据库：先用 Markdown + 关键词检索 + 模型自行读取；等规模与召回数据出现再升级。

## 开放问题（待拍板）

1. 默认作用域与存放位置：`.dsh/memory`、`~/.dsh/memory`，还是并入 jira KB。
2. 自动抽取的触发点与成本上限：会话结束、压缩前，还是仅显式调用。
3. 是否需要 Web 侧边栏的 memory 审阅/编辑面（类似 rules 面板）。
4. 失效/衰减策略与隐私边界（哪些内容永不入记忆）。
5. 与 jira KB 合并为同一存储，还是保持两个命名空间互相引用。

## 来源与可信度

本环境无法直连 GitHub（DNS 解析到非公网地址），因此 claude-mem 的事实取自其发布文档镜像（[introduction](https://mintlify.wiki/thedotmack/claude-mem/introduction)、[architecture](https://mintlify.wiki/thedotmack/claude-mem/architecture/overview)），mem0 取自[官方文档](https://docs.mem0.ai/open-source/overview)，Cline 取自[官方文档](https://docs.cline.bot/best-practices/memory-bank)，Letta 与 Basic Memory 取自各自文档站；其余项目（Zep/Graphiti、Cognee、Cursor/Windsurf、Anthropic memory tool）基于检索结果与公开资料，star 数、许可证等未逐一核实。设计前如需精确引用，应在可直连 GitHub 的环境复核。

## DSH 现状核查（2026/10/20）

用户提出的三层模型：**L1 会话全文 → L2 会话摘要（可自己 drop）→ L3 模型用工具查历史**。逐层核对现有实现：

| 层 | 现状 | 位置 |
|---|---|---|
| L1 会话全文 | **已实现**：每个会话事件持久化到 JSONL；`session-query-sqlite` 建立 SQLite 全文索引，base 层默认挂载，服务为 `ctx.sessionQuery` | `packages/core/session`、`packages/session-query/session-query-sqlite` |
| L2 会话摘要 | **部分实现**：`compaction-basic` 在 token 压力、上下文溢出或 `/compact` 时把最旧历史压成一条摘要，持久化为 `compaction/summary` 事件，携带 `shadowedRange`/`shadowedSeqs`/`shadowedTokenCount`/provider/model/usage，再用 `surfaceOp: replace` 的 checkpoint 消息替换被遮罩区间；再次压缩会把更早的摘要一并遮罩——**"摘要自己 drop"在单会话内已成立**。但这是会话内的上下文压缩，不是跨会话的摘要记忆，也没有 TTL/衰减 | `packages/compaction/compaction-basic/src/region.ts` |
| L3 工具查历史 | **已有但默认关闭**：实验包 `dsh-tool-session-query` 提供 5 个只读工具——`session_search`、`session_event_search`、`session_trace`、`session_event_trace`、`session_event_read`；跨会话访问要求目标会话 `cwd` 与调用者完全相等，搜索排除调用者自身会话；**未挂进任何 bundle**，只能显式 opt-in | `packages/experimental/tool-session-query` |

结论：三层所需的原语都在，缺的是把它们组织成 memory 层的插件：

- **跨会话摘要缺失**：compaction 摘要只服务当前会话的上下文；没有"会话结束时生成摘要、下次会话注入最近 N 条"的机制。
- **摘要生命周期缺失**：摘要事件永久留在日志里，被遮罩只是不进模型上下文；跨会话摘要需要自己的条数/TTL/升级策略（概括进 jira KB 后可丢弃）。
- **L3 默认不开**：web 与 headless 组合都没有挂 `tool-session-query`；且它排除调用者自身会话，当前会话早期内容只能靠 `session_event_search` 的部分能力。
- **没有 memory 存储**：`.dsh` 只有 rules/skills 两个命名空间；jira KB 是另一套策展记忆。

### 新插件的最小形态（设计输入）

- **L2 生产**：会话结束（或 `/compact` 之后）把最近一次 `compaction/summary` 落盘；没有摘要时生成一条"会话摘要"（标题复用 `session-title`）。落盘位置候选：`.dsh/memory/sessions/<id>.md`（frontmatter: sessionId/title/cwd/startedAt/updatedAt/tokens/sourceSeqs/status）或 jira KB（全局）。
- **L2 注入**：`agentContextSources` 的 memory 源注入最近 N 条摘要/上次会话摘要，小预算（~2–4 KiB）。
- **L2 丢弃**：按条数/TTL/被取代折叠；摘要只是工作记忆，沉淀为"已验证知识"后进 jira KB，然后可从 memory 里 drop。
- **L3 接线**：memory 插件启用时挂 `dsh-tool-session-query`（或薄包装），把全文检索能力交给模型；当前会话的读取限制需要单独评估（`session_event_read`/`session_event_search`）。
- **与 jira KB 的分工**：KB 是长期语义记忆（事实、决策、runbook）；`.dsh/memory` 是项目工作记忆；L2 摘要是两者之间的过渡层。

### 外部对照

用户的三层模型与 claude-mem 最接近（原始观察 → 压缩摘要 → 三层检索工具），但 claude-mem 的 L2 是自动压缩、需要后台 worker；Letta 的结构相反（核心记忆块常驻、原始消息可检索）。DSH 的原语天然对应：`compaction/summary` 事件就是 L2 的现成产物，`session-query-sqlite` 是 L1 的索引，`tool-session-query` 是 L3 的雏形——因此新插件应"组合现有原语"，而不是新建一套存储与检索。
