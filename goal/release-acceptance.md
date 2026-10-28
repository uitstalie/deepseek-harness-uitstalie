# 双平台发布验收记录（DH-312）

本文件记录 DH-312 的实测证据与缺口。**Fedora KDE 44 原生矩阵尚未执行**，原因与可复现步骤见末节；本文件不把模拟（`systemFor('linux')`）、Linux CI 或 WSL 结果当作 Fedora KDE 44 通过。

## Windows（已执行）

### 环境

| 项 | 值 |
|---|---|
| OS | Microsoft Windows 10 专业版 10.0.19045，x64，HypervisorPresent=True |
| Node | v24.13.0 |
| pnpm | 12.4.1（与 `packageManager` 一致） |
| Git | 2.50.1.windows.1 |
| PowerShell | 7.6.9 |
| 分支 | `cli-desktop`，验收时的 HEAD 含 DH-311/DH-313/DH-315/DH-316；home-backup 修复见 DH-317 |

### 套件结果

| 命令 | 结果 |
|---|---|
| `pnpm run test:jira:node` | 3 个包，**676 tests passed**（core 565 / agent 73 / cli 38） |
| `pnpm exec vitest run packages/uitstalie/store-atom packages/uitstalie/home-backup packages/uitstalie/memory packages/uitstalie/personality packages/jira/ui-jira` | 23 个文件，**220 tests passed** |
| `pnpm exec vitest run packages/uitstalie/home-backup/tests`（连跑 5 次） | 每次 **19 tests passed** |
| `pnpm exec vitest run packages/sandbox/sandbox-windows-acl packages/shell/tool-pwsh packages/shell/pwsh-sandbox packages/fs/fs-local packages/fs/fs-sandbox` | 32 个文件，**564 passed / 18 failed / 7 skipped**（见下） |
| `pnpm run typecheck` | 5/5 |

### 18 个失败：符号链接权限缺失（17）与并行负载超时（1）

本机进程创建符号链接得到 `EPERM`：

```
fs.symlinkSync(...) → EPERM: operation not permitted, symlink ...
```

失败集中在需要建符号链接的用例：`fs-local/tests/filesystem.spec.ts` 5、`fsio.spec.ts` 8、`fs-sandbox/tests/fs-sandbox.spec.ts` 3、`containment.spec.ts` 1——均为符号链接身份/围栏用例；其余 7 个 skip 是既有平台跳过。另有 1 个 `sandbox-windows-acl/tests/control.spec.ts` 用例在并行负载下 5s 预算超时（单独跑 3/3 通过，耗时 2.55s），属负载下的超时预算问题，不是行为失败。

### 行为验证（真实运行，非模拟）

- **Jira 台账**：本会话在 Windows 上完成建单、评论、链接、状态流转与 `git push`（DH-313 至 DH-317），即真实的 init / write / sync 链路。
- **.dsh store**：global / workspace 两套根的行为由 `store-atom` 套件覆盖（220 中的一部分），本机 `.dsh/` 也被本会话持续读写。
- **文件监听 / 原子写 / 大小写行为**：`fs-local` 与 `fs-sandbox` 套件覆盖；除上述符号链接用例外通过。
- **备份目的地与保留**：`home-backup` 套件覆盖默认目的地、保留数、失败重试；并行负载下曾暴露定时器重叠（staging 目录被下一次运行并发删除，Windows 报 `ENOTEMPTY`），已由 DH-317 修复并连跑 5 次验证。
- **Windows ACL / Pwsh**：`sandbox-windows-acl`、`tool-pwsh`、`pwsh-sandbox` 套件通过（含真实受限令牌与 Job 运行器、前台/后台/取消/超时）。

### Web 与 Desktop

- 3080 上的运行实例是 2026-10-26 启动的旧检出（不含 `ui-memory`），且 `dsh web` 要求身份令牌；本会话没有浏览器驱动，无法在 HEAD 上做视觉/明暗主题/窗口布局验收。该实例的 Slot 台账可读到 7 个段（`general/models/models-dev/plugins/agent-presets/capabilities/jira`），`memory`/`personality` 因旧构建未注册。
- Desktop（Electron）未在本会话启动验收。

## Fedora KDE 44（未执行，阻塞）

### 阻塞事实

- 本机无 WSL 发行版，且 **WSL2 内核文件缺失**；`wsl --update --web-download` 120s 无输出、无提权通道；`wsl --list --online` 返回 `0x80072eff`（无法访问分发源）。
- 已手动下载 Fedora 44 Container Base 并用 `wsl --import --version 1` 导入成功，但启动任何命令都无输出、退出码 1；根因与本机符号链接权限一致（容器内的 `/bin` 等符号链接未能建立），且 WSL1 组件本身不可用。
- 无 docker/podman/qemu，无 Hyper-V/VirtualBox 镜像；已知 Linux 主机 `10.24.158.48:22` 超时、`10.24.137.48:2222` 公钥被拒。
- 因此 Fedora 原生执行、Plasma/Wayland、SELinux、Landlock/bwrap 均无法在本机取证。

### 可复现的 Fedora 验收步骤（在 Fedora KDE 44 上执行）

1. **版本与环境**：`cat /etc/os-release`；`node -v`；`pnpm -v`；`git --version`；`uname -r`；`echo $XDG_SESSION_TYPE`；`rpm -q plasma-desktop`；`getenforce`。
2. **干净检出 + frozen install**：`git clone <仓库> && cd <仓库> && git rev-parse HEAD && pnpm install --frozen-lockfile`。
3. **构建与测试**：`pnpm run typecheck`；`pnpm run test:jira:node`；`pnpm exec vitest run packages/fs packages/sandbox packages/shell packages/uitstalie/memory packages/uitstalie/store-atom packages/uitstalie/home-backup packages/jira/ui-jira`。
4. **行为验证**：
   - 大小写：同一目录下建 `a` 与 `A` 必须是两个条目；
   - 监听：Node `fs.watch` 对 `writeFile`/`rename` 各收到一次事件；
   - 原子写：写临时文件后 `rename`，读回内容完整；
   - 台账：用 jira 工具建单 → 评论 → 状态流转 → 同步，检查 `git log`/远端一致；
   - 备份：`runBackup` 目的地与 `retain`，确认快照数与 staging 无残留。
5. **沙箱**：`command -v bwrap`；`ls /sys/kernel/security/landlock` 或 `grep -i landlock /proc/kallsyms`；跑 sandbox 套件；若 Landlock/bwrap 不可用，记录降级状态与提示文案，**不把 probe 结果当作通过**。
6. **Web/Desktop**：`dsh web` 打开打印的 URL；逐段验收 `general/models/models-dev/plugins/agent-presets/capabilities/memory/jira/personality`；明暗主题各一次；`apps/desktop` 的窗口布局与同一组设置页另列证据。Browser UI 通过不能替代 Desktop。
7. **回填**：把版本矩阵、每条命令与结果、明确未覆盖项贴回 DH-312；Fedora 与 Windows 的证据分列。

## 未覆盖清单

- Fedora KDE 44 原生机上的全部矩阵（见上节）。
- Plasma 6 / Wayland 的登录窗口、托盘、注入行为。
- SELinux enforcing 下的 AVC 判读与策略。
- Landlock / bwrap 可用性与拒绝分类。
- HEAD 上的 Web 视觉验收（含明暗主题、窗口布局）与 Desktop 验收。
- Windows 主机符号链接权限授予后的 fs 符号链接用例（授予 Developer Mode 或提权后可复跑）。
