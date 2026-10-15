# task31 — models.dev 设置页换共用件按钮 + 清掉 llm-plus 的 oxlint 债

**变更自**：[task29](task29.md)（设置页家规适配）与 [task30](task30.md)（先清 ui-models-dev 的 lint）列出的两条后续；关联 [task17](task17.md)。
**类型**：已有 mission 的变更（新任务单，新 id）。
**分支自有文件改动**：本任务**不触碰任何原生文件**（无标记需求）。

## 需求

用户："1，2，做了" ——
① models.dev 设置页里的裸 `<button>` 换成共用件 `Button`；
② 把其余分支包的 oxlint 债一并清掉。

## ① 设置页按钮换共用件

`ui-models-dev` 的 9 个裸按钮全部改为 `ui-primitives` 的 `Button`：

| 位置 | 之前 | 现在 |
|---|---|---|
| `ModelsDevSection.tsx` 主操作"添加 N 个提供商" | `.submitButton`（中性描边） | **`variant="primary"`**（该页的主操作，对应原生主按钮族） |
| `ModelsDevSection.tsx` 加载失败"重试" | `.submitButton` | `variant="outline"` |
| `OAuthPanel.tsx` 选项回答 / 提交回答 / 取消 / 开始登录 | `.submitButton` | `variant="outline"` |
| `MyRoutes.tsx` 保存 / 取消 / 编辑 / 删除 | `.submitButton` | `variant="outline"` |

- 共用件自带尺寸（`md` 36px / 12px 圆角，`sm` 28px / 8px 圆角）与 `--dsw-alias-button-*` token 族 ⇒ **观感与尺寸会变**（用户已知情），本包不再自造按钮皮肤：`.submitButton` / `.submitButton:disabled` 两条 CSS 已删除，`.submitBar`（右对齐容器）保留。
- 新增依赖：`@deepseek-ai/dsh-client-ui-primitives` 进 `devDependencies`（浏览器基线外部件，仅开发期关系）⇒ `pnpm install` 更新 lockfile。
- 规格：`tests/models-dev-section.client.spec.ts` 增加 1 例——三个文件都必须从共用件导入、**不得再出现 `<button`**、不得引用 `styles.submitButton`，且样式表里不得再有 `.submitButton`（当前 4 例全过）。

## ② 其余分支包的 oxlint 债

先扫全量：七个包里**只有 `llm-plus` 有债（39 处）**，其余六个本来就 0。逐条处理后 **39 → 0**：

| 文件 | 处数 | 处理 |
|---|---|---|
| `src/oauth/pkce-login.ts` | 5 | 3× 箭头简写改块体；`manualError` 的复查改为经 `lateFailure()` 读取（首次检查会把类型收窄成恒假，但 `await` 期间回调仍可能写入）⇒ 同时满足 `no-unnecessary-condition` 与 `only-throw-error` |
| `src/oauth/providers/openai-codex.ts` | 4 | `{ code?: unknown } \| unknown` 去掉冗余联合；`parsed?.` 系列可选链按 `parsed.error` 局部变量改写 |
| `src/oauth/providers/kimi-coding.ts` | 1 | `reject(signal.reason)`：非 Error 的中止理由包成 `new Error(...)` |
| `src/oauth/providers/openrouter.ts` | 2 | 箭头简写改块体 |
| `src/protocols/openai-responses.ts` | 1 | 可选链**保留** + 定点豁免（该规则未计入 `noUncheckedIndexedAccess` 的下标 `undefined`，实测 tsc 会报 TS18048） |
| `src/protocols/anthropic-messages.ts` | 2 | 去掉多余的 `as JsonValue[]`；switch 补 `default: { break }`（覆盖缺席的 event 名） |
| `src/protocols/gemini.ts` | 1 | 去掉多余的 `as JsonValue[]` |
| `src/config.ts` | 3 | 边界复查**保留** + 定点豁免：cordis.yml 是解析边界，schema 之后仍按运行时形状复查以报出带路由名的精确错误 |
| `src/adapter.ts` | 4 | `resolved?.value.trim()`（`value` 在类型上是必填）；去掉 `effort.id as string`；箭头简写改块体 |
| `src/remote.ts` | 3 | `beginFlow` 去掉 `async` 并显式 `Promise.resolve(...)`（无 await）；去掉多余的 `as AuthorizationService \| undefined`（顺带删掉该未用导入）；`notify` 改块体 |
| `src/index.ts` | 1 | `warn` 箭头简写改块体 |
| `tests/llm-plus.spec.ts` | 13 | `String(input)`/`String(body)` 改为按类型分支（不再对对象做 base-to-string）；`String(ref)` 去掉；5× `route as never` 与 2× 对象 `as never` 去掉；2× `await registry.delete(...)` **保留** + 定点豁免（实测它就是 thenable：删 await 会让两个"随 fiber 摘除"的用例失败） |

**定点豁免共 6 处**（`oxlint-disable-next-line` + 逐处理由），其余全是真实修正；没有全局关闭任何规则。

## 验证

- `oxlint`：**七个分支包全部 0 warning / 0 error**（`llm-plus` 此前 39）。
- `tsc -b tsconfig.client.json tsconfig.host.json` ✓。
- `vitest packages/uitstalie`：19 文件 / **132 测试** ✓（含 llm-plus 26、ui-models-dev 4）。
- `verify-client-ui-i18n` ✓ 1044 文件。
- `pnpm run build` ✓ 363 client artifact；3081 复看页面（按钮外观改为共用件族，行为不变）。

## 备注

- `noUncheckedIndexedAccess` 下的数组下标访问与 cordis.yml 边界复查这两类，oxlint 会误报 ⇒ 今后遇到同类，按本任务的方式**保留代码 + 定点豁免 + 写清理由**，不要为了过规则削弱运行时检查。
