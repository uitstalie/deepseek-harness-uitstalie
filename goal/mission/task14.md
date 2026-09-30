# task14 — 工作区 .dsh/ 目录管理插件

## requirement

为支持「目录形式的 rules」，先提供一个专门管理**工作区 `.dsh/` 目录**的插件：agent 只需要告诉插件「创建 / 查询 / 删除什么位置的文件和文件夹」，插件负责解析路径、执行操作、把结果按模型可读的形式返回。

本任务单只做**存储管理面**。目录形式的 rules 加载器（读取 `.dsh/rules/**` 并注入上下文）是紧随其后的独立任务单，见本文末「后续任务」。

## 背景与既有约定

- 工作区 `.dsh/` 已经**是本仓库的项目级约定**，不需要新造隐藏目录名：[skill-filesystem](../../packages/skill/skill-filesystem/src/index.ts) 从 `<projectRoot>/.dsh/skills` 读取项目技能（用户级为 `~/.dsh/skills`），`session-snapshot` 的夹具也用 `.dsh/runtime.json`。因此 `.dsh/rules` 与 `.dsh/skills` 并列，落在同一个被认可的项目级隐藏目录下。
- 归口插件的**规则加载侧**目前无法承接目录形式：[agent-instructions](../../packages/context/agent-instructions/src/config.ts) 的候选名过滤会丢弃含 `/`、`\` 的值，只能表达「同目录文件名」，所以 `.dsh/rules/**` 必须由新插件承载。
- 能力缺口（本任务单的核心设计约束）：`ctx.fs` 服务定义只提供 `resolve` / `contains` / `stat` / `lstat` / `listDir` / `readText` / `streamText` / `readBytes` / `writeText` / `editText`，**没有建目录、没有删除**；`writeText` 走 `writeFileAtomic`，内部 `mkdir(dirname, { recursive: true })`，因此「写到 `.dsh/rules/x.md`」会自动建出父目录，「建一个空目录」和「删除」才需要另想办法。

## 设计要点

完整设计（工具 schema、路径规则、拒绝矩阵、能力缺口的两条路线、阶段划分）见 [dsh-dir-plugin.md](../dsh-dir-plugin.md)。摘要：

1. 根目录**锁定** `<projectRoot>/.dsh`（已定：不做配置项）。project root 的判定与 `dsh-skill-filesystem` 一致（cwd 向上找 `.git` 标记，找不到退化为 cwd）。插件**默认确保根目录存在**：挂载后若 `.dsh/` 不存在，就创建一个空目录（受策略门禁约束，`read-only` 下跳过并记录）。
2. 模型给出的路径**相对 `.dsh/`**；插件负责拼接、规范化并拒绝一切越界形态（绝对路径、盘符、UNC、`..`、`~`、软链逃逸）。
3. 工具面只暴露**一个**工具，名为 `tool-dsh-store`（已定；工具与插件/包同名），动作 `create` / `query` / `delete`，作用对象是文件或文件夹。它的本质是 `.dsh/` 的**统一管理面与规范提醒**：目录下的内容参与 context 与运行时（rules、skills、MCP 声明、runtime 快照），所以 agent 应经它创建/查询/删除，而不是拿 `write`/`edit`/`bash` 直接改。因此 `create` 在落盘前按命名空间校验内容，宁可拒绝也不写入坏数据。
4. 生产写操作前先做策略门禁（`read-only` 一律拒绝；`workspace-write` 仅允许 `.dsh/` 根内），拒绝时复用 `@deepseek-ai/dsh-sandbox` 的 denial marker，使模型看到与 fs/bash 一致的 `[sandbox: …]` 措辞。
5. 建空目录与删除这两个 `ctx.fs` 未提供的原语，集中在插件内单一模块（`src/store-ops.ts`）实现；将来若把能力补进 `FileSystem` 服务定义，只需替换该模块。

## 进度

### 已完成（第一步：路径矩阵 + 存储操作层）

- 新包 `packages/uitstalie/tool-dsh-store/`（`@deepseek-ai/dsh-tool-dsh-store`）：
  - `src/paths.ts`：`.dsh/` 相对路径归一化与**拒绝矩阵**（绝对路径/UNC/盘符、`..` 逃逸、`~`/`$`/`%` 展开、Windows 保留设备名、非法字符与段尾点/空格、长度与深度上限），纯函数、不触碰文件系统。
  - `src/store-ops.ts`：把「建目录 / 写文件 / 查询 / 删除」落到 `ctx.fs` 上（`ensureStoreRoot`、`createStoreFolder`、`createStoreFile`、`queryStoreTarget`、`removeStoreTarget`），只接收已确认在根内的绝对路径，数据形状（`StoreQueryResult` / `StoreEntry` / …）与执行逻辑分离。
  - `src/index.ts`：当前只导出上述两层（工具接线是下一步），否则 tsdown 找不到入口。
  - 测试：`tests/paths.spec.ts`（10 个，逐行钉矩阵）+ `tests/store-ops.spec.ts`（9 个，真实 `LocalFileSystem` + 临时工作区，含"非空目录未给 recursive 必须拒绝"与"空目录可直接删"）。
- 登记：`tsconfig.host.json` 聚合 references（标记行）、`tsconfig.base.json` 别名（生成器自动推断）、`pnpm install` 更新 lockfile。
- 顺带修掉 task8 遗留的 **`ui-models-dev` manifest 问题**（29 条依赖门禁）：非 cordis 的 DSH 依赖下沉 devDependencies、`workspace:^`→`workspace:*`、cordis 保持 peer+dev 的 `workspace:~`、`zod` 移入 devDependencies。`verify-package-dependencies` 现在 75 个包全过。
- **验证**：`tsc -b tsconfig.host.json` 干净、`oxlint` 0 错、**19 个测试全绿**、`pnpm run build` 349 artifact。

### 下一步（按优先级）

1. **工具接线**：`tool-dsh-store` 的 Tool schema（create/query/delete × file/folder）、会话策略门禁（`read-only` 一律拒绝、`workspace-write` 仅限 `.dsh/` 内）、拒绝措辞复用 sandbox denial marker、命名空间校验（`rules/**` 的 Markdown 与重复内容拒绝；`mcp.json` 复用 mcp-client 的 Config 校验；`skills/**/SKILL.md` 必填项）。挂载后确保根目录存在。
2. **五个 uitstalie 包缺 README**：`verify-package-readme-model-experience` 与 `verify-package-readme-limitations` 对 models-dev / llm-plus / ui-models-dev / agent-instructions-plus / tool-dsh-store **全部报缺**（含 Model Experience 段与 `## Known Limitations and Deferred Work` 段，中文对与 i18n 记录同步）。
3. **禁用词重命名**：`verify-concrete-terms` 禁止字面量 `provenance`（全仓库，除 vendor/ 与归档 Agent Notes）。命中处：`models-dev/src/index.ts`（`CatalogProvenance` 类型与字段）、`scripts/gen-cordis-catalog.ts` 的豁免说明、生成物 `api-catalog.ts` 与 `docs/subsystems/llm-streaming{,.zh}.md`、以及本目录的若干任务单。需改名为具体来源词（如 `CatalogOrigin` / `origin`）后重跑 `gen-cordis-api`。
4. 侧边栏 rules UI（`ui-tool-dsh-store`）与 Remote 只读 namespace。

