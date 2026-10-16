# task36 — item 10：沙箱相关包 README 契约同步（核实为已完成）

**变更自**：[task12](task12.md)（其"待办"列的 README 同步项）。
**类型**：已有 mission 的变更（新任务单，新 id）。
**原生文件改动**：**无**（本次只核实与登记；被核实的内容由 task12 当时完成）。

## requirement

用户（2026/10/12）指定按序做三件收尾，其中第 10 项＝"[task12](task12.md) 待办：5 个沙箱相关包的 README 契约与双语对同步"。

## 核实结论：该项**当时已完成**，本次无改动

task12 的文档里已有一段"文档同步（已完成）"，明说已同步 `dsh-sandbox`、`dsh-bash-sandbox`、`dsh-pwsh-sandbox`、`dsh-sandbox-local` 的 README + `README.zh.md`、子系统页 `docs/subsystems/sandbox.md` + `.zh.md`，并重录配对记录；`dsh-ptc-runtime-node` 的 README 不描述分类细节，无需改动。

本次逐处复核（ripgrep 计数）：

| 文件 | 命中 `路径证据 / path evidence / writableRoots / 授权根` |
|---|---|
| `packages/sandbox/sandbox/README.md` / `.zh.md` | 3 / 3 ✓ |
| `packages/sandbox/sandbox-local/README.md` / `.zh.md` | 1 / 1 ✓ |
| `packages/shell/bash-sandbox/README.md` / `.zh.md` | 1 / 1 ✓ |
| `packages/shell/pwsh-sandbox/README.md` / `.zh.md` | 1 / 1 ✓ |
| `docs/subsystems/sandbox.md` / `.zh.md` | 1 / 1 ✓ |
| `packages/ptc-runtime/ptc-runtime-node/README.md` / `.zh.md` | **0 / 0** ✓（与 task12 结论一致：该 README 不描述分类细节，无需同步） |

配对记录另由文档门禁把关：`pnpm run test:docs` 曾在本次会话实测 **21 项通过 / 0 失败**（含 `translation pairing`、`package README limitations`、`repository references`）✓。

## 本次唯一动作

把 [task12](task12.md) 的"待办"一行标注为已办（避免后续再被当成待办取用），并在其文档同步段补一句"本项由 [task36](task36.md) 复核确认无需改动"。

## 验证

只读复核：上述 ripgrep 计数 + 既有 `test:docs` 结果（21/0）。本次不含代码或文档内容改动（除 task12 本任务单内两行状态标注）。
