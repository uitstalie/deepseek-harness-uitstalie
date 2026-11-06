# `home-write` 已禁用（入口与使用入口）

Status: **implemented / disabled by default（2026/11/06）**
Jira: **DH-902** — 关联 **DH-901**（风险评估）
Related: [home-write-sandbox.md](home-write-sandbox.md)（原始设计；其中“可选”的部分已被本文取代）

## 1. 结论

在本机核实后决定：**先禁用 `home-write` 的入口与使用入口**，让它不可被选择、也不可生效；`non-critical-write` 兼容别名一并关掉。实现代码（平台 profile、ACL grant、策略渲染、审批工具）保留，只加单一开关与门禁，不删文件、不重构。

唯一开关在 `packages/sandbox/sandbox/src/modes.ts`：

```ts
export const HOME_WRITE_ENABLED: boolean = false
```

所有入口都读这一个值；**要恢复只需把它改回 `true` 并按第 6 节恢复几处被注释的字面量/预设**。

## 2. 为什么要禁用（已在本机核实）

机制（Windows ACL 后端）：

- `home-write` 的授权根是**整个 canonical home**，Windows 上还包括**除系统盘外的每个固定盘根**，以及会话 workspace 与配置的 temp 例外。
- 每个根由 `AclWriteGrant.add(root)` 授权；Windows 实现通过 `SetNamedSecurityInfoW(..., LABEL_SECURITY_INFORMATION, ...)` 写入一个 **可继承的 `SYSTEM_MANDATORY_LABEL_ACE`（S-1-16-4096 = Low，OI|CI）**。
- 关键在“可继承 + 对已存在对象生效”：该调用会把根下**已经存在的整棵子树**一起重标为 Low（桌面、开始菜单、AppData、`%TEMP%`、D: 整盘……）。
- 切回 `workspace-write` 只停止后续 grant，**不会撤销磁盘上已经写入的标签**；provider 崩溃/异常退出同样会留下标签。没有自动回滚。

后果：

- Windows 把低完整性的 `.lnk` / `.bat` 当作 Internet 来源文件：双击快捷方式必弹“打开文件 - 安全警告 / 未知发布者”。
- AppData 下的应用（本机为飞书）行为异常。
- 任何 Low 进程（浏览器渲染器等）因此获得对用户数据的写路径，形成 Low→Medium 的用户级代码执行面（DH-901 的增量风险）。

结论：这个选项的机制（整树重标）与生命周期（无回滚）都不合理；在修好“记录并恢复原标签”之前，不应暴露给用户，也不应能通过配置/升级/工具悄悄生效。

## 3. 禁用点（逐文件）

标记注释统一为 `uitstalie-deepseek-flash, 2026/11/06, DH-902, home-write disabled (Low-integrity whole-tree relabel; no auto-rollback)`；可用 `git grep -n "uitstalie-deepseek-flash"` 盘点。

