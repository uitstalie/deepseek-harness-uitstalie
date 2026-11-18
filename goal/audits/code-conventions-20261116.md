# 自研插件与原生插入代码规范审计（2026-11-16）

## 0. 口径与结论

本轮只审规范，不审功能正确性或架构取舍，不修改代码、测试、快照或既有文档。仅本报告及证据附件是新增文件；未 commit、push、重启服务。排除 `vendor/`、`.agents/notes/archived/`、`.dsh/` 本地状态，以及未改动的上游代码。

**结论：本轮不能判“整体符合”。** 已确认的高优先级问题为：函数插件入口多导出值、工具预期失败缺乏 `HarnessError`、共享状态缺 Cordis owner、原生插入无分支标记、未知事件默认跳过与根规范冲突、新增 `as unknown`。lint 的 563 条并不全部是同一严重度：其中 28 条在生产代码、535 条在测试代码；报告不将测试 mock 的简洁性诊断伪装成架构缺陷。

严重度按规范问题影响排序：**P0 = 当前门禁直接阻断或跨实例生命周期/工具错误契约缺失；P1 = 明确书面规则违规，影响公开接口、事件语义、可维护契约；P2 = 文档、措辞、机械及局部一致性问题。** 同一处多规则只在一个主条目中计数，维度表另给诊断数。

## 1. 覆盖声明与上游事实

### 1.1 基线与范围判定

- 工作区分支 `cli-desktop`，HEAD 为审计执行当日（2026-11-16）的分支顶端。按仓库引用规则本文件不保存提交标识；需要复核时以该日运行 `git rev-parse HEAD` 的输出为准。
- `upstream = git@github.com:deepseek-ai/deepseek-harness.git`；`upstream/master` 为审计当日上游 `master` 顶端，merge-base 由当日运行 `git merge-base upstream/master HEAD` 计算得到。同样不保存提交标识，按当日命令输出复核。
- `git log upstream/master..HEAD --oneline` 返回本分支提交；`git diff upstream/master...HEAD --stat` 为 **1258 文件、140206 行新增、5174 行删除**。运行了 `pnpm run change-scope --base upstream/master --head HEAD` 交叉核对路径；未把 `goal/native-change-inventory.md` 的旧数量当当前事实。
- `git diff upstream/master...HEAD --name-only --diff-filter=A -- 'packages/*/*/package.json'` 返回 **24 个新增包**。`packages/uitstalie/**`、`packages/jira/**`、`packages/superagent/**`、`packages/interaction/tool-policy/**` 在 merge-base 没有对应包，因此归为“我们自研”。其中自研 TS/TSX 446 个文件；测试文件 147 个。
- 其余上游已有包只审 `git diff upstream/master...HEAD` 的新增、修改、删除行，归为“插入原生 DSH 的改动”；不改动的上下文仅用于理解。原生路径含 `apps/`、`scripts/`、组合配置、原生包源码/测试/README/清单及生成物。按启发式（新增非空源码/配置行、排除新自研包、排除生成文档等见下）有 **146/223 个文件**带新增行但无 `uitstalie-` 标记；该数包含新生成物及原生侧新增文件，不能直接当违规数。
- `goal/` 是设计/过程记录，不作为代码审计对象；`goal/AGENTS.md` 的全仓声明是本轮分支规则依据。生成 catalog、slot catalog、锁文件、i18n 配对哈希等只检查同步与机械项，语义问题追溯到 owning source，不把生成文本另报一条。
- `packages/jira/*/src/*.test.ts`、`packages/superagent/superagent-core/src/*.test.ts` 也属自研代码；不是因放在 `src/` 就排除。

### 1.2 逐维度结果

“符合”只指已审范围内未发现该维度违规，不等于功能正确。数量按本报告主条目；括号给机械诊断数。

| 维度 | 结论 | 数量与覆盖 |
|---|---|---|
| 类型安全 | 有违规 | 31 处新增 `as unknown`；7 个 coded error 裸继承 `Error`；lint 另有 16 项测试 any/unsafe。未跑全量 typecheck。 |
| 错误处理 | 有违规 | 工具参数/上下文/角色预期失败直接抛普通 `Error`，共定位 13 个执行点（含同类分支）；7 个 coded error 类；4 个静默降级/吞错簇。Jira 返回式 `Result` 未一概误判。 |
| 注释与文档（JSDoc/双语/措辞） | 有违规 | 导出 JSDoc 105 条；英文标题大小写 1 处；JSDoc 与实现不一致 4 簇；skill 多行段落 12 段；历史/移植/审查叙述多簇；控制字符/替换字符 2 处。双语配对 gate 通过。 |
| 注册与生命周期 | 有违规 | 模块级共享 cache/queue/journal 4 处 owner 缺失；原生 Set 注册漏 effect 1 处；models-dev/OAuth 在途卸载 1 簇；客户端手动 disposer、异步卸载、轮询/stream 5 簇。未见 `ctx.on/effect` 注册普遍漏反向清理，不作全生命周期安全保证。 |
| 事件与声明合并 | 有违规 | 未知事件默认跳过 1 个语义簇；新增 tool-pair 事件 declaration merging 和模型输入日志属合规正面项。 |
| 命名、包结构、导入 | 有违规 | Loader 入口 418 项；非标准 export key 13 处；69 个测试文件位于 `src/`；`src/types.ts` 运行时值 2 文件；发布 files 17 包；原生重复依赖键 9 个。依赖声明/client module gate 通过。 |
| 测试与快照 | 有违规 | 聚焦 lint 563 项；测试位置 69 个文件；缺少非琐碎模型/用户可见变化的 assembled 记录快照（当前快照目录仅 1 个 pwsh 描述同步文件）。未跑全量测试/快照。 |
| 配置与硬编码 | 有违规 | 部署可变的 OAuth timeout/retry、UI 轮询、memory 重试等常量未进入 Config，6 个代表簇。协议常量未硬判。 |
| UI 文案 / i18n | 有违规 | 英文 `meta.title` 1 处；helper 硬编码 UI 错误 1 处；中文术语/语义 4 处。字典归属 gate 通过，但不覆盖 locale metadata/helper 数据流，见证据。 |
| 机械项 | 有违规 | `jira-board.md` 无末尾换行；`workspace/src/types.ts` 有 BEL 控制字符；原生插入标记缺失为跨维度问题。`git diff --check upstream/master...HEAD` 通过。 |

