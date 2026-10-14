# task24 — `dsh-common-view`：原生 view 的自定义模板与 overlay 机制

## requirement

用户判定（2026/10/09，承接 [task21](task21.md) 的 overlay 调研）：

> 写一个插件 `dsh-common-view`，对这些原生的 view 进行**可自定义扩展**的处理，**一个 view 一个 view、一个结构一个结构**地处理。后续修改 view 布局时，都依赖这个插件实现 **overlay** 与**编组转义**。类比 Android：实现了 framework 的 **view 模板** + **OverlayManagerService**。

即：本任务单交付的不是"改某一个页面"，而是一套**可复用的 view 接管机制**——把原生 view 当作可被 overlay 的模板：能覆盖它的属性、能接管它的结构、能在其编组面上插入我们的项、能把我们自己的组件登记为它的替换实现；并且**逐 view 增量接管**，每个 view 一份适配器。

设计与 Android 概念的逐条映射见 [common-view.md](../common-view.md)。

## 关系

- **源自** [task21](task21.md)：那里的 [overlay-feasibility.md](../overlay-feasibility.md) 已给出机制与缺口（slot shadowing 的 `priority` 语义、319 条组件局部自定义属性、React props 无外部通道、类名是构建哈希、一个 slot 一个声明者）。
- **不是** task21 的样式修正（那是 task21 第三步）；本任务单是**新能力**，故按分支规则另立 mission。
- 与 [task14](task14.md) 的 `ui-workspace` seat 互补：seat 提供"位置"，本插件提供"如何接管与编组"。

## 修改范围

- **分支自有**：新包 `packages/uitstalie/common-view/`（包名 `@deepseek-ai/dsh-client-common-view`——遵守 client 包命名规则；用户口语名 `dsh-common-view` 记于此）、其 `tests/`、双语 README 三件套、设计文档 [common-view.md](../common-view.md)、本任务单。
- **原生**：**预期为零**。本插件的全部落地手段都走既有扩展点（`ctx.slots` 的 shadowing、`ctx.theme` 的 token、wrapper 的内联自定义属性、插件 `Config`）。若某个 view 确实没有可用 seat 且无法用 shadowing 变通，才按分支规则另立登记（[task14](task14.md) 是唯一先例）。

## 交付方式（用户明确的节奏）

**一个 view 一个 view、一个结构一个结构**。每个 view 一片：

1. **适配器**：为这个 view 写一份"结构清单"（它的 cell、owner props、局部自定义属性、可覆盖 token）——这份清单同时补上了调研里发现的"**发现面**"缺口；
2. **overlay 项**：在该清单上声明我们要做的动作（属性覆盖 / 编组插入 / 接管替换），默认**关闭**（opt-in）；
3. **测试**：用 `client-runtime` 的装配测试（`roster: webApp` 或按该 view 的声明者装配）断言"开启后结构/属性如预期、关闭后与原生逐字一致"；
4. **验证**：`tsc` 两面 + `pnpm run build` + 受影响包的聚焦测试 + `test:gui` 不新增失败。

## 待用户拍板的开放项

1. **第一个接管的 view**（见 [common-view.md](../common-view.md)「切片计划」的三类候选）；
2. 插件是否**默认挂载但全项关闭**（推荐：机制在、行为不变），还是默认不挂；
3. `Config` 的粒度：按 view 分节（每个 view 一个 `enabled` + 动作开关）——推荐，便于逐 view 灰度。

## 状态：PENDING（2026/10/09 挂起）

**已完成并推送**（`origin/cli-desktop` 的分支 tip，分支侧改动全部在 `packages/uitstalie/common-view/` 内；原生改动只有早先一片登记行）：

| 层 | 内容 |
|---|---|
| 几何单元 | `Row`、`Column`（spec → `resolveUnit` → `emitUnit`；接受 `style` 以便传组件局部自定义属性） |
| 显示叶子 | `TextView`（字型/墨色内联）、`ImageView`（fit 内联、圆角走类+`corner-shape` 配对）、`Spacer`（flex 长写）、`Divider`（0.5px 中性发丝线） |
| 能力 | `button-capability.ts`（`ButtonSpec` 数据 + `ButtonBindings` 行为 + `resolveButton`/`deriveButton`/`indexButtonOverrides`）→ `DefaultButton`（`forwardRef`，交共用件 `Button` 渲染） |
| 视图 | 会话行动作条（默认关）、大布局脚手架 `AppScaffold`（浮层内，默认关）、侧边栏复刻 `SidebarGroupList` + 品牌行/设置行 |

