# task25 — rebase 到 upstream master 的 0.2.1-alpha.2 之后

## requirement

用户要求（2026/10/12）：同步上游修改并 rebase。分支约定（[AGENTS.md](../AGENTS.md)）：rebase 后必须 `git grep -n "uitstalie-"` 盘点全部标记、逐处确认适配结果；原生改动与分支改动分开提交。本任务单登记本次 rebase 的事实、冲突处理、上游改动引起的适配，以及本次新增的原生改动。

## 本次 rebase 的事实

| 项 | 值 |
|---|---|
| 目标基座 | `upstream/master`（dsh 0.2.1-alpha.2 的 release 合并点之后；按规则不把 SHA 写进文档） |
| 重放提交 | **96 个**（我们一方） |
| 跨过的上游提交 | **669 个**（其中非 merge 512 个） |
| rebase 前 HEAD | 已在本机打保底分支（`backup/cli-desktop-*`），回滚可用 |
| rebase 后 HEAD | task24 报告那条提交（内容不变、父链更新） |
| 冲突停点 | **2 次**：16/96 根 `package.json`、75/96 `pnpm-lock.yaml` |
| 上游破坏性提交 | 仅 1 个：`refactor(experimental)!: classify optional packages and move prototypes`（把 hooks/skill/session/client 的一批可选包移进 `packages/experimental/`） |
| 上游是否碰过分支自有路径 | **否**：`git diff <旧基座>..upstream/master -- packages/uitstalie/` 为空 |

**冲突处理**：

| 停点 | 文件 | 处理 |
|---|---|---|
| 16/96 | 根 `package.json` | 取**分支侧** `packageManager: pnpm@12.4.1`（分支的 lockfile 由 pnpm 12 生成，本机 pnpm 也是 12.4.1；上游为 11.28.5 且 updater 未改写该字段）。后续提交把完整性摘要哈希复原，收尾检查确认仍在 |
| 75/96 | `pnpm-lock.yaml` | 取**当前侧**（即已重放部分的状态），lockfile 不手改，收尾 `pnpm install` 重生成 |

为避免 lockfile 在 41 处冲突上反复停车，本次启用**本机专属**合并驱动（不提交、不影响他人）：`.git/info/attributes` 增 `pnpm-lock.yaml merge=ourslock`，`merge.ourslock.driver=true`。仓库原有的 `rerere.enabled=true` 保持不变。

## rebase 收尾：`pnpm run clean` 是必需的

rebase 后首次 `pnpm run build` 失败：

```
[MISSING_EXPORT] "registerSessionTitleLlmProvider" is not exported by "../session-title-llm/src/index.ts"
```

原因是上游把 `packages/session/session-title-all-prompts-llm` 移进 `packages/experimental/`，而旧目录里**只剩被 git 忽略的 `lib/`**（重生成的构建产物），tsdown 按目录发现包时把这份陈旧产物当成一个包来打包。`pnpm run clean` 移除 **368 个路径**（含该孤儿目录）后 `pnpm run build` 通过。结论：**跨大版本 rebase 后先 clean 再 build**。

## 原生改动登记（本次新增一处）

上游本区间新增门禁 `verify-product-use`：非 experimental 的包必须能从出厂组合（默认或官方按需 bundle）到达，或在 `scripts/product-package-policy.ts` 显式登记角色，否则报错。分支 [task9](task9.md) 把 base 组合的 `llm-pi-ai` 行禁用、换成休眠的 `llm-plus` 行，因此该门禁报：

```
packages/llm/llm-pi-ai (@deepseek-ai/dsh-llm-pi-ai): no product runtime use; mount it, declare its maintained role, or move it to experimental
```

三选一（挂载 / 登记角色 / 移进 experimental）中取**登记角色**（挂载会推翻 task9 的替换，移包会动上游目录布局）：

| 文件 | 位置 | 改动 | 原因 |
|---|---|---|---|
| `scripts/product-package-policy.ts` | 表尾（`packages/util/package-manifest` 条目之后，稳定锚点追加） | 增 `packages/llm/llm-pi-ai`: `category: 'optional'` + 理由句 | 分支 base 组合改挂 `llm-plus`，该 provider 仍可由用户组合选用；`optional` 正是"可被按需选择、但不是默认能力"的既有分类 |

标记形式为 BEGIN/END 块（`uitstalie-k3, 2026/10/12, task25`）。该文件的规格自建策略对象、不比对仓库策略表，因此无快照连带影响；门禁复跑通过（274 default / 30 optional）。

## 上游改动导致的适配（分支自有文件）

**1. `dsh-agent-instructions` 换掉了工作目录来源**（上游"centralize working directories and directory context"）：`inject` 由 `['sessionProjections']` 变为 `['sessionProjections', 'workingDirectory']`，`cwd` 由 `agent.session.header.cwd`（**创建时**的目录）改为 `await ctx.workingDirectory.ensure(agent, signal)`（**当前**目录）；`loadBaselineInstructionSet` 增加 `agentsHome`（共享 agents 根）。我们的 `agent-instructions-plus` 是"装饰原生链路"的插件，因此必须同步，否则两个链路会扫描不同目录：

