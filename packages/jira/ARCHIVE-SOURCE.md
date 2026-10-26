# ARCHIVE-SOURCE.md — jira 代码与文档的归档来源

本文记录 `packages/jira/` 的内容来自哪个外部仓库、对应哪个提交、哪些内容已经迁入、哪些仍留在外部仓库，以及外部仓库可以归档的退出条件。迁移的目标形状与阶段记录在 [MIGRATION.md](MIGRATION.md)，决策与理由在 [DESIGN.md](DESIGN.md)，操作与交接信息在 [HANDOVER.md](HANDOVER.md)。

## 来源

| 项 | 值 |
|---|---|
| 源代码仓 | `uitstalie/dsh-plugin-multidevice-jira`（GitHub private） |
| 源代码提交 | `38b0e91`（`38b0e91d676781c1292a0acc8c167c642f1fec98`，2026-10-23） |
| 数据仓 | `uitstalie/dsh-plugin-multidevice-jira-cloudstore`（GitHub private） |
| 数据仓状态 | 未迁移、未改格式；账本数据仍以该仓的 git 历史为准，`jira-service` 通过本地 clone 读写 |
| 迁移设计 | [MIGRATION.md](MIGRATION.md)（针对 `38b0e91` 编写，已执行） |
| 包组入口 | [packages/jira/README.md](README.md) |

## 迁入矩阵

| 内容 | 状态 | 落点与说明 |
|---|---|---|
| 代码 `src/core/` | 已迁入 | `packages/jira/jira-core/src/`，含 `system/`、`messages.ts`、`entity.ts`、`result.ts`、`errors.ts` |
| 代码 `src/plugin/` | 已迁入 | 模型面在 `packages/jira/jira-agent/src/`；装配部分（makeStore、machine id、push 队列、effect 接线）拆到 `packages/jira/jira-service/src/` |
| 代码 `src/cli/` | 已迁入 | `packages/jira/jira-cli/src/`，含 `main.ts`、`runtime.ts` 与 `commands/` 下的 23 个命令 |
| 代码 `src/testing/` | 已迁入 | `packages/jira/jira-core/src/testing/`（`bothPlatforms`、`removeTree`） |
| 测试 | 已迁入 | 各包的 `*.test.ts` 随包迁移（import 改为包根）；`jira-service` 与 `ui-jira` 另有本仓新增的 vitest 规格（`tests/*.spec.ts`、`tests/*.spec.tsx`） |
| 技能 | 已迁入 | `packages/jira/jira-agent/skills/`：`jira-work.md`、`jira-board.md`、`jira-triage.md` |
| 测试夹具 | 已迁入 | `packages/jira/jira-core/fixtures/config.md`，必须与账本仓 `config.md` 逐字一致（决策 189） |
| DESIGN.md | 已迁入 | `packages/jira/DESIGN.md`，正文未改（仅去掉 5 行行尾空白） |
| HANDOVER.md | 已迁入 | `packages/jira/HANDOVER.md`，交接与操作记录正文未改 |
| MIGRATION.md | 已迁入 | `packages/jira/MIGRATION.md`；本仓版只在页首注明写于 `38b0e91`、已执行、包路径位于 `packages/jira/` |
| LICENSE | 未单独迁入 | 外部仓的 MIT 许可证文件（`Copyright (c) 2026 uitstalie`）没有复制为文件；各包只声明 `license: "MIT"`，仓根 `LICENSE` 的版权行是 `Copyright (c) 2026 DeepSeek` |
| 守卫脚本、CI 与打包脚本 | 部分迁入 | 边界守卫的不变量落成 `packages/jira/tests/boundaries.spec.ts`；其余脚本的归属见下一节 |

## 未迁入的内容

