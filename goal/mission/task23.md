# task23 — rebase 到 upstream 5badb15009 + 移除 invariant 伴生入口

## requirement

用户要求（2026/10/09）：拉取上游提交并 rebase。分支约定（[AGENTS.md](../AGENTS.md)）：rebase 后必须 `git grep -n "uitstalie-"` 盘点全部标记、逐处确认适配结果；原生改动与分支改动分开提交。

## 本次 rebase 的事实

| 项 | 值 |
|---|---|
| 目标基座 | `upstream/master` = **5badb15009**（release dsh 0.2.1-alpha.1，比 fork 镜像 `origin/master` 639ed01539 多 1 个提交） |
| 重放提交 | **73 个**（我们一方），跨过上游 **266 个**新提交 |
| rebase 前 HEAD | `c6ef5ea9fc`（备份：分支 `backup/cli-desktop-20261009-1030` + tag `backup-cli-desktop-20261009-1030`） |
| rebase 后 HEAD | `dc38771c5a`（task21 报告那条提交，内容不变、父链更新） |
| 冲突文件总量 | 35 个（与上游同期改动重叠的文件数）；实际停 6 次 |
| 真源开启 | repo-local `rerere.enabled=true` + `rerere.autoupdate=true`（复用解法） |

**冲突处理原则**：生成物取上游侧 + 事后重生成；语义内容两边保留。

| 停点 | 文件 | 处理 |
|---|---|---|
| 23/73 | `packages/sandbox/sandbox/README.{md,zh.md,i18n.yaml}` | 以上游为底，**把我们的两处加回**（`classifyDenial` 需要路径证据的段落 + `src/diagnostics.ts` 源码地图行；中文侧同步），配对记录重录 |
| 26/73 | `pnpm-lock.yaml` | 取上游侧（lockfile 不手改，收尾 `pnpm install` 重生成） |
| 40/73 | `packages/extensions/tool-cordis/src/api-catalog.ts` | 取上游侧，收尾 `pnpm run gen-cordis-api` 重生成 |
| 43/73 | `packages/bundle/web-app/presets/{standard,ptc,cordis}.patch.yml` | **两边保留**：我们的 plus config（`agentInstructions.maxBytes` + `rules.maxBytes`）+ END 标记，其后接上游新增的 `- id: time-context` 行（上游新插件，不能丢） |
| 45/73 起 | `pnpm-lock.yaml`（多次） | 同上，取上游侧 |

## 上游改动导致的适配（分支自有文件）

**上游 v0.2.0-rc.2 移除了 runtime invariant 机制**（证据：`docs/upgrade-guide/v0.2.0-rc.2/remove-runtime-invariants/guide.md` —— 不再发布 `@deepseek-ai/dsh-invariants`、`InvariantRegistry`、`InvariantInstaller`、`InvariantError`，也不再有 `<package>/invariant` 子路径）。我们的三个包此前发布 invariant 伴生入口，`pnpm install` 因此直接失败（`@deepseek-ai/dsh-invariants` 已不在 workspace）。

据此**撤除三个包的 invariant 伴生入口**（全部为分支自有文件）：

| 包 | 改动 |
|---|---|
| `packages/uitstalie/models-dev` | 删 `src/invariant.ts`；`package.json` 去掉 `./invariant` 导出、`lib/invariant.js` files 项、两处 `@deepseek-ai/dsh-invariants` 依赖；`tsconfig.json` 去掉 `runtime-diagnostics/invariants` 引用 |
| `packages/uitstalie/llm-plus` | 同上 |
| `packages/uitstalie/ui-models-dev` | 同上，另 `tsdown.config.ts` 去掉 `'lib/types/invariant.js'` 入口 |

`tsconfig.base.json` 的两条 `/invariant` 别名在**生成区**，由 `pnpm run gen-tsconfig-paths` 自动删除（手写区不动）。

**新门禁要求**（`verify-cordis-config`，上游修好了它的符号链接问题后首次能跑通）：Loader 组合夹具里的**裸包名必须在其 resolver manifest 声明**。补齐：

