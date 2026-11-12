# 沙箱与软工具策略

[English](sandbox.md) | 中文

部署会在两种文件效果层之间选一种。base 组合用进程沙箱 seam隔离进程；[soft-policy overlay](../../apps/cli/config/overlays/soft-policy.yml) 用 [dsh-tool-policy](../../packages/interaction/tool-policy/README.zh.md) 取代该隔离——那是一层作用在模型工具调用上的 best-effort 黑名单。**软策略是安全性降级，不是另一种沙箱。** 进程保留登录用户的完整权限；shell 命令、PTC `run_code`、MCP 服务器、第三方插件、git hook，以及任何直接打开文件的代码都不受它的路径检查。只有当风险是“文件工具误碰凭据目录”、且确实不需要 OS 级隔离时才选择它。

<!-- uitstalie-deepseek-flash, 2026/11/06, DH-905, the page now leads with the soft tool policy; the sandbox remains as the rollback composition -->

## 软工具策略

`dsh-tool-policy` 注册 `ctx.toolPolicy` 并维护命名 profile。一个 profile 同时包含按工具名整次调用拒绝的工具规则，和按文件操作（`read`、`write`、`list`）拒绝的路径规则。overlay 禁用 `sandbox`、`sandbox-policy`、`bash-sandbox`、`pwsh-sandbox`、`fs-sandbox`、`permission` 行，挂载 `dsh-fs-local`、一个本地 shell 执行器（`dsh-bash-local` 或 `dsh-pwsh-local`），并以 `defaultProfile: guarded` 挂载 `dsh-tool-policy`。审批仍然可用，由 `DSH_APPROVAL_POLICY` 选择；策略 profile 既不隐含也不覆盖它。base 默认组合不变，因此在软策略 overlay 之后应用 `os-sandbox.yml` 即可恢复沙箱行。

| Profile | 拒绝内容 |
|---|---|
| `unrestricted` | 不拒绝任何内容。进程依然不受隔离。 |
| `guarded`（默认） | 对文件工具拒绝 `~/.ssh`、`~/.gnupg`、`~/.aws`、`~/.config/gh`、`~/.kube`、`~/.docker`、`~/.dsh`；拒绝 `run_code`。shell 工具保持可用。 |
| `guarded-no-shell` | 在 `guarded` 之上再拒绝 `bash`、`pwsh`、`run_code`。 |
| `files-read-only` | 拒绝 `write`、`edit`、`apply_patch`、`str_replace_editor`、`bash`、`pwsh`、`run_code`；读取保持允许。 |

策略分四层强制执行：per-agent schema 限制隐藏被禁工具；单调的 `ctx.tools.guard()` 即使工具被调用也拒绝；`dsh-tool-fs` 在操作前检查 `read`、`read_image`、`write`、`edit` 以及 `apply_patch` 每个文件目标的规范化路径；`tool-policy` 运行时上下文段告诉模型当前 profile、被拒绝目标和绕过面。会话 profile 由 `/policy` 选择并写入复用的 `permission/preset` 事件，因此旧构建会回退而不是失败。已下线的 `DSH_PERMISSION_MODE` 变量在加载时映射一次（`danger-full-access` 映射为 `unrestricted`，其余值映射为 `guarded`），并以弃用警告告知。

用 patch overlay 启用与回滚；两个文件都随仓库提供：

```sh
dsh --profile headless --patch apps/cli/config/overlays/soft-policy.yml "task"
dsh --profile headless --patch apps/cli/config/overlays/soft-policy.yml \
  --patch apps/cli/config/overlays/os-sandbox.yml "task"
```

软策略组合没有 `ctx.sandboxPolicy`。注入它的行——Web 的 workspace-files 与 terminal 控制器、`workflow-ptc`、PTC runtime——会保持未挂载，直到后续阶段为它们提供策略来源；因此这些能力是缺失，而不是不受限。配置、精确的提示词与拒绝文案、完整绕过清单由[包 README](../../packages/interaction/tool-policy/README.zh.md) 负责。

## 进程沙箱

