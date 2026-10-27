---
description: "The host environment atom: platform facts, path spelling and comparison rules, environment lookup, and the user and Harness home directories, provided as ctx.systemEnvironment."
kind: "package-reference"
---

# @deepseek-ai/dsh-system-environment

[English](README.md) | 中文

## 摘要

`dsh-system-environment` 提供 `ctx.systemEnvironment`：分支插件询问平台、路径拼写与比较、环境变量以及用户 home 与 Harness home 的唯一入口。两套规则（`win32` 与 `posix`）在任意宿主上都可用，因此 Windows 行为可以在 Linux 上测试，反之亦然。它没有模型面，也没有 UI；需要比较路径或展开 `~` 的插件注入这个服务，而不是各自 import `node:path` / `node:os` 再把同一个问题决定第二遍。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>

## 使用本包

在任何消费者之前挂载这一行：

```yaml
- id: system-environment
  name: '@deepseek-ai/dsh-system-environment'
```

插件声明 `inject: ['systemEnvironment']`，然后问服务，而不是重新推导：

```ts
const under = ctx.systemEnvironment.isUnder(workspaceRoot, candidate)
const home = ctx.systemEnvironment.dshHome()
const programFiles = ctx.systemEnvironment.env('ProgramFiles')
const same = ctx.systemEnvironment.samePath(left, right)
```

`platform` 与 `env` 是行的测试缝：默认都取运行宿主，固定它们就是在 Linux 上验证 Windows 规则（反之亦然）的方式。

<a id="understand-the-implementation"></a>

## 理解实现

`src/index.ts` 从解析出的平台构造一个冻结值：

- `normalizePath` 是比较拼写：平台方言规范化分隔符、去掉结尾分隔符、Windows 折叠大小写。`samePath` 与 `isUnder` 都定义在它之上，因此同一条路径不会被两种方式比较。`isUnder('/a/b', '/a/bc')` 为 false；`C:\` 这类以分隔符结尾的根也已处理。
- `env(name)` 在 POSIX 上是精确查找，在 Windows 上不区分大小写，因为操作系统如此。
- `homeDir()` 取 `HOME`，Windows 上取 `USERPROFILE`（其次 `HOME`）；`dshHome()` 走共享的 `resolveDshHome`（`$DSH_HOME`，否则 OS home 下的 `.dsh`）。
- `path`、`separator`、`delimiter` 暴露方言本身，供需要构建而不只是比较的调用方使用。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与延期工作

- **不做文件系统操作。** 这里只是查找与比较，不是针对磁盘的解析：需要证明目标存在的消费者仍然自己 stat。
- **默认 Harness home 跟随 OS home。** 只覆盖 `HOME` 的测试，`dshHome()` 仍会看到真实 OS home，除非固定 `DSH_HOME` 或使用 `env` 缝。
- **消费者仍各自携带路径规则。** sandbox 诊断、home-backup 与 store-atom 目前各自拼路径比较；把它们迁到本服务另行跟踪，且不得改变行为。
