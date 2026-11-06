# Linux 沙箱实测与缺陷清单（bwrap / Landlock）

Status: **audit complete（2026/11/06）**
Jira: **DH-903** — 关联 DH-901（Windows home-write Low 标签风险）、DH-902（home-write 入口已禁用）
E2E: [linux-probe.e2e.ts](../packages/sandbox/sandbox-local/tests/linux-probe.e2e.ts)

## 1. 结论摘要

- 真实 Linux 内核上，`read-only` / `workspace-write` / `home-write` 的**边界本身没有发现越权写入**：工作区、`$HOME`、`/tmp`、符号链接、`/proc/self/root` 的允许/拒绝与代码声明一致（P0 = 0）。
- 真正的缺陷集中在**语义不一致与可用性**：home-write 默认可写 `~/.ssh`/`~/.config`（P1）、Landlock 上 home-write + excludePaths 整个不可用且失败延迟到执行期（P1，重新启用后）、home-write 默认没有 temp 因此 `/tmp`/`TMPDIR` 不可写（P2）、`/dev/shm` 与 `TMPDIR` 在 bwrap/Landlock/Seatbelt/fs-fence 之间不一致（P2）。
- `home-write` 的产品入口已由 DH-902 关闭；本报告的证据来自直接调用 `LocalSandboxProvider.confine()`，用于评估“将来是否/如何恢复”。
- Windows 的 Low 完整性整树重标是**另一类**缺陷（持久化、无回滚，DH-901）；Linux 没有这个持久化标签问题，但有“默认可写凭据目录”的同类威胁模型。

## 2. 实际使用的环境（不是 Windows 本机伪装）

本机 Windows 没有可用的 Linux：

```text
wsl -l -v        → 未安装任何 WSL 发行版
docker / podman  → 命令不存在（Docker Desktop 未安装）
VBoxManage / vmrun / qemu → 不存在
```

因此使用 **GitHub Actions 的真实 Ubuntu 24.04 runner**（fork `uitstalie/deepseek-harness-uitstalie`，临时 `probe/linux-sandbox` 分支 + 临时 workflow 仅用于取证）：

| 项 | 值（CI 实测） |
| --- | --- |
| runner | `ubuntu-24.04`（x64） |
| kernel | `7.0.0-1017-azure` |
| bwrap | `bubblewrap 0.9.0` |
| Landlock | `landlock: fully enforced`（`landlockEnforcement: full`） |
| unprivileged userns | `kernel.unprivileged_userns_clone=1` |
| AppArmor userns | `kernel.apparmor_restrict_unprivileged_userns=0`（CI 步骤显式放开） |
| uid / home / temp | `1001` / `/home/runner` / `/tmp` |
| 运行的测试 | 现有 `bwrap.e2e.ts` + `landlock.e2e.ts` + 新增 `linux-probe.e2e.ts` |

证据 run（均 success）：

- `https://github.com/uitstalie/deepseek-harness-uitstalie/actions/runs/42206266785`（29 tests）
- `https://github.com/uitstalie/deepseek-harness-uitstalie/actions/runs/42206614851`（30 tests，含 `TMPDIR`/`/dev/shm` 观测）

CI 中关键输出（原样）：

```text
LINUX_SANDBOX_ENV={"platform":"linux","arch":"x64","release":"7.0.0-1017-azure",
 "bwrapUsable":true,"bwrapVersion":"bubblewrap 0.9.0",
 "landlockUsable":true,"landlockProbe":"landlock: fully enforced","landlockEnforcement":"full",
 "unprivilegedUsernsClone":"1","apparmorRestrictUnprivilegedUserns":"0",
 "home":"/home/runner","temp":"/tmp","uid":1001,"rungs":["bwrap","landlock"]}

LANDLOCK_PROBE=landlock: fully enforced exit=0
LANDLOCK_USAGE_FAILURE={"status":125,"stderr":"landlock-run: usage error: --probe takes no other arguments"}
 Test Files  3 passed (3)
      Tests  30 passed (30)
```

## 3. 实测覆盖矩阵

`hostEffect` = 命令结束后宿主机上是否真的出现该文件/目录变化。`status` = 沙箱内命令退出码。

