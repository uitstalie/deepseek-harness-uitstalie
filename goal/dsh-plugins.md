# DeepSeek Harness 插件全景清单

本文盘点 `packages/`（约 200 个 `@deepseek-ai/dsh-*` 包）与 `apps/`（2 个 launcher）的全部插件，按包组组织：每个包给出名称、作用与角色。任务单：[task3](mission/task3.md)。来源：各包 package.json / README.md / src/index.ts 实测。

**角色词汇**（仓库的 capability seam 约定）：

- **Service Definition**：定义 `ctx.<name>` 服务契约（默认导出 `extends Service` 的类，常为抽象类，由 Provider 子类实现）；
- **Service Provider**：实现某 Definition 的后端（默认导出服务类或函数插件）；
- **Consumer**：消费服务、向模型/用户暴露功能的插件（`tool-*` 包 = 向模型注册工具的 Consumer）；
- **函数插件**：named export `name`/`inject`/`Config`/`apply`、无默认导出；**服务类插件**：默认导出 Service 类；**纯库**：无 cordis 插件入口。

---

## 1. core/ — 产品 API 脊柱（8 包）

| 包 | 作用 |
|---|---|
| `dsh-agent` (core/agent) | **Definition**：`ctx.agents`（`AgentRegistry`）。Agent 句柄（`followup()`/`steer()`/`cancel()`/`whenIdle()`）、活注册表、`agent/*` 事件词表、initiator scope。不含 loop，被几乎所有上层包依赖。服务类插件。 |
| `dsh-agent-loop` (core/agent-loop) | 唯一的具体 agent 驱动：实现 `Agent` 接口并把 factory 注册到 `ctx.agents`；跑 turn/step 生命周期——认领 prompt、组装请求、流式响应、分发 tool call、写回 session log。config 支持声明式 `agents[]` 与 `maxParallelToolCalls`。服务类插件。 |
| `dsh-session` (core/session) | **Definition**：`ctx.sessions`（`SessionStore`）。事件溯源 session 日志：`session.append(type, data)` 提交类型化事件，`deriveMessages()` 从日志派生模型所见消息历史；定义可扩展的 `SessionEventMap` 词表与 `session/event`、`session/flush` 事件。服务类插件。 |
| `dsh-system-prompt` (core/system-prompt) | **Definition**：`ctx.systemPrompt`。系统提示词组装注册表：有序 section、动态 runtime context、tool schema 来源、命名变量；loop 每步调 `assemble()`。config 控制 harness 身份开场白、persona、toolOrder。服务类插件。 |
| `dsh-tools` (core/tools) | **Definition**：`ctx.tools`（`ToolRuntime`）。工具注册表与执行管线：`defineTool()` 定义类型化工具；tool call 走 allow/deny/ask 策略 → 守卫 → around-dispatch 管线；`mode` 选 native/PTC 呈现，内置 SDK 渲染器与 `run_code` PTC 传输。服务类插件。 |
| `dsh-agent-default-model` (core/agent-default-model) | **Provider**：`ctx.agentDefaultModel`。部署级默认模型选择（provider/model/reasoningEffort），新建会话无自选模型时读取；settings 用户选择叠加在 cordis.yml config 上。服务类插件。 |
| `dsh-agent-tool-presentation` (core/agent-tool-presentation) | Consumer：agent preset 携带一行，config `mode: native\|ptc\|both`，在挂载 scope 调 `ctx.tools.presentAs()` 声明该 preset 下 agent 看到的工具形式。函数插件。 |
| `dsh-scope` (core/scope) | 纯库：作用域注册原语（`createScope`/`scopeOf`/`ScopedLayers`），agent、tools、system-prompt 的 scoped 注册全建在它上面。 |

## 2. llm/ — 模型调用能力（7 包）

| 包 | 作用 |
|---|---|
| `dsh-llm` (llm/llm) | **Definition**：`ctx.llm`（`LlmRuntime`）。provider-neutral 词汇（message、`StreamChunk`）、`stream()` 流式调用、adapter 注册（重复报 `DUPLICATE_ADAPTER`）、模型发现、`llm/stream` waterfall。不含 provider wire 逻辑。服务类插件。 |
| `dsh-llm-deepseek` (llm/llm-deepseek) | **Provider**：注册 `deepseek-official` 路由，把 DeepSeek chat-completions wire 翻译成 `StreamChunk`；支持 thinking、vision（Files API 优先）、per-request settings/credentials 解析、`deepseekLlmApiExtensions` 顶层字段。函数插件。 |
| `dsh-llm-pi-ai` (llm/llm-pi-ai) | **Provider**（孪生 adapter）：基于 `@earendil-works/pi-ai`，一个插件拥有一整本 providers 字典路由（OpenAI 兼容网关、自托管），支持 OAuth/key 登录、replay state 恢复、endpoint 模型发现。函数插件。 |
| `dsh-llm-retry` (llm/llm-retry) | Consumer：挂 `agent/request-error` waterfall，按 adapter 注册的 `retryPolicy`（normal 有限退避 / always 无限）在 durable step 边界内重跑失败 step；调度先落 `llm/retry` 日志再等待。函数插件。 |
| `dsh-deepseek-llm-api-extensions` (llm/deepseek-llm-api-extensions) | **Definition**：`ctx.deepseekLlmApiExtensions`。DeepSeek 请求的顶层字段注册表：贡献者各占一个字段，`prepare(request)` 并发准备、`accept()` 在 HTTP 2xx 后统一回调。服务类插件。 |
| `dsh-plugin-package-inventory-deepseek` (llm/plugin-package-inventory-deepseek) | Consumer：`dsh_plugin_packages` 字段贡献者——每请求枚举 Loader 树中 ACTIVE 插件的 `{ name, version }` 随请求发出，模型不可见。函数插件。 |
| `dsh-token-meter` (llm/token-meter) | **Definition**：`ctx.tokenMeter`。replay-aware token 测量：从 session 日志 fold 出请求/上下文压力快照，启发式 + adapter 视觉定价；注册 `tokenUsage`/`contextPressure`/`contextBreakdown` 三个 projection unit。服务类插件。 |

## 3. session/ — 会话数据（14 包）