[dsh-sandbox](../../packages/sandbox/sandbox) 的进程沙箱 seam 将与配套子进程提供方共享执行环境的子进程 argv 包装在文件效果策略中，而不将消费方耦合到特定平台运行器。[dsh-sandbox-local](../../packages/sandbox/sandbox-local) 提供 Linux bwrap/Landlock、macOS Seatbelt 与 Windows ACL 受限令牌后端；[dsh-bash-sandbox](../../packages/shell/bash-sandbox) 和 [dsh-pwsh-sandbox](../../packages/shell/pwsh-sandbox) 是其消费方。[dsh-sandbox-ssh](../../packages/ssh/sandbox-ssh/README.zh.md) 通过与 SSH 文件系统及子进程提供方配套的远端后端执行同一策略。

源码：[`packages/sandbox/sandbox/src/index.ts`](../../packages/sandbox/sandbox/src/index.ts)

<a id="windows-acl-backend-limitation-disk-scoped-not-process-scoped"></a>

<!-- uitstalie-deepseek-flash, 2026/11/06, DH-906, record the disk-scoped Windows ACL limitation and its constraint -->

## Windows ACL 后端的限制：磁盘级，而非进程级

Windows 后端写的是**磁盘状态**，不是进程状态。它调用 `SetNamedSecurityInfoW(..., LABEL_SECURITY_INFORMATION, ...)`，给被授权的根写入一个可继承的 `SYSTEM_MANDATORY_LABEL_ACE`（Low，`S-1-16-4096`），另外还有 DACL 的 grant 与 deny ACE。该标签 ACE 带 `(OI)(CI)`，调用会把**已经存在的整棵子树**一并重标，而不只是之后新建的文件；在本机做一次 home 根授权后，`%TEMP%` 变成 `Mandatory Label\Low Mandatory Level:(I)(OI)(CI)(NW)`。

这些状态会活过会话。结束会话、切回 `workspace-write`、进程崩溃，都不会撤掉标签与 DACL；后端没有自动回滚。恢复只能手动做，且需要提升权限：

```powershell
icacls "<root>"
icacls "<root>" /setintegritylevel "(OI)(CI)M" /T
icacls "<root>" /setintegritylevel "(OI)(CI)M"
```

第一条命令查看强制标签与 DACL；`/T` 恢复根及所有已存在的子项，不带 `/T` 只改根与未来的子项。授权写入的 DACL deny ACE 需要另行移除；恢复标签不会移除它。之后注销或重启受影响的程序，才能清掉缓存状态。完整事故记录见 [goal/windows-sandbox-limitation.md](../../goal/windows-sandbox-limitation.md)。

标签还会跟着可执行文件“传染”到进程。Medium 完整性的进程启动一个带 Low 标签的可执行文件后，**子进程就是 Low**：在那样的子进程里执行 `whoami` 报 `S-1-16-4096`，尽管父进程是 Medium。因此安装在被重标盘上的任何程序都会失去对仅限 Medium 位置的访问——本机 SP Flash Tool 在 `C:\ProgramData` 下创建目录时报 `boost::filesystem::create_directories: Permission denied`，`adb` 也写不了 `%TEMP%\adb.log`。影响范围不是工作区，而是该卷上的所有程序。把 home 根或盘根选作工作区会让整机或整盘降级；本机恢复 `D:` 全盘重标花了约五分钟的 `icacls /T`。

**对之后每一项沙箱改动的约束。** 沙箱改动**不得**对 home 根、盘根或任何其他宽目录写完整性标签或 DACL 项。隔离**必须**跟着进程走——受限令牌、Job 对象、AppContainer、独立用户或远程执行——并且**必须**可撤销、作用域最小：离开会话、切换模式或崩溃都不能留下磁盘状态。若将来恢复基于 ACL 的后端，必须先用测试证明这两个性质（退出与崩溃都能清理、不做整棵子树重标），才能再次提供该后端。

## 模式与强制执行