## 2. 主违规清单（按严重度）

### P0：门禁失败与共享 owner / 错误契约

#### 2.1 函数插件入口多导出值（418 项）

- **位置/原文代表：**
  - `packages/uitstalie/memory/src/index.ts:59-217`：`export { appendMemoryEntry, …, resolveMemoryEntries, …, memoryTools, … }`，以及 `MemorySummaryRunner` 等大量运行时值。
  - `packages/jira/jira-agent/src/index.ts:253-441`：`export { applySessionPermission, … }`、`export * from './superagent.ts'` 等。
  - `packages/uitstalie/home-backup/src/index.ts:25-34`：`DEFAULT_INTERVAL_MS`、`DEFAULT_RETAIN` 等；`packages/uitstalie/llm-plus/src/index.ts:48`：`export { PlusAdapter }`。
  - 原生插入同类：`packages/context/agent-instructions/src/index.ts:49-65`、`packages/core/agent/src/index.ts:23`、`packages/core/tools/src/index.ts:419`、`packages/interaction/tool-policy/src/index.ts:48-53`、`packages/sandbox/sandbox-policy/src/index.ts:40`、`packages/session/session-persistence-jsonl/src/index.ts:180`。
- **条款：**`docs/defensive-patterns/package-surface.md#a-plugin-package-exports-what-the-loader-loads`：函数插件入口仅 `name/inject/Config/apply`；service 插件默认导出 service class；只允许另加 Service Definition 与 error types。`packages/AGENTS.md:5` 同规。
- **gate：会。** 实际 `pnpm run verify-plugin-entry-exports` 失败 **418 项**。完整入口与名字见附件 `code-conventions-20261116-export-evidence.md`。
- **修复方向：**值移到内部模块；同包测试直接导入内部路径，跨包行为通过 service/slot 等已声明接口；不要把 allowlist 当默认修复。原生插入同样处理。
- **严重度：P0**，当前明确红色 gate。

#### 2.2 工具预期失败直接抛普通 `Error`

- **位置/原文：**
  - `packages/uitstalie/memory/src/tools.ts:483-485`：`if (query.length === 0) throw new Error('memory_search: query must not be empty')`；同文件 `:619`：`throw new Error(\`${tool} requires an owning agent session\`)`。
  - `packages/uitstalie/memory/src/cleanup.ts:248-251`：`memory_resolve needs turn, tag, or all: true` / 空 tag。
  - `packages/uitstalie/tool-dsh-store/src/tool.ts:110,135-136,160`：缺 session、create 参数约束、memory namespace 拒绝。
  - `packages/uitstalie/persona-card/src/state.ts:315-351`：缺 agent、未选 card、schema 缺失、patch values 非对象、缺 version、default 未知 action。
  - `packages/uitstalie/token-calculator/src/tool.ts:62-64`：超过输入字节上限。
  - `packages/uitstalie/personality/src/agent-tools.ts:169,187`：subagent 不可用、缺 agent；`writing-tool.ts:111,214` 同类。
  - `packages/interaction/tool-policy/src/guard.ts:20` 只返回字符串 denial；`index.ts:211-215` 返回 policy reason，没有 `info.name/code`。
- **条款：**`AGENTS.md#conventions` L151；`.agents/skills/dsh-error-handling/SKILL.md#tool-failures` L20-27：预期工具失败抛 `HarnessError`；手检参数 `ToolArgsError`，缺 Agent/service/turn `ToolContextUnavailableError`；guard denial 带 `info.name/code`；cancellation 不得换普通 `Error`。
- **gate：不会因类型自动拦；相关测试多仅检查文本。** 本轮没有全量测试；这是一项人工语义发现。
- **修复方向：**在 owning domain 定义稳定的 UPPER_SNAKE code，参数/上下文分别使用标准错误；测试断言 `error.info.name/code`；guard 返回含 `info` 的结构；保留 cancellation 原 reason。
- **严重度：P0**（模型日志/重试/UI 无法路由结构化错误；非功能判断）。

#### 2.3 带机器 code 的错误类裸继承 `Error`（7 类）

- **位置/原文：**`packages/uitstalie/memory/src/memory-file.ts:164-175`：`MemoryDocumentError extends Error`，`readonly code: MemoryDocumentErrorCode`；`personality/src/analyze.ts:78-86`、`apply.ts:49`、`global-store.ts:97`、`output-style.ts:76`、`writing-rules.ts:94`；`store-atom/src/paths.ts:24-43`（`StorePathRejection`）均同类。
- **条款：**`.agents/skills/dsh-error-handling/SKILL.md#typed-structured-failures` L12-16：携带 machine code 的 error class 必须直接/经包基类继承 `HarnessError`，不能裸 `Error`，code 用稳定 `UPPER_SNAKE_CASE`。
- **gate：不会直接拦。**
- **修复方向：**每包一个 `HarnessError` 基类或统一 domain error；保留原因、name、稳定 code，并将小写/kebab code 的兼容变化写入升级说明（若属已发布面）。
- **严重度：P0**（与上条同根源，修复可合并）。

#### 2.4 模块级共享状态没有 Cordis owner（4 处）

- **位置/原文：**
  - `packages/jira/jira-agent/src/workspace-conventions.ts:35-36`：`const cache = new Map<string, CachedConventions>()`；仅 `:126` 暴露手动 `clearWorkspaceConventionsCache`。
  - 同包 `superagent.ts:1015-1021`：`const reportJournals = new Map<string, DispatchReportStore>()`，注释明确 `not closed by dispose`。
  - 同包 `super-workspace-definition.ts:257-274`：模块级 `queues`，虽 settle 后删除，跨 fiber 的共享 queue owner 仍是模块。
  - `packages/jira/jira-core/src/push.ts:285-299`：模块级 `queues` / `sharedPushQueue`，与 `jira-service` 声称的 service-owned queue 相分离；仅 `:306` 手动 forget。
