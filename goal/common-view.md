# `dsh-common-view` 设计：原生 view 的模板化与 overlay

服务于 [task24](mission/task24.md)。目标：把原生 view 当作**可 overlay 的模板**，逐 view、逐结构地接管；后续所有"改 view 布局"的工作都建立在这套机制上。

## 一、与 Android 的逐条映射

| Android | 本插件 / DSH | 证据与说明 |
|---|---|---|
| framework 的 **view 模板**（`View`/`ViewGroup`、布局资源） | `ui-primitives` 的组件 + **slot 声明**（父注册的 `children` + `renderSlot`） | 原生 view = 组件 + 它声明的子槽；槽就是"可被替换/插入的模板洞" |
| **OverlayManagerService（RRO）**：按 target package 叠加资源覆盖，可 enable/disable、按优先级取胜 | **slot shadowing**：同 cell 不同 `priority`，升序后**最低的活跃项渲染** | `ui-slots/src/index.ts:1278–1284`；同格同优先级抛错 `:1218/1225/1233`。**撤下我们的注册即自动回退原生** = OMS disable ✓ |
| Android **资源类型/资源 id**（color/dimen/layout） | **主题 token**（`--dsw-*`）+ **组件局部自定义属性**（319 条实测） | 自定义属性沿 DOM 继承 ⇒ 祖先可设 = 资源覆盖 ✓ |
| overlay 的 **target + overlay 包配对** | **view 清单（manifest）**：一个 view 一份"结构描述"，与我们提供的 overlay 项配对 | 见下节；同时补上调研发现的"发现面"缺口 |
| Android 的 **fabricated overlay / 编组** | **`list` 槽天然是编组面**：任何插件都能追加项，并用 `priority` 与原生项交错排序 | `order` 定显示次序、`priority` 定 cell 归属（`index.ts:1282–1284` 两者并存） |
| Android **替换整个自定义 View** | 我们**自己渲染**同一 cell（shadowing）→ 内部布局/子槽全部由我们声明 | 我们既是声明者也是渲染者 ⇒ 可在自己的组件里声明**属于我们的新槽** ✓ |

## 二、三层结构

### 1. 视图清单（view manifest）——每个被接管的 view 一份

纯数据（无行为），描述"这个 view 能被怎么改"：

- **身份**：view 的稳定标识（用它的 slot 名 / cell 组合，如 `sidebar.workspaces.session.row.action`）；
- **cell 表**：每个可接管的 cell 及其 kind（`single`/`list`/`keyed`/`chain`）、owner props 形状、是否可编组；
- **旋钮表**：该 view 读取的**局部自定义属性**与**可覆盖 token**（从源码读出，落成数据）；
- **动作表**：我们为该 view 提供的 overlay 项（默认关闭）。

> 这份清单的价值：**overlay 不再依赖读源码猜旋钮**（调研里的缺口 (a)），并且每接一个 view 就沉淀一份可复用描述。

### 2. overlay 引擎——清单 + 插件 `Config` → 三类落地动作

| 动作 | 机制 | 适用的 cell | 约束 |
|---|---|---|---|
| **属性覆盖** | wrapper 元素上的**内联自定义属性**（`style={{ '--x': value }}`）+ `ctx.theme.overrideTokens` | 全部 | `web-styling.md:22` 明确允许"内联样式传组件局部自定义属性值" ✓；**不能**写主题分支 ✗；全局样式表归 `ui-theme` ✗（所以不走注入全局 CSS） |
| **编组（插入/排序）** | `slots.register({ name, id, order, priority })` 往既有 `list` 槽追加项 | `list` | 一个 slot 一个声明者 ✓ 我们只是注册者 ✓；`id` 唯一 ✓；与原生项用 `priority` 交错 ✓ |
| **接管（替换）** | 同 cell 注册 `priority: -1`，渲染我们的组件 | `single`/`list`/`keyed` | 原生注册仍活着 → 撤下即回退 ✓（OMS 语义）；我们可在自己组件里声明新子槽 ✓ |

反向约束（来自调研）：**React props 无外部通道** ✗、**类名是构建哈希不可作选择器** ✗ —— 因此引擎**只**使用上面三条通道，不做类名 hack。

### 3. 每个 view 一个适配器模块

```
src/client/
  engine/           引擎：清单类型、Config 解析、注册与回退、wrapper 与内联自定义属性
  views/
    <view-id>/     一个 view 一片：manifest.ts（结构清单）+ overlay.tsx（我们的项）+ index.ts（装配）
```

