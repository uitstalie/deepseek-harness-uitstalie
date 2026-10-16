# task27 — 给分支自有插件补显示元信息

## requirement

用户要求（2026/10/12）：侧边栏**插件**工作区现在把「官方/按需插件」与「内置插件」分成两类，我们做的插件都属于**内置插件**，需要**补上它们自己的显示信息**（标题、描述），让它们在「设置 → 内置插件」清单与插件页里不再显示成裸包名。

## 机制（上游 0.2.1 起，证据在源码）

- 解析器：[`packages/boot/app-boot/src/package-meta.ts`](../../packages/boot/app-boot/src/package-meta.ts) 的 `readPluginMeta()`——**不激活插件**，只读导出资源。
- 文本：`<包名>/locale/en.json` 必须作为发现基线导出；同目录其它 `<语言>.json`（本任务加 `zh.json`）按语言 id 收录；每个文件的 `meta.title` / `meta.description` 必须是非空字符串。
- 回退链：标题 `meta.title` → 包根插件的 `package.json.name` → 完整 Cordis 插件名；描述 `meta.description` → `package.json.description` → 无描述。
- 作者格式：[cookbook §5](../../docs/cookbook/adding-a-package.md)（`exports` 增 `"./locale/*.json"`，`files` 增 `locale/*.json`）。
- 机械校验：`scripts/verify-package-meta.ts`（导出必须解析到源码 JSON、各语言文件必须与 `en.json` 同目录、必须被 `files` 覆盖、字段非法即报错）。

## 本次改动（全部为分支自有文件，无原生改动）

7 个包各加 `locale/en.json` + `locale/zh.json`，并在各自 `package.json` 的 `exports` 增 `"./locale/*.json": "./locale/*.json"`、`files` 增 `"locale/*.json"`：

| 包 | 标题（en / zh） | 描述要点 |
|---|---|---|
| `llm-plus` | LLM Plus providers / LLM Plus 提供商 | 把模型请求路由到已配置的提供商（含订阅登录、目录默认值） |
| `models-dev` | models.dev catalog / models.dev 目录 | 拉取并缓存目录，向设置页提供提供商与模型默认值 |
| `agent-instructions-plus` | Workspace instructions / 工作区指令 | 原生 AGENTS.md/CLAUDE.md 链 + 常开 `.dsh/rules`，同一条消息 |
| `tool-dsh-store` | .dsh store files / .dsh 存储文件 | 在工作区 `.dsh` 内创建/查看/删除文件与目录 |
| `ui-models-dev` | Models.dev catalog page / 模型目录页 | 浏览提供商、勾选子集、物化为 LLM Plus 路由 |
| `ui-tool-dsh-store` | Workspace rules view / 工作区规则视图 | 侧边栏按工作区展示注入的 `.dsh` 规则 |
| `common-view` | Common view overlay / 通用视图 overlay | 逐次接管一个原生视图，用 slot 与 token 提供 overlay |

**未做**：~~图标（manifest `icon` 或 `./icon` 导出）~~ **已完成**（2026/10/12，用户选定"7 个元信息包全补"）：见 [task38](task38.md) B 段——7 个包各加自绘 `icon.svg`，manifest 增 `icon`、`./icon` 导出与 `files` 条目，真实解析器实测 7/7 解析成功。

## 验证

| 检查 | 结果 |
|---|---|
| `tsx scripts/verify-package-meta.ts` | ✓ 通过（导出解析到源码 JSON、各语言文件与 `en.json` 同目录、`files` 覆盖、字段合法；该门禁内部会对每个声明了 locale 资源的包调用 `readPluginMeta`，无 `error` 输出） |
| 解析实测（临时探针，用真实解析器 `readPluginMeta`） | ✓ 7 个包的 `title` / `description` **中英双语全部解析成功、`error: none`**（探针用完即删） |
| `tsx scripts/verify-package-dependencies.ts` | ✓ 77 包符合依赖策略 |
| `tsx scripts/verify-client-packages.ts` | ✓ 63 client 包（58 动态 / 5 静态链接）模块请求规则不变 |
| `pnpm run test:docs` | ✓ 21 条门禁全绿 |
| `tsc -b tsconfig.client.json tsconfig.host.json` | ✓ 两面干净 |

**效果**：下次启动/刷新 Web GUI 后，「设置 → 内置插件」清单与插件页里，我们这 7 个插件会按界面语言显示上述标题与描述，而不是裸包名。