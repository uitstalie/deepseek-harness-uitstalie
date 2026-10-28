# 原生改动盘点（DH-311）

本文是 DH-311 的落盘清单：把 `upstream/master` 到分支 HEAD 的全部改动按「分支自有 / 生成物 / 原生改动」分开，逐文件给出标记键、变更原因与回退方式，并列出仍然保留的上游内部 API 依赖。强制规则见 [AGENTS.md](AGENTS.md)，标记规范见 [rebase-friendly.md](rebase-friendly.md)。逐处登记同时在 DH-311 的 Jira 评论里。

## 口径

- 基线：`upstream/master`（2026-10-28 取点）；盘点时 HEAD 为 DH-313 的修复提交（命令与结果见该 issue 评论）。
- 命令：`git diff --name-status upstream/master...HEAD`，共 **737** 个文件（无删除）。
- 「原生改动」= 不在 `packages/uitstalie/`、`packages/jira/`、`goal/` 下的文件。原生文件里，带 `uitstalie-` 标记的由 `git grep -n uitstalie-` 枚举；不带标记的只有四类：**生成物**、**无法内联注释的 JSON**、**分支新增文件**（路径或文件名本身可辨识，不需标记）、以及**本次审计补标记的源码/配置**。

## 总数

| 类别 | 文件数 | 说明 |
|---|---:|---|
| 分支自有（`packages/uitstalie/`、`packages/jira/`、`goal/`） | 611 | 新包、新插件、新文档，rebase 永不冲突 |
| 原生改动，带标记 | 73 | `git grep -n uitstalie-` 可枚举 |
| 生成物 | 43 | 文档/目录/配对记录/lockfile，按命令重生成，不手工加标记 |
| 无法内联注释的 JSON | 6 | 逐处登记在本文件与 Jira |
| 分支新增的原生侧文件 | 4 | 路径或文件名自身可辨识（`*.uitstalie.yml`、`opencode.json`、`scripts/test-jira-node.ts`） |
| **合计** | **737** | = 611 + 73 + 43 + 6 + 4 |

## 原生改动（带标记）

73 个文件。每处都给出键，rebase 冲突时按键回查 Jira（`DH-*`）或冻结的 mission 档案（`taskNN`，见 [mission/FROZEN.md](mission/FROZEN.md)）。