`SandboxMode` 仅管控文件系统效果。`read-only` 要求后端拒绝写入——POSIX runner 还会授予其 shell 所需的 `/dev/null` 接收器，而 Windows ACL runner 不授予任何显式可写根目录，并因环境 ACL 缺口报告部分强制执行；`workspace-write` 允许在工作区根目录、受支持的额外目录及后端承诺的临时区域下写入；`home-write` 允许在用户主目录、Windows 上除系统盘之外的每个固定盘、会话工作区及配置的临时例外下写入，`excludePaths` 在任意被授权根目录内挖出只读洞；`danger-full-access` 绕过隔离。Windows 子进程忽略额外目录授权；Harness 文件工具独立执行这些授权。网络与进程可见性不在此处的定义范围内。

```ts type-equiv
/**
 * File-effect policy for confined processes. `read-only` permits only required
 * sinks such as `/dev/null`; `workspace-write` also permits the workspace,
 * explicit extra roots where supported, and backend-defined temp areas; `home-write` permits the canonical
 * home, every non-system fixed drive on Windows, the session workspace, and configured
 * temp exceptions, with `excludePaths` carving read-only holes out of all of them;
 * `danger-full-access` bypasses confinement. Network and process visibility are outside
 * this vocabulary.
 */
type SandboxMode = 'read-only' | 'workspace-write' | 'home-write' | 'danger-full-access'
```

每种受限模式都可以发送给 provider。`danger-full-access` 消费方直接 spawn 原始 argv，不调用 `ctx.sandbox`。

```ts type-equiv
/** A confining (non-`danger-full-access`) mode — the modes a {@link SandboxPolicy} can carry. */
type ConfinedSandboxMode = Exclude<SandboxMode, 'danger-full-access'>
```

强制执行完整性是后端报告的事实。`full` 表示后端管控了该模式承诺的所有文件效果；`partial` 表示活跃后端或较旧的内核 ABI 仅管控其中一个子集，因此要求绝对保证的消费方必须拒绝或向上暴露这一区别。当前的部分强制执行情形包括较旧的 Landlock ABI，以及 Windows ACL runner 的硬链接、读取不受限与 AppContainer ACL 边界。

```ts type-equiv
/**
 * Enforcement completeness for this host. `partial` means an active backend or
 * older kernel ABI cannot govern every promised file effect; callers requiring
 * an absolute boundary must not treat it as `full`.
 */
type SandboxEnforcement = 'full' | 'partial'
```

### 决策：`home-write` 是唯一的用户数据模式

`workspace-write` 对产出落在工作区之外的任务太紧，`danger-full-access` 又拆掉所有边界。`home-write` 是两者之间唯一的模式：它允许用户主目录（含隐藏目录）、Windows 上除系统盘之外的每个固定盘、会话工作区及配置的临时例外。因此即使任务要写数据盘，C: 上用户主目录之外的路径仍然只读；所有档位的读取都不受限制。`excludePaths`（默认为空——`~/.ssh`、`~/.dsh`、`~/.gnupg` 不配置就可写）把命中的已存在路径强制为只读，即使位于被授权根目录内；文档建议的加固清单是 `~/.ssh`、`~/.gnupg`、`~/.aws`、`~/.config/gh`、`~/.kube`、`~/.docker`，Windows 部署可再加 `C:\\Windows`。该模式不会替换 `fsAdditionalWritableRoots`：进程内围栏同时叠加两组根目录，进程后端仍忽略仅文件系统的字段。Landlock 无法在被授权根目录内表达只读洞，因此只装 Landlock 的宿主机在 `excludePaths` 非空时失败关闭并建议安装 bubblewrap；Windows ACL 既能授权额外根目录，也能用可继承的 DENY ACE 表达排除。在 Fedora 上 SELinux 标签依然生效——沙箱只写 DACL，从不重新打标签——因此强制策略仍可能拒绝 DACL 允许的写入，这种拒绝会作为操作自身的错误报告，而不是沙箱拒绝。仍写着已折叠 `non-critical-write` 模式或使用 `nonCriticalRoots` 的配置与会话日志，在读取时会映射为 `home-write`。本构建里 `home-write` 本身已禁用：`HOME_WRITE_ENABLED` 为 false，因此 `SANDBOX_MODES` 不含它，`resolve()` 与 `setSandboxMode()` 拒绝它，Windows ACL 授权分支在写入任何标签之前就拒绝，且 `sandbox_home_readonly` 不再注册。实现保留，留待具备生命周期安全恢复能力后再启用。

