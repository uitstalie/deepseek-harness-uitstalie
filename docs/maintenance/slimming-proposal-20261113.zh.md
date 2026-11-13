# 分支产物瘦身提案（2026-11-13）

[English](slimming-proposal-20261113.md) | 中文

状态：清点与提案；2026-11-13 用户裁定保留 `docs/inputs`、批 1 只删 6 个文档、批 3a 暂缓；本文保留初始提案。

## 0. 范围与口径

**我们自己的产物：** `packages/uitstalie/*`、`packages/jira/*`、`packages/superagent/*`、`packages/bundle/*` 的 patch/preset、`goal/`、我们写的 `docs/**`、`scripts/**`、`tests/**`。

**原生：** 上游仓库内容，即不在上述路径、且不带 `uitstalie-` 标记的文件。原生文件本轮一律不删不改；只提减少侵入方案。

本提案的依据是当前工作树（HEAD `fa34560cc2`）、`git grep`、包内测试和文档引用；不是凭印象。

## 1. 文档 · 过期（删）

| 路径 | 行数 / 大小 | 判断依据 | 删除前置 |
|---|---:|---|---|
| `docs/inputs/correction-patterns-20261113.md` | 199 行 / 12,334 B | 一次性分析输入；结论已内联到 `docs/design/dafeiyu-personality-plugin.md` 第 0/2 节；不属于产品文档 | 把设计稿顶部“输入保留在 docs/inputs”改为“输入已内联删除” |
| `docs/inputs/windows-superagent-eval-handoff-2026-11-09.md` | 91 行 / 6,467 B | 与 `docs/reviews/windows-superagent-eval-handoff-2026-11-09.md` 内容重复的一次性交接稿；正式交接稿保留 | 设计稿/审计稿中无引用；删除前 `rg` 确认 |
| `docs/reviews/2026-11-07-memory-jira-implementation-review.md` + `.zh.md` + `.i18n.yaml` | 257 + 257 行 / 109,433 B | 旧评级 C 的审查；其 J/M 项已被 `docs/reviews/audit-fix-coverage-20261110.*` 与当前测试覆盖；旧文档含本机绝对路径 | 先确认没有外部引用；删除后审计稿仍保留结论 |
| `docs/reviews/2026-11-07-memory-jira-fixes.md` + `.zh.md` + `.i18n.yaml` | 109 + 109 行 / 36,428 B | 一次性修复流水；“M1–M4 已修”已被包测试和审计表取代；与当前代码不同步 | 与上一条同批删除；先确认没有外部引用 |

合计：**8 个文件，约 1,022 行 Markdown**（其中 6 个带 i18n 记录），约 165 KB。

**保留不删：**

- `docs/reviews/windows-superagent-eval-2026-11-09.*`：仍是唯一的 Windows 实机证据；只做去本机路径，不删。
- `docs/reviews/windows-superagent-eval-handoff-2026-11-09.*`：k3.1 复审和主评测引用它；保留为历史交接。
- `docs/reviews/audit-fix-coverage-20261110.*`：当前整改账本；保留。
- `goal/mission/task*.md`：`goal/mission/FROZEN.md` 明确冻结为历史档案；不删。
- `packages/jira/HANDOVER.md` / `MIGRATION.md` / `DESIGN.md` / `ARCHIVE-SOURCE.md`：虽然页首已标历史，但 `jira-core/README`、错误码测试和决策引用仍依赖它们；删除会先破坏文档链接与测试，不能列入本轮。
- `docs/design/dafeiyu-personality-plugin.*`：当前设计；保留。

## 2. 文档 · 错误（改）