| 文件 | 标记键 | 变更原因（首个标记） |
|---|---|---|
| `.github/workflows/ci.yml` | `DH-308` | jira 的 node:test 套件进 CI 静态门禁 |
| `docs/subsystems/sandbox.md` | `task26` | 追溯补标记：task12 增补“短语之外还需路径证据”的判定语义 |
| `docs/subsystems/sandbox.zh.md` | `task26` | 追溯补标记：task12 增补“短语之外还需路径证据”的判定语义 |
| `packages/bundle/web-app/presets/cordis.patch.yml` | `DH-5` | agent-instructions-plus 在分支层提供基线，preset 不再重复挂载原生 agent-instructions |
| `packages/bundle/web-app/presets/ptc.patch.yml` | `DH-5` | agent-instructions-plus 在分支层提供基线，preset 不再重复挂载原生 agent-instructions |
| `packages/bundle/web-app/presets/standard.patch.yml` | `DH-5` | agent-instructions-plus 在分支层提供基线，preset 不再重复挂载原生 agent-instructions |
| `packages/client/tsdown.client.ts` | `task22` | 未解析裸导入从警告升级为构建错误（浏览器里只表现为模块表拒绝该行、整行插件不激活） |
| `packages/client/ui-settings-general/src/client/SettingsRoot.tsx` | `DH-14` | 设置段可跳到兄弟段 |
| `packages/client/ui-settings-general/tests/shell.client.spec.ts` | `DH-15,DH-316` | 分支 jira 设置段与能力总代段进入 roster |
| `packages/client/ui-settings/src/client/contract/slots.ts` | `DH-14` | 设置段 owner 增加 openSection |
| `packages/client/ui-workspace/src/client/contract/slots.ts` | `task14` | 工作区行 action seat 的 owner 份额 |
| `packages/client/ui-workspace/src/client/index.ts` | `task14` | 声明该 seat 后才允许占用 |
| `packages/client/ui-workspace/src/client/rows/Rows.tsx` | `task14` | 行组件需要渲染该 seat |
| `packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx` | `task14` | 把 seat 渲染器透传给工作区行组件 |
| `packages/context/agent-instructions/src/index.ts` | `task16` | 让 plus 插件能复用 loader 的公开实现（纯导出可见性，行为不变） |
| `packages/fs/fs-local/README.md` | `task26` | 追溯补标记：原 task14 的 mkdir/remove 能力 |
| `packages/fs/fs-local/README.zh.md` | `task26` | 追溯补标记：原 task14 的 mkdir/remove 能力 |
| `packages/fs/fs-local/src/fsio.ts` | `task14` | .dsh/ store 需要"建目录/删除"两个原语（本地实现） |
| `packages/fs/fs-local/src/index.ts` | `task14` | remove 的选项类型 |
| `packages/fs/fs-local/tests/filesystem.spec.ts` | `task14` | 建目录与删除原语的本地行为 |
| `packages/fs/fs-sandbox/README.md` | `task26` | 追溯补标记：原 task14 的 mkdir/remove |
| `packages/fs/fs-sandbox/README.zh.md` | `task26` | 追溯补标记：原 task14 的 mkdir/remove |
| `packages/fs/fs-sandbox/src/index.ts` | `task14` | remove 的选项类型 |
| `packages/fs/fs-sandbox/tests/fs-sandbox.spec.ts` | `task14` | 建目录与删除同样受策略围栏 |
| `packages/fs/fs/README.md` | `task26` | 追溯补标记：原 task14 的 mkdir/remove |
| `packages/fs/fs/README.zh.md` | `task26` | 追溯补标记：原 task14 的 mkdir/remove |
| `packages/fs/fs/src/index.ts` | `task14` | remove 的选项类型 |
| `packages/fs/fs/src/types.ts` | `task14` | .dsh/ store 需要删除原语：给 remove 一个有名字的选项形状 |
| `packages/ptc-runtime/ptc-runtime-node/src/index.ts` | `task12` | 本次调用的授权根，供拒绝分类判断路径归属。 |
| `packages/README.md` | `DH-11` | 分支自有包组登记 |
| `packages/README.zh.md` | `DH-11` | 分支自有包组登记 |
| `packages/sandbox/sandbox-local/README.md` | `task26` | 追溯补标记：原 task12 的拒绝短语收窄 |
| `packages/sandbox/sandbox-local/README.zh.md` | `task26` | 追溯补标记：原 task12 的拒绝短语收窄 |
| `packages/sandbox/sandbox-local/src/index.ts` | `task12,task34,task37` | 去掉通用短语 "permission denied" 与 |
| `packages/sandbox/sandbox-local/tests/local.spec.ts` | `task26,task37` | 追溯补标记：task12 把 windows-acl 的拒绝短语收窄为确实带路径证据的两条 |
| `packages/sandbox/sandbox-windows-acl/README.md` | `task34` | 在该限制处指明失败形态与诊断 skill 入口 |
| `packages/sandbox/sandbox-windows-acl/README.zh.md` | `task34` | 在该限制处指明失败形态与诊断 skill 入口 |
| `packages/sandbox/sandbox-windows-acl/src/acl.ts` | `task11` | 幂等跳过条件改为分别判断：一次部分落盘的 |
| `packages/sandbox/sandbox-windows-acl/tests/provider-chain.spec.ts` | `task26,task37` | 追溯补标记：task12 把 windows-acl 的拒绝短语收窄为确实带路径证据的两条 |
| `packages/sandbox/sandbox/README.md` | `task26` | 追溯补标记：原 task12 增补“短语之外还需路径证据”的判定段落 |
| `packages/sandbox/sandbox/README.zh.md` | `task26` | 追溯补标记：原 task12 增补“短语之外还需路径证据”的判定段落 |
| `packages/sandbox/sandbox/src/diagnostics.ts` | `task12,task37` | 路径证据按解析后真实路径判定需要拼路径 |
| `packages/sandbox/sandbox/src/index.ts` | `task12` | 导出带路径证据的拒绝分类 |
| `packages/sandbox/sandbox/tests/diagnostics.spec.ts` | `DH-305` | 拒绝分类的路径证据按平台比较（大小写折叠与目录段边界） |
| `packages/shell/bash-sandbox/README.md` | `task26` | 追溯补标记：原 task12 的路径证据要求 |
| `packages/shell/bash-sandbox/README.zh.md` | `task26` | 追溯补标记：原 task12 的路径证据要求 |
| `packages/shell/bash-sandbox/src/helpers.ts` | `task26` | 追溯补标记：task12 让 bash 的分类也走共享分类器并携带可写根 |
| `packages/shell/bash-sandbox/src/index.ts` | `task12` | 后台路径按 exitCode+stderr 直接分类（前台路径走 helpers 的结果级包装） |
| `packages/shell/bash-sandbox/tests/sandbox.spec.ts` | `task26` | 追溯补标记：task12 给该块每个用例补第三实参 writableRoots，并新增"需要路径证据"的用例 |
| `packages/shell/pwsh-sandbox/README.md` | `task26` | 追溯补标记：原 task12 的路径证据要求 |
| `packages/shell/pwsh-sandbox/README.zh.md` | `task26` | 追溯补标记：原 task12 的路径证据要求 |
| `packages/shell/pwsh-sandbox/src/helpers.ts` | `task12` | 拒绝分类改用共享实现（带路径证据），不再只用短语匹配 |
| `packages/shell/pwsh-sandbox/src/index.ts` | `task12` | 后台路径按 exitCode+stderr 直接分类（前台路径走 helpers 的结果级包装） |
| `packages/shell/tool-pwsh/README.md` | `task28` | 工具描述补充两条方言规则 |
| `packages/shell/tool-pwsh/README.zh.md` | `task28` | 工具描述补充两条方言规则 |
| `packages/shell/tool-pwsh/src/index.ts` | `task28` | 依据 PowerShell 实战踩坑记录补两条方言级规则（引号/文件化 + bash 惯性、退出码与 Replace 静默） |
| `packages/test-support/client-runtime/README.md` | `DH-307` | 替身补 $stream 以支撑打开看板/详情的 logical stream |
| `packages/test-support/client-runtime/README.zh.md` | `DH-307` | 替身补 $stream 以支撑打开看板/详情的 logical stream |
| `packages/test-support/client-runtime/src/assembly/remote-default-responses.ts` | `DH-315` | 分支 web roster 的 ui-jira 在 apply 时打开台账变更流 |
| `packages/test-support/client-runtime/src/remote.ts` | `DH-307` | 打开看板/详情需要一代 logical stream，测试替身补 $stream |
| `scripts/check-workspace-constraints.ts` | `DH-13,DH-201,DH-3` | 分支自有包不发布：发布成员规则（版本/公开仓库/files 清单）只约束上游发布成员 |
| `scripts/client-bundle-purity.spec.ts` | `task22` | 覆盖新增的产物裸导入门禁（未声明 external 的裸导入必须构建失败） |
| `scripts/gen-cordis-catalog.ts` | `DH-311,DH-313,task18` | 分支自有的模型目录服务，归到 LLM 页 |
| `scripts/gen-doc-graphs.ts` | `DH-12` | 分支自有服务（能力总代/存储/台账/models.dev）在 docs/subsystems 之外的契约登记 |
| `scripts/gen-tool-catalog.ts` | `task28` | 分支自有工具包 dsh-tool-dsh-store 此前未进目录清单，导致 verify-tool-catalog 直接失败 |
| `scripts/product-package-policy.ts` | `task25` | 分支的 base 组合用 llm-plus 行取代了 llm-pi-ai 行，该 provider 仍可由用户组合选用 |
| `scripts/run-gates.ts` | `DH-201` | jira 的 node:test 套件进 CI 静态门禁 |
| `scripts/verify-package-readme-model-experience.ts` | `DH-12,DH-309,DH-310,task20` | 存储原子没有模型面 |
| `scripts/verify-repository-references.ts` | `DH-311` | 机器本地 .dsh/memory 不参与提交号扫描 |
| `tsconfig.base.json` | `DH-12,DH-13,DH-15,DH-302,DH-310,task14,task23,task5,task8` | 新增 models-dev 包的 deepseek-extra-params 子路径别名（生成器只管根与 invariant，子路径走手写区） |
| `tsconfig.client.json` | `DH-12,DH-13,DH-302,DH-310,task14,task24,task8` | 注册 uitstalie 组 client 包进 Client 聚合程序 |
| `tsconfig.host.json` | `DH-12,DH-13,DH-302,DH-309,DH-310,DH-311,DH-7,task14,task16,task6` | 注册 uitstalie 组两个新包进 Host 聚合程序 |
| `vitest.config.ts` | `DH-13` | jira 组级边界/冒烟套件随 jira 包入仓，根 vitest 必须收进来 |

