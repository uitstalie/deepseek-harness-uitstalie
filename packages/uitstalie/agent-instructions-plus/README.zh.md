---
description: "支持 .dsh 规则的工作区指令加载器，面向衡量或排查进入模型内容的用户与维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-instructions-plus

[English](README.md) | 中文

## 概述

`dsh-agent-instructions-plus` 是本分支的工作区指令加载器。它原样挂载原生 `dsh-agent-instructions` 加载器，并追加一路始终在线的来源：`<projectRoot>/.dsh/rules` 下的每个 Markdown 文件，渲染进同一条持久基线消息。组合层会禁用原生行、改挂本包，因此同一条链不会被投递两次。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 它增加了什么

原生链——`$DSH_HOME/AGENTS.md` 加上项目链上的 `AGENTS.md`、`CLAUDE.md` 及各自的本地覆盖文件——与以往完全一致。本包增加的是工作区规则：`.dsh/rules` 下的每个 `.md` 文件（含嵌套目录），按路径顺序。

### 配置

原生段就是原生加载器自己的 schema，因此它的字段与默认值仍归它自己；规则段增加一份独立预算。

```yaml
- id: agent-instructions-plus
  name: '@deepseek-ai/dsh-agent-instructions-plus'
  config:
    agentInstructions:
      maxBytes: 65536
    rules:
      maxBytes: 16384
```

### 规则撰写约定

规则是纯 Markdown，没有 front-matter、也没有激活元数据：每个文件都始终生效，若某文件的内容在去掉首尾空白后与另一个重复，则只保留路径序里靠前的那个。这样整组规则容易推理——不存在会写错的逐文件作用域——这也是重复内容应当删除而不是改名的原因。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

插件把原生加载器作为子插件挂载，并在挂载**之前**注册自己的 `agent/pre-step` 监听器，因此该监听器包裹原生监听器：瀑布经 `next()` 到达原生加载器，规则段再并入原生加载器投递基线所用的那条通道——它返回的批次，或它在批次不拥有 step 时保留的 pending inbox。原生渲染被逐字复用，因此 AGENTS 部分与"只挂原生"的组合保持逐字一致；原生链不反应的规则改动会由本插件自己发出替换基线。

</details>

-----

<a id="model-experience"></a>
## 模型体验

### 工作区指令上下文

#### 模型看到的内容

首次请求前的一条持久 user 消息，以 `<system-reminder>` 框住：先是原生链，随后是每个保留下来的规则文件对应的 `Instructions from: .dsh/rules/<name>` 段。读取更深的目录可以把嵌套的 `AGENTS.md` 作为后续更新加入；编辑规则会重发完整基线，因此模型不会依据已被取代的规则工作。

#### Token 影响

受两份互相独立的预算约束：原生链保持它的 `maxBytes`，规则段保持 `rules.maxBytes`。渲染器先省略较宽泛的文件、再截断最具体的文件，因此没有任何配置会静默丢弃某条规则。

#### KV Cache 影响

基线只投递一次，在首次请求之前，因此它扩展可复用的前缀。编辑规则会发出替换基线并使该点之后的可复用性失效——这正是规则预算刻意取小的原因。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明当前行为。

- **规则始终生效**——没有逐文件作用域、glob 或激活开关；只在某些场合适用的规则必须在正文里自己说明。
- **按内容去重，而不是按意图**——用不同措辞表达同一件事的两条规则都会被投递；只有去除首尾空白后完全相同的才会合并。
- **复用原生加载器而非复制**——它的入口导出了本插件所组合的内部实现，这避免了两份实现漂移，但也让本包依赖那份导出清单。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

本开发备注是非权威的工作上下文：尚未决定的问题与方向。已发布行为与已确认的理由在上文各节与包内代码里。

- **规则改动会整条重发基线；要做逐文件增量，需要先给规则定义作用域模型。**

</details>