| 包 | 作用 |
|---|---|
| `dsh-session-persistence` | **Definition**：抽象 `ctx.sessionPersistence`。持久化契约（create/append/load/list/locate）：append-only、连续 seq、崩溃恢复合成闭合、只丢撕裂尾部。抽象服务类。 |
| `dsh-session-persistence-jsonl` | **Provider**：每 session 一个 append-only `.jsonl.zstd`（可明文），首行不可变 `SessionHeader`；必填 `root`；有 per-session artifact（导出依赖它）。服务类插件。 |
| `dsh-session-persistence-sqlite` | **Provider**：全部 session 存单库（schema-19 packed-row，`SCHEMA_VERSION` 单调），必填 `path`（支持 `:memory:`）；无 per-session artifact；shipped 默认不启用。服务类插件。 |
| `dsh-session-checkpoint-policy` | Consumer：三个语义屏障强制 flush——模型请求前、tool 副作用前、每 `agent/pre-step`；checkpoint 失败 fail-closed 不执行。函数插件。 |
| `dsh-session-log-deepseek` | Consumer：`dsh_session_log` 字段贡献者——把水位线后的 session 日志后缀随请求上传（at-least-once，2xx 后推进水位线）。默认 `enabled: false`。函数插件。 |
| `dsh-session-projection` | **Definition**：`ctx.sessionProjections`。投影注册表：domain 包注册纯计算 unit（init/apply fold），框架驱动并通知变更，向 client 提供当前值。服务类插件。 |
| `dsh-session-projection-cache` | Consumer：`ctx.sessionProjectionCache`。把 unit 状态 checkpoint 写入 `session_projcache` storage domain，使冷 session 投影零 I/O。服务类插件。 |
| `dsh-session-stats` | Consumer：`sessionStats` projection unit——fold 出 turns/steps/llmMs/toolMs/ttft 等全量会话数字。函数插件。 |
| `dsh-session-telemetry` | **Definition**（契约库）：抽象 `SessionTelemetryBackend`（`emit`/`flush`/`shutdown`）、live/on-demand 捕获协调、`sessionTelemetry/record` 脱敏 waterfall（fail-closed）、sharing 披露词汇。无插件入口。 |
| `dsh-session-telemetry-otel` | **Provider**：OTel 后端。`FULL` 立即上交 OTel SDK；`FEEDBACK_ONLY` 在 feedback 落地时重放日志后缀；`DISABLED`（默认）不构造。服务类插件。 |
| `dsh-session-title` | **Definition**：`ctx.sessionTitle`。三个标题来源（确定性 fallback / 异步 provider / 用户 rename）新者胜；每修订是 log-only `session/title` 事件。服务类插件。 |
| `dsh-session-title-llm` | 纯库：LLM 标题生成共享策略（路由解析、JSON 化消息、超预算即失败、输出校验），保证两个 provider 不漂移。 |
| `dsh-session-title-first-prompt-llm` | **Provider**：仅新鲜 session 首条 human 消息后生成一次；fork 继承不跑；失败保留 fallback。函数插件。 |
| `dsh-session-title-all-prompts-llm` | **Provider**：每条合格 human prompt 后启动新修订，fold 全部消息生成；新修订中止旧工作。函数插件。 |

## 4. session-query/ — 历史查询（4 包）

| 包 | 作用 |
|---|---|
| `dsh-session-query` | **Definition**：抽象 `ctx.sessionQuery`。精确读、过滤、标题折叠、lineage 追踪、全文搜索的组合式查询面；live 优先于持久化。抽象服务类。 |
| `dsh-session-query-sqlite` | **Provider**：SQLite FTS5 全文搜索；live 从内存建索引、持久化用独立派生索引库；`openAt` 控制索引打开时机。服务类插件。 |
| `dsh-tool-session-query` | Consumer：向模型暴露 `session_search`/`session_event_search`/`session_trace`/`session_event_trace`/`session_event_read` 五个只读工具（按 workspace 授权）。opt-in。函数插件。 |
| `dsh-session-log-export` | Consumer：Web 端把 session 树打包为 `dsh-session-<id>.zip` 下载；`Session log` 按钮 + `/export` 命令；仅支持 JSONL 后端。函数插件。 |

## 5. compaction/ — 上下文压缩（4 包）

| 包 | 作用 |
|---|---|
| `dsh-compaction` | **Definition**：抽象 `ctx.compaction`。契约：旧历史替换为一条 summary，被压缩内容留在日志使 replay 精确；触发分自动/按需/显式 span。抽象服务类。 |
| `dsh-compaction-basic` | **Provider**：读 `tokenMeter.measure()` 压力，近上限时自动压缩最旧历史为模型撰写的 summary；context-overflow 后先压再重试；per-model 阈值覆盖。服务类插件。 |
| `dsh-compaction-tool-result-pruner` | Consumer：压缩触发合格时把超预算 tool 结果修剪为 head + tail（原文留日志）；不发模型调用，修剪可能直接解除压力。服务类插件。 |
| `dsh-command-compact` | Consumer：`/compact` 命令——未达阈值也手动压缩一段旧历史，报告替换条目数与节省 token。函数插件。 |

## 6. context/ — 请求上下文（6 包）

| 包 | 作用 |
|---|---|
| `dsh-agent-instructions` | 把 `AGENTS.md`/`CLAUDE.md` 指令文件装入模型上下文：首请求带 durable baseline（全局 + 项目链去重），文件变更后增量通知；`maxBytes` 预算约束。函数插件。 |
| `dsh-file-reference` | **Definition**：抽象 `ctx.fileReferences`。`@file` mention 语法与 `list(agent, query)` 契约；选中只插入 prompt 文本，不读内容。抽象服务类。 |
| `dsh-file-reference-local` | **Provider**：每 agent 工作区的有界模糊搜索索引；tool result 后标记过期、先旧索引应答后台重建。服务类插件。 |
| `dsh-session-reference` | `ctx.sessionReferenceResolver`：`@[label](dsh-session:...)` mention 规范化为有界只读快照注入（固定"不可信"警告）；`listCandidates` 按 cwd 亲和排名。服务类插件。 |
| `dsh-time-context` | per-step 注入当前时间（ISO + IANA zone + 距前消息经过时间）的 durable user-role 消息；可节流。opt-in。函数插件。 |
| `dsh-tmux-context` | per-turn 注入 tmux 位置（session/window/pane + pane-tree 布局），位置不变不注入。opt-in。函数插件。 |

## 7. plan/ preset/ guard/ identity/（6 包）

