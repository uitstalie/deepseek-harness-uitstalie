# task21 — 分支自有 client 代码的样式合规专项

## requirement

用户判定（2026/09/30）：**样式问题作为独立专项任务处理**，不与当时正在进行的 task14（`.dsh` 存储插件）混在一起，两者不冲突、可各自推进。

专项范围来自一条已成文的常设规则（[AGENTS.md](../AGENTS.md) 最后一条 + [theme-overlay.md](../theme-overlay.md)）：**分支自有 client 代码一律优先共用模板**——组件用 `ui-primitives`（`Menu` / `Modal` / `Button` / `Tooltip` / `HoverCard` …），样式用 `ui-theme` 的 `--dsw-*` token，**不手搓**定位、层级、材质或自造色值。理由是用户计划实现 **theme 插件**（overlay 主题 config）与 **overlay 插件**（overlay 特定组件）：只有组件是共用件、样式走 token，overlay 才有稳定落点。

本任务单只做**更正**：把分支自有 client 代码**已经产生**的违规改回共用件与 token；不新增功能，不改交互语义。

## 已确认的违规（起点，非全部）

1. **`packages/uitstalie/ui-models-dev/src/client/ModelsDevSection.module.css`**：`ui-theme` 规格报 9 处中性 token 描边写成 `1px`（规格：中性实线为发丝线 `0.5px`），另有圆角/`corner-shape` 不配对。对应失败：`test:gui` 的 `elevation-styles`、`corner-shape-styles` 规格（"draws every solid neutral-token border at 0.5px under packages/"、"pairs corner-shape: round with every full-round border-radius under packages/"）。
2. **`packages/uitstalie/ui-models-dev/src/client/ProviderCard.tsx:42`**：JSX 里硬编码 `"OAuth"`（`verify-client-ui-i18n` 报 1 处 hard-coded UI string）——产品可见字符串必须出自 locale 字典。
3. **`menu-surfaces` 规格**（"requires shared material outside the schedule-owned menu and clock picker"）当前也红，需按同一份规格确认是哪个面在绕过 `Menu`/`MenuSurface`。

## 方法与判据

- 逐个分支自有 client 包（`packages/uitstalie/*`，后续新增包同步纳入）对照三组检查：
  1. `pnpm run test:gui` 中的 `ui-theme` 规格（描边宽度、圆角/`corner-shape`、菜单材质与容器）；
  2. `pnpm run verify-client-ui-i18n`（文案归属）；
  3. [theme-overlay.md](../theme-overlay.md) 的人工判据：**这个面是否由共用件渲染**。
- 修法优先级：**换成共用件** > 用 token 表达 > 最后才是保留自造样式但满足规格。凡遇到"某处共用件不够用"的情况，先记录，不要为了绕过而自造。
- 每个被修的包：同步更新其 README 中描述外观/交互的段落（双语文档三件套 + `--write` 重录配对）。

## 修改范围

- 分支自有：`packages/uitstalie/*/src/client/**` 的 CSS Modules 与组件、必要的 locale 字典、受影响的 README 三件套。
- 原生文件：**预期不需要**。若发现必须改原生（例如某个共用件缺少必要的 slot/prop），按分支规则先与用户约定、建立（或改用）带标记的最小插入，并在此登记。

## 验证

- `pnpm run test:gui` 全绿（当前 8 个失败中，3 个 `ui-theme` 规格属于本任务单；其余 4–5 个在 `connection` / `ui-deliverables` / `ui-sidebar-documentpreview` / `ui-sidebar-right`，与样式合规无关，需另行定性）。
- `pnpm run verify-client-ui-i18n` 全绿。
- 分支自有包聚焦测试与 `pnpm run build` 保持绿。

## 与其它任务单的关系

- 与 [task14](task14.md) 解耦：task14 的存储插件功能面与 UI 面均已完成并由用户目视确认，本任务单只处理样式合规，不回改其交互。
- 与 [task17](task17.md)（组合层迁移）、[task15](task15.md)（rules 检查层）互不阻塞，可任意先后。
