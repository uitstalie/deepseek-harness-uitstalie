---
description: "models.dev 目录服务说明，面向选择路由、刷新提供商元数据或排查磁盘缓存的读者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-models-dev

[English](README.md) | 中文

## 概述

`dsh-models-dev` 每个进程拉取一次 models.dev 目录、落盘缓存，并向构建 LLM 路由的包提供提供商与模型元数据。它回答同步查询——`getProvider`、`getModel`、`resolveModelDefaults` 与 `resolveExtraParams`——以及两个供 Web 设置页调用的 Remote 方法，并在每次采用新目录时发出 `models-dev/updated`。拉取失败时回退到缓存副本，再退到空目录，因此消费方永远得到回答而不是错误。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 服务提供什么

数据集的取值是 advisory 的：一条路由先解析成提供商 id，再解析出模型元数据、harness 形状的默认值（`contextWindow`、`maxTokens`、模态、推理）以及该提供商的额外请求参数。本服务从不改动调用方的路由；它只回答问题，并报告当前目录是怎麼取得的。

### 配置

只有来源与缓存两类旋钮可配，默认值适配普通开发机。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `sourceUrl` | models.dev API 端点 | 网络拉取的目录来源 |
| `cachePath` | `$DSH_HOME/cache/models-dev.json` | 跨重启保留的磁盘副本 |
| `cacheTtlMs` | `3600000` | 超过该年龄才再次尝试拉取 |
| `timeoutMs` | `10000` | 单次拉取的网络超时 |
| `routeAliases` | `{ 'deepseek-official': 'deepseek' }` | 路由名到数据集提供商 id 的映射 |
| `extraParams` | `{}` | 用户提供的按提供商/按模型的请求参数 |

### 刷新与缓存

首次请求或设置页触发加载；并发调用方共享同一次在途刷新。拉取成功即写缓存，拉取失败继续服务缓存副本，既失败又没有缓存时服务空目录——查询返回空而不是抛错。

-----

<a id="model-experience"></a>
## 模型体验

间接：经由它为 LLM 消费方解析出的模型路由、默认值与额外请求参数进入请求。

#### KV Cache 影响

无直接影响：本服务不贡献请求内容，它解析出的取值成为 LLM 消费方所拥有请求的一部分。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定目录可以被信任到什么程度。

- **只是 advisory 元数据，不是策略**——数据集里没有的路由或模型，只要显式配置就照常工作；目录只补调用方没说的部分。
- **只认一种数据形状**——只解析 models.dev 的载荷布局；换一个注册表就要另写解析器。
- **不碰凭据**——本服务只读公开元数据，从不接触 API key；凭据解析属于 credentials seam。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

本开发备注是非权威的工作上下文：尚未决定的问题与方向。已发布行为与已确认的理由在上文各节与包内代码里。

- **磁盘缓存只按路径做键；接入第二个目录源需要它自己的缓存标识。**

</details>