- **条款：**`packages/AGENTS.md` L13、`docs/defensive-patterns/general.md#shared-state-has-one-owner` L104-122：共享状态必须挂在 service/instance；模块级 cache/singleton/global WeakMap 无 owner。`.agents/skills/cordis-styling-nitpicking/SKILL.md#p0-singleton-pattern` 同规。
- **gate：不会因模式直接拦；本次源码追踪证实。**
- **修复方向：**移到 `JiraService` 或对应 capability/service 实例，声明 inject；cache/queue 生命周期由该实例 disposal 管理。不可仅靠“process-local”注释豁免。
- **严重度：P0**（该专项 skill 命名为 P0）。此结论只针对 owner 规则，不宣称已证明额外运行故障。

#### 2.5 原生未知事件默认跳过，违反 required-on-read

- **位置/原文：**`packages/core/session/src/types.ts:520-532`：`Unknown events are skipped by default` 并新增 `critical?: true`；`packages/core/session/src/surface.ts:305-307` 从仅未知 `ignorable` 跳过改为所有未知类型跳过。
- **条款：**`AGENTS.md#conventions` L135：`SessionEventMap` members are required-on-read unless envelope carries `ignorable: true`；同版本变化需要 safe readers。`goal/AGENTS.md` L7-9 也禁止无标记重写原生行。
- **gate：不会由现有类型/合并 gate 直接拦；需要规范/持久化审查。** 本报告不评价该迁移是否有业务价值，只指出与当前书面规则不一致。
- **修复方向：**恢复 required-on-read，或先正式修改书面规范并同步所有 reader/持久化确认；原生修改采用可追踪最小块。新增 `critical` 不能在规则未改时绕过 `ignorable`。
- **严重度：P0/P1 交界，按 P1 主清单展示（当前规范直接冲突）。**

### P1：公开接口、类型与分支规则

#### 2.6 新增 `as unknown`（31 处）

- **位置/原文代表：**`packages/llm/llm-pi-ai/src/config.ts:288`：`]) as unknown as z<ChatTemplateKwargValue>`；`packages/jira/jira-agent/src/superagent.ts:1522,1623`：`scanned.items as unknown as Candidate[]`；`packages/jira/ui-jira/src/client/index.ts:151,157,174,186`：Cordis/Remote 双重断言；测试另有 `memory/tests/summary.spec.ts:753`、`workflow/tool-workflow/tests/tool-workflow.spec.ts:729` 等。
- **条款：**`AGENTS.md#conventions` L148：禁止新增 `as unknown` / `<unknown>`，用 typed values 或 validation。
- **gate：会。** `pnpm run verify-no-unknown-casts` 失败并逐一列出 **31** 处，见附件。
- **修复方向：**在 wire/config/durable JSON 边界做类型校验；Cordis 用已声明 service 类型/typed get，Remote 用生成类型；测试给最小接口而非 `as unknown as`。
- **严重度：P1**（红色 gate 与上述 P0 gate 合计时不重复计条目）。

#### 2.7 原生插入未遵守分支标记与最小插入规则

- **位置/原文代表：**`packages/api/session-controller/src/agent.ts:460-474` 新 `workspaceRoleFor` 与 role 传播；`packages/core/agent-loop/src/agent.ts:44,742-749` 新 pairing import/append；`packages/workspace/workspace/src/entity.ts:14,94-116`、`spec.ts:25-35`、`types.ts:83-85,113-115`；`packages/core/system-prompt/src/index.ts:139,142-143`；`packages/llm/llm/src/content.ts:383-410`。
- **条款：**`goal/AGENTS.md` L5-9：默认走新增路径；原生修改必须 `uitstalie-${model}` 标记、日期、mission id、原因，原行尽量保留，禁止顺手重排/优化；L10-11 要 `DH-*` 和逐处登记。`packages/core/agent-loop/README.md` 无对应 pairing repair 文档也违反根 L181/包 L27。
- **gate：无统一现有 gate 验证 marker/Jira；人工 diff 可复现。** 146 个文件无标记只是启发式候选，需扣除新生成物/新文件；这里以具体原生插入为证，不把 146 全判违规。
- **修复方向：**优先分支扩展点；确需原生修改则最小连续块、合法标记、逐处 Jira；JSON 在 issue 登记；恢复被重排原行。
- **严重度：P1**。历史冻结 `taskNN` 不按新规则一概倒判，但新插入应使用 `DH-*`。

#### 2.8 非标准 package export key（13 处）

- **位置/原文：**`packages/superagent/superagent-core/package.json:21`：`"./dispatch"`；`packages/uitstalie/models-dev/package.json:15`：`"./deepseek-extra-params"`；`packages/uitstalie/agent-instructions-plus/package.json:17`、`common-view/package.json`、`llm-plus/package.json`、`models-dev/package.json`、`tool-dsh-store/package.json`、`ui-models-dev/package.json`、`ui-tool-dsh-store/package.json`：`"./icon"`；`packages/jira/{jira-agent,jira-cli,jira-core,jira-service}/package.json` 与 `packages/uitstalie/persona-card/package.json`：`"./*": "./src/*"`。
- **条款：**`docs/defensive-patterns/package-surface.md#packagejson-exports-uses-the-standard-key-set` L75-114：新 key 必须先改 owning document 和 check；`./dispatch`、`./deepseek-extra-params`、`./icon`、通配 `./*` 不在标准集合。
- **gate：该专门规则没有被通过的 client/package gate 完整覆盖。**
- **修复方向：**使用标准 `./src/*`/`./types`/service 接口，或先获 owner 确认并更新文档与扫描；不能拿现有未审 one-off key 当先例。
- **严重度：P1**。

#### 2.9 测试放在 `src/`（69 文件）

- **位置/原文：**`packages/jira/jira-agent/src/compaction-seam.test.ts:1`、`packages/jira/jira-core/src/store.test.ts:1`、`packages/jira/jira-cli/src/main.test.ts:1`、`packages/superagent/superagent-core/src/index.test.ts:1` 等；统计为 jira-agent 17、jira-cli 2、jira-core 48、superagent-core 2。
- **条款：**`packages/AGENTS.md` L26：tests live at package level under `tests/`, not `src/__tests__/`；L25 `src/types.ts` 只类型；`docs/testing.md` L9 package tests under `tests/**`。
- **gate：lint 会把它们当生产 `src` 规则，coverage 也覆盖；没有专门的布局 gate 拦下。**
- **修复方向：**迁到包级 `tests/`，更新 tsconfig/运行器；不要为了消 lint 把生产规则全局关闭。`src/types.ts` 的运行时值另见 6.9。
- **严重度：P1**。

