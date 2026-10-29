---
description: "uitstalie 包组：分支自有的能力与插件——指令来源、.dsh 存储、多协议 LLM 适配器与目录、memory、personality，以及它们的 Web 挂载面——供浏览本组的读者阅读。"
kind: "package-group"
---

# uitstalie/ — 分支自有能力家族

[English](README.md) | 中文

## 概述

`uitstalie` 是本分支自有的包组：本分支在上游 harness 之上新增的能力与插件，而不是上游产品包。宿主侧提供常驻指令来源、`.dsh` 存储服务及其模型工具、自有的多协议 LLM 适配器与 models.dev 目录，以及把 memory 与 personality 接到 root agent（智能体）上的组织者。浏览器侧新增 common-view overlay 框架、models.dev 设置页与侧栏 rules 面板。每个包 README 负责各自的包级约定；设计记录放在 [goal/](../../goal/)。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

每行给出包的贡献，以及它挂接的 `ctx` 键或界面。

| 包 | 职责 | ctx 键或挂载面 |
|---|---|---|
| [`agent-instructions-plus`](agent-instructions-plus/README.zh.md) | 把注册的常驻上下文来源（首先是 `.dsh/rules`）追加到原生指令基线 | `ctx.agentContextSources` |
| [`common-view`](common-view/README.zh.md) | overlay 框架：一次接管一个原生 Web 视图，贡献 slot、主题 token 与元素级自定义属性 | 客户端 slot 与主题 token |
| [`dafeiyu`](dafeiyu/README.zh.md) | 能力组织者：注册表、启用门、按 agent（智能体）接线、轮次分发与失败隔离 | `ctx.dafeiyu` |
| [`home-backup`](home-backup/README.zh.md) | 把 sessions、storages 与 profile 配置定时快照到 `$DSH_HOME` 之外，并保留有限份数 | 宿主定时器；不注册 `ctx` 键 |
| [`llm-plus`](llm-plus/README.zh.md) | 自有的多协议 LLM 适配器，带 OAuth 登录流与热更新的路由 | 注册到 `ctx.llm` |
| [`memory`](memory/README.zh.md) | 记忆能力提供者：固定提示词段、快照、轮次摘要任务、`memory_*` 工具与 `/memory` 维护命令 | 注册到 `ctx.dafeiyu` |
| [`models-dev`](models-dev/README.zh.md) | models.dev 目录服务：启动拉取、磁盘缓存回落、路由默认值与额外请求参数 | `ctx.modelsDev` |
| [`personality`](personality/README.zh.md) | 人格能力提供者：全局档案加工作区覆盖、`personality_learn` 与 `/personality` 审阅 | 注册到 `ctx.dafeiyu` |
| [`persona-card`](persona-card/README.zh.md) | 角色扮演角色卡格式：纯 `persona/v1` 校验/渲染器、安全的 Character Card V2/V3 JSON 导入器，以及带 `/persona` 选择、卡目录 watcher、persona 状态与 depth-0 `/director` 导演注的 per-session provider（不是部署 persona 预设） | 注册到 `ctx.dafeiyu` |
| [`store-atom`](store-atom/README.zh.md) | `.dsh` 存储原子：`dshStore` 基础接口，含项目根发现、路径围栏、命名空间撰写校验、工作区规则发现与带版本守卫的读写 | `ctx.dshStore` |
| [`system-environment`](system-environment/README.zh.md) | 宿主环境原子：平台事实、路径拼写与比较、环境变量查找，以及用户 home 与 Harness home | `ctx.systemEnvironment` |
| [`token-calculator`](token-calculator/README.zh.md) | 离线 DeepSeek V4 token 计算器：内置 byte-level BPE 分词器、受能力门控制的 `count_tokens` 工具，以及用于提示词预算的 `/tokens` 命令 | 注册到 `ctx.dafeiyu` |
| [`tool-dsh-store`](tool-dsh-store/README.zh.md) | 面向模型的存储工具，以及基于存储原子的只读 rules Remote | `ctx.dshStore` 消费方 |
| [`ui-dafeiyu`](ui-dafeiyu/README.zh.md) | 能力设置段：列出组织者的 provider、切换其启用门，并链接到每个 provider 的设置页 | 设置页段落 |
| [`ui-memory`](ui-memory/README.zh.md) | memory 设置段：编辑 provider 的 volatile 窗口、保留会话数、预算与摘要模型字段 | 设置页段落 |
| [`ui-models-dev`](ui-models-dev/README.zh.md) | Web 设置页段落：浏览目录并把选中的提供商物化为 `llm-plus` 路由 | 设置页段落 |
| [`ui-tool-dsh-store`](ui-tool-dsh-store/README.zh.md) | Web 侧栏按钮：列出并读取工作区的 `.dsh/rules` | 工作区行菜单 |

-----

<a id="related-documentation"></a>
## 相关文档

- [记忆层设计](../../goal/memory.md)——`dsh-memory` 背后的遗忘窗口、`.dsh/memory` 存储、摘要分层与工具面。
- [角色扮演 persona 卡设计](../../goal/persona.md)——助手侧卡格式、CCv2/V3 安全导入与部署 persona 的边界。
- [人格层设计](../../goal/personality.md)——`dsh-personality` 背后的全局档案、工作区覆盖、学习信号与漂移审阅。
- [能力组织者设计](../../goal/dafeiyu.md)——`dafeiyu` 为其 provider 定义的注册表、启用门与接线约定。
- [规则与指令来源](../../goal/rules.md)——`.dsh/rules` 如何经指令 seam 进入模型。
- [.dsh 目录插件设计](../../goal/dsh-dir-plugin.md)——`dsh-tool-dsh-store` 背后的存储接口、命名空间校验与模型工具。
- [LLM 流式子系统](../../docs/subsystems/llm-streaming.zh.md)——`llm-plus` 实现的、`models-dev` 为其解析路由的消息、请求与流式分片约定。
- [系统提示词子系统](../../docs/subsystems/system-prompt.zh.md)——`agent-instructions-plus`、`memory` 与 `personality` 贡献的段与来源装配。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本组只由分支补丁层挂载（`packages/bundle/base/cordis.patch.uitstalie.yml` 与 `packages/bundle/web-app/cordis.patch.uitstalie.yml`）。这些包不发布，因此其 API 不承诺上游兼容性。

</details>
