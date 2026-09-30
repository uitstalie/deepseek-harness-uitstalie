# task17 — 把 models-dev / ui-models-dev 的挂载迁到仓库组合层

## requirement

用户判定（2026/09/30）：task16 采用的"**组合层小改 + 原生代码不动**"本来就是应有做法，因此 **models-dev 也该这样**——目前 `@deepseek-ai/dsh-models-dev` 与 `@deepseek-ai/dsh-client-ui-models-dev` 只存在于**本机 profile patch**（`~/.dsh/profiles/web/cordis.patch.yml` 的 `insert` 块），仓库内没有任何组合层声明，等于这两个分支自有插件**没有被分支本身声明**：换台机器、换 profile 就丢失，插件管理页里看到的也只是本地状态。

变更自 [task8](task8.md)（models.dev 设置页）与 [task9](task9.md)（llm-plus 灰度替换）——那两个任务单当时的规则是"分支自有包经用户层挂载，不入原生 bundle"，本任务单在用户放宽原生改动后**取代**该做法。

## 要做的事

1. 在仓库组合层为两个包补上声明行（带 `uitstalie-` 标记、最小块）：
   - `@deepseek-ai/dsh-models-dev`（host 服务，profile 级——目录服务与设置页是全局的，不需要按 agent 挂）；
   - `@deepseek-ai/dsh-client-ui-models-dev`（client 行，紧随设置页相关 client 行）。
   - 落点候选：`packages/bundle/web-app/cordis.patch.yml`（profile 级）。若判定需要 per-agent 作用域，则改落三个 preset（与 skill-filesystem 同侧）。
2. **移除 profile patch 里的对应 `insert` 行**，避免同 id 重复挂载（profile patch 是用户层文件，不入仓库）。
3. 复核 `llm-plus` 是否也存在同类问题：它在 `packages/bundle/base/cordis.patch.yml` 有标记行（已入仓库），但**路由配置**只在本机 profile patch 的 `- id: llm-plus / config.routes` 里——若该配置属于"部署级选择"，按仓库规则应落在仓库组合层；若属于"本机凭据/偏好"，留在 profile patch 并在此登记说明。

## 修改范围

- 原生文件：`packages/bundle/web-app/cordis.patch.yml`（新增行，`uitstalie-` 标记）；视第 1 步结论可能还有 base bundle 或 preset 文件。
- 用户层：`~/.dsh/profiles/web/cordis.patch.yml` 删除对应 insert 行（不入仓库）。
- 分支自有：本任务单。
- 依赖：需要先把 task16 的 plus 插件挂上（同一批 composition 改动一起验证）。

## 验证

- 清空/换一个 profile 后，仅靠仓库组合层能让 models-dev 与设置页生效（证明"分支自带声明"成立）。
- 插件管理页能看到这两个行，且无重复 id 冲突。
- Web 里设置页正常展示目录、路由与 OAuth 面板；llm-plus 的路由仍可用。
- `pnpm run verify-cordis-config` 与 `pnpm run doc-sync` 相关门禁通过。

## 待办与风险

- **先修分类缺口**：`pnpm run gen-cordis-api` 当前失败，原因是 task8 引入的 `models-dev/updated` 事件（`packages/uitstalie/models-dev/src/index.ts:97`）引用了未分类类型 `CatalogProvenance` 与 `ModelsDevCatalog`，生成器要求把它们放进 `linkedTypePages`（并给出文档页）、`foundationTypeNames` 或 `typeLinkExemptions`。该缺口同时阻塞 task14 的 `api-catalog.ts` 重建，因此先修它。
- 待确认落点：profile 级（web-app bundle）还是 per-agent（preset）。我的判断是 profile 级——目录服务与设置页是全局的。
- 风险：若上游在同一位置新增行，标记块可能冲突；按既有规程逐处对照解决。
- 风险：**顺序**上不要与 task16 的 preset 改动混在一个提交里——两个任务的标记块各自独立，便于单独回退。