#### 2.10 聚焦 lint：563 项（生产 28、测试 535）

- **位置/原文代表：**`packages/jira/jira-agent/src/superagent.ts:3191,3196,3202,3210,3219,3232,3237,3251`：`return failStart(...)` 在外层 `try/catch` 内未 await；`packages/superagent/superagent-core/src/index.ts:188,212` 为持久化 JSON 对象检查；`packages/jira/jira-agent/src/role.test.ts:10` 为 floating promise；`packages/jira/jira-core/src/store-create.test.ts:102-107` 为 JSON.parse any。
- **条款：**`.oxlintrc.json` 已启用规则的失败是 gate 违规；`AGENTS.md` L177/L179 对 any/narrowing；`AGENTS.md` L147 对 durable/model JSON 校验；`docs/defensive-patterns/general.md#optional-inputs-state-both-behaviors` 仅适用于未决定的 optional hop，不是所有 `?.` 的普遍禁令。
- **gate：会，实际命令退出 1。** 规则分布：`no-unnecessary-condition` 347、`require-await` 168、`return-await` 8、`no-unsafe-member-access` 8、`no-unnecessary-type-conversion` 5、`unbound-method` 5、`no-unnecessary-type-assertion` 4、`no-unsafe-assignment` 3、`no-unsafe-return` 3、`no-deprecated` 3、`restrict-plus-operands` 3；其余 7 项各 1。完整坐标附件。
- **修复方向：**8 个 return-await 保留本地失败处理；16 个测试 any/unsafe 修类型；durable/tool JSON 检查不机械删除；Node/browser timer 分别处理；496 个 `src/*.test.ts` 的 NUC/require-await 先按布局迁移或明确窄 lint 策略，不能加无意义 await。
- **严重度：P0（gate）/P2（多数测试简洁性），不单拔高。**

### P2：文档、配置、UI 与机械项

#### 2.11 导出 JSDoc 不完整（105 条）

- **位置/原文：**`packages/core/tools/src/role.ts:22`：`roleAllows(role, minimum)` 只有一句 description；`:27` `withMinRole`、`:35` `toolMinRole` 缺 `@param/@returns`；`packages/api/session-controller/src/agent.ts:265` `composeAgent` 新 `role` 未写 `@param`；`packages/workspace/workspace/src/index.ts:254` `create` 新 `role` 未写 `@param`；`packages/uitstalie/personality/src/defaults.ts:70` 等大量函数缺参数/返回文档。
- **条款：**`AGENTS.md#type-safety-and-documentation` L177：每个 export 简洁 JSDoc，function-like exports `@param/@returns`，由 `verify-export-jsdoc` 执行。
- **gate：会。** 实际 **105** 条失败，完整条目附件。
- **修复方向：**补真实参数、返回、失败/副作用/ownership 合约，不能只加无信息 `@param foo - foo` 消 gate。
- **严重度：P2**（红色 gate 的阻断属性已在前述总 gate 说明）。

#### 2.12 文档与行为不一致、无信息措辞

- **位置/原文：**`packages/interaction/permission-presets/src/types.ts:35`：`current durable selection only`，实际 `PermissionSelection` 含 `currentValue/sandboxMode/approvalPolicy`；`packages/interaction/permission-presets/src/index.ts:9-10`：`current-value-only permissions Session projection`；`packages/workspace/workspace/src/types.ts:83`：`unknown values are ` + BEL + `gent.`（含 BEL）；`packages/core/agent-loop/README.md` 未写新增 request-local pairing repair/log。
- **条款：**`AGENTS.md` L177/L179/L181、`packages/AGENTS.md` L27、`docs/AGENTS.md` L46-47；`docs/defensive-patterns/README.md` 要求 review-enforced rule 与当前 artifact 一致。
- **gate：导出 JSDoc gate 不会检查语义；文档配对 hash 也不证明内容正确。**
- **修复方向：**按 owning code 改 JSDoc/README，并同步中文；去控制字符。
- **严重度：P2**。

#### 2.13 英文 metadata 未用 sentence case（1 处）

- **位置/原文：**`packages/uitstalie/home-backup/locale/en.json:3`：`"title": "Home Backup"`。`Models.dev catalog page`、`LLM Plus providers`、`Common view overlay` 符合规则，未误判。
- **条款：**`.agents/skills/dsh-prose-standard/SKILL.md#required-coverage-by-prose-location` L58：English `meta.title/description` sentence case；`AGENTS.md` L159。
- **gate：`verify-client-ui-i18n` 不扫描 locale JSON，无法拦此大小写；`verify-locale-metadata` 只查完整性/占位符等。** 我另用只读脚本把每个英文 locale 文件交给 `findUiI18nViolations` 得到 0，证明源码 gate 对 metadata 无覆盖。
- **修复方向：**`Home backup`；不要改 `LLM Plus` 这类产品名。
- **严重度：P2**。

#### 2.14 缺 locale 文件（2 包）

- **位置/原文：**`packages/interaction/tool-policy/locale/en.json` 不存在；`packages/uitstalie/personality/locale/en.json` 不存在；两包有 `src/index.ts`/Config 插件面。
- **条款：**`AGENTS.md` L159 与 `packages/AGENTS.md` 文档/可见 metadata 要求；实际由 locale metadata gate 定义完整性要求。
- **gate：会。** `pnpm run verify-locale-metadata` 报两个 ENOENT 并退出 1，因此后续 `verify-translation-pairing` 单独运行（通过）。
- **修复方向：**补全 shipped language metadata 或明确无 metadata 的允许形态，不能只留空 JSON 消错。
- **严重度：P2**。

#### 2.15 Jira skill 的硬换行与推理/历史残留

