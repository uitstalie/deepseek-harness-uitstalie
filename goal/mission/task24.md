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

## 验证（每片固定）

`tsc` 两面 ✓ · 该 view 的装配测试（开/关两态）✓ · `pnpm run build` ✓ · `test:gui` 无新增失败 ✓ · README 三件套与 i18n 记录 ✓。
