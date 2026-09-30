# 工作区 .dsh/ 存储管理插件（设计）

本文件是 [task14](mission/task14.md) 的设计文档：为一个专门管理**工作区 `.dsh/` 目录**的插件定下工具面、路径与安全模型、能力缺口的实现路线、阶段划分，以及它与后续「目录形式 rules」加载器的衔接。原理与分支规则见 [rebase-friendly.md](rebase-friendly.md) 与 [AGENTS.md](AGENTS.md)。

## 目标与非目标

**目标**：agent 用一句话告诉插件「创建 / 查询 / 删除 `.dsh/` 下的什么文件和文件夹」，插件负责路径解析、越界拒绝、策略门禁、结果渲染。它是 `.dsh/` 的唯一写入面，为 `.dsh/rules/**`、`.dsh/skills/**` 这类项目级内容提供受控的创建与清理能力。

**非目标**：不做规则语义（不解析 rules 内容、不注入上下文，那是后续任务单）；不做任意工作区路径的通用文件管理（通用路径已有 `tool-fs`）；不做 `.dsh/` 之外的位置。

## 根目录与布局

- 根 = `<projectRoot>/.dsh`。project root 的判定与 [skill-filesystem](../packages/skill/skill-filesystem/src/index.ts) 一致：从会话 cwd 向上找 `.git` 标记，找不到则退化为 cwd。这样 `.dsh/rules` 与既有 `.dsh/skills`、`~/.dsh/skills` 的归属完全对齐。
- 配置项：`rootDir`（默认 `.dsh`）、`projectRootMarkers`（默认 `['.git']`）、`maxPathLength`、`maxDepth`、`maxReadBytes`（query 读文件的上限）。
- 布局示例：`.dsh/rules/*.md`、`.dsh/skills/<name>/SKILL.md`、`.dsh/runtime.json`。

## 工具面

推荐**单工具多动作**——用户的描述是「告诉插件做什么 + 在哪」，一个工具一次表达完，也省一份工具定义开销。备选是拆成三个单动词工具（贴合仓库 `read`/`write`/`edit` 的现状）。

```ts
// 方案 1（推荐）：单工具
{
  name: 'dsh_dir',
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

// 方案 2（备选）：三个单动词工具
// dsh_create(path, kind, content?) / dsh_query(path, depth?) / dsh_delete(path, recursive?)
```

动作语义：

| action | kind | 行为 | 说明 |
|---|---|---|---|
| `create` | `file` | `ctx.fs.writeText` 写入 | 父目录由 `writeFileAtomic` 的 `mkdir recursive` 自动建出，不需要单独的建目录步骤 |
| `create` | `dir` | 建空目录（原语，见下） | 已存在且是目录 → 幂等成功；已存在但是文件 → 报错 |
| `query` | 自动 | 文件：`stat` + `readText`（受 `maxReadBytes` 限制）；目录：`listDir`（按 `depth` 递归展开） | 返回结构化条目列表（相对路径、kind、字节数） |
| `delete` | 自动 | 文件直接删；目录需 `recursive: true` | 目录非空且未给 `recursive` → 报错而不是静默递归 |

输出：结构化 `{ path, action, kind, entries? , content?, bytes? }` + `render` 出的人类可读文本；`presentCall`/`presentResult` 先给最小实现（沿用 `tool-fs` 的路径卡片思路），UI 打磨放二期。

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

`ctx.fs` 现状：`resolve` / `contains` / `stat` / `lstat` / `listDir` / `readText` / `streamText` / `readBytes` / `writeText` / `editText`。**没有建目录，也没有删除。**

**方案 B（推荐，符合分支「只走新增路径」规则）**：这两个原语在插件内实现，集中在 `src/store-ops.ts`：

- 用 `node:fs` 的 `mkdir` / `rm`，但调用前必须完成：`ctx.fs.resolve` 规范化 → `.dsh/` 根归属校验（realpath）→ 会话策略门禁。
- 读、写、列举一律走 `ctx.fs`（读 `readText`/`listDir`/`stat`，写 `writeText`），只有这两个缺口用宿主 `node:fs`。
- 原生文件零改动；将来把能力补进服务定义时，只替换这一个模块。

