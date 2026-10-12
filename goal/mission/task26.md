# task26 — 早期原生改动的追溯补标记清扫

## requirement

用户要求（2026/10/12，"第一项，做"）：处理 [task25](task25.md) 遗留的**38 个"有分支改动但没有 `uitstalie-` 标记"的原生文件**。这是 [task23](task23.md) 盘点时发现、当时未处理的合规缺口：分支规则要求每一处原生改动都能被 `git grep -n "uitstalie-"` 枚举，且带标记的改动可在 rebase 冲突现场离线定位。

本任务单与 [task21](task21.md)/[task22](task22.md) 无关（那两项是门禁收尾）；本任务单只做**追溯标记与登记**，不改任何行为、不改任何文案含义。

## 清单来源（可复现）

```
git diff --name-only upstream/master..HEAD      # 262 条
git grep -l "uitstalie-"                        # 58 个（含本任务单）
```

两者相减、再去掉分支自有路径（`goal/*`、`packages/uitstalie/*`），余下 **38 个原生文件** ✓（与 task23 记录的数字一致）。

## 分类与处置

**判据**：宿主文件类型能否内嵌注释；以及该文件是否由生成器产出（生成物上的手写标记会被下次生成覆盖）。

### A. 可内嵌注释 → 补标记（20 个）

| 文件 | 改动来源（原任务） | 本次做法 |
|---|---|---|
| `packages/shell/bash-sandbox/src/helpers.ts` | task12：`classifyDenial` 增 `writableRoots` 参数并改为转发共享分类器 | BEGIN/END 块 |
| `packages/shell/bash-sandbox/tests/sandbox.spec.ts` | task12：同上，用例补第三个实参 | BEGIN/END 块 |
| `packages/sandbox/sandbox-local/tests/local.spec.ts` | task12：Windows ACL 的 `denialSignatures` 期望收窄为两条 | 单行行内 |
| `packages/sandbox/sandbox-windows-acl/tests/provider-chain.spec.ts` | task12：同上 | 单行行内 |
| `docs/subsystems/sandbox.md` + `.zh.md` | task12：说明"短语本身不足以判定拒绝，还需路径证据" | BEGIN/END 块 |
| `packages/fs/fs/README.md` + `.zh.md` | task14：`mkdir`/`remove` 进入 `FileSystem` seam（正文一句 + 限制两条） | 行内 + BEGIN/END |
| `packages/fs/fs-local/README.md` + `.zh.md` | task14：同上（正文一句、能力段、源码地图表、判定段） | 行内（3 处） |
| `packages/fs/fs-sandbox/README.md` + `.zh.md` | task14：沙箱装饰器覆盖 `mkdir`/`remove` | 行内 |
| `packages/sandbox/sandbox-local/README.md` + `.zh.md` | task12：拒绝判定需要路径证据 | 行内 |
| `packages/sandbox/sandbox/README.md` + `.zh.md` | task12：同上（新增段落 + 源码地图行） | BEGIN/END |
| `packages/shell/bash-sandbox/README.md` + `.zh.md` | task12：同上（一句） | 行内 |
| `packages/shell/pwsh-sandbox/README.md` + `.zh.md` | task12：同上（一句） | 行内 |

行内形式：`…… 正文 <!-- uitstalie-k3, 2026/10/12, task26, 追溯补标记：<原任务与原由> -->`；块形式：`<!-- BEGIN … -->` / `<!-- END uitstalie-k3 -->`。行内形式不改行数，因此不会破坏双语逐行对齐；块形式在两侧同位置各加两行，改完统一重录配对。

### B. 生成物 → 只在任务单登记（14 个）

标记会被下一次生成覆盖，按分支规则改为逐处登记：

| 文件 | 生成者 | 我们的改动 |
|---|---|---|
| `pnpm-lock.yaml` | `pnpm install` | 分支依赖/清单变化的重生成结果（task25 收尾重生成） |
| `packages/extensions/tool-cordis/src/api-catalog.ts` | `scripts/gen-cordis-api.ts` | 分支新增包的 API 条目 |
| `docs/subsystems/filesystem.md` + `.zh.md` | `scripts/gen-cordis-catalog.ts`（`BEGIN GENERATED cordis-surface` 区，第 280–554 行） | `FileSystem.mkdir`/`remove` 的类型面（task14） |
| `docs/subsystems/llm-streaming.md` + `.zh.md` | 同上（`BEGIN GENERATED cordis-surface` 区，第 909–1279 行） | `ctx.modelsDev` 一节（task17；正文取自 `packages/uitstalie/models-dev` 的 JSDoc） |
| `docs/subsystems/sandbox.i18n.yaml` | `verify-translation-pairing --write` | 配对记录（task12 改过 sandbox.md） |
| `packages/fs/fs/README.i18n.yaml`、`fs-local`、`fs-sandbox` | 同上 | 配对记录（task14） |
| `packages/sandbox/sandbox/README.i18n.yaml`、`sandbox-local` | 同上 | 配对记录（task12） |
| `packages/shell/bash-sandbox/README.i18n.yaml`、`pwsh-sandbox` | 同上 | 配对记录（task12） |

### C. JSON（不支持注释）→ 只在任务单登记（4 个）

| 文件 | 我们的改动 |
|---|---|
| `opencode.json` | 分支自有根级配置：注入 `goal/AGENTS.md` 为会话规则 |
| `package.json`（根） | `packageManager` 固定 pnpm 12.4.1 + 完整性哈希（task25 保留分支侧解法） |
| `packages/bundle/base/package.json` | base 组合声明 `dsh-llm-plus`、`dsh-working-directory` 等分支所需依赖（task9） |
| `packages/bundle/web-app/package.json` | web 组合声明分支自有 client 行（task14/17/24） |

## 验证

| 检查 | 结果 |
|---|---|
| `git grep -l "uitstalie-"` 文件数 | **58 → 78**（补标记的 20 个文件全部在册；余下 18 个即上表 B/C 两类的生成物与 JSON） |
| `verify-translation-pairing --write`（8 个配对） | ✓ 重录 8 份 `.i18n.yaml`；随后 `verify-translation-pairing` 检查 **935 对全绿** |
| `pnpm run test:docs` | ✓ **21 条门禁全绿**（含双语配对、md 链接、md 换行、模型体验、仓库引用） |
| `tsc -b tsconfig.client.json tsconfig.host.json` | ✓ 两面干净（代码/测试文件只加注释） |
| 聚焦测试 `packages/sandbox` + `packages/shell/bash-sandbox` + `packages/shell/pwsh-sandbox` | ✓ **23 文件 / 290 测试通过、3 跳过**（首轮与 tsc 并发时 `sandbox-windows-acl/tests/control.spec.ts` 有一例超时，独立复跑 3/3 通过——环境性抖动，与本轮注释无关） |
| 内容零变化 | ✓ 全部改动经 `git diff --word-diff` 逐行核对：除新增标记行与 8 份 `.i18n.yaml` 哈希外，**没有任何正文改动** |

**未标出的部分（有意为之）**：B 类生成物不做手写标记——标记会被下一次生成覆盖；C 类 JSON 不支持注释——两者的登记以本任务单的表格为准（分支规则认可的替代形式）。