- **位置/原文：**`packages/jira/jira-agent/skills/jira-board.md:3-4,10-11,20-21`；`jira-triage.md:3-4,28-29,33-35`；`jira-work.md:3-6,38-39,49-50,54-55`。`jira-work.md:54-55` 还保留 `(decision 26)`；`jira-core/src/errors.ts:4-6,25,49,145-151` 大量 decision/trial feedback 叙述；`llm-plus/src/oauth/pkce-login.ts:1-5` 的“移植自…保留公共结构”是移植记录而非当前模块职责。
- **条款：**`docs/AGENTS.md` L42 一段一行、L46 保留当前完整合约去 reasoning transcript、L69；`.agents/skills/dsh-prose-standard/SKILL.md` L12、L40、L48-51；`AGENTS.md` L179。
- **gate：**`verify-md-wrap` 虽通过，但 `scripts/verify-md-wrap.ts:18-31` 的 glob 不覆盖 `packages/*/*/skills/*.md`，故不能拦这些 skill 段落。JSDoc gate 也不审 prose 语义。
- **修复方向：**每段一行；保留当前 guardrail，删除设计 session 编号、旧移植/试验叙述，必要 rationale 链接唯一 owner。
- **严重度：P2**。

#### 2.16 配置硬编码（6 个代表簇）

- **位置/原文：**`packages/uitstalie/llm-plus/src/oauth/providers/github-copilot.ts:93`：`AbortSignal.timeout(5000)`；`kimi-coding.ts:17-19`：device timeout、poll interval、refresh retries；`llm-plus/src/oauth/http.ts:8`：`OAUTH_REQUEST_TIMEOUT_MS = 30_000`；`packages/uitstalie/ui-models-dev/src/client/store.ts:167,324`：60s poll/800ms delay；`packages/uitstalie/memory/src/summary.ts:82-85`：2 attempts/100ms；`packages/uitstalie/tool-dsh-store/src/remote.ts:29`：256 KiB rule limit。
- **条款：**`AGENTS.md#conventions` L144：deployment-varying choices 必须是 validated Config，DEFAULT 常量不是 configurability；L143 默认解析要在 owning resolve step，不是 run 内 hidden fallback。协议常量/外部规范/安全不变量可固定，故 RFC 默认 5s、slow_down +5s、tokenizer 上限等未一概判违规。
- **gate：无通用硬编码 gate。**
- **修复方向：**将确需部署调整的 timeout/retry/poll/byte limit 放入 Config 并校验默认值；UI 可由 host Config/declared settings 注入；明确哪些值是协议/安全不变量并记录。
- **严重度：P2**。

#### 2.17 静默降级与空 catch 的契约缺口

- **位置/原文：**`packages/jira/jira-agent/src/superagent.ts:1536-1538`：`catch { // A background pass must never turn a completed turn into a failed one. }`；`:1636-1638` timer pass 同样吞错；`packages/jira/ui-jira/src/client/index.ts:195-197` 空 catch，只注释 test composition fallback；`packages/uitstalie/llm-plus/src/oauth/pkce-login.ts:150-158` 监听失败后 close 为空函数且没有默认启用日志。
- **条款：**`AGENTS.md` L151-152；`.agents/skills/dsh-error-handling/SKILL.md#catch-recover-or-stop` L31-35、`#localized-actionable-visible-reports` L37-43：continuing supervision 要 observable degradation；unknown/untrusted outcome 要可见；空 catch 要命名错误和 why，try 仅一个语句。
- **gate：通常不拦，需要人工判断。** 不把所有 catch-and-return 都判违规；仅这些背景持续失败/状态不明且无报告路径的实例。
- **修复方向：**记录结构化、默认启用且可访问的降级日志，区分可预期 optional absence 与真正 failure；保证后续工作前置条件。空 catch 用 `catch (error) { /* reason */ }` 并限一个 try statement，或改显式 capability detection。
- **严重度：P2**。

#### 2.18 客户端 disposer/异步卸载

- **位置/原文：**`packages/jira/ui-jira/src/client/index.ts:170-200`：手动 `disposeSuperGroup` 在 `refreshSuperGroup()` 前被替换，最终 effect 只同步调用；`:202-205` `return () => { void mounted?.() }` 不等待异步卸载。
- **条款：**`AGENTS.md` L134 注册是 effects；`docs/defensive-patterns/general.md#dispose-must-reach-quiescence-not-just-request-it` L194-198：可观察工作须 await；`.agents/skills/cordis-styling-nitpicking/SKILL.md#p0-unreversed-side-effect`。
- **gate：无通用 gate；已作源码追踪。**
- **修复方向：**把 group registration 放进 owning `ctx.effect`，刷新时 await 上一次 cleanup，卸载返回并等待真实 mounted disposer；取消/代际处理不应让旧刷新覆盖新注册。
- **严重度：P1**。

#### 2.19 机械项

- `packages/jira/jira-agent/skills/jira-board.md` 末尾无换行：原文最后 `second view of it will disagree with the first one.`。违反 `AGENTS.md` L169 exactly one trailing newline。修复为补一个 LF。`git diff --check` 未报此项，说明不能仅依赖 whitespace gate；文本扫描命中。
- `packages/workspace/workspace/src/types.ts:83` 的 BEL 控制字符见 2.12，归文档与机械同一根因；`packages/uitstalie/personality/README.md:38` 还混入字面量 `` `r`n ``，把两行表格粘在一起，属同类机械损坏，需恢复换行。
- 二进制 `packages/uitstalie/token-calculator/assets/deepseek-v4.tokenizer.json.gz` 不适用文本末尾换行规则，未误报。
- `packages/bundle/web-app/package.json:227-236` 重复 9 个依赖键：如 `dsh-client-ui-context-menu`、`dsh-client-ui-file-drag`、`dsh-host-product-telemetry-otel`。违反 `goal/AGENTS.md` L5-9 最小插入/不得重排原生内容；JSON parser 后值覆盖前值，现有依赖 gate 不一定能识别重复。删除重复项并在 Jira 逐处登记。**不把重复键说成额外通用规范。**
- `git diff --check upstream/master...HEAD` 退出 0：无 whitespace errors。

## 3. 无书面依据的偏好与不得硬判项

