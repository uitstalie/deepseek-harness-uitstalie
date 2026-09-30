---
description: "自有多协议 LLM 适配器说明，面向配置路由、凭据或 Models 设置条目的读者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-plus

[English](README.md) | 中文

## 概述

`dsh-llm-plus` 是本分支自有的 LLM 适配器。它支持四类提供商协议——OpenAI chat completions、OpenAI responses、Anthropic messages 与 Gemini——并把每条路由注册进 `ctx.llm`，因此 profile 可以触达出厂适配器未覆盖的提供商。所有路由都来自配置：没有内置路由，凭据只经 credentials seam 解析，设置页的修改无需重启即可到达运行中的适配器。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 何时选它

当工作区要通过这四类协议之一（含 OpenAI 兼容端点与 Anthropic 风格网关）访问提供商时选它。它不替换出厂的 DeepSeek 适配器；两者可以同时挂载，由模型选择决定会话使用哪条路由。

### 路由即配置

一条路由声明协议、base URL、模型 id 与可选的路由级字段；适配器把每条条目变成一个 provider 注册。结构性错误的路由会让挂载 fiber 直接失败，而不是静默注册一个坏 provider；profile 的 `routes` 对象是编辑路由的唯一位置。

### 凭据来自 seam

插件不读任何环境变量。它注入 `credentials`，并按每条路由声明的引用去解析，因此环境兜底、本地文件或远端授权流程都是 provider 的职责而不是适配器逻辑。需要交互式登录的提供商会注册 OAuth 流程，由设置页驱动。

### 活配置

路由表是 volatile 配置引用。Loader 提交只读变更时会发出 `loader/volatile-update`；插件重新解析该表并原子替换自己的注册，而配置钩子会在提交之前拒掉坏候选。

-----

<a id="model-experience"></a>
## 模型体验

间接：经由它注册进 `dsh-llm` 的提供商路由与请求字段进入请求，而请求组装由 `dsh-llm` 拥有。

#### KV Cache 影响

无直接影响：适配器转发已组装好的请求，它贡献的字段属于 `dsh-llm` 所拥有的请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定适配器当前能覆盖的范围。

- **只支持四类协议**——其它线格式需要新的协议模块及其请求/响应映射。
- **没有内置路由**——挂载了适配器却没有配置路由的 profile 触达不到任何提供商，这是有意为之。
- **目录元数据只是 advisory**——模型默认值在挂载 `dsh-models-dev` 时来自目录；没有它时只应用显式配置的字段。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

本开发备注是非权威的工作上下文：尚未决定的问题与方向。已发布行为与已确认的理由在上文各节与包内代码里。

- **设置页的路由表单与本包的路由 schema 必须同步演进，目前没有机制强制这一点。**

</details>
