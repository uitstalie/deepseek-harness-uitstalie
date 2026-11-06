---
description: "面向接受进程级文件访问的部署的软工具策略插件：命名 profile 拒绝模型工具调用与文件工具目标，不做任何 OS 隔离。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-policy

[English](README.md) | 中文

## 摘要

`dsh-tool-policy` 是**作用在模型工具调用上的软策略（best-effort）**，不是 OS 沙箱。它注册 `ctx.toolPolicy`，由命名 profile 同时维护工具黑名单与文件目标黑名单：被禁工具会从模型 schema 中消失，并由单调工具守卫拒绝；`dsh-tool-fs` 在读取、写入、编辑或打补丁前询问该服务。进程保留用户的完整权限，因此 shell 命令、PTC 代码、MCP 工具、其他插件，以及任何直接调用 `node:fs` 的代码都完全绕过该策略。当部署只想让模型碰不到凭据目录和少数工具、又不愿承担进程隔离的成本时选择它；当文件效果边界必须成立时，应选择 [`dsh-sandbox-local`](../../sandbox/sandbox-local/README.zh.md) 配合沙箱化文件系统与 shell。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发者备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把本插件与不受限的文件系统后端和 shell 执行器一起挂载（`dsh-fs-local`、`dsh-bash-local` 或 `dsh-pwsh-local`）。它需要会话投影注册表，base 组合已经挂载；它在工具注册表、system prompt、命令注册表和 agent 注册表存在时使用它们，缺少其中任何一个也能工作。随包提供的 [soft-policy overlay](../../../apps/cli/config/overlays/soft-policy.yml) 就是完整组合：禁用沙箱行、挂载本地后端，并以 `defaultProfile: guarded` 挂载本插件。

### 安全披露

进程没有被隔离。策略拒绝给文件工具的任何目标，仍然可以通过 shell 命令、`run_code`（PTC）、MCP 服务器、第三方插件、git hook，或任何自己打开该路径的程序到达。策略只检查模型经工具注册表发起的工具调用，以及调用 `ctx.toolPolicy.assertFileAccess` 的文件工具。它是安全与误操作防护层，不是安全边界。

### 最小组合

```yaml
- id: fs-local
  name: '@deepseek-ai/dsh-fs-local'

- id: bash-local
  name: '@deepseek-ai/dsh-bash-local'

- id: tool-policy
  name: '@deepseek-ai/dsh-tool-policy'
  config:
    defaultProfile: guarded
```

### Profile

一个 profile 由名字、一句由 `/policy` 和提示词展示的 `description`、可选的路径规则和可选的工具规则组成。配置项合并到内置 profile 之上：写出某个内置 profile 的名字会整体替换它，而不是向它的列表追加。未知的 `defaultProfile`、相对路径规则、未知操作或重复工具名都会在加载时失败。

| Profile | 含义 |
|---|---|
| `unrestricted` | 没有路径或工具拒绝。进程依然不受隔离。 |
| `guarded`（默认） | 对文件工具的读/写/列目录拒绝 `~/.ssh`、`~/.gnupg`、`~/.aws`、`~/.config/gh`、`~/.kube`、`~/.docker`、`~/.dsh`，并拒绝 `run_code`。shell 工具保持可用。 |
| `guarded-no-shell` | 在 `guarded` 之上再拒绝 `bash`、`pwsh`、`run_code`。 |
| `files-read-only` | 拒绝 `write`、`edit`、`apply_patch`、`str_replace_editor`、`bash`、`pwsh`、`run_code`；读取保持允许。 |

### 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `defaultProfile` | `guarded` | 会话起始 profile。`/policy` 与复用的 `permission/preset` 事件按会话覆盖它。 |
| `profiles` | `{}` | profile 定义；每个键替换同名内置项。 |
| `profiles.<name>.description` | 名字本身 | 由 `/policy` 与模型提示词展示的一句话。 |
| `profiles.<name>.paths` | `[]` | 路径规则；目标的词法或物理拼写位于规则根或其下即拒绝。 |
| `profiles.<name>.paths[].path` | 必填 | 绝对路径或以 `~` 开头；准备 profile 时规范化。 |
| `profiles.<name>.paths[].operations` | 全部 | `read`、`write`、`list` 中任意若干项。 |
| `profiles.<name>.paths[].includeSelf` | `true` | 规则根自身是否也拒绝。 |
| `profiles.<name>.paths[].reason` | 无 | 追加到拒绝信息里的、面向模型的解释。 |
| `profiles.<name>.tools` | `[]` | 整次调用即拒绝的、精确的模型可见工具名，每项可带 `reason`。 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-policy)是所有受支持字段的权威来源。

### 选择 profile

`/policy` 报告或切换当前会话的 profile。它把 profile 名写入复用的 `permission/preset` 会话事件，因此旧构建会把该选择视为未知预设并回退，而不是崩溃。优先级是会话选择，然后是部署的 `defaultProfile`。模型不能修改 profile。

已下线的 `DSH_PERMISSION_MODE` 环境变量保留一个版本的别名：`danger-full-access` 选择 `unrestricted`，其余值选择 `guarded`，插件会记录一条弃用警告并说明最终选中的 profile。它覆盖配置的 `defaultProfile`，与沙箱配置原先的优先级一致。

### 启用与回滚

在 profile 自有层之后应用随包提供的 overlay：

```sh
dsh --profile headless --patch apps/cli/config/overlays/soft-policy.yml "task"
```

base 组合未改动，因此去掉 overlay 即恢复 OS 沙箱。若某个 profile 已经把软策略行写进自己的配置，可在其后应用显式回滚 overlay：

