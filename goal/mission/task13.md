# task13 — 2026/09/30 rebase 到上游 0.2.0-rc.2

## requirement

把 `cli-desktop` rebase 到上游 `deepseek-ai/deepseek-harness` master 的最新提交（本次 fetch 的新头是 `release(dsh): 0.2.0-rc.2`），并保证 `pnpm run build` 成功。

变更自 [task10](task10.md)：task10 记录了上一次 rebase 之后的文档与登记修正；本次是同一分支上的下一次上游同步。

## rebase 结果

- 上游本次新增提交：基点之后 293 个（含 release 0.2.0-rc.1 → rc.2、Windows ACL 单轮修复、pwsh 完成行与提示尾改动）。
- 分支 25 个提交全部重放成功，rebase 后落后上游 0 个提交。
- 冲突只有一处：`pnpm-lock.yaml`，落在「adapt to the rebased master APIs」这个提交上。按 task5/task6/task8 登记的规程接受上游版本，rebase 结束后重跑 `pnpm install` 重新生成；`package.json` 的 `packageManager` 完整性哈希由 pnpm 12 自动写回，一并提交。
- 分支改动面未变：`uitstalie-` 标记共 46 行、22 个文件，rebase 前后逐文件计数完全一致；task12 新增的 `packages/sandbox/sandbox/src/diagnostics.ts` 分类实现与 `sandbox-local` 的签名表在 rebase 前后逐字相同（前者上游本次零改动）。

## 修改范围

- 新增分支自有文件：本任务单 `goal/mission/task13.md`。
- 原生文件（JSON/YAML 无法内嵌标记，登记于此，均由 `pnpm install` 生成或写回，无手写内容）：
  - `pnpm-lock.yaml`：恢复本分支 pnpm@12.4.1 的 `packageManagerDependencies` 与 `@pnpm/exe.*` 条目（冲突时取上游版本会丢掉这些行）。
  - `package.json`：`packageManager` 补回 `pnpm@12.4.1` 的 sha512 完整性哈希。

## 环境问题与处置

本工作区的 pnpm 自管副本（store 的 links 目录下的 pnpm@12.4.1）缺少原生二进制：`node_modules/pnpm/` 下只有 shebang-less 占位文件加 `.pnpm-needs-build` 标记，其 `bin/pnpm.CMD` 指向该无扩展名占位文件。后果是 `node_modules/.bin/pnpm` 与包脚本里的裸 `pnpm` 都报「不是内部或外部命令」，`pnpm run build:lib` 这类脚本必然失败；`node_modules/.bin/pnpm` 是 pnpm 前置到脚本 PATH 的第一项，因此即使外层用全局 pnpm 也绕不开。

按 pnpm 自身 preinstall 的做法修复：把 `@pnpm/exe.win32-x64/pnpm.exe` 落到 `node_modules/pnpm/`（含 `pnpm.exe`，并把占位文件替换为同一 PE），并把该 links 目录的 `bin/pnpm.CMD` 指向 `pnpm.exe`。修复后裸 `pnpm` 在仓库内解析为 12.4.1，`pnpm run build` 在干净 PATH 下通过。

修复只在本机 store，不在仓库内；若 pnpm 重写该 store 目录需重做。回滚素材：`D:\dqc\pnpm-placeholder-backup.bin`、`D:\dqc\pnpm-link-bin-CMD-backup.txt`。

## 验证

- `pnpm run build`（干净 PATH，`pnpm` 解析到 `PNPM_HOME` 的 12.4.1）通过：`build:native-system` → host 面 `tsc -b tsconfig.host.json` + tsdown + desktop bundle → client 面 `tsc -b tsconfig.client.json` + tsdown → web `vite build`，末行 `build: recorded 349 client artifact(s)`，404 KB 日志内无 error 行。
- 聚焦测试 `packages/sandbox packages/shell packages/ptc-runtime packages/uitstalie`：754 通过、6 失败、6 跳过；单独重跑三个失败文件为 5 失败（另一条只在并行负载下失败）。
- 上述失败与本次 rebase 无关，取证如下：
  1. `ptc-runtime-node`「applies read-only confinement to direct Node filesystem writes」：task12 从 `windows-acl` 签名表删掉 `permission denied`、`operation not permitted` 后，沙盒内 Node 自身抛出的 EPERM/EACCES 措辞不再命中；把两条短语临时加回，该用例立即通过。read-only 分支只做短语匹配、与授权根无关，且签名表与分类实现在本分支上 rebase 前后逐字未变，属 task12 遗留。
  2. `ptc-runtime-node`「permits workspace writes and denies a symlink to a sibling outside it」：junction 指向区外，但拒绝信息里的路径字面在工作区内，task12 的路径证据规则据此判为非沙盒拒绝——该规则的已知假阴性。
  3. `sandbox-windows-acl/tests/control.spec.ts` 两条「runs without a visible console …」期望 `visible: false` 实得 `true`；该测试与其 runner 都不是分支改动，属上游最新代码在本机的表现。
  4. `tool-pwsh-persistent`「preserves cwd and environment across calls」：`stdinReads` 不足且出现 `inferred_idle`；该包非分支改动，上游本次引入了 pwsh 完成行与提示尾相关改动。
- 用 git worktree 在上游干净树复现失败不可行：junction 的 `node_modules` 会让 `@deepseek-ai/dsh-*` workspace 包解析到 dev 树的源码路径，三个文件全部以解析错误结束。

## 待办

- 第 1、2 条需要 task12 的后续任务单：让路径证据只作用于 `workspace-write`，对依赖短语覆盖的后端方言语保留必要短语，并把 symlink 逃逸改为按解析后的真实路径判定。
- 第 3、4 条需要在干净环境复现后再定性（本机 worktree 方案失败，需单独安装依赖的干净树）。
- `packages/shell/bash-sandbox/src/helpers.ts` 的原生改动仍缺标记注释（task12 的登记表列了该文件，但文件内没有标记；`pwsh-sandbox/src/helpers.ts` 有）。