- `tool-dsh-store/package.json`：`@deepseek-ai/dsh-agent-loop`、`@deepseek-ai/dsh-system-prompt` → devDependencies；
- `agent-instructions-plus/package.json`：`@deepseek-ai/dsh-agent-loop`、`@deepseek-ai/dsh-system-prompt`、`@deepseek-ai/dsh-tools` → devDependencies。

## 标记盘点（分支约定的 rebase 收尾动作）

- `git grep -l "uitstalie-"`：rebase 前后均为 **45 个文件**——**rebase 未丢失任何标记**；
- 盘点发现我 task14 的 `ui-workspace` slot 改动（4 文件 7 处）**当初漏了标记**（rebase 前就没有，非 rebase 所致）。本次**补齐 8 处**：`contract/slots.ts`（owner 接口 + SlotMap 条目用 BEGIN/END 块，联合成员用单行）、`index.ts`（children 条目单行）、`rows/Rows.tsx`（联合成员、解构参数、`renderSlot` prop 用块、JSX 渲染点用 `{/* */}`）、`rows/WorkspaceBrowser.tsx`（透传点用 `{/* */}`）。补齐后 49 个文件带标记。
- **既有缺口（未处理，需用户定夺）**：另有 38 个原生文件有我们的改动但没有标记，分三类——(1) **生成物/记录**（`pnpm-lock.yaml`、`api-catalog.ts`、`*.i18n.yaml`、`docs/subsystems/*.md`）：标记会被重生成覆盖，按规则改为**在任务单登记**；(2) **JSON**（`package.json`、`bundle/*/package.json`、`opencode.json`）：不支持注释，同样登记；(3) **早期任务的代码/文档**（`fs-local`/`fs-sandbox`/`sandbox`/`shell/*` 的 README 与少数源码、`sandbox-local`/`sandbox-windows-acl` 的测试）：可以补 `<!-- -->`/`//` 标记，但那是**一批原生改动**，按分支规则需独立任务单——本次未动，等用户决定是否做这轮合规清扫。

## 发现：`test:gui` 的 50 个失败源于「分支的 client 行进了原生组合层」

rebase 后 `pnpm run test:gui` = **11 文件 / 50 测试失败**（此前 7 文件 / 8 测试）。分诊：

| 类别 | 文件 | 结论 |
|---|---|---|
| 已知分支自有 | `ui-theme` 的 `elevation-styles` + `corner-shape-styles`（2） | 我们 `ui-models-dev` 的既有 CSS 违规 → [task21](task21.md) 处理 |
| 环境性 | `ui-deliverables/present-open`（Windows 符号链接）、`connection/binary-rpc`、`ui-sidebar-documentpreview`（本机 pnpm store） | 与本分支无关 |
| **组合 roster 簇** | `ui-settings-general`（11）、`ui-settings-account`（26）、`ui-shortcuts`（2）、`ui-renderer/reconnect`（1）、`ui-directory-picker-native`（1）、`ui-trajectory/client-bundle`（1） | **由我们的组合行造成**，见下 |

**机制**：上游的组合测试运行时按 **bundle patch 文件**推导浏览器 roster（`packages/test-support/client-runtime/src/assembly/bundle-roster.ts`，规格用 `createClientTest({ roster: webApp })`，共 11 个规格如此）。因此把分支自有 client 行写进 `packages/bundle/web-app/cordis.patch.yml`（[task17](task17.md) / [task14](task14.md)）之后，这些规格装配到的 roster **不再是上游出厂 roster**，而它们：
- 用固定的 Remote 桩集合（我们的 `ui-models-dev` 在 boot 就调 `modelsDev/listCatalogProviders` 与 `llmPlusAuth/listOAuthRoutes` → `remote-mock: unmatched request(s)`）；
- 断言固定的设置分区账本（我们的设置分区把它从 4 变 5 → `expected [Array(5)] to deeply equal [Array(4)]`）。

**对照实验（决定性）**：把工作树里 6 个分支相关 client 侧文件临时换回上游版本（ui-workspace 4 文件 + `web-app/cordis.patch.yml` + `tsconfig.base.json`）→ 同一规格 **9/9 通过**；只回退 `web-app/cordis.patch.yml` 一个文件 → **9/9 通过**；只回退 ui-workspace 四个文件 → 仍 8 失败（排除 slot 改动）；只回退 host 行或只回退 client 行 → 仍失败（说明是**组合行集合**而非单一行的作用）。

