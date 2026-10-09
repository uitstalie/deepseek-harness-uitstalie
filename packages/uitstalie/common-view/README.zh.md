---
description: "本分支面向原生 Web 视图的 overlay 框架：一次接管一个 view，并通过 slot、主题 token 与组件局部自定义属性提供其 overlay。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-common-view

[English](README.md) | 中文

## 概述

`dsh-client-common-view` 是本分支面向原生 Web 视图的 overlay 框架：它**一次接管一个 view**，并通过仓库既有的接缝为其提供 overlay——slot 注册（编组与替换）、主题 token，以及内联设置的组件局部自定义属性。它借用了 Android 的形态：`ui-primitives` 与 slot 声明相当于框架的 view 模板，而 slot shadowing 相当于 `OverlayManagerService`——`priority` 更低的注册赢得该 cell，撤下它即恢复原生占用者。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 接管的 view

本包接管会话行的动作列表（`sidebar.workspaces.session.row.action`，由 `ui-workspace` 声明）。它的两项贡献是插件行配置上彼此独立的开关：

| 配置字段 | 默认值 | 作用 |
|---|---|---|
| `sessionRowAction` | `true` | 把 overlay 的标记插入该行的动作列表，位置在原生 `archive`（`order` 100）与 `pin`（`order` 200）之间。 |
| `takeoverArchive` | `false` | 以 `priority: -1` 注册原生 `archive` 所占据的同一 cell，于是由 overlay 的组件渲染，而原生注册仍然存活，可即时回退。 |
| `accent` | `var(--dsw-alias-state-business-primary)` | 两项贡献所用的颜色。它以元素上内联设置的 `--dsh-common-view-accent` 自定义属性进入组件 CSS，绝不在样式表里写成字面色。 |

因为未声明 `config` 的行会把 `undefined` 交给浏览器半边，浏览器半边先经 `resolveCommonViewConfig` 解析收到的值；两侧的默认值都读自 `src/config.ts`。

<a id="model-experience"></a>
## 模型体验

无，因为本框架只注册浏览器侧的视图贡献；它不新增工具、不新增提示段，也不新增上下文内容。

#### KV Cache effect

无：overlay 不改变任何模型输入。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **资源覆盖要求注册在"读取该属性的元素"的同级或祖先。** 自定义属性会继承，因此位于视图内部的贡献只能给自己着色；要覆盖某一行或某个列表自身的资源，需要该层级的 cell，而当前接管的 view 没有提供。
- **React props 没有外部通道。** 视图的 props 由渲染它的那一方决定，因此要改 props 就得占用渲染它的那个 seat。
- **构建哈希类名不能当选择器。** 因此 overlay 只使用 token、自定义属性以及少量稳定的 `data-*` 钩子，绝不用以组件类名为键的样式规则。
- **一个 slot 只有一个声明者。** 框架能占用已声明的 cell；要在别人的组件里新增一个位置，仍需该包自己声明。
- **接管项是一个样例。** 它的存在是为了端到端跑通 shadowing 路径；真正接管的 view 应对应一个具体需求。

-----

<a id="dev-note"></a>
### 开发备注

设计、Android 概念映射、逐 view 的方法（每个 view 一个适配器模块，含其结构与资源清单）与切片计划，都随本分支的设计记录存放；任务单与第一个 view 的研究同样如此——它们由任务单记录具名指出，而不从这个公开 README 外链。
