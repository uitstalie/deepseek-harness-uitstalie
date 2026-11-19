# 派发完成通知：唤醒派发方

[English](dispatch-completion-notice.md) | 中文

状态：已实现（首版）。实现位于 `packages/uitstalie/workspace-tools/src/completion.ts`，由 `workspace-tools` 插件在 `completionNotice` 打开时挂载；测试位于 `tests/completion-notice.spec.ts`。

## 1. 背景与目标

没有完成信号时，派发方只能在 turn 内 sleep 或轮询；而普通消息只在目标 turn 结束时进入 next-turn，执行方若结束 turn 却没有发消息，派发方永远不会被唤醒。C 为任务绑定的派发补上这个正向信号。

目标：

1. 执行方 turn 结束时，向该任务的派发方投递一条完成通知。
2. 通知作为普通用户消息进入派发方 next-turn；派发方空闲时自动开新 turn，运行中则在当前 turn 结束后处理。
3. 只对任务绑定关系生效；同工作区消息回复与非任务派发保持现状。

非目标：

- 不替代 `workspace_message` 回复，也不做同步等待（另立方案）。
- 不改变任务状态机；任务状态仍只经 `workspace_tasks`。
- 不向非任务绑定的会话、子代理树或用户广播通知。

## 2. 触发点

| 触发点 | 语义 | 优点 | 缺点 |
|---|---|---|---|
| 执行方 `turn/end` | 每次 turn 结束投递一次 | 覆盖“结束但没发消息” | 多 turn 任务会多次通知 |
| `workspace_message.send` 被接收 | 已有回复消息 | 无额外噪音 | 执行方不发消息就没有 |
| `workspace_tasks.receipt` | 形式化完成回执 | 语义最准 | 依赖执行方主动写回执 |

建议以 `turn/end` 为主触发，用“该 turn 是否已有带 `taskId` 的消息”做去重；`receipt` 只用于通知正文里的状态摘要。任务记录已有 `targetSessionId`/`dispatcherSessionId`；跨工作区关系另有 dispatch relation（`dispatch.ts`），二者都可定位派发方。

## 3. 投递形式与 turn 边界

通知用 `agent.followup` 投递，与 subagent settlement 和 scheduled 提醒相同：一条带 `workspace-task-settled` 标记的用户消息进入派发方 next-turn；派发方 idle 时立即唤醒，running 时等当前 turn 结束再开新 turn；不 steer、不打断当前 step。若 `source.kind` 是封闭联合，首版复用 `user` 并在首行标注，新增 kind 走 session 格式评审。

| 字段 | 内容 |
|---|---|
| taskId | 任务 id |
| executorSessionId / turn | 执行方会话与结束的 turn |
| status | turn 终止原因与任务当前状态 |
| reportRef | 该 turn 的最新回执或消息 id |
| summary | 一行结果摘要，正文仍用 `workspace_message.read` / `workspace_tasks.get` |

## 4. 幂等与防自激

- 去重键是 `(taskId, executorSessionId, turn)`；同一 turn 只投一条。
- 该 turn 已有带 `taskId` 的 `workspace_message` 到达时，通知变为 no-op，只保留消息。
- 由通知开启的派发方 turn 不再为同一 task 触发通知，避免“唤醒→再派发→再唤醒”的链。
- 只对任务绑定关系生效：任务存在且 `targetSessionId`/`dispatcherSessionId` 与两方一致。
- 任务进入 `done`/`cancelled` 后不再投递，并设每任务入站通知上限与过期时间。

## 5. 与现有通知机制的关系

| 机制 | 现有行为 | 与本设计的关系 |
|---|---|---|
| `workspace_message` 普通消息 | next-turn，idle 唤醒 | 回传主路径；通知不替代它 |
| `urgent` steer | 插入 next-step，可打断 | 仅用于三种紧急情况，不用于完成通知 |
| scheduled 提醒 | `agent.followup` 唤醒 | 同机制，可复用投递与去重经验 |
| subagent settlement | 子级完成 notice + followup | 同模式，可复用 notice 结构与 source 元数据 |
| `wait_agent` | 阻塞等 next-step 输入 | 收不到工作区 next-turn 消息，不替代 C |

## 6. 开关、回滚与失败降级

- 开关：配置项 `completionNotice: 'off' | 'task-bound'`；首版默认 `off`，由 `workspace-tools` 插件行配置；灰度验证后切 `task-bound`。同名的 `noticeMaxPerTask`（默认 32）与 `noticeTtlMs`（默认一天）控制每任务上限与窗口。
- 回滚：关开关即恢复旧行为；通知是普通用户消息，不需要改 session 格式。
- 失败降级：宿主控制器缺失或拒绝时记录失败与原因，不让执行方 turn 失败；不无限重试，派发方仍可用 `workspace_tasks get` 自查。
- 兼容：不绑定任务的历史派发不生成通知；旧版本读到通知消息只当作普通用户文本。

## 7. 测试计划

- 集成点：执行方 `turn/end` → 任务/派发关系查询 → notice 构造 → `agent.followup`。
- 断言：idle 派发方自动开新 turn 并收到 notice；running 派发方在 turn 结束后处理。
- 断言：同一 turn 多条消息只一条 notice；已回复时 no-op；非任务绑定不投递。
- 断言：通知 turn 不触发新通知；`done`/`cancelled` 后不再投递；失败不使执行方 turn 失败。
- 断言：`urgent` 仍走 steer；scheduled/subagent 通知路径不受影响。

## 8. 非目标与未决问题

- 不做同步等待或阻塞式派发（B/D 另立）。
- 未决：首版默认开关；通知是否携带报告正文；同一任务多执行方并发时的合并策略。