| 包 | 作用 |
|---|---|
| `dsh-plan-mode` (plan/plan-mode) | `ctx.planMode`（`PlanModeController`）：plan mode 激活时渲染 `plan:policy` section，agent 先探索后经 `exit_plan_mode` 工具交用户审批；`/plan` 进 `/plan off` 出；引导而非强制。服务类插件。 |
| `dsh-agent-presets` (preset/agent-presets) | `ctx.agentPresets`：per-session agent 组合——preset 目录的 `agent.cordis.yml` 即该 session 的插件组合；花名册、复制创建、默认覆盖、session 未产出前可切换。服务类插件。 |
| `dsh-persona` (preset/persona) | preset 内 persona 行：注册 `deployment:persona` section 遮蔽部署级；`complete: true` 时成为完整 system prompt。必须在 agent scope 挂载。函数插件。 |
| `dsh-repeat-tool-reminder` (guard/repeat-tool-reminder) | 检测同参数连续重复调用同一工具，在 `thresholds`（默认 3/5/8）提醒模型换方法；建议式不阻断；新 user 消息清零。函数插件。 |
| `dsh-tool-call-timeout-policy` (guard/timeout-policy) | 包裹 `tools/execute`：对声明时限的工具武装 deadline，超时 abort 后映射为 `Error: tool call timed out`；不硬停下游。函数插件。 |
| `dsh-anonymous-user-id` (identity/anonymous-user-id) | 纯库：每 harness home 一个随机 UUID（`$DSH_HOME/.anonymous-user-id`），被遥测、feedback、DeepSeek 请求 header 消费。 |

## 8. fs/ — 文件系统能力（7 包）

| 包 | 作用 |
|---|---|
| `dsh-fs` | **Definition**：抽象 `ctx.fs`（`FileSystem`）：`resolve`/`stat`/`readText`/`streamText`/`readBytes`/`listDir`/`writeText`/`editText` 等 13 原语 + 版本守卫 + 稳定码 `FsError`；`fs/write-intent`、`fs/edit-intent`（决策 waterfall）与 `fs/observed` 事件词汇。 |
| `dsh-fs-local` | **Provider**：宿主机实现；realpath 身份、临时文件 + fsync + 原子发布（Windows 保 DACL）、每目标 FIFO 锁。服务类插件。 |
| `dsh-fs-sandbox` | **Provider**：继承 fs-local，变更按 `ctx.sandboxPolicy` 围栏：`read-only` 拒绝、`workspace-write` 限工作区与临时根、`danger-full-access` 直通。服务类插件。 |
| `dsh-fs-observation-policy` | 策略插件：read-before-edit——未读文件只能创建不能覆盖、版本过期报 `FS_NOT_OBSERVED`/`FS_STALE_VERSION`；移除后退回裸 provider。函数插件。 |
| `dsh-tool-fs` | Consumer：模型工具 `read`/`read_image`/`write`/`edit`；变更走 `fs/*-intent` waterfall，`read_image` 需 `ctx.attachments` + 路由声明图像输入。函数插件。 |
| `dsh-tool-fs-search` | Consumer：模型工具 `glob`/`grep`，直接 spawn 打包的 `@vscode/ripgrep`（需 `ctx.subprocess`）；超限可经 spill 保存。函数插件。 |
| `dsh-tool-str-replace-editor` | Consumer：单一 `str_replace_editor` 工具（`view`/`create`/`str_replace`/`insert`，Claude-Code 风格），tool-fs 的替代编辑套件。函数插件。 |

## 9. shell/ subprocess/ terminal/ — 执行层（15 包）

| 包 | 作用 |
|---|---|
| `dsh-shell` | **Definition**：抽象 `ctx.shell`（`ShellExecutor`）：`resolve(request)→spec` 显式补全、`run`（前台）/`start`（后台，job 归 `ctx.jobs`）；共享退出标记 `[exit code: N]` 与 `parseExitStatus`。 |
| `dsh-bash-local` | **Provider**：POSIX 默认执行器，每次 spawn 全新 `bash -c`（cwd/timeout/输出预算），底层走 `ctx.subprocess`。服务类插件。 |
| `dsh-bash-sandbox` | **Provider**：继承 bash-local，argv 经 `ctx.sandbox.confine()` 包装；无 runner 时 fail-closed `SANDBOX_UNAVAILABLE`。服务类插件。 |
| `dsh-pwsh-local` / `dsh-pwsh-sandbox` | **Provider**：PowerShell 对应物（`pwsh -NoProfile -NonInteractive`，Windows 5.1 兜底 / ACL restricted-token）。服务类插件。 |
| `dsh-shell-env` | `ctx.shellEnv` 注册表：每次 shell 调用重建可信 `DSH_*` 环境快照（`DSH_HOME`/`DSH_SESSION_ID` 等），插件可注册贡献者（key 冲突 fail-loud）。函数插件。 |
| `dsh-tool-bash` | Consumer：模型工具 `bash`（command/timeoutMs/workdir/run_in_background，沙箱下加升级字段）；后台走 `ctx.jobs`；升级走 `ctx.approval`。函数插件。 |
| `dsh-tool-pwsh` | Consumer：`pwsh` 工具，tool-bash 的 Windows 镜像。函数插件。 |
| `dsh-tool-bash-persistent` / `dsh-tool-pwsh-persistent` | Consumer：持久 `bash`/`pwsh` 工具——每 agent 一个 owner-scoped PTY shell（cwd/变量跨调用存活），经 `ctx.terminals.spawn`；不确定状态即重建。函数插件。 |
| `dsh-subprocess` | **Definition**：抽象 `ctx.subprocess`：显式 spawn spec、`spawnTerminal`（真 PTY）、树级 `terminate()`（SIGTERM→grace→SIGKILL）、`scrubbedParentEnv` 环境清洗、collect 有界尾部 + spill。 |
| `dsh-subprocess-local` | **Provider**：宿主机实现：POSIX detached 进程组、Windows `taskkill /T`、node-pty PTY、spill 0600/O_EXCL、host 退出强杀。服务类插件。 |
| `dsh-win32-process` | 纯库：Koffi Win32 绑定（restricted-token 创建、Job Object、管道），唯一消费者是 sandbox-windows-acl。 |
| `dsh-terminal` | **Definition + 实现**：`ctx.terminals`：持久 PTY session（spawn/send/read/signal/kill/list），按 `Agent` 对象 owner fencing（`FOREIGN_SESSION`），每 session 单 active send。服务类插件。 |
| `dsh-terminal-bash` | **Provider**：向 `ctx.terminals` 注册 `shell` 后端——经 `spawnTerminal` 起 bash/pwsh，三级 readiness 模型，不支持全屏 TUI。函数插件。 |
| `dsh-tool-terminal` | Consumer：模型工具六件套 `terminal_open`/`terminal_send`/`terminal_read`/`terminal_signal`/`terminal_close`/`terminal_list`。函数插件。 |

## 10. e2b/ sandbox/ code-runtime/ lsp/ mcp/（14 包）

