# overlay 可行性调研（task21 第二步调研）

## 要回答的问题

用户计划做 **theme 插件**（overlay 主题 config）与 **overlay 插件**（对特定组件 overlay），并列举了四类场景：**覆盖组件属性**、**覆盖组件布局**、**增加自定义布局**、**组件替换**。本文逐条给出**可行性判定 + 代码级证据 + 缺口**。

## 结论速览

| 场景 | 机制 | 可行性 | 证据 |
|---|---|---|---|
| **组件替换**（同格换渲染） | slot **shadowing**：同 cell 不同 `priority`，**升序后最低者胜**；同优先级才报错 | **✅ 一等公民** | `packages/client/ui-slots/src/index.ts:1278–1284`（排序）、`:1218/1225/1233`（同格同优先级抛错，分别对应 single/keyed/list）、`:1134–1140`（shadowing 语义） |
| **组件替换**（整行换包） | 组合层 patch **不能改 `name`**（不匹配即跳过）；可行路径是 **insert 自己的行 + `disabled: true` 原生行** | **✅（用组合而非改名）** | `vendor/include/src/index.ts:77`（patch 形状）、`:105–121`（按 id 覆盖；`:116` name mismatch 跳过）、`:79–93`（insert 到根或组） |
| **覆盖组件属性（外观）** | ① 主题 token（`--dsw-*`）；② **组件局部自定义属性**（可继承，祖先可设）；③ `ThemeDefinition` / `ctx.theme.overrideTokens` | **✅ 两条通道** | `docs/web-styling.md:11`（组件可定义局部自定义属性）、`:18`（特性用语义别名）；实测 **70 个原生 CSS Module 定义 319 条局部自定义属性**；`ui-theme/src/client/index.ts`（`register`/`overrideTokens`） |
| **覆盖组件属性（React props）** | 无外部通道 ✗ | **❌**（除非该处本身有 owner props / slot 注入面，如我们的 seat 就带 `{workspaceId,label}`） | 组件 props 由渲染方给出，外部无法注入 |
| **覆盖组件布局** | ① 组件暴露的 `className`/`contentLayoutClassName` 等钩子（**仅当你自己渲染该组件时**）；② 组件读取的自定义属性（几何）；③ 整块替换 | **✅（①受限、②③可行）** | primitives 几乎都收 className 类钩子（`DisclosureRow` 15、`FileTypeIcon` 21、`ConnectionIndicator` 9…）；几何类局部属性实测如 `--dsh-frame-top-clearance`（ui-layout 发布）、`--dsh-chat-flow-gap: 6px`、`--dsh-table-spare` |
| **增加自定义布局** | slot 的 `children` **只能由声明者声明**（one declarer per slot）；无 seat 处插不进去 ✗ | **⚠️ 有 seat 才行** | `ui-slots/src/index.ts:1135–1136`（一个 slot 一个声明者）、`:1245`（重复声明抛错）。这正是 task14 必须**原生化**一个工作区行 seat 的原因 |
| **配置驱动 overlay** | 客户端插件 `Config`（schemastery）→ 设置页表单；运行时 `ctx.theme.overrideTokens` | **✅** | `ui-primitives` 的 `SettingsForm`/`settingsNumberField` 族；`ctx.theme.overrideTokens` |

## 关键机制细读

### 1. 组件替换：slot shadowing（最有力的落点）

```ts
// packages/client/ui-slots/src/index.ts:1278–1284
// Stable sorts: priority ascending for every kind, ties keep registration
// sequence — a cell's winner is its first occurrence ...
next.sort(spec.kind === 'list'
  ? (a, b) => ((a.options.priority ?? 0) - (b.options.priority ?? 0)) || ((a.options.order ?? 0) - (b.options.order ?? 0))
  : (a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0))
```

- **cell** 的定义：`single` → 槽本身；`keyed` → 同 `key`；`list` → 同 `id`。
- 同一 cell 的多个注册**共存**，按 `priority` 升序，**渲染最低的活跃项**；`priority` 默认 0，**同格同优先级抛错**（保住"无优先级即独占"的历史行为）。
- 含义：overlay 插件只需 `slots.inject('<slot>', () => slots.register({ name, id, priority: -1, ... }, OurComponent))` 就能**顶掉原生组件**，不需要改原生代码 ✓；原生注册仍活着（可被撤下后自动回退 ✓ —— 最低的**活跃**项渲染）。
- 对 `list` 槽，`priority` 与 `order` **是两个字段**：`priority` 决定谁在 cell 里胜出，`order` 决定列表显示次序（同优先级时用 `order` 细分）。

### 2. 组合层换行（不能改名，只能替位）

