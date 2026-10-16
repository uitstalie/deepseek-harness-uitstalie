# task37 — item 11：路径证据按解析后真实路径判定 + 恢复必要方言短语

**变更自**：[task13](task13.md)（其"待办"第 1、2 条；第 3 条经核实已由 [task26](task26.md) 补过）。
**类型**：已有 mission 的变更（新任务单，新 id）。
**原生文件改动**：**2 个**，均带标记并在下方逐处登记。

## requirement

用户（2026/10/12）指定按序做三件收尾，其中第 11 项＝"[task13](task13.md) 后续任务单：让路径证据只作用于 `workspace-write`，对依赖短语覆盖的后端方言语保留必要短语，并把 symlink 逃逸改为按解析后的真实路径判定"。

## 三条要求的现状核实

| # | 要求 | 现状 | 结论 |
|---|---|---|---|
| 1 | 路径证据只作用于 `workspace-write` | [task12](task12.md) 的实现已如此：[`classifyDenial()`](../../packages/sandbox/sandbox/src/diagnostics.ts) 只在 `writableRoots.length > 0`（即 `workspace-write`）时要求路径证据；`read-only`（授权根为空）维持"短语 + 非零退出" | **已满足** ✓ 本次不改 |
| 2 | 对**依赖短语覆盖**的后端方言保留必要短语 | task12 从 `sandbox-local` 的 `'windows-acl'` 签名表删掉了 `permission denied` / `operation not permitted`；task13 实测该删减让 `ptc-runtime-node` 的**只读**用例（沙盒内 Node 自身抛 `EPERM`/`EACCES`，措辞正是这两条）失配 | **要修**（本次） |
| 3 | symlink 逃逸改按解析后真实路径判定 | 现有 [`namesPathOutsideRoots()`](../../packages/sandbox/sandbox/src/diagnostics.ts) 对拒绝信息里的路径与授权根做**纯字面**比较；task13 实测假阴性：junction 指向区外、但拒绝信息的字面路径在区内 ⇒ 判成非沙盒拒绝，模型拿不到升权提示 | **要修**（本次） |
| — | task13 待办 3：`bash-sandbox/src/helpers.ts` 缺标记 | 已有 [task26](task26.md) 的"追溯补标记"包住该处（`helpers.ts:4`、`:8`） | **已满足** ✓ 本次不改 |

## 改动（原生最小插入，带标记）

### A. `packages/sandbox/sandbox/src/diagnostics.ts`（task12 标记块内，新增 task37 标记）

- 新增分支自有 `resolvedPath(path)`：先 `realpathSync.native(path)`；失败（拒绝信息可能指向不存在目标）则退化为逐级向上找最近的**存在**祖先并解析它、再拼回剩余段；仍失败则原样返回 ⇒ 不改变无法解析时的既有行为。
- `isUnderAnyRoot()` 改为对**双方都解析后**再比较（授权根本身也可能是链接/junction）。
- `comparisonPath()` 去掉 Windows 扩展长度前缀（`\\?\` / `\\?\UNC\`），否则 `realpathSync.native` 的返回拼写会让朴素前缀比较失配。
- 效果：区内 junction 指向区外时，拒绝信息里的字面区内路径解析到区外 ⇒ 正确判为沙盒拒绝（假阴性消除）；普通区内路径行为不变。

### B. `packages/sandbox/sandbox-local/src/index.ts`（`DENIAL_SIGNATURES['windows-acl']`）

- 恢复 `'permission denied'`、`'operation not permitted'` 两条短语（带 task37 标记与理由）：它们是**沙盒内 Node 自身报错**的措辞（`EPERM: operation not permitted`、`EACCES: permission denied`），只读路径下没有路径证据可用，删掉即漏判。
- 与当初的审批噪音不冲突：`workspace-write` 侧仍由路径证据（A 之外的那条规则）兜底 —— 工作区内的 `permission denied` 依旧判为非沙盒拒绝。
- 代价（有意接受）：`read-only` 下普通命令若打印这两条短语会重新被判为沙盒拒绝并给升权提示；这是只读路径的既有设计（无路径可矛盾时短语即判据），且只读是显式选择。

## 原生文件改动登记

| 文件 | 位置 | 改动 |
|---|---|---|
| `packages/sandbox/sandbox/src/diagnostics.ts` | 头部 import 块 | 新增 `realpathSync` 与该任务标记的 `node:path` 三项 import |
| 同上 | task12 标记块内（`comparisonPath` / `isUnderAnyRoot` 一带） | 新增 `stripExtendedPrefix()`、`resolvedPath()`；`comparisonPath` 去扩展前缀；`isUnderAnyRoot` 双方解析后再比较 |
| `packages/sandbox/sandbox-local/src/index.ts` | `DENIAL_SIGNATURES['windows-acl']` | 恢复 `'permission denied'`、`'operation not permitted'`（带 task37 标记与理由） |
| `packages/sandbox/sandbox-windows-acl/tests/provider-chain.spec.ts` | 第 46 行一带 | 断言随签名表更新（+ task37 标记说明） |
| `packages/sandbox/sandbox-local/tests/local.spec.ts` | 第 409 行一带 | 同上 |

（两处断言改的是**行为已变的期望值**，按仓库规则"行为变了就同时改它的测试并说明理由"；两处原本就在 task26 的追溯标记内。）

## 验证

| 检查 | 结果 |
|---|---|
| `packages/ptc-runtime/ptc-runtime-node`（task13 记录的两条失败用例） | ✓ **12 文件 / 185 通过、1 跳过**；`applies read-only confinement to direct Node filesystem writes` ✓（修复 B 见效）、`permits workspace writes and denies a symlink to a sibling outside it` ✓（修复 A 见效） |
| `packages/sandbox/sandbox/tests`（含 `diagnostics.spec.ts` 分类器用例） | ✓ 4 文件 / 44 通过 |
| `packages/sandbox/sandbox-windows-acl`（本机可跑的 Windows 车道） | ✓ 16 文件 / 199 通过（含随本次更新的 `provider-chain.spec.ts`） |
| `packages/shell/bash-sandbox` 的 `classifyDenial` 用例 | **本机不可用**：该包在 [`vitest.config.ts`](../../vitest.config.ts) 的 `windowsUnsupportedPackages` 里（Windows 上排除其 `tests/**`）⇒ 信号归 Linux 车道 |
| `tsc -b tsconfig.host.json` | ✓ |
| `oxlint`（4 个改动文件） | ✓ 0 / 0 |
| 快照通道 | 按分支规则本机不跑（Windows 必红且会污染 fixture）；`read-only` 判定分支未变，预期输出不变，信号归 CI |

## 备注

- 第 1 条要求（路径证据只作用于 `workspace-write`）在 task12 实现里已满足，本次未改。
- task13 待办 3（`bash-sandbox/src/helpers.ts` 缺标记）已由 [task26](task26.md) 追溯补上，本次未改。
- task13 待办 2（`sandbox-windows-acl/tests/control.spec.ts` 的 console 期望、`tool-pwsh-persistent` 的 cwd/env 用例）未在本任务范围内，仍需干净环境复现后再定性。
