---
description: "面向模型的 .dsh 存储工具与只读侧边栏 Remote，驱动存储原子包提供的 dshStore 服务。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-dsh-store

[English](README.md) | 中文

## 概述

`dsh-tool-dsh-store` 是工作区 `.dsh` 目录（承载项目技能与运行时快照的项目级约定）的模型面与侧边栏面。存储实现（`ctx.dshStore`、路径限定、带版本守卫的 `writeFile`、命名空间撰写校验与会话策略门禁）位于 [`@deepseek-ai/dsh-store-atom`](../store-atom/README.zh.md)，本包消费它。注册的 `tool-dsh-store` 工具在应用命名空间校验的前提下创建、查询与删除 `.dsh` 内容；`.dsh/memory` 对 memory 能力可写、对工具只读；插件同时提供 `remote.dshStore`，让 Web 侧边栏**无需会话**即可列出并读取某工作区的规则。

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

`.dsh` 已经是本仓库的项目级约定：项目技能在 `.dsh/skills` 下，工作区规则在 `.dsh/rules` 下，测试夹具写 `.dsh/runtime.json`。存储层只拥有这一个目录，调用方给出相对 `.dsh` 的目标，而不是自己拼绝对路径。`dshStore` 服务由 [`@deepseek-ai/dsh-store-atom`](../store-atom/README.zh.md) 提供并在此注入；下面的工具是它主要的模型面消费者。

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
| 带可选版本守卫写文件（仅服务侧可用） | `writeFile` | `{ path, version }`；`expected` 过期时以 `FS_STALE_VERSION` 拒绝 |
| 查询目标 | `queryStoreTarget` | 目标类型、直接子项，以及可选的正文 |
| 删除目标 | `removeStoreTarget` | `{ path, kind }`；非空目录需要 `recursive` |

`store-ops` 辅助函数接收的绝对路径已由路径层限定在根内，并配合 `FileSystem` 服务使用；`writeFile` 直接接收 `.dsh` 相对路径并自行解析，是拥有某个命名空间的插件所用的写路径。每次写操作都会带上调用会话解析出的策略，因此限定型后端围栏的是同一次调用。`memory/**` 区域可经服务写入，但对工具只读：`query` 可以到达，而 `create` 与 `delete` 会被拒绝。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

路径层、存储操作、命名空间撰写校验、策略门禁与 `dshStore` 服务都位于 [`@deepseek-ai/dsh-store-atom`](../store-atom/README.zh.md)，由该包的 README 记录；本包保留两个消费者。`src/tool.ts` 构建工具并持有 `memory` 保留规则：它拒绝该前缀上的 `create` 与 `delete`，因此保留规则位于工具层，而服务本身仍可写。`src/remote.ts` 是侧边栏使用的只读 Remote 命名空间：因为工作区行可能还没有会话，它按**工作区根**寻址；读取前先拿宿主的工作区注册表核对该根；它的列表就是指令加载器自己的保留集合，因此面板显示的正是进入模型的那一组。`src/index.ts` 注入 `ctx.dshStore`、注册工具并挂载 Remote；工具注册在 profile 层，因此 profile 里每个 agent 都能调用它。

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

- **内容校验覆盖 `rules` 与 `skills`**——`mcp.json` 刻意不校验：harness 里没有任何插件读它，为它写校验等于凭空发明一个约定，而不是保护已有消费者。
- **`memory/` 不区分大小写地匹配**——在大小写不敏感的文件系统上，`Memory/...` 与 `memory/...` 指向同一处，因此工具会拒绝 `memory`、`Memory` 及其所有子路径；服务本身仍为 memory 能力保留写入权限。
- **根目录固定为 `.dsh`**——不做配置项，因此一个工作区只有一个存储区。
- **只读会话不保留存储根**——创建它属于写操作，因此根会在会话首次可写时出现；在此之前查询会如实报告根不存在。
- **工具在 profile 内全局可见**——它注册在 profile 层，因此 profile 里每个 agent（含 `minimal` preset）都能看到它；上面描述的存储根仍随各自的会话解析。
- **省略 `expected` 时 `writeFile` 是无条件写入**——它直接创建或替换现有内容，不做过期校验；`createIfAbsent` 守卫是 `FileSystem.writeText` 的另一条映射，存储服务尚未暴露。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

本开发备注是非权威的工作上下文：尚未决定的问题与方向。已发布行为与已确认的理由在上文各节与包内代码里。

- **`mcp.json` 这个命名空间是否该存在**——需要先有一个消费它的插件，存储层才谈得上有意义地校验其内容。

</details>
