# task4 — 模型提供方插件的数据来源调查

## requirement

第一个定制前的摸底：检查模型提供方（model provider）相关插件——模型目录/模型列表的数据来源是网络获取（API 拉取）还是代码写死（hardcoded）。覆盖 `llm-deepseek`、`llm-llm-pi-ai` 的模型发现路径，以及上游 `dsh-llm` 的模型目录契约与 UI（`ui-model-selection`、`ui-settings-models`）消费方式。产出调查结论文档，作为后续定制的依据。

## 修改范围

- 纯研究与文档任务：不修改任何原生文件。
- 新增分支自有文件：
  - 本任务单 `goal/mission/task4.md`
  - 调查结论 `goal/model-provider-data-source.md`

## 原生文件修改登记

无（本任务不涉及原生文件修改或删除）。
