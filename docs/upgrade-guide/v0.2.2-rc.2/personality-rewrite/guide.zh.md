---
kind: upgrade-guide
description: "personality 能力重写：工作区覆盖、自动学习、proposal、历史、命令、设置页与配置键移除；档案改用新的全局格式和两个工具。"
---

# 把 personality 能力重写为围绕全局文件

[English](guide.md) | 中文

## 变更

`dsh-personality` 现在只读 `<DSH_HOME>/personality/` 下的三个文件：`PERSONALITY.md`、`OUTPUT_STYLE.yaml`、`WRITING_RULES.yaml`。档案格式、工具和包导出面都变了。移除的内容：

- 工具 `personality_learn` 与 `personality_propose`；`/personality` 及其所有子命令；proposal Remote；
- 工作区覆盖（`.dsh/memory/PERSONALITY.md` 不再读写）、turn-end 自动学习、文件 watcher，以及历史/revert 运行时；
- `PERSONALITY.history.jsonl` 的创建与复用；旧文件原样保留；
- 包导出 `./remote`、`./types`、`./typert`、`./locale/*.json`；`ui-personality` 设置页及其整包；
- `Config` schema 及 `workspaceOverlay`、`maxBytes`、`autoLearn`、`historyLimit` 键。Loader 不拒绝未知键，所以旧行仍能加载，这些值被忽略。

新的模型面：每个 agent 都有只读的 `personality_analyze`；只有 root agent 有 `personality_apply`（必须传字面量 `confirm: true`）和维护全局规则的 `write_like_human`。三个提示词段取代原来的一个：档案 100、输出风格 690、写作规则 695。

## 迁移

1. 从 profile patch 中删掉 `ui-personality` 行，并从 `personality` 行删除已删除的配置键；没有替代键。
2. 启动一次 harness。首次激活会把重写前的 `PERSONALITY.md` 移到 `legacy/PERSONALITY.<YYYYMMDDTHHMMSSZ>.md`，并 seed `OUTPUT_STYLE.yaml` 和空的 `WRITING_RULES.yaml`。移动失败时旧文件留在原处，不创建新档案，并阻止写入；修好文件系统后重启。
3. 不要编辑 `legacy/`，也不要指望它被解析。`PERSONALITY.history.jsonl` 与 `PERSONALITY.proposals.jsonl` 作为历史证据留在原处；本版本不迁移也不删除它们。
4. 用新格式编写 `PERSONALITY.md`，或让 `personality_apply` 创建它：

   ```markdown
   ---
   version: 1
   updatedAt: 2026-11-13T00:00:00.000Z
   entries:
     - id: understanding.role-prefix
       kind: understanding
       text: The prefix names the executor; the rest is the task.
   ---
   ```

   id 是 `<kind>.<lower-kebab-name>`；`identity` 条目只能手改。单条最多 400 字符，文档最多 32 KiB。
5. 在磁盘上编辑 `OUTPUT_STYLE.yaml`。root agent 通过 `write_like_human` 维护 `WRITING_RULES.yaml`；子 agent 只读注入的规则，要改需回主会话。人仍可直接编辑该文件。
6. 替换已移除的调用：`personality_learn` 与 `personality_propose` 改为先 `personality_analyze`、再由用户明确确认的 `personality_apply`；proposal 审阅和 `/personality` 没有替代；identity 变更改为手改文件。

7. 确认迁移：能力状态列出 `personality`；装配后的提示词包含 order 100/690/695 的 `personality`、`personality:output-style`、`personality:writing-rules`；`personality_analyze` 不改 `PERSONALITY.md`，只有 `confirm: true` 的 `personality_apply` 会写入；root agent 能看到 `write_like_human`，子 agent 看不到；工作区 `.dsh/memory/PERSONALITY.md` 只记一次警告且不被读写；设置页不再显示 personality 段，旧的 `legacy/` 文件仍存在。
