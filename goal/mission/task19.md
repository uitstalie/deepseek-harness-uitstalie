# task19 — 目录来源字段改名 provenance → origin

## requirement

`pnpm run test:docs` 的 `verify-concrete-terms` 门禁**禁止字面量 `provenance`**（仓库级规则："name the exact source, field, identity, or evidence"），只排除 `vendor/` 与 `.agents/notes/archived/`（历史格式与发布快照另有两条例外正则）。task8 引进的 models-dev 服务把该词用作**类型名与字段名**，因此本分支的代码、生成物与任务单都在违规。

改名方案：类型 `CatalogProvenance` → `CatalogOrigin`，实例字段/事件参数/局部变量 `provenance` → `origin`；取值 `'network' | 'cache' | 'none'` 与语义不变。

变更自 [task8](task8.md)（引入该类型）、[task18](task18.md)（把该类型登记进生成器豁免表）。

## 修改范围

- 分支自有代码：`packages/uitstalie/models-dev/src/index.ts`（类型、字段、事件参数、`adopt()` 形参、JSDoc 与注释）、`packages/uitstalie/models-dev/src/invariant.ts`（注释里的一处措辞）。
- 分支自有文档：`goal/mission/task14.md`、`task17.md`、`task18.md` 中对旧名的引用。
- 原生文件（新增行内的字符串，最小改动）：`scripts/gen-cordis-catalog.ts` 的 `TYPE_LINK_EXEMPTIONS` 条目键与说明文字。
- 生成物（重跑生成器）：`packages/extensions/tool-cordis/src/api-catalog.ts`、`docs/subsystems/llm-streaming.md` 与 `docs/subsystems/llm-streaming.zh.md`。

## 验证

- `pnpm run verify-concrete-terms` 通过（全仓库不再出现该字面量）。
- `pnpm run gen-cordis-api` 与 `pnpm run verify-cordis-api` 通过。
- `pnpm run verify-translation-pairing` 通过（生成区改动不破坏双语配对）。
- `pnpm exec vitest run packages/uitstalie`、`tsc -b tsconfig.host.json`、`pnpm run build`。