1. 不因为函数长、模块大就判违规。`goal/AGENTS.md` L17 的“小函数/组合”是分支书面要求，但没有行数阈值；除非具体难以组合的实例，不将个人函数长度审美列为违规。
2. 不把“中文代码注释”一律判违规。`packages/client/AGENTS.md` L120 只明确 Client code comments English；Host 中文注释按完整合约、直接措辞判断。`llm-plus` 中移植/推理叙述另按 prose 规则处理。
3. 不要求每个 `ctx.on()` 再手动保存 disposer，Cordis 已提供反向清理；也不把 registry 已返回 disposer 但未显式 `ctx.effect` 的所有情况判违规。只报告有实际 owner/异步清理证据者。
4. 不要求所有 `async` mock 添加无意义 `await`；168 条是 lint gate 事实，具体修复需保留接口 Promise 语义。
5. 不把所有 `?.`、默认值、`try/catch`、plain `Error` 都判违规。协议常量、外部 specs、安全不变量允许固定；纯内部 programmer error 可 plain Error；CLI 的返回式 `Result` 不等同工具 thrown failure。
6. 不把 `Home Backup` 之外的合法产品名强行小写：`LLM Plus providers`、`Models.dev catalog page` 等按 sentence case/产品名规则处理。
7. 不因存在测试就声称满足测试政策，也不以 Windows 不跑快照为理由判“快照必然失败”。`goal/AGENTS.md` L15 禁止本机快照通道，本轮遵守；缺失 assembled evidence 仍按 `docs/testing.md` 报告。
8. 不把历史 `taskNN` 标记一律判违规；冻结 mission 索引仍有效。新改动应使用当前 `DH-*`。
9. 不把新增源码文件自动视为原生标记豁免，也不把无标记文件计数 146 直接当违规数；需要按新增点逐个判定。
10. 不评判权限模型、角色传播、pairing repair、OAuth 协议选择、UI 架构或功能正确性。

## 4. 已运行命令与证据边界

| 命令 | 实际结果 |
|---|---|
| `git log upstream/master..HEAD --oneline` / `git diff upstream/master...HEAD --stat` | 1258 文件、140206+/5174-；确定分支与上游范围。 |
| `pnpm run change-scope --base upstream/master --head HEAD` | 成功，列出 staged/unstaged/untracked 及分支 diff；未替代人工语义审查。 |
| `pnpm exec oxlint --config .oxlintrc.json --format=github packages/uitstalie packages/jira packages/superagent packages/interaction/tool-policy` | **失败：563 errors / 0 warnings，438 文件，60 文件有诊断。** |
| `pnpm run verify-plugin-entry-exports` | **失败：418 项。** |
| `pnpm run verify-export-jsdoc` | **失败：105 项。** |
| `pnpm run verify-no-unknown-casts` | **失败：31 处。** |
| `pnpm run verify-locale-metadata` | **失败：tool-policy、personality 缺 locale/en.json。** |
| `pnpm run verify-package-readme-summaries` | **失败：personality 107 words、ui-memory 106 words，上限 100。** |
| `pnpm run verify-package-meta` | 通过：locale metadata、SVG artwork、resource exports、publication files。 |
| `pnpm run verify-no-top-level-await` | 通过：3425 source files，3 个 executable 按声明排除。 |
| `pnpm run verify-client-ui-i18n` | 通过：1364 个 Client UI 源文件。不覆盖 locale metadata。 |
| `pnpm run verify-package-dependencies` | 通过：102 packages。 |
| `pnpm run verify-client-packages` | 通过：71 client packages（66 dynamic、5 static）。 |
| `pnpm run verify-translation-pairing` | 通过：1308 pairs。 |
| `pnpm run verify-md-wrap` | 通过：2670 files；不覆盖 `skills/` 深层路径。 |
| `git diff --check upstream/master...HEAD` | 通过，退出 0。 |
| 只读脚本：英文 metadata 交给 `findUiI18nViolations` | 0；证明该 checker 不覆盖 locale JSON，不等于 metadata 全文合规。 |
| 依赖 gate 后续重复 entry-export 子进程 | 已由我取消重复运行；独立 entry-export 命令已得到完整 418 项结果。 |

**未运行：**全量测试、全量构建、全量 typecheck、snapshot/test:snapshot/test:web、真实 API e2e。故没有“全部测试通过”或“其余 gate 全绿”的结论。类型安全维度除机械检查和源码审查外，全量编译结论记为本轮未覆盖。

## 5. 附件

- `goal/audits/code-conventions-20261116-lint-evidence.md`：563 条 lint 的逐文件、逐行列、逐规则清单。
- `goal/audits/code-conventions-20261116-export-evidence.md`：418 项 Loader 入口导出、105 项 JSDoc、31 项 unknown-cast 明细及对应 gate 条款。
- `goal/audits/code-conventions-20261116-native-markers.txt`：146 个无 `uitstalie-` 标记的原生新增行文件候选；仅供复核，不是 146 条违规。

## 6. 补充人工复核发现

以下均由第二轮源码复核补充，不改变前述机械 gate 数量。

### 6.1 原生 Set 注册漏 effect

- **位置/原文：**`packages/sandbox/sandbox-policy/src/index.ts:429-431`：`this.fsRootProviders.add(provider)`，只返回 delete 闭包。
- **条款：**`AGENTS.md` L134；`packages/AGENTS.md` L19：registry contribution 必须通过 fiber dispose 证明移除；相邻 `registerWritableRoot` 已示范 `this.ctx.effect`。
- **gate：现有测试手动调用 disposer，不能覆盖 owner fiber 卸载。**
- **修复方向：**以调用方 `this.ctx.effect()` 注册，dispose 贡献 fiber 而不手动调用返回 disposer，观察 provider 移除。

### 6.2 客户端组件订阅和 props 弱化

