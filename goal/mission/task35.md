# task35 — task21 第四步：其余分支自有 client 包的样式归一（审计 + 收口门禁）

**变更自**：[task21](task21.md)（第四步"其余分支自有 client 包"；第三步已完成 `ui-models-dev`，见 [task29](task29.md) / [task31](task31.md)）。
**类型**：已有 mission 的变更（新任务单，新 id）。
**原生文件改动**：**无**（本任务是纯分支自有：一个新增规格文件 + 本文档）。

## requirement

用户（2026/10/12）："做 task21"（即任务单里留的第四步）——把**其余**分支自有 client 包的样式偏差改回共用件与 token。判据仍按 [task21](task21.md) 的"方法与判据"：`ui-theme` 规格、`verify-client-ui-i18n`、以及"这个面是否由共用件渲染"。

## 审计（全库、按类清点）

审计面：`packages/uitstalie/*/src/client/**` 的全部 `*.css`、`*.tsx`、`*.ts`（七个包）。

| 检查类 | 结果 | 证据 |
|---|---|---|
| `var(--dsw-*, #色值)` 字面色兜底 | **0 处** ✓ | ripgrep `var\(--dsw-[^,)]*,\s*#` |
| 半径字面量（CSS `border-radius: <px>`；TS/TSX 数值半径） | **0 处** ✓（唯一 `border-radius: 999px` 在 `ui-models-dev` 的 pill 上，已配 `corner-shape: round` ✓；另有 2 处 `50%` 同样配对 ✓） | ripgrep + `corner-shape` 配对检查 |
| `font-weight: 600+`（含 `font:` 简写里的重字重） | **0 处** ✓（task21 点名的 `ui-tool-dsh-store` 的 `.mark` 已在 [task33](task33.md) 随字母标记一并移除） | ripgrep |
| 裸 `#hex` / `rgba()` / `hsl()` / `monospace` | **0 处** ✓ | ripgrep |
| 中性 token 描边写成 `1px`（规格应为发丝线 `0.5px`） | **0 处** ✓（3 处均为 `border-top: 0.5px solid var(--dsw-alias-border-l2)`） | ripgrep |
| `font-size` 字面量 | 存在，但**不是偏差**：原生本身就用字面量——`ui-settings-general/SettingsRoot.module.css` 用 `14px`/`16px`，`ui-workspace/rows/Rows.module.css:224` 的时间单元用 `10px`（我们复刻侧栏的 `.time` 正是照它写的 `10px`/`line-height: 16px`） | 原生同位置比对 |

**结论：其余分支自有 client 包没有需要"改回"的违规** ✗⇒ 第四步不存在代码改动，只留下收口用的门禁（见下）。

## 改动：把三类偏差里没门禁的两类接进门禁（新增分支自有规格）

`ui-theme` 的既有规格已覆盖发丝线宽度、半径尺度、`corner-shape` 配对与菜单材质，且会扫到本分支的文件（本次实测 `packages/client/ui-theme` **19 文件 / 127 测试** ✓ 全绿）。**未被任何门禁覆盖**的是两类绝对规则：色值只能经 `--dsw-*` token 到达（含"token 里的字面兜底"）、字重不得高于 caption 档。因此新增：

- **新文件**：`packages/uitstalie/common-view/tests/branch-client-tokens.client.spec.ts`（分支自有，`@vitest-environment node`）
- **五条规则**（各自纯函数 + 失败时逐行报 `文件: 命中内容`）：① 色值字面量；② token 里的字面兜底；③ `font-weight` ≥ 600 / `font:` 简写里的重字重；④ `monospace` 字面量；⑤ 半径越界（非 `--dsw-radius-*`）与"全圆未配 `corner-shape: round`"。
- **自证必红**：同一文件里对每条规则喂一个反例并断言其命中、再喂一个合规样例断言其不命中（`rejects one invalid case per rule`）⇒ 规则失效时规格自己会红，而不是静静放行。
- 扫描面限制在 `<包>/src/client/**`（不递归整包），避免踩到 pnpm 注入的深层 `node_modules`。

**为什么放在 `common-view`**：它是本分支的视图/样式包，`tests/` 已是既有样式检查（CSS 规则读取辅助）的落点；规格读的是同分支兄弟包的源文件，属"分支级合规门禁"，不触碰原生。

## 未做（有意）

- **`common-view` 已提交但 park 的复刻切片**（task24 放弃）**未改动**：它们默认全关、不进产品路径，动它们只有 churn 没有收益；若将来从支线 `overlay-view-replica` 接回复刻，新规格会一并守着它们。
- 不改原生（本任务无需）。

## 验证

| 检查 | 结果 |
|---|---|
| 新规格单跑 | ✓ 1 文件 / **7 测试**（扫描面 + 5 规则 + 反例自证） |
| `vitest packages/uitstalie` | ✓ **20 文件 / 141 测试**（此前 19/132） |
| `packages/client/ui-theme` 规格 | ✓ 19 文件 / 127 测试 |
| `tsc -b tsconfig.client.json tsconfig.host.json` | ✓ |
| `oxlint`（`common-view` src+tests） | ✓ 0 / 0 |
| `verify-client-ui-i18n` | ✓ 1044 文件 |

## 与其它任务单的关系

- 续 [task21](task21.md) 第三步（`ui-models-dev`）与 [task29](task29.md)/[task31](task31.md)；第四步至此收口。
- 与 [task24](task24.md)（已 park）无耦合：本次不动其切片。