| 包 | 作用 |
|---|---|
| `dsh-e2b` (e2b/e2b) | `ctx.e2b`：共享远程 Linux sandbox 生命周期（apiKey/cwd/timeoutMs），是 fs-e2b/subprocess-e2b 的基座。服务类插件。 |
| `dsh-fs-e2b` / `dsh-subprocess-e2b` | **Provider**：远程 E2B sandbox 内的 `ctx.fs` / `ctx.subprocess` 实现（realpath canonicalize、base64 分帧、原子发布 / 异步进程组 id、SIGTERM→SIGKILL 阶梯）。服务类插件。 |
| `dsh-sandbox` | **Definition**：抽象 `ctx.sandbox`：`confine()` 返回被强制 argv（禁止静默直通）、模式词汇 `read-only`/`workspace-write`/`danger-full-access`、升级词汇（`sandbox_permissions`/`justification`）、共享 `writableRoots`。 |
| `dsh-sandbox-local` | **Provider**：按平台 runner 链——Linux bwrap→Landlock、macOS Seatbelt、Windows ACL restricted-token；功能探测选定并缓存；报告 `enforcement: full\|partial`。服务类插件。 |
| `dsh-sandbox-policy` | `ctx.sandboxPolicy`：每调用策略解析——批准显式模式 > session `sandbox/mode` 事件 > 部署默认（`read-only` fail-safe）；向 runtime-context 贡献 `sandbox:policy` 条款。服务类插件。 |
| `dsh-sandbox-windows-acl` | 纯库 + runner：Windows ACL 写限制后端（WRITE_RESTRICTED token + capability-SID 白名单），enforcement 恒 `partial`；`./runner` 子进程入口。 |
| `dsh-code-runtime` | **Definition**：抽象 `ctx.codeRuntime`：`run({ program, bindings, signal? })` 一次性运行模型编写的程序，一切失败都是 result 字段。被 PTC `run_code` 消费。 |
| `dsh-code-runtime-worker-thread` | **Provider**：每程序一个 Node worker thread 跑 TS（类型剥离），绑定经 message port 往返；computeMs/maxWallMs 双预算 + 堆上限。PTC 出货后端。服务类插件。 |
| `dsh-code-runtime-python` | 纯库：Node↔CPython 的 fd-3 线协议（帧编解码、敌意帧验证、无损 JSON 计量），未来 CPython 后端的协议层。 |
| `dsh-lsp` | **Definition**：`ctx.lsp`：provider 按扩展名注册（独占，`LSP_CONFLICT`），封闭四操作只读词汇 `goToDefinition`/`findReferences`/`goToImplementation`/`hover`。服务类插件。 |
| `dsh-lsp-stdio` | **Provider**：通用 stdio language-server host：`servers` 配置表，每 workspace 懒启动池化一个 server，transient didOpen→request→didClose。函数插件。 |
| `dsh-tool-lsp` | Consumer：模型工具 `lsp`（operation/file_path/line/character，一基坐标换算），要求会话 workspace 根。函数插件。 |
| `dsh-mcp-client` | 桥接插件：把外部 MCP server 工具桥到 `ctx.tools`，稳定名 `mcp__<server>__<rawName>`；代际原子替换、断线指数退避重连；只桥 tools。函数插件。 |

## 11. subagent/ — 子代理委派（11 包）

| 包 | 作用 |
|---|---|
| `dsh-subagent` | **Definition**：`ctx.subagents`（`SubagentRuntime`）：命名 provider 注册表——父 agent 委派任务给具名子 agent，one-shot 与 continuable 两种形态，发现后代树；`subagent/*` 事件。服务类插件。 |
| `dsh-subagent-spawn-in-process` | **Provider**（名 `spawn`）：进程内全新（空对话）子 agent，继承父 cwd/provider/model。函数插件。 |
| `dsh-subagent-fork-in-process` | **Provider**（名 `fork`）：以父 session 已完成轮次前缀 seed 启动子 agent。函数插件。 |
| `dsh-subagent-in-process-driver` | 纯库：两个进程内后端共享的运行驱动 `startInProcessRun()`。 |
| `dsh-subagent-acp` | **Provider**（名 `acp`）：每次委派 spawn 子进程，作为 ACP client 驱动；只传最终答案。函数插件。 |
| `dsh-subagent-dsh-sdk` | **Provider**（名 `dsh-sdk`）：委派跑成完整 dsh 运行时子进程（stdio JSON-RPC），支持 `agentOptions`。函数插件。 |
| `dsh-subagent-claude-code` / `dsh-subagent-codex` | **Provider + Profile Bundle**：经官方 SDK 跑真实 Claude Code / Codex 子会话；带 `cordis.patch.yml` 安装后休眠待命。函数插件。 |
| `dsh-tool-subagent` | Consumer：把一个 provider 变成模型工具（默认名 `subagent`）；`backgroundMode` 决定前台/后台（走 `ctx.jobs`）；可选 persona/toolFilter/maxDepth。函数插件。 |
| `dsh-tool-subagent-control` | Consumer：continuable 子代理的控制工具 `send_message`/`interrupt_agent`（+ 可选 `list_agents`）。函数插件。 |
| `dsh-tool-subagent-report` | Consumer：为进程内 continuable 子代理安装子作用域 `report` 工具，把发现作为父消息送回。函数插件。 |

## 12. workflow/ webhook/ jobs/ schedule/（10 包）

| 包 | 作用 |
|---|---|
| `dsh-workflow` | **Definition**：`ctx.workflowEngine`：运行 plain-JS 编排脚本返回 live run 的契约；脚本内 `agent()`/`parallel()`/`pipeline()`/`phase()`；`workflow/*` 事件。服务类插件。 |
| `dsh-workflow-worker-thread` | **Provider**：每 run 一个 worker thread（node:vm 隔离），`agent()` 经 host/worker 协议桥回 `ctx.subagents`。服务类插件。 |
| `dsh-tool-workflow` | Consumer：模型工具 `workflow`（meta/script/args），前台阻塞父轮直到 workflow 结算。函数插件。 |
| `dsh-tool-ralph` | Consumer：模型工具 `ralph`——固定"fresh-agent 循环"：不可变 objective 交给一串全新子代理直到 complete/blocked 或 round 上限。函数插件。 |
| `dsh-webhook` | **Definition + 运行时**：`ctx.webhookRuntime`：受信 webhook 规则注册表，内置动作 = 在 Web Workspace 创建 root Session（`Agent.followup()` 提交）。服务类插件。 |
| `dsh-webhook-github` | Provider：注册 HTTP 路由，校验 `X-Hub-Signature-256` HMAC，把 GitHub 事件投影为 delivery 后 dispatch，立即 202。函数插件。 |
| `dsh-jobs` | **Definition**：`ctx.jobs`（`JobRegistry`）：后台 job 契约——`<kind>-N` id、按 agent session owner 隔离、读输出/等待/取消。服务类插件。 |
| `dsh-jobs-local` | **Provider**：进程内实现（内存记录，per-owner 并发上限 10，不持久）。服务类插件。 |
| `dsh-tool-jobs` | Consumer：模型工具 `job_output`/`job_list`/`job_kill`；job 完成转为会话内通知。函数插件。 |
| `dsh-schedule` | 独立能力：模型工具 `schedule_create`/`schedule_list`/`schedule_delete`——agent 作用域持久提醒（after/at/fixed-rate），状态是 session 日志 `schedule/change` 事件流，重启可恢复。函数插件。 |