| 模式 | 场景 | bwrap | Landlock | 结论 |
| --- | --- | --- | --- | --- |
| read-only | workspace 写 | `1` / 无效果 | `1` / 无效果 | 拒绝 ✔ |
| read-only | `$HOME` 写 | `1` / 无效果 | `1` / 无效果 | 拒绝 ✔ |
| read-only | `/tmp` 写 | `1` / 无效果 | `1` / 无效果 | 拒绝 ✔ |
| read-only | `/dev/null` 写 | `0` | `0` | 允许 ✔ |
| read-only | `/dev/shm` 写 | `0` / 无宿主效果（私有 devtmpfs） | `1` / 拒绝 | **后端不一致（P2）** |
| read-only | `/dev/stderr` 写 | `1`（ENXIO） | `1`（ENXIO） | 测试 harness 把 stderr 接成管道导致，非沙箱差异 |
| workspace-write | workspace 写 | `0` / 有效果 | `0` / 有效果 | 允许 ✔ |
| workspace-write | `$HOME` 写 | `1` / 无效果 | `1` / 无效果 | 拒绝 ✔ |
| workspace-write | `/tmp` 写 | `0` / **无宿主效果**（私有 tmpfs） | `0` / **有宿主效果**（host `/tmp`） | 语义差异（P2/P3） |
| workspace-write | `/dev/shm` 写 | `0` / 无宿主效果 | `1` / 拒绝 | **后端不一致（P2）** |
| workspace-write | 符号链接指向 `$HOME` | `1`（EROFS） | `1`（EACCES） | 拒绝 ✔ |
| workspace-write | `/proc/self/root` 指向 `$HOME` | `1`（EROFS） | `1`（EACCES） | 拒绝 ✔ |
| workspace-write | PID namespace | 私有（`pid:[4026532323]`） | 宿主（`pid:[4026531836]`） | 文档化差异（P3） |
| workspace-write | 自定义 host `TMPDIR` + `mktemp` | `1` | `1` | **与 `writableRoots()` 承诺不一致（P2）** |
| home-write | `$HOME` 写 | `0` / 有效果 | `0` / 有效果 | 允许（模式语义） |
| home-write | `$HOME/.ssh`、`$HOME/.config` 写 | `0` / 有效果 | `0` / 有效果 | **默认可写凭据（P1）** |
| home-write | workspace 写 | `0` / 有效果 | `0` / 有效果 | 允许 ✔ |
| home-write | home 外的同级目录写 | `1` / 无效果 | `1` / 无效果 | 拒绝 ✔ |
| home-write | `/etc` 写 | `1` / 无效果 | `1` / 无效果 | 拒绝 ✔ |
| home-write | `/tmp`（默认 temp roots 为空） | `1` / 无效果 | `1` / 无效果 | **默认可写区不含 temp（P2）** |
| home-write | `homeWriteTempRoots:[temp]` + `TMPDIR=temp` | `0` | `0` | 显式配置可用 ✔ |
| home-write | excludePaths（`.ssh`） | 排除项 `1`；非排除项 `0` | **`confine()` 直接抛 `SandboxUnsupportedPolicyError`** | **Landlock 整个不可用（P1，重新启用后）** |
| home-write | 真实 bwrap 探测失败后的回退 | — | 选中 launcher，`full`，`permission denied` 方言 | 回退链 ✔ |
| danger-full-access | 消费者绕过（写 `$HOME`） | `0` / 有效果 | `0` / 有效果（同一消费者路径） | 按设计 ✔ |

> `danger-full-access` 不经过 `confine()`：`SandboxBashExecutor` 在 `mode === 'danger-full-access'` 时直接执行并标记 `{denied:false}`。测试同时证明这条绕过路径确实能写 `$HOME`。

## 4. 缺陷清单

### P0 — 无

未发现“应当拒绝却成功写入宿主”的越权：read-only/workspace-write 的 workspace/home/tmp 边界、符号链接、`/proc/self/root`、home-write 的 home 外路径与 `/etc` 全部按预期拒绝。`/dev/shm` 在 bwrap 下可写，但只落在私有 `/dev` tmpfs（`hostEffect=false`），不是宿主越权。

