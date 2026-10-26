---
description: "jira 账本的独立 profile 组合包：在目标 profile 上插入 jira-service、jira-agent 与 jira-ui 三行，由 service 行打开账本、agent 行贡献模型面。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-jira-app

[English](README.md) | 中文

## 概述

`dsh-jira-app` 是 jira 账本的独立 profile 组合包。安装它会在目标 profile 上插入三行：`jira-service`（账本的唯一写入者）、`jira-agent`（带工具、`/jira`、skill、守卫与 turn 结束 settle 的 dafeiyu 能力）与 `jira-ui`（带账本状态、只读看板、issue 详情与知识搜索的 `jira` 设置页段落）。由本 checkout 构建的 `dsh --profile web` 已经挂载同样三行，因此安装本组合包是给其他 profile 用的。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>

## 使用本包

组合包在目标 profile 上插入账本行：`jira-service`（账本的唯一写入者）、`jira-agent`（带工具、`/jira`、skill、守卫与 turn 结束 settle 的 dafeiyu 能力）与 `ui-jira`（浏览器行：带账本状态、只读看板、issue 详情与知识搜索的 `jira` 设置页段落）。

`packages/bundle/web-app/cordis.patch.uitstalie.yml` 也挂载同样三行，因此由本 checkout 构建的 `dsh --profile web` 无需安装本组合包就带有账本。

安装了本组合包但未启用能力的 profile 仍保留服务（账本仍可通过 `ctx.jira` 读取），只失去模型面。

### 安装到 profile

```sh
pnpm dsh plugin add @deepseek-ai/dsh-jira-app
```

或者，对由目录组合的 profile：

```sh
pnpm dsh --profile web --patch packages/bundle/jira-app/cordis.patch.yml
```

行配置就是 `jira-service` 的 schema：`root`、`host`、`machine_id`、`remote`、`push.enabled`、`push.debounce_ms`。账本的词表不是配置——它在账本仓库的 `config.md` 里。

<a id="model-experience"></a>

## 模型体验

间接地，通过它插入的行：`jira-agent` 为每个 root agent 贡献三个常驻工具 schema 与 `[store] jira · …` 注入行，`jira-service` 决定模型做出的提交在 turn 的 settle 之后是否离开这台机器，而不是留在本地。

#### KV 缓存影响

组合包自身不添加任何请求文本；缓存行为属于每个被插入行所属的包。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **浏览器页只显示行配置，不写它。** `root`、`host` 与 `push.enabled` 在那里是只读的，直到 `jira-service` 的 schema 把它们声明为 `.volatile()`。
- **dafeiyu v1 没有 UI 元数据。** 能力以 `contractVersion: 1` 注册，因此组织者的列表只显示 id 与状态，没有 `label` 或 `settings.sectionId` 链接；描述符 v2 升级是约定的阶段 2 后续工作。
- **行列表与 patch 由 `tests/bundle.spec.ts` 对照。** 增加一行意味着同时更新两者，测试会在它们漂移时失败。

<a id="dev-note"></a>

### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
