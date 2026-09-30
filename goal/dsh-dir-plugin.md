# 工作区 .dsh/ 存储管理插件（设计）

本文件是 [task14](mission/task14.md) 的设计文档：为一个专门管理**工作区 `.dsh/` 目录**的插件定下工具面、路径与安全模型、能力缺口的实现路线、阶段划分，以及它与后续「目录形式 rules」加载器的衔接。原理与分支规则见 [rebase-friendly.md](rebase-friendly.md) 与 [AGENTS.md](AGENTS.md)。

## 目标与非目标

**目标**：agent 用一句话告诉插件「创建 / 查询 / 删除 `.dsh/` 下的什么文件和文件夹」，插件负责路径解析、越界拒绝、策略门禁、结果渲染。它是 `.dsh/` 的唯一写入面，为 `.dsh/rules/**`、`.dsh/skills/**` 这类项目级内容提供受控的创建与清理能力。

**非目标**：不做规则语义（不解析 rules 内容、不注入上下文，那是后续任务单）；不做任意工作区路径的通用文件管理（通用路径已有 `tool-fs`）；不做 `.dsh/` 之外的位置。

## 根目录与布局

- 根 = `<projectRoot>/.dsh`，**根名锁定、不做配置项**（用户已定）。project root 的判定与 [skill-filesystem](../packages/skill/skill-filesystem/src/index.ts) 一致：从会话 cwd 向上找 `.git` 标记，找不到则退化为 cwd（标记同样不做配置项，保持与 skill 同源）。这样 `.dsh/rules` 与既有 `.dsh/skills`、`~/.dsh/skills` 的归属完全对齐。
- **默认创建根目录**：挂载后若 `<projectRoot>/.dsh` 不存在，就建一个空目录（`createRoot` 默认 true）。它是一次写操作，所以受策略门禁约束：`read-only` 会话下跳过并记录，不报错。这条保证 `.dsh/` 作为"工作区级约定目录"总是存在，agent 与 UI 不需要先判断再创建。
- 其余配置项：`maxPathLength`、`maxDepth`、`maxReadBytes`（query 读文件的上限）。
- 布局示例：`.dsh/rules/*.md`、`.dsh/skills/<name>/SKILL.md`、`.dsh/runtime.json`。

## 工具面

**已定：只暴露一个工具 `tool-dsh-store`**（工具与插件/包同名；包 `@deepseek-ai/dsh-tool-dsh-store`）。用户明确这个工具的本质是**提醒 agent**——`.dsh/` 下的文件参与 context 与运行时，最好统一经工具管理修改。所以工具面不是"三个文件动词"，而是"一个规范入口"：动作 `create` / `query` / `delete`。

```ts
{
  name: 'tool-dsh-store',
  description: 'Create, inspect, and delete files and folders under the workspace .dsh/ store.',
  parameters: {
    action:    { type: 'string', required: true, enum: ['create', 'query', 'delete'] },
    path:      { type: 'string', required: true, description: 'Path relative to .dsh/, e.g. rules/api.md. Empty selects .dsh/ itself for query.' },
    kind:      { type: 'string', enum: ['file', 'dir'], description: 'Required for create; inferred from stat for query/delete.' },
    content:   { type: 'string', description: 'File text for create + file. Empty writes an empty file.' },
    recursive: { type: 'boolean', description: 'Must be true to delete a directory that has entries.' },
    depth:     { type: 'number', description: 'query on a directory: levels to list; default 1, -1 lists the whole subtree.' },
  },
}
```

动作语义：

| action | kind | 行为 | 说明 |
|---|---|---|---|
| `create` | `file` | `ctx.fs.writeText` 写入 | 父目录由 `writeFileAtomic` 的 `mkdir recursive` 自动建出，不需要单独的建目录步骤 |
| `create` | `dir` | 建空目录（原语，见下） | 已存在且是目录 → 幂等成功；已存在但是文件 → 报错 |
| `query` | 自动 | 文件：`stat` + `readText`（受 `maxReadBytes` 限制）；目录：`listDir`（按 `depth` 递归展开） | 返回结构化条目列表（相对路径、kind、字节数） |
| `delete` | 自动 | 文件直接删；目录需 `recursive: true` | 目录非空且未给 `recursive` → 报错而不是静默递归 |

