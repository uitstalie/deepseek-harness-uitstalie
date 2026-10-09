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
