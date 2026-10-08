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

### 已完成（第二步：工具接线）

- **工具面板**（`src/tool.ts`）：单个 `tool-dsh-store`，`action` 取 `create` / `query` / `delete`，`path` 相对 `.dsh`，另有 `target` / `content` / `recursive`。工具描述说明它是 `.dsh` 的统一入口（rules、skills、runtime 都在这下面），并点名它比通用 write/edit/shell 更合适。
- **会话策略门禁**（`src/policy.ts`）：每次**写**调用解析会话策略，`read-only` 用共享的 `[sandbox: …]` 拒绝标记拒绝；**查询不过门禁**（读不写存储区，只读会话仍可查看）。策略对象同时传给 `mkdir` / `writeText` / `remove`，限定型后端围栏同一次调用。刻意**不**广告 `sandbox_permissions` 升级参数，因此拒绝文本只给标记、不给模型用不上的重试提示。
- **`rules` 命名空间校验**（写前拒绝、不落盘）：必须是 `rules/**/*.md`、正文非空、且正文（去首尾空白后）不得与已有规则重复——重复检查复用 loader 包（`agent-instructions-plus`）的扫描函数，避免第二份"规则是什么"的实现。
- **每会话准备存储根**（`src/index.ts`）：按会话解析 `<projectRoot>/.dsh`（`cwd` 向上找 `.git`，找不到退化为 `cwd`），在首次 `agent/pre-step` 与每次工具调用前确保其存在；`read-only` 不标记为已完成，会话后续变为可写时会补建。
- **测试 31 个全绿**：路径矩阵 10、存储操作 9、工具层 11、**真实 Loader 组合 1**（YAML 组合启动 → 生产 Agent → 断言工具被注册、pre-step 后空 `.dsh/` 出现、工具调用真实落盘）。
- 验证：`tsc -b tsconfig.host.json` 干净、`oxlint` 0 错、`pnpm run build` 349 artifact、依赖门禁与文档门禁全绿。
- 顺带完成 README 三件套（见 [task20](task20.md)）：本包的 Model Experience 从"单句 none"升级为**结构化**条目（工具 schema、结果文本、KV 影响），并撤掉门禁表里那条"工具属于后续工作"的登记。

### 已完成（第三步：命名空间校验收尾）

- **`skills/**` 校验**（`src/namespaces.ts`）：只接受技能根真正发现的两形态（`skills/<name>.md` 与 `skills/<name>/SKILL.md`，依据 [skill-filesystem](../../packages/skill/skill-filesystem/src/index.ts) 的 `isPotentialSkillPath`）、frontmatter 必须是 YAML 映射、`name` 必须满足技能加载器导出的 `isSkillName` 规则（`^[a-z0-9]+(?:-[a-z0-9]+)*$`）、`description` 必须非空、三个旧版驼峰键必须报错并指向规范键。判据全部对齐加载器的真实行为（加载器对坏文件是"忽略 + 警告"，我们在写入前就拒绝，因此坏技能不会落盘）。
- **`mcp.json`：** 决定**不做**。全仓库检索显示 `.dsh/mcp.json` **没有任何消费者**（唯一出现是本文档与 README），按仓库"公开选择必须有当前消费者证据"的规则，为它写校验等于凭空发明约定；已在 README 的 Known Limitations 与 Dev Note 里记录该判断与前提（先有消费者，再谈校验）。
- **测试 33 个全绿**（新增 2 个 skills 用例：接受两种形态；拒绝无 frontmatter、缺 name、非法 name、缺 description、旧版键、过深路径，且拒绝时 `.dsh/skills` 不存在＝没落盘）。

### 已完成（第四步：侧边栏数据面 —— 只读 Remote namespace）

- **`src/remote.ts`**：`StoreRulesRemote extends TypertRemoteService`（服务键 `dshStore`），两个 `@Remote` 只读方法 `listRules(workspaceRoot)` / `readRule(workspaceRoot, path)`。四个要点：
  - **按工作区根寻址**（不像 `workspaceFiles` 那样由 SessionId 派生）——工作区行可能还没有任何会话；
  - **围栏**：读取前先拿 `ctx.workspaceRegistry.list()` 核对根，不认识的根一律以 `store/unknown-workspace` 拒绝（Remote 参数来自浏览器，不能直接信任）；
  - **列表复用 loader 的扫描函数**（`scanWorkspaceRules`），因此面板显示的正是加载器真正注入的那一组（同样去重、同样路径序）；
  - 读取一律走 `ctx.fs`（不用 node:fs），路径先过 `.dsh` 拒绝矩阵；`RemoteError` 错误码经 `RemoteErrorDetailsMap` 声明合并注册（Typert 要求边界类型从非根 `types` 子路径导出）。
- **接线机制确认（重要，省掉一整类改动）**：客户端插件**自己挂载**宿主生成物——`import storeRemote from '@deepseek-ai/dsh-tool-dsh-store/remote'` 后 `ctx.remote.$mount(storeRemote)`（照 ui-models-dev 的包内自挂模式），**因此不需要改 `packages/api/remotes`**。
- **`lib/typert.host.js` 与 `lib/typert.remote-client.js` 由构建自动生成**（没有独立代码生成命令）；`package.json` 已补 `./typert` / `./remote` / `./types` 导出与 `files` 条目。
- **测试 37 个全绿**（新增 4 个：拒绝非 Host 拥有的根、返回拥有的根、容忍同一根的另一种写法、剥离 store 前缀）。