**另修好了一层**：这些规格最初报的 `Cannot find package '@deepseek-ai/dsh-client-ui-models-dev/client'` 是**真缺口**——我们的 client 包在 `tsconfig.base.json` 只有根别名、没有 `/client` 子路径别名（上游 41 个 client 包都有）。已补（`dde7993a72`），该层错误消失，剩下的才是上面的 roster 语义冲突。

### 三个选项（需用户拍板）

| 选项 | 做法 | 代价 |
|---|---|---|
| **A 惰性化** | 让我们的 client 插件不在 boot 时取数（改为打开设置页才取） | 只能消掉 `remote-mock` 那一层；设置分区账本 4→5 是注册本身造成的，改不掉 |
| **B 改上游规格** | 更新受影响的 2–4 个原生规格（认我们的分区 + 补我们的端点桩） | **原生 spec 改动**，每次 rebase 到同区域都会再冲突 → 违背"最小原生差异"总目标 |
| **C 分支自有 bundle（推荐）** | 把我们的行移进一个分支自有 bundle 包（如 `packages/uitstalie/uitstalie-web/cordis.patch.yml` + `dsh.bundle` 清单），由分支 profile 挂载该 bundle | 原生组合层恢复与上游完全一致 → 这 11 个规格转绿、rebase 友好；代价：新 profile 需要多一行 bundle 声明（写入 goal 文档），task17 的"逐插件写入原生组合层"退化为"整包声明" |

## 上层机制：推导器与 remote 桩是干什么的（用户追问，补记）

### 推导器（`packages/test-support/client-runtime/src/assembly/bundle-roster.ts`）

**它把"profile 的组合层"翻译成"vitest 里的浏览器 roster"**，让整个 client 层测的是**真实出厂组合**，而不是一份手写清单：

1. 取 profile 的 bundle 层（`WEB_PROFILE_BUNDLES = ['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']`，与 `PROFILE_TEMPLATES.web` 一致）；
2. 读每个 bundle 的 `dsh.bundle.patch` 文件清单，用**include 插件自己的 YAML 方言**（`entryListSchema`）解析，再用**同一个** `applyEntryPatches` 组合——即 `insert`、按 id 覆盖、group、`disabled` 的语义都是**启动器那一套**，不是重写；
3. 展开 group、按 Loader 规则判定 `disabled`（含用 `{profileContext:{name:'web'}}` 作用域求值的 `!!js`）；
4. 只把**包清单声明了 `dsh.client.platform === 'web'`** 的行变成 roster 行，带上该声明的 `inject`/`immediately`；
5. **什么都不拷贝**：改一个 bundle patch，下次 import 就反映出来（模块注释原话）；解析不到的 bundle/行/patch 在此直接抛错（启动器只告警的地方它更严）。

**推论**：把分支自有 client 行写进原生 bundle patch，就**按设计**改变了这 11 个用 `roster: webApp` 的规格所装配的 roster —— 所以失配要**在上层适配**（改规格期望 / 共享默认表），而不是把行搬走。

### remote 桩（`packages/test-support/remote-mock/` + 装配默认表 `client-runtime/src/assembly/remote-default-responses.ts`）

- `RemoteMock` 是 Host Typert Remote 网关的测试替身：一张**端点表**（unary 应答、stream 脚本）+ 流控 + 调用日志 + Connection 载体面。装配时注入为 `remote`，于是 client 插件的 `ctx.remote.ns.method()` 落到表里而不是网络。
- 收尾时 `assertNoUnmatched` 会**因未登记的调用而失败**——这是**契约断言**（"该组合在启动/渲染阶段究竟用到了哪些端点"），不是噪音。
- 共享默认表 `remote-default-responses.ts` 把"启动阶段会碰到的每个端点"列全，**每行注释写明调用方插件**，并声明策略：**"boot 从不触碰的端点保持缺席，好让新调用大声失败"**。

## 上层适配（按"最小侵入上层"执行）

