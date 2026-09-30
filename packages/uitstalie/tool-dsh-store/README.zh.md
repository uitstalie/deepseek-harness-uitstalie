---
description: "工作区 .dsh 存储层说明，面向需要其路径拒绝矩阵、存储操作与后续模型工具的读者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-dsh-store

[English](README.md) | 中文

## 概述

`dsh-tool-dsh-store` 拥有工作区的 `.dsh` 目录——这个项目级约定已经在承载项目技能与运行时快照。它按一张固定的拒绝矩阵校验 `.dsh` 相对路径，并通过 `ctx.fs` 服务执行四个存储操作：建目录、写文件、查询目标、删除目标。本包目前只发布这一层；把它暴露给模型的**单个工具**属于后续工作，因此现在挂载它不会增加任何请求内容。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### .dsh 目录就是存储区

`.dsh` 已经是本仓库的项目级约定：项目技能在 `.dsh/skills` 下，工作区规则将放在 `.dsh/rules` 下，测试夹具写 `.dsh/runtime.json`。存储层只拥有这一个目录，调用方给出相对 `.dsh` 的目标，而不是自己拼绝对路径。

### 路径先校验再使用

`normalizeStorePath` 接受 `.dsh` 相对路径，并拒绝一切可能越出根、或在不同平台上指向别处的形态：POSIX 绝对路径与 UNC 前缀、Windows 盘符、`..` 逃逸、`~`、`$`、`%` 展开、Windows 保留设备名、非法字符，以及以点或空格结尾的段。重复分隔符、`.` 段与首尾空白只做归一而不拒绝，因为它们指向同一个目标。

### 存储操作

| 操作 | 函数 | 结果 |
|---|---|---|
| 确保根存在 | `ensureStoreRoot` | 本次调用是否创建了根目录 |
| 建目录 | `createStoreFolder` | `{ path, kind: 'directory' }` |
| 写文件 | `createStoreFile` | `{ path, kind: 'file' }` |
| 查询目标 | `queryStoreTarget` | 目标类型、直接子项，以及可选的正文 |
| 删除目标 | `removeStoreTarget` | `{ path, kind }`；非空目录需要 `recursive` |

每个操作接收的绝对路径都已由路径层限定在根内，配合 `FileSystem` 服务使用，因此 project root 的判定与会话策略都留在调用方。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`src/paths.ts` 把拒绝矩阵实现为不触碰文件系统的纯函数，因此矩阵的每一行都由单测钉住，而不是靠集成用例覆盖。`src/store-ops.ts` 把四个操作映射到 `FileSystem.mkdir`、`writeText`、`stat`/`listDir`/`readText` 与 `remove`，并返回具名的结果记录，让调用方读数据而不是读文件系统状态。`mkdir` 与 `remove` 是本分支为文件系统服务定义补上的可选原语；不支持它们的后端会拒绝调用并指名自己。

</details>

-----

<a id="model-experience"></a>
## 模型体验

无：本包目前只发布路径校验与存储操作，把它们暴露给模型的工具属于后续工作。

#### KV Cache 影响

无：本包不贡献任何请求内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明本包当前**有意不做**的事，是当前约束而不是待办清单。

- **尚无模型可见工具**——`tool-dsh-store` 工具（对 `.dsh` 相对路径执行创建、查询、删除）、它的会话策略门禁与命名空间校验是下一步；在那之前本包只是库。
- **根目录固定为 `.dsh`**——不做配置项，因此一个工作区只有一个存储区，调用方无法把操作指向别的目录。
- **不做内容校验**——存储层写入它所收到的一切；`.dsh/rules/**` 必须是 Markdown 且不得重复内容这条规则，属于创建它们的工具那一步。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

本开发备注是非权威的工作上下文：尚未决定的问题与方向。已发布行为与已确认的理由在上文各节与包内代码里。

- **模型工具、会话策略门禁与命名空间校验是下一步；在那之前本包只是库。**

</details>