### P1-1 — POSIX home-write 默认可写整份凭据/配置（实测）

- 现象：`$HOME/.ssh/id_probe`、`$HOME/.config/dsh-probe` 在 bwrap 与 Landlock 下均写入成功（`status=0`、`hostEffect=true`）。
- 证据/测试：`linux-probe.e2e.ts > home-write: the whole home (including credential dirs) is writable and /etc is not`；观察记录 `$HOME/.ssh write status 0 hostEffect true`（两个 rung）。
- 原因：`Config.excludePaths` 默认 `[]`（`packages/sandbox/sandbox-policy/src/index.ts`），`homeWriteWritableRoots` 直接授权整个 home；GUI 预设旧文案却说 “except force-read-only paths”，默认并没有任何 force-read-only 路径。
- 影响：agent 可静默改 `~/.ssh/authorized_keys`、shell rc、`.gitconfig`、`~/.config/gh` 等；与 Windows home-write 同一威胁模型，只是不落永久标签、不跨重启。
- 复现：

  ```bash
  node node_modules/vitest/vitest.mjs run --config vitest.e2e.config.ts \
    packages/sandbox/sandbox-local/tests/linux-probe.e2e.ts -t 'whole home'
  ```

- 建议：在重新启用 home-write 前，(a) 默认排除 `~/.ssh`、`~/.gnupg`、`~/.aws`、`~/.config/gh`、`~/.kube`、`~/.docker`（并在策略加载时创建/校验），或 (b) GUI 必须显式确认并在预设文案里写清 “credentials are writable by default”。仅仅把文档里的建议清单再抄一遍不够，默认值要改。

### P1-2 — Landlock 上 home-write + excludePaths 整个不可用，且失败延迟到执行期（实测）

- 现象：`landlockProfileArgs` 在 `homeWriteReadOnlyRoots(policy).length > 0` 时直接抛 `SandboxUnsupportedPolicyError`；`confine()` 在真正执行前失败，非排除路径也一并失败。实测两条写操作都是 `status=null, error=SandboxUnsupportedPolicyError`。
- 证据/测试：`linux-probe.e2e.ts > home-write: bwrap enforces excludePaths, Landlock refuses the whole policy`。
- 失败延迟：`SandboxPolicyService.resolve()` 不感知后端；在只有 Landlock 的宿主机（或 bwrap 探测失败回退）上，用户仍可选中 home-write，之后每条命令才在 `confine()` 报错，且没有 preflight 降级/明确提示。
- 复现：

  ```bash
  node node_modules/vitest/vitest.mjs run --config vitest.e2e.config.ts \
    packages/sandbox/sandbox-local/tests/linux-probe.e2e.ts -t 'excludePaths'
  ```

- 建议：给 `SandboxProvider` 增加能力查询（例如 `supports(policy)` / `capabilities`），在**选择模式/预设时**就拒绝或明确降级到 workspace-write；不要在每条命令的执行期才抛。若要在 Landlock 上表达“洞”，只能引入 mount namespace（需要 bwrap 级能力），不是纯 Landlock 能做的。

### P2-3 — home-write 默认 `homeWriteTempRoots=[]`，`/tmp` 与 `TMPDIR` 不可写（实测）

- 现象：`/tmp/<probe>` 在 bwrap（`--ro-bind / /`，无 `/tmp` bind）与 Landlock（只授权 home/workspace）下均 `status=1`；`TMPDIR=/tmp mktemp` 两个 rung 都 `status=1`；显式 `homeWriteTempRoots:[temp]` + `TMPDIR=temp` 才 `status=0`。
- 证据/测试：`linux-probe.e2e.ts > home-write: explicit temp roots and TMPDIR decide whether mktemp works`；`/tmp write (default temp roots) status 1`。
- 影响：绝大多数工具、包管理器、`ptc-runtime-python`（显式设置 `TMPDIR: os.tmpdir()`，见 `packages/experimental/ptc-runtime-python/src/index.ts:444`）在 home-write 下会因为没有可写 temp 而失败。Windows 的 home-write 会在 `<home>/.dsh/tmp` 建私有 temp 并授权（`packages/sandbox/sandbox-local/src/index.ts`），POSIX 没有对应物——**跨平台不一致**。
- 建议：像 Windows 一样给 POSIX home-write 建一个 home 内私有 temp（例如 `<home>/.dsh/tmp` 或 session temp），自动加入 `homeWriteTempRoots` 并设置子进程 `TMPDIR`；不要默认授予宿主 `/tmp`（共享可写区）。

