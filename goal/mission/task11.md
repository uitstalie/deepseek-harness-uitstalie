# task11 — 收敛 workspace-write 下的审批噪音，并修掉 Windows 沙盒的误报

## requirement

用户反馈：当前沙盒在已设 `workspace-write` 的情况下仍频繁弹审批，且 `workspace-write` 下的误报（工作区内的正常写也被引导去升权）让模型走不该走的 `danger-full-access` 路径。同时 Windows ACL 沙盒有几个已实证的执行层 bug（stdio 管道 EPERM、DACL 写入失败、pnpm postinstall 被拒），这些 bug 会让模型误判需要升权。

目标：**workspace-write 下，工作区内的文件操作不再触发审批提示；只有真正越界（写工作区外）才弹审批。** 同时把已实证的 Windows 执行层 bug 列入修复范围。

## 修改范围

- 新增分支自有文件：
  - 本任务单 `goal/mission/task11.md`
  - 新包 `packages/uitstalie/approval-policy-guard/`（`@deepseek-ai/dsh-approval-policy-guard`）：拦截 `ctx.approval.request` 的 Consumer——`workspace-write` 且目标在工作区内时直接 `allowed-once`，不弹审批
  - 任务单内附带的调研结论（见下）

- 修改原生文件（带 `uitstalie-k3` 标记注释，登记于此）：
  - `packages/fs/tool-fs/src/sandbox.ts`：`mapError` 在 `workspace-write` 且目标在工作区内时不再追加 `escalationHintMarker`（这个提示只该在真正越界时出现）
  - `packages/fs/tool-str-replace-editor/src/index.ts`：同上，marker 拼接点收敛

## 调研结论（已核到行）

### 审批触发链

1. `packages/sandbox/sandbox-policy/src/index.ts:47`：`workspace-write` 的提示词声明「may modify files under the session workspace」
2. `packages/fs/fs-sandbox/src/index.ts:122`：fs 栅栏在工作区/临时目录内直接放行，只有越界才抛 `FS_SANDBOX_DENIED`
3. `packages/sandbox/sandbox/src/escalation.ts:171`：`approveEscalation()` 只在模型显式带 `sandbox_permissions` 时触发审批
4. `packages/fs/tool-fs/src/sandbox.ts:129`：栅栏拒绝后**无条件**追加 `escalationHintMarker`，即使操作本就在工作区内——这是误导模型去升权的噪音源

### Windows ACL 沙盒已实证的 bug

| 现象 | 根因 | 位置 |
|---|---|---|
| `git fetch` 报 `couldn't create signal pipe, Win32 error 5` | 受限 token 默认 DACL 不含 restricting SID，子进程创建匿名管道被拒 | `sandbox-windows-acl/src/token.ts:96-107` |
| `Get-ChildItem goal -Recurse` 报 `SetNamedSecurityInfoW failed (Win32 5)` | 带空格路径（`deepseek-harness-uitstalie - 副本`）上 grant 时 DACL 写入失败 | `sandbox-windows-acl/src/acl.ts` |
| pnpm postinstall 里 `esbuild`/`koffi` 报 EPERM | 同上：沙盒子进程再 spawn 时被拒 | 同上 |

### 设计结论

- 审批噪音的主因不是栅栏设计，而是：**(a)** 执行层 bug 让正常操作失败 → 模型误判需要升权 → 弹审批；**(b)** `escalationHintMarker` 在工作区内也追加，诱导模型走 `danger-full-access`。
- 修 (a) 需要改 `sandbox-windows-acl` 的 token/ACL 实现（原生，范围大，留后续 task）；修 (b) 是两处单行收敛 + 一个分支自有 guard，这次做。

## 验证

- `approval-policy-guard` 单测：workspace-write 下工作区内操作不弹审批、越界操作仍弹、read-only 下全部弹
- 原生收敛后跑 `packages/fs/tool-fs` 与 `packages/fs/tool-str-replace-editor` 的既有测试
- 真实手验：`dsh web` 里 workspace-write 模式下写工作区文件不再弹审批

## 实测结果（2026/09/28）

真实根因不是代码，而是**环境前置条件**：

工作区根目录 `D:\dqc\deepseek-harness-uitstalie - 副本` 的 DACL 中，调用账号
`TS-20240229UGAL\TS`（`S-1-5-21-3439173371-1754965139-4214953713-1001`）只持有继承来的
`NT AUTHORITY\Authenticated Users:(I)(M)`（Modify）。Modify 不含 `WRITE_OWNER`，而 Low
强制标签写在 SACL 上，`SetNamedSecurityInfoW` 写 SACL 需要 `WRITE_OWNER`，于是授权在写标签
那步被拒（`Win32 5`），fail-closed 在命令启动之前就中断。这正是本包
`README.md:122`「被授权目录必须由调用者拥有并授予 `WRITE_OWNER`」记录的边界。

修复（一次性环境修复，代码无需改动）：

```powershell
icacls '<workspace>' /grant '*S-1-5-21-3439173371-1754965139-4214953713-1001:(OI)(CI)F'
```

授权成功后根目录与整棵树落齐三件套 + 标签：
`TS:(OI)(CI)(F)`、能力 SID `(W,D,DC)`、`Everyone:(CI)(DENY)`、
`Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`（子目录以 `(I)` 继承）。

实测（`workspace-write`）：

| 用例 | 结果 |
|---|---|
| 写工作区内文件 `goal\test-write.txt` | 成功，删除成功 |
| 写越界路径 `D:\dsh-out-of-workspace.txt` | `UnauthorizedAccessException`，正确拒绝 |

### acl.ts 改动的定位更正

此前的 `grantWrite` / `mergeAndApply` / `revokeWrite` 改动（task11 的首个提交）**不是本次故障的
修复**：故障当时的目录状态是「有 grant ACE、缺 deny、缺 label」，即便按新代码分别补缺，仍要
补 deny 并写 label，一样会撞 SACL 写权限。该改动保留为次要健壮性改进（label 已立时不再重写
SACL，避免整棵树 eager 重传播），但不应据此认为 Win32 5 已被代码修掉。

### 待办

- `approval-policy-guard` 插件尚未实现（审批噪音收敛部分）。
- `escalationHintMarker` 在工作区内也追加的两处收敛尚未实现。