## 生成物与生成命令

| 文件 | 生成命令 |
|---|---|
| `docs/capability-seams.*`、`docs/module-graph.*`、`docs/event-producer-consumer.*` | `pnpm run gen-doc-graphs` |
| `docs/config-catalog.*` | `pnpm run gen-config-catalog` |
| `docs/tool-catalog.*` | `pnpm run gen-tool-catalog` |
| `docs/persistence-catalog.*`、`docs/persistence-schema.json`、`docs/persistence-changes/**` | `pnpm run gen-persistence-catalog`（随后 `verify-persistence-changes` / `verify-persistence-formats`） |
| `docs/subsystems/filesystem.*`、`docs/subsystems/llm-streaming.*` | `pnpm run gen-cordis-api` |
| `packages/extensions/tool-cordis/src/api-catalog.ts` | `pnpm run gen-cordis-api` |
| `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts` | `pnpm run gen-client-catalog` |
| `packages/preset/agent-preset/skills/cordis-composition-reference/references/packages.md` | `pnpm run gen-plugin-packages` |
| `packages/README.i18n.yaml`、`packages/{fs,sandbox,shell}/*/README.i18n.yaml`、`packages/test-support/client-runtime/README.i18n.yaml`、`docs/subsystems/sandbox.i18n.yaml`、`docs/*.i18n.yaml` | `pnpm run verify-translation-pairing --write <README.md>` |
| `pnpm-lock.yaml` | `pnpm install` |

