# view 研究 01：session 行的动作区（`sidebar.workspaces.session.row.action`）

服务于 [task24](mission/task24.md) 的"一个 view 一个 view 地看"。本文只描述**这一个 view 的结构与资源**，以及在它上面能做/不能做的 overlay——不写实现。

## 1. 身份与结构

| 项 | 值 | 出处 |
|---|---|---|
| slot 名 | `sidebar.workspaces.session.row.action` | `ui-workspace/src/client/contract/slots.ts:205` |
| kind / scope | `list` / `root` | 同上 |
| **声明者** | `ui-workspace` 的浏览器入口（父注册的 `children`） | `ui-workspace/src/client/index.ts:273` |
| **渲染点** | 行组件的动作容器内，位于省略号 `Menu` 之后 | `ui-workspace/src/client/rows/Rows.tsx:704`（容器的 CSS 类 `.rowActions`） |
| **owner props** | `{ sessionId: SessionId; displayTitle: string }` | `slots.ts:76–81`（`SessionRowOwnerProps`） |
| **原生占用者** | `archive`（order 100）→ `ArchiveSessionRowButton`；`pin`（order 200）→ `PinSessionRowButton`；两者经**生成器一次性注册**（原子装卸） | `index.ts:293–295` |
| 行容器类 | `.rowActions`（默认隐藏，行 hover 或菜单打开时显现） | `rows/Rows.module.css:258`、`:266`、`:269` |

**结构结论**：这是一个**列表 cell**，渲染于行内动作容器；任何插件都能往里 `register` 一项，且**继承该容器的 hover 显现行为**（因为我们渲染进去的就是它的子节点）。

## 2. 资源清单（逐个）

### 2.1 这个 view 读取的「局部自定义属性」（可覆盖旋钮）

| 资源 | 谁定义 / 谁读 | 覆盖含义 |
|---|---|---|
| `--dsh-workspace-indent` | 读取于 `.sessionRow` 的 `padding-inline-start`（`Rows.module.css:8`）与 `.sessionOverflowButton`（`WorkspaceBrowser.module.css:504`） | 行缩进（工作区层级缩进） |
| `--dsh-session-list-edge-inset` | 定义于 `WorkspaceBrowser.module.css:2`（=`--dsh-sidebar-inline-padding`），被列表边缘/滚动条/渐隐使用（`:10, :305, :332, :363–368, :484`） | 列表的左右内缩 |
| `--dsh-session-list-scrollbar-width` / `-offset` | 定义于 `WorkspaceBrowser.module.css:3–4`，用于滚动条内缩计算 | 滚动条占位 |
| `--dsh-sidebar-inline-padding` | 侧栏级旋钮（由 `ui-sidebar` 发布，被上面引用） | 整个侧栏的内缩 |

### 2.2 这个 view 使用的「主题 token」（颜色/圆角/材质/动效）

| 类别 | 具体 token | 用处（`Rows.module.css` / `WorkspaceBrowser.module.css`） |
|---|---|---|
| 文字 | `--dsw-alias-label-primary` / `-secondary` / `-tertiary` / `-caption` / `-dimmed` | 标题、时间、次级信息 |
| 交互底 | `--dsw-alias-interactive-bg-hover` | 行 hover / 菜单打开 / 选中 |
| 状态 | `--dsw-alias-state-business-primary`（焦点环回退、拖放指示、选中指示）、`--dsw-alias-state-error-primary` | 焦点与拖放、错误态 |
| 描边 | `--dsw-alias-border-l4`（**0.5px 发丝线**，`:173`、`:560`） | 行内小按钮/卡片描边 |
| 圆角 | `--dsw-radius-xs` / `-sm` / `-md` / `-lg` | 行、按钮、卡片、浮层 |
| 焦点 | `--dsw-focus-ring-width` / `--dsw-focus-ring-color` | 键盘焦点环 |
| 材质 | `--dsw-alias-button-elevated-fill`、`--dsw-specific-sidebar-fill`、`--dsw-alias-bg-skeleton` | 浮起按钮、渐隐遮罩、骨架屏 |
| 动效 | `--ds-ease-in-out`（多处 120–200ms 过渡） | hover/展开/拖放动画 |

### 2.3 我们的项自身的资源约束

- 我们的组件是被插入 `.rowActions` 的**子节点**：高度/间距要与 `archive`/`pin` 对齐（它们用 primitives 的图标按钮 ✓ 见 `session-actions/ArchiveSession.tsx`、`PinSession.tsx`）；
- 文案必须走 locale 字典 ✓；只能用 token/自定义属性，不得写字面色 ✓。

## 3. 在这个 view 上能做 / 不能做的 overlay