```sh
dsh --profile headless \
  --patch apps/cli/config/overlays/soft-policy.yml \
  --patch apps/cli/config/overlays/os-sandbox.yml "task"
```

-----


<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

策略分四层。**可见性**按 profile 应用 per-agent 的 `ctx.tools.restrict({ deny })`，被禁工具因此不出现在模型 schema 与 PTC SDK 中；`run_code` 刻意不传给 `restrict`，因为注册表为 PTC 传输保留了它，该拒绝由守卫负责。**执行门**是单调的 `ctx.tools.guard()`，在可扩展的 pre-execute 策略之后运行，因此监听器顺序或过期的可见性掩码都无法把拒绝变回允许。**文件目标**由 `dsh-tool-fs` 通过 `assertFileAccess` 检查：工具先解析目标、在任何变更之前调用；`read`、`read_image`、`write`、`edit` 以及 `apply_patch` 的每个文件目标都会调用它。**提示词与命令**注册 `tool-policy` system-prompt 上下文和 `/policy`。

路径规则按两种拼写匹配。配置的规则会展开 `~`、转为绝对路径并规范化；请求目标按会话 cwd 规范化，最近的存在祖先经 `realpath` 解析；两者用相对路径判断而非字符串前缀比较，因此 `~/.ssh2` 不匹配 `~/.ssh`。Windows 盘符、UNC 共享、`\\?\` 前缀、备用数据流以及末尾点/空格都会被归一化；盘符相对与设备命名空间路径按失败关闭处理。无法规范化的目标按拒绝处理，而不是放行。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | `ToolPolicyService`、`ctx.toolPolicy`、profile 解析、拒绝 |
| [`src/profiles.ts`](src/profiles.ts) | 内置 profile、配置校验、已下线的环境变量别名 |
| [`src/canonicalize.ts`](src/canonicalize.ts) | 各平台路径语法、`~`、物理路径解析 |
| [`src/match.ts`](src/match.ts) | 带操作过滤的词法/物理前缀匹配 |
| [`src/guard.ts`](src/guard.ts) | 单调工具守卫 |
| [`src/visibility.ts`](src/visibility.ts) | per-agent schema 限制与 profile 切换重应用 |
| [`src/prompt.ts`](src/prompt.ts) | 面向模型的策略上下文 |
| [`src/command.ts`](src/command.ts) | `/policy` |

</details>

-----


<a id="further-exploration"></a>
## 进一步阅读

- [沙箱与软工具策略](../../../docs/subsystems/sandbox.zh.md)——子系统页，含本策略可替代的 OS 沙箱。
- [tool-fs](../../fs/tool-fs/README.zh.md)——调用文件目标检查的模型可见工具。
- [sandbox-local](../../sandbox/sandbox-local/README.zh.md) 与 [sandbox-policy](../../sandbox/sandbox-policy/README.zh.md)——base 组合改用它们的隔离。

-----


<a id="model-experience"></a>
## 模型体验

### 工具策略上下文与拒绝

#### 模型看到什么

每个请求都带一个由当前 profile 渲染的运行时上下文段。`guarded` 组合产生：

> Current DSH tool policy: guarded (soft policy; the process has full user permissions and is NOT OS-confined). Baseline soft policy: credential/DSH paths are denied to file tools; run_code is disabled. File-tool access is denied for: `~/.ssh` (read/write/list), … . Tools denied: run_code (…). This policy only checks model tool calls. Shell commands, scripts, PTC code, MCP tools, and direct native file access are not path-checked by it; do not use them to reach a denied path.

被拒绝的工具调用返回 `tool "<name>" is denied by DSH tool policy "<profile>": <reason>`。被拒绝的文件目标以 `FS_POLICY_DENIED` 失败，文本为 `cannot <operation> "<path>": it is under the tool-policy denied path "<rule>" (<operations>) in profile "<profile>"; <reason>. This is a soft policy over model tool calls, not an OS sandbox.` 被允许的调用不变：策略不新增 schema 字段，也不触发审批提示。

#### Token 影响

每个请求多一小段运行时上下文。拒绝会把常规工具结果替换为一到两句错误；没有需要省下的成功载荷。

#### KV Cache 影响

追加式。profile 不变时该上下文段稳定；`/policy` 切换会追加新段，可复用的请求前缀仍然有效。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- **不是安全边界。** shell 命令、`run_code`、MCP 工具、插件、git hook 与直接原生文件访问都在检查之外。被拒绝的路径仍可经其中任一途径到达。
- **`run_code` 的可见性固定。** 工具注册表拒绝限制 PTC 传输，因此在挂载 PTC 执行器处，被拒绝的 `run_code` 仍会列出，只由守卫拒绝。
- **检查与使用之间存在时间窗。** 目标在操作前一刻规范化；检查与系统调用之间的并发符号链接替换并未消除。
- **远程与不透明目标跳过。** 非绝对的后端路径交给该后端处理，而不是拒绝。
- **搜索未覆盖。** `dsh-tool-fs-search` 尚无搜索根或排除检查。
- **只有 `dsh-tool-fs` 调用文件目标检查。** 其他直接经 `ctx.fs` 读写的插件不会被检查。

<a id="dev-note"></a>
### 开发者备注

<details>
<summary>维护者工作上下文——点击展开</summary>

会话 profile 存放在既有的 `permission/preset` 事件里，使旧构建能重放新会话而不遇到未知事件类型；这里的载荷是 profile 名，之前是 permission preset 名。`SESSION_FORMAT_VERSION` 不变。已下线的四个沙箱预设（`read-only`、`workspace-write`、`home-write`、`danger-full-access`）刻意不作为 profile 名，因此过期的选择会回退到部署默认。

</details>
