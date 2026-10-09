# task21 — 分支自有 client 代码的样式合规专项

## 阶段划分（用户要求分步走）

1. **第一步：原生 Web UI 样式体系盘点（已交付）** → [ui-style-inventory.md](../ui-style-inventory.md)。只做统计与出处，不做修改；结论见该报告 §A–§G。
2. **第二步（用户要求先做调研）：overlay 可行性（已交付）** → [overlay-feasibility.md](../overlay-feasibility.md)。逐条验证四类场景（覆盖组件属性 / 覆盖组件布局 / 新增自定义布局 / 组件替换）的机制、证据与缺口。**要点**：组件替换由 slot **shadowing** 支撑——同 cell 不同 `priority`、升序后**最低的活跃项渲染**（`ui-slots/src/index.ts:1278–1284`；同格同优先级才抛错），**无需原生改动**；属性/布局覆盖靠主题 token 与**组件局部自定义属性**（实测 70 个原生 CSS Module、319 条，可继承可覆盖）；而 **React props 无外部通道**、**类名是构建哈希**，两者都不能当 overlay 通道；组合层只能"insert 自己的行 + `disabled` 原生行"（patch 不能改 `name`）。
3. **第三步：门禁级修正**——修 `ui-models-dev` 的 **11 项门禁级问题**（9 处中性描边 `1px → 0.5px`、`.badge` 补 `corner-shape: round`、`ProviderCard` 的 `"OAuth"` 入字典），目标：`elevation-styles` / `corner-shape-styles` / `verify-client-ui-i18n` 三条全绿。做法照 [ui-style-inventory.md](../ui-style-inventory.md) §F.4 的原生同类正解（`ui-settings-models/…/ModelsSection.module.css` 的 `.rowCard` 与 `.credentialDot`）。
4. **第四步：评审级 + 技能级修正**——半径字面量换 token（`12px → --dsw-radius-md`、`8px → --dsw-radius-sm`）、去掉字面色兜底、`font-weight: 600 → ≤500`（含 `ui-tool-dsh-store` 的 `.mark`）。
5. **第五步（待用户定）：把盲区补成门禁**——报告 §F.2 的三条盲区（半径门禁不含 `packages/uitstalie/**`、`test:gui` 不跑我们的测试、字面色无门禁）若要修，属于**原生门禁改动**，按分支规则需最小插入 + `uitstalie-` 标记 + 逐处登记，或另立任务单。

每步的验证固定为：对应门禁原始输出 + 受影响包的聚焦测试 + `pnpm run build`。

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
- 与 [task17](task17.md)（组合层迁移）、[task22](task22.md)（构建门禁）互不阻塞，可任意先后。
