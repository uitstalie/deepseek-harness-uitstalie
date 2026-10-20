# task40 — rebase 到 upstream master 的 0.2.1-rc.2 之后

## requirement

用户要求（2026/10/20）：同步上游提交并 rebase。流程接续 [task25](task25.md)：以 `upstream/master` 为基座、rebase 后 `git grep -n "uitstalie-"` 盘点全部标记、原生与分支改动分开提交。本任务单登记本次 rebase 的事实、冲突处理、上游改动引起的适配，以及验证证据。

## 本次 rebase 的事实

| 项 | 值 |
|---|---|
| 目标基座 | `upstream/master`（dsh 0.2.1-rc.2 的 release 合并点之后；按规则不把 SHA 写进文档） |
| 重放提交 | **141 个**（我们一方） |
| 跨过的上游提交 | **990 个**（其中非 merge 769 个） |
| rebase 前 HEAD | 本地保底分支 `backup/cli-desktop-20261020-1025`（回滚用） |
| 冲突停点 | **4 次 / 5 个文件** |
| 丢弃提交 | **1 个**：task25 的「regenerate the lockfile after the upstream sync」——补丁内容已在上游侧，lockfile 由收尾 `pnpm install` 重新生成 |
| 上游是否碰过分支自有路径 | **否**：本区间 `git log upstream/master -- packages/uitstalie` 为 0 条 |
| 生成物冲突策略 | 沿用 task25 的本机专属合并驱动：`.git/info/attributes` 的 `pnpm-lock.yaml merge=ourslock`、`merge.ourslock.driver=true`；`rerere.enabled=true` 保持 |

### 冲突处理

| 停点 | 文件 | 处理 |
|---|---|---|
| task12「require path evidence for a denial」 | `packages/ptc-runtime/ptc-runtime-node/src/index.ts` | 上游把 timer-range 校验整体移进 `config.ts`，并从 `index.ts` 去掉 `MAX_TIMER_DELAY_MS` 的导入与使用；因此导入行取**上游侧**（只剩 `clampTimeout`），把我们的 `classifyDenial` / `writableRoots` 加回 |
| task17「declare the models.dev service and settings page」 | `packages/bundle/web-app/package.json` | 上游在同位置新增 `@deepseek-ai/dsh-client-ui-deepseek-model-label-1017` 依赖；**两行都保留**（上游顺序在前），JSON 重新校验通过 |
| task22「fail the client bundle build on an unresolved import」 | `packages/client/tsdown.client.ts`、`scripts/client-bundle-purity.spec.ts` | 上游把 `clientConfig` 改成收 `manifest`（内部惰性算 externals）并新增 `nodeClientConfig`；`clientConfig` 头部采用**上游签名**，我们的 `clientExternalsGate` + `Resolver` 标记块整体保留在它前面；spec 的导入块取**并集**（上游的 `Rolldown`、我们的 `resolve` / `pathToFileURL`） |
| task28「teach the two silent PowerShell dialect traps」 | `docs/tool-catalog.i18n.yaml` | 双语配对记录是生成物：冲突不手解，`pnpm run verify-translation-pairing --write docs/tool-catalog.md` 按合并后的中英正文重录 |

## 上游改动导致的适配（均为分支自有文件）

| 文件 | 改动 | 依据 |
|---|---|---|
| `packages/uitstalie/{common-view,ui-models-dev,ui-tool-dsh-store}/tsdown.config.ts` | `clientBundle('<包名>', …)` → `clientBundle(import.meta.dirname, …)` | 上游把 `clientBundle` 的首参改为**包目录**；沿用包名时 host bundle 报 `cannot read <root>/@deepseek-ai/dsh-client-common-view/package.json` |
| `packages/uitstalie/llm-plus/package.json` | 新增 `@deepseek-ai/dsh-typert-protocol` 到 `peerDependencies` + `devDependencies` | 上游 typert 生成器让 `typert.host.js` / `typert.remote-client.js` 都 import `.../remote-info`；清单从未声明它，装配 roster 规格解析失败（`Failed to resolve import "@deepseek-ai/dsh-typert-protocol/remote-info"`）。声明方式对齐上游同类包（`settings-controller` 的 peer + dev） |
| `packages/uitstalie/{common-view,ui-models-dev,ui-tool-dsh-store}/package.json` | 删除各自 devDependencies 里的 `@types/react` | 上游新规则：React 类型包只由根清单声明（`verify-package-dependencies` 报 3 处违规） |

**本次没有新增原生改动**：原生文件只发生了上游内容与既有 `uitstalie-` 标记块的自动合并；生成物（lockfile、`docs/tool-catalog.i18n.yaml`）按各自生成器重录。

## 标记盘点（分支约定的 rebase 收尾动作）

| 检查 | 结果 |
|---|---|
| `git grep -l "uitstalie-"` 文件数 | rebase 前后均 **87 个** |
| 逐文件标记计数（`git grep -c`） | 两侧**完全相同** |
| 标记行文本（213 行，排序后比对） | **逐行相同** |
| 分支自有路径 `goal/`、`packages/uitstalie/` | 与 rebase 前**逐字一致**（0 文件差异） |
| 冲突标记泄漏 | 无 |
| 根 `packageManager` | 保持分支侧 `pnpm@12.4.1`（含完整性摘要），未被上游的 11.x 覆盖 |

## rebase 收尾：clean + lockfile

