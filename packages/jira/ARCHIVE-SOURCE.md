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
| LICENSE | 沿用本仓根 `LICENSE` | 外部仓的代码是同一作者的 MIT 作品，本仓根 `LICENSE`（MIT）已覆盖；不再单独复制外部 `LICENSE`，也不新增 `NOTICE`。各包只声明 `license: "MIT"` |
| 守卫脚本、CI 与打包脚本 | 已迁入（边界与冒烟） | 边界守卫是 `packages/jira/tests/boundaries.spec.ts`，冒烟测试是 `packages/jira/tests/smoke.spec.ts`；其余脚本的归属见下一节 |

## 未迁入的内容

| 内容 | 原因与后续 |
|---|---|
| `scripts/check-boundaries.mjs` | **已迁入**为 `packages/jira/tests/boundaries.spec.ts`：`jira-core` 零宿主 import（只用 `node:*` 与相对路径）、分层方向（`jira-core` ↛ 适配层、`jira-agent` ↛ `jira-cli`、`jira-cli` ↛ `jira-agent`）、禁止直写 `console`、IO 白名单（只有 `jira-core/src/{io,git,lock,hooks}.ts` 可 import `node:fs`/`node:child_process`）。原脚本的 20 条自检表照原意保留，并加了一条"向真实源码注入违规"的用例；原脚本的 `core/`→`cli`/`plugin` 目录映射换成了五个包的实际路径，"adapter 零宿主依赖"一条按决策 108 只约束独立插件，`jira-service` 与 `jira-agent` 允许 import `@deepseek-ai/dsh-*`。 |
| `scripts/smoke.mjs` | **已迁入**为 `packages/jira/tests/smoke.spec.ts`：用 `jira-core` 的 store 函数从 `jira-core/fixtures/config.md` 建一个临时账本（一个项目、两条 issue、一个 tag），再在进程内驱动 CLI 走完读面 → 写生命周期 → 生成/自检 → 提交信息绑定 → 钩子装卸。原脚本的 33 步里，**真账本 clone 与 `dist/` 陈旧构建检查**换成临时 fixture 与源码驱动（这正是"可在 CI 复现"的改动）；**prompt 注入 3 步**（`[store]` 行、workspace 命名、空账本静默）需要活的插件宿主，其计数、格式化与 workspace 命名已由 `jira-core/src/injection.test.ts` 覆盖；**"钩子拦住真实提交"1 步**需要构建后的 CLI 路径，`jira-core/src/hooks.test.ts` 用桩 CLI 跑过真实 `git commit`，本测试改为直接跑 `verify-commit-msg` 的通过与拒绝两种消息，并核对本次产生的提交信息都带 issue key 或 `[no-issue]`。其余步骤逐条保留：读面 11 条命令与"只读不写"断言、`list --json` + `get`、board.html 自包含、写生命周期（new/comment/switch/assignee/`kb` 增改查/update --kb-refs/close）、`generate` 与 `generate --check`、`lint`/`lint --keys`/`lint --keys --compare`（与第二个空账本比较）、`doctor`、`hooks install/status/uninstall`；原"词表解析"一步由 fixture 建账本时的真实解析覆盖（非法流转会被拒）。 |
| `scripts/i18n-tests.mjs` / `scripts/i18n-human.mjs` | 它们是一次性 i18n 迁移的执行器（决策 55）：按表替换 CLI 帮助面的英文字符串并断言每条替换都命中。迁移已完成，脚本在本仓没有可执行的目标。 |
| `scripts/check-text.mjs` | 它检查 LF 与无 BOM；本仓由 `.gitattributes`、编辑器设置与 pre-commit 的 `git diff --cached --check` 覆盖同类问题。 |
| `scripts/check-build.mjs` | 它检查构建产物与 `package.json` 中 `exports`/`bin` 的承诺一致；本仓由 `build:check`、`hygiene`（publint）与各包的入口检查承担同一职责。 |
| `.github/workflows/ci.yml` | 它是外部仓的双平台测试加打包检查工作流。本仓的 CI 由仓库自己的 workflow 拥有，包级 workflow 在 monorepo 里不会运行；账本仓自己的 `.github/workflows/ledger.yml` 属于数据仓，保持不变。 |

## 归档退出条件

- 外部代码仓 `uitstalie/dsh-plugin-multidevice-jira` 的每个跟踪文件，都能在本仓找到落点，或在本文件的两张表里登记为"不迁"。
- `packages/jira/` 的文档齐全：五个包 README 与各自的 `README.zh.md` 成对，[DESIGN.md](DESIGN.md)、[HANDOVER.md](HANDOVER.md)、[MIGRATION.md](MIGRATION.md) 与本文件可查。
- 本仓的文档门禁通过：`verify-package-readme-summaries`、`verify-package-readme-model-experience`、`verify-package-readme-limitations`、`verify-translation-pairing`、`verify-md-links`、`verify-subsystem-pages`。
- 五个包的测试套件在本仓可运行：`jira-core`、`jira-cli`、`jira-agent` 的 `node --test`，`jira-service`、`ui-jira` 的 vitest 规格。
- 遗留的守卫脚本（边界、冒烟、文本卫生、构建承诺）有明确归属：边界守卫与冒烟测试已落成 `packages/jira/tests/boundaries.spec.ts`、`packages/jira/tests/smoke.spec.ts`；文本卫生由 `.gitattributes` 与 pre-commit 的 `git diff --cached --check` 承担，构建承诺由 `build:check`、`hygiene`（publint）承担，CI 由本仓 workflow 承担；i18n 两个脚本是一次性迁移执行器，迁移完成后没有可执行目标。外部仓在归档条件全部满足前保持只读，不删除。
- 数据仓 `uitstalie/dsh-plugin-multidevice-jira-cloudstore` 不受影响：归档只针对代码仓，账本数据继续提交。
- 以上条件满足后把外部代码仓设为只读归档（GitHub archive），不迁移它的 CI，也不在本仓恢复 `disabled_manually` 的工作流。