| 路径 | 原句 | 拟改句 | 依据 |
|---|---|---|---|
| `goal/native-change-inventory.md` | `| 原生改动，带标记 | 73 | ... |`；正文“73 个文件” | `| 原生改动，带标记 | 102 | 2026-11-13 的 git grep 结果（源/配置；另 10 个原生文档） |`；正文改 102 | 当前 `git grep -l "uitstalie-"`（排除 `goal/`、`docs/`、我们的包组）为 **102**；旧计数 73 已过期 |
| `docs/reviews/windows-superagent-eval-2026-11-09.md` | ``- dev: `<dev-checkout>`, branch `cli-desktop`, on the same baseline as the runtime.`` | ``- dev: `<dev-checkout>`, branch `cli-desktop`, on the same baseline as the runtime.`` | 文档可移植性；本机绝对路径不应入库 |
| 同上 `.zh.md` | ``- dev：`<dev-checkout>`，分支 `cli-desktop`，与 runtime 使用同一基线。`` | ``- dev：`<dev-checkout>`，分支 `cli-desktop`，与 runtime 使用同一基线。`` | 双语成对修改；同段其他 `D:\dqc\...` 一并改 `<dev-checkout>` / `<super-workspace>` |
| `docs/reviews/2026-11-07-memory-jira-implementation-review.md` | ``> Review target: `<dev-checkout>`, branch ...`` | 若保留该文档，改为 `> Review target: <dev-checkout>, branch ...` | 该文档已列入删除批；若改为保留，必须同时改中文并重录 pairing |

`docs/reviews/2026-11-07-memory-jira-fixes.md` 不单独改：整份进入删除批，避免“改完再删”。

**不视为错误、不要改：**

- `docs/reviews/windows-superagent-eval-2026-11-09.*` 里“当时 build 失败 4 个 unused import”是带日期的历史事实，不是当前状态；保留原句。
- `packages/jira/HANDOVER.md` / `DESIGN.md` / `MIGRATION.md` 已在页首标明历史；不改正文，除非决定整篇归档。

## 3. 代码 · 废弃/过时

### (a) 无任何引用

当前**没有**发现整文件级完全无引用的分支源码；`rg` 对 `packages/uitstalie/personality`、`packages/uitstalie/ui-personality`、`packages/uitstalie/persona-card` 都有 package/组合或测试引用。不要为了凑数删“看起来没人用”的文件。

### (b) 有引用但已被替代

| 路径 | 规模 | 替代者 | 测试覆盖 | 处理 |
|---|---:|---|---|---|
| `packages/uitstalie/personality/**` | 15 个 ts/tsx/md 文件，**4,937 行 / 211 KB** | `docs/design/dafeiyu-personality-plugin.md` 的新全局实现（尚未实现） | 4 个测试文件（`commands`/`personality-file`/`provider`/`watch`），约 1,487 行 | **现在不删**。等新设计实现后整包替换；旧测试随旧代码一起删，不能先删测试 |
| `packages/uitstalie/ui-personality/**` | 13 个 ts/tsx/md 文件，**1,136 行 / 44 KB** | 新 output-style / writing-rules UI（设计稿第 8/7 节） | `entry.host`、`personality-section.client`、`settings-form.client` 三个测试 | 与 personality 同一批删除；旧 proposal 页不保留 |
| `--permission-mode` 旧旗标 | `packages/bundle/headless/src/startup.ts`（约 5 处）、`src/index.ts`（2 处 legacy 字段）、`tests/startup.spec.ts`（3 个用例） | `--policy`（当前正式旗标） | `startup.spec.ts` 有专门“retired flag warning”用例 | 可删；同步改 README、`docs/cli-help.*`、测试和 release/upgrade 说明。删除后仍是 CLI 破坏性变更，需单独 release note |

### (c) 试验性/未接线

当前没有发现“完全未接线、可安全整包删除”的分支包。`persona-card` 默认关闭但由 `cordis.patch.uitstalie.yml` 显式挂载，属于有意的试验特性，不列入删除。

**旧 personality 的删除量：** 28 个文件、6,073 行、约 255 KB；其中 4 个测试文件、约 1,487 行。**前置是**新设计已经实现并有等价测试，否则删除会让人格能力完全消失。

## 4. 原生侵入清单

当前 `git grep -l -e "uitstalie-" -e "dsh-uitstalie"`（排除 `goal/`、`docs/`、我们自己的包组）为 **102 个源/配置文件**；另有 **10 个原生文档**带标记。`goal/native-change-inventory.md` 的 73 是旧基线，已过期。下表按侵入面分组；完整逐文件清单由该命令导出，关键文件单独列出。

