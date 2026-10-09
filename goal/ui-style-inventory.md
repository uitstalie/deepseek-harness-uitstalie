# 原生 Web UI 式样体系：统计与清单（task21 第一步）

## 一页速览

| 维度 | 数量 | 出处 |
|---|---|---|
| 权威规范文档 | **2 份**（`docs/web-styling.md` 归属 + 14 条组件规则；`docs/ui-radius.md` 半径标准与嵌套几何） | §A、§B |
| token 承载文件 | **9 个**（`ui-theme/src/styles/`） | §D.1 |
| 自定义属性唯一名 | **427**（`--dsw-` **403** + `--shiki-` 11 + `--dsh-` 8 + `--ds-` 5） | §D.1 |
| `--dsw-*` 家族 | font 182 / alias 107 / static 77 / specific 11 / radius 6 / elevation 5 / shadow 4 / 其余 9 | §D.2 |
| token 引用 | **3,177 处 `var()` / 219 个名字** | §D.3 |
| 共用组件（`ui-primitives` 具名导出） | **22 个非图标导出**（10 控件 + 4 行/工具 + 8 面）+ **188 个图标导出** | §E |
| 原生**不提供**、特性必须自写的控件类别 | **6 类**（卡片/面板、`Textarea`/`Select`/`Radio`/`NumberInput`、通用列表行、空状态、骨架屏/独立 spinner、表格） | §E |
| 样式门禁规格 | **8 个文件扫描型**（elevation / corner-shape / radius / menu-surfaces / focus-ring / scrollbar / app-region / client-styles）+ 品牌字体与若干行为规格 | §F.1 |
| 文案门禁 | **1 个**（`scripts/verify-client-ui-i18n.ts`，覆盖我们的树） | §F.1 |
| 强制边界（门禁盲区） | **3 条**（半径门禁不含 `packages/uitstalie/**`；`test:gui` 不跑我们的测试；字面色与"只用 alias"无门禁） | §F.2 |
| 我们分支自己的问题 | **21 项**：门禁级 **11** / 评审级 **7** / 技能级 **3** | §G |

## 这份报告要回答什么

用户要求（task21 分步走，第一步）：**先查清原生到底包装了哪些基础 Web UI 式样**，梳理成统计报告，再据此决定我们分支自有 client 代码该复用什么、该修什么。

因此本文只做**盘点与统计**（事实 + 数字 + 出处），不做修改建议的裁决；修改方案见 task21 的后续步骤。

## 方法

- 权威文本：[docs/web-styling.md](../../docs/web-styling.md)（样式归属 + 组件规则）、[docs/ui-radius.md](../../docs/ui-radius.md)（统一圆角标准）、[packages/client/AGENTS.md](../../packages/client/AGENTS.md)（client 栈规则）。
- 代码盘点：`packages/client/ui-theme/`（token 与全局样式）、`packages/client/ui-primitives/`（共用组件）、`packages/client/ui-theme/tests/` 与 `scripts/verify-*`（强制手段）。
- 分支基线：直接跑三条 `ui-theme` 规格 + 客户端 i18n 门禁，取原始输出（数字为实测，非估算）。

## A. 原生的两层归属模型（权威文档原文摘要）

`docs/web-styling.md` 规定的是**归属**，不是"给一套组件库"：

