---
description: "memory 能力的浏览器面：一个设置页，编辑 memory 行的 volatile 窗口、预算与摘要模型字段。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-memory

[English](README.md) | 中文

## 摘要

`dsh-client-ui-memory` 是 memory provider 的设置页。它编辑 `memory` 行的 volatile 字段——detail、brief、forget 的轮次年龄，`MEMORY.md` 保留的会话数，正文预算，以及摘要 provider 与模型——并把改动作为一次带修订号的变更保存。它不持有记忆数据，也不注册工具：宿主 provider 在下次写入或摘要时应用保存的值。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>

## 使用本包

在与 `memory` provider 相同的 web-app 层挂载本行。页面随后出现在设置中的 Memory 段，能力列表里的 Memory 链接经 provider 的 `settings.sectionId` 打开它。

```yaml
- id: ui-memory
  name: '@deepseek-ai/dsh-client-ui-memory'
```

清空字段会清除 profile 覆盖值并回落到 schema 默认值；数字字段不是正整数时保存按钮保持禁用。

<a id="understand-the-implementation"></a>

## 理解实现

`src/client/index.ts` 注册 `settings.memory` 文案字典，并以 order 190 贡献设置段。它从可选的 `configForms` 服务读取 `memory` 行的共享配置表单，因此没有设置服务的组合会显示不可用提示，而不是可点击但无效的控件。

`src/client/settings.ts` 从已接受快照生成文本草稿，标出无法解析的数字字段，并只经一次 `mutate` 调用、以快照修订号为栅栏写入发生变化的字段。`src/client/MemorySection.tsx` 只负责展示：渲染字段、就地校验以及保存与放弃操作，所有文案来自字典。

<a id="model-experience"></a>

## 模型体验

无：本页只编辑 memory 行的 volatile 字段，不贡献任何 prompt 文本、工具 schema 或记忆写入；其余全部属于 provider。

#### KV Cache 影响

无；本包既不组装也不发送 provider 请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **不编辑记忆内容** —— 本页只编辑 provider 配置；`MEMORY.md` 条目由工具与摘要任务写入。
- **表单依赖设置服务** —— 组合未挂载 `configForms` 时，本段显示不可用提示且不提供控件。
