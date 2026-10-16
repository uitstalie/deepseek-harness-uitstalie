# task39 — task11 与 task25 的收口核实（两项均已了结）

**变更自**：[task11](task11.md)（其"待办"与"修 (a)"）与 [task25](task25.md)（其待办 2/3 的残留）。
**类型**：已有 mission 的变更（新任务单，新 id）。
**原生文件改动**：**无**（本次只核实与登记；被核实的内容由 task12/task26/task34 等当时完成）。

## A. task11：三项全部了结（两项早在 task12 被判不成立/不该做）

| task11 的条目 | 现状 | 证据 |
|---|---|---|
| 修 (a)：`sandbox-windows-acl` 的 token/ACL 实现（管道 EPERM 等） | **已修**（上游后续工作） | 受限 token 的默认 DACL 现在会补一条 restricting SID 的完全访问 ACE：[`token.ts:112 setTokenDefaultDaclGrant`](../../packages/sandbox/sandbox-windows-acl/src/token.ts#L112)，由 [`src/index.ts:304`](../../packages/sandbox/sandbox-windows-acl/src/index.ts#L304) 在建立受限 token 后调用；该包的 Windows 车道 **16 文件 / 199 测试** 全绿（task37 实跑） |
| `Win32 5`（`SetNamedSecurityInfoW failed`） | **环境根因，已在 task11 内实测定性**（工作区 DACL 缺 `WRITE_OWNER`，用 `icacls … /grant '<账号>:(OI)(CI)F'` 修复）；[task34](task34.md) 又把该失败在运行期翻成可执行提示（缺"改所有者"权利 + 指向 `diagnose-windows-sandbox-acl`） | task11 第 48–67 行；task34 |
| 待办：`approval-policy-guard` 插件未实现 | **已作废（不该做）**：[task12](task12.md) 判定"拦到后回 `allowed-once` 等于自动批准把该次调用提到 `danger-full-access`，是安全回退" | `packages/uitstalie/` 下**确无**该包 ✓（本次实测：只有 7 个包） |
| 待办：`escalationHintMarker` 在工作区内也追加的两处收敛 | **已作废（不成立）**：工作区内写不会走到 `mapError`，原计划的收敛点无处可改 | 本次实测：`packages/fs/tool-fs/src/sandbox.ts`、`packages/fs/tool-str-replace-editor/src/index.ts` 内**无**我们的任何标记/改动 ✓ |

**用户目标（workspace-write 下工作区内写不再触发审批）**：三条噪音源都已处理——环境前置（icacls，且现在有运行期提示）、拒绝误判（task12 的路径证据 + task37 的真实路径与方言修正）、升权诱导（同样由误判修正消掉）✓。

## B. task25：待办全部了结；残留的两处"环境性失败"已逐条定性

| 条目 | 现状 | 证据 |
|---|---|---|
| 待办 1 推送决策 | ✓ 已完成（当时 force-with-lease + 保底分支） | task25 记录本身 |
| 待办 2 门禁级收尾 | ✓ 已完成（`ui-trajectory/client-bundle` 已转绿） | task25 记录本身 |
| 待办 3 38 个无标记原生文件 | ✓ 由 [task26](task26.md) 完成；[task38](task38.md) 复核纪律（85 个标记文件、此后新增原生改动无一漏标） | task26 / task38 |
| 残留：`test:gui` 的 `ui-deliverables/present-open` | **环境性**（当前实跑复现）：`EPERM: operation not permitted, symlink …`——该用例故意造 final symlink 来验证"拒绝符号链接"，而本机 `core.symlinks=false`（且无开发者模式/管理员特权）⇒ 无法创建符号链接 | 本次实跑：该规格 30 测试 1 失败，失败点即 `symlink()` 调用；信号归 Linux/macOS 车道 |
| 残留：`test:gui` 的 `connection/binary-rpc` 5s 超时 | **负载性抖动**：单独跑/低负载即绿 | 本次实跑：`binary-rpc.host.spec.ts` **通过**（与 present-open 连跑时也是它绿、present-open 红） |
| 残留：`verify-cordis-config` 的 acp 档案 | **环境性**：`apps/cli/tests/profiles/acp/cordis.yml` 在索引里是 **mode 120000 符号链接**，而本机 `core.symlinks=false` ⇒ 检出为普通文本 ⇒ "root must be a Loader entry array" | `git ls-files -s` 显示 `120000`；`git config core.symlinks` = `false`；与 task23/task25 记录同源 |

**处置**：以上三条都不改代码（前两条属上游测试与本机特权，第三条属检出方式）。本机验证时的正确预期是：这两条规格的红**与分支改动无关**；要它们绿的场合是 Linux/macOS CI，或在本机开启符号链接特权后重新检出。

## 验证

本次为只读取证：`git grep`（标记与包清单）、`git ls-files -s` + `git config`（符号链接环境）、`vitest` 精跑两条规格（present-open ✗ 环境、binary-rpc ✓）、以及 task37 已记录的 `sandbox-windows-acl` 199 测试全绿。除本任务单与两份旧任务单的状态行外，**无任何代码或文档内容改动**。

## 后续去向

本任务单与 [task11](task11.md)、[task25](task25.md) 的残留项已全部了结；其余**有意接受**或**本机无法了结**的事项统一登记在分支限制台账 [goal/limitations.md](../limitations.md)（2026/10/12 建立，用户指定"先记录到文档里，不进 jira"）。
