# task32 — rules 的 R 按钮按共用件对齐邻居按钮

**变更自**：[task14](task14.md)（侧边栏 rules 按钮：占用 ui-workspace 的工作区行 seat）。
**类型**：已有 mission 的变更（新任务单，新 id）。
**分支自有文件改动**：本任务**不触碰任何原生文件**（无标记需求）。

## 需求

用户："那个 rules 的 R [按钮] 跟边上的按钮一样，按照共用件做"。

## 现状与偏差

`ui-tool-dsh-store` 的 `RulesButton` **本来就用共用件**（`Button`/`Menu`/`Modal`/`Tooltip`），偏差在**形态**：触发器是共用件 `Button size="sm"`（**28px、8px 圆角**）+ 文字字形 `R`（`font-weight: 600`），而它旁边（工作区行动作条里）的按钮是原生 `.iconButton` 那套：**16×16、`padding: 0`、`border-radius: var(--dsw-radius-xs)`、tertiary 墨、hover → label-primary**（`ui-workspace/rows/Rows.module.css`）⇒ 同一行里两种控件体量不一致。

另有一处手搓：规则正文用 `<pre className={css.ruleText}>`（自带 `max-height: 360px` + `overflow: auto` 的页内滚动）✗ 与"共用件优先"不符。

## 改动（全部分支自有文件）

| 文件 | 改动 |
|---|---|
| `src/client/RulesButton.module.css` | `.trigger` → **`.trigger.trigger`**（双类提升优先级，压过共用件 `size` 变体）：**16×16、`padding: 0`、无边框、`radius-xs`、透明底、`label-tertiary`**；`:hover` → `label-primary` 且底色保持透明（与原生 `.iconButton` 一致）。`.mark`：**`font: var(--dsw-font-xxs-12)` + weight 500**（原来 600，违反分支"字重 ≤500"）。删掉 `.ruleText`，改为 `.notice`（`label-secondary`）与 `.noticeAlert`（`state-error-primary`） |
| `src/client/RulesButton.tsx` | 弹窗正文：**规则文本走共用件 `CodeBlock`**（自带表面、滚动与复制按钮），空/加载/失败仍为纯文案；`RuleModal.alert: boolean` 改为 **`kind: 'rule' \| 'notice' \| 'alert'`**（数据说清语义，`role="alert"` 只在 alert 出现） |
| `src/client/locales.ts` | 新增 `copy` / `copied`（中英），供 `CodeBlock` 的复制按钮使用 |
| `tests/rules-button.client.spec.tsx` | 新增 2 例：①规则正文经共用 CodeBlock（`<pre>` 存在）而空列表只是文案（无 `<pre>`）；②CSS 钉子——`.trigger.trigger` 的 16×16/radius-xs/tertiary、hover 的 label-primary、`.mark` 的 12px 与 500 字重、`.noticeAlert` 的错误墨，且样式表里不再有 `.ruleText` |

## 验证

`vitest packages/uitstalie/ui-tool-dsh-store`（**8 测试**，此前 6）· `tsc -b` 两面 · `oxlint`（0）· `verify-client-ui-i18n` · `pnpm run build`（363 client artifact；本包 `lib/client.js` 144KB，已无 `ruleText` 类）· 3081 复看。

## 备注

- 工作区行 seat 的插入位置仍是 task14 的原生最小插入（本任务未动原生）。
- 若希望 R 标记换成真正的图标（而不是字母），需要设计师给字形——现按用户要求保留字母 `R`。