| 文件 | 入口 | 处置 |
| --- | --- | --- |
| `packages/sandbox/sandbox/src/modes.ts` | 新增 `HOME_WRITE_ENABLED`、`HOME_WRITE_DISABLED_MESSAGE`、`assertSandboxModeEnabled()` | 单一开关 + 统一拒绝文案 |
| `packages/sandbox/sandbox/src/index.ts` | 导出上述三项 | 供各入口读取 |
| `packages/sandbox/sandbox-policy/src/session-mode.ts` | `SANDBOX_MODES` | 关闭时不含 `home-write`（实现保留在条件展开里） |
| 同上 | `setSandboxMode()` | 写 `sandbox/mode` 事件前断言，拒绝落盘 |
| `packages/sandbox/sandbox-policy/src/index.ts` | 配置 schema 的 `mode` 枚举、`homeWrite*` 字段 | 字面量保留以给出“disabled”明确报错；`homeWrite*` 仅剩 inert 字段（模式本身在构造时被拒） |
| 同上 | 构造函数（部署默认） | `assertSandboxModeEnabled(this.defaultMode)`；`mode: home-write` / `non-critical-write` 在加载期直接失败 |
| 同上 | `resolve()`（会话覆盖 / 已批准升级） | 每个调用边界再断言，任何后端都拿不到该模式 |
| 同上 | `homeWriteTool` 注册点 | `if (HOME_WRITE_ENABLED)` 包住 `scope.tools.register(...)`，`sandbox_home_readonly` 不再挂载 |
| 同上 | `renderPolicyContext` 的 `home-write` 分支 | 实现保留；`resolve()` 先抛错，分支不可达 |
| `packages/sandbox/sandbox/src/escalation.ts` | `WIDER_MODES`、`ESCALATION_TARGETS` | 关闭时不贡献 `home-write` 目标 |
| 同上 | `sandboxPermissionsDescription()` | 关闭时不再向模型描述该模式 |
| 同上 | `approveEscalation()` | 在“重复当前模式”短路之前显式拒绝该目标 |
| `packages/interaction/permission-presets/src/index.ts` | 默认预设表 / 配置 schema | 默认表移除 `home-write`；schema 只接受 `SANDBOX_MODES`，不再接受 `non-critical-write` 别名 |
| 同上 | 构造函数 map | `assertSandboxModeEnabled()` 兜底 |
| `packages/client/ui-permission-presets/src/client/presentation.ts` | `PRESET_LABEL_KEYS` / `DEFAULT_PRESET_LABELS` | 不再给 `home-write` 映射产品标签（host 也不再下发该预设） |
| `packages/core/tool-executor-ptc/src/ptc.ts` | run_code 输出 schema 的 mode enum | 移除 `home-write` |
| `packages/sandbox/sandbox-local/src/index.ts` | windows-acl 的 `policy.mode === 'home-write'` 分支 | **在写任何 ACL 之前** `throw SandboxUnsupportedPolicyError`（带恢复命令），grant 代码保留但不可达 |
| `packages/bundle/base/cordis.patch.yml` | base bundle 的 permission 预设 | 注释掉 `home-write` 预设项 |

保留但由上层门禁兜底的实现：POSIX `bwrap` / Landlock / Seatbelt 的 home-write profile、`fs-sandbox` 的 home-write 围栏、`sandbox-windows-acl` 的 grant/runner 代码、`home-write-tool.ts` 本体。产品路径上它们都拿不到 `home-write` 策略（`resolve()` 先拒绝）；Windows ACL 的 grant 分支另有一道入口拒绝。

## 4. 恢复已被重标的目录

先确认哪些路径被标成 Low（`Mandatory Label`）：

```powershell
icacls "C:\Users\TS" | Select-String "Mandatory Label"
icacls "D:\" | Select-String "Mandatory Label"
```

把根与**已存在子树**恢复为 Medium（建议在**提升的** PowerShell 中执行；`/T` 才会递归修复已有子项）：

```powershell
icacls "C:\Users\TS" /setintegritylevel (OI)(CI)M
icacls "C:\Users\TS" /setintegritylevel (OI)(CI)M /T   # 递归修复已有桌面/开始菜单/AppData 等子项
icacls "D:\" /setintegritylevel (OI)(CI)M /T           # 若 D: 整盘被授权过
```

注意：

- 不带 `/T` 只改目标对象的标签与继承标志；已被显式重标的子项仍可能是 Low。
- 恢复后重新登录/重启资源管理器与相关应用，才能清掉“未知发布者”提示的缓存状态。
- 该命令只修标签，不修 DACL；若还叠加过 DENY ACE，按 DH-901 的记录继续排查。

## 5. 验证禁用是否生效

在运行中的 GUI / CLI：

- `/permission` 的可用列表只剩 `read-only, workspace-write, danger-full-access`（以及 live Auto）。
- `/permission home-write` → `unknown preset "home-write"`。
- 配置文件写 `mode: home-write` 或 `non-critical-write` → 加载失败，错误含 `home-write is disabled`。
- 旧会话日志里已有 `sandbox/mode: home-write` → 下一次受控调用报 `home-write is disabled`（不会静默放宽）。
- 模型侧 `sandbox_permissions` 的 enum 只剩 `workspace-write, danger-full-access`；`sandbox_home_readonly` 工具不再出现。
- Windows 上 `sandbox.confine(..., { mode: 'home-write' })` 直接抛 `Windows ACL home-write confinement is disabled in this build`，不会调用 `SetNamedSecurityInfoW`。