### P2-4 — `/dev/shm` 跨后端不一致（实测）

- 现象：read-only 和 workspace-write 下，bwrap 写 `/dev/shm` `status=0` 但 `hostEffect=false`（`--dev /dev` 的私有 devtmpfs）；Landlock 两种模式都 `status=1`（`/dev/shm` 不在 allow-list，只有 `/dev/null`）。
- 证据/测试：`linux-probe.e2e.ts` 的 read-only / workspace-write 场景；`/dev/shm write status 0 hostEffect false`（bwrap）vs `status 1`（landlock）。
- 影响：依赖 POSIX shared memory 的运行时（Chromium、Python `multiprocessing`、部分 ML/数据库库）在 bwrap 下可用、在 Landlock 下直接失败；read-only 下 bwrap 也允许私有无害写入。
- 建议：bwrap 显式 `--tmpfs /dev/shm` 并文档化为“私有 shm”（当前行为依赖 bwrap 的 `--dev` 实现）；Landlock 侧文档化“无私有 shm”，或把需要 shm 的场景引导到 workspace-write + bwrap；如未来 launcher 能挂私有 tmpfs，再考虑补齐。

### P2-5 — host `TMPDIR` 在 `/tmp` 之外时，bwrap/Landlock 不授权（实测）

- 现象：`process.env.TMPDIR` 指向 home 下的目录后，workspace-write 的 `mktemp` 在两个 rung 都 `status=1`。
- 证据/测试：`linux-probe.e2e.ts > records the host TMPDIR grant difference under workspace-write (known gap)`；`TMPDIR_PROBE bwrap status=1`、`TMPDIR_PROBE landlock status=1`。
- 原因：`writableRoots()`（Seatbelt + in-process fs fence 使用）包含 `os.tmpdir()`，但 `bwrapProfileArgs` 硬编码 `--tmpfs /tmp`，`landlockProfileArgs` 硬编码 `/tmp`；二者都不读 `os.tmpdir()`/policy。
- 影响：同一 host 上 fs 工具允许写 `TMPDIR`，bash/进程沙箱却拒绝；CI 或用户自定义 `TMPDIR` 时出现“文件工具成功、命令失败”的不对称。
- 建议：让 bwrap/Landlock 的 temp grant 从 `writableRoots(policy)`（至少 `tmpdir()`）派生；或在消费者层把 `TMPDIR` 归一化到已授权的 workspace/temp，并加 e2e 断言。

### P2-6 — bwrap 的 `/tmp` 是临时的，Landlock/Seatbelt 是宿主 `/tmp`（实测 + 现有测试）

- 现象：workspace-write 下写同一个 `/tmp` 路径，bwrap `hostEffect=false`（tmpfs 随进程消失），Landlock `hostEffect=true`（宿主文件保留）。
- 影响：命令之间/模型重试之间看不到同一个临时文件；模型可能报告“已写入”但宿主/下一条命令看不到。现有文档已把 bwrap 的 ephemeral `/tmp` 记为差异，但消费者/模型提示没有强调。
- 建议：若需要跨命令 temp，使用 session 级 temp 目录并 bind 进沙箱（宿主可见）；否则在模式文案/工具结果里明确“bwrap temp 是单次执行的”。

### P3 — 记录项

