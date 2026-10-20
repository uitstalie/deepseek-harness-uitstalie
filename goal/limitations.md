# 已知限制登记（cli-desktop 分支）

本文件是分支的**限制台账**：凡是我们**有意接受**或**本机无法了结**的事项，都在这里逐条登记，免得后续会话反复当"待办"取用。每条给四处信息：**限制是什么**、**为什么是限制**、**什么条件能解除**、**证据/出处在哪**。

维护方式：新限制被接受时追加一行；某条被解除时删掉该行，并在对应任务单里记明解除方式。**不写提交哈希**（仓库引用检查禁止），指提交用主题描述。

| # | 限制 | 类型 | 为何是限制 | 解除条件 | 证据/出处 |
|---|---|---|---|---|---|
| 1 | `tool-dsh-store` 未做真实会话手工验收（模型触发建/查/删） | 未做的验收 | 需要在**运行中的 harness + 真实会话**里由模型触发；本轮 dev server 由用户主动停掉 | 起一个真实会话跑一遍即可 | [task14](mission/task14.md) 第 23 行 |
| 2 | `packages/extensions/tool-cordis/src/api-catalog.ts` 当前不可再生成 | 上游遗留缺口 | `pnpm run gen-cordis-api` 被 task8 的遗留缺口挡住：`models-dev/updated` 事件引用了未分类类型 | 补上该事件的类型分类后重跑生成器 | [task14](mission/task14.md) 第 183 行 |
| 3 | 两条上游用例在本机无法定性 | 环境/复现条件 | ① `sandbox-windows-acl/tests/control.spec.ts` 期望无可见控制台（期望 `visible: false` 实得 `true`）；② `tool-pwsh-persistent` 的 cwd/env 用例（`stdinReads` 不足、出现 `inferred_idle`）。本机 worktree 复现方案失败（junction 的 `node_modules` 会让 workspace 包解析到 dev 树源码，三个文件全部以解析错误结束） | 装好依赖的**独立干净树**里复现后再定性 | [task13](mission/task13.md) 待办 2 |
| 4 | Windows 检出缺符号链接特权（`core.symlinks=false`）造成的两处红 | 环境 | ① `apps/cli/tests/profiles/acp/cordis.yml` 在索引里是 mode 120000 符号链接，本机检出为普通文本 ⇒ `verify-cordis-config` 报 "root must be a Loader entry array"；② `ui-deliverables/tests/present-open.host.spec.ts` 故意造 final symlink 来验证"拒绝符号链接"，`symlink()` 直接 `EPERM` | 开 Windows 开发者模式/管理员后 `git config core.symlinks true` 并重检出（会重整工作区）；或交给 Linux/macOS CI | [task39](mission/task39.md) B 段（`git ls-files -s` = 120000、`git config core.symlinks` = false、实跑 EPERM） |
| 5 | `packages/client/connection/tests/binary-rpc.host.spec.ts` 偶发 5s 超时 | 负载性抖动 | 曾与并发门禁同跑时超时；单独/低负载跑**通过**，非缺陷 | 无需解除；若 CI 也见，另行按测试可靠性排查 | [task39](mission/task39.md) B 段 |
| 6 | `packages/shell/bash-sandbox` 与 `packages/sandbox/sandbox-local` 的 `tests/**` 在 Windows 上被排除 | 平台车道 | `vitest.config.ts` 的 `windowsUnsupportedPackages` 显式排除（这些套件依赖 POSIX 侧机制），源码也随之在本机覆盖车道豁免 | 由 Linux 车道覆盖 | [task37](mission/task37.md) 验证段 |
| 7 | 沙箱工作区授权失败时**不**自动跑诊断修复 | 有意的产品限制 | 自动修会**替用户改 ACL**（`icacls` 级写入）；当前只把失败翻成可执行提示（缺哪项权利 + 指向诊断 skill） | 若要做，必须是**显式开关**且默认关 | [task34](mission/task34.md) 备注、[task11](mission/task11.md) 收口 |
| 8 | rules 链不进非 web 组合 | 用户决定 | 平面规则：`agent-instructions-plus`/`tool-dsh-store` 属 **agent preset 平面**，而 CLI/headless 组合没有 preset 层；挂到 profile 级会被 `verify-cordis-config` 判为"一行活在两个平面" | 用户改主意时再评估（给非 web 组合引入 preset 层，或把 rules 迁到 profile 级） | [task33](mission/task33.md) 缺口 2（用户已定"不要"）、[task39](mission/task39.md) 无关 |
| 9 | 受限会话的 `read-only` 路径仍按**短语**判定拒绝 | 有意的判定取舍 | 只读策略下没有授权根可与短语矛盾，故"短语 + 非零退出"即判据 ⇒ 打印 `permission denied` 的普通命令仍可能被判为沙盒拒绝并给升权提示 | 只读策略下再引入其它证据（如后端专属的稳定措辞集合）时收窄 | [task12](mission/task12.md) 收紧规则、[task37](mission/task37.md) 修复 B 的代价说明 |
| 10 | 分支字形均为自绘，非设计师图形 | 设计资源 | R 按钮用共享图标集的 `checklist`；7 个插件各用自绘 `icon.svg`；共享图标集里没有 Material 的 `rule`/`policy` 专名 | 设计师给出字形后替换（R 换专名、插件图标换品牌 mark） | [task33](mission/task33.md) 备注、[task38](mission/task38.md) B 段 |
| 11 | `common-view` 的逐 view 复刻切片默认全关且已 park | 用户决定 | task24 的 PENDING 1–5 被用户"暂时放弃"；代码停在支线 `overlay-view-replica`（其 tip 就是那条 park 提交），产品行为不受影响 | 从该支线接回复刻（需要时） | [task24](mission/task24.md) 待办上方的状态块 |
| 12 | 本机不跑快照通道 | 环境 | 用户明确要求（Windows 上必红：headless 通道不回传 `cwdAliases`、`{{cwd}}` 归一化不上；无 key 的 refresh 会把真实路径写进 fixture） | 由 macOS/Linux CI 覆盖；确需更新侧车时手工同步 + `-t <场景名>` 过滤复跑 | [AGENTS.md](AGENTS.md) 的 Windows 快照规则 |
| 13 | 本机 `pnpm run hygiene` 有 7 项红灯 | 既有 / 环境 / 上游 | ①分支既有：runtime closure（preset 挂了分支插件而 `python/sdk-runtime` 未声明；`dsh-llm-plus` 的 peer 不在 closure）、5 处 `as unknown` 不在 baseline、7 个包的 `workspace:^` 不符 constraints；②环境：node-next types 与 cordis config 都要符号链接；③上游侧：publint 的 `./src/*` 发布视图告警、rescope 映射滞后 | 逐项立项修（改原生文件需用户定夺）；两项环境红灯归 Linux/macOS CI | [task40](mission/task40.md) 的 hygiene 段 |

**已解除（留痕）**：38 个"有分支改动但没有 `uitstalie-` 标记"的原生文件——由 [task26](mission/task26.md) 补标记/登记，[task38](mission/task38.md) 复核纪律后解除。