输出：结构化 `{ path, action, kind, entries? , content?, bytes? }` + `render` 出的人类可读文本；`presentCall`/`presentResult` 先给最小实现（沿用 `tool-fs` 的路径卡片思路），UI 打磨放二期。

### 规范（norm）放在哪

`.dsh/` 的正确性靠"agent 知道该走这条路"，所以规范要有落点，但**一件事只说一遍**：

- **主位：工具的 `description`。** agent 考虑 `.dsh/` 工作时一定读到它，写明"这些文件参与 context 与运行时，请用本工具创建/查询/删除，不要用 `write`/`edit`/`bash` 直接改"。
- **强化位：`ctx.systemPrompt.section({ name: 'tool:dsh', … })`。** 只写一句指向性的话（例如".dsh/ 下的内容用 `dsh` 工具管理"），**不重复**描述里的参数规则。
- **不做硬拦截。** `write`/`edit` 不属于本插件，给它们加围栏是原生改动；先落软规范。
- **可选补强（低成本、走现成 seam）**：订阅 `ctx.on('fs/observed')`，发现 `.dsh/` 下的**非本工具**写入时给一次提醒，说明这份内容应经 `dsh` 工具维护。`skill-filesystem` 已在用同一条 seam 做失效，不需要新机制。

### 写入前校验（"统一规范"的落点）

内容会喂 context 与运行时，所以 `create` 按命名空间校验后再落盘，**宁可拒绝也不写入坏数据**；校验失败返回结构化错误（字段 + 原因），不产生半成品文件：

| 命名空间 | 校验 | 复用 |
|---|---|---|
| `rules/**` | **无需格式校验**（纯 Markdown，加载器逐字注入）；但写入前比对 trim 后内容与现有规则，命中重复就提示并拒绝落盘 | 自建（对应"写 rules 时注意去重"的纪律） |
| `mcp.json` | 整体按 MCP 客户端配置校验：serverName 归一化、传输联合、URL scheme、header/env 去重与合法性 | `@deepseek-ai/dsh-mcp-client` 的 `Config`，写法照 [acp/src/mcp.ts](../packages/acp/acp/src/mcp.ts:26) 的 `mountAcpMcpServers` |
| `skills/**` | `SKILL.md` front-matter 必填项与 `name` 语法 | `isSkillName` @ `@deepseek-ai/dsh-skill` |
| 其它路径 | 只做路径与字节限制 | — |

## 路径与安全模型

模型可控的路径必须过一张拒绝矩阵，全部在 `src/paths.ts` 里集中实现与测试：

| 输入形态 | 处理 |
|---|---|
| 绝对路径（`/x`、`C:\x`、`\\srv\share`） | 拒绝 |
| 规范化后越出根的 `..` 段 | 拒绝 |
| `~`、`$HOME`、`%USERPROFILE%` | 不展开，直接拒绝 |
| 空路径或只有分隔符 | `query` 视为 `.dsh/` 根；`create`/`delete` 拒绝 |
| 软链：`.dsh` 本身或中间/末段指向根外 | `realpath` 后校验归属，越界拒绝 |
| 长度 > `maxPathLength`（默认 240）或深度 > `maxDepth`（默认 32） | 拒绝 |
| Windows 保留名（`CON`/`NUL`/`COM1`…）与非法字符 | 拒绝 |
| `.`、`./`、重复分隔符 | 归一后放行 |

写操作前的**策略门禁**（与 `fs-sandbox` 同一套语义）：

- `read-only`：`create`/`delete` 一律拒绝，`query` 放行（`fs-sandbox` 对读取不做限制，保持一致）。
- `workspace-write`：仅当目标的 realpath 落在策略的 writable root 内才允许；`.dsh/` 在工作区内，正常路径天然满足；`.dsh` 是工作区外软链时拒绝。
- `danger-full-access`：允许，但仍受 `.dsh/` 根与拒绝矩阵约束。
- 拒绝输出走 `@deepseek-ai/dsh-sandbox` 的 denial marker，让模型看到的措辞与 fs/bash 一致（而不是插件自造的错误文案）。

**威胁模型声明**（写进 README 的 Known Limitations）：这里的检查是可信代码对模型可控路径的策略检查，与 `fs-sandbox` 自述的定位相同——containment，不是内核边界。宿主机进程不受 Windows ACL 沙盒约束，所以策略判断是唯一门禁；因此把根严格限定在 `.dsh/`，绝不开放任意工作区路径的删除。