## 6. 回滚本次禁用（重新启用 `home-write`）

前提：先修 DH-901 的 P2（离开模式/崩溃时恢复原标签）或至少加入显式披露与 opt-in；否则不建议恢复。

1. `packages/sandbox/sandbox/src/modes.ts`：`HOME_WRITE_ENABLED` 改为 `true`。这一步会自动恢复 `SANDBOX_MODES`、`ESCALATION_TARGETS`、升级文案、`setSandboxMode`/`resolve` 门禁、`sandbox_home_readonly` 注册与 windows-acl grant 分支。
2. `packages/interaction/permission-presets/src/index.ts`：取消注释默认预设表的 `home-write` 项（schema 已由 `SANDBOX_MODES` 自动恢复接受）。
3. `packages/bundle/base/cordis.patch.yml`：取消注释 `home-write` 预设项。
4. `packages/client/ui-permission-presets/src/client/presentation.ts`：取消注释 `['home-write', 'preset.homeWrite']` 与默认标签项。
5. `packages/core/tool-executor-ptc/src/ptc.ts`：把 `home-write` 加回输出 schema 的 enum。
6. 还原/重写受影响的期望：`packages/sandbox/sandbox/tests/escalation.spec.ts`、`sandbox-policy/tests/policy.spec.ts`、`permission-presets/tests/{permission-presets,projection}.spec.ts`、`fs/tool-fs` / `shell/tool-{bash,pwsh}` 的 enum 与升级用例、`sandbox-local/tests/local.spec.ts` 的 Windows ACL 用例。
7. 全量 `typecheck` / `lint` / 相关 vitest，并在 Windows 实机验证标签生命周期（授权→切回→注销/崩溃）后才重新默认暴露。

## 7. 运行中的 3080 实例如何同步

现状（2026/11/06 18:30 左右核对）：

- 运行实例 checkout：`D:\dqc\deepseek-harness-uitstalie`，branch `cli-desktop`，HEAD `af255ad8ba`；进程 7776 的命令行是 `node --import tsx/esm apps/cli/src/bin.ts "web"`（**直接跑 TS 源码，host 侧无需预编译**）。
- 开发 checkout：`D:\dqc\deepseek-harness-uitstalie-dev`，branch `cli-desktop`，HEAD `8f0af59871` + 本次未提交改动。
- `af255ad8ba` 是 dev HEAD 的**祖先**（`git merge-base af255ad8ba <dev HEAD>` = `af255ad8ba`），所以可以把 dev 的提交**快进**到运行 checkout，不需要 cherry-pick 或重建历史。
- 本机 web profile `C:\Users\TS\.dsh\profiles\web\cordis.patch.yml` **没有** `home-write` 预设，不需要改用户配置；预设来自 base bundle。
- 当前没有单独的 `pnpm run dev:web` 进程，所以 `ui-permission-presets` 的 client 产物需要重新构建后刷新页面。

步骤：

1. 在 dev 里提交本次改动（建议按仓库规则拆成“原生文件修改”和“goal/ 文档”两个提交）：

   ```powershell
   cd D:\dqc\deepseek-harness-uitstalie-dev
   git add packages
   git commit -m "fix(sandbox): disable home-write entry points (DH-902)"
   git add goal
   git commit -m "docs(goal): record the home-write disable (DH-902)"
   ```

2. 在运行 checkout 里快进（先确认工作区干净；有本地改动先 stash/commit）：

   ```powershell
   cd D:\dqc\deepseek-harness-uitstalie
   git status --porcelain           # 应为空
   git fetch D:\dqc\deepseek-harness-uitstalie-dev cli-desktop
   git merge --ff-only FETCH_HEAD
   git log --oneline -3             # 应包含上面的 DH-902 提交
   ```

3. 重建 client 产物（host 走 tsx 源码，只有 client bundle 是预构建的）：

   ```powershell
   cd D:\dqc\deepseek-harness-uitstalie
   pnpm run build:lib:client
   ```

   如果只是本机临时验证，也可以另开 `pnpm run dev:web`（client-plugin HMR），但它需要另起 Vite dev server，不能替代 3080 的 host 重启。