- **`/proc` 可见性**：bwrap 私有 PID namespace，Landlock 保持宿主 PID namespace（`pid:[4026531836]` 与宿主一致）。这是文档化差异；`/proc/self/root` 的写逃逸在两个 rung 都被拒绝，没有发现 procfs magic-link 绕过。P3：不是 bug，但 Landlock 下命令能看到/信号同用户宿主进程。
- **partial enforcement 未实测**：本机 runner 的 Landlock 是 `fully enforced`（ABI ≥ 5），`landlock-run` 的 partial 分支（`landlock-run: partial enforcement (older Landlock ABI)` 与 `enforcement: 'partial'`）没有机会运行。代码/单测覆盖了解析（`native/system/test/launcher.test.js`、`sandbox-local` 的 probe 测试），但真实旧内核上的 `truncate`/`ioctl` 行为未验证。P3（环境限制）。
- **`/dev/stderr` 的 ENXIO**：两个 rung 都是 `No such device or address`，原因是测试用 `spawnSync` 把 stderr 接成管道，`/dev/stderr`/`/proc/self/fd/2` 在非 tty 管道上打开失败；不是沙箱差异。记录以免误判。
- **Windows Low 标签（DH-901）**：不属于 Linux 缺陷清单；但它是 home-write “默认整 home 授权”这一类问题的更严重版本（持久、无自动回滚）。Linux 版本没有持久标签，但 P1-1 的凭据可写是同一威胁模型的非持久版本。

## 5. Windows / Linux / macOS 一致性对照表

说明：Windows 列来自 DH-901 的实测与本机证据；Linux 列本次实测；macOS 列为**代码与现有 `seatbelt.e2e.ts` 推导**，本次没有 macOS runner（见 §7）。

| 维度 | Windows ACL | Linux bwrap | Linux Landlock | macOS Seatbelt |
| --- | --- | --- | --- | --- |
| read-only 强制 | 无显式可写根，环境 ACL 缺口 → `partial` | 全只读（`--ro-bind / /`）+ `/dev`、`/proc` 私有挂载 → full | `--ro /` + `/dev/null` → full/partial（按 ABI） | `(deny file-write*)` + `/dev/null` → full |
| workspace-write 可写 | workspace + `additionalWritableRoots` + 私有 temp | workspace + extras + **私有 tmpfs `/tmp`** | workspace + extras + **宿主 `/tmp`** | workspace + extras + `/tmp` + `os.tmpdir()` |
| workspace-write 下 `$HOME` | 只读 | 只读（`/` ro-bind） | 只读（`/` ro） | 只读（deny） |
| home-write 根 | home + 每个非系统盘 + workspace + temp | home（默认 `$HOME`）+ workspace + 显式 temp | 同 bwrap | 同 bwrap |
| home-write 默认凭据 | 可写（需 `excludePaths` 才保护） | **可写（实测 .ssh/.config）** | **可写（实测）** | 可写（需 exclude） |
| home-write excludePaths | inheritable DENY ACE | `--ro-bind` 子路径（实测生效） | **不支持，直接抛错** | SBPL deny（代码） |
| home-write 默认 temp | `<home>/.dsh/tmp` 私有 temp（代码） | **无；`/tmp` 只读** | **无；`/tmp` 拒绝** | **无；`/tmp` 未授权** |
| 自定义 `TMPDIR` | 由 Windows 私有 temp 承担 | 不授权 | 不授权 | `writableRoots()` 授权 `os.tmpdir()` |
| `/dev/shm` | 宿主正常 | 私有 devtmpfs，可写但无宿主效果 | 拒绝 | 拒绝（deny） |
| PID / 进程可见性 | 同宿主 | 私有 PID namespace | 宿主 | 宿主 |
| `/proc/self/root` 逃逸 | n/a | 拒绝（ro bind） | 拒绝（path rules） | 拒绝（SBPL） |
| 符号链接逃逸 | DACL/路径 | 拒绝（ro bind） | 拒绝（path rules） | 拒绝（subpath） |
| 持久副作用 | **Low 标签整树重标，无自动回滚** | 无 | 无 | 无 |
| 失败模式 | Win32 错误（grant 时） | probe 失败 → Landlock | launcher exit 125 + `landlock-run:` | sandbox-exec 失败 |
| 强制声明 | partial | full | full / partial（ABI） | full |

## 6. 修复建议（按优先级）

1. **重新启用 home-write 之前**（P1）：
   - 改默认 `excludePaths`（凭据/配置目录），或把 home-write 改成必须显式列根/显式确认；同步修正预设文案。
   - 增加后端能力查询：Landlock 上 home-write+exclude 在选择期就拒绝/降级，不要让每条命令执行期抛错。