| 文件 | 改动 | 依据 |
|---|---|---|
| `packages/test-support/client-runtime/src/assembly/remote-default-responses.ts` | 增两行：`modelsDev/listCatalogProviders`、`llmPlusAuth/listOAuthRoutes` → `ok([])`，注释写明调用方是本分支 `ui-models-dev` 的 apply（`load()`/`loadOAuthRoutes()`） | 遵循该表自己的策略与格式 |
| `packages/client/ui-settings-general/tests/shell.client.spec.ts` | `PRODUCT_SECTIONS` 加 `'models-dev'`（并更新注释） | 规格自带注释："A plugin adding a section changes this list" |
| `packages/uitstalie/ui-models-dev/src/client/index.ts`（分支侧） | 设置分区 `order: 20 → 12`，确定落在 `models`(10) 与 `plugins`(15) 之间 | 原为 20，与 `agent-presets` 并列导致导航顺序不确定 |

## 真正的根因（46 个失败的来源）

上面的适配消掉了 `remote-mock` 与分区账本两层，但簇仍红。抓到的最内层错误是：

```
Error: web boot: 1 entry did not activate
@deepseek-ai/dsh-client-ui-models-dev: failed
 ❯ assertEntriesActive packages/client/web/src/boot-client.ts:87
```

即 **`ui-models-dev` 在装配启动时激活失败**（`failed`，不是 pending），`bootClient` 因此抛错 → 所有装配 web roster 的规格连带失败。`assertEntriesActive` 只聚合失败项、**不打印 cause**，所以下一步要拿到该 fiber 的错误对象（在 `boot-client.ts` 的失败集合里）才能定位我们 apply 里的抛出点。这是**分支自有插件的问题**（由 task17 把它放进组合层才进入装配），不是 rebase 造成。

## 原生改动审计（按"上游已满足则回归原生"）

| 原生改动 | 上游现在是否已提供 | 结论 |
|---|---|---|
| invariant 伴生入口（`models-dev`/`llm-plus`/`ui-models-dev`） | **上游已删除该机制** | **已回归原生**（本次撤除）✓ |
| `agent-instructions` 的导出块（task16） | 无（上游导出集与旧版一致，我们要的名字不在其中） | 保留 |
| `ui-workspace` 逐工作区行动作 seat（task14） | 无（上游只有 session 行 seat 与 directoryFlow） | 保留 |
| `FileSystem` 的 `createDirectory`/`remove` 原语（task14 等） | 无（`fs/fs`、`fs-local`、`fs-sandbox` 都没有） | 保留 |
| sandbox 拒绝的**路径证据**（task12，`classifyDenial` 取授权根） | **无**——上游 `classifyDenial(result, signatures)` 仍是纯短语匹配；上游新增的 `diagnostics.ts` 只做 runner 失败与 spawn 可用性 | 保留（撤回会重现"误报沙盒拒绝并诱导升权"的缺陷） |
| shell/ptc 调用点（task12 的配套） | n/a（服务于上一条） | 保留 |
| `scripts/gen-cordis-catalog.ts` 的分类豁免（task18/19） | 无——实测**去掉即生成器失败** | 保留 |
| bundle 组合行、tsconfig 登记与手写别名 | n/a（组合与登记，非能力） | 保留 |

**结论**：本轮除 invariant 机制外，**没有其他可回归项**——上游尚未提供我们当初补的那些能力。

## 根因与修复（分支侧）：`$mount` 撞名 + 启动取数

`assertEntriesActive` 不打 cause，于是用**我们自己的包**做临时探针（try/catch + console.error，抓完即撤），拿到真因：

```
Error: client api: namespace "modelsDev" conflicts with an existing Remote namespace
  ❯ Proxy.validateContribution packages/api/gateway/src/client/index.ts:303
```

**装配层已按行安装每行生成物的 Remote 命名空间**，我们仍在 apply 里无条件 `ctx.remote.$mount(modelsDevRemote)` → 撞名 → 该 fiber `failed` → `bootClient` 抛错 → 所有装配 web roster 的规格连带失败（46 个）。

两处分支侧修复：

