# task16 — dsh-agent-instructions-plus（原生 loader + rules）

## requirement

用户已定：**不改原生 `dsh-agent-instructions`，而是禁用它，另做一个 `dsh-agent-instructions-plus`**。这个 plus 插件本质就是"原生的 workspace instruction loader **+** rules"：把原生的全部语义照搬过来，再在**同一条链**上追加 `.dsh/rules/**`。原生插件代码保持原样、随时可以退回。

变更自 [task15](task15.md)：task15 原计划给原生加 `instructionDirs` 配置项，该路线已作废，演变为本任务单的"fork 出 plus 插件"。rules 的语义与规格仍以 [rules.md](../rules.md) 为准。

## 必须与原生逐条对齐的语义（plus 的"原生部分"）

对齐清单来自原生的实际实现，缺一条就不算可退回：

1. `$DSH_HOME/AGENTS.md`（用户级，名字固定）+ 项目根 → cwd 每一层；每层按 `AGENTS.md`、`CLAUDE.md`，再 `AGENTS.local.md`、`CLAUDE.local.md`（[config.ts:12](../../packages/context/agent-instructions/src/config.ts:12)）。
2. 项目根 = 向上找 `.git` 标记，找不到退化为 cwd（[files.ts:181](../../packages/context/agent-instructions/src/files.ts:181)）。
3. 同目录内按 trim 后内容去重（[files.ts:375](../../packages/context/agent-instructions/src/files.ts:375)）；单文件上限 `maxSourceBytes`（默认 1 MiB）。
4. 渲染：一块 `<system-reminder>`，`Instructions from: <相对路径>` 分节，宽→具体排序，正文里的 `</system-reminder>` 转义（[render.ts:10](../../packages/context/agent-instructions/src/render.ts:10)）。
5. 预算：`maxBytes`（base 与三个 preset 都是 65536 B）；先丢更宽的整文件、再截断最具体的文件，并输出 `Workspace instruction budget …` 通知。
6. 注入：首个可用 `agent/pre-step` 变成一条**带来源的 durable `user/message`**（source kind `agent-instructions`）；baseline 带身份，resume 时对账。
7. 跟进：成功的 `read`/`write`/`edit` 触达更深目录 → `Additional instructions from:`；文件变更 → `Updated instructions from:`；消失或变成同目录重复 → `Instructions removed:`。

## rules 的增量

- 目录：`<projectRoot>/.dsh/rules/**/*.md`（纯 Markdown，逐字注入，无激活元数据）。
- 激活：**全量常驻**，与 AGENTS 链在**同一条消息**里；位置排在 AGENTS 链之后（最具体者最后）。
- 去重：在**整个 rules 集合内**按 trim 后内容去重（不是按目录）。
- 预算：独立一份 `maxBytes`（与 AGENTS 链的那份互不挤占，建议 16 KiB），沿用同样的"先丢宽文件、再截断最具体、输出通知"策略。
- 变更：沿用 `Updated instructions from: .dsh/rules/x.md` / `Instructions removed: …`。

## 实现路线（已定）

**A. 复用原生代码**（已定）：原生包 `exports` 内有 `"./src/*"`，plus 直接从 `@deepseek-ai/dsh-agent-instructions/src/*` 取发现、渲染与状态机实现，自己只新写"rules 发现 + 组合编排"。**不整包复制**——复制会撞 `pnpm run duplication`（jscpd 跨文件克隆检测），且两份实现会静默漂移；复用下上游重构会在编译期报错，响亮可修。

**B. 小改预设（B1，已定）**：在三个 preset（`packages/bundle/web-app/presets/{standard,ptc,cordis}.patch.yml`）里把原生的 `agent-instructions` 行设为 `disabled: true`，紧跟插入 plus 行；每处为最小块 + `uitstalie-` 标记，退回时删标记块即可。不走"profile patch 覆盖整张 `config.plugins`"的 B2。

用户补充的判断（同样适用于本任务单）：**这类"组合层小改 + 原生代码不动"本来就是应有做法**——[task17](task17.md) 据此把 models-dev / ui-models-dev 的挂载从"只存在于本机 profile patch"迁到仓库内的组合层。

## 进度

### 已完成（第一步：复用面 + 骨架 + 规则层）