## 修改范围

- 新增分支自有文件：
  - 新包 `packages/uitstalie/tool-dsh-store/`（包名 `@deepseek-ai/dsh-tool-dsh-store`，工具名同为 `tool-dsh-store`）：`package.json`、`tsconfig.json`、`src/*`、`tests/*`、`README.md` + `README.zh.md` + `README.i18n.yaml`。
  - 客户端 UI 包 `packages/uitstalie/ui-tool-dsh-store/`（包名 `@deepseek-ai/dsh-client-ui-tool-dsh-store`）：工作区侧边栏"新建会话"按钮**右侧**的 rules 按钮，以及该工作区 rules 的查看视图。
  - 本任务单与设计文档 [dsh-dir-plugin.md](../dsh-dir-plugin.md)。
- 原生文件（全部为新增行 / 最小块，逐处 `uitstalie-` 标记登记；具体清单在 UI 调查结论回来后定稿）：
  - **`FileSystem` 两个原语**（已实现并验证）：`packages/fs/fs/src/index.ts`（声明 `mkdir` / `remove`，默认实现抛 `FS_IO_ERROR` 并指名后端——沿用同文件 `watch()` 的"不支持即报错"先例）、`packages/fs/fs/src/types.ts`（新增 `FsRemoveOptions`）、`packages/fs/fs-local/src/index.ts` + `src/fsio.ts`（实现：建目录递归、删除由 `recursive` 控制，非空目录未给 `recursive` 时拒绝）、`packages/fs/fs-sandbox/src/index.ts`（两个方法都过现成的 `checkedTarget` 围栏）；测试新增 `fs-local/tests/filesystem.spec.ts` 与 `fs-sandbox/tests/fs-sandbox.spec.ts` 各一组用例；`fs` / `fs-local` / `fs-sandbox` 三份 README + `.zh.md` + `README.i18n.yaml` 记录同步。**不含 `fs-ssh`**（远端协议改动，见设计文档「已知限制」）。
  - **待生成**：`packages/extensions/tool-cordis/src/api-catalog.ts`（`pnpm run gen-cordis-api`）当前被 task8 遗留缺口阻塞——`models-dev/updated` 事件引用了未分类类型 `CatalogProvenance` 与 `ModelsDevCatalog`；已登记到 [task17](task17.md) 待办。
  - **侧边栏 slot**：`packages/client/ui-workspace/src/client/contract/slots.ts`（SlotMap 新增 seat）、`src/client/index.ts`（children 声明）、`src/client/rows/Rows.tsx`（`.rowActions` 内加 `renderSlot`）。
  - `tsconfig.host.json`：注册 host 包（做法同 task6）。
  - `tsconfig.client.json`：注册 client 包（做法同 task8）。
  - `tsconfig.base.json`：别名。生成区由 `pnpm run gen-tsconfig-paths` 重建；client 包因目录前缀与 `dsh-client-ui-*` 命名不吻合，需手写根别名（同 task8）。
