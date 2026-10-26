---
description: "面向运维者的 harness 主目录定时快照：在 $DSH_HOME 被删除或损坏后恢复会话、存储与 profile 配置。"
kind: "package-reference"
---

# @deepseek-ai/dsh-home-backup

[English](README.md) | 中文

## 摘要

`dsh-home-backup` 按固定间隔把 harness 主目录里的持久数据复制到 `$DSH_HOME` 之外的目录，并只保留有限份快照。一份快照完整复制配置的主目录条目——默认是 `sessions` 和 `storages`——加上每个 profile 的配置文件，凭据文件仅在明确开启时才复制。插件只运行在宿主侧：不提供工具、不注入提示词段落、不写 Session 事件，并为每份快照写一个 `manifest.json`，让恢复方知道快照里有什么。

## 目录

- [使用本包](#use-this-package)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 快照内容

快照递归复制每个配置的主目录条目，然后复制每个 `profiles/<name>` 目录的已知配置文件：`package.json`、`pnpm-workspace.yaml`、`cordis.yml` 和 `cordis.patch.yml`。profile 的依赖与构建产物被排除在外，因为它们可以重新安装。`manifest.json` 记录快照名、创建时间、来源主目录、已复制条目及其文件数与字节数，以及是否包含凭据。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `destination` | `<用户主目录>/dsh-backups` | 存放快照的目录，必须位于 `$DSH_HOME` 之外 |
| `intervalMs` | `1800000` | 快照间隔（至少一分钟） |
| `initialDelayMs` | `30000` | 第一份快照前的延迟；`0` 表示挂载即快照 |
| `retain` | `24` | 保留的快照份数（含最新一份） |
| `paths` | `["sessions", "storages"]` | 完整复制的主目录相对条目 |
| `profileConfig` | `true` | 复制每个 profile 的配置文件 |
| `credentials` | `false` | 复制 `.credentials.yaml`；仅当目标目录受保护时开启 |

每次运行先把快照写入同级的暂存目录，再重命名到最终位置，因此目标目录不会暴露写了一半的快照。失败的运行会清掉自己的暂存目录、通过宿主日志报告失败，并保留下一次定时运行。新快照落盘后，保留策略删除超出 `retain` 的最旧快照。

### 恢复

先停掉所有 `dsh` 进程，再把某份快照的 `sessions` 与 `storages` 目录复制回新的主目录；`manifest.json` 说明了快照的来源主目录与条目。恢复 profile 配置则是把 `profiles/<name>` 下的文件复制回该 profile 旁边，其依赖由 profile 管理器重新安装。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- **完整复制而非增量** — 每份快照都完整复制所选目录，磁盘占用随快照数 × 数据量增长，靠保留策略而不是增量存储来约束。
- **不做加密** — 快照就是普通文件副本。把目标目录放在受保护的卷上，并保持 `credentials` 关闭，除非该卷满足要求。
- **不是一致性快照** — 复制时正在写入的文件（例如活跃的会话日志）按读取到的内容落盘。快照是恢复材料，不是事务日志。
- **没有手动触发入口** — 调度是唯一入口；临时复制或恢复通过文件系统完成。
- **只在宿主进程运行时快照** — 定时器属于提供服务的进程，从不启动 `dsh` 的机器不会产生快照；若要求无人值守也持续备份，应改用操作系统级调度器。
- **重叠运行不做合并** — 如果一次快照比间隔更慢，下一次定时运行会照常开始；每次写到自己的目录，保留策略保留最新者。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

本开发备注是非权威的工作上下文：尚未决定的问题与方向。已交付行为与已接受的依据见上文与包代码。

- **增量快照与恢复命令是待定想法，不是决定。**
- **目标目录是用户配置而非派生路径；把该行挂到网络共享的部署自行负责该共享的保留策略。**

</details>
