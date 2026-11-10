---
kind: upgrade-guide
description: "权限旗标改为 --policy，DSH_PERMISSION_MODE 变成弃用别名，可选的 soft-policy overlay 用工具黑名单取代 OS 沙箱。"
---

# 工具策略与 soft-policy overlay

[English](guide.md) | 中文

## 变更

headless 单次运行应用的 `--permission-mode` 改名为 `--policy`。旧旗标在一个版本内向 stderr 打印 `dsh: --permission-mode is deprecated; use --policy.`。挂载 `dsh-tool-policy` 时，`--policy` 选择工具策略 profile；挂载已下线的预设服务时选择 permission preset。

`DSH_PERMISSION_MODE` 已弃用。挂载 `dsh-tool-policy` 时，插件在加载时把该变量映射为 profile——`danger-full-access` 映射为 `unrestricted`，其余值映射为 `guarded`——记录该映射，并把它用作部署默认。base 组合仍会为其沙箱行读取该变量，因此映射只在挂载软策略处生效。

`soft-policy.yml` overlay 禁用沙箱与权限行，挂载本地文件系统/shell 后端及带 `defaultProfile: guarded` 的 `dsh-tool-policy`，并从 `DSH_APPROVAL_POLICY` 取审批策略。随后应用 `os-sandbox.yml` 会恢复 base 行。base 组合不变，默认仍使用 OS 沙箱。

在软策略组合里，面向模型的运行时上下文用 `Current DSH tool policy: …` 取代 `Current DSH file policy: …`，并说明进程拥有完整权限、未受 OS 隔离。命中被拒绝路径的文件工具以新错误码 `FS_POLICY_DENIED` 失败。由于预设行被禁用，`/permission` 命令不存在；改用 `/policy` 选择 profile。

## 迁移

1. 把脚本、服务单元、CI 作业与 SDK 启动器中的 `--permission-mode` 换成 `--policy`。只有在某个消费方被锁定在本版本时，才继续使用弃用拼写。
2. 如果启动环境导出 `DSH_PERMISSION_MODE`，把选择迁到 profile patch 里的 `tool-policy.defaultProfile`，或迁到 agent preset。别名只保留一个版本，生效时会记录警告。
3. 要采用软策略，把 `@deepseek-ai/dsh-fs-local`、一个本地 shell 包与 `@deepseek-ai/dsh-tool-policy` 安装进 profile，再应用 `--patch apps/cli/config/overlays/soft-policy.yml`。进程不再被隔离：shell、PTC、MCP、插件与原生文件访问都绕过路径检查。需要文件效果边界的部署继续使用 base 组合。
4. 保留 `--add-dir`：它给沙箱授予根目录，没有 `sandboxPolicy` 时明确报错。提供方校验器运行在 CLI 内，看不到 MCP 服务器目录；需要该授权的工作应移到沙箱组合或不沙箱的路径。
5. 对挂载 overlay 的组合，更新断言已下线策略行的期望输出，以及从工具 schema 解析 `sandbox_permissions` 的脚本。默认输出不变。
6. 重新构建导入 `@deepseek-ai/dsh-sandbox` 类型或调用 `ctx.sandboxPolicy` 的插件；软策略组合不挂载这些服务，因此该行保持未挂载。

用以下命令确认迁移结果：

- `dsh --profile headless --help` 列出两个策略旗标。
- `dsh --profile headless --permission-mode guarded "task"` 打印弃用警告。
- 软策略下，读取 `~/.ssh` 的文件工具以 `FS_POLICY_DENIED` 失败；没有 `sandboxPolicy` 时，`--add-dir /tmp/x` 明确报错。
- 在 `soft-policy.yml` 后应用 `os-sandbox.yml` 会恢复 `Current DSH file policy: workspace-write`。
