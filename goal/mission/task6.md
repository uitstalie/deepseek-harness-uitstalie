# task6 — pi-ai-plus：自有多协议 LLM 适配器

## requirement

合并重构方向：不做"裁剪 pi-ai"，而是新增一个增强版多协议 LLM 适配器插件（pi-ai-plus），最终目标替换 llm-pi-ai。

- v1 实现三种 wire 协议：`openai-completions`、`anthropic-messages`、`gemini` 原生；
- 与 llm-pi-ai 并存开发，灰度迁移，最终替换（replay 签名回带、OAuth 是替换前必须补齐的能力，v1 不做）；
- 认证 v1 只做 api-key；
- 目录与协议提示接 dsh-models-dev（npm/shape/reasoning_options/interleaved），额外 headers/body 因 adapter 自有而**原生注入**，不再需要 deepseek-llm-api-extensions 绕道；
- 删除 pi-ai 中间层后，compat 门禁、按 URL 猜测、23 字段配置面全部不需要。

## 修改范围

- 新增分支自有文件：
  - 本任务单 `goal/mission/task6.md`
  - 新包 `packages/uitstalie/llm-plus/`
  - 设计文档 `goal/llm-plus-design.md`

## 原生文件修改登记

- `tsconfig.base.json`：新包别名（生成区由 gen-tsconfig-paths 写入，rebase 后重跑生成器恢复）。
- `tsconfig.host.json`：Host 聚合 references 末尾追加 `./packages/uitstalie/models-dev` 与 `./packages/uitstalie/llm-plus`（带 `uitstalie-k3` 标记注释）。
- `pnpm-lock.yaml`：`pnpm install` 自动生成（rebase 冲突时接受上游后重跑 install）。
