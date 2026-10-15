# task33 — R 按钮换共享图标 + 分支插件"默认开启"梳理

**变更自**：[task32](task32.md)（R 按钮按共用件对齐邻居）与更早的"rules / models.dev 默认开启"需求；关联 [task14](task14.md)、[task17](task17.md)。
**类型**：已有 mission 的变更（新任务单，新 id）。
**原生文件改动**：本任务改动原生文件 **1 个**（`packages/bundle/base/cordis.patch.yml`，带标记）+ 其清单 `packages/bundle/base/package.json`（JSON 无法注释，故在本文档登记，见下）。

## ① R 按钮换图标

用户提示"可以查查 material3 的 icon 库"。共享图标集 [`ui-primitives/src/icons/index.tsx`](../../packages/client/ui-primitives/src/icons/index.tsx) 是自己维护的产品字形（**不是**从 Material 直接导入），而它的字形族与命名（`Outline`/`Fill` × `Regular`/`Medium`）与 Material Symbols 对应。集合里已有语义最贴的一枚：

- 采用 **`IconChecklistOutlineRegular size={14}`**（对应 Material Symbols 的 `checklist`：一列带勾选项 = 规则清单），与邻居行内按钮的 14px 图标一致 ✓；
- 未采用 `IconListPenOutline*`（带笔＝可编辑，而本按钮是**只读**查看）；
- 我们库里没有 Material Symbols 的 `rule` / `policy` 专名；真要那枚字形需要新增产品字形（按分支规则需设计师给字形）⇒ 本任务不动字形集。
- 随之删掉 `glyph: 'R'` 文案键与 `.mark` 样式；规格改为断言"触发器内是一枚装饰 svg、无文本"。

## ② 默认开启梳理（审计结论）

| 包 | 组合位置（行） | 默认 |
|---|---|---|
| `models-dev` | `bundle/web-app/cordis.patch.yml`（profile 级） | ✅ 开启 |
| `ui-models-dev` | 同上 | ✅ 开启 |
| `ui-tool-dsh-store`（R 按钮） | 同上 | ✅ 开启 |
| `common-view` | 同上 | ✅ 行开启（其 overlay 能力由自身 config 控制，默认关，属 task24 挂起项） |
| `agent-instructions-plus` | `bundle/web-app/presets/{cordis,standard,ptc}.patch.yml`（**agent 平面**） | ✅ 开启 |
| `tool-dsh-store` | 同上 | ✅ 开启 |
| `llm-plus` | `bundle/base/cordis.patch.yml`（profile 级，接替被逻辑禁用的 `llm-pi-ai`） | ✅ 开启 |

**结论：web 组合里七个插件本来就都默认开启**，不需要改动。

**发现的两个缺口（非 web 组合）**：

1. **`models-dev` 在 base（CLI/headless/acp/sdk 走这条）里没有** ⇒ **本次补上**：在 `packages/bundle/base/cordis.patch.yml` 的 `llm-plus` 行之后插入带标记的一行（宿主侧目录服务；浏览器设置页仍只在 web 组合）。清单侧需要在 `packages/bundle/base/package.json` 的 `dependencies` 增加 `"@deepseek-ai/dsh-models-dev": "workspace:*"`（JSON 无注释，故在此登记：文件 `packages/bundle/base/package.json`，`dependencies` 段，位置在 `@deepseek-ai/dsh-agent-instructions` 之后，原因＝新挂载行的包解析）。
2. **rules 链（`agent-instructions-plus` + `tool-dsh-store`）在非 web 组合里没有，且不能简单补**：`verify-cordis-config` 的**平面规则**明确拒绝"同一行同时活在宿主平面（profile 级）与 agent 平面（preset 的 `plugins` 列表）"——
   - 我最初把这两行挂到 base profile 级，门禁报 `row "agent-instructions-plus" is also active in the host composition; a row belongs to exactly one plane`（×3 个 web preset）✗；
   - 非 web 组合没有 preset 层（headless 只是个 runner；preset 只有 `bundle/web-app/presets/*.yml`）⇒ 要让 CLI 也默认带 rules，只有两条路：**(a)** 给非 web 组合引入 agent-preset 层（较大的原生改动，属上游形状）；**(b)** 把这套从 web preset 迁到 profile 级（等于改掉 web 的平面归属）✗。**本次不动，留给用户决定。**

## 验证

`oxlint`（本包 0）· `tsc -b` 两面 · `vitest packages/uitstalie/ui-tool-dsh-store`（**8 测试**）· `vitest packages/bundle/base`（2 测试）· `verify-cordis-config`（base 行被接受；**另有一处先前就存在的失败**见下）· `pnpm run build` ✓。

**先前就存在的失败（与本次无关，已核实）**：`verify-cordis-config` 在 `apps/cli/tests/profiles/acp/cordis.yml` 上报 `root must be a Loader entry array`；该文件是指向 `snapshots/acp/escalation-approved/cordis.yml` 的 symlink。用 `git stash` 把我的 base 改动摘掉后**同样报这条**，故属本 checkout 既有问题（疑与 task28 记录的 Windows 快照通道限制同源），不在本任务范围内。