## 13. spill/ storage/ workspace/ todo/ goal/ feedback/（15 包）

| 包 | 作用 |
|---|---|
| `dsh-spill` | **Definition**：`ctx.spillStore`：保存超大工具文本、返回 locator + 字节数 + 检索指引的契约。服务类插件。 |
| `dsh-spill-local` | **Provider**：写到宿主机私有 session 作用域文件（不可预测文件名防 symlink），指引模型 read/grep。服务类插件。 |
| `dsh-spill-policy` | Consumer：tool 结果超 `maxInlineBytes` 时替换为 head/tail 预览 + locator（原文入 spill store）；省略配置即禁用。函数插件。 |
| `dsh-storage` | **Definition/枢纽**：`ctx.storage`：命名 backend 注册表 + data-form facility 连接点，不做 IO。服务类插件。 |
| `dsh-storage-domain` | Facility：`ctx.storageDomain`——owning 包声明 domain（format version + zod schema），consumer 得同步内存读 + 先持久后 resolve 的写，`domain/changed` 事件。函数插件。 |
| `dsh-storage-json` / `dsh-storage-sqlite` | **Provider**：JSON 文件 KV（`single`/`per-record` 布局）/ SQLite KV（单库每记录一行 JSON）。函数插件。 |
| `dsh-workspace` | `ctx.workspaceRegistry`：持久 workspace 记录（命名目录 + session 列表 + 稳定顺序），在 storage domain 之上；对模型不可见。服务类插件。 |
| `dsh-tool-todo` | Consumer：模型工具 `todo_write`——整表替换式任务清单，状态为 `todo/write` session 事件，经 todos projection 供 UI。函数插件。 |
| `dsh-goal` | `ctx.goals`（`GoalService`）：每会话一个持久目标，事件源 `goal/change`（create/edit/pause/resume/complete/blocked/clear），compare-and-set 变更，round 上限默认 256。服务类插件。 |
| `dsh-tool-goal` | Consumer：模型工具 `get_goal`/`create_goal`/`update_goal`；权限在执行时强制（create 须顶层人类轮）。函数插件。 |
| `dsh-command-goal` | Consumer：`/goal` slash 命令（人类侧直接操作目标，不进模型请求）。函数插件。 |
| `dsh-goal-round-driver` | Consumer：agent 空闲且有 active/armed goal 时自动开启下一 goal round（race-fenced）。函数插件。 |
| `dsh-command-feedback` | `/feedback` 命令：记录 log-only 会话反馈并确认（含遥测 sharing 方式说明），模型不可见。函数插件。 |
| `dsh-message-feedback` | `ctx.messageFeedback`：已定稿 assistant 消息的正/负评分 + 短注，storage domain 侧车持久，不进模型历史。服务类插件。 |

## 14. interaction/ settings/ credentials/（10 包）

| 包 | 作用 |
|---|---|
| `dsh-commands` (interaction/commands) | **Definition**：`ctx.commands`（`CommandRuntime`）：slash 命令注册表——`/command [input]` 直接对 agent 执行不产生模型消息；全局 + agent-scoped 两层；`command/run`、`commands/change` 事件。服务类插件。 |
| `dsh-permission-presets` (interaction/permission-presets) | `ctx.permissionPresets`：把 sandbox mode + approval policy 打包成命名 preset（`workspace-write`/`danger-full-access`），写路径经两个 canonical setter；含 `/permission` 命令。服务类插件。 |
| `dsh-user-approval` (interaction/user-approval) | **Definition**：`ctx.approval`：一次性审批 seam——`request(req)` 经 answerer waterfall 返回 `allowed-once`/`rejected`/`cancelled`/`unavailable`；缺失 answerer fail-closed；会话策略 `ask`/`never`；审计事件。服务类插件。 |
| `dsh-user-questions` (interaction/user-questions) | **Definition**：`ctx.userQuestions`：抽象"向人类提问"seam，`ask(request)` 派发 answerer waterfall 等首个被接受回答；定义意图词汇（`plan-review` 等）。服务类插件。 |
| `dsh-tool-ask-user` (interaction/tool-ask-user) | Consumer：模型工具 `ask_user_question`，回答以紧凑 JSON 回到 loop；拒绝 runtime 子 agent 提问。函数插件。 |
| `dsh-settings` (settings/settings) | **Definition**：`ctx.settings`：插件以 schemastery schema 注册配置命名空间；三层解析（默认 → base → 用户文档）；`get`/`watch`/`update`/`mutate`/`describe`（脱敏 secret）；`settings/updated` 事件。抽象服务类。 |
| `dsh-settings-file` (settings/settings-file) | **Provider**：单份 `<dshHome>/settings.yaml`（或 JSON），chokidar 热重载，叶级 diff 保留注释，0600 权限 + 原子写。服务类插件。 |
| `dsh-credentials` (credentials/credentials) | **Definition**：`ctx.credentials`：两个键空间——`credentialRef`（环境变量形引用，resolve/describe/set/unset）与 `credentialKey`（`<owner>/<id>` 持久记录，OAuth grant 等）；按操作即时 resolve，轮换立即生效。抽象服务类。 |
| `dsh-credentials-local` (credentials/credentials-local) | **Provider**：`$DSH_HOME/.credentials.yaml`；四层优先级（启动环境快照 > 存储文件 > 项目 .env > 家目录 .env）；writer lock 行级 patch；拒绝他人可读文件。服务类插件。 |
| `dsh-authorization` (credentials/authorization) | **Definition**：`ctx.authorization`：交互式授权流程注册表（OAuth 登录等），流程必须经 `modifyRecord` 提交记录后才报 `authorized`；自身不带 flow。服务类插件。 |

## 15. skill/ web/ hooks/ acp/ attachment/（14 包）