生成物一律不手工加 `uitstalie-` 标记：标记会与生成器输出互相覆盖。行尾出现 `uitstalie-` 的生成文档（如 `docs/subsystems/sandbox.md`）是生成区域之外的**手写段落**，按普通原生改动标记。

## 无法内联注释的 JSON（6）

| 文件 | 改动与登记 |
|---|---|
| `package.json` | 根脚本 `test:jira:node` / `test:jira`（DH-308）；`packageManager` 升到 `pnpm@12.4.1`（分支工具链，rebase 后恢复锁文件完整性时定版） |
| `packages/bundle/base/package.json` | `dsh.bundle.patch` 改为数组并追加 `cordis.patch.uitstalie.yml`；依赖加 `dsh-llm-plus`（DH-1）、`dsh-models-dev`（DH-1） |
| `packages/bundle/web-app/package.json` | 同上追加分支补丁层；依赖加 `agent-instructions-plus`（DH-5）、`client-common-view`（task24）、`ui-dafeiyu`/`dafeiyu`/`memory`/`personality`（DH-12、DH-310）、`ui-jira`/`jira-agent`/`jira-service`（DH-13）、`ui-memory`（DH-310）、`models-dev`/`ui-models-dev`（task5、task8）、`tool-dsh-store`/`ui-tool-dsh-store`（task14）、`home-backup`（DH-311 追溯）、`system-environment`（DH-309）、`ui-file-drag`（分支 client 插件） |
| `packages/test-support/client-runtime/package.json` | 测试支撑的 roster 依赖补分支 client 插件（DH-15） |
| `python/sdk-runtime/package.json` | Host 闭包补 `agent-instructions-plus`、`models-dev`、`tool-dsh-store`、`util-crypto`（DH-5、DH-1、task14） |
| `snapshots/session/pwsh-tool-turn/tool-schemas.expected.json` | 手工同步 pwsh 工具描述（task28；Windows 上不跑快照通道，按权威文本对齐） |

