# task5 — models.dev 目录同步插件

## requirement

新增一个通用 models.dev 目录服务插件（第一个定制落地）：

- 启动时拉取 models.dev `api.json`（可配置源），磁盘缓存 + TTL，失败用缓存兜底（对齐 opencode 机制）；
- 提供 provider 无关的模型目录查询（默认信息：context/output 上限、cost、modalities、reasoning_options、interleaved 等）；
- 提供额外 params 的写入位置：用户可为 provider/model 配置额外 headers/body，插件挂 `llm/stream` waterfall 在请求发出前注入（同时支持 models.dev `experimental.modes` 数据）；
- 评估并记录：落地后哪些相关插件（llm-pi-ai 的静态目录等）可以退役。

设计决策（与用户确认）：通用目录服务（非仅 deepseek）；额外 params 由本插件拦 `llm/stream` waterfall 注入；启动拉取 + 磁盘缓存 TTL。

## 修改范围

- 新增分支自有文件：
  - 本任务单 `goal/mission/task5.md`
  - 新包 `packages/uitstalie/models-dev/`（`packages/*/*` glob 自动纳入 workspace，无需改 pnpm-workspace.yaml）
  - 设计/使用文档 `goal/models-dev-plugin.md`

## 原生文件修改登记

- `tsconfig.base.json`：
  1. 手写区新增子路径别名 `@deepseek-ai/dsh-models-dev/deepseek-extra-params`（带 `uitstalie-k3` 标记注释，生成器只管根与 invariant 别名，子路径必须手写）。
  2. 生成区新增 `@deepseek-ai/dsh-models-dev` 根与 `/invariant` 别名——由 `pnpm run gen-tsconfig-paths` 生成器写入，rebase 后重跑生成器即可恢复，无标记注释（生成区不保留手写内容）。
- `pnpm-lock.yaml`：新 workspace 包的链接条目（`pnpm install` 自动生成，JSON 无法内嵌标记；rebase 冲突时接受上游后重跑 `pnpm install` 即恢复）。