- 不改 `FileSystem` 服务定义、不改 `agent-instructions`（能力缺口由新包内原语 + 自行门禁补齐）。
- 挂载走**用户层 profile 补丁**（`~/.dsh/profiles/web/cordis.patch.yml` 插行），不进原生 bundle；本机验证用，不入仓库。

## 侧边栏 UI 接线（代码调查结论；原生改动待批准）

- **目标位置**：工作区行的"新建会话"按钮右侧，即 `ProjectRowItem` 的 `.rowActions` 容器（[Rows.tsx:268-308](../../packages/client/ui-workspace/src/client/rows/Rows.tsx:268)，按钮本体 :297-307）。
- **现状**：该位置**没有任何 slot**。[ui-workspace 的 SlotMap](../../packages/client/ui-workspace/src/client/contract/slots.ts:114) 只有 `sidebar.workspaces.directoryFlow`、`.session.menu.item`、`.session.row.action`、`sidebar.session.row.leading`、`.hover`；逐工作区动作只有硬编码的 Rename/Delete 菜单。
- **因此**：要精确落在该位置，必须在 `packages/client/ui-workspace` 新增**一个逐工作区的 list slot**（例名 `sidebar.workspaces.row.action`），三处**纯新增行**、逐处 `uitstalie-` 标记登记：
  1. `src/client/contract/slots.ts` — SlotMap 声明；
  2. `src/client/index.ts` — children 声明（照 :271 形状）；
  3. `src/client/rows/Rows.tsx` — `.rowActions` 内 `renderSlot(...)`（照 :687 形状）。
  既有行为不变（只多一个可注入 seat）。
- **零原生改动的替代都不满足需求**：`sidebar.footer.action` 是已有的 slot，但只有全局一个按钮；工作区行的"..."菜单同样硬编码（仍需改原生）；在 `sidebar.workspaces`（single）里自渲染整块会重复 ui-workspace 的渲染。
- **其余全走新路径**：新 client 包用 `ctx.slots.inject(...)` 注册（模板 [ui-schedule/src/client/index.ts:231](../../packages/client/ui-schedule/src/client/index.ts:231)）；工作区数据用 `ctx.get('workspaces')` 的 `WorkspaceView.path`（[types.ts:18](../../packages/api/workspace-controller/src/types.ts:18)）；读 `.dsh/rules` 走**本插件自己的 Typert Remote 只读 namespace**（`workspaceFiles` 是 session-scoped，不能复用），照 `models-dev` + `ui-models-dev` 的包内自挂模式。
- **登记清单**：`tsconfig.client.json`、`tsconfig.base.json`（手写别名）、`tsconfig.host.json`；挂载走用户层 profile patch，不动 `packages/bundle/web-app/*`。

## 验证

- 单测：路径拒绝矩阵（`..`、绝对路径、盘符、UNC、`~`、软链逃逸）、三个 action 的正常路径、`read-only` 下拒绝、删除非空目录必须显式递归开关。
- 命名空间校验：`rules/**` 的 front-matter 与 YAML 可解析性、`mcp.json`（复用 `@deepseek-ai/dsh-mcp-client` 的 `Config` 校验）、`skills/**/SKILL.md` 的必填项与 `name` 语法；非法内容必须被拒绝且不落盘。
- 真实 Loader 组合测试（[packages/AGENTS.md](../../packages/AGENTS.md) 要求 product-visible 插件必须有非单测的真实组合测试）：在测试 profile 里挂载插件，断言工具注册、一次端到端调用，以及**挂载后空 `.dsh/` 被创建**。
- UI：Web 里每个工作区在"新建会话"按钮右侧出现 rules 按钮；点击打开该工作区 `.dsh/rules` 的列表与规则正文；没有 rules 时给空状态而不是报错。
- `pnpm run typecheck`、`pnpm run build`、聚焦 `vitest run packages/uitstalie`。
- 手工验证：Web 会话里工具出现在模型工具表，能对 `.dsh/rules` 建、查、删。

## 待办与风险

- 待用户拍板：删除是否本阶段就开放、原语路线（方案 B 确认）、规范强度（软规范 vs 加 `fs/observed` 提醒）、rules 视图是否只读。
- 风险：插件内的策略检查是**可信代码对模型可控路径的检查**（与 `fs-sandbox` 自身声明的威胁模型一致：containment，不是内核边界）；宿主机进程不受 Windows ACL 沙盒限制，所以策略判断是唯一门禁——因此根严格限定在 `.dsh/`，不做任意工作区路径的删除。
- 风险：`.dsh/` 若本身是软链，需按 realpath 判定归属并在 README 记录；插件默认创建根目录属于写操作，`read-only` 会话下必须跳过而不是失败。
- 风险：rules 视图是**跨工作区**的读取面，需要 host 侧只读接口（列目录 + 读文件），不能把任意路径读能力暴露给客户端。
