---
kind: upgrade-guide
description: "权限旗标改为 --policy，DSH_PERMISSION_MODE 变成弃用别名，可选的 soft-policy overlay 用工具黑名单取代 OS 沙箱。"
---

# 工具策略与 soft-policy overlay

[English](guide.md) | 中文

## 变更

headless 单次运行应用的 `--permission-mode` 改名为 `--policy`。旧旗标仍可用一个版本，并向 stderr 打印 `dsh: --permission-mode is deprecated; use --policy.`；后续版本会移除它。当组合挂载 `dsh-tool-policy` 时，`--policy` 接受工具策略 profile；当挂载已下线的预设服务时回退到 permission preset，因此同一条命令在两种组合上都可用。

`DSH_PERMISSION_MODE` 已弃用。挂载 `dsh-tool-policy` 时，插件在加载时把该变量映射为 profile——`danger-full-access` 映射为 `unrestricted`，其余值映射为 `guarded`——记录该映射，并把它用作部署默认。base 组合仍会为其沙箱行读取该变量，因此映射只在挂载软策略处生效。

仓库新增两个 patch overlay。`soft-policy.yml` 禁用 `sandbox`、`sandbox-policy`、`bash-sandbox`、`pwsh-sandbox`、`fs-sandbox`、`permission` 行，挂载 `dsh-fs-local`、一个本地 shell 执行器，以及带 `defaultProfile: guarded` 的 `dsh-tool-policy`，并从 `DSH_APPROVAL_POLICY` 取审批策略。`os-sandbox.yml` 在它之后应用时恢复 base 行。base 组合没有改动，因此两个 overlay 都不是必需的，默认行为仍是 OS 沙箱。

在软策略组合里，面向模型的运行时上下文用 `Current DSH tool policy: …` 取代 `Current DSH file policy: …`，并说明进程拥有完整权限、未受 OS 隔离。命中被拒绝路径的文件工具以新错误码 `FS_POLICY_DENIED` 失败。由于预设行被禁用，`/permission` 命令不存在；改用 `/policy` 选择 profile。

## 迁移

1. 把脚本、服务单元、CI 作业与 SDK 启动器中的 `--permission-mode` 换成 `--policy`。只有在某个消费方被锁定在本版本时，才继续使用弃用拼写。
2. 如果启动环境导出 `DSH_PERMISSION_MODE`，把选择迁到 profile patch 里的 `tool-policy.defaultProfile`，或迁到 agent preset。别名只保留一个版本，生效时会记录警告。
3. 要采用软策略，先把 overlay 引用的包（`@deepseek-ai/dsh-fs-local`、`@deepseek-ai/dsh-bash-local` 或 `@deepseek-ai/dsh-pwsh-local`、`@deepseek-ai/dsh-tool-policy`）安装进 profile，再用 `--patch apps/cli/config/overlays/soft-policy.yml` 应用 overlay。要接受进程不再被隔离：shell 命令、PTC 代码、MCP 服务器、插件与直接原生文件访问都在路径检查之外。需要文件效果边界的部署继续使用 base 组合。
4. 保留 `--add-dir`：它给沙箱授予工作区根目录，在没有挂载 `sandboxPolicy` 服务时会以明确错误失败。位于提供方插件里的校验器运行在 CLI 进程内，看不到 MCP 服务器目录，因此依赖 `--add-dir` 的软策略部署必须把这部分工作移到沙箱组合或不沙箱的路径上。
5. 只针对真正挂载 overlay 的组合，更新那些断言已下线策略行的已提交期望输出，以及从工具 schema 解析 `sandbox_permissions` 的脚本。默认组合的输出没有变化。
6. 重新构建那些直接导入 `@deepseek-ai/dsh-sandbox` 类型或调用 `ctx.sandboxPolicy` 的自定义 Client 或 Host 插件；软策略组合不挂载这些服务，因此这样的行会保持未挂载。

## 验证

1. `dsh --profile headless --help` 列出 `--policy` 与已弃用的 `--permission-mode`。
2. `dsh --profile headless --permission-mode guarded "task"` 在 stderr 打印弃用警告，并按所选策略运行。
3. 应用 soft-policy overlay 后，对 `~/.ssh` 下文件工具的读取以 `FS_POLICY_DENIED` 失败，请求上下文显示 `Current DSH tool policy: guarded`；`dsh --profile headless --add-dir /tmp/x "task"` 明确报错，而不是静默丢弃授权。
4. 在 `soft-policy.yml` 之后应用 `os-sandbox.yml` 会重新挂载沙箱行，新会话报告 `Current DSH file policy: workspace-write`。