### 已完成（第五步：客户端半边 —— 侧边栏 rules 按钮）

- **原生插入（比预告的"三处"多，实际 4 个文件 7 处，全部为新增行 + 标记）**：
  1. `ui-workspace/src/client/contract/slots.ts`：`WorkspaceRowOwnerProps`（工作区身份 + 标签）与 SlotMap 条目 `sidebar.workspaces.row.action`（list/root），以及 `WorkspaceBrowserProps` 的 `PropsRenderSlots` 联合；
  2. `src/client/index.ts`：父注册的 `children` 声明该 seat；
  3. `src/client/rows/Rows.tsx`：`RowRenderSlots` 联合、`ProjectRowItem` 的 `renderSlot` 参数，以及 `.rowActions` 内、新建会话按钮**右侧**的 `renderSlot` 调用；
  4. `src/client/rows/WorkspaceBrowser.tsx`：把 `renderSlot` 透传给行组件。
  - **偏差登记一**：`ProjectRowItem` 的 `renderSlot` 声明为**可选**（浏览器根始终传入）。理由：设为必填会让既有 `rows.client.spec.tsx` 的 9 处直接构造报错，而按仓库惯例要包一层默认值（改原生测试 9 处）；可选 + 显式 `!== undefined` 守卫把原生差异压到最小。代价：若浏览器根漏传，seat 静默不渲染。
  - **偏差登记二**：`ui-workspace` 的 **README 未改**（其 slot 清单属原生双语文档，改了要重录配对）。seat 由本包的 README 记录为占用方。
- **客户端包 `packages/uitstalie/ui-tool-dsh-store/`（`@deepseek-ai/dsh-client-ui-tool-dsh-store`）**：`ctx.remote.$mount(storeRemote)` 自挂 Remote → 内层 `ctx.inject(['slots','remote.dshStore'])` → `slots.inject(SEAT)` 注册按钮；`RulesButton` 用 ui-primitives 的 `Button` + `MenuSurface`（自定义下拉的强制容器）+ `MenuItemButton`，面板列出规则路径与字节数、点选后就地读正文，空态/失败态/读取失败态都有文案，Esc 与关闭控件都能收起。文案经 `ctx.locale.register(NS, { zh, en })` 双语注册。
- **登记**：`tsconfig.client.json` 引用、`tsconfig.base.json` 手写根别名（client 前缀推不出）+ **手写 `/types` 子路径别名**、`pnpm install` 的 lockfile。
- **验证**：`tsc` 客户端面与宿主面均干净、`oxlint`（本包 + ui-workspace）0 错、**组件测试 6 个全绿**、`ui-workspace` 396 个既有测试全绿、`pnpm run build` **351** artifact（新增 2 个 client 产物）、21 条文档门禁全绿。

### 发现的既有问题与边界（不在本任务单范围）

- **`test:gui` 8 个失败，均与本改动无关**：3 个 `ui-theme` 样式规格是 **`ui-models-dev` 既有 CSS 违规**（中性 token 边框用了 `1px`，规格要求 `0.5px`；另有 `corner-shape` 缺失）；其余 4 个分别在 `client/connection`（binary rpc gzip）、`ui-deliverables`（symlink 打开）、`ui-sidebar-documentpreview`（license chunk）、`ui-sidebar-right`（持久化字节）——都与本次改动面无关。
- **平面边界**：宿主面声明的 Remote 错误码（`src/types.ts` 的 `RemoteErrorDetailsMap` 增强）在**客户端测试程序**里合并不上（探针证明组件能看到、测试文件看不到）。本版 UI 不按错误码分支，因此用协议自带错误码写测试桩；将来若要按 `store/not-found` 之类分支，需要把错误码声明放到两个面都能加载的模块。

### 已完成（第六步：挂进仓库组合层 + 编译测试）

**原生插入（5 处，全部带标记）**——不再走本机 profile patch，直接由仓库声明：

1. `packages/bundle/web-app/cordis.patch.yml`：紧随 `ui-workspace` 行插入 client 行 `ui-tool-dsh-store`（seat 的声明者在前，占用者在后）；
2. `packages/bundle/web-app/presets/{standard,ptc,cordis}.patch.yml`：在 task16 的同一个标记块内、plus 行之后插入 host 行 `tool-dsh-store`（工具随 agent preset 组装，与 tool-bash/tool-fs 同侧）；
3. `packages/bundle/web-app/package.json`：新增两个依赖（`@deepseek-ai/dsh-tool-dsh-store`、`@deepseek-ai/dsh-client-ui-tool-dsh-store`）——preset 与 client 行里的裸包名必须能在 bundle 的 manifest 里解析。

**编译测试结果**：

