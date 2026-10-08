---
description: "Web 侧边栏 rules 按钮说明，面向查看工作区 .dsh 规则的用户与接线工作区行 seat 的维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-tool-dsh-store

[English](README.md) | 中文

## 概述

`dsh-client-ui-tool-dsh-store` 给 Web 侧边栏的每个工作区行加一个按钮，位置在该行"新建会话"按钮右侧。按钮打开一个**只读**面板，展示该工作区的 `.dsh` 规则：指令加载器真正注入的那些规则文件，每个都能就地阅读。数据来自存储层的 Remote 命名空间（`remote.dshStore`），因此列表就是宿主自己加载的那一组，面板也无法写入任何东西。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 按钮出现在哪里

插件占用 `sidebar.workspaces.row.action`——一个由工作区行渲染在其动作组中、紧跟"新建会话"按钮之后的 list seat。该 seat 的 owner share 带上工作区身份与标签，因此占用方不需要自己查表；未分组桶没有工作区，也就不渲染任何占用方。

### 面板展示什么

点击按钮会列出每条保留规则的路径与字节数，选中其一即在列表下方读出该规则正文。列表就是指令加载器自己的保留集合——同样的扫描、同样的跨文件内容去重——因此面板显示的正是进入模型的那组规则；空工作区会如实说明，而不是报错。

### 数据与失败

面板经 `remote.dshStore.listRules` 与 `readRule` 读取；插件在 `apply` 里先自己挂载该 Remote，再在内层作用域等待它。Remote 调用解析为判别式结果，因此"工作区被拒"或"规则读不出来"都以面板文案呈现，而不是抛异常。本包不写任何东西，工作区身份由宿主拿自己的注册表核对。

-----

<a id="model-experience"></a>
## 模型体验

无：浏览器侧边栏面板只经存储层的 Remote 命名空间读取规则，不贡献任何请求内容、也不写入。

#### KV Cache 影响

无：面板不改变任何模型输入。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明面板当前的范围。

- **只读**——按钮只展示规则；创建、编辑、删除走模型可见的存储工具。
- **不主动刷新**——列表在面板打开时加载；同一会话里新建的规则要重开面板才出现。
- **平铺列表**——规则路径不按目录分组；在 `.dsh/rules` 保持浅层时够用。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

本开发备注是非权威的工作上下文：尚未决定的问题与方向。已发布行为与已确认的理由在上文各节与包内代码里。

- **挂载路径**——本包目前与其它分支自有 client 插件一样，经本机 profile patch 挂载，而不是进入出厂的 Web bundle。

</details>
