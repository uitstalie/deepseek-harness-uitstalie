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
