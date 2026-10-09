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
