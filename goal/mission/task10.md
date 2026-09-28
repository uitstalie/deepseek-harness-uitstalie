# task10 — 跟进 2026/09/28 上游 rebase 的文档与登记修正

## requirement

rebase 到上游 master（`21638c5631`）后，goal/ 下多处描述与代码对不上：上游 #4587 把 settings 模型从 `dsh-settings-file` + `installSection` 换成 profile 条目 + volatile Config，工具结果从内容块改为 `role:'tool'` 消息，`readImageRequest` 改为显式 target。修正这些文档，并登记 rebase 期间原生文件的适配点。

变更自：task5（models-dev 设计文档）、task8（models.dev 设置页）、task9（llm-plus 灰度替换），以及一份无任务单的早期 settings 摸底。

## 修改范围

- 新增分支自有文件：本任务单 `goal/mission/task10.md`
- 修改分支自有文件：
  - `goal/llm-plus-design.md`：settings 接线段、协议数、图片段
  - `goal/model-provider-data-source.md`：settings.yaml/`installSettingsSection` 描述与行号
  - `goal/dsh-plugins.md`：`dsh-settings` 描述、`dsh-settings-file` 行
  - `goal/models-dev-plugin.md`：settings.yaml 措辞
  - `goal/mission/task8.md`：写入落点与测试夹具描述
  - `goal/mission/task9.md`：图片预算字段名

## 原生文件修改登记

无新增。rebase 期间两处原生适配**未动任何原生行**，仅按规则登记：

- `packages/uitstalie/ui-models-dev/tsconfig.json`：上游把 `locale` 与 `ui-settings` 拆成 client/host 叶配置后，本包的 `references` 改为指向各自的 `tsconfig.client.json`（JSON 不支持注释，登记于此）。
- `packages/bundle/base/package.json`：rebase 冲突解决时保留 `@deepseek-ai/dsh-llm-plus` 依赖行；行内容与上游格式一致，不带注释，登记于此。
- `packages/bundle/base/cordis.patch.yml`：task9 的灰度替换行在 rebase 后原样保留（`uitstalie-k3` 标记在位）。

## 验证

- `pnpm vitest run packages/uitstalie`（32 绿）
- `npx tsc -b tsconfig.host.json`（干净）
- 文档只改描述，不改行为
