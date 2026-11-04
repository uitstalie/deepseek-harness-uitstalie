# Super workspace: definition, dispatch ledger, memory (DH-802)

## 要解决的问题

Super agent 的对话一被压缩/重开，`superagent_session` 的派发与回来的 task-report 就只剩上下文记忆。人需要能按工作区回答：

- 上次派了什么、什么时候、现在 pending 还是回来了；
- 回来后的结论、产物、未决决策；
- 这条派发和哪个 jira issue 有关（只引用，不复制 jira 状态）。

## 存储选择

选择 **两层**，不把两件事塞进一层：

1. **调度台账（结构化、可更新）**：每个工作区一个 Markdown 文件，位于
   `<super workspace>/.superagent/ledger/<workspace-id>.md`。
   这是派发事实的唯一权威：任务、时间、状态、结论、产物、决策、可选 issue key。
   人可读，工具用 `superagent_ledger` 追加/更新/检索。
2. **memory（对话结论层）**：继续使用现有 memory 能力，写入 super workspace 的
   `MEMORY.md`。memory 记录“人跟 super agent 聊出的 durable conclusion”，
   不承担任务状态机。

不选择“只写 memory”的原因（读代码确认）：memory 是 per-workspace
（`<workspace>/.dsh/memory/sessions/MEMORY.md`）、append-only 的 managed block；
一条 `memory_write` 必须是一行、最多 8 KiB；默认整个 managed block 16 KiB、
每 session 40 条；kind 只有 `decision/files/open/preference`，没有 update/delete，
也没有暴露给其他插件的 service API。它适合结论，不适合“pending → returned”的结构化状态。

不选择“只写台账”的原因：人跟 agent 聊出的结论需要参与 memory 的检索/摘要/遗忘；
台账是运维记录，memory 是对话记忆，两者职责不同。

## 台账格式

文件头：

```md
# Dispatch ledger — <title>

- workspace: <title>
- path: `<canonical path>`
- updated: <ISO>

## <task-id> · <pending|returned|failed>
- task: ...
- dispatched: <ISO>
- session: <session id>
- issue: DH-...
- artifacts: path, path
- outcome: ...
- decisions: decision; decision
```

- 任务段按 `## <id> · <status>` 分隔；更新只重写该段，追加新段。
- 空字段省略；`decisions` 与 `artifacts` 用 `; ` 分隔，保持人可读。
- 文件名使用 workspace id（UUID）；文件头保留 title/path，重命名/路径变化后由下次写入刷新。
- `.superagent/` 是 super workspace 自己的运维目录；不写目标工作区，不碰 jira 账本。

## 写入时机

`superagent_session` 的 `onTurnEnd` 已经能观测子会话结束：`createSuperagentContribution`
维护 `tasks: Map<sessionId, TaskSessionRecord>`，turn end 时先查 map，再投递
`[task-report]`。因此选择 **插件自动落账 + 手动兜底**：

- `start` / `append` / `prompt` 成功投递后，插件立即写一条 `pending`，并把
  task id、workspace、ledger root 放进 `TaskSessionRecord`；
- 子会话 `turn end` 时，插件在投递报告前后用 `lastAssistantText` 更新同一条为
  `returned`（无文本则 `returned` 并注明没有结论；投递失败单独记录）；
- 如果事件丢失/插件重启/手动改过，模型可用 `superagent_ledger resolve` 补
  `returned`/`failed`、结论、产物、决策；
- 报告作为新消息回到 super 会话后，提示词要求模型调用 `memory_write`，写一行
  `relation: superagent, workspace: <title>, task: <id>, issue: <key>` 的
  decision/open/files 结论；memory 自己也会对对话做 turn summary，漏写时仍有对话层兜底。

## Jira 边界

- jira 记 issue 的 claim/status/review；台账记“人让 super agent 派了什么活、结果如何”。
- 台账只允许可选 `issue: DH-xxx` 引用，不复制 issue 状态、评论或 claim 身份。
- 派发/完成仍走现有 `superagent_claim` / `issue_work`；台账不改 jira 状态。

## 正式定义文件

`<super workspace>/AGENTS.md`：由 `ensureSuperWorkspace` 首次创建（已存在则不覆盖），
原生 instruction loader 会在任何开在该目录的会话中加载它。内容写清：

- 这是人跟 harness 对话的唯一入口，不是普通代码仓库；
- 对话/决策/台账/memory 归这里；目标工作区的代码、文档、数据必须派进该工作区 Session；
- `.superagent/ledger/` 与 `.dsh/memory/` 的约定；
- 台账动作顺序：先 `superagent_ledger list`，派发自动 pending，收到报告后
  `resolve` + `memory_write`；禁止把 jira 状态复制进台账。

## 验收

- 新工作区首次挂载会得到 AGENTS.md，已有文件不被覆盖；
- 派发自动 pending，turn end 自动 returned，手动 resolve 可纠正；
- `superagent_ledger list` 可按 workspace/status/query 检索；
- 测试覆盖 record/update/list 与自动 pending/outcome；
- typecheck / build 通过；提示词、README/设计文档同步。
