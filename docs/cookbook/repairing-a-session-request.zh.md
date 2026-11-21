# Cookbook：修复一个 Session 请求

[English](repairing-a-session-request.md) | 中文

当一个 Session 每一轮都以 `DeepSeek Messages transport failed` 失败、重试也救不回时，用这套恢复流程。有两种记录状态会让请求无法构造：图片的附件对象已从 `$DSH_HOME/attachments` 消失，以及记录下来的会话面对超过提供方传输的体积上限。两者都留在 Session 日志里，所以修复对象就是日志本身。

## 1. 找到 sessions 根目录

sessions 根目录是 `$DSH_HOME/sessions`；桌面版使用 `~/.dsh/sessions`。每个 Session 目录里只有一个 `session.v4.jsonl.zstd` 日志。先停掉正在失败的那一轮，但应用可以继续开着：工具会跳过最近两分钟内写过的日志，因此不会改写正在进行的轮次。

## 2. 先跑 dry run

```sh
pnpm run session:repair -- "<sessions-root>"
```

dry run 会为每个需要修复的 Session 打印一行：修复前后的记录会话面、缺失附件块数量、被剪枝的工具结果数量、Session 标题与日志路径。只检查一个 Session 时，把单个 Session 目录当作参数传进去。

## 3. 应用并重启

```sh
pnpm run session:repair -- "<sessions-root>" --apply
```

每个被改写的日志都会先在旁边留下一份 `session.v4.jsonl.zstd.bak-<epoch-ms>` 副本，再原子替换。工具会重新读取结果，事件数发生变化就拒绝保留。之后重启应用，让运行中的宿主重新从磁盘读取 Session 日志。

## 4. 验证

打开修复过的 Session 发一条消息。缺失的图片显示为 `[image unavailable: attachment <id> is missing from the attachment store]`，被剪枝的工具结果显示为 `[tool result pruned by session repair: <n> characters removed]`。事件数保持不变，所以 Session 的 id、标题、归档状态与工作空间归属都还在。

## 5. 调整修复参数

`--attachments <root>` 指向另一个附件存储，`--keep-recent <count>` 决定最近多少条工具结果保持原样（默认 40），`--threshold <chars>` 决定超过多少字符的会话面才修复（默认 700,000 字符，低于实测的传输上限）。剩余文本仍然超过上限的 Session 无法就地继续；新开一个 Session 并总结旧的那条。工具不能恢复已经消失的字节，只能让记录下来的历史重新可发送。

## 6. 它是什么

这是一条运维脚本，不是 `dsh` 子命令：启动器把 `dsh <name>` 读作 `dsh --profile <name>`，新增动词会改变已有 profile 名的含义。它还会修改被删除或损坏的用户数据，这属于显式的恢复步骤，而不是产品常规命令面的一部分。
