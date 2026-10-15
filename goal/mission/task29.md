# task29 — models.dev 设置页按设置页家规适配

**变更自**：[task17](task17.md)（models.dev 目录服务与设置页），关联 [task12](task12.md)/[task14](task14.md)/[task16](task16.md) 中 models.dev 相关部分。
**类型**：已有 mission 的变更（新任务单，新 id）。
**分支自有文件改动**：本任务**不触碰任何原生文件**（无标记需求）。

## 需求

用户反馈"models.dev 插件设置页貌似有点问题"，确认页面能打开后要求**按设置页家规做适配**。

## 诊断结论（2026/10/12）

1. 先排除的：注册形状与原生逐字一致（`name:'settings.section'` + `id:'models-dev'` + `order:12` + `label: () => t('nav')` + `inject`）；文案键中英齐全；壳子渲染路径正常（`ui-settings-general` 的 `SettingsRoot.tsx:99` 用 `renderSlot('settings.section', {close}, {only: active})`，导航行由 `ctx.slots.entries('settings.section')` 按 `order` 投影）。**这些都不是原因。**
2. 真问题之一（环境）：用户当时看的是 **3080（sibling 上游 checkout）**，那份 `packages/uitstalie/` 为空、成分零引用，**永远不会有本插件**。
3. 真问题之二（构建）：一次"成功"的构建其实被 `Select-Object -First N` 提前掐断上游管道，**全仓库 `lib/client.js` 未产出**；完整重跑后 363 个 client artifact 齐全。

## 与家规的偏差（本次修复）

| # | 偏差 | 原生家规 | 修复 |
|---|---|---|---|
| 1 | 页面只有 secondary 墨的 `.subtitle`，**无主标题** | 每个 section 以 `.title`（**16/24、weight 500、label-primary**）+ `.intro`（**14/22、label-tertiary**）开头（`ui-settings-models/ModelsSection.module.css`、`ui-agent-preset/AgentPresetSection.module.css`） | 加 `.title`/`.intro`，删 `.subtitle`；字典加 `title`、`intro`（原 `subtitle` 文案转作 intro） |
| 2 | `.section` `max-width: 760px` | Models 兄弟页 **720px**（760 是 Plugins 页的宽度） | 改 720px |
| 3 | 字面半径 `12px`/`8px` | 走 `--dsw-radius-*`（`md`=12、`sm`=8） | 换 token；`999px` pill 保留并配 `corner-shape: round` |
| 4 | `.list { max-height: 60vh; overflow-y: auto }` 页内嵌套滚动 | 设置面板内容列 `.options` 自身 `overflow-y: auto`（`SettingsRoot.module.css:228`），section 只需生长 | 去掉外层内滚动；`.modelList` 这类**有界小列表**保留滚动但高度改 **320px**（与原生同类列表一致） |
| 5 | **三个 token 不存在**导致静默回退到字面色：`--dsw-alias-state-error-label`(→#d04437)、`--dsw-alias-state-success-label`(→#2e9e5b)、`--dsw-alias-label-link`(→#3a6fd8) | 用真实存在的 `--dsw-alias-state-error-primary` / `--dsw-alias-state-success-primary` / `--dsw-alias-state-business-primary` | 换 token 并**删掉字面 fallback** |
| 6 | `font-weight: 600`（`.rowTitle`、`.deviceCode`） | 分支规则：feature CSS 字重 **≤ 500** | 改 500 |
| 7 | `font-size` 字面（12/11px）、`font-family: monospace` | 12px 走 `--dsw-font-xxs-12` 简写；等宽走 `--ds-font-family-code` | 换 token（section 标题的 16/24 与原生同样用字面值，保持） |

## 验证

`vitest`（本包规格，含家规钉子）· `tsc -b` 两面 · `oxlint` · `verify-client-ui-i18n` · `pnpm run build` · 预览 3081 复看。

## 顺带修掉的 lint（同文件，先前就存在）

`ModelsDevSection.tsx` 原本有 **7 处 oxlint 报错**（6× `no-confusing-void-expression` + 1× `no-unnecessary-condition`），因本任务改到该文件、pre-commit 的 staged lint 会拦，故一并修正：把 `void` 调用的箭头简写改成块体（单参块体按仓库风格补括号），并删掉 `state.myRoutes &&` 这个死分支（`MyRoutesState` 非可选，类型上恒真）。修正后该文件 0 error。

## 未做（后续）

- 页内仍是裸 `<button>`（`.submitButton` 等），未换共用件 `Button`/`DefaultButton`——换了会改变观感与尺寸，单独一片做。
- 列表行的视觉（`rowCard` 等）未按原生卡片规格重做，仅做本次的 token/家规对齐。
- **本包仍有 25 处先前存在的 oxlint 债**，位于本次未触碰的文件：`DraftForm.tsx` 12、`store.ts` 5、`OAuthPanel.tsx` 4、`index.ts` 2、`MyRoutes.tsx` 1、`ProviderCard.tsx` 1（类型为 `no-confusing-void-expression` / `no-floating-promises` / `no-unnecessary-condition`）。它们会拦住今后对相应文件的提交，建议下一次动这个包时先清掉。
