# task30 — 清掉 ui-models-dev 的 oxlint 债

**变更自**：[task29](task29.md)（models.dev 设置页家规适配）的"未做（后续）"第一条；关联 [task17](task17.md)。
**类型**：已有 mission 的变更（新任务单，新 id）。
**分支自有文件改动**：本任务**不触碰任何原生文件**（无标记需求）。

## 需求

用户："oxlint 顺便处理了吧"——把 task29 记录的 25 处**先前就存在**的 oxlint 债清掉，让 `packages/uitstalie/ui-models-dev` 整包 lint 干净（否则它们会拦住今后对该包任何文件的提交）。

## 改动（纯机械，行为不变）

| 文件 | 处数 | 规则 → 处理 |
|---|---|---|
| `src/client/DraftForm.tsx` | 12 | `no-confusing-void-expression`（箭头简写返回 void 调用）→ 改成块体、单参块体补括号 |
| `src/client/OAuthPanel.tsx` | 4 | 同上 |
| `src/client/ProviderCard.tsx` | 1 | 同上 |
| `src/client/MyRoutes.tsx` | 1 | `no-unnecessary-condition`：`isEditing &&` 已把 `editing` 收窄为非空（TS 别名条件收窄）⇒ 删掉恒真的 `editing !== undefined` |
| `src/client/store.ts` | 5 | 4× `no-confusing-void-expression`：`return fail(...)` → `fail(...); return`；1× `no-unnecessary-condition`：轮询循环里 `this.polling` 被 `while` 条件收窄 ⇒ 改为经方法读取（`private isPolling()`），既消除虚假收窄，又保证等待期间 `stopCatalogPolling()` 仍被及时观察到（注释已写明这一点） |
| `src/client/index.ts` | 2 | `no-floating-promises`：fiber 清理回调是同步的，两个异步 disposer 显式 `void` 丢弃（注释写明原因） |

## 验证

`oxlint`（整包 **0 error**，此前 25）· `tsc -b` 两面 · `vitest packages/uitstalie`（19 文件 / 131 测试）· `pnpm run build` · 3081 复看页面行为未变。