**方案 A（正解，但违反分支规则且冲突面大，留待上游）**：给 `FileSystem` 服务定义加 `mkdir(target, opts)` 与 `remove(target, { recursive })`，同步实现 `fs-local`（含 `fsio` 原语）、`fs-sandbox`（两个原语都要按 mode 加围栏：`read-only` 拒绝，`workspace-write` 做 containment）、`fs-ssh`，并更新三方 README/JSDoc 与 invariant。适合作为独立的上游提案，不在本分支落地。

## 与既有扩展点的关系

- 注册：`ctx.tools.register(defineTool({...}))`，按 [tool-fs/write.ts](../packages/fs/tool-fs/src/write.ts) 的形状写；系统提示指导段用 `ctx.systemPrompt.section({ name: 'tool:dsh_dir', order: ctx.systemPrompt.getSectionOrder('TOOL_...'), text })`，仅在工具可见时输出文本。
- 服务：`ctx.fs`（路径与读写）、`ctx.get('sandboxPolicy')`（会话策略；与 `ctx.fs.sandboxMode` 一起判断是否confining）。
- 触达：`create`/`delete` 成功后 `ctx.emit('fs/observed', target, { kind, version }, exec)`，让按文件系统触达工作的消费者（`agent-instructions` 的子目录发现、skill 的观察失效）能看见 `.dsh/` 的变化——这是二期 rules 加载器「改了就刷新」的基础。
- 观测/UI：`presentCall`/`presentResult` 先做最小卡片；是否需要专属 Web 面板放二期。

## 阶段与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 | 本设计文档 + 任务单 | 文档评审通过 |
| P1 | 包骨架、`paths.ts`、`store-ops.ts`、单测 | 拒绝矩阵全绿；`read-only` 拒绝用例全绿 |
| P2 | `tools.ts` 注册、提示段、输出渲染、`fs/observed` | 单测 + 手工调用可建/查/删 |
| P3 | 真实 Loader 组合测试、profile 挂载、Web 手工验证 | 组合测试绿；Web 工具表出现 `dsh_dir` 并端到端成功 |
| P4 | 双语 README + i18n 记录、类型/构建/聚焦测试 | `pnpm run typecheck`、`pnpm run build`、`vitest run packages/uitstalie` 全绿 |
| P5 | **新任务单**：`.dsh/rules/**` 目录形式 rules 加载器 | 见下节 |

提交拆分：分支自有文件一个提交（新包 + 文档）；原生登记（`tsconfig.host.json`、必要时 `tsconfig.base.json`）单独一个提交，带 `uitstalie-` 标记。

## 与二期 rules 加载器的衔接

加载器**不改** `agent-instructions`（它的候选过滤只支持同目录文件名），而是新插件/新模块，复用同一套注入框架：

- 扫描 `<projectRoot>/.dsh/rules/**/*.md`（可配置 glob 与扩展名），按路径深度「宽 → 具体」排序，与 `agent-instructions` 的优先级方向一致。
- 注入形态沿用它的契约：**带来源的 user 消息**、`<system-reminder>` 框架、`maxBytes` 预算（先丢宽文件、再截断最具体的文件并输出预算通知）、内容去重、变更/移除通知、`</system-reminder>` 转义、会话日志可完整重建。
- 可选增强：front-matter 里的 `globs`/`alwaysApply` 决定是否注入（这是「目录形式 rules」相对单文件 AGENTS.md 的主要收益）。
- 刷新：本插件发出的 `fs/observed` + 成功读写的触达，正好是加载器需要的变更信号。

## 未决问题（需用户拍板）

1. **工具面粒度**：单工具 `dsh_dir(action)`（推荐）还是三个单动词工具？
2. **命名**：工具 `dsh_dir`、包 `@deepseek-ai/dsh-tool-dsh-dir`、目录 `packages/uitstalie/dsh-dir/`；备选 `dsh_store` / `agent-store`。
3. **删除的开放时机**：本阶段就开放 `delete`（含显式递归），还是先只做 `create`/`query`、删除留到二期？
4. **根名**：固定 `.dsh`，还是做成配置项（默认 `.dsh`，允许部署改名）？
5. **是否要 UI**：设置页或侧栏浏览 `.dsh/`？默认不做，先只给 agent 工具面。
6. **原语路线**：确认方案 B（零原生改动 + 自建门禁）；若接受方案 A（扩 `FileSystem` 服务定义），本任务单的修改范围需要重写。