| 动作 | 可行 | 具体做法 |
|---|---|---|
| **编组（插入一项）** | ✅ | `slots.inject(slot, () => slots.register({ name: slot, id: 'ours', order: 150/300, inject, locale }, OurButton))` —— 落在 `archive`(100) 与 `pin`(200) 之间或其后；继承容器的 hover 显现 |
| **接管某一项** | ✅ | 同 `id`（如 `archive`）注册 **`priority: -1`** → 我们的组件渲染，原生注册仍活着（撤下即回退） |
| **与原生项交错排序** | ✅ | 同 cell 内 `priority` 决定归属、`order` 决定次序；本 view 原生只用 `order`，故我们插 `order` 即可 |
| **覆盖**本 view 的局部自定义属性 | ❌（从本 cell 出发） | 见下节：这些属性由**行/列表容器**读取，而我们的项是它们的**后代**——自定义属性沿 DOM **继承**，后代设置只影响自己 ✗ |
| **改行的内部结构** | ❌ | 原生 occupant 的内部输出没有对外通道（transclusion 不可得，见 [common-view.md](common-view.md) 第三节） |

## 4. 本 view 暴露出的机制结论（重要）

**资源覆盖要求"站在读取该属性的元素的同级或祖先"**。本 slot 位于行**内部**，因此：

- 能改：**该 cell 的编组与被接管项自身的外观**；
- 不能改：**行级/列表级**的自定义属性（`--dsh-workspace-indent`、`--dsh-session-list-*`）与行容器的布局——要动它们必须**接管一个更上层的 cell**（例如某个 `single` 面板位），或由原生提供一个更上层的 seat。

⇒ 这条结论对后续每个 view 的调研都适用：**先问"我要改的资源，由哪个元素读取"，再找"我能不能被注册到那个元素的同级/祖先"**。

## 6. 粒度结论（用户现场判定，2026/10/09）

用户看过实现后的判定：**这个 view 是"合成行"（composite row）——一行 header，用约束/相对布局摆放它的 button、icon-button 等**。因此：

- 往它的 `sidebar.workspaces.session.row.action`（`list` cell）**插入一项，并不是布局级接缝** ✗：cell 的**容器布局归拥有者**（会话行组件），我们只是它的一个子节点，既改不了这一行的排布，也改不了各部件之间的相对关系；
- 要做布局层面的接管，必须**把粒度继续拆细**：让"这一行/这一区域"本身成为一个**由拥有者渲染的 region seat**（`single`），其占用者负责该区域的布局，并可在**自己的组件里**声明更细的子槽（button 位、icon-button 位等）——这正是 [common-view.md](../common-view.md) 里"模板接管"模式要覆盖的形态；
- 本 view 目前**没有**这样的 region seat：`ui-workspace` 直接在行组件里渲染这些按钮，其上是 entry 而非 slot ✗。所以这一 view 若要做布局接管，需要**一处最小原生插入**（行内区域 seat + 一次 `renderSlot`），按分支规则需先与用户约定、带标记、在任务单逐处登记（[task14](mission/task14.md) 是先例）。
- **落地调整**：本包把 `sessionRowAction` 默认为**关闭**（不再默认侵入一个合成行），该开关保留为机制样例；装配测试补了"默认什么都不贡献 = 该 cell 与原生逐字一致"的用例。

## 8. 拆成最小基础单元（用户要求，2026/10/09）

按"先拆成最小单元、再对单元 overlay"的要求，本 view 的分解如下：

| 层级 | 单元 | 归属 | 能否被我们 overlay |
|---|---|---|---|
| 行容器 | `.rowActions`（行内动作条） | `ui-workspace`（会话行组件） | ✗ 布局归拥有者；只能作为 item 的宿主 |
| 行内条目 | 每个 icon-button / 菜单按钮 | 原生 = `ui-workspace` 的私有组件 | ✗ 私有组件 import 不到 ⇒ 只能"整项替换"（shadowing）或自建 |
| **我们的单元** | **`Row` 单元**（`ActionRow`）承载我们自己的条目 | **我们**（在 cell 内渲染） | ✓✓ 单元内部一切归我们：子项、间距、对齐；下一步在此声明更细的子槽 |
| 未来区域单元 | 若拥有者声明 region seat（`single`），其占用者可渲染一个 **`Row`/`Column` 区域单元**，把原生部件也纳入自己的布局 | 拥有者 + 我们 | ✓ 这是"整行布局归我们"的唯一路径（见 §6） |

**结论**：本 view 上真正能被我们 **unit 级 overlay** 的，是**我们自己渲染的那段单元**（今天的 `Row`，未来的区域单元）；原生部件在其私有组件内，只能被整项替换 ✗。因此 unit 层的价值有两重：① 立即让我们的贡献是**结构化、可配置几何**的（而不是一个裸按钮）✓；② 一旦有了 region seat，同一套单元可以承载**原生部件 + 我们的部件**的混合布局 ✓。

## 9. 若实现（下一片）需要准备的测试点

1. **未启用**：该 slot 的占用者 id 序列与原生逐字一致（`['archive','pin']`）；
2. **编组启用**：序列按 `order` 插入我们的项，且渲染在 `.rowActions` 容器内（继承 hover 显现）；
3. **接管启用**：`archive` 位置渲染我们的组件；**注销我们的注册后原生项自动恢复**（OMS disable 语义）；
4. 关闭 `Config` 后行为与 1 完全一致。
