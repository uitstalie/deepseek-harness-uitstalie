# task12 — 收敛「沙盒拒绝」误报导致的审批噪音

变更自 [task11](task11.md)：task11 记录了审批噪音与沙盒故障，但当时对根因的判断有误（详见下文「对 task11 结论的更正」）。本任务单承接其剩余目标并给出正确修法。

## requirement

用户反馈：设置了 `workspace-write` 之后仍然「动不动啥都审批」，期望只有真正写到工作区外的操作才需要审批。

## 根因（已实测取证）

审批只在模型**显式请求升权**（带 `sandbox_permissions`）时才触发（[`packages/sandbox/sandbox/src/escalation.ts:171`]）。因此「频繁弹审批」= 模型被反复诱导去升权。诱导来自**沙盒拒绝的误报**：

1. 各后端以 `denialSignatures` 声明自己的拒绝方言，Windows ACL 后端此前声明四条：
   `access is denied`、`access to the path`、`permission denied`、`operation not permitted`。
2. 分类只做**短语匹配 + 非零退出**，不看路径。任何打印这些短语的非零退出都被判成沙盒拒绝。
3. 误判为拒绝后，工具层追加拒斥 marker **和升权提示**（`escalationHintMarker`），直接把模型推向带 `sandbox_permissions` 重试 → 弹审批。

实测复现（命令与沙盒无关，只是打印文本并 exit 1）：

```
cmd /c "echo permission denied 1>&2 & exit 1"
→ [sandbox: file access denied under workspace-write mode]
→ [sandbox: escalation available — retry this exact command once with sandbox_permissions ... the approval prompt asks the user]
```

常见命中源：`ssh` 的 `Permission denied (publickey)`、包管理器的 `EACCES: permission denied`、工作区内文件**自身权限**导致的拒绝（沙盒根本没拦它）。

## 修改范围

分支自有文件：本任务单。

原生文件（均已用 `uitstalie-k3` 标记注释包围，登记如下）：

| 文件 | 位置 | 改动 |
|---|---|---|
| `packages/sandbox/sandbox/src/diagnostics.ts` | 文件末尾新增块 | 新增带路径证据的 `classifyDenial(exitCode, stderr, signatures, writableRoots)` 及其私有辅助；`matchesSignature` 保留不动 |
| `packages/sandbox/sandbox/src/index.ts` | 第 182 行 | 导出 `classifyDenial` |
| `packages/sandbox/sandbox-local/src/index.ts` | `DENIAL_SIGNATURES` 的 `'windows-acl'` 项 | 去掉通用短语 `permission denied` / `operation not permitted` |
| `packages/shell/bash-sandbox/src/helpers.ts` | `classifyDenial` | 改为委托共享实现，新增 `writableRoots` 参数 |
| `packages/shell/bash-sandbox/src/index.ts` | 导入、`processFacts` 形状、`execute`、`onProcessDone` | 派生并传递本次调用的授权根 |
| `packages/shell/pwsh-sandbox/src/helpers.ts` | 同 bash | 同 bash |
| `packages/shell/pwsh-sandbox/src/index.ts` | 同 bash | 同 bash |
| `packages/ptc-runtime/ptc-runtime-node/src/index.ts` | 导入、`execute`、`done` 帧处理 | 第三处短语匹配改为共享实现 |

### 收紧规则

- **`workspace-write`**：短语命中还不够，该行必须**举出一个不被本次授权根覆盖的绝对路径**。沙盒不可能拒绝授权根内的路径，所以「根内路径 + 拒绝短语」「没有路径 + 拒绝短语」都改判为非沙盒拒绝，不再给升权提示。
- **`read-only`**（授权根为空）：无路径可与短语矛盾，维持原有的「短语 + 非零退出」判定。这使得所有既有 read-only 快照与测试保持逐字不变。

## 对 task11 结论的更正

- task11 称「`escalationHintMarker` 在工作区内也被追加」——**不成立**。`fs` 栅栏只在越界或 `read-only` 抛 `FS_SANDBOX_DENIED`（`packages/fs/fs-sandbox/src/index.ts:140`），工作区内写不会走到 `mapError`；`packages/fs/tool-str-replace-editor/src/index.ts:86` 更是只加 marker、不加升权提示。原计划的「收敛 marker」无处可改，已作废。
- task11 称「新增 `approval-policy-guard` 插件拦截审批」——**不该做**。审批只由模型显式升权触发，拦到后回 `allowed-once` 等于自动批准把该次调用提到 `danger-full-access`，是安全回退。已作废。
- task11 记录的真实故障（`Win32 5`）根因是**环境**：工作区 DACL 只给调用账号继承来的 `Authenticated Users:(M)`，Modify 不含 `WRITE_OWNER`，而写 SACL 标签需要它。已用 `icacls <workspace> /grant '<account>:(OI)(CI)F'` 修复。

## 同时完成的回退

`packages/sandbox/sandbox-windows-acl/src/acl.ts`：回退 task11 中关于标签标志的两处改动，恢复 `mergeAndApply` 的 `labelEdit.kind === 'keep' ? DACL : DACL|LABEL` 与 `revokeWrite` 的 `{ kind: 'clear' }`（原写法本就是对的，改动使 `clear` 不再清 SACL，又用 `as never` 绕过）。**保留** `grantWrite` 的逐项幂等判定（部分落盘状态可自愈），该处标记注释随之保留。

## 验证

- `node --max-old-space-size=4096 ./node_modules/typescript/bin/tsc -b tsconfig.host.json` 通过（含 `tests/`）。
- `packages/shell/bash-sandbox/tests/sandbox.spec.ts` 的 `classifyDenial` 用例更新为新签名，并新增覆盖「根内路径不算拒绝 / 无路径不算拒绝 / 根外路径算拒绝」的用例。
- 断言 Windows ACL 签名列表的两处（`sandbox-local/tests/local.spec.ts`、`sandbox-windows-acl/tests/provider-chain.spec.ts`）随签名收窄更新。
- `snapshots/session/partial-landlock-child-failure`、`background-confinement-failure`、`snapshots/web/permission-policy-context` 均为 `read-only`，判定分支未变，预期输出不变。

## 待办

- 各包 README 的契约描述尚未同步（`dsh-sandbox`、`dsh-bash-sandbox`、`dsh-pwsh-sandbox`、`dsh-sandbox-local`、`dsh-ptc-runtime-node` 及其 `README.zh.md` 双语对）。