## 逐调用策略

完整执行策略会按每次能力调用解析并携带。它包括 `danger-full-access`，因此消费方可以只解析一次策略，再决定是否绕过约束。普通工具调用从调用会话的不可变 cwd 派生 `workspaceRoot`；部署配置提供无 agent 调用的回退值和共享的额外写入授权。存活 Session 的注册为后续解析添加 effect 生命周期内的目录授权。解析器保留执行环境中的绝对路径写法。执行限制的提供方在文件实际存在的位置规范化根目录，因此包含 `symlink/..` 的 cwd 会标识配套子进程提供方实际运行的目录。

```ts type-equiv
/**
 * The complete file-effect policy resolved for one capability call. The root
 * is carried even under modes that do not consume it so callers can resolve
 * policy once before choosing the enforcement path.
 */
interface SandboxExecutionPolicy {
  /** The file-effect mode this execution runs under. */
  mode: SandboxMode
  /** Absolute root directory the workspace-writable modes may write under. */
  workspaceRoot: string
  /**
   * Explicit `home-write` roots replacing the platform default (Windows: the
   * user home plus every non-system fixed drive; Linux/macOS: `$HOME`).
   * Absence means the enforcing host derives the default; `~` expands there.
   * The session workspace is always added separately.
   */
  homeWriteRoots?: readonly string[]
  /**
   * Read-only holes carved out of `home-write`: a matching path stays
   * read-only even inside a writable root. Entries are execution-world paths
   * (`~` expands on the enforcing host) naming an existing directory; a
   * trailing `/*` or `/**` means the same directory subtree, and any other glob
   * syntax is rejected. Absence means no exclusions — the mode's default.
   */
  excludePaths?: readonly string[]
  /**
   * Extra physical absolute directories `workspace-write` may also write under.
   * Absence means none. The enforcing host rejects missing, non-directory, and
   * symlinked entries on each call. Remote paths are checked on the remote host.
   * Windows process confinement ignores these; harness filesystem operations honor them.
   * These grant nothing under `read-only` or `danger-full-access`.
   */
  additionalWritableRoots?: readonly string[]
  /**
   * Extra physical absolute directories only the in-process filesystem fence
   * (`@deepseek-ai/dsh-fs-sandbox`) may write under.
   *
   * This is the narrow grant for a capability that must hand files to a
   * directory without widening what confined processes (shell, terminal, PTC)
   * may write: those backends ignore this field, so a host whose confinement
   * cannot express extra roots (Windows ACL) keeps working. The fence skips
   * entries that are missing, are not directories, or are symlinked; unlike
   * {@link additionalWritableRoots}, an unusable entry denies only itself
   * instead of failing the whole policy. Grants nothing under `read-only` or
   * `danger-full-access`.
   */
  fsAdditionalWritableRoots?: readonly string[]
  /** Extra directories writable under `home-write` (default: none). */
  homeWriteTempRoots?: readonly string[]
  /**
   * Opaque identity of the calling session (the branded `dsh-session`
   * SessionId). Backends key per-session state off it (e.g. windows-acl gives
   * each live session/workspace pair a random private temp directory and SID,
   * while the workspace SID and standing grant remain per-workspace); absent
   * for agentless calls, which fall back to per-call backend state.
   */
  sessionId?: SessionId
}
```

`ctx.sandboxPolicy.resolve()` 接收活跃会话；对于已批准的重试，还接收显式模式。该服务拥有优先级与 root 回退规则，使 bash 和 fs 不必重复实现。

```ts type-equiv
/** Inputs that select the sandbox policy for one capability call. */
interface SandboxPolicyRequest {
  /** Calling session; its immutable cwd becomes the workspace boundary. */
  session?: Session
  /** Explicit approved mode override, which outranks session policy. */
  mode?: SandboxMode
}
```

只有受约束的执行会到达 `ctx.sandbox`；传给提供方的策略在保留同一 root 的同时收窄模式。这使并发会话、消费方与一次性提权重试可以向同一提供方请求不同边界，而无需改变提供方状态。

```ts type-equiv
/**
 * What one confined execution is allowed to touch — carried PER CALL, not
 * fixed on the provider: two consumers may confine under different policies
 * at the same instant (bash under `read-only` while a confined child agent
 * needs its state directory writable), and an approved escalated retry is a
 * new call with a wider policy. Defaulting/resolution is an explicit step at
 * the consumer boundary; the provider treats the policy as fully specified.
 */