4. 重启 3080（先停进程 7776，再从运行 checkout 原样启动；保持原来的 cwd、env 与参数）：

   ```powershell
   Stop-Process -Id 7776
   cd D:\dqc\deepseek-harness-uitstalie
   node --import tsx/esm apps/cli/src/bin.ts web
   ```

   启动后刷新 `http://127.0.0.1:3080`。

5. 同步后验收（同第 5 节）：`/permission` 列表无 `home-write`；`sandbox_permissions` enum 只有两项；`sandbox_home_readonly` 消失；用一次 `mode: home-write` 配置或旧日志验证明确报错。

6. 若希望完全不碰运行 checkout：也可以直接在 dev checkout 里用同样的命令另起一个端口（例如 `DSH_WEB_PORT=3081` 或 CLI 的 `--port`，以本机 CLI 帮助为准）验证，再决定是否切换 3080；但 3080 本身仍只会加载它自己 checkout 的代码。

## 8. 验收记录（本机，2026/11/06 18:44）

本机 `D:\` 根与 home 已被早先的 home-write 授权重标为 Low，因此**经 `pnpm` 启动的 node 子进程会被降为 Low**，写不了 Medium 的系统 Temp（`EPERM`）；下面的命令都改为 `node` 直跑，效果等同 `pnpm run` 对应脚本。

- `typecheck`：`node node_modules/tsx/dist/cli.mjs scripts/build.ts --scope typecheck` → **5 passed / 0 failed**（52.55s）。
- `lint`（本次改动的 17 个文件）：`node node_modules/tsx/dist/cli.mjs scripts/run-oxlint.ts <changed files>` → **0 warnings / 0 errors**。
- `lint`（全仓）：`node node_modules/tsx/dist/cli.mjs scripts/run-oxlint.ts .` 仍有 **1427 个与本改动无关的既存错误**（`packages/jira/...`、`packages/uitstalie/...`、`packages/experimental/...` 等未触碰文件）；本分支当前状态下全仓 lint 本就不是绿的。本次改动的文件不在这些错误里。
- vitest（Windows 默认工程可跑的相关包）：

  ```
  node node_modules/vitest/vitest.mjs run \
    packages/sandbox/sandbox/tests/escalation.spec.ts \
    packages/sandbox/sandbox-policy/tests \
    packages/interaction/permission-presets/tests \
    packages/core/tool-executor-ptc/tests \
    packages/client/ui-permission-presets/tests \
    packages/fs/tool-fs/tests/tools.spec.ts \
    packages/shell/tool-pwsh/tests/tools.spec.ts
  ```

  结果：**17 files passed / 529 tests passed / 1 skipped**（20.81s）。
- `packages/sandbox/sandbox-local/tests/local.spec.ts` 与 `packages/shell/tool-bash/tests/tools.spec.ts` 被 `vitest.config.ts` 的 `windowsUnsupportedPackages` 排除，只能在 Linux CI 执行；本次已同步修改其中对 `home-write` 的期望（Windows ACL 两个用例改为断言 `home-write is disabled`；bash 的 enum/升级用例与 pwsh 对齐）。
- 生成物：
  - `verify-config-catalog`：up to date（重新生成只改了 `source` 行号引用）。
  - `verify-tool-catalog`：up to date；`docs/tool-catalog.md` 与 `docs/tool-catalog.zh.md` 均已移除 `sandbox_home_readonly`，`tool-catalog.i18n.yaml` 已重录。
  - `verify-translation-pairing`：1221 对全部一致。
- 未改动：`docs/subsystems/sandbox.md` / `.zh.md` 仍按保留的实现描述 `home-write`（`SandboxMode` 类型也仍包含它）；这是后续文档同步项，不属于本次“只加门禁”的范围。

## 9. 关联

- 本任务记录：dsh-jira `DH-902`（正文与标记注释都使用该 key）。
- `DH-901` 的风险评估与恢复建议仍然有效；本文只记录“先禁用入口”的这一层。
- 若将来恢复该模式，请把本文件状态改为 superseded，并在 DH-902 评论中链接新的生命周期实现。
