# 共用 UI 模板优先（为 theme / overlay 插件留落点）

## 规则（用户 2026/09/30 明确要求）

分支自有 client 代码**一律优先共用模板**：

- **组件**用 `@deepseek-ai/dsh-client-ui-primitives`：`Menu`（含摆放、portal、键盘走位、焦点回归、子菜单互斥）、`Modal`（surface 材质、Escape、焦点恢复）、`Button` / `Tooltip` / `HoverCard` / `MenuSurface` 等；
- **样式**用 `ui-theme` 的 `--dsw-*` token（特性组件用 `--dsw-alias-*` 语义 token），颜色与描边**不自造**；
- **不手搓**：固定定位与层级、菜单/面板材质、键盘与焦点管理、自造色值或"看起来差不多"的仿制品。

判据是"这个面是否由共用件渲染"：由共用件渲染的界面能被统一替换/覆盖；手搓出来的不行。

## 为什么要这样（用户计划）

用户计划实现两个插件：

1. **theme 插件**——对**主题 config**（token 层）做 overlay；
2. **overlay 插件**——对**特定组件**做 overlay。

两者的共同前提是：目标组件是**共用件**、样式来自 **token**。手搓的定位/材质/色值会把这两条路都堵死：

- overlay 组件时，手搓面板的层级、材质、焦点行为不受控，覆盖后行为会与 App 其它菜单/对话框不一致；
- overlay 主题时，自造色值与 1px 描边不响应 token 替换，主题一切换就露馅。

## 本分支的实例（含反面教材）

- **正面**：`ui-tool-dsh-store` 的 rules 按钮——初版手搓了 `MenuSurface` + `getBoundingClientRect` 固定定位 + 自造面板 CSS，表现为与其他列表菜单不一致并遮挡内容；现已改为**共用 `Menu`（规则列表）+ 共用 `Modal`（读规则）**，自身 CSS 只剩触发器标记与正文排版（无颜色、无描边、无定位）。
- **反面（待修）**：`ui-models-dev` 的 `ModelsDevSection.module.css` 违反 `ui-theme` 规格——中性 token 边框写成 `1px`（规格要求 `0.5px`，中性实线是发丝线）、圆角与 `corner-shape` 不配对。这正是"手搓样式绕开共用件/token"的直接后果，`test:gui` 会红。修它属于这条规则的落地，而不是额外工作。

## 检查手段

- `pnpm run test:gui` 内的 `ui-theme` 规格（`elevation-styles` / `corner-shape-styles` / `menu-surfaces`）会扫描 `packages/**` 的 CSS：中性 token 描边宽度、圆角与 `corner-shape` 配对、菜单/下拉必须由 `Menu` 渲染或包在 `MenuSurface` 里且不得覆盖材质 token；
- `pnpm run verify-client-ui-i18n` 管文案归属（所有产品可见字符串走 locale 字典）；
- `scripts/client-bundle-purity.spec.ts` 与 `verify-client-packages` 管模块图（共享件不得被私自复制）。
