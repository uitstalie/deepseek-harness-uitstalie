# 软沙箱（soft tool policy）设计

Status: **accepted；Phase 0 implemented（2026/11/06）**
Jira: **DH-904** — 关联 DH-901（Windows home-write 风险）、DH-902（home-write 入口禁用）、DH-903（Linux 实测）

> **安全披露（必须先读）**：本设计是**安全降级**。进程以完全用户权限运行；本插件只是“按工具调用和文件目标做黑名单”的**软策略**，**不是 OS 沙箱，也不是安全边界**。shell、PTC `run_code`、MCP/第三方插件、直接 `node:fs`、子进程都可以绕过它。需要真正隔离时，请把 DSH 跑在容器/VM/远程执行环境里。

## 0. 已拍板决策（不再变更）

1. **默认 profile = `guarded`**：进程仍完全权限，`guarded` 的窄基线黑名单生效。
2. **`guarded` 允许 shell**（`bash`/`pwsh`）；文档与提示词明说“shell 可绕过路径黑名单”。另提供 `guarded-no-shell`。
3. **`guarded` 禁用 `run_code`（PTC）**：PTC 程序可直接 `import fs`，工具级路径检查对它无效。
4. **软策略 deny 不做 one-shot approval**：deny 即终局；approval 只留给其它工具自身的确认。
5. **会话 profile 事件复用 `permission/preset`**（payload 字符串），不新增事件类型；便于回滚到旧构建。
6. **旧四档 `read-only` / `workspace-write` / `home-write` / `danger-full-access` 全部下线**；只保留配置弃用警告与 `DSH_PERMISSION_MODE` 别名映射：`danger-full-access` → `unrestricted`，其余 → `guarded`。

## 1. 新模型

| 层 | 新状态 |
| --- | --- |
| OS / 进程 | 完全权限（`fs-local` / `bash-local` / `pwsh-local`）；不挂 `sandbox-local`、不挂 `sandbox-windows-acl`，无 ACL/SACL/token/标签/runner |
| 策略 | `tool-policy` 插件按命名 profile 做工具黑名单 + 文件目标黑名单 |
| 默认 | `guarded`（窄基线；见 §5） |
| 模型权限 | 模型不能改 profile、不能改黑名单；只能由用户 `/policy`、部署配置、agent preset 选择 |

## 2. Seam 选择（为什么不是全局 `ctx.fs`）

已核对：`ctx.fs` 有 153 处消费方，覆盖 Web 文件预览（`api/workspace-files`、`session-controller` 的文件服务）、attachments、skills、agent-instructions、deliverables 等。**把黑名单挂到全局 `ctx.fs` 会误伤这些内部读取**；`ctx.fs` 调用也不携带“调用方是否为模型工具”的身份，无法只拦模型。

因此采用**四层**：

| 层 | 职责 | 实现 |
| --- | --- | --- |
| L1 可见性 | 被禁工具不出现在 schema / PTC SDK | per-agent `agent.ctx.tools.restrict({ deny })`；按 `ctx.tools.schemas()` 过滤未挂载名字；`run_code` 不能 restrict，由 L2 兜底 |
| L2 执行门 | 即使绕过可见性也拒绝 | `ctx.tools.guard()`（单调、同步）：按 profile 的 tool deny 返回理由；覆盖直接调用与 PTC nested |
| L3 文件路径 | 文件工具的读/写/补丁目标 | `tool-fs` 入口中间件 `assertFileAccess(...)`；目标先由 `ctx.fs.resolve` 解析，再取 `processPath` |
| L4 搜索/shell/PTC | 搜索根、shell、代码 | `tool-fs-search` 搜索根检查 + ripgrep 排除（Phase 1.5）；shell 只整工具禁用；`run_code` 在 `guarded` 整工具禁用 |

**不做**：全局 `ctx.fs` 黑名单、shell 命令字符串解析、`sandbox_permissions` 升权。

## 3. 配置、profile 与优先级