`apply` 只负责：读 Config → 对启用的 view 逐一 `ctx.slots.inject(...)` 注册；全部经 `ctx.effect` 注册以便卸载回退；关闭时**不做任何注册**（与原生逐字一致）。

## 三、"编组转义"的边界（必须先说清）

- **能做到的编组**：在 `list`/`keyed` cell 上追加我们的项、与原生项按 `priority`/`order` 交错、在**我们自己接管**的 cell 内部自由分组排布、并声明我们自己的子槽。
- **做不到的**：把**原生组件的内部结构**取出来重新编排（transclusion）。渲染器只把 cell 的**胜出者**交给渲染方，原生 occupant 的内部输出没有对外通道。
- **因此深改造只有两条路**：① 接管整个 cell，用我们自己的实现**复现 + 扩展**（推荐，Android 的 custom View 等价物）；② 若必须保留原生内部结构而只调整其分组，需要该 view 自己声明更细的子槽——那属于**原生 seam**，按分支规则另立登记（[task14](mission/task14.md) 的先例）。

## 三点五、两种 overlay 模式与粒度判据（用户现场判定后补记，2026/10/09）

第一个 view 的实现让用户看清了一件必须先立规矩的事：**粒度决定模式**。往一个 cell 里"加一项"只在**该项列表的容器布局不归我们关心**时成立。

| 模式 | 适用形态 | 我们得到什么 | 我们得不到什么 |
|---|---|---|---|
| **贡献（contribution）** | `list`/`keyed` cell，且**容器布局归拥有者、且我们接受它**（菜单项、分区列表、动作栏） | 与原生项并存、按 `priority`/`order` 交错、单项替换 | 容器自身的排布、各部件的相对关系 |
| **模板接管（takeover）** | 该 cell 的占用者渲染**一整块结构**（一个 panel、一个 region、一行复合行） | 整块的布局归我们：我们自己排版，并**在自己组件里声明更细的子槽**（每个 button/icon-button 位一个 seat） | 原生 occupant 的内部输出（transclusion 不可得）；**别的插件的私有组件我们也 import 不到** ✗ |

**粒度判据（写进每个 view 的研究里）**：

1. 我要改的**布局**归谁？如果归拥有者，贡献模式不成立 ✗，必须找/建一个**我们渲染的 region** ✓。
2. 我要改的**资源**由哪个元素读取？自定义属性继承 ⇒ 我们必须注册在它的同级或祖先 ✓（见 [views/01](views/01-sidebar-session-row-action.md) §4）。
3. 接管后我要复用原生部件吗？若那些部件是**别的插件的私有组件**，我们只能：
   (a) 用共用件（`ui-primitives`）重新实现该部件 ✓；
   (b) 或请该拥有者把该部件也声明成一个 seat（原生最小插入 + 标记 + 登记）✓。

**由此得到的框架目标**：`dsh-common-view` 需要一个**区域级 seat 的发现与声明机制**——凡是"复合行/复合区域"，都要先问"它有没有一个由拥有者渲染的 region seat"，没有就只能走 (a) 或 (b)。这条判据会写进每个 view 的研究结论，并决定该 view 用哪种模式落地。

## 三点六、基础单元层（units）：overlay 作用的最小对象（用户要求，2026/10/09）

用户要求：**把一个 view 拆成最小的基础单元，先对这些单元做 overlay**（例如 row 与 column）。据此本包提供一层**布局单元**，它们就是 overlay 的作用对象：

| 单元 | 职责 | 输入 | 落地方式 |
|---|---|---|---|
| `Row` | 沿行内轴排布子项 | `gap` / `align` / `justify` / `className` / `children` | 几何以**内联组件局部自定义属性**（`--dsh-common-view-unit-gap`）+ 两个离散轴进入 CSS |
| `Column` | 同样的契约沿块轴（**刻意与 Row 对称**：会用一个就会用两个） | 同上 | 同上 |

单元层的三条立规：

1. **单元只管几何**：颜色、描边、材质一律用主题 token；单元自身不出现字面色、不出现 px 字面量以外的自造样式（`4px` 只是**无配置时的回退**，配置值来自插件 Config）；
2. **几何可被 overlay**：`gap`/`align`/`justify` 是插件 **Config 字段**（`unitGap`/`unitAlign`/`unitJustify`），由 apply 传进单元 → 这就是"对单元做属性 overlay"的最小闭环 ✓；
3. **单元是未来子槽的宿主**：下一步每个单元在自己组件里声明更细的子槽（button 位、icon-button 位…），于是"继续拆得更琐碎"有了落点 ✓。

**pilot 的应用**：会话行动作区里我们的贡献不再是"一个裸按钮"，而是**一个 Row 单元**（`ActionRow`），其几何全部来自 Config；该 cell 的条目 id 不变（`common-view-marker` ✓），单元在内部承载条目。