| 包 | 作用 |
|---|---|
| `dsh-skill` | **Definition**：`ctx.skills`（`SkillRegistry`）：合并所有 provider 的技能 catalog（同名按 rank 取胜），`SkillInvocationPolicy` 决定模型面/用户面。服务类插件。 |
| `dsh-skill-filesystem` | **Provider**：扫描五类根（`.dsh/skills`、`.agents/skills` 等，rank 100–600），`<name>/SKILL.md` 目录包或扁平 md，解析 YAML frontmatter，chokidar 免重启增删。函数插件。 |
| `dsh-skill-badge` | **Provider**：内置 `dsh-badge` 徽章技能；出厂组合 `disabled: true` 携带。函数插件。 |
| `dsh-tool-skill` | Consumer：模型工具 `skill`（按名加载技能正文返回 `<skill_content>`）；首请求注入 catalog 消息；`/name` 用户直接调用。函数插件。 |
| `dsh-web` | **Definition**：`ctx.web`：`search()`/`fetch()`，provider 后端插入，按配置或唯一可用自动选择；统一 `WebError` 分类。服务类插件。 |
| `dsh-tool-web` | Consumer：模型工具 `web_search`（多 query 并发合并、要求引用 URL）/ `web_fetch`（turndown 转文本、标注不可信）；可分别关闭。函数插件。 |
| `dsh-web-fetch-http` | **Provider**（名 `http`）：匿名公共 HTTP fetch——URL 校验、公网地址钉定、仅同源重定向、不带凭据。函数插件。 |
| `dsh-web-search-deepseek` | **Provider**（名 `deepseek-official`）：走 Anthropic 兼容 Messages API 的原生搜索，一次搜索 = 一个模型 turn。函数插件。 |
| `dsh-web-search-exa` / `dsh-web-search-perplexity` | **Provider**：Exa（原生结果 + snippet）/ Perplexity（生成式 answer + 引用来源）搜索后端。函数插件。 |
| `dsh-hook-protocol` | 纯库：Claude Code/Codex 两桥共用的 hook 线协议（matcher、exit-code 语义：2 阻断、附加上下文、`continue:false`）。 |
| `dsh-hooks-claude-code` / `dsh-hooks-codex` | 桥插件：把现有 Claude Code / Codex `hooks.json` 原样跑在 harness 拦截点（SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop 等），hook 以 bash 运行。函数插件。 |
| `dsh-acp` | 自动化专用 ACP 服务器（JSON-RPC stdio）：`session/new`/`prompt`/`cancel`、MCP server 挂载、语义化执行更新；对自己的 agent 应答 `approval/request`。函数插件。 |
| `dsh-attachment` | **Definition**：抽象 `ctx.attachments`（`AttachmentStore`）：持久不可变图片附件，入库前归一化为 provider 无关 8-bit sRGB 位图；仅 PNG/JPEG/WebP/GIF。抽象服务类。 |
| `dsh-attachment-local` | **Provider**：`DSH_HOME` 下内容寻址本地存储（sharp 校验/定向/剥元数据），相同图像只存一份，路由请求版本派生缓存。服务类插件。 |

## 16. api/ typert/ — RPC 与类型图（8 包）

| 包 | 作用 |
|---|---|
| `dsh-typert-registry` | `ctx.typert`：运行时类型图注册表——各包反射（services/events/objects）、活 Zod schema、Remote invocation descriptor、lookup/scoped-Context 注册表。服务类插件。 |
| `dsh-typert-loader` | 监听 `internal/plugin` 增量扫描 Loader 条目，导入各包 `./typert` 导出的 `TYPERT` manifest 并校验注册（fiber 卸载撤回）。函数插件。 |
| `dsh-typert-generator` | 纯库（构建期）：分析包类型树产出类型图 + 可执行 JS + Zod schema；`./tsdown` 插件随构建自动运行。 |
| `dsh-typert-protocol` | 纯库（声明）：`@Remote`/`@RemoteScope` 装饰器、`TypertRemoteService` 基类、传输错误、全部类型声明（业务包/生成产物/Gateway/Client 四方共用）。 |
| `dsh-api-gateway` | `ctx.typertGateway`（Host 面）/ `ctx.remote`（Client 面）：Typert RPC 双端网关——invoke 解析 descriptor、校验参数、经 lookup resolver 调用业务方法；client 侧一元调用关联与流复用。服务类插件。 |
| `dsh-api-remotes` | 应用级 Remote 组装（BFF facade）：Host 持有转发事件白名单 `API_REMOTE_FORWARDED_EVENTS`；Client 逐个 `$mount()` 各业务包生成的 `/remote` 产物。函数插件。 |
| `dsh-api-session-controller` | `ctx.sessionController`：Session 域 Remote owner——生成 `ctx.remote.session`/`skills`/`fileReferences`：生命周期、历史分页 + live follow、模型目录、Agent/Session 身份 lookup resolver。服务类插件。 |
| `dsh-api-settings-controller` | `ctx.settingsController`：设置与凭据 Remote——脱敏读取、`update`/`replace`/`mutate` 写入、凭据 describe（secret 只进不出）。服务类插件。 |
| `dsh-api-workspace-controller` | `ctx.workspaceController` + `ctx.directoryPickerController`：Workspace 域 Remote——增删改排序、`follow()` 流（baseline + 增量、重连换代）。服务类插件。 |

## 17. host/ runtime-diagnostics/（8 包）

| 包 | 作用 |
|---|---|
| `dsh-host-webserver` | `ctx.webServer`：Web GUI 的 HTTP 传输（node:http）——exact/prefix 命名路由、upgrade 路由、单主 fallback 座位、`renderIndex` 变换 tap；仅 127.0.0.1/0.0.0.0，无 TLS。服务类插件。 |
| `dsh-host-frontend-static` | SPA dist 服务器：占据 fallback 座位，dist 根与 index 路径返回 `index.html`（注入 boot manifest），越界 403。函数插件。 |
| `dsh-host-plugin-inventory` | `pluginInventory`（Remote-only）：Loader 插件状态只读投影——条目 id、模块 specifier、启用态、root Fiber 相位。服务类插件。 |
| `dsh-host-directory-picker` | **Definition**：抽象 `ctx.directoryPicker`：`capability()` 返回判别联合 `native`（OS 选择器）/ `browse`（应用内浏览）。抽象服务类。 |
| `dsh-host-directory-picker-auto` | 启动时采样宿主情形（loopback、非 SSH、显示会话），在内存 Loader 树挂 `-native` 或 `-browse` 后端；模糊落 `browse`。函数插件。 |
| `dsh-host-directory-picker-browse` | **Provider**：应用内浏览后端（`list` 单层目录 + crumbs、`createDirectory` 单段名校验）。服务类插件。 |
| `dsh-host-directory-picker-native` | **Provider**：原生 OS 选择器（macOS osascript、Linux zenity、Windows koffi `IFileOpenDialog`）。服务类插件。 |
| `dsh-invariants` (runtime-diagnostics/invariants) | `ctx.invariants`：运行时不变量注册表——各包以 `./invariant` 伴生模块注册检查，在活组合内验证事件流与快照的关系；allowlist/blocklist 过滤。服务类插件。 |