| 侵入组 | 文件数 | 典型改动 | 能否回原生 | 必须保留的最小范围 |
|---|---:|---|---|---|
| 未标记的检索默认值 | 3 | `packages/bundle/base/cordis.patch.yml`、`packages/bundle/web-app/cordis.patch.yml` 的 `openAt: first-search`；`apps/cli/tests/lazy-search-startup.compat.spec.ts` 期望值 | **能** | 原生恢复 `never`；由 `cordis.patch.uitstalie.yml` 覆盖为 `first-search`，分支测试放 `packages/uitstalie/**` 或 `apps/cli/tests` 的新文件 |
| CI 静态门禁 | 1 | `.github/workflows/ci.yml` 的 jira node:test 步骤 | **能** | 删除原生 workflow 块；本地 `scripts/run-gates`/CI 另设分支文件 |
| 根规则 | 1 | `AGENTS.md` 的 Windows ACL 一行 | **能** | 删除该行；限制已在 `docs/subsystems/sandbox` 与 `goal` 文档 |
| base 组合 | 1 | `packages/bundle/base/cordis.patch.yml` 的 home-write 块 | **能**（需验证分支 patch 层在其后应用） | 移动到 `cordis.patch.uitstalie.yml`，原生只留空行 |
| web/base 包清单 | 2 | `packages/bundle/{base,web-app}/package.json` 的分支依赖与 patch 数组 | **不能完全**（原生包要声明 patch/依赖才能挂载） | 只留最小依赖 + 一个 `*.uitstalie.yml` 引用；分支 bundle 化另案 |
| 构建/门禁配置 | 20 | `tsconfig.base/host/client`、`vitest.config.ts`、15 个 `scripts/*` 分支分类/豁免 | **不能完全** | 只保留注册分支包、生成分支目录所需的行；删除一次性豁免/字符串特判 |
| 原生导出缝 | 1 | `packages/context/agent-instructions/src/index.ts` 约 20 行导出 | **不能**（plus 需要内部状态机） | 只保留导出块；中期向上游提稳定 seam |
| Windows/文件行为 | 约 40 | `packages/sandbox/*`、`packages/shell/*`、`packages/fs/*` 的 `uitstalie-` 块 | **不能**（Windows ACL/软策略修复是行为价值） | 只保留 fail-closed、分类、围栏相关最小块 |
| 测试支撑 | 4 | `packages/test-support/client-runtime/*` 的 `$stream`/roster 替身 | **不能完全** | 只保留分支 Web roster 所需的替身 |
| 运行时 loader | 1 | `vendor/loader/src/internal.ts` 的 v1/v2 形状探测 | **不能**（分支运行依赖） | 保留这一处；不扩大 |
| 原生 README/文档 | 2 + 2 | `packages/README.*` 的 uitstalie 行；`docs/subsystems/sandbox.*` 的手写标记 | **README 能**；sandbox 文档只能收窄 | README 行可移到 `packages/uitstalie/README`；sandbox 只留限制说明，不重复实现 |

**逐项**（高影响文件）：

- `packages/bundle/web-app/cordis.patch.yml`：`openAt: first-search` 是**未标记**的原生改动，必须优先修。
- `packages/bundle/base/cordis.patch.yml`：`openAt: first-search` + home-write 块；前者未标记，后者有 DH-902 标记。
- `apps/cli/tests/lazy-search-startup.compat.spec.ts`：为 first-search 改的原生测试，必须随上一条回退。
- `.github/workflows/ci.yml`、`AGENTS.md`：一个 CI 块、一行规则；都能回原生。
- `tsconfig.*`、`vitest.config.ts`、`scripts/*`：共 20 个文件，是分支包能构建的 plumbing；不是功能代码，但标记最多。
- `packages/context/agent-instructions/src/index.ts`：唯一“原生内部 API 导出”缝；保留。
- `packages/sandbox/*`、`packages/shell/*`、`packages/fs/*`：约 40 个文件，属于 Windows/策略行为；保留，不能为了“零侵入”退掉。

