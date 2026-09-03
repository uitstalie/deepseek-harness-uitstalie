# task8 — models.dev 目录设置页：勾选提供商 → 物化为自有 provider

## requirement

给 models-dev 增加单独的设置页面：页面展示目录拉下来的全部可用提供商列表，用户勾选一个或几个，逐provider自定义配置（凭据引用/端点/协议/extraParams/模型子集），确认后形成自己的 provider（模型选择器立即可用）。

## 架构决策（已与用户确认）

1. **接原生 custom-provider 缝**：llm-plus 实现 `registerConfigurableProviders`（每路由一条 `{provider, displayName, settingsNs: 'llm-plus', settingsPath: ['routes', routeId]}`）+ `registerModelDiscovery`，per-provider 编辑用原生 Models 设置页的编辑器（参照 llm-deepseek 单路由与 llm-pi-ai 目录两条既有路径）。
2. **落点（Q2 歧义的解答）**：**llm-plus 是路由的唯一拥有者（单写者）**。models-dev 设置页只是"目录 → 路由"的**物化器**——勾选确认时把成品路由写进 llm-plus 命名空间用户层，写完即脱钩；`modelsDevProvider` 字段保留目录链接（模型元数据/能力/价格继续从目录读）。不产生第二个事实来源，llm-plus 对本 feature 零感知。
3. **v1 自定义字段**：apiKeyRef（默认目录 env[0]）、baseURL（默认目录 api，含 ${ENV_VAR} 插值处理）、protocol（默认 npm 方言映射，可手改四协议）、extraParams（headers/body）、模型子集（默认全量；选子集则物化为 route.models 手工表）。
4. **目录查询面**：models-dev 增加 @Remote 方法（listCatalogProviders/listCatalogModels），client 经 connection RPC 读取；写路由复用 settings 的既有 client 读写机制（同 ui-settings-models）。

## 修改范围

- 新增分支自有文件：
  - 本任务单 `goal/mission/task8.md`
  - 新 client 包 `packages/uitstalie/ui-models-dev/`（`@deepseek-ai/dsh-client-ui-models-dev`）
- 修改分支自有文件：
  - `packages/uitstalie/llm-plus/`：结构化 route schema（原生编辑器字段渲染）、每路由目录条目注册（随 settings 热更新原子替换）、模型发现 handler
  - `packages/uitstalie/models-dev/`：@Remote 目录查询面
- 用户态（非 repo）：
  - `C:\Users\ts\.dsh\profiles\web\cordis.patch.yml`：insert client 行（dsh.client 条目经用户层树解析，link: 依赖已就位）

## 原生文件修改登记

- `tsconfig.client.json`：Client 聚合 references 追加 `./packages/uitstalie/ui-models-dev`（带 `uitstalie-k3` 标记注释）。
- `tsconfig.base.json`：新包别名（生成区由 gen-tsconfig-paths 写入，rebase 后重跑生成器恢复）。
- `pnpm-lock.yaml`：`pnpm install` 自动生成。

## 验证

- host 侧单测：models-dev Remote 查询面、llm-plus 目录条目注册/热更新替换/发现 handler、settings 用户层热更新（真实 settings-file 组合，20/20 绿）。
- 浏览器手验：设置页出现 models.dev 段、目录列表渲染、勾选物化路由、原生 Models 页可继续编辑该路由、模型选择器出现新 provider、真实对话通。

## 验收中修掉的三个实现 bug（2026/08/31 晚）

1. **setSource 冻结**：llm-plus apply 把 installSettingsSection 给的 thunk 在挂接点求值（`source = current()`），用户层变更永远读旧值——页面上添加的路由全部不生效。修复对齐 llm-deepseek：存 thunk、onChange 里现取。教训：这类"接线语义"必须有真实 settings-file 组合的热更新测试（已补）。
2. **client 包漏 inject 声明**：浏览器 apply 访问 `ctx.remote/ctx.locale/ctx.slots` 未声明 inject，cordis 守卫拒绝（"cannot get property without inject"）。修复：模块级声明 + `remote.modelsDev` 走 $mount 后的内层 ctx.inject（agent-team 模式，防自供死锁）。
3. **zod 未声明**：生成的 typert.remote-client 运行时需要 zod，ui-models-dev 未声明 dependencies → bundle 外部化 → 浏览器模块表无法满足。修复：zod 进 dependencies（私有内联）。

## 环境事故（排查插曲）

`tsc -b` 事故在 5 个包的 src/ 下留下陈旧 .js/.d.ts 残留（packages/core/session、credentials/credentials、settings/settings、typert/protocol、uitstalie/llm-plus，共 76 个无跟踪文件）——vite 目录解析优先 index.js，vitest 因此加载陈旧产物而非最新 src，造成"探针（tsx 读 src）正常、vitest（误读残留）失败"的假象。已全部删除。教训：vitest 行为与 src 不符时，先查 src/ 下是否有同名 .js 残留。
