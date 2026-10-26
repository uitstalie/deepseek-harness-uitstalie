---
description: "能力列表的浏览器面：一个设置段，列出 dafeiyu 注册的每个 provider 及其状态、启用开关与指向 provider 自己设置页的链接。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-dafeiyu

[English](README.md) | 中文

## 概述

`dsh-client-ui-dafeiyu` 是能力设置页。它列出注册到 `dafeiyu` 组织者的每个 provider，显示组织者报告的状态（`active`、`disabled`、`missing` 或 `failed`），经 `dafeiyu` 设置命名空间翻转组织者的启用门，并按 `settings.sectionId` 把 v2 provider 链接到它自己的设置段。它不持有能力数据，也不持有 provider 配置：状态来自只读的 `remote.dafeiyu` 命名空间，开关写的是与 profile 编辑相同的 volatile 配置。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>

## 使用本包

把这一行挂在挂载 `dafeiyu` 与各 provider 的同一个 web-app 层；它随后作为设置里的「能力」段出现。消费方不需要配置本包——它就是组织者自己的列表。

```yaml
- id: ui-dafeiyu
  name: '@deepseek-ai/dsh-client-ui-dafeiyu'
```

开关就是组织者门：关闭一个能力会销毁它的贡献并立刻从 agent 上撤销其工具；开启会重建贡献，且只有此后创建的 agent 才会收到。provider 配置从不在这里编辑：带 `settings.sectionId` 的 provider 会得到一个「打开设置」按钮，把设置面板切到那个段；没有的则不显示链接。

行显示契约版本 2 provider 的描述符 label 与 description，版本 1 回退到 id。配置里出现但插件行缺席的 id 报为 `未加载`，其开关被禁用。

<a id="understand-the-implementation"></a>

## 理解实现

`src/client/index.ts` 挂载生成的 `remote.dafeiyu` 贡献（若 carrier 已提供该命名空间则跳过），注册 `settings.capabilities` 文案字典，并占用设置段。门表单来自 `ctx.configForms.get('dafeiyu')`——组织者自己那一行的共享配置表单——因此开关与所有设置编辑器共享同一套 revision 栅栏与冲突恢复。

`src/client/store.ts` 持有页面状态：一次 `status()` 读取发布条目；`setEnabled()` 经该表单写入 `capabilities.<id>.enabled`，然后重复读状态，直到宿主侧的协调结果显示出请求的值（关门同步销毁；开门要等 provider 的 `create()`）。写入被拒会置 `refused`，抛错会置 `actionError`，两者都渲染成一条提示。

`src/client/CapabilitiesSection.tsx` 只做呈现：从注入面渲染状态徽标、描述、最近失败、开关与设置链接，每句文案都来自 `settings.capabilities` 字典。

<a id="model-experience"></a>

## 模型体验

### 没有模型面

#### 模型看到什么

什么都没有。本页是设置面；它不注册工具、prompt 段、context source 或会话消息，也从不写会话。它列出的能力工具与 prompt 段属于各 provider，只能经组织者到达 agent。

#### Token 影响

零。本页只改变某个 provider 贡献的内容，而那份内容归 provider 自己。

#### KV 缓存影响

没有直接影响。在这里关闭的能力会停止向新 agent 贡献工具与 prompt 段，从而改变那些 agent 构建的 prompt；已运行 agent 的既有 prompt 不会被改写。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与延期工作

- **本页不含 provider 配置** — jira 账本的 root、host 与 push 开关属于 `ui-jira` 的段；本页只链接过去。
- **启用不接线运行中的 agent** — 启用的能力只到达开关之后创建的 agent，不影响已在运行的 agent。
- **一次只允许一个开关** — 有一个写入在途时本页禁用所有开关，两个能力不会争同一 revision。
- **provider 缺席时仍显示开关** — 配置里的门可以改，但控件在其插件行加载前保持禁用。

<a id="dev-note"></a>

### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

本开发备注是非权威的工作上下文：尚未决定的问题与方向。已发布行为与已确认的理由在上文各节与包内代码里。

- **失败的开关是否需要 toast** — 提示会留在原地直到下一次操作；瞬时 toast 需要一个与设置 shell 共享的出口。

</details>