- `pnpm install` ✓、`pnpm run build` ✓（**351** client artifact）；
- `tsc -b tsconfig.client.json` ✓、`tsc -b tsconfig.host.json` ✓；
- 组合敏感测试：`packages/uitstalie` + `packages/preset/agent-preset-registry` 共 **17 文件 / 131 测试全绿**（含 preset 守卫测试与 store 的真实 Loader 组合测试）；
- bundle 自身的组合测试：`packages/bundle/web-app/tests/{web-app,startup}.spec.ts` **22 个全绿**——新的 client 行与 preset 行在组合里可解析、可启动。

**环境性失败（非本次改动）**：`ui-sidebar-documentpreview` 的许可证打包测试失败于**本机 pnpm store 损坏**（`D:\.pnpm-store\...\@pnpm\exe\package.json` 缺失，`pnpm pack` 起不来）；该修复涉及工作区外路径，按用户要求不擅自改动。

### 已完成（第七步：受控 dev server 验证）

从**本 checkout**（不是兄弟 checkout）启动受管 dev server：`pnpm run dev:web -- --skip-build --no-open --port 3081`（后台 job `pwsh-108`；3080 上用户原有的 GUI 未受影响）。

服务端可观测的三层证据：

1. **启动日志**：`dev-web: watching 74 dsh.client plugin packages ... packages/uitstalie/ui-tool-dsh-store`——我们的 client 包在 watcher 清单里（HMR 生效）；tsdown 也重建了 `[@deepseek-ai/dsh-client-ui-tool-dsh-store]`；
2. **HTTP**：`GET http://127.0.0.1:3081/?token=…` → **200**，35,711 字节，含 `__DSH_BOOT__`；
3. **组合与投递**：
   - `pnpm dsh --profile web --dump-config` 中出现 `ui-tool-dsh-store → @deepseek-ai/dsh-client-ui-tool-dsh-store`（profile 级）与 preset 内的 `tool-dsh-store → @deepseek-ai/dsh-tool-dsh-store`（与 `agent-instructions` / `agent-instructions-plus` 相邻）；
   - SPA 的 boot 载荷里列出 `@deepseek-ai/dsh-client-ui-tool-dsh-store/client.js`——浏览器确实会加载本插件。

尚需人工确认的只有**视觉**一环（工作区行右侧的按钮与面板内容），由用户在浏览器里点开该 URL 完成。

### 下一步（按优先级）

1. **人工视觉确认**：打开 `http://127.0.0.1:3081/?token=…`，确认每个工作区行的"新建会话"按钮右侧出现 rules 按钮、点开能列出并读出该工作区 `.dsh/rules` 的内容；必要时在会话里确认模型工具表出现 `tool-dsh-store`。
2. 修 `ui-models-dev` 的既有 CSS 违规（0.5px 中性边框 + `corner-shape`），让 `test:gui` 全绿。
3. task17（把 models-dev / ui-models-dev 从本机 profile patch 迁到仓库组合层）与 task15 检查层。

## 修改范围

- 新增分支自有文件：
  - 新包 `packages/uitstalie/tool-dsh-store/`（包名 `@deepseek-ai/dsh-tool-dsh-store`，工具名同为 `tool-dsh-store`）：`package.json`、`tsconfig.json`、`src/*`、`tests/*`、`README.md` + `README.zh.md` + `README.i18n.yaml`。
  - 客户端 UI 包 `packages/uitstalie/ui-tool-dsh-store/`（包名 `@deepseek-ai/dsh-client-ui-tool-dsh-store`）：工作区侧边栏"新建会话"按钮**右侧**的 rules 按钮，以及该工作区 rules 的查看视图。
  - 本任务单与设计文档 [dsh-dir-plugin.md](../dsh-dir-plugin.md)。
- 原生文件（全部为新增行 / 最小块，逐处 `uitstalie-` 标记登记；具体清单在 UI 调查结论回来后定稿）：
  - **`FileSystem` 两个原语**（已实现并验证）：`packages/fs/fs/src/index.ts`（声明 `mkdir` / `remove`，默认实现抛 `FS_IO_ERROR` 并指名后端——沿用同文件 `watch()` 的"不支持即报错"先例）、`packages/fs/fs/src/types.ts`（新增 `FsRemoveOptions`）、`packages/fs/fs-local/src/index.ts` + `src/fsio.ts`（实现：建目录递归、删除由 `recursive` 控制，非空目录未给 `recursive` 时拒绝）、`packages/fs/fs-sandbox/src/index.ts`（两个方法都过现成的 `checkedTarget` 围栏）；测试新增 `fs-local/tests/filesystem.spec.ts` 与 `fs-sandbox/tests/fs-sandbox.spec.ts` 各一组用例；`fs` / `fs-local` / `fs-sandbox` 三份 README + `.zh.md` + `README.i18n.yaml` 记录同步。**不含 `fs-ssh`**（远端协议改动，见设计文档「已知限制」）。
  - **待生成**：`packages/extensions/tool-cordis/src/api-catalog.ts`（`pnpm run gen-cordis-api`）当前被 task8 遗留缺口阻塞——`models-dev/updated` 事件引用了未分类类型 `CatalogOrigin` 与 `ModelsDevCatalog`；已登记到 [task17](task17.md) 待办。
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