- **部署配置**（`cordis.yml`）：`profiles` 全量定义 + `defaultProfile`；路径规则只来自这里或 agent preset，**不来自模型/会话自由文本**。
- **agent preset**：Phase 1 支持选择 profile；只能收紧（追加 deny），不能放宽部署基线。
- **会话**：用户 `/policy <name>` 只能从已定义 profile 中选择；写入 `permission/preset` 事件（payload 字符串），投影为 `toolPolicyProfile`。
- **优先级**：会话事件 > agent preset > 部署 `defaultProfile`。旧 session 里的 `read-only`/`workspace-write`/`home-write`/`danger-full-access` 不是合法 profile，回退到默认并警告（不崩）。
- **旧环境变量**：`DSH_PERMISSION_MODE` 仅作弃用别名，加载时警告并映射（见 §0.6）。

## 4. 路径规范化

`canonicalizeTarget(input, { cwd, platform, home, caseSensitive, resolvePhysical })` 产出 `{ lexical, physical? }`：

1. 拒绝空串/NUL/控制字符；`\\?\GLOBALROOT`、`\\.\` 等 device namespace 默认拒绝。
2. 相对路径按**会话 cwd**（`exec.agent.session.header.cwd`）解析，不用 `process.cwd()`。
3. `~` 只在开头展开。
4. `lexical = resolve(cwd, input)`，消除 `..`/`.`。
5. `physical`：对最近已存在祖先 `realpathSync.native`，再拼回不存在段；目标存在时直接 `realpath`。不跟随不存在段的符号链接。
6. Windows：统一 `\`、盘符大写；剥 `\\?\` / `\\?\UNC\`；UNC 按 server/share 不区分大小写；8.3/junction 交给 realpath；ADS（`file.txt:stream`）按基础文件匹配；去掉每段末尾的点/空格；drive-relative（`C:foo`）拒绝（fail closed）。
7. macOS：`/tmp` 与 `/private/tmp` 由 realpath 统一；默认大小写不敏感。
8. Linux：大小写敏感。
9. 匹配用 `relative(root, target)` 的 `''` 或非 `..` 前缀，**不用 `startsWith`**（`.ssh2` 不命中 `.ssh`）；`lexical` 或 `physical` 任一命中即拒绝。
10. TOCTOU：检查后到 syscall 之间仍可能被换 symlink；写前再 canonicalize 一次，但不承诺完全消除（文档披露）。

规则形状：`{ path, operations?: ('read'|'write'|'list')[], includeSelf?: boolean, reason? }`；默认 `includeSelf: true`、operations 全选。`apply_patch` 的每个 `*** Add/Update/Delete File:` 目标都按 `write` 检查；解析失败由现有 `PatchParseError` 整批拒绝。

## 5. Profile 与基线黑名单

| profile | 含义 | 进程 |
| --- | --- | --- |
| `unrestricted` | 无路径/工具 deny | 完全 |
| `guarded`（默认） | 窄基线：`~/.ssh`、`~/.gnupg`、`~/.aws`、`~/.config/gh`、`~/.kube`、`~/.docker`、`~/.dsh`（read/write/list）；禁 `run_code`；允许 shell | 完全 |
| `guarded-no-shell` | `guarded` + 禁 `bash`、`pwsh`、`run_code` | 完全 |
| `files-read-only` | 禁 `write`、`edit`、`apply_patch`、`str_replace_editor`、`bash`、`pwsh`、`run_code`；读允许 | 完全 |

基线刻意**窄**：不默认 deny 整个 `$HOME`/workspace/`node_modules`，避免 pnpm、编辑器 temp、git 被误伤。部署可覆盖/追加 profile；未知 profile 或非法规则在加载时报错。

## 6. 旧 preset / escalation / approval

- 四档名称不再进入工具 schema 或 UI；`tool-fs`/`tool-bash`/`tool-pwsh`/`run_code` 在 `fs-local`/`bash-local` 下因 `sandboxMode === undefined` **自动不再 advertise** `sandbox_permissions`/`justification`。
- `ESCALATION_TARGETS`/`WIDER_MODES`/`approveEscalation` 不再被会话路径使用；Phase 2 删除死代码。
- approval 只保留：
  1. 其它工具自身的确认（如 `plugin_manager`）；
  2. 软策略默认 **不做** one-shot 例外（deny 即终局；批准也改变不了进程已有能力）。
- `/permission` 由 `/policy` 取代（Phase 1 可保留一个版本的别名）。

## 7. 边界与 UI / prompt

- **不挂载**（代码保留供回滚）：`sandbox-local`、`sandbox-windows-acl`（不被 import，无标签/token）、`sandbox-policy`、`fs-sandbox`、`bash-sandbox`、`pwsh-sandbox`、`permission-presets`。
- **UI**：profile 选择器取代四档；去掉盾牌/锁图标，改“soft policy”徽标；“完全权限”是进程事实，不是某个档位；设置项文案“默认工具策略（best-effort，非 OS 沙箱）”。
- **Prompt**：删除 `Current DSH file policy: …`，新增 `tool-policy` context，必须写明：
  - profile 名与是否为 soft policy；
  - 进程完全权限；
  - 被 deny 的路径（含 operations）与被 deny 的工具；
  - shell / PTC / MCP / 直接 native 访问**不被路径检查**；
  - 不要用其它工具绕到 denied 路径。
  - 禁止写“cannot modify files”“sandbox will deny”这类会被 shell 打脸的话。

## 8. 风险与回滚

**挡不住**：shell、PTC 代码、MCP/第三方插件、直接 `node:fs`、git hooks、`curl file://`、子进程、TOCTOU。