- **位置/原文：**`packages/uitstalie/ui-memory/src/client/MemorySection.tsx:61-64`：组件直接 `useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot)`；`packages/uitstalie/ui-dafeiyu/src/client/CapabilitiesSection.tsx:22-38`、`packages/uitstalie/ui-models-dev/src/client/ModelsDevSection.tsx:22-36`、`packages/jira/ui-jira/src/client/JiraSection.tsx:26-47` 注入整只 controller/store，并用 `Partial<InjectFace<...>>` 或本地重写 owner props。
- **条款：**`packages/client/AGENTS.md` L13、L17、L26；`docs/defensive-patterns/client-components.md#components-never-receive-a-cordis-context` L137-142、`#identity-and-initial-state-are-deliberate` L275-281：业务组件不自订阅，hook 由 renderer 经 inject `hooks` 绑定；props 从正式 shares 派生，不给整 service。
- **gate：无。**
- **修复方向：**`controller.store` 放 `hooks.snapshot`，组件用绑定 `useSnapshot`；注入窄动作，使用 `PropsRuntime` / `InjectFace` 正式派生，不用生产 `Partial` 方便测试。
- **严重度：P1。**

### 6.3 客户端异步资源没有等待停止

- **位置/原文：**`packages/uitstalie/ui-models-dev/src/client/index.ts:104-108`：`void disposeModelsDev?.()` / `void disposeLlmPlus?.()`；`store.ts:165-170,323-326` 两个无 handle 的 `setTimeout`，OAuth 循环无停止入口；`packages/uitstalie/ui-tool-dsh-store/src/client/index.ts:55-68`：`void ctx.remote.$mount(...).then(...)`；`packages/jira/ui-jira/src/client/index.ts:105-109`：`void stream.dispose()`；`packages/uitstalie/ui-dafeiyu/src/client/index.ts:83-85` 与 `jira/ui-jira/src/client/index.ts:202-205`：`void mounted?.()`。
- **条款：**`AGENTS.md` L134；`docs/defensive-patterns/general.md#dispose-must-reach-quiescence-not-just-request-it` L194-198；`.agents/skills/cordis-styling-nitpicking/SKILL.md#p0-unreversed-side-effect`。
- **gate：无；`void` 只让 floating-promise lint 不报警，不证明清理结算。**
- **修复方向：**`async apply`/effect 中 await mount；统一 controller 异步 dispose，取消并唤醒 timer、等待 OAuth/catalog/stream；顺序 await Remote mount disposer，避免无所有者的 `.then()`。
- **严重度：P1。**

### 6.4 UI 样式规则

- **位置/原文：**`packages/jira/ui-jira/src/client/SuperagentSetupAction.module.css:17-18`：裸 `:hover` 和 `rgb(...)` fallback；`packages/uitstalie/ui-memory/src/client/MemorySection.module.css:11,18,35,40-48,60,65,71`：未定义 `--dsw-alias-text-*`、`bg-default`、`border-focus`；`packages/jira/ui-jira/src/client/JiraSection.module.css:13,36,124,179`：`font-weight: 600`；同文件 `:304,400,425,449` 中性 border `1px`；`ui-dafeiyu/.../CapabilitiesSection.module.css:181`、`common-view/.../AppScaffold.module.css:90`、`SidebarGroupList.module.css:36,40,131-132,151`：裸 `:hover`。
- **条款：**`docs/web-styling.md` L18、L24、L32；`.agents/skills/dsh-client-ui-ux/SKILL.md#visual-foundation`：字重 ≤500；`goal/AGENTS.md` L18：共用 `--dsw-*` token、不手搓材质。
- **gate：颜色/hover/中性 border 有共享 spec 可拦；未定义 alias、字重跨组规则未被现有全量检查完整覆盖。**
- **修复方向：**使用现有 `--dsw-alias-label-*`、`bg-layer-*`、`border-l*`、`interactive-bg-hover`；hover 加 `(hover:hover)`；中性分隔改 0.5px；字重 ≤500。
- **严重度：P2。**

### 6.5 共用控件与 key 身份

- **位置/原文：**`packages/uitstalie/ui-dafeiyu/src/client/CapabilitiesSection.tsx:73-94`：自写 `role=switch` 和 action button；`packages/uitstalie/common-view/src/client/views/scaffold/AppScaffold.tsx:79-92`、`SidebarGroupList.tsx:55-56,106`、`packages/jira/ui-jira/src/client/SuperagentPanel.tsx:128,134,187,197,212` 自写裸按钮；`packages/uitstalie/ui-models-dev/src/client/OAuthPanel.tsx:97-99`：`key={index}`。
- **条款：**`goal/AGENTS.md` L18、`docs/web-styling.md` L16、`packages/client/AGENTS.md` L19、`docs/defensive-patterns/client-components.md#a-key-states-what-it-identifies` L417-424。
- **gate：无完整 gate。**
- **修复方向：**换目录已有 `Switch/Button`，用 class/prop 保持局部样式；notice 由 owner 提供稳定业务 id。
- **严重度：P2。**

### 6.6 UI 文案与词典

- **位置/原文：**`packages/jira/ui-jira/src/client/store.ts:140`：`error: 'the Remote method is unavailable'`，helper 返回值进入页面 error；`packages/uitstalie/ui-dafeiyu/src/client/locales.ts:37-38,52`：`能力总代`、`组织者的门`；`packages/uitstalie/ui-memory/src/client/locales.ts:43`：`摘要 provider`；`packages/jira/ui-jira/src/client/locales.ts:144`：`一个 turn…生成物`；`:160`：Priority 译成 `严重程度`。
- **条款：**`AGENTS.md` L159；`packages/client/AGENTS.md` L124：所有产品文案经 typed dictionary；`.agents/skills/dsh-prose-standard/SKILL.md` L58；`docs/i18n/terminology.md` 的 turn=轮次、artifact=产物、capability=能力及直接准确翻译。
- **gate：当前 UI i18n gate 不追踪 helper 返回值到 JSX，也不判断译文语义。**
- **修复方向：**helper 返回结构化 `unavailable` 原因，由组件映射字典；文案改“能力/能力组织者”“摘要提供商”“一个轮次…派生产物”“优先级”。
- **严重度：P2。**

### 6.7 README 与实现矛盾

- **位置/原文：**`packages/uitstalie/common-view/README.md:32`：`sessionRowAction | true`，而 `src/config.ts:34-40` 默认 `false`；`packages/jira/ui-jira/README.md:12,36,62` 称 ledger 只读/只有模型写，和同页人工 proposal 确认、`src/client/index.ts:139-200` super workspace setup 相矛盾。
- **条款：**`AGENTS.md` L181、`packages/AGENTS.md` L27、`docs/AGENTS.md` L40：当前状态且事实只有一个 owner。
- **gate：双语配对 hash 不检查事实。**
- **修复方向：**默认值改 `false`；明确 settings、proposal 确认、workspace setup 三类写路径，删除绝对化“只读/只有模型写”。
- **严重度：P2。**