- **原生改动（一处，纯可见性）**：`packages/context/agent-instructions/src/index.ts` 追加导出块——`agentInstructionsMessage`、`reconcileInstructionContext`、`baselineInstructionState`、`applyInstructionVersionUpdates`、`retainedInstructionVersionUpdates`、`instructionContentSha1`、`trimmedInstructionDigest`、`resolveConfig`、`workspaceBaselineIdentity` 及配套类型，全部带 `uitstalie-k3` 标记。**为什么必须改**：原生包 `files` 只发布 `lib/`，从 `./src/*` 引用会把 source plane 与 artifact plane 混用（仓库明令禁止）；导出后 plus 用公开 API 复用，且**零行为变化**。
- **新包骨架**：`packages/uitstalie/agent-instructions-plus/`
  - `src/config.ts`：**嵌套复用**原生 `Config` schema（`agentInstructions` 段原样转发），外加 `rules` 段（`enabled` / `maxBytes` 默认 16 KiB / `maxSourceBytes` 默认 256 KiB）。
  - `src/rules.ts`：`<projectRoot>/.dsh/rules/**` 扫描——递归、路径排序、按 trim 后内容在**整个集合内**去重、单文件超限跳过、集合 digest 用于变更检测；缺失目录即空扫描。
  - `src/index.ts`：当前只导出上述层（插件接线是下一步），否则 tsdown 找不到入口。
  - `tests/rules.spec.ts`：7 个用例（缺失目录、递归收集与忽略非 Markdown、跨文件去重、per-file cap 与空文件、digest 随增删改变化、首次扫描视为变更、abort）。
- **登记**：`tsconfig.host.json` 聚合 references（标记行）；`tsconfig.base.json` 别名由 `pnpm run gen-tsconfig-paths` 自动推断（路径与包名后缀吻合）；`pnpm install` 更新 lockfile。
- **验证**：`tsc -b tsconfig.host.json` 干净、`oxlint`（新包 + 原生包）0 错、规则测试 7 通过、`pnpm run build` 349 个 client artifact。

### 下一步

1. `src/index.ts` 的插件接线：AGENTS 段复用原生 `loadBaselineInstructions` 渲染（**逐字一致**＝可退回的硬证据），规则段独立预算渲染，两段拼进**同一条** `agent-instructions` 消息（`agentInstructionsMessage` + `baseline: true` + `baselineIdentity`）；增量继续用原生 `reconcileInstructionContext`；规则集合变更触发整条重发。
2. 真实组合测试（对齐原生输出 + 规则进上下文）。
3. 三个 preset 的替换（禁用原生 + 插入 plus）与 profile 挂载。

## 修改范围

- 新增分支自有文件：新包 `packages/uitstalie/agent-instructions-plus/`（`package.json`、`tsconfig.json`、`src/*`、`tests/*`、双语 README + i18n 记录）、本任务单。
- 原生文件：仅在选了 B1 时改三个 preset 行（各一处最小块 + `uitstalie-` 标记）；`packages/context/agent-instructions/**` **零改动**。
- 登记：`tsconfig.host.json` 聚合 references（做法同 task6）。
- 挂载：用户层 profile patch。

## 验证

- **可退回的硬证据**：同一份 AGENTS.md 场景下，plus 注入的消息与原生注入的消息**逐字一致**（除 rules 段）——用一个对齐测试把两者并排跑。
- rules：全量注入、集合内去重（重复内容只留一份）、预算截断与通知、变更/移除通知、子目录触达发现。
- 组合：禁用原生 + 只挂 plus，Web 会话里 AGENTS.md 链与 `.dsh/rules/**` 都进上下文；模型看到的是**一条**消息。
- `pnpm run typecheck`、`pnpm run build`、聚焦 `vitest run packages/uitstalie`、`pnpm run duplication`（走了复制路线时必须过）。

## 待办与风险

- 待用户拍板 A（复用 vs 复制）与 B（B1 改 preset vs B2 覆盖 profile）。
- 风险：复用途径依赖原生包的 `./src/*` 导出，属"跨包引用内部模块"；若上游把它改成私有子路径，需要退回复制或自己持有实现。
- 风险：禁用原生后，任何依赖原生 source kind `agent-instructions` 的消费者（快照、SDK 投影、`session-format-v3-to-v4/src/sources.ts` 的来源表）必须继续成立——plus 应**沿用同一个 source kind**，否则会动到会话格式面。
