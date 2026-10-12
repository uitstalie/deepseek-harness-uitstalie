# task22 — 客户端 bundle 的"未解析裸导入"门禁

## requirement

task14 在真实浏览器里暴露过一个**漂移**：`@deepseek-ai/dsh-client-ui-tool-dsh-store` 的 bundle 里留下了 `require("zod")`，而 zod 既不是平台种子、也不是已物化模块、也没有包工厂，客户端模块表在 boot 时直接拒绝该行（`import failed: client-modules: require("zod") missed the module table`）。

根因是宿主包漏声明 zod（Typert 生成的 `lib/typert.remote-client.js` 需要它），tsdown 从生成物所在位置解析不到，就"当作外部依赖"留在 bundle 里。**关键在于：整条流水线只有一句警告，没有任何门禁失败**：

- `pnpm run build` 打印 `Module not found, treating it as an external dependency` 后以 **0** 退出；
- `pnpm run verify-client-packages` 通过（它检查的是请求/外部的**声明规则**，不检查"未声明的裸导入"）；
- `scripts/client-bundle-purity.spec.ts` 通过；
- 直到浏览器运行时模块表才拒绝。

后果是：一个只在**用户浏览器里**才会出现的启动横幅，且它会让整个插件行不激活。

## scope

1. 在客户端 bundle 的构建路径上把该警告升级为**错误**：产物里出现**非平台种子、非已声明 external** 的裸导入即失败，并指名包与模块。
   - 判据来源必须是"共享单一真源"：平台种子清单（`packages/client/web/src/platform.ts` 的 `PLATFORM_MODULES`）与各包 `dsh.client.external` 声明；
   - 已有的 `scripts/client-bundle-purity.spec.ts` 是合适的落点（或新增一个同级的 spec），两者择一但只保留一处实现。
2. 让失败信息能直接指导修复：指出是"声明缺失（devDependencies）"还是"应加入 external 请求"。
3. 覆盖本仓库当前的全部 client 包（含 `packages/uitstalie/*`），并补一个"故意留下未声明裸导入即失败"的负例测试（仓库规则：把可机械检查的不变量接入被执行的门禁，并证明每条变更过的验收路径会拒绝非法输入）。

## 关联

- 触发自 [task14](task14.md) 第八步；修复本身（给宿主包声明 zod）已完成并提交。
- 与 [task21](task21.md)（样式合规）互不阻塞。

## 交付记录（2026/10/12）

**做法**：在共享客户端 preset 的**动态浏览器面**（`clientConfig`）里新增一个 rolldown 插件 `dsh-client-bundle-externals`，以 **`resolveId` 的后置钩子**（`order: 'post'`）执行：对每个裸说明符，若它**不是**本包请求的模块表行，就用 bundler 自己的解析器问一次（`this.resolve(source, importer, { skipSelf: true })`）——解析不出结果即**抛错**，错误信息给出包名、模块名、导入方路径与两条修法（devDependencies 内联 / 声明 exact external 请求）。

判据来自**唯一真源**：`isRequested()` 就是 preset 已有的 `clientExternals(id)`（= `PLATFORM_MODULES` + `PRELOADED_CLIENT_EXTERNALS` + 本包 `dsh.client.external`），与 `deps.alwaysBundle` 同源，不新增第二份清单。

**为什么不是"把 rolldown 的 `UNRESOLVED_IMPORT` 警告升级为错误"**（先试过，弃用，两条实测证据）：

1. **日志级别依赖**：实测 rolldown 只在 `logLevel` 阈值之上把日志投递给插件的 `onLog`。`logLevel: 'silent'`（本仓的脚本与规格大量使用）下**一条日志都不投递**，门禁随之静默失效——把不变量交给"日志开关"违背仓库"把可机械检查的不变量接入被执行的门禁"。
2. **误报**：`scripts/browser-bundled-externals.ts` 的许可证分析构建**故意**把可解析的工作区包标成 external（实测 `dsh-api-gateway` 的 client 构建里 `@deepseek-ai/dsh-typert-protocol` 就是 external），"产物里任何非请求裸导入即失败"的判据会直接打断 `gen-third-party-notices`（pre-commit 钩子）。

改为"解析不出才失败"后：可解析而被别的插件（如许可证 recorder）标成 external 的情况放行，而**真正解析不到的**（task14 的 `require("zod")` 那一类）在**任何日志级别下**都失败。

**只加在动态面**：静态链接面（`staticLinked`）按契约 1 让**每个**裸说明符都保持 external，由 `apps/web` 的 Vite 构建解析——那里解析失败是**可见的构建失败**，不是浏览器里的一条警告，因此不需要（也不能）加这条门禁。

**原生改动登记**（本次原生改动，按分支规则带标记）：

| 文件 | 位置 | 改动 | 标记 |
|---|---|---|---|
| `packages/client/tsdown.client.ts` | `clientConfig` 之前新增工厂 `clientExternalsGate`；`clientConfig` 的 `plugins` 数组里紧接 `dsh-client-bundle-purity` 之后调用它 | 新增解析式产物门禁（后置 `resolveId`） | `// BEGIN/END uitstalie-k3, 2026/10/12, task22, …` |
| `scripts/client-bundle-purity.spec.ts` | `client bundle experimental input isolation` 之前 | 新增 `client bundle externals gate` 规格块（5 个测试） | 同上 |

**验证**：

| 检查 | 结果 |
|---|---|
| `vitest run scripts/client-bundle-purity.spec.ts` | ✓ **47 测试**（新增 5：负例点名包与模块、**`logLevel: 'silent'` 下同样失败**、正例声明 external 照常放行、全量 roster） |
| 全量 roster（规格内实测） | ✓ **78 个动态浏览器配置**全部带该插件；5 个静态链接包按设计跳过；分支三个包（`dsh-client-common-view`、`dsh-client-ui-models-dev`、`dsh-client-ui-tool-dsh-store`）在册 |
| 误报对照 | ✓ `pnpm run build` 363 artifact 全过（无一处误报）；`tsx scripts/gen-third-party-notices.ts` ✓——即"可解析但被 recorder 标 external"的分析构建不受影响 |
| 修复指引 | 错误文本同时点名 `devDependencies` 与 `dsh.client.external`，规格里有断言钉住 |
| 其他 | `run-oxlint` ✓ 0 warning / 0 error |

**仍未覆盖（如需请另立任务）**：本门禁只认动态面的产物；若某包**手写** tsdown 配置而不用 `clientBundle`，它不会经过该 preset（`verify-client-packages` 只要求"声明 `dsh.client` 或使用 staticLinked"二选一，不校验是否走共享 preset）。