## 5. 减少侵入提案（按侵入面排序）

| 优先级 | 方案 | 类型 | 预期收益 |
|---:|---|---|---|
| 1 | 把 base/web 的 `openAt: first-search` 恢复为原生 `never`；在 `cordis.patch.uitstalie.yml` 里覆盖；原生 CLI 测试恢复，另建分支测试 | ①完全回原生 | 去掉 2 个未标记原生配置改动 + 1 个原生测试；first-search 仍生效 |
| 2 | 删除 `.github/workflows/ci.yml` 的分支块；jira node:test 改由分支脚本/分支 workflow 文件跑 | ①完全回原生 | 少 1 个原生 CI 冲突点 |
| 3 | 删除 `AGENTS.md` 的 Windows ACL 行；限制已在 docs 与 goal | ①完全回原生 | 少 1 个根规则冲突点 |
| 4 | 把 base 的 home-write 块移入 `cordis.patch.uitstalie.yml` | ①完全回原生（需验证层序） | 少 1 个原生 patch 冲突点 |
| 5 | `packages/bundle/{base,web-app}/package.json` 收窄为“一个分支 patch + 最小依赖”；依赖移入分支 bundle 的 package | ②保留但收窄 | 原生 JSON 只留登记行；分支依赖集中 |
| 6 | `tsconfig.*`/`vitest.config`/`scripts/*` 只保留注册与生成所需行，删除一次性字符串豁免 | ②保留但收窄 | 20 个文件的标记块缩短；不能完全归零（分支包必须注册） |
| 7 | `agent-instructions` 导出块保留；向上游提 seam 后删除 | ③必须保留 | 20 行内部依赖；短期不动 |
| 8 | sandbox/shell/fs 的 Windows 修复保留；只收窄到 fail-closed 与分类所需 | ③必须保留 | 约 40 个文件无法回原生；退掉会重新引入 Windows 故障 |
| 9 | `test-support`/`vendor/loader`/原生 README 行保留 | ③必须保留/极小 | 测试与运行时依赖；README 可移到分支文档，收益小 |

**预计侵入面：** 102 个源/配置标记文件，按 1–4 可去掉约 6 个原生文件/冲突点（102 → 约 96）；5–6 只缩短块，不减少文件；7–9 不动。**不要把“102→96”当成大胜**：真正的剩余大头是 40 个 Windows 行为文件和 20 个构建 plumbing 文件。

## 6. 分批执行计划（本轮不执行）

### 批 1：文档清理（低风险，先做）

**删除：**

- `docs/inputs/correction-patterns-20261113.md`
- `docs/inputs/windows-superagent-eval-handoff-2026-11-09.md`
- `docs/reviews/2026-11-07-memory-jira-implementation-review.{md,zh.md,i18n.yaml}`
- `docs/reviews/2026-11-07-memory-jira-fixes.{md,zh.md,i18n.yaml}`

**更正：**

- `goal/native-change-inventory.md` 的 73 → 102（并重跑 `git grep -l` 记录日期）。
- `docs/reviews/windows-superagent-eval-2026-11-09.md` / `.zh.md` 的本机路径改 `<dev-checkout>` / `<super-workspace>`；成对重录 pairing。
- 设计稿顶部“输入保留在 docs/inputs”改为“输入已内联，文件删除”。

**影响：** 文档链接/pairing/goal 引用。执行前 `rg` 检查；删除后 `pnpm run verify-translation-pairing`、`verify-md-links`、`test:docs`。

**回滚：** 一个 commit；`git revert <sha>` 恢复全部文档和 sidecar。无构建影响。

### 批 2：废弃 CLI 旗标（小代码改动，需单独决定）

**改动：**

