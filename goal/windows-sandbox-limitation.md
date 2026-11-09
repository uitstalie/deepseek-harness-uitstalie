# Windows 原生沙箱的磁盘级限制

Status: **documented / constraint in force（2026/11/06）**
Jira: **DH-906** — 关联 DH-901（Low 完整性继承风险评估）、DH-902（home-write 入口禁用）、DH-803（home-write 设计）、DH-905（软沙箱 Phase 1a）
Contract: [docs/subsystems/sandbox.md](../docs/subsystems/sandbox.md#windows-acl-backend-limitation-disk-scoped-not-process-scoped)

本文记录 Windows ACL 沙箱后端的**根本性限制**：它改的是磁盘，不是进程。任何后续涉及沙箱的改动都必须先读本文与上面的契约节。本文是证据与复现记录，契约正文在子系统页。

## 1. 机制：写的是磁盘态

Windows 后端（`packages/sandbox/sandbox-windows-acl`）通过：

```text
SetNamedSecurityInfoW(..., LABEL_SECURITY_INFORMATION, ...)
```

给被授权的根写入一个**可继承**的 `SYSTEM_MANDATORY_LABEL_ACE`（Low，SID `S-1-16-4096`），并配合 DACL 的 grant/deny ACE。标签 ACE 带 `(OI)(CI)`（Object Inherit | Container Inherit），因此一次调用会把根下**已经存在的整棵子树**一起重标。

本机实测：一次 home 根授权后，连 `%TEMP%` 都变成

```text
Mandatory Label\Low Mandatory Level:(I)(OI)(CI)(NW)
```

即“整树重标”不是理论风险，是每次授权都会发生的事实。

## 2. 后果一：磁盘态持久，不会自动撤销

以下三种常见结束方式都**不会**恢复标签或 DACL：

- 会话正常结束；
- 切回 `workspace-write`（只停止后续 grant，不撤销已写入磁盘的标签）；
- provider 崩溃或异常退出（没有回滚路径）。

恢复只能手动、且需要提升权限：

```powershell
icacls "<root>"                                        # 查看强制标签与 DACL
icacls "<root>" /setintegritylevel "(OI)(CI)M" /T      # 恢复根及所有已存在子项（会递归）
icacls "<root>" /setintegritylevel "(OI)(CI)M"         # 只改根与未来子项
```

注意：

- `/T` 才会修已存在的子项；不带 `/T` 只改目标对象与继承标志。
- 恢复标签**不会**移除 DACL deny ACE；授权写入的 deny 需要另行移除（`icacls ... /remove:d ...`）。
- 恢复后注销或重启受影响程序，才能清掉“未知发布者”等缓存状态。

## 3. 后果二：标签会“传染”到进程（本机炸掉的直接原因）

关键语义：**Medium 进程启动一个带 Low 标签的可执行文件，子进程本身就是 Low。**

本机用 `whoami` 实测：在 Medium 父进程里启动 D: 盘上被标 Low 的 exe 后，子进程的完整性级别报 `S-1-16-4096`（Low）。

于是影响面从“工作区”扩大到“该盘上的所有程序”：

- **SP Flash Tool**（D: 盘，被标 Low）：写 `C:\ProgramData\...` 时报
  `boost::filesystem::create_directories: Permission denied`（Medium-only 路径对 Low 进程不可写）。
- **adb**：在同样的 Low 继承下写不了 `%TEMP%\adb.log`。

这不是“沙箱限制了某个工具的一次调用”，而是**磁盘标签把整台机器的程序降级**，直到手动恢复。

## 4. 后果三：作用域爆炸

工作区一选成 home 根或盘根，授权根就是整机/整盘，恢复要对整棵子树重标：

- 本机 `D:` 全盘恢复（`icacls "D:\" /setintegritylevel (OI)(CI)M /T`）实测约 **5 分钟**；
- 期间大量程序处于 Low，出现各种 `Permission denied`；
- 任何“选一次 home-write / 选一次盘根”的试验都会留下全盘副作用。

## 5. 约束（写死）

以后涉及沙箱的改动**必须**满足：

1. **不得**对 home 根、盘根或任何宽目录写完整性标签或 DACL 项。
2. 隔离**必须跟着进程走**：受限令牌（restricted token）、Job 对象、AppContainer、独立用户，或远程执行环境。
3. **必须可撤销、作用域最小**：离开会话、切换模式或崩溃后不得留下磁盘状态。
4. 若将来恢复基于 ACL 的后端，必须先用测试证明第 2、3 条（退出与崩溃都能清理、不做整棵子树重标），否则不允许重新暴露。

结论：Windows 上正确的方向是**进程级隔离**，不是给盘打标签。软沙箱（DH-905）明确放弃 OS 隔离并披露降级；真正需要隔离时，优先容器/VM/远程执行，或在 Windows 上使用跟随进程、可撤销的受限令牌/Job/AppContainer 方案。

## 6. 相关文件

- 契约节：[docs/subsystems/sandbox.md](../docs/subsystems/sandbox.md#windows-acl-backend-limitation-disk-scoped-not-process-scoped) / [sandbox.zh.md](../docs/subsystems/sandbox.zh.md#windows-acl-backend-limitation-disk-scoped-not-process-scoped)
- ACL 后端实现：`packages/sandbox/sandbox-windows-acl/`
- home-write 禁用记录：[home-write-disabled.md](home-write-disabled.md)（DH-902）
- 风险与恢复建议：DH-901；软沙箱设计：[soft-tool-policy-design.md](soft-tool-policy-design.md)（DH-904/DH-905）
- 构建工具链结论与默认软沙箱建议（建议/待实施）：[Windows super agent 评测 §3.8](../docs/reviews/windows-superagent-eval-2026-11-09.md#38-windows-沙盒结论workspace-write-acl-不适用于构建工具链应改用完全权限软沙盒)

2026-11-09 禁用旧后端的验证边界：`acl-disabled.spec.ts` 与 `runner-disabled.spec.ts` 各 2/2 通过，证明两种模式均在授权或启动子进程前拒绝。完整 Windows ACL 套件未通过：`probe.spec.ts` 的旧隔离用例观察到 `ESCAPE-WRITE: OK` 而非 DENIED，`control.spec.ts` 报 exit 127 / `write EOF`，`provider-chain.spec.ts` 因生产链为空抛 `SandboxUnavailableError`；这些旧用例与已禁用后端不再构成可运行的验收路径，不作为通过证据。`sandbox-local/tests/local.spec.ts` 属于本机排除的 POSIX 套件，未执行。