### 6.8 中文 Client 注释与损坏文本

- **位置/原文：**`packages/uitstalie/ui-models-dev/src/client/store.ts:21-82,102-187`、`index.ts:1-109`、`draft.ts`、`fields.tsx`、`packages/uitstalie/ui-tool-dsh-store/src/client/locales.ts:1-4`：中文代码注释；`ModelsDevSection.tsx:5` 含两个 U+FFFD：`一切变更经 controller 的动作派发出��。`
- **条款：**`packages/client/AGENTS.md` L120：Client code comments English；根 L177/L179：可读、直接的当前合约。
- **gate：lint/i18n 不检查注释语言或替换字符。**
- **修复方向：**保留技术事实翻为英文，恢复损坏文字；不改实现。
- **严重度：P2。**

### 6.9 `src/types.ts` 含运行时值

- **位置/原文：**`packages/uitstalie/persona-card/src/types.ts:12-15`：`PERSONA_SCHEMA`、`DEFAULT_PERSONA_MAX_BYTES`；`packages/interaction/tool-policy/src/types.ts:23`：`FILE_ACCESS_OPERATIONS`。
- **条款：**`packages/AGENTS.md` L25：`src/types.ts contains only types — no runtime code`。
- **gate：无专门 gate。**
- **修复方向：**常量移入 config/schema/runtime vocabulary 模块，`types.ts` 只保留类型。
- **严重度：P1。**

### 6.10 发布 files 清单不合标准

- **位置/原文：**17 个 `packages/uitstalie/*/package.json`，例如 `agent-instructions-plus/package.json:20-24` 的 `files` 只有 `lib/index.js`、d.ts、icon、locale；缺 `src` 和 `lib/types/**/*.d.ts.map`。
- **条款：**`docs/cookbook/adding-a-package.md#1-create-the-package` L27：标准 files 集合包括 `lib/index.js`、`lib/types/**/*.d.ts`、`lib/types/**/*.d.ts.map`、`src` 及包特定 runtime artifacts，声明与 map/source 同步发布。
- **gate：分支自有包被 workspace constraints 的发布成员规则豁免，依赖/client gate 不查这个集合。**
- **修复方向：**按真实 runtime artifacts 补齐 files，并在打包预览检查，不要复制无关 artifact。
- **严重度：P1。**

### 6.11 models-dev 与 OAuth 卸载未等待在途工作

- **位置/原文：**`packages/uitstalie/models-dev/src/index.ts:200-203`：`this.ready = this.load()`，disposer 仅 `lifetime.abort()`，未 await ready/refreshing；`packages/uitstalie/llm-plus/src/remote.ts:107-121`：保存 attempt 后 `void authorization.begin(...).then/catch`，服务无卸载中止/等待；`oauth/pkce-login.ts:185,238`：`server.close()` 不等待关闭，startCallbackServer 的 abort 不关闭 server；`remote.ts:38-40` 模块级 `nextAttemptId/nextPromptId` 也无实例 owner。
- **条款：**`docs/defensive-patterns/general.md#dispose-must-reach-quiescence-not-just-request-it` L194-198；`.agents/skills/cordis-styling-nitpicking/SKILL.md#p0-unreversed-side-effect`；`packages/AGENTS.md` L13 共享状态 owner。
- **gate：现有 models-dev spec 只测摘除服务，llm-plus stub 明示不 fiber-aware；不能覆盖晚写/late settle。**
- **修复方向：**models-dev effect 停止新 refresh 并 await ready + refreshing；PlusAuthRemote effect 停止新 begin、abort attempts、await 每个 flow 与 HTTP server close；id 计数器移入 Remote 实例。用 deferred fetch/login 验证 dispose pending 直到 settle。
- **严重度：P0。**

### 6.12 README Summary 超预算

- **位置/原文：**`packages/uitstalie/personality/README.md:12`：Summary 107 words；`packages/uitstalie/ui-memory/README.md` Summary 106 words。
- **条款：**`.agents/skills/dsh-doc-writing/SKILL.md#validation` 与 `templates/package-reference.md`：英文 Summary ≤100 词，且保留 config/failure/limits 等必要合约。
- **gate：会。** 实际 `pnpm run verify-package-readme-summaries` 退出 1，列出这两份。
- **修复方向：**压缩宣传/实现叙述，保留用户动作、配置、限制与失败事实，双语同步并重录 pair。
- **严重度：P2。**

### 6.13 真实组合测试缺口

- **位置/原文：**`packages/interaction/tool-policy/tests/policy.spec.ts:19-24`：只手工 `ctx.plugin`； denial 由伪造 guard/restrict 检查，没有 test-only cordis.yml 经 Loader 与真实 tool executor。
- **条款：**`packages/AGENTS.md` L7、`docs/testing.md` L39-41：product-visible plugin 需要非单元 REAL-composition，经 Loader/app/process，断言 model/durable/user-visible output；denial 在 executor 验证。
- **gate：普通单测和 coverage 不会识别缺失的真实入口。**
- **修复方向：**加真实 Loader composition，执行被拒 tool，断言 `error.info.name/code` 与 model-visible/durable outcome；加入 HMR fiber dispose。
- **严重度：P1。**

### 6.14 生成事件文档与实现矛盾

- **位置/原文：**`packages/core/session/src/known-event-types.ts:10-20` 仍写 unknown 非 ignorable 均拒绝，而 `session-persistence/src/storage-contract.ts` 默认跳过、critical 才拒绝。
- **条款：**`AGENTS.md` L181；`docs/AGENTS.md` L44/L46；prose 标准生成物追溯 owning source。
- **gate：`verify-persistence-catalog` 可查 freshness，不能判断陈旧文字与新手写实现矛盾。**
- **修复方向：**先确定 2.5 的规范取向，修改 generator owner 文本再生成，不能只改派生物。
- **严重度：P2。**
