---
description: "工作区 .dsh 存储层说明，面向需要其路径拒绝矩阵、存储操作与模型可见工具的读者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-dsh-store

[English](README.md) | 中文

## 概述

`dsh-tool-dsh-store` 拥有工作区的 `.dsh` 目录——这个项目级约定已经在承载项目技能与运行时快照。它按一张固定的拒绝矩阵校验 `.dsh` 相对路径，通过 `ctx.fs` 服务执行四个存储操作，并注册**一个**模型可见工具来按需执行它们。同时它负责让每个会话的存储根存在，并在会话不可写时跳过这次创建。

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

`.dsh` 已经是本仓库的项目级约定：项目技能在 `.dsh/skills` 下，工作区规则在 `.dsh/rules` 下，测试夹具写 `.dsh/runtime.json`。存储层只拥有这一个目录，调用方给出相对 `.dsh` 的目标，而不是自己拼绝对路径。

### 工具做什么

注册的 `tool-dsh-store` 工具接收 `create`、`query` 或 `delete` 三种 `action`，以及相对 `.dsh` 的 `path`。`create` 写文件或建目录，`query` 列目录或读文件，`delete` 删除文件或目录——只有同时给出 `recursive` 时才允许删除非空目录。创建规则会先校验 `rules` 命名空间：目标必须是 Markdown、正文不得为空、正文不得与已存在的规则重复。写技能会校验技能根所需的文档：路径必须是它发现的两种形态之一、front-matter 必须是映射、`name` 必须是小写单词以单个连字符连接（`skills/review.md`、`skills/handoff/SKILL.md`）。

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

每个操作接收的绝对路径都已由路径层限定在根内，配合 `FileSystem` 服务使用；写操作还会带上调用会话解析出的策略，因此限定型后端围栏的是同一次调用。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`src/paths.ts` 把拒绝矩阵实现为不触碰文件系统的纯函数，因此矩阵的每一行都由单测钉住，而不是靠集成用例覆盖。`src/store-ops.ts` 把四个操作映射到 `FileSystem.mkdir`、`writeText`、`stat`/`listDir`/`readText` 与 `remove`，并返回具名的结果记录，让调用方读数据而不是读文件系统状态。`src/policy.ts` 在每次写操作前解析一次会话策略，并用共享的拒绝标记拒绝 `read-only` 会话；查询不过这道门禁，因为读取不会写存储区。`src/tool.ts` 定义工具并约束 `rules` 命名空间，`src/index.ts` 按会话解析 `<projectRoot>/.dsh`——从 `cwd` 向上找 `.git` 标记，找不到则退化为 `cwd`——并在会话可写时创建它。

</details>

-----

<a id="model-experience"></a>
## 模型体验

### 工作区存储工具

#### 模型看到的内容

一个名为 `tool-dsh-store` 的工具：必填的 `action` 取 `create`、`query` 或 `delete`，必填的 `path` 相对 `.dsh`，另有可选的 `target`、`content` 与 `recursive`。每次调用返回一句短文本——`Created file .dsh/rules/api.md.`、`Deleted directory .dsh/rules.` 或 `Not found: .dsh/rules/absent.md.`——目录查询则把直接子项列为 `- file .dsh/rules/api.md (24 bytes)`。

#### Token 影响

工具可见时每次请求都有固定的 schema 开销。结果本身很小：目录查询随直接子项数量增长，文件查询返回该文件的完整正文。

#### KV Cache 影响

在定义与可见性不变时前缀稳定。结果只是追加在可复用前缀之后的普通工具结果，不会使更早的条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明本包当前**有意不做**的事。

- **命名空间校验覆盖 `rules` 与 `skills`**——`mcp.json` 刻意不校验：harness 里没有任何插件读它，为它写校验等于凭空发明一个约定，而不是保护已有消费者。
- **根目录固定为 `.dsh`**——不做配置项，因此一个工作区只有一个存储区。
- **只读会话不保留存储根**——创建它属于写操作，因此根会在会话首次可写时出现；在此之前查询会如实报告根不存在。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

本开发备注是非权威的工作上下文：尚未决定的问题与方向。已发布行为与已确认的理由在上文各节与包内代码里。

- **`mcp.json` 这个命名空间是否该存在**——需要先有一个消费它的插件，存储层才谈得上有意义地校验其内容。

</details>
