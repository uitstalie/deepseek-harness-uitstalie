# task38 — task25 剩余项核实（已完成）+ task27 图标补齐

**变更自**：[task25](task25.md) 待办 3（38 个无标记原生文件的合规清扫）与 [task27](task27.md) 的"未做：图标"。
**类型**：已有 mission 的变更（新任务单，新 id）。
**原生文件改动**：**无**（A 段只核实既有事实；B 段全部在分支自有的 7 个包内）。

## A. task25 待办 3：核实为**已完成**（由 [task26](task26.md) 办掉），本次无改动

task25/task23 列的那"38 个有分支改动但没有 `uitstalie-` 标记的原生文件"，已在 [task26](task26.md) 处理完：20 个能内嵌注释的补了标记、14 个生成物 + 4 个 JSON 改为逐处登记；`git grep -l "uitstalie-"` 当时从 58 → **78**。

本次复核（口径＝任务单自身的判定标准，不再用会漂移的远端基座）：

| 检查 | 结果 |
|---|---|
| `git grep -l "uitstalie-"` 文件数 | **85**（= task26 的 78 + 此后新增的 7 个已标记文件） |
| 此后新增的 7 个已标记文件 | `bundle/base/cordis.patch.yml`、`sandbox/sandbox-local/src/index.ts`、`sandbox/sandbox-local/tests/local.spec.ts`、`sandbox/sandbox-windows-acl/README.md` + `.zh.md`、`sandbox/sandbox-windows-acl/tests/provider-chain.spec.ts`、`sandbox/sandbox/src/diagnostics.ts`——**逐一在册** ✓ |
| 最近 14 个提交里其余改动的原生文件 | 3 个，均为**不可内嵌注释的生成物/清单**（`pnpm-lock.yaml`、`bundle/base/package.json`、`sandbox-windows-acl/README.i18n.yaml`），已分别在 task26/task33/task34 的任务单里逐处登记 ✓ |

⇒ **无未标记的原生改动** ✓，标记纪律保持 ✓。本次仅在 task25 与 task23 的待办行标注"已办"，不触碰任何原生文件。

## B. task27 图标：7 个包各补 `icon.svg`（用户选定"7 个元信息包全补"）

### 机制（按真实解析器实测，非推测）

- [`readPluginMeta(specifier, parentURL)`](../../packages/boot/app-boot/src/package-meta.ts#L175)：**bare specifier** 读 `<pkg>/package.json` 的 `icon`（相对包内路径，须落在包目录内）；任何 specifier 都还可以走 `<specifier>/icon` **导出**。只收 SVG/PNG/JPEG/WebP、≤256 KiB。
- 消费方：`packages/client/ui-plugin-manager` 的 `PluginManagerPage` 用 `PackageArtwork src={pkg.meta?.icon}` 渲染 ⇒ 图标会真的显示在插件清单与行里。
- 组合里我们的 client 行用的是**裸名**（`name: '@deepseek-ai/dsh-client-ui-models-dev'` 等）⇒ 裸名路径已足够；`"./icon"` 导出是为**子路径挂载**留的入口（原生同样做法），一并加上。

### 改动（全部分支自有，7 个包 × 4 处）

| 文件 | 改动 |
|---|---|
| `<pkg>/icon.svg`（7 个新文件） | 自绘 36×36 线性几何 mark，沿用原生模板的配色族（蓝 `#7CB7FF`、琥珀 `#F2AF63`、青 `#45D9E7`），**不使用任何第三方字形路径**（避免许可/notice 负担） |
| `<pkg>/package.json`（7 个，各 +3 行） | 顶层 `"icon": "./icon.svg"`；`exports` 增 `"./icon": "./icon.svg"`；`files` 增 `"icon.svg"` |

七个 mark 的语义（一眼能对上包）：

| 包 | 图形 |
|---|---|
| `llm-plus` | 左侧一个请求块经分叉线连到右侧三个提供商块（路由） |
| `models-dev` | 三条目录带 + 向下箭头（拉取并缓存目录） |
| `agent-instructions-plus` | 两张叠放的文稿（原生链 + `.dsh/rules` 常开） + 三条规则线 |
| `tool-dsh-store` | 文件夹内一份带条文线的文件（`.dsh` 内的存取） |
| `ui-models-dev` | 设置页窗口 + 四个可勾选块，其中一格选中（浏览并物化路由） |
| `ui-tool-dsh-store` | 面板 + 勾选行 + 两条规则线（工作区规则清单，与侧栏 R 的 checklist 同族） |
| `common-view` | 前后两块叠放（overlay 覆在原生 view 之上） |

### 验证

| 检查 | 结果 |
|---|---|
| `scripts/verify-package-meta.ts` | ✓ 通过（导出解析到源码 JSON、`files` 覆盖、字段合法） |
| 真实解析器探针（`readPluginMeta`，用后即删） | ✓ **7 个包 title 与 icon 全部解析成功**、`error: undefined`；宿主侧 4 个从 `bundle/base`/`bundle/web-app`(+presets) 基座解析，client 3 个按组合里的**裸名**解析 |
| `verify-package-dependencies.ts` | ✓ 77 包 |
| `verify-client-packages.ts` | ✓ 63 client 包 |
| manifest 改动面 | ✓ 每包恰好 **+3 行**（无重排、无其它键改动） |

### 备注

- 图标为分支自绘，未引入外部字体/图标库 ⇒ 不触发 third-party notices 变更。
- 观感复核入口：重启 Web GUI 后看「设置 → 插件」清单与插件行；要换某个 mark 的形态或配色，点名即可（改动只在对应 `icon.svg`）。
