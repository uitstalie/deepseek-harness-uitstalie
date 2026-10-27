---
description: "identity 提案队列的浏览器面：一个设置段，列出排队的 identity 提案及其证据，并通过 remote.personality 接受或拒绝。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-personality

[English](README.md) | 中文

## 摘要

`dsh-client-ui-personality` 是 personality provider 的设置页。它列出模型或人排入 `PERSONALITY.proposals.jsonl` 的 identity 提案，显示每条的名字、正文、证据、入队时间与状态，并接受或拒绝待处理的提案。它不拥有档案数据，也不拥有提案存储：读取与决定都走 `remote.personality` 命名空间，host 侧把接受后的 identity 条目经与 `/personality accept` 命令相同的版本守卫写入；拒绝只记录状态。它也会通过共享配置表单编辑该行的 volatile 字段。

## 目录

- [使用这个包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与未决工作](#known-limitations-and-deferred-work)
- [开发者注记](#dev-note)


## 使用这个包

<a id="use-this-package"></a>

在挂载 `personality` provider 的同一层 web-app 组合里挂一行。设置里就出现「人格」段，能力总代理里的 Personality 链接会通过 provider 的 `settings.sectionId` 打开它。

```yaml
- id: ui-personality
  name: '@deepseek-ai/dsh-client-ui-personality'
```

接受会把 identity 条目写入全局 `PERSONALITY.md`，提案变为 `accepted`；拒绝记录 `rejected`，档案不变。同样的决定也有 `/personality proposals`、`/personality accept <id>`、`/personality reject <id>` 三种命令，headless 会话不需要这个页面。队列上方的 Provider 设置块编辑该行的字段；保存的值在 provider 的下一次工具调用、学习判定或历史写入时生效。


## 理解实现

<a id="understand-the-implementation"></a>

`src/client/index.ts` 在载体尚未提供命名空间时挂载生成的 `remote.personality`，注册 `settings.personality` 文案字典，并以 order 210（在能力总代与 Jira 页之后）注册设置段。它解包每个 `RemoteResult` 并抛出 host 失败，让页面显示就地提示；它不会自行重试决定。src/client/settings-form.ts 暂存该行的数字与开关字段，并只把发生变化的字段作为一次带修订号的变更写入。

`src/client/PersonalitySection.tsx` 只负责呈现：挂载时读一次队列，pending 在前，显示状态徽标与证据行；决定后用 host 返回值替换该行，并在请求进行中禁用该行按钮。所有文案来自 `settings.personality` 字典。

host 侧在 `@deepseek-ai/dsh-personality`：`src/proposals.ts` 拥有 JSONL 队列与版本守卫写入，`src/remote.ts` 通过 `remote.personality` 暴露 `list`、`accept`、`reject`。设置页的决定在档案历史里记录会话 `settings-ui`；接受仍会走 `confirmIdentity`，其它路径打不开这个口。


## 模型体验

<a id="model-experience"></a>

### 无模型面

#### 模型看到什么

什么都没有。这个页面是设置面；它只贡献 `settings.personality` 文案字典与读取的 `remote.personality` 队列，不注册工具、提示词段、上下文源或会话消息。填充队列的 `personality_propose` 工具属于 provider，经组织者到达 agent。

#### Token 影响

零。页面只改档案文件，而档案就是 provider 自己的提示词段；接受写入后，后续组装会看到新内容。

#### KV Cache 影响

没有直接影响。接受 identity 条目会改变 provider 的系统提示词段，因此下一次组装的缓存前缀从该段起变化；已构建的 agent 提示词不会被改写。


## 已知限制与未决工作

<a id="known-limitations-and-deferred-work"></a>

- **每次访问只读一次** — 页面打开期间入队的提案要重新进入该段才能看到；队列没有实时订阅。
- **接受与点击同步等待** — 页面等待 host 的档案写入；写入慢或失败时显示提示，该行仍保持 pending。
- **接受前不能编辑** — 提案的名字与正文在入队时固定；要改只能先拒绝再重新提议。
- **只覆盖全局** — identity 条目住在全局档案里；页面从不读写工作区覆盖。


### 开发者注记

<a id="dev-note"></a>

<details>
<summary>维护者工作上下文——点击展开</summary>

这段 Dev Note 是非权威工作上下文：尚未决定的问题与方向。已发布行为与已接受的取舍以上文和包内代码为准。

- **页面是否应订阅队列变化** — 实时刷新需要 host 推送或轮询；文件队列目前两者都没有。

</details>