2. **temp 策略**（P2）：
   - POSIX home-write 建 home 内私有 temp（对齐 Windows 的 `<home>/.dsh/tmp`），加入 `homeWriteTempRoots` 并导出 `TMPDIR`；bwrap bind、Landlock grant。
   - 让 bwrap/Landlock 的 temp 授权从 `writableRoots(policy)`/`tmpdir()` 派生，消除 P2-5；或统一把 `TMPDIR` 指到已授权目录。
3. **`/dev/shm`**（P2）：bwrap 显式 `--tmpfs /dev/shm` 并文档化私有语义；Landlock 文档化不支持，必要时让运行时改用 workspace temp。
4. **`/tmp` 持久性**（P2/P3）：明确“bwrap temp 单次执行”；需要跨命令时用 session temp bind。
5. **partial ABI**（P3）：增加旧 ABI/模拟 launcher 的 CI leg，覆盖 `truncate`/`ioctl` 与 partial 提示。
6. **文档**：在 `docs/subsystems/sandbox.*` 与 home-write 预设描述中同步上述差异；本次只加测试与审计记录，未改行为代码。

## 7. 新增/补强 e2e 与运行方式

新增 [`packages/sandbox/sandbox-local/tests/linux-probe.e2e.ts`](../packages/sandbox/sandbox-local/tests/linux-probe.e2e.ts)：12 个测试，覆盖 §3 的矩阵（bwrap 与 Landlock 同一文件内并排跑）、真实回退链、`landlock-run` 的 `--probe`/125 合同、`danger-full-access` 消费者绕过，并输出 `LINUX_SANDBOX_ENV` / `LINUX_SANDBOX_REPORT` 供取证。

在真实 Linux 上运行（CI 实际使用的命令）：

```bash
# Ubuntu 24.04; bwrap 主链 + Landlock 回退链
sudo apt-get update -q
sudo apt-get install -yq bubblewrap musl-tools
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 || true
pnpm install --frozen-lockfile
pnpm --dir native/system run build:ts
pnpm --dir native/system run build:native
node node_modules/vitest/vitest.mjs run --config vitest.e2e.config.ts \
  packages/sandbox/sandbox-local/tests/bwrap.e2e.ts \
  packages/sandbox/sandbox-local/tests/landlock.e2e.ts \
  packages/sandbox/sandbox-local/tests/linux-probe.e2e.ts
```

结果（CI run 42206614851）：`Test Files 3 passed (3)` / `Tests 30 passed (30)`；`bwrap smoke` = `BWRAP_OK`；`landlock-run --probe` = `landlock: fully enforced`；`--probe --ro /` = exit `125` + `landlock-run: usage error`。

Windows 本机（无 Linux 内核）只能跑 skip 检查：`linux-probe.e2e.ts` 报 `12 skipped`——本文件的断言不会在 Windows 上误报。

## 8. 阻塞点与未覆盖项

- **本机无 WSL 发行版、无 Docker/Podman/VM**：`wsl -l -v` 无发行版；所以使用 GitHub Actions；没有在 Windows 本机“模拟”Linux。
- **临时取证分支/workflow**：`probe/linux-sandbox` 与 `.github/workflows/linux-sandbox-probe.yml` 仅用于跑 CI，取证后删除；不进入交付提交。
- **partial enforcement 未实测**：runner 的 Landlock 是 full（ABI ≥ 5）；旧内核的 partial 分支、`truncate`/`ioctl` 未覆盖。
- **macOS/Seatbelt 未在本次重测**：对照表的 macOS 列来自 `seatbelt.e2e.ts` 与 `seatbeltProfileArgs` 代码；上游 `sandbox.yml` 的 macOS leg 可在合并后覆盖。
- **home-write 产品入口已禁用**（DH-902）：本报告的 home-write 测试直接调用 `LocalSandboxProvider.confine()`，不代表当前产品可选；它评估的是“如果恢复”的风险。
- **未修改任何沙箱行为代码**：本任务只加 e2e 与审计记录；修复建议需另开实现任务。

## 9. 关联

- DH-903（本任务）；DH-901（Windows Low 标签风险评估）；DH-902（home-write 入口禁用）。
- 原设计：[home-write-sandbox.md](home-write-sandbox.md)；禁用记录：[home-write-disabled.md](home-write-disabled.md)。