## 18. boot/ bundle/ sdk/ examples/（13 包）

| 包 | 作用 |
|---|---|
| `dsh-app-boot` (boot/app-boot) | 纯库：`dsh` profile 共用 Loader 启动——加载 .env 层、组合 profile bundle 与 patch、fail-loud 启动并返回运行中 app；支持启动前预览配置。 |
| `dsh-cmdline` (boot/cmdline) | 纯库：launcher 把剩余 argv 以 `ctx.cmdlineArgs` 交给 app 树；`parseCmdline()` 让 app 发布自有服务（`webStartup` 等）供 `!!js` 惰性引用；`ctx.appExit`/`ctx.appReady`。 |
| `dsh-base` (bundle/base) | 纯 patch bundle：所有 base-backed profile 的第一层——模型接入 + 全套工具 + 持久会话 + 安全默认值（timer、llm、session、typert、agent 脊柱、全部工具插件、subagent providers、沙箱、settings/credentials、compaction、持久化/投影/遥测等约 80 行 patch）。 |
| `dsh-headless` (bundle/headless) | 一次性任务 bundle（`dsh --profile headless "<task>"`）：base 之上跑核心 Agent/Session，无 HTTP/浏览器；创建 Agent、打印结果、0/1 退出。函数插件。 |
| `dsh-web-app` (bundle/web-app) | 浏览器 GUI bundle（`dsh --profile web`）：base 之上 + 前端 dist 伺服 + 三个 api controller + host 层 + 约 35 个 `dsh-client-ui-*` 浏览器插件。函数插件。 |
| `dsh-acp-app` (bundle/acp-app) | 仅自动化的 ACP stdio 应用 bundle（over base）。函数插件。 |
| `dsh-sdk-app` (bundle/sdk-app) | SDK stdio 应用 bundle（over base）：解析命令行提供 `sdkAppStartup`，就绪后挂 JSON-RPC server。函数插件。 |
| `dsh-sdk-minimal` (bundle/sdk-minimal) | 独立最小 SDK profile：不叠 base，patch 即完整树——持久 shell + `str_replace_editor`、JSONL 持久化、danger-full-access，仅限隔离工作区。纯 patch。 |
| `dsh-sdk-protocol` (sdk/protocol) | 纯库：JSON-RPC 线协议（换行分隔 over 字节流）+ 全部 request/result/notification 类型，TS/Python SDK 共用。 |
| `dsh-sdk-client` (sdk/client) | 纯库：TS SDK 客户端 `DeepSeekHarness` 高层 API（spawn runtime、开 session、发 prompt、收集响应与事件流）。 |
| `dsh-sdk-jsonrpc-server` (sdk/server) | stdio JSON-RPC 服务插件：每 `sessionId` 一个 session、排队 prompt、回传事件与状态；stdout 专属协议帧。函数插件。 |
| `dsh-agent-spine-demo` (examples/agent-spine-demo) | 无 executor、无 UI 的 agent 脊柱 bundle 插件：内存 session + 回退标题 + provider 重试 + system prompt + bash/skill/jobs 工具 + turn loop；config 以用户语言给出。函数插件。 |

## 19. client/ — 浏览器端（43 包）

client 包为**双面结构**：`src/index.ts`（Node/Host half）+ `src/client/index.ts`（浏览器 half，经 `dsh.client` 清单动态加载）；均为函数插件（除注明外）。

**基础设施**：`dsh-client-web`（boot kernel：从 `window.__DSH_BOOT__` 构建模块系统、激活全部 client 插件、渲染 boot 页后交给 `ctx.uiRenderer.mount`，非插件）、`dsh-client-modules`（双面模块系统：Host 组合 boot graph 与 `/plugins`，浏览器 lazy-CJS 模块表作为 Loader 内部接缝）、`dsh-client-connection`（浏览器↔Host 线路层：Remote RPC 载体、连接代际重连、launch token 认证、反 DNS-rebinding）、`dsh-client-store`（纯库：React-free observable/snapshot-store 原语）、`dsh-client-hmr`（仅开发：client 插件热重载）、`dsh-client-locale`（`ctx.locale`：字典注册 + `t` 绑定，偏好存 settings）。

**渲染骨架**：`dsh-client-ui-slots`（纯库：slot 系统类型核心，`register({name,...}, Component)`）、`dsh-client-ui-renderer`（React slot 绑定/outlet、`ctx.uiRenderer.mount`、五个框架 hooks）、`dsh-client-ui-primitives`（纯库：共享 React 原子组件，模型输出安全处理）、`dsh-client-ui-session`（Session Controller 的 React/Slot 适配层）、`dsh-client-ui-layout`（三栏 AppFrame + `ctx.layout` 面板几何 + theme presenter）、`dsh-client-ui-theme`（light/dark/system、字号、`--dsw-*` token、防闪烁 bootstrap）、`dsh-client-ui-sidebar`（侧栏外壳：品牌行槽、New Session、折叠 rail）、`dsh-client-ui-brand-official`（official 构建时填品牌槽）。

**会话/对话**：`dsh-client-ui-conversation`（target-neutral 会话装配：`ctx.uiConversation` 事件/视图注册表、composer、提交队列）、`dsh-client-ui-chat`（Chat target：transcript 节点渲染、turn 折叠、滚动恢复）、`dsh-client-ui-tool`（tool-call 节点渲染，经 `tool.call.toolview` 槽分发到工具卡）、`dsh-client-ui-trajectory`（turn-aware 事件台账 + 时间轴 tab）、`dsh-client-ui-subagent`（子代理目录、按地址打开、继续路由）、`dsh-client-ui-workflow-run`（workflow 事件重建为独立 Chat 节点）、`dsh-client-ui-jobs`（会话 header 后台任务 popover）。

**输入/引用/命令**：`dsh-client-ui-input-trigger`（`/` 与 `@` 触发菜单管线）、`dsh-client-ui-commands`（客户端命令面：`ctx.commandUi`、三种分发形态）、`dsh-client-ui-reference`（统一 `@file`/`@session` 引用源）、`dsh-client-ui-skill`（技能引用菜单 + 技能调用卡）、`dsh-client-ui-attachment`（草稿图片条、拖放、lightbox）、`dsh-client-ui-deliverables`（turn 结束产出文件行 + inline-code 文件引用）。

**交互/状态**：`dsh-client-ui-approval`（审批 UI：接管 composer 呈现权限请求并回传决定）、`dsh-client-ui-user-questions`（`ask_user_question` 逐题问答面）、`dsh-client-ui-plan`（plan 模式状态芯片）、`dsh-client-ui-goal`（GoalBar + `/goal` 命令气泡）、`dsh-client-ui-message-feedback`（Like/Dislike + 备注）、`dsh-client-ui-model-selection`（`/model` popup + composer 模型座位）、`dsh-client-ui-permission-presets`（权限预设设置行 + 会话切换选择器）、`dsh-client-ui-agent-preset`（预设选择 chip + 名册管理）。