1. **缺了才挂**：`ctx.get('remote.modelsDev') === undefined ? await ctx.remote.$mount(...) : undefined`（`llmPlusAuth` 同）——符合平台"可选服务用 `ctx.get`"的约定，在"外壳不自动挂/按行装配已挂"两种装配下都正确；disposer 改为可选调用。
2. **取数延后到首次打开页面**：`load()/loadOAuthRoutes()/loadMyRoutes()/startCatalogPolling()` 从 apply 移进注入面的 `activate()`，由 `ModelsDevSection` 首次挂载触发（`useEffect`）。装配态下没人打开页面 → **不读 Host** → 规格里 `settings/describe` 的调用计数恢复（3→2、1→0），并顺带消掉卸载后仍发布的 `Cannot update an unmounted root`。

因此**上一步加的两行默认端点又被撤掉**（`50dae13310`）——共享默认表保持与上游**逐字一致**，顶层净原生改动只剩下规格里的分区清单那 1 行 ✓。

## 最终验证

`pnpm run test:gui`：**5 文件 / 5 测试失败，9776 通过**（rebase 后最初是 11 文件 / 50 失败；rebase 前是 7 文件 / 8 失败）。剩余 5 个全部已有归属：

| 失败文件 | 归属 |
|---|---|
| `ui-theme/tests/elevation-styles`（9 处 1px 描边） | 我们 `ui-models-dev` 的既有 CSS → [task21](task21.md) |
| `ui-theme/tests/corner-shape-styles`（`.badge`） | 同上 |
| `ui-deliverables/tests/present-open` | 环境：Windows 无符号链接 |
| `connection/tests/binary-rpc` | 环境（rebase 前即失败） |
| `ui-trajectory/tests/client-bundle`（`[]` vs `['trajectory']`） | **上游包**按构建产物挂进裸 ring 的断言，与本分支内容无关；rebase 后（Vite 8 等升级）才出现，待单独诊断 |

其余相关验证：`tsc` 两面干净 ✓、`pnpm run build` 359 artifact ✓、`packages/uitstalie` **11 文件 / 86 测试** ✓、`test:docs` 21 条全绿 ✓、依赖门禁 76 包 ✓、client 门禁 63 包 ✓、`gen-cordis-api` 119 artifact ✓。

## 验证（rebase 后）

| 检查 | 结果 |
|---|---|
| `tsc -b tsconfig.host.json` | ✓ 干净 |
| `tsc -b tsconfig.client.json` | ✓ 干净（首次报 4 处错在上游新包 `client-ui-claude-code-mods`，是 build 前缺已生成的 remote 类型；build 后复跑通过） |
| `pnpm run build` | ✓ **359** client artifact（此前 351；+8 来自上游新包） |
| 聚焦测试 `packages/uitstalie` + `client/ui-workspace` + `bundle/web-app` | ✓ **31 文件 / 545 测试** |
| `pnpm run gen-cordis-api` | ✓ 119 artifact 计算、1 个写入（task18/19 的分类数据在上游新代码下仍成立） |
| `pnpm run test:docs` | ✓ **21 条门禁全绿** |
| `verify-package-dependencies` | ✓ 76 包 |
| `verify-client-packages` | ✓ 63 client 包 |
| `pnpm dsh --profile web --dump-config` | ✓ 我们的行全部就位（`models-dev`、`ui-models-dev`、`ui-tool-dsh-store`、`agent-instructions-plus`、`tool-dsh-store`） |
| `verify-cordis-config` | **仅剩一个环境性失败**：`apps/cli/tests/profiles/acp/cordis.yml` 是上游文件（diff 为空），内容是 `../../../../../snapshots/...`——即 Windows 无符号链接支持把 git symlink 检出成文本文件（与当初挡住该门禁的同一问题），与本分支无关 |
| `git grep '^(<<<<<<<|>>>>>>>) '` | ✓ 无冲突标记泄漏 |
| rebase 过程中磁盘上的 lockfile | 每次冲突均取上游侧；收尾 `pnpm install` 与 `pnpm install --lockfile-only` 各一次，`pnpm-lock.yaml` 现与三处清单改动一致 |

## 待办

1. **推送决策（需用户拍板）**：本次 rebase 重写了历史，`origin/cli-desktop` 已分叉，推送必须是 `--force-with-lease`（分支规则禁止裸 `--force`）。未推送。
2. **38 个无标记原生文件的合规清扫**（见上，需用户定夺是否独立成任务）。
3. task21 第二步（门禁级样式修正）与 task22（未解析裸导入门禁）不受本次 rebase 影响，可继续。
