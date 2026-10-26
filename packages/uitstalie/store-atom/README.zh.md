---
description: ".dsh 存储原子：dshStore 基础接口——项目根发现、路径围栏、命名空间作者校验，以及带版本守卫的读写。"
kind: "package-reference"
---

# @deepseek-ai/dsh-store-atom

[English](README.md) | 中文

## 概述

`store-atom` 拥有 `ctx.dshStore` 背后的 `.dsh` 存储实现：项目根发现、路径围栏、存储操作、rules/skills 命名空间作者校验，以及按会话的沙箱策略门。能力提供方通过这个接口写自己的存储区域，不再各自拼存储路径或重实现拒绝矩阵；`@deepseek-ai/dsh-tool-dsh-store` 中面向模型的工具与只读侧边栏 Remote 也驱动同一份实现。

它提供 `ctx.dshStore`，自身没有模型面。分支组合层在 `web-app` 里把它挂在消费它的工具行之前；消费方声明 `inject: ['dshStore']`。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

## 使用本包

<a id="use-this-package"></a>

每个组合层挂一次，且在任何 `ctx.dshStore` 消费方之前：

```yaml
- id: store-atom
  name: '@deepseek-ai/dsh-store-atom'
  config:
    ensureRoot: true
```

提供方随后用存储相对路径读写自己的区域：

```ts
const read = await ctx.dshStore.readFile(session, 'memory/sessions/MEMORY.md', { signal })
const written = await ctx.dshStore.writeFile(session, 'memory/sessions/MEMORY.md', text, {
  expected: read.version,
  signal,
})
```

`expected` 是先前读取返回的版本；省略即无条件写入。并发写入方会以 `FS_STALE_VERSION` 暴露，而不是静默覆盖。`ensureRoot` 控制可写会话是否在第一步之前创建 `<projectRoot>/.dsh`。

## 理解实现

<a id="understand-the-implementation"></a>

- `src/service.ts` —— 服务本体：根解析、各项操作、策略门，以及 `dshStore` 接口。
- `src/paths.ts` —— 存储相对路径的规范化与围栏，拒绝绝对路径、`..`、盘符与保留设备名。
- `src/namespaces.ts` —— `rules/**` 与 `skills/**` 的作者校验，以及存储工具可读但不可改的 `memory` 区域。
- `src/policy.ts` —— 解析会话的沙箱策略，并对 `read-only` 会话的变更抛出共享拒绝标记。
- `src/store-ops.ts` —— 服务与 Remote 共用的文件系统操作。

工作区存储根是 `<projectRoot>/.dsh`，项目根由会话 cwd 按 `.git` 标记发现。任何会话模式下都可以读；写要过会话的策略门。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **目前只有 workspace scope。** 设计中的 `global` scope 以 `$DSH_HOME` 为根，尚未实现：personality 的 `globalPath` 允许指向 `$DSH_HOME` 之外，这个契约要先定。
- **每次调用都需要会话。** 根解析与写入门都来自会话的项目与策略；宿主侧写入方还没有无会话路径。

## 开发备注

<a id="dev-note"></a>

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

本包从 `@deepseek-ai/dsh-tool-dsh-store` 抽出，让存储实现被复用，而不是从工具包导入。面向模型的工具与 Remote 留在工具包里作为消费方。

</details>
