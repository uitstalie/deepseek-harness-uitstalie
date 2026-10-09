# task15 — 工作区 rules：常驻注入 + 交付前自检

## 状态：已废弃（2026/09/30 用户判定）

**废弃理由**：rules 的**注入层已经交付**，但**不是按本任务单的写法**——由 [task16](task16.md) 的 `dsh-agent-instructions-plus` 落地，且采用后来拍板的简化规格（`rules/**` 全量常驻、纯 Markdown 逐字注入、**不用 front-matter / globs / 激活元数据**；复用原生 loader 全部语义并禁用原生行以便退回）。用户据此判定：**本任务单废弃**，其中"交付前自检（机检层）"**暂不推进**，也不另立任务单。

因此本文件只作为**历史记录**保留，不再作为待办；其中"规则文件规格（front-matter 的 `alwaysApply`/`globs`/`check`）"与"验证"两节描述的形态**已被否决**，读时应以 [rules.md](../rules.md) 的现状与 [task16](task16.md) 的实现为准。`agent/turn-stopping` + `Agent.steer` 的 hook 结论仍然是准确的实测记录，将来若重启机检层可直接引用本文。

## requirement（原始，已不适用）

为工作区提供 rules：执行本工作区的项目时**必须遵守的规则与必须执行的动作**，并在**每个 turn 交还给用户之前做一次自检**，未通过则强制再走一步。规则以目录形式维护在 `.dsh/rules/**`（多文件、可 glob 作用域），由 task14 的 `dsh` 工具负责写入与校验。

设计（hook 点、两种自检模式、规则文件规格、复用面、待定项）见 [rules.md](../rules.md)。

## 关键结论（已实测）

- 交付前自检的 hook 点是 **`agent/turn-stopping`**：serial、被 await、无 `next()`；全部监听器返回后 loop 重新检查 `inbox.nextStep`，非空则继续跑下一步（[agent-loop/src/agent.ts:359](../packages/core/agent-loop/src/agent.ts:359)）。
- 强制续跑用 **`Agent.steer(message)`**（[agent.ts:167](../packages/core/agent-loop/src/agent.ts:167)）；这正是 `hooks-claude-code` 的 blocking `Stop` hook 与 `hooks-codex` 的做法，也是 `workspace-changes` 做交付快照的边界。
- 它**不是否决权**，也**没有内建自续跑上限**（仓库自己在 [hooks-claude-code/src/index.ts:275](../packages/hooks/hooks-claude-code/src/index.ts:275) 留了 `TODO(stop-loop-guard)`）→ 插件必须自限连续强制续跑次数。
- 用户中止的 turn 不会走到该边界，自检不会污染取消路径。

## 修改范围

- 新增分支自有文件：
  - 新包 `packages/uitstalie/rules/`（`package.json`、`tsconfig.json`、`src/*`、`tests/*`、双语 README + i18n 记录）。
  - 本任务单与设计文档 [rules.md](../rules.md)。
- 原生文件（新增行，逐处 `uitstalie-` 标记登记）：`tsconfig.host.json` 注册新包；`tsconfig.base.json` 别名（生成区，rebase 后重跑 `pnpm run gen-tsconfig-paths`）。
- 挂载：用户层 profile 补丁（与 `dsh` 工具同层），不进原生 bundle。
- 依赖 task14：规则文件由 `dsh` 工具创建/校验；若 task14 尚未落地，本任务单可先用测试夹具直接写 `.dsh/rules/` 验证加载与自检。

## 验证

- 单测：front-matter 解析（`alwaysApply`/`globs`/`check`）、glob 作用域命中与不命中、预算与去重、变更/移除通知。
- 自检：`command` 模式失败 → `steer` 且注入失败输出；连续失败达到上限后不再 steer 且交付可见标注；`model` 模式注入清单；abort 路径不触发。
- 真实 Loader 组合测试：挂载插件，跑一个 turn，断言 turn-stopping 的自检行为与注入内容。
- `pnpm run typecheck`、`pnpm run build`、聚焦 `vitest run packages/uitstalie`。

## 待办与风险

- 需用户拍板的 6 项见设计文档「待定」（自检默认开关、常驻策略、续跑上限、是否约束工具动作、命令模式执行面、是否复用 hooks.json 协议）。
- 风险：自检若配得过重（每轮跑测试）会显著拉长交付时间；建议默认只在规则声明 `check` 时执行，并在文档里给出耗时预期。
- 风险：`command` 模式执行规则里的命令等于把宿主命令面交给规则文件——需明确命令只在经 `ctx.shell`（受沙盒与权限策略）下执行，并在 README 记录该信任边界。
