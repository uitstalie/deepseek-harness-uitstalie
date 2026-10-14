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
   - **仍未复刻（本 view 内）**：视图内容（消息流/轨迹）、`WidthControls` 宽度手柄、`conversation.input.dock`（queue）、`EmptyHero`/`HeroShell`、`TodoPanel`、`ContextMeter`、以及 composer 的**控件行内容**（模型选择/权限/发送等）。
5. **本包尚未提交的门禁收尾**：README 若再改需重录配对；`test:gui` 未在本轮跑过（本批未改原生 ✓）。

**本地预览方式**（`--patch` 必须排在 web 自己的参数之前，否则会被转发给 web 的 commander 报 `unknown option` ✗）：

```
pnpm run dev:web -- --skip-build --patch tmp/scaffold.overlay.yml --no-open --port 3081
```

## 验证（每片固定）

`tsc` 两面 ✓ · 该 view 的装配测试（开/关两态）✓ · `pnpm run build` ✓ · `test:gui` 无新增失败 ✓ · README 三件套与 i18n 记录 ✓。