## 本次审计补的标记（14）

| 文件 | 键 |
|---|---|
| `.github/workflows/ci.yml` | DH-308 |
| `vitest.config.ts` | DH-13 |
| `packages/bundle/web-app/presets/cordis.patch.yml` | DH-5 |
| `packages/bundle/web-app/presets/ptc.patch.yml` | DH-5 |
| `packages/bundle/web-app/presets/standard.patch.yml` | DH-5 |
| `packages/sandbox/sandbox/tests/diagnostics.spec.ts` | DH-305 |
| `packages/shell/tool-pwsh/README.md` | task28 |
| `packages/shell/tool-pwsh/README.zh.md` | task28 |
| `packages/test-support/client-runtime/README.md` | DH-307 |
| `packages/test-support/client-runtime/README.zh.md` | DH-307 |
| `packages/test-support/client-runtime/src/remote.ts` | DH-307 |
| `packages/test-support/client-runtime/src/assembly/remote-default-responses.ts` | DH-315 |
| `scripts/gen-doc-graphs.ts` | DH-12 |
| `scripts/verify-repository-references.ts` | DH-311 |

另有两处原有标记的键不合法（不是 issue key），本次改为指向 DH-311 追溯登记：

| 文件 | 原键 | 现键 |
|---|---|---|
| `tsconfig.host.json` | `home-backup` | `DH-311` |
| `scripts/gen-cordis-catalog.ts`（分支服务分类块） | `branch-owned capability` | `DH-311` |

## 历史 mission 键索引

2026/10/20 起 mission 任务单冻结，键只作历史档案；Jira 侧以本节与 DH-311 为索引。`task18` 等键出现在生成器源码里时，指向同名的冻结档案。

| 键 | mission 档案 | 涉及文件数 |
|---|---|---:|
| `task5` | [task5.md](mission/task5.md) | 1 |
| `task6` | [task6.md](mission/task6.md) | 1 |
| `task8` | [task8.md](mission/task8.md) | 2 |
| `task11` | [task11.md](mission/task11.md) | 1 |
| `task12` | [task12.md](mission/task12.md) | 7 |
| `task14` | [task14.md](mission/task14.md) | 14 |
| `task16` | [task16.md](mission/task16.md) | 2 |
| `task18` | [task18.md](mission/task18.md) | 1 |
| `task20` | [task20.md](mission/task20.md) | 1 |
| `task22` | [task22.md](mission/task22.md) | 2 |
| `task23` | [task23.md](mission/task23.md) | 1 |
| `task24` | [task24.md](mission/task24.md) | 1 |
| `task25` | [task25.md](mission/task25.md) | 1 |
| `task26` | [task26.md](mission/task26.md) | 20 |
| `task28` | [task28.md](mission/task28.md) | 4 |
| `task34` | [task34.md](mission/task34.md) | 3 |
| `task37` | [task37.md](mission/task37.md) | 4 |

## 保留的上游内部 API 依赖