**设置域**：`dsh-client-ui-settings`（基座：`ctx.settingsScope` 文档镜像 + `ctx.settingsSchema`，声明 settings 槽类型）、`dsh-client-ui-settings-general`（设置面板外壳 + General 区 + onboarding 流水）、`dsh-client-ui-settings-models`（Models 页：provider 行、API key 管理、模型列表编辑）、`dsh-client-ui-settings-plugins`（每 Host 插件一张配置卡，revision fence 写入）、`dsh-client-ui-settings-plugin-inventory`（只读 Plugin list tab）。

**Workspace/目录选择**：`dsh-client-ui-workspace`（sidebar Session 行 + WorkspacePicker）、`dsh-client-ui-directory-picker-browse`（Miller-column 应用内目录对话框）、`dsh-client-ui-directory-picker-native`（renderless 原生选择器驱动）。

## 20. extensions/ experimental/ test-support/（18 包）

| 包 | 作用 |
|---|---|
| `dsh-tool-cordis` (extensions/tool-cordis) | 模型面自指 Cordis 工具集：`cordis_define`/`cordis_run`/`cordis_stop`/`cordis_undefine` 等 7 个工具，让模型定义-运行动态插件包（仅进程内存）。函数插件。 |
| `dsh-cordis-host-runner` / `dsh-cordis-client-runner` | 动态双半包的 Host/浏览器运行时：`node:vm` 跑 host half、浏览器 half 需用户批准后加载；重启即清空。服务类 / 函数插件。 |
| `dsh-client-ui-cordis` | 动态 Cordis 包的浏览器 UI：全局定义面板 + 工具卡 + `@pluginId` 输入源。函数插件。 |
| `dsh-experimental-agent-team` | `ctx.agentTeams`：Agent Teams 域服务——Lead + 具名 teammate、durable 离线消息队列、共享任务 DAG 看板（experimental）。服务类插件。 |
| `dsh-experimental-tool-agent-team` | Team 模型工具集（10 个工具：建 teammate、发消息、任务板管理）。函数插件。 |
| `dsh-experimental-agent-team-profile` / `dsh-experimental-agent-team-web-profile` | 纯 patch profile：base 之上挂 Team 域 / web 之上加 Team UI。 |
| `dsh-experimental-client-ui-agent-team` | Team 的 Web UI（名册、任务板、teammate 导航）。函数插件。 |
| `dsh-experimental-inspector` | 跨 realm CDP 调试枢纽：在 Chrome DevTools 检视运行中的 Host 与 Client。函数插件。 |
| `dsh-experimental-webworker-runtime` / `dsh-experimental-webworker-packer` | 纯浏览器 harness 运行时（插件树跑在 Web Worker + Node 兼容层）/ 构建期 profile 打包器（gzip tar 镜像）。纯库。 |
| `dsh-agent-loop-testkit` (test-support) | 纯库：测试真实 AgentLoop 的标准前置服务一键挂载。 |
| `dsh-client-test-runtime` | 纯库：jsdom 槽测试运行时（真实 Cordis Context + SlotRegistry + controller 测试替身）。 |
| `dsh-llm-mock-server` | 纯库 + CLI：可脚本化的 OpenAI 兼容故障服务器（流重置/停滞/限流/5xx），免 key 测重试退避。 |
| `dsh-llm-replay` | 回放 LLM 插件：短路 `llm/stream`，把录制的 `assistant/chunk` 重建成 chunk 流；快照套件与 e2e 的免 key 模型源。函数插件。 |
| `dsh-loader-smoke` | 纯库：免 key 冒烟测试 harness——经 Cordis Loader 跑真实 bin 与 cordis.yml。 |
| `dsh-session-snapshot` | 纯库：`test:snapshot` 共享核心——manifest、脱敏、归一化、协议适配器（仅 vitest 内可用）。 |

## 21. util/（9 包，全部纯库非插件）

`dsh-atomic-write`（原子文件替换 + 跨进程 writer lock）、`dsh-brand`（`Branded<B>` 名义类型）、`dsh-util-crypto`（浏览器安全 UUID）、`dsh-home-paths`（Harness home 解析与 watch 路径规范化）、`dsh-launch-environment`（启动环境分层快照：进程环境 > 调用目录 .env > home .env）、`dsh-native-command`（无 shell 原生命令与路径打开）、`dsh-output-retention`（有界保留原语 `ItemRetainer`/`TextRetainer`）、`dsh-timeout`（`clampTimeout` 与 deadline 融合）、`dsh-util-workspace-path`（Workspace 路径助手）。

## 22. apps/（2 个 launcher，非插件）

- `apps/cli` — `dsh` CLI launcher（`--profile` 选择 bundle 启动；profile 包括 headless/web/acp/sdk/sdk-minimal）。
- `apps/web` — Web 前端 Vite 入口（驱动 `dsh-client-web` 的 boot kernel）。

---

## 结构观察

1. **capability seam 三分**是主导模式：`fs`、`shell`、`subprocess`、`terminal`、`sandbox`、`codeRuntime`、`lsp`、`llm`、`sessionPersistence`、`sessionProjection`、`sessionTitle`、`sessionTelemetry`、`sessionQuery`、`compaction`、`fileReferences`、`subagents`、`workflowEngine`、`jobs`、`spillStore`、`storage`、`settings`、`credentials`、`skills`、`web`、`attachments`、`directoryPicker` 等约 27 条缝，每条都是 Definition / Provider / Consumer 完整三角——**替换插件时以缝为单位**：保住 Definition 的服务名与事件词表，Provider/Consumer 可整体换。
2. **组合入口在 bundle/**：`dsh-base` 是全部产品 profile 的公共层，headless/web/acp/sdk-app 叠在其上，sdk-minimal 独立成树。CLI/Desktop UI 的新组合应以新增 bundle + cordis.patch.yml 挂接。
3. **模型面工具**（`tool-*` 包）约 30 个：bash、pwsh（含 persistent）、read/write/edit/read_image、glob/grep、str_replace_editor、web_search/web_fetch、skill、lsp、subagent 系列、workflow、ralph、todo_write、ask_user_question、job_*、terminal_*、schedule_*、session_*（查询）、goal 三件套、cordis_* 系列等。
4. **每个包都有 `src/invariant.ts`** 伴生（向 `ctx.invariants` 注册检查），是仓库约定，不是功能插件。