| 内容 | 原因与后续 |
|---|---|
| `scripts/check-boundaries.mjs` | **已迁入**为 `packages/jira/tests/boundaries.spec.ts`：`jira-core` 零宿主 import（只用 `node:*` 与相对路径）、分层方向（`jira-core` ↛ 适配层、`jira-agent` ↛ `jira-cli`、`jira-cli` ↛ `jira-agent`）、禁止直写 `console`、IO 白名单（只有 `jira-core/src/{io,git,lock,hooks}.ts` 可 import `node:fs`/`node:child_process`）。原脚本的 20 条自检表照原意保留，并加了一条"向真实源码注入违规"的用例；原脚本的 `core/`→`cli`/`plugin` 目录映射换成了五个包的实际路径，"adapter 零宿主依赖"一条按决策 108 只约束独立插件，`jira-service` 与 `jira-agent` 允许 import `@deepseek-ai/dsh-*`。 |
| `scripts/smoke.mjs` | 它跑构建后的 `dist/`，用真账本的临时 clone 走 33 步。这依赖机器上的真实账本与 git 钩子，无法在 CI 复现；仓库的测试策略用组合测试与快照回放替代，"构建 `jira-cli` + `jira-agent` 后跑 33 步"的仓级冒烟测试是后续工作。 |
| `scripts/i18n-tests.mjs` / `scripts/i18n-human.mjs` | 它们是一次性 i18n 迁移的执行器（决策 55）：按表替换 CLI 帮助面的英文字符串并断言每条替换都命中。迁移已完成，脚本在本仓没有可执行的目标。 |
| `scripts/check-text.mjs` | 它检查 LF 与无 BOM；本仓由 `.gitattributes`、编辑器设置与 pre-commit 的 `git diff --cached --check` 覆盖同类问题。 |
| `scripts/check-build.mjs` | 它检查构建产物与 `package.json` 中 `exports`/`bin` 的承诺一致；本仓由 `build:check`、`hygiene`（publint）与各包的入口检查承担同一职责。 |
| `.github/workflows/ci.yml` | 它是外部仓的双平台测试加打包检查工作流。本仓的 CI 由仓库自己的 workflow 拥有，包级 workflow 在 monorepo 里不会运行；账本仓自己的 `.github/workflows/ledger.yml` 属于数据仓，保持不变。 |

## 归档退出条件

- 外部代码仓 `uitstalie/dsh-plugin-multidevice-jira` 的每个跟踪文件，都能在本仓找到落点，或在本文件的两张表里登记为"不迁"。
- `packages/jira/` 的文档齐全：五个包 README 与各自的 `README.zh.md` 成对，[DESIGN.md](DESIGN.md)、[HANDOVER.md](HANDOVER.md)、[MIGRATION.md](MIGRATION.md) 与本文件可查。
- 本仓的文档门禁通过：`verify-package-readme-summaries`、`verify-package-readme-model-experience`、`verify-package-readme-limitations`、`verify-translation-pairing`、`verify-md-links`、`verify-subsystem-pages`。
- 五个包的测试套件在本仓可运行：`jira-core`、`jira-cli`、`jira-agent` 的 `node --test`，`jira-service`、`ui-jira` 的 vitest 规格。
- 遗留的守卫脚本（边界、冒烟、文本卫生、构建承诺）有明确归属：边界守卫已落成 `packages/jira/tests/boundaries.spec.ts`；文本卫生由 `.gitattributes` 与 pre-commit 的 `git diff --cached --check` 承担，构建承诺由 `build:check`、`hygiene`（publint）承担，CI 由本仓 workflow 承担；i18n 两个脚本是一次性迁移执行器，迁移完成后没有可执行目标。冒烟测试的落点仍在补齐；在此之前外部仓保持只读，不删除。
- 确认外部 LICENSE 的版权行（`Copyright (c) 2026 uitstalie`）是否需要以文件或 NOTICE 形式保留在本仓；当前只有各包的 `license: "MIT"` 声明与仓根 `LICENSE`。
- 数据仓 `uitstalie/dsh-plugin-multidevice-jira-cloudstore` 不受影响：归档只针对代码仓，账本数据继续提交。
- 以上条件满足后把外部代码仓设为只读归档（GitHub archive），不迁移它的 CI，也不在本仓恢复 `disabled_manually` 的工作流。