| 文件 | 改动 |
|---|---|
| `packages/uitstalie/agent-instructions-plus/src/index.ts` | `inject` 增 `workingDirectory`（带说明注释）；`rulesSegment`/`replacementBaseline` 改收 `Agent`，cwd 取 `ctx.workingDirectory.ensure(agent, signal)`；`loadBaselineInstructionSet` 补传 `resolved.agentsHome`；补 `import type {} from '@deepseek-ai/dsh-working-directory'` |
| `packages/uitstalie/agent-instructions-plus/package.json` | `@deepseek-ai/dsh-working-directory` → peerDependencies + devDependencies（与原生同款声明） |
| `packages/uitstalie/agent-instructions-plus/tests/plus.spec.ts` | 夹具补 `provideWorkingDirectoryFixture(ctx, project)`——原生 loader 现在要求该服务，缺它则整条原生链不激活，两个对拍测试因此失败 |
| `packages/uitstalie/agent-instructions-plus/tests/loader-composition.spec.ts` + `tests/fixtures/loader-composition/cordis.yml` | 组合夹具增 `@deepseek-ai/dsh-working-directory` 行，模块表同步登记 |

（`tool-dsh-store` 仍读 `session.header.cwd`：它要的是"会话创建目录"这一持久语义，不是当前目录，故不动。）

**2. 文档门禁的既有失败顺带修掉**：`goal/mission/task24.md` 里写了裸提交短哈希，`verify-repository-references` 报 `commit-hash`。这与本次 rebase 无关（分支自有的 goal 文档内容 rebase 前后逐字一致），但推送前的 `test:docs` 会连带红，故按 task23 的同一办法改成散文指代。

## 标记盘点（分支约定的 rebase 收尾动作）

| 检查 | 结果 |
|---|---|
| `git grep -l "uitstalie-"` 文件数 | rebase 前后均 **53 个**（`git grep -c` 逐文件计数也逐条相同） |
| 标记行文本 | 两侧**逐行相同**（128 行，排序后比对无差异） |
| 原生文件"新增行"集合 | 31 个原生文件、**616 行新增**，rebase 前后逐行相同——**原生改动面一字未变**（含上游同期改动过这些文件的情形） |
| 分支自有路径 | `packages/uitstalie/`、`goal/` 与 rebase 前逐字一致 |
| 冲突标记泄漏 | 无 |

## 验证（rebase 后）

| 检查 | 结果 |
|---|---|
| `pnpm run clean` + `pnpm run build` | ✓ **363** client artifact（此前 361；+2 来自上游新包） |
| `tsc -b tsconfig.client.json tsconfig.host.json` | ✓ 两面干净（首次客户端面报 4 处错，全在上游新包 `client-ui-cot-translation`：build 前缺已生成的 Remote 类型，build 后复跑通过） |
| 聚焦测试 `packages/uitstalie` | ✓ **18 文件 / 128 测试**（适配前是 2 处失败） |
| `verify-product-use` | ✓ 274 default / 30 optional / 2066 source modules |
| `verify-default-product-isolation` | ✓ 288 包、298 条 web 组合行全部排除 experimental |
| `verify-package-dependencies` | ✓ 77 包 |
| `verify-client-packages` | ✓ 63 client 包 |
| `verify-package-readme-model-experience` | ✓ 338 README |
| `verify-translation-pairing` | ✓ 935 对 |
| `run-oxlint`（改动文件） | ✓ 0 warning / 0 error |
| `test:docs` | ✓ 21 条门禁全绿（修掉 task24 的哈希后） |
| `verify-cordis-config` | **仅剩环境性失败**：`apps/cli/tests/profiles/acp/cordis.yml` 在上游是 **git 符号链接**（mode 120000），Windows 检出成普通文本文件 → "root must be a Loader entry array"。该文件 `git status` 为空、与本分支无关（与 task23 记录的是同一处） |

## 待办

1. ~~**推送决策**~~ **已完成（2026/10/12，用户批准）**：`--force-with-lease` 推送 `cli-desktop`，远端报告 forced update ✓；推送前的 typecheck 钩子通过（44.5s），推送后本地与 `origin/cli-desktop` 一致。保底：rebase 前的 tip 与远端被覆盖前的 tip 是同一个提交，已在本地打保底分支 `backup/cli-desktop-*`；如需回滚，用该分支强制回推即可。
2. **门禁级收尾已完成（2026/10/12，用户指定顺序：task21 先行、task22 随后）**：交付记录见 [task21 第三步](task21.md) 与 [task22](task22.md)；`pnpm run test:gui` 现只剩**两处环境性失败**（`connection/binary-rpc` 5s 超时、`ui-deliverables/present-open` 的 Windows 无符号链接权限），task23 记录的 `ui-trajectory/client-bundle` 在本次 rebase + clean + build 后**已转绿**。
3. **仍需用户定夺**：38 个无标记原生文件的合规清扫（本任务单未做，按分支规则属独立任务）。
4. [task24](task24.md) 的 PENDING 清单（common-view overlay 逐 view 复刻、设置通道开关等）继续有效。