- `pnpm run clean` 移除 **355 个路径**（跨大版本 rebase 后先 clean 再 build，避免旧 `lib/` 被当作包发现）。
- `pnpm install`（pnpm 12.4.1）重生成 `pnpm-lock.yaml`；此后三条清单改动（typert 依赖、`@types/react` 删除）再跑一次 install，lockfile 与清单一致。
- 首次 `pnpm run build` 曾因 `clientBundle` 首参报错而停在 host bundle；改完三处 `tsdown.config.ts` 后复跑全绿。

## 验证（rebase 后）

| 检查 | 结果 |
|---|---|
| `pnpm run build` | ✓ **9 gate 全绿**、331 个 client artifact、3 个 public value |
| `pnpm exec vitest run packages/uitstalie` | ✓ **20 文件 / 141 测试**（含装配 roster 的 common-view 规格） |
| `pnpm run test:gui` | 642 文件 / 10770 测试：**10764 通过 / 4 失败 / 2 跳过**；4 处均为环境或负载性，见下 |
| `pnpm run test:docs` | **20 通过 / 1 失败**；唯一失败是 `verify-repository-references` 对上游 `python/sdk/uv.lock` 的误报，见下 |
| `pnpm run verify-package-dependencies` | ✓ 87 包（5 Client-only / 80 Client-Host / 2 Host） |
| `pnpm run verify-client-packages` | ✓ 66 个 client 包（61 dynamic / 5 static）、6 条 external request |
| `pnpm run verify-product-use` | ✓ 280 default / 33 optional、2150 个源模块 |
| `pnpm run verify-default-product-isolation` | ✓ 296 包、2135 个运行时源、10 个配置、311 条 web 组合行 |
| `pnpm run verify-cordis-config` | 仅 acp 档案的符号链接环境失败（同 task23/task25） |
| `pnpm run lint:contracts-ready` | 0 error / 1 warning（上游 `client-ui-cot-translation` 的冗余 disable 指令） |
| `git grep '^(<<<<<<<|>>>>>>>) '` | ✓ 无冲突标记 |

**GUI 的 4 处失败**（均与本分支内容无关）：`connection/binary-rpc.host.spec.ts` 两条 5s 超时（单独复跑即绿，task39 已定性为负载抖动）；`ui-deliverables/present-open.host.spec.ts` 的 `symlink()` EPERM（limitations #4）；`host/open-in-app/tests/resolver.spec.ts` 的 `EBUSY`（Windows 并发删临时 exe；单独复跑通过）。后两条与 binary-rpc 单独复跑合计 78 测试全绿。

**docs 的唯一失败**：`python/sdk/uv.lock:113` 被 `verify-repository-references` 判为 `commit-hash`。该行是 wheel 记录里的 `size` 字段（七位十进制数），这个数字恰好是本地对象库里一条**上游提交**的唯一前缀；该门禁只把「命中本地对象库的候选」算作引用，因此全历史克隆才会命中（上游文件、内容与 `upstream/master` 一致，本分支未触碰 `python/`）。属环境性误报。

## hygiene 盘点（本次未修：均为既有、环境或上游条件）

`pnpm run hygiene` 报 7 项红灯。逐项定性如下，**没有一项由本次 rebase 引入**；其中修复面较大或属于原生文件的，另立任务需要用户定夺。

| 门禁 | 现象 | 定性 |
|---|---|---|
| `verify-runtime-closure` | preset 行挂 `dsh-agent-instructions-plus` / `dsh-tool-dsh-store`，而 `python/sdk-runtime` 未声明；`dsh-llm-plus` 的 peer `models-dev` / `util-crypto` 也不在 closure | 分支既有：preset 行 rebase 前后逐字相同，门禁脚本未变 |
| `verify-no-unknown-casts` | 5 处 `as unknown`（llm-plus 测试 4 处、models-dev catalog 1 处）不在 baseline | 分支既有：这些文件 rebase 前后未变；上游 baseline 本次重排（530→522）也从未含我们 |
| `constraints` | 分支 7 个包的 `workspace:^` 与仓库 protocol（DSH 用 `workspace:*`、vendor 用 `workspace:~`）不符 | 分支既有：rebase 前的清单同样如此 |
| `publint` | 每个包都报 `pkg.exports["./src/*"] … does not match any files` | 上游侧：发布视图按 `files` 组装而不含 `src`，脚本本次只是把 browser-format 误报的抑制挪了位置 |
| `rescope-vendor:check` | 20 处 residue：多数是上游新文件（apps/web 测试、docs/upgrade-guide、snapshots fixture），另有一处是我们 `loader-composition.spec.ts` 里的 `'cordis'` | 上游映射表滞后 + 我们复制件的路径不在豁免表；rescope 脚本未变 |
| `verify-node-next-types` | 脚本在临时目录建目录符号链接，本机无此权限 ⇒ 空诊断的 EPERM | 环境：同 limitations #4（`core.symlinks=false`） |
| `verify-cordis-config` | acp 档案在索引里是符号链接，本机检出为文本 | 环境：limitations #4 |

## 待办

1. **推送决策**：`--force-with-lease` 推送 `cli-desktop`（远端旧 tip 已在本地保底分支 `backup/cli-desktop-20261020-1025`）。
2. **hygiene 的 5 项既有红灯**（runtime closure / unknown casts / constraints / publint / rescope）：是否立项修，需用户定夺；与本次 rebase 无关。
3. [limitations](../limitations.md) 已追加「本机 hygiene 红灯」一条，指回本任务单。