- `packages/bundle/headless/src/startup.ts` 删除 `--permission-mode` 选项、别名解析与 warning。
- `packages/bundle/headless/src/index.ts` 删除 `permissionMode` legacy 读取路径。
- `packages/bundle/headless/tests/startup.spec.ts` 删除/改写 3 个 alias 用例。
- `packages/bundle/headless/README.*`、`docs/cli-help.*` 去掉旧旗标；历史 upgrade guide 保留（它记录的是历史）。
- 需要新的 release note：这是 CLI 破坏性删除，不是“无感清理”。

**影响：** headless 构建/测试、CLI help 生成、文档 pairing。**回滚：** 一个 commit。

### 批 3：旧 personality + 原生侵入（高风险，阻塞于新设计实现）

**3a 旧 personality：**

- 删除 `packages/uitstalie/personality/**`（28 文件，6,073 行）及 `packages/uitstalie/ui-personality/**`（10 文件）。
- 删除 bundle 挂载行、旧 config、旧测试；旧 `PERSONALITY.md` 按设计只备份/移动，不在这个 commit 删用户数据。
- **前置：** 新 `personality_analyze` / `personality_apply`、output-style、writing-rules 已有等价测试；否则禁止执行。

**3b 原生侵入：**

- 恢复 base/web `openAt: never`；在 `cordis.patch.uitstalie.yml` 覆盖 first-search；恢复原生 CLI 测试。
- 删除 CI 原生块、`AGENTS.md` 行、base home-write 块（先验证分支 patch 层序）。
- 收窄 `tsconfig`/`scripts` 遗留标记；不动 sandbox/shell/fs 的 Windows 行为。

**影响：** build 10/10、typecheck 5/5、六文件测试、memory/personality 测试、CLI smoke、pairing。**回滚：** 3a/3b 各自一个 commit；删除用户数据不在回滚范围（数据只移动/备份）。

## 7. 预期删除量

| 类别 | 文件数 | 行数（约） | 说明 |
|---|---:|---:|---|
| 文档删除 | 8 | 1,022 | 输入 2 + 旧 memory review/fixes 6 |
| 文档更正 | 5 | 少量 | 2 个英文/中文对 + goal + pairing |
| 代码删除（旧 personality） | 28 | 6,073 | 等新实现；含 4 个测试文件 1,487 行 |
| 废弃 CLI 旗标 | 0（只改 7 个文件） | 约 50 | 删选项/分支/测试，不删文件 |
| **合计删除** | **36** | **约 7,100** | 文档约 165 KB + 旧 personality 约 255 KB |

原生侵入不按“删除文件”计：方案 1–4 减少约 6 个原生冲突点，方案 5–6 只缩短块，方案 7–9 必须保留。

## 8. 明确不删/不改

- 不删原生文件，不删仍有行为价值的测试。
- 不删 `goal/mission/task*.md`（FROZEN）、当前 audit/design、Windows 实机评测与正式 handoff。
- 不删旧 `PERSONALITY.md` 用户数据；按设计只移动/备份。
- 不把旧的 `--permission-mode` 删除和 personality 删除放同一个 commit。
- 不做顺手重构、不做功能改动；本轮只提案。
## 9. 执行结果

- 批 1：`e69c9696e5`，13 files，+474/−1,226；删除 6 个旧 memory/jira 审查与修复流水，保留 `docs/inputs`；pairing 1303 对、md-wrap 2,658 files、md-links 2,621 files 通过。
- 批 2：`78a787e3a0`，14 files，+101/−81；`--permission-mode` 删除；build 10/10、typecheck 5/5、headless 135/135；release note 已加。
- 批 3b：`abf8f50f2e`，8 files，+40/−39；原生 `openAt` 恢复 `never`，分支 patch 覆盖 `first-search`；build 10/10、typecheck 5/5；真实 memory 工具首搜 46 ms、二搜 6 ms 命中；原生标记 **102 → 99**。
- 批 3a：旧 personality 删除**推迟到新实现之后**，本轮不做。
- 剩余 99 项按 `goal/native-change-inventory.md` 的 2026-11-13 用户裁定，全部保留；Windows ACL 与 agent-instructions 导出缝明确不得作为瘦身目标。

**结论：瘦身到此为止，后续只在新增侵入时逐项审批。**