| 依赖点 | owner | 兼容约束 | 替代评估 |
|---|---|---|---|
| `packages/context/agent-instructions/src/index.ts` 的 task16 导出块（约 20 行内部实现） | 上游 `agent-instructions` 包；分支侧 `agent-instructions-plus` | 上游改动 `state.ts`/`digest.ts`/`files.ts`/`config.ts` 的内部形状时，plus 必须同步；typecheck 会先红 | 短期保留：plus 复用原生 loader 的版本/去重状态机，复制一份会漂移。中期候选：向上游提稳定 seam（指令源注册 + 版本协调），由 plus 只消费 seam；在此之前该块不扩大 |
| `ui-settings` 的 `SettingsSectionOwnerProps.openSection` | 上游 `ui-settings` contract | 新增字段是**可选**回调；上游若改 owner props 形状，只需保留该字段 | 已最小化：只加可选字段 + 透传；不依赖原生内部实现 |
| `ui-workspace` 行 action seat（task14） | 上游 `ui-workspace` | 纯新增可选 seat 与渲染占位；上游改 Row props 时按标记重放 | 无更小替代（slot 只能由原生声明）；上游化评估：通用「行级 action seat」可提 upstream |
| `fs` seam 的 `mkdir`/`remove`（task14） | 上游 `fs` | 新增可选方法，默认实现直接失败并指名后端；上游新增同名方法会冲突，按标记重放 | 通用能力，适合独立上游化；分支内保持「仅新增方法 + 本地实现」 |
| `fs-local`/`fs-sandbox` 的目录原语实现与围栏（task14） | 上游 `fs-local`/`fs-sandbox` | 围栏覆盖全部变更原语；上游重排 `writableRoots` 时按标记适配 | 与上一条一体，上游化时一起走 |
| `sandbox` 共享拒绝分类 `classifyDenial`（task11/task12/task37、DH-305） | 上游 `sandbox` | 签名含 `writableRoots` 与可选平台；上游改签名会同时影响 bash/pwsh/ptc 适配 | 通用修复，适合独立上游化；分支只保留调用适配 |
| `ptc-runtime-node`/`bash-sandbox`/`pwsh-sandbox` 的分类调用适配 | 各自上游包 | 依赖 `classifyDenial` 的形参顺序 | 上游化 `classifyDenial` 后无需保留 |
| `tool-pwsh` 描述补充（task28） | 上游 `tool-pwsh` | 纯字符串追加；上游重写描述会冲突，按标记重放 | 分支特有的 model-experience 内容，保留 |
| `SettingsRoot` 的 `openSection` 透传（DH-14） | 上游 `ui-settings-general` | 只透传原生已有的 `actions.openSection`；本次已删除顺手加的布局 wrapper | 已最小化 |

## 回退方式

| 改动 | 回退 |
|---|---|
| 单个 Jira 任务的原生块 | 按标记键找到 issue；`git revert <commit>` 或按标记删除块；生成物重跑对应 `gen-*` |
| 生成物 | 删除后重跑本表命令；不要手工改 |
| JSON 清单 | 按本文件「无法内联注释的 JSON」逐行回退；依赖行同时检查 `verify-package-dependencies` |
| 分支补丁层（`*.uitstalie.yml`） | 整文件删除并从 `package.json` 的 `dsh.bundle.patch` 数组移除 |
| 审计补的标记 | 只删注释行，不动行为 |

## rebase 重放与验证

1. `git rebase upstream/master`；冲突只会出现在「原生改动（带标记）」表列出的文件上，按标记键逐块重放。
2. `git grep -n "uitstalie-"` 与本文表对账；新增原生改动必须同时补标记与 Jira 登记。
3. 重跑：`pnpm run typecheck`（5/5）、`pnpm run verify-package-dependencies`、`pnpm run verify-cordis-api`、`pnpm run test:jira:node`，以及受原生块影响的 FS/Sandbox/Shell/Client 测试（`pnpm exec vitest run packages/fs packages/sandbox packages/shell packages/client/ui-settings-general`）。