interface SandboxPolicy extends SandboxExecutionPolicy {
  /** The file-effect mode this execution runs under. */
  mode: ConfinedSandboxMode
}
```

<a id="wrapped-argv-and-classification-dialects"></a>

## 包装后的 argv 与分类方言

`RunnerFailureRule` 汇集用于判定 runner 在执行命令前失败的证据。消费方要求进程以非零状态退出，并同时满足可选的允许退出码门控，以及余下某一 stderr 行中不区分大小写的致命签名。系统会先按不区分大小写的整行精确匹配移除信息性排除项，因此无害的 runner 通知本身不能证明失败。匹配到的行仍可用作错误详情；分类过程不会重写 stderr。

```ts type-equiv
/**
 * Evidence that identifies a sandbox runner failing before it executes the
 * wrapped command. A consumer first applies {@link allowedExitCodes} when
 * present, removes {@link informationalLines} by case-insensitive exact line
 * equality, then matches {@link fatalSignatures} case-insensitively within
 * each remaining stderr line. Exit status alone never proves runner failure.
 */
interface RunnerFailureRule {
  /** Nonzero process exit codes on which this rule may match; omitted permits any nonzero exit. */
  allowedExitCodes?: readonly number[]
  /** Non-empty substrings identifying a fatal runner diagnostic on one stderr line. */
  fatalSignatures: readonly string[]
  /** Benign stderr lines excluded by exact full-line equality before fatal matching. */
  informationalLines?: readonly string[]
}
```

`ConfinedArgv` 是消费方实际 spawn 的内容。除了替换后的 argv，它还携带后端的强制执行事实和两种正交的 stderr 分类器。`denialSignatures` 用于识别沙箱正常工作时受限命令被阻止的情况。`runnerFailureRules` 用于识别沙箱 runner 在执行命令之前拒绝或失败的情况；消费方应先检查后者，将其作为沙箱基础设施故障上报，而非普通任务失败。

<!-- BEGIN uitstalie-k3, 2026/10/12, task26, 追溯补标记：task12 增补“短语之外还需路径证据”的判定语义 -->
仅命中短语并不能证明被拒绝。`dsh-sandbox` 中的共享分类器还要求该行指出一个不被本次调用可写根目录覆盖的绝对路径，因为无关工具也会打印这些普通文件系统消息（SSH 密钥被拒、包管理器自身的访问错误），而任何受限模式都不会拒绝它自己已授予的路径。缺少这项证据时，失败会以沙箱拒绝加升权提示的形式送达模型，为一个沙箱从未管辖的调用索取更宽模式。`read-only` 下没有任何路径与短语相矛盾，因此由短语单独判定。
<!-- END uitstalie-k3 -->

```ts type-equiv
/**
 * A {@link SandboxProvider.confine} result: the argv to spawn in place of
 * the caller's own, plus the enforcement completeness the selected backend
 * achieves for it.
 */
