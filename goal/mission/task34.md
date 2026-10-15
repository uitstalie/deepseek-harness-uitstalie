# task34 — Windows 沙箱工作区授权失败时给出可执行的报错

**变更自**：无（新方向：沙箱可观测性）。关联用户报告（2026/10/12）：在 `D:\1234` 跑一条只读 pwsh 命令时，seam setup 报
`Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\1234)`。
**类型**：新 mission。
**原生文件改动**：**1 处**（`packages/sandbox/sandbox-local/src/index.ts`，带 `uitstalie-k3` 标记）；无清单/manifest 改动。

## 调查结论（1/2/3）

1. **成立（本次修）**：报错只有 Win32 原始形态 —— [`subprocess/win32-process/src/errors.ts:8`](../../packages/subprocess/win32-process/src/errors.ts#L8) 的 `Win32Error` 拼出
   `${api} failed (Win32 ${code}): ${detail}`，`detail` 由 [`sandbox-windows-acl/src/acl.ts`](../../packages/sandbox/sandbox-windows-acl/src/acl.ts) 传 `` `grantWrite(${path})` ``。用户看不出**缺什么权利**、也看不出**下一步做什么**。
2. **不成立（我先前判断错误，已更正）**：seam **已按策略模式分流** —— [`sandbox-local/src/index.ts:373-392`](../../packages/sandbox/sandbox-local/src/index.ts#L373) 的 `windowsAclRunnerArgv()` 在 `sessionId === undefined || policy.mode === 'read-only'` 时**根本不物化任何授权**，只传 `--mode read-only`；只有 **workspace-write 策略**才在首次受限调用时物化**常驻**的工作区授权（[`materializeAclGrant()`](../../packages/sandbox/sandbox-local/src/index.ts#L407)）。
   ⇒ 用户那条命令只读却触发授权，是因为**会话策略是 workspace-write**（沙箱约束的是"能力"而非"命令意图"，无法预知某条命令只读）。这是**刻意的 fail-closed**（[`sandbox-windows-acl/README.zh.md` 的 Known Limitations](../../packages/sandbox/sandbox-windows-acl/README.zh.md) 明确写"只授 Modify 的目录会大声失败而不是静默跳过隔离"）⇒ **不作为缺陷修**；"懒物化"既不可行（能力先于意图），"失败即降级为只读"又会悄悄削弱隔离 ⇒ 均不采纳。
3. **成立（本次修）**：失败路径**不提诊断入口**，而 seam 本来就注册了它 —— [`sandbox-local/src/index.ts:40`](../../packages/sandbox/sandbox-local/src/index.ts#L40) `registerAclDiagnosisSkill`（即 `diagnose-windows-sandbox-acl` 技能，一条命令既诊断又修复）。

## 改动（原生最小插入，带标记）

### 1) 运行期报错（`packages/sandbox/sandbox-local/src/index.ts`）

`materializeAclGrant()` 里，工作区授权失败、清理成功后的 `throw error` **之前**插入一个带标记的判断块：当错误是 `Win32Error`、`api === 'SetNamedSecurityInfoW'`、`win32Code === 5`（ACCESS_DENIED）时，改抛一个**说明型 Error**（`cause` 保留原错误）：

- 说清缺什么：Windows 要求登录用户在该目录上**同时**具备"改权限"和**"改所有者"**两项能力，而只从上级继承权限项的目录不会有后者；
- 给下一步：对这条路径跑一次 `diagnose-windows-sandbox-acl` 技能（它会连同上级目录一起检查、只修它证明有问题的部分，并打印恢复旧权限的命令）；
- 末尾附 `Original failure:` 原文（保留 Win32 证据）。

约束：不引入新依赖（用 `instanceof Error` + `'api' in error` 结构判断，避免为 `Win32Error` 类加包依赖）；判断块与使用点**同一段连续代码**，便于 rebase 与 `git grep uitstalie-` 盘点。

### 2) 文档侧指明 skill 入口（原生文档，带 HTML 注释标记）

用户追加要求"skill 的指定补一下"。核查后：两份 README 的**正文**早已点名该技能（[`README.md:78`](../../packages/sandbox/sandbox-windows-acl/README.md#L78) / [`README.zh.md:80`](../../packages/sandbox/sandbox-windows-acl/README.zh.md#L80)，以及 `sandbox-local/README.md:83` 的注册说明），缺的是 **Known Limitations 里那条"被授权目录必须授予 `WRITE_OWNER`"限制本身没有入口** ⇒ 在该条末尾补一句"Windows 把这种拒绝报成 setup 阶段的 `SetNamedSecurityInfoW failed (Win32 5)`，对该工作区路径跑一次[内置技能](assets/diagnose-windows-sandbox-acl/SKILL.md)"，中英同步、各一行、每行用 `<!-- BEGIN/END uitstalie-k3, …, task34 -->` 包住：

- `packages/sandbox/sandbox-windows-acl/README.md`（Known Limitations 的 `WRITE_OWNER` 条目）
- `packages/sandbox/sandbox-windows-acl/README.zh.md`（同条）

### 3) 双语 sidecar（生成物，登记而非手改）

改完 README 后，文档门禁 `translation pairing` 会因配对摘要过期而失败（实测：把我的两处 README 改动 stash 掉即恢复通过 ⇒ 确系本次引起）。该摘要记录由它自己的命令机械重录：

```sh
pnpm run verify-translation-pairing --write packages/sandbox/sandbox-windows-acl/README.md
```

⇒ `packages/sandbox/sandbox-windows-acl/README.i18n.yaml` 被重录（per-section 的 en/zh 哈希）。**登记说明**：这是**生成物**、由门禁自带命令重录，非手工编辑，故按分支规则"不支持注释/生成物改为在任务单登记"处理，**不加** `uitstalie-` 标记（下次 `--write` 会整体重写，加标记只会产生噪声；`git grep uitstalie-` 的盘点以本任务单为准）。

## 验证

| 检查 | 结果 |
|---|---|
| `tsc -b tsconfig.host.json` | ✓ |
| `oxlint packages/sandbox/sandbox-local/src/index.ts` | ✓ 0 warning / 0 error |
| `vitest run packages/sandbox/sandbox-windows-acl`（本机可跑的 Windows 车道，199 测试覆盖 `grantWrite` 与失败路径） | ✓ 16 文件 / **199 测试** |
| `vitest run packages/sandbox/sandbox-local/tests` | ✗ **本机不可用（非本次改动导致）**：`sandbox-local` 在 [`vitest.config.ts:37`](../../vitest.config.ts#L37) 的 `windowsUnsupportedPackages` 里 ⇒ Windows 上其 `tests/**` 被显式排除（"No test files found"），且 [`windowsUnsupportedCoveragePackages`](../../vitest.config.ts#L76) 令该包源码在 Windows 车道免于 per-file 覆盖 |
| 人工复现 | 本机无法复现 ACCESS_DENIED（本仓库工作区已有用户完全控制项 + DSH 能力项）⇒ 留给真实受限会话（用户在 `D:\1234` 重跑那条命令即可看到新报错文案） |

**未做的门禁（按分支既有约定）**：仓库要求"非平凡的用户可见改动更新 keyless 录制快照"，但 Windows 上快照通道不可用（见 task28 记录），故不纳入本任务。


## 备注

- 本仓库工作区 `D:\dqc\deepseek-harness-uitstalie-dev` 已带 `TS-…\TS:(OI)(CI)(F)` 与 DSH 自己的 `S-1-4-…:(OI)(CI)(W,D,DC)` 能力项 ⇒ 受限会话在此正常。
- 用户已同意把这类修复放在魔改分支（不是提给上游）。
- 可选后续（本次不做）：给 workspace-write 会话加"失败即自动跑诊断修复"的**显式开关**（默认关）——涉及替用户改权限，须用户明确启用。
