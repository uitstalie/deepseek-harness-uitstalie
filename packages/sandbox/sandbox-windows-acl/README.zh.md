---
description: "已禁用的 Windows ACL 隔离原语，以及修复 Windows 文件权限的诊断技能。"
kind: "package-library"
---

# @deepseek-ai/dsh-sandbox-windows-acl

[English](README.md) | 中文

## 概述

本包保留 Windows ACL 原语与 ACL 诊断技能，但受限执行已禁用。旧实现写入工作区的 Low 标签与 Everyone 删除拒绝项也会影响普通用户进程；Medium 受限令牌无法维持原有写入边界。`dsh-sandbox-local`、直接调用 runner 与公开 `AclSandbox` 构造都会在修改目录或启动命令之前拒绝。新的授权辅助函数只修改能力 SID 允许 ACE：绝不写入 Low 标签或 Everyone 删除拒绝项。

## 目录

- [修复权限](#repair-permissions)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="repair-permissions"></a>
## 修复权限

随包发布的 `diagnose-windows-sandbox-acl` 技能检查请求路径及每一级祖先。它在有效 `WRITE_DAC` 或 `WRITE_OWNER` 缺失处补充当前用户的完全控制允许 ACE，并在来源处移除显式 AppContainer 包允许 ACE。它保留拒绝项、所有者、继承和完整性标签。每次 DACL 改动都先备份再复读，确认后才会报告成功。

脚本拒绝重解析路径、受管理的应用目录和授权根之外的对象。修复失败时按相反顺序恢复尝试修改的内容。请在不提权的非受限进程中运行，再重试原始受限操作；权限改动通过验证并不单独证明原始故障已消除。

当 `dsh-sandbox-local` 挂载内置 Windows 支持且技能注册表可用时，`registerAclDiagnosisSkill` 会贡献此技能。注册时提取供外部 PowerShell 使用的资源，ASAR 与 SEA 部署也适用。fiber 释放时注销提供方并删除副本。

## 模型体验

间接地通过随包诊断技能的目录条目，以及 `dsh-sandbox-local` 提供的后端不可用诊断呈现。

#### KV Cache 影响

Windows 上存在一个目录条目。资源提取不会使请求前缀失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **内置 runner 不可用**——在替代实现既能保留普通用户权限又能强制执行模式的文件操作之前，本包不提供 Windows 受限执行。
- **诊断保留完整性标签**——它不会修复退役 runner 留下的 Low 标签。非正常退出后可能残留恢复目录和脚本。
- **诊断需要非受限调用方**——其安全描述符操作在受限进程中会失败。审批是否可用决定操作能否继续。

<a id="dev-note"></a>
### 开发备注

无。