interface ConfinedArgv {
  /** The wrapped argv (runner, profile, separator, then the caller's argv). */
  argv: string[]
  /** How completely the selected backend enforces the policy's file effects. */
  enforcement: SandboxEnforcement
  /**
   * The selected backend's denial DIALECT: the case-insensitive stderr
   * substrings a file effect denied by THIS backend produces (EROFS text
   * under bwrap's read-only binds, EACCES under Landlock, EPERM under
   * Seatbelt). A consumer that infers denials from a failed run's stderr
   * matches against exactly these rather than a cross-backend union — the
   * union claims denials a given backend never produces.
   */
  denialSignatures: readonly string[]
  /**
   * Structured runner-failure evidence rules. Consumers require a matching
   * fatal stderr line (after informational exclusions) and any rule-specific
   * exit-code gate before checking denial signatures: runner failure means the
   * command never ran, while denial means confinement worked and blocked it.
   */
  runnerFailureRules: readonly RunnerFailureRule[]
}
```

[本地提供方](../../packages/sandbox/sandbox-local/README.zh.md)拥有运维配置，并将其 runner 方言映射到这些规则。[沙箱化 bash 消费方](../../packages/shell/bash-sandbox/README.zh.md)拥有 spawn 与结果归因。

## 提供方与 fail-closed 错误

`await ctx.sandbox.confine(argv, policy, signal)` 在执行环境中解析策略路径并返回 `ConfinedArgv`，没有可用后端时以 `SandboxUnavailableError`（错误码 `SANDBOX_UNAVAILABLE`）拒绝，提供方无法为该模式准备主机状态时以 `SandboxPreparationError`（`SANDBOX_PREPARATION_FAILED`、`SANDBOX_INVALID_TEMP_ROOT`）拒绝。可选信号可在启动前取消解析。消费方也可以在 spawn 或观察所返回的 argv 时对失败进行分类；该归因属于消费方约定。对于受限策略，静默的无隔离透传永远不合法。

提供方选择、探测、缓存和后端特定的强制执行报告归[本地提供方](../../packages/sandbox/sandbox-local/README.zh.md)所有。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxsandbox--sandboxprovider-abstract-seam"></a>

### `ctx.sandbox` — `SandboxProvider` (abstract seam)

Abstract process-sandbox service. confine must return enforcing argv or fail closed at wrap or runner-execution time; silent unconfined passthrough is forbidden. Functional probes arbitrate multi-runner chains and may be skipped for a sole candidate, whose own refusal remains the fail-closed end.

```ts cordis-catalog
/**
 * Wrap `argv` so it executes confined under `policy` on this host; the
 * caller spawns the returned argv in place of its own.
 * @param argv - the exact argv the caller is about to spawn (program plus
 *   arguments), NOT a shell string — a shell-shaped consumer passes
 *   `['bash', '-c', command]`.
 * @param policy - the file-effect policy this execution runs under,
 *   carried per call (see {@link SandboxPolicy}).
 * @param signal - cancellation while the provider resolves the policy and runner.
 * @returns the argv to spawn instead, plus the enforcement completeness
 *   the selected backend achieves for it.
 */
abstract confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv>
```

Source: [`packages/sandbox/sandbox/src/index.ts`](../../packages/sandbox/sandbox/src/index.ts)

<a id="ctxsandboxpolicy--sandboxpolicyservice"></a>

### `ctx.sandboxPolicy` — `SandboxPolicyService`

The sandbox-policy service (`ctx.sandboxPolicy`). Owns the deployment default mode, fallback workspace root, session-scoped directory grants, and request-time policy section. Tool layers call resolve for each execution so a session's mode log and immutable cwd travel together to every enforcing capability.

```ts cordis-catalog
/**
 * Resolve the complete policy for one capability call. An approved explicit
 * mode outranks the session's last `sandbox/mode` event, which outranks the
 * deployment default. A session cwd is its workspace-write boundary; the
 * configured root is the fallback for agentless calls and sessions without a
 * cwd. Configured extra roots, this Session's active registrations, and
 * capability-registered fs-only grants are snapshotted together, so the
 * in-process filesystem fence can receive directories that process
 * confinement deliberately does not; existing operations and processes keep
 * their policy.
 * @param request - optional session and approved mode override.
 * @returns the fully resolved per-call mode and absolute workspace root.
 * @throws `SandboxInvalidRootError` (`SANDBOX_INVALID_ROOT`) when the session's recorded cwd is
 *   relative or contains a NUL byte.
 */
resolve(request: SandboxPolicyRequest = {}): SandboxExecutionPolicy

/**
 * Permit writes under one directory in this Session's future workspace-write
 * operations. The calling context owns the effect; disposal removes only this
 * registration. Other grants to the directory remain effective. Existing
 * operations and persistent processes retain their resolved permissions.
 * Grants are runtime-only and must be registered again after resume or fork.
 * On Windows, only harness file tools honor extra grants; process permissions stay unchanged.
 * @param session - exact live Session receiving the grant; other Sessions and agentless calls are unaffected.
 * @param directory - absolute execution-world path; execution rejects missing, non-directory, or symlinked paths.
 * @returns the exact Cordis effect disposer for this registration.
 * @throws when the directory is relative or contains a NUL byte.
 */