**默认全关**：装配测试（boot 真实 web roster）证明未配置时行内 cell 与原生逐字一致、`shell.overlay` 无我们的条目、整组 roster 全部激活 ✓。

**待办（下次接手先看这里）**：

1. ~~**两处未核实的度量**~~ **已完成（2026/10/12）：照原生源核对并修正** —— 出处与实测值：
   - **`ui-sidebar` 的品牌行**（[`SidebarRoot.module.css`](../../packages/client/ui-sidebar/src/client/SidebarRoot.module.css#L219)）：expanded **60px** / rail 36px；`padding: 8px 0 8px 4px`；`gap: 8px`；`margin-bottom: 4px`（rail 12px）；`justify-content: flex-end`；品牌区 `.brandIdentity` 高 24 / gap 8；**本地构建名走 `.fallbackBrandName`：17px + 继承 600 字重 + 行高 24**（18px/600/`letter-spacing: .04em` 是默认 wordmark 变体）；行尾控件 `.iconButton` **28×28、radius-sm、hover `--dsw-alias-interactive-bg-hover`**，面板图标 expanded **16** / rail 18。我们此前用的 44px、14px、16×16 图标盒都是推测，已改。
   - **设置 seat 的真正占用者是 [`ui-settings-general`](../../packages/client/ui-settings-general/src/client/index.ts#L198)**（不是 ui-settings）：行内容 [`chrome.tsx` 的 `TriggerContent`](../../packages/client/ui-settings-general/src/client/chrome.tsx#L22) ＝ **`IconSettingsOutlineMedium` size 16（rail 18）** + 仅宽栏显示的 `t('trigger')`（zh **设置** / en **Settings**）；外层 `.triggerRow`（gap 8、`width: calc(100% + 4px)`、`margin: 4px -2px`）+ `.trigger` **42px 高、`padding: 0 10px 0 8px`、radius-**md**、hover 填充、14px/22px**；rail 变体 36×36 / gap 0 / padding 0。我们此前的 `IconSlidersTwoOutlineRegular` 与 34px 是推测，已改。
   - 落点：`packages/uitstalie/common-view/` 的 `AppScaffold.tsx` + `AppScaffold.module.css`；另加 2 条**读 CSS 模块断言数字**的规格（jsdom 量不到样式，这是把保真数字钉住的唯一机械手段）。
   - **有意未复刻**：seat 同级的 `ConnectionIndicator` 与 `DesktopUpdateIndicator`（运行时状态，不属布局）；`.triggerRow` 的 ±2px 外扩属原生外壳自身内边距体制的细节。
2. **脚手架开关的持久通道**：浏览器半边**收不到组合里的行 config**（启动载荷只带模块说明符 ✗，已实测），因此 `scaffold`/`sessionRowAction` 这类开关必须改走**插件 settings（`configForms`）** ✓ —— 做完才能把"临时默认打开"彻底移除 ✓；
3. **区域子槽通道**：外来插件无法给 `shell.overlay` 合并 children 声明（`SlotMap` 形状归 ui-layout ✗）⇒ 脚手架的三个区域要么等上游给 children 位（原生最小插入），要么设计"自有父槽 + 子槽"注册通道 ✓；
4. **继续逐 view 复刻**：
   - **会话行 hover 动作条（已完成 2026/10/12）**——照原生 `Rows.tsx:680-706` 复刻：动作条内容为 **`⋯` 菜单触发器 + `archive`(order 100) + `pin`(order 200)**，每个都是 `.iconButton`（16×16、`radius-xs`、tertiary→primary hover）；其中
     - `⋯` 是**真菜单**（共用件 `Menu`，`portal` + `closeOnPointerLeave`），四项按原生顺序 **pin(100) / rename(200) / fork(300) / archive(400)**，用 `MenuItemButton`（图标 + 文案）；
     - `archive` 的图标/文案随状态翻转（`IconArchiveOutlineRegular` ↔ `IconUnarchiveOutlineRegular`），`pin` 同理（`IconPinOutlineRegular` ↔ `IconPinFillRegular size={14}`）；
     - **归档行不提供 pin 按钮**（原生：pin 与 archive 在 Host 上互斥，`PinSessionRowButton` 在归档行返回 null）；
     - `archive`/`pin` 都带 `Tooltip`（`side="bottom" align="end" delayMs={500}`），文案分两族：tooltip 用短式（`actions.archive|unarchive|pin|unpin` → 归档会话/取消归档/置顶会话/取消置顶），可访问名用句式（`menu.*Session`）；`⋯` 的 aria 是 `actions.session.aria`（会话"{name}"的操作）；
     - 动作条自身 `display:none`、hover 或**菜单打开**时显示（原生 `.menuOpen` 同款），并吞掉点击避免触发行激活；
     - 字典新增 9 个键、值照原生 `ui-workspace` 的 `actions.*`/`menu.*`；CSS 只加一条 `.actionsOpen`（原有 `.actions`/`.glyph` 已与原生 `.rowActions`/`.iconButton` 逐条一致）；
     - 规格：`scaffold.client.spec.tsx` 加 2 例（按状态计数的动作条、菜单四行顺序），`sidebar-group-list.client.spec.tsx` 的旧标签断言同步更新。
   - **工作区（project）行动作条（已完成 2026/10/12）**——照原生 `Rows.tsx:251,281-324` 复刻：`⋯` 触发器（aria = `actions.workspace.aria` → 工作区"{name}"的操作）打开共用件 `Menu` 的 `items` 形态，两行 **rename（`IconEditOutlineRegular`，文案"重命名"）→ delete（`IconTrashOutlineRegular`，**`danger: true`**，文案"删除工作区"）**；其后是**新会话按钮**（tooltip = `actions.newSession`"新会话"，aria = `actions.newSession.aria` → 在"{name}"中新建会话，图标 `IconNewChatOutlineRegular` **不带 size**）。动作条同样 hover 显示、菜单打开时保持显示、吞掉点击。字典新增 4 键（值抄原生 `rename` / `delete.workspace` / `actions.workspace.aria` / `actions.newSession.aria`）；规格加 1 例断言菜单两行的顺序。
   - **工作区行 HoverCard（已完成 2026/10/12）**——照原生 `Rows.tsx:162-176,331-344` 复刻：共用件 `HoverCard` 包住整行，`openDelayMs={800}`、`disabled={menuOpen}`（菜单打开时不弹卡）、`copyText=workspace.cwd` + 复制/已复制文案；卡内容三行 `.hoverContent`（`column` / `gap 8px`）：标题 14/20、目录 12/16 `word-break: break-all`、创建时间 12/16（`创建于 {date} {HH:mm}`，日期走字典 `scaffold.dateYmd`，时钟本地时区补零）。为此把菜单开合状态从动作条**上提到行组件**（`WorkspaceRow`），与原生的 `disabled={menuOpen}` 同构；样例数据补上 `cwd` 与 `createdAt`（工作区即数据）。规格加 1 例：假定时器 → `pointerEnter` → 800ms 后卡片出现且带目录与年份。
   - **有一处刻意偏离原生**：卡内次要文字原生写死 `#CFD3D6`（深色卡上的次级灰），仓库无对应 token，本分支规则禁字面色 ⇒ 我们用「继承卡片白墨 + `opacity: .78`」表达同一层次。若要逐像素一致，需上游给 hover card 补一个次级墨色 token。
   - **仍未复刻（本 view 内）**：工作区标题的**双击重命名**输入态（原生 `.renameInput`）、行拖拽（`draggable` + 插入标记）。
   - **中间信息区：头部结构（已完成 2026/10/12 第一片）**——照 `ui-conversation` 的 `ConversationRoot.module.css` + `ConversationSession.tsx`（`conversation.session.header` 占用者）复刻出该 view 的头：
     - `.header`：`grid-template-columns: auto minmax(0,1fr)`、**`min-height: 76px`**、`padding: 10px 28px 0 20px`、`border-bottom: 0.5px solid var(--dsw-alias-border-l3)`（76px 是与侧栏 tab 条 + 头部各 38px 对齐的结果，见原生注释）；
     - `.headerLeading`（grid 列 1，空占位）+ `.titleRow`（列 2、**`min-height: 30px`**、`padding-inline-start: max(0px, calc(var(--dsh-frame-leading-clearance, 0px) - 20px))`）；
     - `.crumbs`（gap 4px、nowrap、overflow hidden）→ `.crumbSeg`（gap 4px）+ `.crumbSep`"/"（caption 色、14/20）+ `.crumb`（**`padding: 4px 8px`、`max-width: 220px`、radius-md、tertiary 墨、ellipsis**）；**祖先面包屑是 `button`（hover 有填充），当前项是纯文本 `.crumbCurrent`（`font-weight: 500` + label-primary）** —— 原生特意不用 disabled button（darwin 拖拽区会把它整块减掉）；
     - `.headerActions` / `.headerUtilities`（`margin-left: 20px` + `:empty` 隐藏）/ `.headerCorner`（`margin-right: -16px` + `:empty` 隐藏）= 空 seat 占位，与原生同构；
     - `.tabs`（`grid-column: 1/-1`、gap **36px**、`margin-top: 10px`、`padding-left: 8px`）+ `.tab`（13/16、weight 500、tertiary）+ **`::after` 2px 指示条**（`bottom: -1px`）+ `.tabActive`/`.tabActive::after` 用 `state-business-primary`；**原生只在 ≥2 个视图时才显示 tab 条**（我们也照此）；`role="tablist"`/`role="tab"`/`aria-selected` 齐全；
     - 数据在 `sample-conversation.ts`（面包屑 = 会话血缘，当前项最后；两个 tab = 原生 `ui-chat` 的"对话"/`ui-trajectory` 的"轨迹"，字典键 `scaffold.tabChat`/`scaffold.tabTrajectory`）；选中态由 `AppScaffold` 持有。
   - **顺带做的整理**：`classes()` 提到 `views/scaffold/classes.ts`（两个复刻件共用）；规格里的"读 CSS 断言数字"helper 提到 `tests/css-rule.client.ts`（**必须带 `.client.` 后缀**，否则 `tsconfig.client.json` 的 include 模式收不到它，`tsc -b` 会报 TS6307 —— 已踩过）。
   - **中间信息区：主体框架（已完成 2026/10/12 第二片）**——照 `ConversationRoot.module.css` + `InputBar.module.css` 复刻：
     - 原生嵌套（`ConversationContent.tsx:188-203`）：`.body[data-conversation-content]` → `.scrollBody[data-conversation-scroll]` → { 视图, `.composerSeat[data-composer-seat]` }，宽度控制是 `.body` 的兄弟；
     - `.body`：`position: relative`、flex 列、`flex: 1`、`min-height: 0` + **共享宽度轴**：`--dsh-chat-content-width: var(--dsh-chat-user-width, clamp(680px, calc(var(--dsh-conversation-column-width, 0px) * 0.64), 920px))`、`--dsh-composer-card-max-width: calc(内容宽 + 32px)`、`--dsh-composer-side-clearance: 16px`、`--dsh-composer-dock-inset: 8px`（我们的复刻没有列宽输入 ⇒ 按原生公式落到 **680px 下限**，已验证公式文本）；
     - `.scrollBody`：`margin-right: 2px`（产品级 2px 滚动条偏移）、`overflow-y: auto`、**`scrollbar-gutter: stable`**，`::-webkit-scrollbar-track { margin: 2px }`；
     - `.viewArea`（active 相：`flex: 1 0 auto; min-height: auto`）+ `.composerSeat`（`flex: none`、列、**`position: sticky; bottom: 0`**、`--dsh-composer-text-max-height: 336px`）+ `.composerStack`（`--dsh-composer-stack-gap: 6px`）；
     - composer 盒：`InputBar .root`（`padding: 0 var(--dsh-composer-side-clearance) 4px`、居中）→ `.card`（**`padding-top: 8px`、`gap: 12px`、`max-width: var(--dsh-composer-card-max-width)`、`border-radius: var(--dsw-radius-panel)`、`background: var(--dsw-specific-input-major)`、`box-shadow: var(--dsw-elevation-soft)`**、描边走 `--dsw-elevation-stroke-color: var(--dsw-alias-border-l2)`、字号 `var(--dsh-content-font-size, 14px)` + `line-height: calc(24px + var(--dsh-content-font-delta, 0px))`、滚动条走 l2 对）→ `.input`（**`min-height: 36px`、`padding: 4px 8px 0 14px`**、`caret-color: state-business-primary`）+ `.placeholder`（**`position: absolute; inset: 4px 8px auto 14px`、caption 墨、单行 ellipsis、不接收指针**）+ `.row`（`padding: 2px 8px 6px`、gap 12、`container-type: inline-size`）；
     - 占位文案照原生 `placeholder.default`（"发消息或创建任务, / 调用指令, @ 文件或对话" / "Message or run a task, / commands, @ files or sessions"）。
     - 规格 `content-body.client.spec.tsx` 3 例（结构、滚动/座位度量、卡与输入行度量）。
   - **仍未复刻（头部内）**：`.headerBlank`/`.headerSessionless` 的空白态、`.crumbSubagent`（12/18）与 lineage 子槽、`conversation.session.header.actions|utilities|corner` 的真实占用者。
   - **composer 控件行（已完成 2026/10/12 第三片）**——照 `InputBar.tsx:439-518` + `InputBar.module.css` 复刻：
     - 行：`.row`（`padding: 2px 8px 6px`、gap 12、`justify-content: space-between`、`container-type: inline-size`）；左组 `.tools`（gap 12）→ **`+` 按钮**（`.add`：28×28、`border-radius: 999px` + **`corner-shape: round`**、`background: var(--dsw-specific-selector)`、hover `interactive-bg-hover-solid`、图标 `IconPlusOutlineMedium size={14}`、`aria-haspopup="listbox"`、Tooltip"添加文件或调用指令"`side="top" delayMs=500`）+ `.modes`（权限/plan 两个 seat，空）；
     - 右组 `.trailing`（`flex: none`、**`margin-left: auto`**、gap 12）→ `.standardControls`（right/model seat，空）+ `.activity`（`flex: none`、`:empty` 隐藏）+ **发送圆钮**（`.primary`：**34×34**、`999px` + `corner-shape: round`、`background: var(--dsw-alias-button-info-fill)`、hover `button-info-hover`、**`transform: translateY(-2px)`**（抵掉行的 2px 下移）、`:disabled { opacity: .4 }`）；
     - **`color: #fff` 是原生明确写死的**（原生注释：箭头在蓝色填充上两种主题都保持白色，用前景 token 会翻色，design 34:10465）⇒ 我们照抄并在代码里保留该理由，属"抄原生既定值"而非自造色值；
     - 空占位状态照原生：草稿为空 ⇒ 发送钮**禁用**（原生 `primaryDisabled` 含 `empty`）；文案取自 `input.commands` / `input.send`。
     - **一处保真说明**：发送箭头用的是原生 `InputBar` 内联的那条 path（同一枚产品字形）；共用件里的 `IconSendOutline*` 是另一枚字形，未采用。
     - 规格：`content-body.client.spec.tsx` 扩到 5 例（结构、滚动/座位、卡与输入行、控件行与按钮、空 seat），并把测试 helper 升级为"同一选择器可跨多条规则/选择器列表"匹配（`.a, .b { }` 这种分组写法也能断言）。
   - **空会话 Hero（已完成 2026/10/12 第四片）**——照 `EmptyHero.tsx` + `HeroShell.module.css` + `ConversationRoot.module.css` 的 `.composerHero`/`.heroWorkspaceRow` 复刻：
     - 原生 hero 是"空白会话"相位：`.root[data-phase='hero'] .scrollBody { justify-content: center; overflow-y: auto }`（我们用一个 `hero` 数据位切换 `.scrollBodyHero`）；
     - `.root`（flex 居中、**`height: 100%`**、`padding: 0 24px`）→ `.stack`（列、**gap 12**、`width: 100%`、**`max-width: var(--dsh-composer-card-max-width)`**、`overflow: visible`）；
     - `.headline`（flex **wrap**、`column-gap: 10`、`row-gap: 12`、居中、**26/32、weight 500**）＝ 品牌标记（原生是 `conversation.hero.brand.mark` seat，回落一枚**带 SMIL 游动形变**的 `HeroFish`；我们未复刻动画，用共用件 `FishLogo` 34px 静态呈现）+ `.titleGroup`（wrap、`column-gap: 7`、`row-gap: 4`）＝ 标题 + `.previewBadge`（**`padding: 1px 7px 0`、`999px` + `corner-shape: round`、0.5px `interactive-bg-hover` 描边、`state-business-tertiary` 底、`label-primary-bluish` 墨、等宽字体 12/18、weight 500**）；
     - 工作区 chip（`WorkspaceChip`，原生同样导出）：**`gap: 4px`、`max-width: min(100%, 360px)`、`min-height: 28px`、`padding: 0 8px`、radius-sm、13/20、weight 500**，含文件夹 16 + 标签（ellipsis）+ chevron 12（caption 墨）；无标签时显示"选择工作区"占位；
     - hero 相位下的 composer 栈（`.composerHero`）：**`align-self: center`、gap 8、`padding-bottom: 32px`**（把整叠略抬到真中心之上）、`width: min(calc(卡上限 + 2×侧距), 100%)`、`z-index: 1`；工作区行 `.heroWorkspaceRow`（flex、`gap: 2px`、**`margin-top: 4px`**、**`padding: 0 16px 0 20px`**）排在 hero 与输入卡之间（原生顺序：HeroShell → 工作区行 → dock seat → InputBar）；
     - 文案照原生 `hero.headline`/`hero.preview`/`hero.chooseWorkspace`。
     - 规格：新增 `hero-shell.client.spec.tsx` 3 例；`content-body.client.spec.tsx` 增 1 例（hero 相位结构 + `.composerHero`/`.heroWorkspaceRow` 度量）。
   - **仍未复刻（hero 内）**：品牌标记的游动动画（SMIL 形变目标）、`conversation.hero.brand.mark` 子槽、hero 的落点/发光装饰。
   - **ContextMeter 上下文计量（已完成 2026/10/12 第五片）**——照 `ContextMeter.tsx` + `ContextMeter.module.css` 复刻，放在 composer 的 dock seat 里（原生 `InputBar` 的 `.dock`）：
     - dock：`display: flex; align-items: center; justify-content: center; gap: 12px; max-width: 100%; padding-top: 4px`（hero 时 `:empty` 收起）；
     - 触发器 `.trigger`：**`gap: 6px`、`padding: 1px 8px`、radius-sm、tertiary 墨**、字号 `var(--dsh-content-font-size-secondary, 13px)`、行高 `calc(20px + var(--dsh-content-font-delta-secondary, 0px))`、**`font-variant-numeric: tabular-nums`**；hover/展开 → `interactive-bg-hover` 底 + secondary 墨；`aria-haspopup="dialog"`；
     - 圆环：**14px viewBox、2px 描边、r=5.5**（周长 2πr），`.track` 用 `border-l3`、`.fill` 用 tertiary 墨 + `stroke-linecap: round`、`rotate(-90 7 7)`，`strokeDashoffset = 周长 × (1 - 百分比)`；
     - 面板（`createPortal` 到 body + 共用件 `useAnchoredPosition(side:'top', gap:8, margin:12)` + `useDismissOnOutsidePointer`）：**`width: min(264px, calc(100vw - 24px))`、`padding: 12px`、radius-lg、`--dsw-specific-menu` 底 + `backdrop-filter`、`--dsw-elevation-prominent`**；头部 = 本地化句子的两半 + 读数 + `~已用 / 窗口`（`~` 表示投影值）；`.bar`（**gap 1、`margin: 10px 0 12px`、高 4px、`999px` + `corner-shape: round`**）+ `.segment`（`min-width: 2px`）；`.rows`/`.row`（space-between、gap 12、`padding: 2px 0`）+ `.swatch`（**8×8、radius 2、`margin-right: 6px`**）；
     - **读数在句子里的位置用 `\u0000` 占位切分**（原生 `READING_SLOT`）：zh「上下文已用 {percent}」→ 前半有字、后半空，en「{percent} of context used」→ 反之，`.headline:empty` 让空的一侧不占 gap ✓ 我们照此实现；
     - 三色 tint 照原生：系统提示词 `--dsw-static-neutral-bluish-400`、工具定义 **`rgb(167, 139, 250)` 字面值**（原生注释：设计平台没有紫色静态 token）、对话消息 `--dsw-static-blue-450`；数字格式走我们字典里的 `scaffold.numberThousand/Million`（值同共用 `number.*`）；
     - **依赖变更**：面板要 `createPortal`，而本包原先没声明 `react-dom` ⇒ 在 `devDependencies` 补 `react-dom` + `@types/react-dom`（版本对齐 `ui-conversation`），`pnpm install` 更新了 lockfile；`verify-package-dependencies` ✓ 77 包通过。
     - 规格：新增 `context-meter.client.spec.tsx` 3 例（读数与圆环、展开面板三行与三段、度量与 tint）；注意**面板是 portal 到 body 的**，断言要用 `document` 而不是 render container。
   - **消息流：转写框架 + 用户消息（已完成 2026/10/12 第六片）**——照 `ui-chat` 的 `ChatView.module.css` + `MessageItem.module.css` 复刻：
     - 框架：`.frame`（relative、列、`flex: 1 1 auto`、**`container-type: inline-size`**）→ `.root`（**`overflow-x: visible; overflow-y: clip`**）→ `.scroll`（`overflow-y: auto`、**`padding: 16px calc(var(--dsh-composer-side-clearance) + 16px)`**（两侧＝composer 侧距 +16 ⇒ 转写恒比输入卡窄 32px）、`container-type: inline-size`）→ `.column`（**`max-width: var(--dsh-chat-content-width)`、`width: 100%`、`margin: 0 auto`**、列）；
     - 行距：相邻 flow item **`margin-top: var(--dsh-chat-flow-gap, 6px)`**；响应用 `.flowItemResponse { --dsh-chat-flow-gap: 12px }`（原生还把它之后的下一行也抬到 12px，我们用自己的相邻选择器表达同一效果）；
     - 用户消息：`.userRow`（列、**`align-items: flex-end`**、gap 6）→ `.userStack`（列、右对齐、**gap 8**、**`max-width: min(calc(var(--dsh-chat-content-width, 748px) * 0.702), 82%)`**，即 figma 525px 占宽度轴的比例）→ `.bubble`（**`background: var(--dsw-specific-bubble)`、`border-radius: var(--dsw-radius-xl)`、`padding: 10px 16px`**、字号 `var(--dsh-content-font-size, 14px)`、行高 `calc(22px + var(--dsh-content-font-delta, 0px))`（单行 42px 泡泡）、label-primary、`white-space: pre-wrap` + `word-break: break-word`）；
     - **相位切换**：原生空白会话不挂视图、非空才 `renderSlot('conversation.session')` ⇒ 我们按 `hero` 位切换（hero ⇒ 居中 hero 演示；active ⇒ 转写），并在顶部条加了**第三个演示按钮**（`DefaultButton` 派生 outline）在预览里来回切相位；规格加 1 例断言切换。
     - **未复刻且需注意**：助手消息体是 `AssistantMarkdown` 这一整套 markdown 面（本片用纯文本代替，标为待办）；工具卡、过程行、错误行、`turnSpacer`、`toBottom`、`older` 等同样是后续切片。
     - 规格：新增 `chat-transcript.client.spec.tsx` 2 例（行与 flow part、度量）。
   - **queue 排队区（已完成 2026/10/12 第七片）**——照 `queue/QueueDock.module.css` + `QueueDock.tsx` 复刻，放在 composer 栈里输入卡**之前**（原生顺序：`conversation.input.dock` 的占用者 → InputBar）：
     - `.dock`：**`width: calc(100% - 2×侧距 - 2×dock 内缩)`、`max-width: calc(卡上限 - 2×dock 内缩)`、`margin: 0 auto calc(0px - var(--dsh-composer-stack-gap) - 3px)`**（取消自身后的栈间距并塞到输入卡下方 3px，读作同一块面）、`padding: 0 var(--dsh-composer-dock-inset)`；
     - `.panel`：`padding: 2px 0`、**`border-radius: lg lg 0 0`**（下方方角）、`::before` = `specific-menu` 底 + `menu-backdrop-filter`、**`::after` = 0.5px `border-l1` 描边且 `border-bottom: none`**（由输入卡自己的上边闭合）；
     - 头部按钮：**`height: 36px`、`gap: 10px`、`padding: 4px 12px`、radius-md**，内容 = `IconQueueOutlineRegular` 前导 + 计数（**13/24、weight 500**，`font-family: Inter, var(--dsw-font-family)`）+ 展开箭头（**14×14 网格、tertiary**，`IconChevronDown/UpOutlineRegular` 随开合切换）；`aria-controls`/`aria-expanded` 齐全，**关闭时列表内容不再渲染**（原生 `{listVisible && …}`，我们照此，规格里也因此断言"关闭后文本消失"）；
     - 列表：**`max-height: 180px`** + `overflow-y: auto`；行：**`min-height: 36px`、`gap: 10px`、`padding: 4px 5px 4px 12px`、radius-md**，行间 `box-shadow: inset 0 1px 0 var(--dsw-alias-border-l1)`；
     - 文案照原生 `queue.count`（"{n} 条排队消息" / "{n} queued messages"）；**未复刻**：附件行、内联编辑器、发送回显行、单行时的前导图标规则。
     - 规格：新增 `queue-dock.client.spec.tsx` 3 例（空队列不渲染、计数与就地展开/收起、dock/panel/header/row 度量）。
   - **工具卡（已完成 2026/10/12 第八片）**——照 `ui-tool` 的 `ToolRow.tsx`（`ToolRow.module.css`）复刻**摘要行 + 展开体**：
     - **行骨架直接复用共用件 `DisclosureRow`**（原生就是它：`icon`/`title`/`running`/`open`/`expandable`/`expandOnRowClick`/`keepContentWhenOpen`/`onToggle`/`collapsedContent` + `leadingClassName`/`titleClassName`/`rowClassName`），输出体复用共用件 **`CodeBlock`**（原生 IN/OUT 卡同样走它）——本包只自带原生那几处行内度量；
     - `.root`（列）、`.leading`（`flex-shrink: 0`）、`.title`（**weight 400**；原生对 `cordis_*` 工具用 500，未复刻），摘要行的 `[16 前导] gap6 [标题 13/24] gap8 [2×2 点] gap8 [摘要占满+截断]`：`.sep` = **2×2、`border-radius: 1px`、`margin: 0 8px`、caption 墨**；`.summary` = `flex: 1 1 auto` + `min-width: 0` + ellipsis + nowrap + **`--dsh-content-font-size-secondary, 13px`** + `calc(24px + var(--dsh-content-font-delta))`；
     - 转写数据加 `role: 'tool'`（带 `ToolCardModel`），流里按响应行处理（非用户行 ⇒ `data-chat-group-part="response"`，12px 间距）；
     - **未复刻且已登记**：各工具的专属前导图标（我们用一个 16px 占位方块）、diff/read/search/web/image 等专属体、以及**视觉隐藏的状态句**（原生 `row.running|failed|stopped` 的文案来自共享命名空间，不在 `ui-tool` 字典里，未找到出处故未做）。
     - 规格：新增 `tool-card.client.spec.tsx` 2 例（摘要可见、点开后出现 `<pre>` 输出且摘要保留；行度量）。
   - **仍未复刻（本 view 内）**：助手 markdown 面、各工具专属体与过程/错误行、`WidthControls` 宽度手柄、`TodoPanel`、`conversation.composer.dock` 的其他占用者、控件行 seat 的真实占用者、hero 的品牌标记游动动画。
5. **本包尚未提交的门禁收尾**：README 若再改需重录配对；`test:gui` 未在本轮跑过（本批未改原生 ✓）。

**本地预览方式**（`--patch` 必须排在 web 自己的参数之前，否则会被转发给 web 的 commander 报 `unknown option` ✗）：

```
pnpm run dev:web -- --skip-build --patch tmp/scaffold.overlay.yml --no-open --port 3081
```

## 验证（每片固定）

`tsc` 两面 ✓ · 该 view 的装配测试（开/关两态）✓ · `pnpm run build` ✓ · `test:gui` 无新增失败 ✓ · README 三件套与 i18n 记录 ✓。