**误伤**：基线只含凭据/系统/DSH home；提供 dry-run 日志（Phase 1）调参；Windows 路径规范化用表驱动测试覆盖。

**回滚**：旧包与旧 bundle 保留；`os-sandbox` overlay 可切回；Phase 0 不动默认组合，风险为零。会话事件复用 `permission/preset`，旧构建看到未知 profile 名只会派生 `custom`，不崩。

## 9. Phase 0 / Phase 1 / Phase 2

- **Phase 0（本轮）**：新增 `tool-policy` 包、`tool-fs` 中间件、`FS_POLICY_DENIED`、单测；**不挂载、不改 bundle、不改旧沙箱代码**。
- **Phase 1（下一轮，最小面）**：
  1. `packages/bundle/base/cordis.patch.yml`：卸 `sandbox`/`sandbox-policy`/`bash-sandbox`/`pwsh-sandbox`/`fs-sandbox`/`permission`，挂 `tool-policy` + `fs-local` + `bash-local`/`pwsh-local`；`approval` 改独立 `DSH_APPROVAL_POLICY`。
  2. UI：`ui-permission-presets` 改 profile（或新 `ui-tool-policy`）+ 文案/图标。
  3. `tool-fs-search` 接搜索根/排除。
  4. 更新 headless/web 的 `permission` 引用与快照；`--permission-mode` → `--policy`。
  5. 文档/升级指南/catalog 重新生成。
- **Phase 2**：删除 `sandbox_permissions`/escalation 死代码、旧 UI、旧 preset 包；视情况删除只读的旧沙箱包。

## 10. 候选实现对比

| | A 只做工具门 | B 工具门 + 文件中间件（采用） | C 全局 `ctx.fs` 黑名单 | D 全中介 |
| --- | --- | --- | --- | --- |
| 复杂度 | 中 | 中高 | 高 | 很高 |
| 路径覆盖 | 单路径工具；apply_patch 弱 | 文件工具全覆盖 | 覆盖过宽，误伤内部 | 全服务 |
| 误伤 | 中 | 低 | 高（153 个消费方） | 高 |
| 漏防 | 高 | 中（shell/PTC/MCP 已披露） | 低（fs） | 低（fs），shell 仍不可解析 |
| 可测性 | 中 | 高 | 中 | 低 |
| 结论 | 不够 | **采用** | 否决 | 否决 |

## 11. 测试计划

- **canonicalize**：win32 盘符大小写、UNC、`\\?\`、8.3、ADS、末尾点/空格、drive-relative；symlink 拼写；不存在目标；`..`；相对路径按 cwd；darwin `/tmp`；linux 大小写。
- **匹配**：根/子/兄弟边界（`.ssh2` 不命中 `.ssh`）；operations 区分；大小写。
- **profile**：默认/会话优先级；未知 profile 回退；旧 preset 名不崩。
- **guard/restrict**：`toolDenialReason`；可见性 deny 过滤（`run_code` 不走 restrict）；profile 切换 re-apply。
- **prompt**：`guarded`/`unrestricted` 精确文本；无 “Current DSH file policy”；soft/not-a-boundary 披露。
- **tool-fs 接入**：read/read_image/write/edit/apply_patch 命中 deny → `FS_POLICY_DENIED`；未挂载 → 行为不变。