## 三点七、主干思路：**组合渲染 → 回落 DSH 原生**（用户判定，2026/10/09）

用户给出的主干判断：**view 这一块靠组合渲染，然后转换回 DSH 的原生**。这成为本框架的两段式流水线：

```
        ┌─ 组合层（composition） ─────────────┐   ┌─ 回落层（native emit） ────────────────┐
overlay │ units(Row/Column) + spec + 配置项   │ → │ 单元盒：单元自身 CSS Module 的类        │
config  │ 子槽声明 + 我们提供的叶子组件        │   │        + 组件局部自定义属性 + 内联轴值  │
        └────────────────────────────────────┘   │ 叶子：ui-primitives 的共用控件          │
                                                 │ 文案：locale 字典；结构：slot           │
                                                 └────────────────────────────────────────┘
```

**两层各自的职责（写死）**：

| 层 | 只做 | 不做 |
|---|---|---|
| **组合层** | 用单元与子槽描述结构；把 overlay 的 config（几何/强调色/开关）解析成完整 spec | 不直接写 DOM 细节、不出现字面色、不自造选择器 |
| **回落层** | 把 spec 落成 DSH 原生会渲染的东西：单元自带 CSS Module 的盒子类、token、组件局部自定义属性、`ui-primitives` 叶子、locale 文案、slot 结构 | 不引入外来约定（无第三方布局系统类名、无自造 DOM 语义） |

**不变量**：**组合模型的输出必须与原生渲染同语义** —— 同一套 token、同一类共用控件、同样的 a11y 与文案归属；任何在原生侧没有对应物的组合节点，都必须先补映射再允许使用（"有共用件就用共用件"那条常驻规则的延伸）。

**代码落点**：几何映射收敛在唯一一处 `src/client/units/spec.ts`（`UnitSpec` → `resolveUnit` → `emitUnit`）；`Row`/`Column` 只是它的**薄渲染器**（`spec.ts` 决定一切，组件文件只输出原生盒子）。后续新增单元 = 在 spec 里加一个 kind 与一处映射 ✓。

## 三点八、原子 view（leaves）：`TextView` / `ImageView`（用户要求，2026/10/09）

用户要求的基础原子：**textView 显示文本、imageView 显示 png/svg/其他图片**，二者只做**最基础的显示**——**不涉及 click、不涉及 stateful**。

| 原子 | spec（组合层） | 回落（native emit） | 主题资源 |
|---|---|---|---|
| `TextView` | `TextSpec = { text, tone?, size? }` | `<span>` + 单元自身 CSS Module 的类；`font`/ink 以**内联组件局部属性**（`--dsh-common-view-text-font` / `-ink`）落入 CSS | `size` → **复合 `font` token**（`large`=`--dsw-font-base-16`、`body`=`--dsw-font-s-14`、`small`=`--dsw-font-xs-13`、`caption`=`--dsw-font-xxs-12`，**自带行高配对** ✓）；`tone` → `--dsw-alias-label-{primary,secondary,tertiary,caption}` |
| `ImageView` | `ImageSpec = { src, alt, fit?, width?, height?, radius? }` | `<img>` + fit/尺寸以**内联属性**（`--dsh-common-view-image-fit`）落入 CSS；**圆角走类**（`radiusSm/Md/Lg` 用 `--dsw-radius-*`，`radiusFull` 用 `50%` + **`corner-shape: round` 配对**——必须让主题规格在 CSS 文本里看得见 ✓） | 无字面色；`fit` = `contain`/`cover`/`fill`/`none` |
| `Spacer` | `SpacerSpec = { size?, grow? }` | `<span aria-hidden="true">` + **flex 长写属性内联**（`flexGrow/Shrink/Basis`：固定 = `0 0 <size>`，`grow` = `1 1 0%`）；不绘制任何东西 | 无（纯粹占位） |
| `Divider` | `DividerSpec = { orientation? }` | `<span role="separator" aria-orientation>`；**描边留在类里**：`horizontal` = `border-top: 0.5px solid var(--dsw-alias-border-l2)` + `height:0`、`vertical` = `border-left: 0.5px …` + `width:0` + `align-self: stretch` | `--dsw-alias-border-l2`（中性 0.5px 发丝线；主题规格要求中性描边必须 0.5px 且不得与阴影并存 ✓） |

两条立规：

