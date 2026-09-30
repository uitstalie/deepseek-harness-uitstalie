# task20 — 补齐五个分支自有包的 README 对

## requirement

`pnpm run test:docs` 的两条门禁对 `packages/uitstalie/` 下的五个包**全部报缺**：

```
verify-package-readme-model-experience: packages/uitstalie/<pkg>/README.md: missing package README
verify-package-readme-limitations:      packages/uitstalie/<pkg>/README.md: package manifest has no sibling README with
                                        the `## Known Limitations and Deferred Work` section
```

涉及 `models-dev`、`llm-plus`、`ui-models-dev`、`agent-instructions-plus`、`tool-dsh-store`。仓库里 316 个包 README **全部是英中三件套**（`README.md` + `README.zh.md` + `README.i18n.yaml`），因此补齐意味着 15 个文件，而不是 5 个。

变更自 [task8](task8.md)（models-dev / llm-plus / ui-models-dev）、[task14](task14.md)（tool-dsh-store）、[task16](task16.md)（agent-instructions-plus）——三个任务单都只做了代码，没随包写 README。

## 模型体验的两种形态

门禁只认三种写法：结构化条目（H3 + 三个固定 H4）、**单句形态**（`None, as …` 或 `Indirectly, through …`，附带一个 `#### KV Cache effect`），或整段省略（需在门禁的 `NO_MODEL_EXPERIENCE_SECTION` 里带审计理由）。本任务单按各包的真实可见性选择：

| 包 | 形态 | 依据 |
|---|---|---|
| `agent-instructions-plus` | 结构化 | 它直接向请求注入指令上下文，模型确实看到内容 |
| `models-dev` | 单句（indirect） | 目录服务的取值经 LLM 消费方进入请求（路由、默认值、额外参数） |
| `llm-plus` | 单句（indirect） | 它向 `dsh-llm` 注册路由与请求字段，组装由消费方完成 |
| `ui-models-dev` | 单句（none） | 浏览器侧设置面；承载路由的 host 服务才拥有模型可见效果 |
| `tool-dsh-store` | 单句（none） | 当前只发布路径校验与存储操作，模型工具属于后续工作 |

## 修改范围

- 新增分支自有文件：五组 README 三件套（`packages/uitstalie/{models-dev,llm-plus,ui-models-dev,agent-instructions-plus,tool-dsh-store}/README.md`、`README.zh.md`、`README.i18n.yaml`）。
- 原生文件（一处最小插入块，逐行标记）：`scripts/verify-package-readme-model-experience.ts` 的 `SENTENCE_MODEL_EXPERIENCE` 表追加四行——该表本身就是这些单句结论的审计记录，所以登记必须落在那里。
- 本任务单。

## 验证

- `pnpm run test:docs`（或分别跑 `verify-package-readme-model-experience`、`verify-package-readme-limitations`、`verify-translation-pairing`）全绿。
- 每对用 `pnpm run verify-translation-pairing --write <README.md>` 记录，再跑一次 check 确认一致。
- `pnpm run build` 与聚焦 `vitest run packages/uitstalie` 不受影响。