## 能力缺口与实现路线

`ctx.fs` 现状：`resolve` / `contains` / `stat` / `lstat` / `listDir` / `readText` / `streamText` / `readBytes` / `writeText` / `editText`。**没有建目录，也没有删除**——用户已批准补齐这两个原语。

**已选路线（在服务定义上声明，本地链实现并加围栏）**：

| 文件 | 改动 | 说明 |
|---|---|---|
| `packages/fs/fs/src/index.ts` | 声明 `mkdir` / `remove`，**具体方法 + 默认抛 `FS_UNSUPPORTED`** | 让类型对所有消费者可见；测试替身与未实现的 provider 无需改动即可编译，运行时明确失败 |
| `packages/fs/fs-local/src/index.ts` + `src/fsio.ts` | 实现两个原语 | `mkdir` 递归建；`remove` 由 `{ recursive }` 控制，带 abort 检查与错误映射 |
| `packages/fs/fs-sandbox/src/index.ts` | 两个方法都过现成的 `checkedTarget` 围栏 | `read-only` 拒绝、`workspace-write` 做 containment——**不需要插件自造门禁** |
| `packages/extensions/tool-cordis/src/api-catalog.ts` | 生成物 | 由 `pnpm run gen-cordis-api` 重建（服务定义变了） |
| `fs` / `fs-local` / `fs-sandbox` 三方 README + 双语/i18n 记录 | 文档 | 新操作的行为、错误码与围栏语义 |

**已知限制（写进 README）**：`fs-ssh` 暂不实现——SSH 远端要同时扩展 `dsh-ssh` 的远端协议与 helper，属远端协议改动（涉及版本兼容）。因此 SSH 工作区上的 `.dsh/` store 会**明确失败**（`FS_UNSUPPORTED`）而不是静默降级。

**备选（完整 seam）**：连 `fs-ssh` + `ssh` 协议/helper + 5 个测试替身一起补齐，让所有 provider 都支持。面更大，且远端协议改动要单独评估兼容性；适合作为独立的上游提案。

（原先的"方案 B：插件内用 `node:fs` + 自造策略门禁"已废弃——既然能改原生，就没有理由让删除绕过 `fs-sandbox` 的围栏。）

## 与既有扩展点的关系

- 注册：`ctx.tools.register(defineTool({...}))`，按 [tool-fs/write.ts](../packages/fs/tool-fs/src/write.ts) 的形状写；系统提示指导段用 `ctx.systemPrompt.section({ name: 'tool:tool-dsh-store', order: ctx.systemPrompt.getSectionOrder('TOOL_...'), text })`，仅在工具可见时输出文本。
- 服务：`ctx.fs`（路径与读写）、`ctx.get('sandboxPolicy')`（会话策略；与 `ctx.fs.sandboxMode` 一起判断是否 confining）。
- 触达：`create`/`delete` 成功后 `ctx.emit('fs/observed', target, { kind, version }, exec)`，让按文件系统触达工作的消费者（`agent-instructions` 的子目录发现、skill 的观察失效）能看见 `.dsh/` 的变化——这是 rules 加载器「改了就刷新」的基础。
- 只读查询面：为侧边栏 UI 提供"列某工作区 `.dsh/rules/**`"与"读单条规则正文"的能力，路径在 host 侧解析并限制在 `.dsh/rules` 内。
- 观测：`presentCall`/`presentResult` 给最小卡片（工具调用在会话里的呈现）。

## 侧边栏 UI：工作区 rules 查看（已定）

用户已定：UI 需要，且落在**侧边栏的工作区列表**里——每个工作区一条，按钮位置在**「新建会话」按钮右侧**，点开查看该工作区的 rules。