registerWritableRoot(session: Session, directory: string): () => void

/**
 * Register one session-scoped filesystem-fence grant. The provider is
 * consulted on every resolution; a failing provider is logged and ignored so
 * a broken capability cannot take the whole tool surface down. Only absolute
 * entries are kept, and duplicates are dropped. The grant never reaches a
 * process sandbox: see {@link SandboxExecutionPolicy.fsAdditionalWritableRoots}.
 * @param provider - the session → extra directories function.
 * @returns the exact disposer that removes the provider.
 */
registerFsWritableRoots(provider: FsWritableRootsProvider): () => void

/**
 * Read the session override without applying the deployment default.
 * @param session - session whose log supplies the override.
 * @returns the last logged mode, or `undefined` without one.
 */
overrideOf(session: Session): SandboxMode | undefined
```

Types: [Session](session.zh.md)

Source: [`packages/sandbox/sandbox-policy/src/index.ts`](../../packages/sandbox/sandbox-policy/src/index.ts)

<a id="ctxtoolpolicy--toolpolicyservice"></a>

### `ctx.toolPolicy` — `ToolPolicyService`

Named soft-policy profiles over model tool calls. Requires the session projection registry (the profile fold) and the agent registry (per-agent visibility); the tools, prompt, and command registries are optional children.

```ts cordis-catalog
/**
 * Whether a profile is defined.
 * @param name - candidate profile name.
 * @returns true when `/policy` may select it.
 */
has(name: string): boolean

/**
 * Look up a profile.
 * @param name - profile name.
 * @returns the prepared profile.
 * @throws when the name is unknown.
 */
profile(name: string): PreparedProfile

/**
 * Resolve the profile in force for a session: the last reused
 * `permission/preset` name wins when it names a defined profile; otherwise
 * the deployment default. A retired permission preset (e.g.
 * `workspace-write`) is not a profile, so it falls back instead of throwing.
 * @param session - the calling session, if any.
 * @returns the prepared profile.
 */
profileForSession(session: Session | undefined): PreparedProfile

/**
 * Resolve the profile for an agent.
 * @param agent - the calling agent.
 * @returns the prepared profile.
 */
profileForAgent(agent: Agent): PreparedProfile

/**
 * Denial reason for one tool call, used by the monotonic guard.
 * @param toolName - the model-visible tool name.
 * @param exec - the pending execution (its agent selects the profile).
 * @returns the model-facing denial reason, or undefined to allow.
 */
toolDenialReason(toolName: string, exec?: ToolExecution): string | undefined

/**
 * Canonicalize and check one file target without throwing on a denial.
 * @param operation - read, write, or list.
 * @param hostPath - the backend's process path for the target.
 * @param exec - the calling tool execution.
 * @returns the matched rule and target, or undefined when allowed.
 * @throws {FsError} `FS_POLICY_DENIED` when the path cannot be canonicalized.
 */
checkFileAccess(operation: FileAccessOperation, hostPath: string, exec?: ToolExecution): PathDenial | undefined

/**
 * Assert that a file target may be touched under the calling session's
 * profile. Tool implementations call this after resolving the target.
 * @param operation - read, write, or list.
 * @param hostPath - the backend's process path for the target.
 * @param exec - the calling tool execution.
 * @throws {FsError} `FS_POLICY_DENIED` with the matched rule.
 */
assertFileAccess(operation: FileAccessOperation, hostPath: string, exec?: ToolExecution): void

/**
 * Select a profile for one session. The selection is durable through the
 * reused `permission/preset` event; the user command and authorized super-agent tool call this.
 * @param session - the session whose profile changes.
 * @param name - a defined profile name.
 * @param reason - optional audit reason retained on the profile event.
 */
select(session: Session, name: string, reason?: string): void
```

Types: [Agent](core.zh.md) · [Session](session.zh.md) · [ToolExecution](tools.zh.md)

Source: [`packages/interaction/tool-policy/src/index.ts`](../../packages/interaction/tool-policy/src/index.ts)
<!-- END GENERATED cordis-surface -->
