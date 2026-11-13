---
kind: upgrade-guide
description: "headless 的 --permission-mode 旗标及其旧配置键被移除；改用 --policy 与 policy。"
---

# 移除弃用的 `--permission-mode` 旗标

[English](guide.md) | 中文

## 变更

headless 单次运行应用不再接受 `--permission-mode`，headless 行也不再读取旧的 `permissionMode` 配置键。改用 `--policy` 与 `policy` 键。替代旗标在 v0.2.2-alpha.3 引入；本版本结束兼容窗口。

## 迁移

1. 把脚本、服务单元、CI 作业与 SDK 启动器中的 `--permission-mode` 换成 `--policy`。
2. 把 headless profile patch 与 Cordis overlay 中的 `permissionMode:` 换成 `policy:`。
3. 旧升级指南保留为历史记录；它们描述的是别名仍存在的版本。

## 验证

- `dsh --profile headless --help` 列出 `--policy`，不再列出 `--permission-mode`。
- `dsh --profile headless --policy guarded "run the tests"` 按选定策略运行。
- 仍设置 `permissionMode` 的 profile 会校验失败，而不是静默忽略旧键。