- **形态**：客户端 UI 包 `@deepseek-ai/dsh-client-ui-tool-dsh-store`（目录 `packages/uitstalie/ui-tool-dsh-store/`），与 host 包分开，沿用本分支 `models-dev` + `ui-models-dev` 的既有分工。
- **数据来源**：host 侧由 `tool-dsh-store` 提供**只读**查询面（列出某工作区 `.dsh/rules/**`、读取单条规则正文），客户端经现有 Remote/RPC seam 调用。客户端只传 workspace id：路径由 host 侧解析并限制在 `.dsh/rules` 内，**不把任意路径读取暴露给客户端**。
- **展示**：规则列表（文件名 + front-matter 的 `description` + `alwaysApply`/`globs` 摘要）→ 点开看正文；空目录给空状态（引导"这个工作区还没有 rules"）；单条解析失败单独标注，不让整页报错。
- **文案**：走 locale 字典（仓库 `verify-client-ui-i18n` 拒绝硬编码文案），中英各一份。
- **待补**：按钮的 slot/注册点、客户端读工作区数据的 Service、以及新客户端包必须登记的聚合文件清单，由正在进行的侧边栏代码调查敲定后写入 [task14](mission/task14.md) 的「修改范围」。

## 阶段与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 | 本设计文档 + 任务单 | 文档评审通过 |
| P1 | host 包骨架、`paths.ts`、`store-ops.ts`（含**根目录 ensure-create**）、单测 | 拒绝矩阵全绿；`read-only` 拒绝用例全绿；挂载后空 `.dsh/` 被创建 |
| P2 | `tools.ts` 注册单工具 `tool-dsh-store`、提示段、输出渲染、`fs/observed`、命名空间校验 | 单测 + 手工调用可建/查/删；非法内容被拒 |
| P3 | host 只读查询面（列 `.dsh/rules`、读单条）+ 真实 Loader 组合测试、profile 挂载 | 组合测试绿；查询面只接受 workspace id |
| P4 | 客户端包：侧边栏工作区 rules 按钮（「新建会话」右侧）+ 查看视图 | Web 上每个工作区按钮可见可用；空状态正常；文案走 locale |
| P5 | 双语 README + i18n 记录、类型/构建/聚焦测试 | `pnpm run typecheck`、`pnpm run build`、`vitest run packages/uitstalie` 全绿 |
| P6 | **新任务单（[task15](mission/task15.md)）**：rules 常驻注入 + 交付前自检 | 见 [rules.md](rules.md) |

提交拆分：host 包、client 包、docs 各自独立提交（分支自有文件）；原生登记（`tsconfig.host.json`、`tsconfig.client.json`、`tsconfig.base.json` 手写别名）单独一个提交，带 `uitstalie-` 标记。

## 与 rules 加载器（[task15](mission/task15.md)）的衔接

加载器**不改** `agent-instructions`（它的候选过滤只支持同目录文件名），而是新插件/新模块，复用同一套注入框架：

- 扫描 `<projectRoot>/.dsh/rules/**/*.md`（可配置 glob 与扩展名），按路径深度「宽 → 具体」排序，与 `agent-instructions` 的优先级方向一致。
- 注入形态沿用它的契约：**带来源的 user 消息**、`<system-reminder>` 框架、`maxBytes` 预算（先丢宽文件、再截断最具体的文件并输出预算通知）、内容去重、变更/移除通知、`</system-reminder>` 转义、会话日志可完整重建。
- 可选增强：front-matter 里的 `globs`/`alwaysApply` 决定是否注入（这是「目录形式 rules」相对单文件 AGENTS.md 的主要收益）。
- 刷新：本插件发出的 `fs/observed` + 成功读写的触达，正好是加载器需要的变更信号。

## 未决问题（需用户拍板）

1. ~~工具面粒度与命名~~ **已定**：单工具、名为 `tool-dsh-store`，包与插件同名。
2. ~~根名~~ **已定**：锁定 `.dsh`，不做配置项，且默认创建该空目录。
3. ~~是否要 UI~~ **已定**：侧边栏工作区列表、「新建会话」右侧的 rules 按钮 + 查看视图。
4. **删除的开放时机**：本阶段就开放 `delete`（非空目录需显式 `recursive: true`），还是先只做 `create`/`query`、删除留到后面？
5. **原语路线**：确认方案 B（零原生改动 + 自建门禁）；若接受方案 A（扩 `FileSystem` 服务定义），修改范围需要重写。
6. **规范强度**：只落软规范（工具描述 + 提示段），还是加"检测到非本工具写入 `.dsh/` 给一次提醒"（订阅 `fs/observed`）？
7. **rules 视图是否只读**：本期按只读设计；若要在 UI 里直接编辑/删除规则，需要补写面与编辑交互，属另一阶段。