`applyEntryPatches` 的 patch 形状是 `{ id, insert, name, ...overrides }`：非 insert 的 patch 必须 `id` 命中，且**若写了 `name` 必须与目标一致**，否则跳过（`:116` name mismatch）。所以：

- ❌ 不能把原生行指向我们的包；
- ✅ 可以 `- insert: [我们的行]` + 对原生行 `disabled: true`（本分支 task16 就是这么换掉 `agent-instructions` 的）✓；
- ✅ 也可以只覆盖某个字段（如 `config`）✓。

### 3. 属性覆盖：**自定义属性是事实上的 overlay 协议**

`docs/web-styling.md:11` 允许组件定义局部自定义属性，且自定义属性**沿 DOM 继承**——因此祖先（我们的容器、或 `body` 级主题覆盖）可以设置它：

| 例子（实测） | 归属 | overlay 含义 |
|---|---|---|
| `--dsh-frame-top-clearance`、`--dsh-frame-overlay-top` | `ui-layout` 在根元素发布 | 视图在窗口里的位置可被覆盖 ✓ |
| `--dsh-chat-flow-gap: 6px`、`--dsh-table-spare` | 特性组件局部 | 该处的间距/宽度契约可被外部设定 ✓ |
| `--dsw-elevation-stroke-color`、`--dsh-scrollbar-thumb` | 组件在自己的容器上 rebind 主题 token | 逐面的材质/滚动条可被覆盖 ✓ |

**实测规模**：`packages/client` 的 228 个 CSS Module 中，**70 个定义局部自定义属性，共 319 条**——这些就是 overlay 可用的稳定"旋钮"。

## 缺口与边界（必须知道）

1. **React props 无外部覆盖通道**：只能靠 ① 该处是否暴露 owner props/slot 注入面 ② shadowing 整块替换。**这是"覆盖属性"场景最容易踩空的一点。**
2. **一个 slot 只能有一个声明者**：overlay 不能往别人的组件里**新插一个位置**；只能占用已声明的 seat，或 shadow 一个既有 cell（比如某个 `single` 面板，shadow 后整块区域归你，你就能在里面自由排布 ✓）。无 seat 的位置只能**原生化**（task14 的先例）。
3. **类名是构建哈希，不可作为选择器**：实测动态包产物形如 `.kQj6AG_rowCard{…}` —— CSS 层 overlay **不能**靠类选择器命中组件；必须用 token / 自定义属性 / 少量 `data-*` 钩子（如 `data-window-drag`、`[data-dsh-automatic-focus]`）。
4. **非主题插件"注入全局样式"没有明确合规路径**：`web-styling.md:11` 规定全局样式表归 `ui-theme/src/styles/`。overlay 若需要超出 token/自定义属性的选择器级覆盖，目前没有 sanctioned 通道（建议：优先用 token/自定义属性；确需时再与上游讨论新增 seam）。
5. **`ThemeDefinition` 是现成的主题 overlay 通道**：第三方主题 = alias 覆盖写成 `body` 内联变量，不需要改主题文件 ✓。

## 给 overlay / theme 插件的落点建议

| 目标 | 建议做法 |
|---|---|
| 改全站颜色/圆角/材质 | `ctx.theme.register(ThemeDefinition)` 或 `ctx.theme.overrideTokens` ✓ |
| 改某组件外观 | 优先找它读的自定义属性（319 条里通常有对应旋钮）；否则 shadowing 替换该 cell |
| 改某块布局 | shadow 一个 `single` cell，用自己的布局渲染该区域；或占用 `list` cell 追加自己的行 |
| 完全替换某组件 | `slots.inject` + `priority: -1`（同 `id`/同 slot）✓；原生仍在，撤下即回退 ✓ |
| 换掉某个原生插件行 | 组合层 `insert` 我们的行 + 对原生行 `disabled: true` ✓（不能改 `name`） |
| 让用户配置 overlay | 插件 `Config`（schemastery）+ `SettingsForm` 族 ✓，运行时落到 `overrideTokens` / 自定义属性 ✓ |

## 归入 task21 的结论

- **四类场景都有落点**，且**主要不依赖原生改动**：组件替换（shadowing）、外观覆盖（token + 319 条自定义属性）、布局覆盖（shadow 或组件钩子）；只有"在无 seat 处新增布局"需要原生化，而这已有先例与规则（最小插入 + 标记 + 登记）。
- **两个必须先补的能力**（若要做得干净）：(a) 一个"列出自定义属性/可用 cell"的**发现面**（overlay 插件要知道有哪些旋钮，目前只能读源码）；(b) 非主题插件的**样式注入合规通道**（若确实需要选择器级覆盖）。