1. **只显示**：两者都不接受 `onClick`、不持有状态、不发请求 ✓（用户明确要求）；
2. **文案归属**：`ImageView` 的 `alt` 由**调用方**必填（装饰图传空串），原子自身**不持有任何回退文案** ✓（与"共用件要求完整 label props"一致 ✓）；`TextView` 的内容是**数据**，逐字显示 ✓。

## 三点九、父 view 大布局脚手架 `AppScaffold`（用户要求，2026/10/09）

用户要求：以**现在父 view 的大布局**（侧边栏位置、顶部位置、中间信息位置）做**最原始的脚手架**，方便后续验证时**直接在脚手架的布局上迭代**。

**真实拓扑（现场读 `Slots.listSubTree` 得到，不是猜的）**：

| 区域 | 真实 seat | kind | replaceRisk |
|---|---|---|---|
| 左侧栏 | `sidebar` | single | `shadows-shipped-ui`（可接管） |
| 顶部 | `shell.leading`（窗口 chrome 座位） | single | 可接管 |
| 中间 | `main`（按侧边栏条目 id 派发，已占 `conversation`） | keyed | 可接管 |
| 整框 | `root`（**只有 shell 能渲染** ✗ 规则 1） | single | — |
| 浮层 | `shell.overlay`（"Frame-wide floating layer, above every column"） | list | 可接管 |

**脚手架的形态**：`AppScaffold` = **纯组合体**，只用本包的单元与叶子搭出大布局（`Row` 左列 + `Divider` 竖线 + `Column`［`Row` 顶栏 + `Divider` 横线 + 内容区］），三个区域各带 `TextView` 名称标签；两处尺寸（列宽、顶高）是插件 **Config**（`scaffoldSidebarWidth` / `scaffoldTopHeight`），以组件局部自定义属性内联落入 CSS ⇒ **布局实验 = 改配置** ✓。

**挂载点与开关**：默认 `scaffold: false`（不进产品默认 ✓）；打开后注册进 `shell.overlay`（`id: common-view-scaffold` ✓），卸载即撤下 ✓。本地验证用 patch overlay（`tmp/scaffold.overlay.yml`，不入仓 ✓）：

```
pnpm run dev:web -- --skip-build --no-open --port 3081 --patch tmp/scaffold.overlay.yml
```

**记录到的通道限制（下一片要解）**：区域**子槽**（让脚手架的三个区域成为可被他人注入的 seat）目前走不通类型层——`SlotMap` 里 `shell.overlay` 的形状由 ui-layout 拥有，**外来插件无法给它合并新的 children 声明**（运行时接受 erased 形式的 `children`，但那是绕过类型 ✗）。因此区域子槽要么等上游在 `SlotMap` 里给出 children 位（原生最小插入），要么由本框架设计一条"自有父槽 + 子槽"的注册通道 ✓。

## 四、切片计划（一个 view 一片）

| 片 | 内容 | 说明 |
|---|---|---|
| **slice 0** | 包骨架 + 引擎（清单类型、Config、注册/回退、wrapper 内联变量）+ 单测 | 不含任何 view ⇒ 行为与原生**完全一致**（可断言） |
| **slice 1** | 第一个 view 适配器 | 候选见下 |
| **slice N** | 后续 view 一片片加 | 每片独立可测、独立可回退 |

### slice 1 的候选（需用户选一个）

| 候选 view | 它的 cell | 我们能演示什么 |
|---|---|---|
| `sidebar.workspaces.session.row.action`（原生 list，session 行的动作区） | list | **编组**：追加我们的一项、与原生项按 `priority` 交错 |
| `settings.section`（原生 list，设置分区） | list | **编组 + 属性**：追加分区，并给既有分区容器设自定义属性 |
| 某个 `single` cell（如侧栏右栏的某个面板位） | single | **接管**：`priority: -1` 顶掉原生，用我们自己的布局渲染该区域，并声明我们自己的子槽 |

> 建议从**一个 list 槽**开始（风险最低：只是追加一项，撤销即回退），把 `priority` 交错与 Config 开关跑通；再拿一个 `single` cell 做接管与自声明子槽的样板。

## 五、规则与约束（写代码前必须满足）

- 客户端包命名 `@deepseek-ai/dsh-client-*`；包放 `packages/uitstalie/common-view/`；
- 三个登记面齐全：`tsconfig.client.json` 引用、`packages/bundle/web-app/cordis.patch.yml` 的 `dsh.client` 行、`packages/bundle/web-app/package.json` 依赖；
- 文案全部走 locale 字典（`verify-client-ui-i18n`）；样式只用 token 与自定义属性（`ui-theme` 规格）；
- **不改原生文件**；无当前消费者/需要的抽象不做（每片都必须服务于一个真实 view 的改造需求）。
