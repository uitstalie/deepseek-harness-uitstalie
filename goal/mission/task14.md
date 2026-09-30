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

1. 根目录固定为 `<projectRoot>/.dsh`，project root 的判定与 `dsh-skill-filesystem` 一致（cwd 向上找 `.git` 标记，找不到退化为 cwd）；根名可配置但默认 `.dsh`。
2. 模型给出的路径**相对 `.dsh/`**；插件负责拼接、规范化并拒绝一切越界形态（绝对路径、盘符、UNC、`..`、`~`、软链逃逸）。
3. 工具面只暴露**一个**工具 `dsh`（已定），动作 `create` / `query` / `delete`，作用对象是文件或文件夹。它的本质是 `.dsh/` 的**统一管理面与规范提醒**：目录下的内容参与 context 与运行时（rules、skills、MCP 声明、runtime 快照），所以 agent 应经它创建/查询/删除，而不是拿 `write`/`edit`/`bash` 直接改。因此 `create` 在落盘前按命名空间校验内容，宁可拒绝也不写入坏数据。
4. 生产写操作前先做策略门禁（`read-only` 一律拒绝；`workspace-write` 仅允许 `.dsh/` 根内），拒绝时复用 `@deepseek-ai/dsh-sandbox` 的 denial marker，使模型看到与 fs/bash 一致的 `[sandbox: …]` 措辞。
5. 建空目录与删除这两个 `ctx.fs` 未提供的原语，集中在插件内单一模块（`src/store-ops.ts`）实现；将来若把能力补进 `FileSystem` 服务定义，只需替换该模块。

## 修改范围

- 新增分支自有文件：新包 `packages/uitstalie/dsh-dir/`（`package.json`、`tsconfig.json`、`src/*`、`tests/*`、`README.md` + `README.zh.md` + `README.i18n.yaml`）、本任务单、设计文档 [dsh-dir-plugin.md](../dsh-dir-plugin.md)。
- 原生文件（全部为新增行，逐处 `uitstalie-` 标记登记）：
  - `tsconfig.host.json`：把新包注册进 Host 聚合程序（做法同 task6）。
  - `tsconfig.base.json`：别名。根与 `/invariant` 别名落在生成区，rebase 后重跑 `pnpm run gen-tsconfig-paths` 重建；手写区仅在生成器无法推断时才添加。
- 不改 `FileSystem` 服务定义、不改 `agent-instructions`（能力缺口由新包内原语 + 自行门禁补齐）。
- 挂载走**用户层 profile 补丁**（`~/.dsh/profiles/web/cordis.patch.yml` 插一行），不进原生 bundle；本机验证用，不入仓库。

## 验证

- 单测：路径拒绝矩阵（`..`、绝对路径、盘符、UNC、`~`、软链逃逸）、三个 action 的正常路径、`read-only` 下拒绝、删除非空目录必须显式递归开关。
- 命名空间校验：`rules/**` 的 front-matter 与 YAML 可解析性、`mcp.json`（复用 `@deepseek-ai/dsh-mcp-client` 的 `Config` 校验）、`skills/**/SKILL.md` 的必填项与 `name` 语法；非法内容必须被拒绝且不落盘。
- 真实 Loader 组合测试（[packages/AGENTS.md](../../packages/AGENTS.md) 要求 product-visible 插件必须有非单测的真实组合测试）：在测试 profile 里挂载插件，断言工具注册与一次端到端调用。
- `pnpm run typecheck`、`pnpm run build`、聚焦 `vitest run packages/uitstalie`。
- 手工验证：Web 会话里工具出现在模型工具表，能对 `.dsh/rules` 建、查、删。

## 待办与风险

- 待用户拍板的选项见设计文档「未决问题」（工具面粒度、命名、是否本阶段就开放删除、是否需要 UI）。
- 风险：插件内的策略检查是**可信代码对模型可控路径的检查**（与 `fs-sandbox` 自身声明的威胁模型一致：containment，不是内核边界）；宿主机进程不受 Windows ACL 沙盒限制，所以策略判断是唯一门禁——因此根严格限定在 `.dsh/`，不做任意工作区路径的删除。
- 风险：`.dsh/` 若本身是软链，需按 realpath 判定归属并在 README 记录。