- [`ui-theme`](../../packages/client/ui-theme/README.md) 拥有 `--dsw-*` 静态尺度、语义别名、排版、动效、渐变、阴影、滚动条样式与明暗偏好；[`ui-layout`](../../packages/client/ui-layout/README.md) 把解析后的主题快照应用到 document；**特性包消费语义别名，不得另造全局主题**。
- 全局样式表只放 `ui-theme/src/styles/`；**组件样式与组件同目录的 CSS Modules**；组件可以定义**局部**自定义属性（当其值属于该组件的布局/呈现契约），但共享的颜色、排版、高度、动效属于主题包。
- 组件规则共 14 条，按主题归类（原文 `#component-rules`）：
  1. **先复用再改造**：跨特性包的唯一通道是 [ui-primitives 组件目录](../../packages/client/ui-primitives/README.md#component-catalog)；有意为之的视觉差异应成为那里的一个 prop，而不是第二份实现；
  2. 用 CSS Modules + `clsx`；**不加组件库、不用 Tailwind**；
  3. 特性组件用 `--dsw-alias-*` 语义 token；**不拷贝静态调色值、不写字面色**；
  4. 主题选择器不进特性组件 CSS（明暗覆盖属于主题所有者）；
  5. 字号与行高成对，能匹配既有角色时用主题排版变量；
  6. 需要保列的内容（源码、终端输出、diff）不换行；用共享滚动条样式而非组件私有滚动条选择器；
  7. 表现放 CSS；内联 React 样式**只允许**传组件局部自定义属性值，不得编码主题分支；
  8. 新增过渡/仅悬停控件时必须保留键盘焦点可见性与 reduced-motion 行为；
  9. 圆角继承 `ui-theme` 的 `corner-shape.css` 超椭圆平滑；**每个满圆 `border-radius`（`50%`/`100%`/pill）必须同规则配 `corner-shape: round`**（角形状规格强制）；
  10. 浮起面（菜单、popover、模态、面板、浮动按钮、composer）用 `border: 0` + `--dsw-elevation-*`；**不得把 `--dsw-alias-border-*` 与 lv/elevation 阴影配对**（高度规格强制）；
  11. 下拉/上下文/子菜单/选择菜单**必须用 `Menu` 或把自定义内容包进 `MenuSurface`**；材质是主题持有的 `--dsw-menu-surface-fill` + `--dsw-menu-backdrop-filter`，特性 CSS **不得覆盖**（菜单规格强制，`ui-schedule` 的 `TaskMenu`/`ClockPicker` 为显式例外）；
  12. 模态遮罩保持半透明深色、无模糊（`--dsw-mask-blur: none`）；
  13. 菜单背景滤色留在隔离层；macOS 上 `MenuSurface` 追加不透明 backing；
  14. 中性 `--dsw-alias-border-*` 实线**画 0.5px 发丝线**（按钮、输入、卡片、行分隔、分隔块共享该权重）；虚线/状态色描边保持 1px；spinner 环宽按白名单（高度规格强制）。

## B. 原生确实包装了「尺度 + 材质 + 几何」标准（`docs/ui-radius.md`）

不是只有 token，还有**按角色选值**的规范表与配套守卫：

| 角色 | 典型尺寸/例子 | 半径 | 共享 token |
|---|---|---|---|
| 小细节 | H<20；键帽、行内代码、极小控件 | R4 | `--dsw-radius-xs` |
| 紧凑控件 | H20–28；小按钮、紧凑图标按钮、紧凑菜单项 | R8 | `--dsw-radius-sm` |
| 标准控件/单行单元格 | H32–40；按钮、输入、选择器、导航行 | R12 | `--dsw-radius-md` |
| 大控件/成组内容 | 大按钮、刻意多行单元格、嵌套表单组 | R16 | `--dsw-radius-lg` |
| 独立内容卡 | 设置卡、消息气泡、引导入口卡 | R20 | `--dsw-radius-xl` |
| 主包封面 | composer、对话框、主/浮动面板 | R28 | `--dsw-radius-panel` |

另有：嵌套同心公式 `内 R = max(0, 外 R − inset)`；三态嵌套（同心内嵌 / 贴边填充 / 独立子卡）；标准菜单 外 R16 + 4px padding + 项 R12，紧凑菜单 外 R12 + 4px + 项 R8；设置卡材质（`--dsw-radius-xl` + `0.5px` 描边 + `--dsw-alias-settings-card-fill`）；离标字面量（10/14/18/24px）被半径守卫拒绝，例外用 `packages/client/ui-theme/tests/expected/radius-exceptions.expected.json` **逐文件逐选择器**钉住。

## C. 分支自有 client 代码的当前违规基线（实测原始输出）

跑 `packages/client/ui-theme/tests/{elevation-styles,corner-shape-styles,menu-surfaces}.client.spec.ts` + `scripts/verify-client-ui-i18n.ts` 的结果：

| 门禁 | 结果 | 命中 |
|---|---|---|
| `menu-surfaces`（菜单材质/容器） | **通过** | —（见下方更正） |
| `elevation-styles`（0.5px 发丝线等） | 失败 | **9 处**，全部在 `packages/uitstalie/ui-models-dev/src/client/ModelsDevSection.module.css` |
| `corner-shape-styles`（满圆配 `corner-shape`） | 失败 | **1 处**，同上文件 `.badge` |
| `verify-client-ui-i18n`（文案归属） | 失败 | **1 处**：`ui-models-dev/src/client/ProviderCard.tsx:42` 硬编码 `"OAuth"` |

`elevation-styles` 的 9 处（原文，选择器 + 声明）：

```
.rowCard      border: 1px solid var(--dsw-alias-border-l2)
.badge        border: 1px solid var(--dsw-alias-border-l2)
.draftForm    border-top: 1px solid var(--dsw-alias-border-l2)
.input        border: 1px solid var(--dsw-alias-border-l2)
.textarea     border: 1px solid var(--dsw-alias-border-l2)
.modelList    border: 1px solid var(--dsw-alias-border-l2)
.submitButton border: 1px solid var(--dsw-alias-border-l2)
.oauthPanel   border: 1px solid var(--dsw-alias-border-l2)
.attemptArea  border-top: 1px solid var(--dsw-alias-border-l2)
```

`corner-shape-styles` 的 1 处：`ModelsDevSection.module.css .badge`（满圆半径缺 `corner-shape: round`）。

**更正一处我先前给用户的判断**：早先 `pnpm run test:gui` 的三个 `ui-theme` 失败里，我把 `menu-surfaces` 也算成"`ui-models-dev` 的既有问题"——**错了**。该规格在本次实测中**通过**，它当初变红是因为 task14 初版那个**手搓的固定定位面板**（现已被共用 `Menu` + `Modal` 替换）；其余两条（`elevation-styles`、`corner-shape-styles`）才是 `ui-models-dev` 的既有违规。

## E. 共用组件层盘点（`ui-primitives`）

**规则先说清**：跨特性包的**唯一**共用通道是 [`ui-primitives` 目录](../../packages/client/ui-primitives/README.md#component-catalog)。`packages/client/AGENTS.md`：「插件不得 runtime-import 或 re-export 另一个特性插件的值」（L37），「插件不能 import 另一个插件的组件，所以 `ui-primitives` 是控件唯一可共享的地方」（L151）。

**已提供（可复用，共 22 个非图标导出 + 188 个图标）**：`Button`、`Input`、`Checkbox`、`Switch`、`SegmentedControl`、`SegmentedTabs`、`Tag`（只读胶囊，8 种色调）、`Pill`（可选中胶囊）、`SettingsValueField`、`SettingsSecretField`（10 个控件）；`DisclosureRow`、`PathLabel`、`StateDot`（含 14px 旋转 loader 的 `ongoing`）、`TextShimmer`（4 个行/工具）；`SettingsForm`、`Menu`、`MenuSurface`、`Modal`、`Tooltip`、`HoverCard`、`Toast`、`ConnectionIndicator`（8 个面）。图标集在 `ui-primitives/src/icons/index.tsx`，**188 个 `Icon*` 导出**（`Regular` 为 1px 描边、`Medium` 为 1.3px，`size` prop 控制渲染尺寸；新增字形需要设计审批）。

**原生明确不给（特性必须自己写）**：

| 特性常见需求 | ui-primitives 是否提供 |
|---|---|
| 面板 / 卡片（`Card`/`Panel`） | **没有**。README 原文：卡片属于特性包（`ui-settings-plugins` 的 `PluginCard` 是先例） |
| 表单控件 `Textarea` / `Select` / `Radio` / `NumberInput` | **没有** |
| 通用列表行 / 表格行 | **没有** |
| 空状态 | **没有**（最接近的是 `ConnectionIndicator`） |
| 骨架屏 / 独立 spinner | **没有**（只有 `StateDot` 与 `TextShimmer`） |
| 表格 | **没有** |

**因此"特性包自己写组件"是被允许的**——README 原文：*"Writing your own component in your own package is fine when the need is genuinely specific. What is not fine is copying a control that already exists here."*；当**第二个包**需要同一控件时再提升进 `ui-primitives`。

## F. 强制手段清单与"允许 vs 禁止"边界

### F.1 门禁一览（全部在 `pnpm run test:gui` = `vitest run packages/client packages/host` 内）

| 规格（`packages/client/ui-theme/tests/`） | 扫什么 | 拒绝什么 |
|---|---|---|
| `elevation-styles.client.spec.ts` | **`packages/` 下每个 `.css`** | 中性 `--dsw-alias-border-*` 实线 ≠ `0.5px`；1px 填充分隔线；`box-shadow: var(--dsw-shadow-lv*/elevation-*)` 配中性描边；菜单填充无配套 `backdrop-filter` |
| `corner-shape-styles.client.spec.ts` | 同上 | 满圆 `border-radius`（`50%`/`100%`/`≥99px`）缺 `corner-shape: round` |
| `radius-styles.client.spec.ts` | `packages/client/*/src/`（**排除 `src/styles/`**） | px 字面量 `>4 && <99`、未知 `--dsw-radius-*`；例外钉在 `tests/expected/radius-exceptions.expected.json` |
| `menu-surfaces.client.spec.ts` | **`packages/*/*/src/` 下每个 `.tsx`（TS AST 解析）** | `role="menu"/"listbox"` 不在 `MenuSurface` 内；被当作 `MenuSurface className` 的类上出现 `background/backdrop-filter/anchor-name`；在主题表之外重定义 `--dsw-specific-menu`/`--dsw-menu-surface-fill`/`--dsw-menu-backdrop-filter` |
| `focus-ring-styles.client.spec.ts` | `packages/client/` 的 `.css` | `:focus` 规则里的 `outline`/`outline-color`/`box-shadow` 用了白名单外的值；`:focus-visible` 绕过指针抑制间接层 |
| `scrollbar-styles.client.spec.ts` | 局部样式表 + `design-platform.css`/`scrollbar.css` | 定义未消费 / 消费未定义的 `--dsw-alias-scrollbar-*`；不完整的 thumb/hover 配对；离契约的几何变量 |
| `app-region-styles.client.spec.ts` | CSS + TSX | `-webkit-app-region: drag` 只允许出现在两处；`CHROME_ROWS` 把每行 chrome 的样式表、选择器、标记、高度、内缩钉死 |
| `client-styles.client.spec.ts` / `brand-font` / 若干行为规格 | 全局表挂载顺序、品牌字体与许可、主题运行时 | — |
| `scripts/verify-client-ui-i18n.ts` | `packages/*/*/src/client/**`（**覆盖 `packages/uitstalie/**`**）+ `apps/web`、`apps/desktop` | JSX 文本、`aria-label`/`title`/`placeholder`/`*Label` 等属性字面量、默认值与返回字面量；发现面有 `MINIMUM_CLIENT_UI_SOURCES = 450` 下限守卫 |

### F.2 三条**强制边界**（本次盘点发现，直接影响 task21 的做法）

1. **半径门禁看不见我们的包**：`radius-styles.client.spec.ts` 的扫描条件是 `file.includes('/packages/client/')` → `packages/uitstalie/**` 的半径字面量**不在守卫范围内**（而 elevation / corner-shape / i18n 三条**覆盖**我们的树）。因此我们的离标半径只能靠**人**发现。
2. **`test:gui` 不跑我们的测试**：`test:gui = vitest run packages/client packages/host`，所以 `packages/uitstalie/**/tests/*.spec.tsx`（例如 `ui-tool-dsh-store/tests/rules-button.client.spec.tsx`）**不在 GUI 内循环里**，只在完整 `pnpm run test` 下运行。这也解释了为什么我们那 6 个组件测试全绿却与 `test:gui` 无关。
3. **两条文档规则无人守**：`web-styling.md` 的「不写字面色」与「特性组件只用 `--dsw-alias-*`」**没有任何门禁**（全仓库 grep 确认只有评审把关；`scripts/gen-client-catalog.ts:93` 只是在生成的提示文本里劝一句）。反证：`ui-primitives/src/HoverCard.module.css:10` 自己就写了字面色 `#2C2C2E`，`--dsw-static-*` 在主题包外被 11 个文件引用 33 次——都通过了当前所有门禁。

### F.3 允许 vs 禁止（结论）

- **允许且是正解**：特性包用 **CSS Modules + `--dsw-alias-*` 语义 token**（`web-styling.md:11,18`；`client/AGENTS.md:113`）；**自己写**原生没有的控件（`ui-primitives/README.md:83`）。
- **禁止**：拷贝 `ui-primitives` 已有的控件；写死颜色；中性 token 描边写 `1px`；满圆不配 `corner-shape`；菜单不用 `Menu`/`MenuSurface` 或改菜单材质；特性 CSS 里放主题选择器；硬编码产品文案。
- **技能层附加（`dsh-client-ui-ux`，非门禁但强制于评审）**：特性 CSS **`font-weight` 上限 500**；仅图标且含义不直观的动作**必须给 Tooltip**；颜色必须在**明暗两主题**下可读；浮层必须**可关闭 / 视口内 / 不被裁剪**；列表用骨架屏、页面级加载居中 spinner；图标只能用**既有图标库**。

### F.4 与 task21 直接相关的两条对照

- **反例（我们的包）**：`ui-models-dev/src/client/ModelsDevSection.module.css` 的 `.rowCard` 用 `1px solid var(--dsw-alias-border-l2)` + `border-radius: 12px` 字面量。
- **原生同类正解（照着改即可）**：`packages/client/ui-settings-models/src/client/ModelsSection.module.css:54` 的 `.rowCard`：

  ```css
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  background: var(--dsw-alias-settings-card-fill);
  border-radius: var(--dsw-radius-xl);
  ```

  同文件 `.credentialDot` 用 `border-radius: 50%; corner-shape: round;`——正是我们 `.badge` 缺的那半。

## G. 分支自有包的完整问题清单（三层规则对照）

以下为**实测**（grep 上述两个包的 `*.module.css` + 三条门禁原始输出），按规则的强制层级分组：

### G.1 门禁级（跑门禁会红，必须修）

| # | 文件:行 | 现状 | 规则 |
|---|---|---|---|
| 1–9 | `ui-models-dev/…/ModelsDevSection.module.css` `.rowCard` `.badge` `.draftForm` `.input` `.textarea` `.modelList` `.submitButton` `.oauthPanel` `.attemptArea` | `border: 1px solid var(--dsw-alias-border-l2)`（其中两处是 `border-top`） | 中性 token 描边必须 `0.5px`（`web-styling.md:29`，`elevation-styles` 拒绝） |
| 10 | 同上 `.badge:58` | `border-radius: 999px` 无 `corner-shape: round` | 满圆必须配对（`web-styling.md:24`，`corner-shape-styles` 拒绝） |
| 11 | `ui-models-dev/…/ProviderCard.tsx:42` | JSX 文本 `"OAuth"` | 产品文案必须走 locale 字典（`client/AGENTS.md:117`，`verify-client-ui-i18n` 拒绝） |

### G.2 评审级（无门禁，靠人/规则把关）

| # | 文件:行 | 现状 | 规则 |
|---|---|---|---|
| 12–15 | `ModelsDevSection.module.css:27,162`（`12px`）、`:85,93,114,131`（`8px`） | px 字面量半径 | 用 `--dsw-radius-md` / `--dsw-radius-sm`（`ui-radius.md:50`）；**半径门禁扫不到我们的树**（F.2-1），所以只能人工修 |
| 16–18 | 同上 `:148,152,186` | `var(--dsw-alias-state-error-label, #d04437)` 等**字面色兜底** | 「不写字面色」（`web-styling.md:18`，全仓无门禁）；兜底还会掩盖 token 缺失 |

### G.3 技能级（`dsh-client-ui-ux`，评审标准）

| # | 文件:行 | 现状 | 规则 |
|---|---|---|---|
| 19–21 | `ModelsDevSection.module.css:42,193`、`ui-tool-dsh-store/…/RulesButton.module.css:8` | `font-weight: 600` ×3 | 特性 CSS 字重**上限 500**；强调靠字号或墨色 |

### G.4 已经符合的部分（避免过度修改）

- `ui-tool-dsh-store` 除 `font-weight: 600` 外**无门禁级问题**：无字面色、无 px 半径字面量、菜单与对话框走共用 `Menu`/`Modal`、仅图标动作带 Tooltip、文案全部走字典（含 `glyph`）。
- `ui-models-dev` 的 `corner-shape`/elevation 之外，README 双语、依赖声明、`dsh.client` 清单等结构面均已合规（此前 task20/task21 前置工作已修）。

## D. Token 层盘点

### D.1 承载文件（`ui-theme/src/styles/`，9 个）

| 文件 | 定义行 | token 层级 |
|---|---|---|
| `design-platform.css` | 382 | 静态调色板 + 语义别名（明/暗）+ darwin 专用 |
| `gradient-shadow-text.css` | 196 | 排版阶梯、渐变、阴影、高度、遮罩、菜单滤镜 |
| `base.css` | 10 | 字体族、**半径尺度**、设置卡别名 |
| `onboarding.css` | 10 | 引导态强调色/渐变/别名 |
| `focus.css` | 2 | 焦点环宽度与颜色 |
| `corner-shape.css` | 1 | `--dsw-corner-shape` |
| `shiki.css` | 11（`--shiki-*`，非 `--dsw-`） | 语法高亮（明 `:root` / 暗 `body[data-ds-dark-theme]`） |
| `scrollbar.css` | 5（`--dsh-scrollbar-*`） | 滚动条间接层 |
| `brand-font.css` | 0（3 个 `@font-face`） | 品牌字体 |

`ui-theme/src/styles/` 内**自定义属性唯一名 427 个**：`--dsw-` **403**、`--shiki-` 11、`--dsh-` 8、`--ds-` 5。仓库范围内 `--dsw-*` 定义行 628 行。

### D.2 家族与数量（唯一名）

| 家族 | 唯一名 | 家族 | 唯一名 |
|---|---|---|---|
| `--dsw-font-*` | **182** | `--dsw-gradient-*` | 3 |
| `--dsw-alias-*` | **107** | `--dsw-focus-*` | 2 |
| `--dsw-static-*` | **77** | `--dsw-linear-*` | 2 |
| `--dsw-specific-*` | 11 | `--dsw-menu-*` | 2 |
| `--dsw-radius-*` | 6 | `--dsw-corner-shape` | 1 |
| `--dsw-elevation-*` | 5 | `--dsw-mask-blur` | 1 |
| `--dsw-shadow-*` | 4 | | |

别名子族：`bg` 15、`button` 15、`label` 13、`state` 12、`markdown` 8、`border` 7、`file` 6、`interactive` 5、`brand`/`onboarding`/`scrollbar` 各 4、`tooltip`/`menu`/`settings`/`toast`/`code`/`turn` 各 2、`link`/`switch` 各 1。全部 11 个 `--dsw-specific-*`：`bubble`、`bubble-highlight`、`input-major`、`login-input`、`menu`、`selector`、`sidebar-fill`、`sidebar-nav-item-active`、`sidebar-nav-item-active-accent`、`sidebar-nav-item-hover`、`tip`。

**特性代码被要求只用的层级**（`web-styling.md:18`）：`--dsw-alias-*` 语义别名；不得拷贝静态调色值或写字面色。

### D.3 消费实况

`packages/client` + `apps/web` 内 `var()` 引用共 **3,177 处 / 219 个不同名字**：alias 103 名/2,195 次、radius 7/307、static 60/229、font 23/179、focus 2/142、specific 8/48、elevation 6/41、menu 2/24、mask 1/4、shadow 2/3、gradient 3/3、corner 1/1。

引用最多的别名：`label-primary` 320、`label-tertiary` 310、`label-secondary` 226、`state-business-primary` 162、`interactive-bg-hover` 147、`state-error-primary` 127、`border-l2` 87、`label-caption` 80、`border-l3` 54、`bg-layer-1` 52。

**`ui-theme` 不提供任何 class / 工具类 / CSS-Module API**：它只注入 8 个全局表（`client/styles.ts`），特性代码在 CSS Modules 里**直接 `var()`**（已验证 4 例：`MenuSurface.module.css:26–27` 取菜单材质、`GoalBar.module.css:61`、`SidebarRoot.module.css:17`、`JobListAction.module.css:142` 用 `color-mix`）。主题包**之外**有 25 个文件定义 `--dsw-*`（26 行），全是**对既有 token 的 rebind**（`--dsw-elevation-stroke-color` 占 20 处）；唯一的例外是 `ui-primitives/src/HoverCard.module.css:10` 用共享前缀造了组件局部 token 并写字面色 `#2C2C2E`。另外 `--dsw-static-*` 在主题包外被 11 个文件引用 33 次——**文档禁止但无人守**。

### D.4 明暗与主题绑定

不是类名、也不是构建期变体，而是**调色板属性选择器**：明色默认走 `body { … }`；暗色走 `body[data-ds-dark-theme] { … }`；macOS 特例走 `html[data-platform='darwin'] body[data-ds-dark-theme]`。写属性的是 `ui-theme/src/boot-theme.ts:32`（插件前脚本）与 `ui-layout/src/client/theme-presenter.ts`（按 `snapshot.active.colorScheme` 切换，**不按主题 id**）。**没有产品变体**；第三方主题是 `ThemeDefinition` 的别名覆盖，作为**内联 CSS 变量写在 `body`** 上，不新增选择器。

### D.5 TypeScript 侧 token API

存在于 `ui-theme/src/client/index.ts` 并从 `./client` 入口导出：`ThemeTokens = Record<string, string>`（**字典，不是 token 名联合**）、`ThemeTokenModes`/`ThemeTokenOverrides`/`ThemeDefinition`/`ThemeSnapshot`/`ThemeTokenInspection`、`ThemeRuntime`（`getTheme`/`exportInspectTokens`/`setTheme`/`setFontSize`/`register`/`overrideTokens`）与合并到 Context 的 `ctx.theme`。`BUILTIN_INSPECT_TOKENS` 只有 14 条描述项，不是全集。**没有生成的 token 名类型、没有逐 token 常量、没有类型化 CSS 助手**；特性组件代码不使用该 API（只有若干包做 type-only 导入），运行时覆盖 token 才是它的用途。

## 附：可复现命令

```powershell
# 门禁级（三条规格 + 文案）
pnpm exec vitest run packages/client/ui-theme/tests/{elevation-styles,corner-shape-styles,radius-styles,menu-surfaces}.client.spec.ts
pnpm exec tsx scripts/verify-client-ui-i18n.ts

# 评审级 / 技能级（我们两个包的 CSS）
Get-ChildItem packages\uitstalie\ui-tool-dsh-store,packages\uitstalie\ui-models-dev -Recurse -Filter *.module.css -File |
  Select-String -Pattern 'font-weight:\s*\d+|#[0-9a-fA-F]{3,8}|rgb\(|border-radius:\s*[0-9]+px'

# 组合里的原生对照件
Get-Content packages\client\ui-settings-models\src\client\ModelsSection.module.css | Select-Object -First 120
```

## 附：本报告的来源

- 我本人：`docs/web-styling.md`、`docs/ui-radius.md` 全文；分支基线三条规格与 i18n 门禁的**原始输出**；两个分支包的 CSS 扫描。
- 并行盘点（只读调研，未改任何文件）：规则与强制手段盘点（含 8 个规格的逐条 test 名、`verify-client-ui-i18n` 的扫描面与 `MINIMUM_CLIENT_UI_SOURCES` 守卫、三条盲区）；组件与缺口盘点（`ui-primitives` 目录与 README 原文）。
- token 家族与数量：见 §D（子代理 A 结果）。
