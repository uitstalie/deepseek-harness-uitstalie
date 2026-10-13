# task28 — PowerShell 工具描述审计（依据 KB 踩坑文档）

## requirement

用户要求（2026/10/12）：阅读 `D:\dqc\kb-llm\KB-LLM-Deploy\deepsekvspowershell.md`（DSH × PowerShell 的实战踩坑记录，来自 `task/0037`–`task/0040` 的 KB 检索改造），审计**我们模型可见的 pwsh 工具描述**，判断是否需要升级。本任务单只做**审计与提案**；拿到用户批准前不改任何原生文件。

## 被审计的对象

| 面 | 位置 | 现状 |
|---|---|---|
| 工具描述（每次调用都进上下文） | `packages/shell/tool-pwsh/src/index.ts:123-151` `pwshDescription()` | 基础 9 句 + Windows 沙箱 3 句 |
| 系统提示段 `tool:pwsh` | 同文件 `:266-271` | 非零退出的 `[exit code: N]` 标记 + "被杀的裸 exit 1 视为中断" |
| 姊妹工具的风格基准 | `packages/shell/tool-bash/src/index.ts` `bashDescription()` | **只放"方言级"规则**（bash 那条是 `${VAR:?}`），不是踩坑大全 |

**风格判据**：这类描述是每轮都在上下文里的契约面，因此只收"不写就会静默做错/做反"的**方言级**规则；情境化的操作经验（ssh / scp / 进程计数 / 编码）应走按需加载的 skill，不进描述。

## 逐条对照（KB 教训 → 我们的覆盖情况）

| # | KB 教训 | 我们的描述 | 判断 |
|---|---|---|---|
| 1 | **引号与解析**：`git commit -m "中文…"` → `pathspec '有' did not match`；嵌套引号 / 中文全角引号 → ParserError；here-string 会插值且 `\$VAR` 不是转义；`python -c "…"` 双层解析 | ✗ 未覆盖 | **要加**（本会话因此带失败提交两次、生成过"路径全空"的脚本） |
| 2 | **bash 惯性**：`2>/dev/null`、`> /dev/null` 被解析成 `D:\dev\null`；没有 heredoc；双引号里 `\n` 是字面量（要 `` `n ``） | ✗ 未覆盖 | **要加**（静默写错目标 / 直接解析失败） |
| 3 | **`.Replace()` 静默不匹配**：没匹配上原样返回、不报错；且 PowerShell 直接改文件会绕过 read-before-edit，后续 `edit`/`write` 报 "file changed since it was read" | ✗ 未覆盖 | **要加**（本会话"以为改了，其实一个字没改"） |
| 4 | **退出码**：原生命令非零时 PS 既不中断也不让调用失败；`Select-String` 只留匹配行 → 失败用例名与 `error TS` 被过滤掉，于是"带着失败提交" | 部分（系统提示只说标记会报告，未说"不会中断/不会失败"） | **要加**（一句话） |
| 5 | Python 中文输出要 `$env:PYTHONIOENCODING='utf-8'` | ✗ | 不进描述 → skill |
| 6 | `Set-Content` 写 CRLF，推到 Linux 的 `.sh` 报 `\r: command not found` | ✗ | 不进描述 → skill |
| 7 | 长任务 `nohup … &` + 轮询日志；别让一条命令挂 10 分钟 | ✓ 机制已覆盖（`run_in_background`；前台超时转后台 job） | 不加 |
| 8 | `ssh` 单/双引号语义完全不同（双引号本地先展开 `$HOME` / 甚至执行 `$(id -u)`）、`-o BatchMode=yes -o ConnectTimeout=20` | ✗ | 不进描述（本机 pwsh 的描述不该塞远端 ssh 语义） → skill |
| 9 | `scp` 到 `~/` 的 realpath 报错要先 `mkdir -p`；`pgrep -f` 自我匹配；`grep -c` 数的是行不是进程 | ✗ | 不进描述 → skill |
| 10 | 找文件/搜内容优先 `glob`/`grep` 工具 | ✓ 骨架提示已覆盖（"Use the glob tool — not shell find" 等） | 不加 |
| 11 | ConstrainedLanguage（`.NET` 静态调用 / `Add-Type` / COM 失败）、命名管道 EPERM | ✓ 已在描述尾段（Windows 沙箱） | 保留 |
| 12 | 删除/移动前核对解析后的绝对路径；不要给 `$HOME` 等自动变量赋值 | ✓ 已在描述 | 保留 |

## 结论：**需要升级，但只升级方言级的两条（建议加 2 句，约 60 词）**

建议文本（英文，与现有句子同一风格；插在 `$env:NAME` 那句之后、`Managed $env:DSH_*` 之前）：

```
PowerShell re-parses the command line and is not bash: put quoted, multi-line, or `$`-bearing text in a file and pass
the path (`git commit -F msg.txt`, `python script.py`); `2>/dev/null` targets `D:\dev\null` (write `2>$null`), heredocs
do not exist, and `\n` inside double quotes is literal (write `` `n ``).
A native command's non-zero exit neither stops the chain nor fails this call — check `$LASTEXITCODE` when its result
decides the next step — and `String.Replace()` returns the input unchanged when nothing matches, so prefer the `edit`
tool or assert the match count first.
```

- 第 1 句覆盖 KB §1/§4/§8（引号、重定向、heredoc、反引号转义）；
- 第 2 句覆盖 KB §3/§5（静默不匹配、退出码不传播）；
- 长尾（ssh 语义、scp、进程计数、编码、CRLF）建议落成**分支自有 skill**（新增文件、非原生改动、按需加载），或保留在 KB 文档里由用户按需查阅。

## 若批准的改动面与验证

| 面 | 动作 |
|---|---|
| 原生源码 | `packages/shell/tool-pwsh/src/index.ts` 描述文本；按分支规则带 `uitstalie-` 标记并在本任务单登记 |
| 原生文档 | `packages/shell/tool-pwsh/README.md` + `.zh.md`（README 明确写了"the tool also teaches … in its description"，需同步）+ 重录 `README.i18n.yaml` |
| 生成物 | `pnpm run gen-tool-catalog` 重生成 `docs/tool-catalog.md`；把新句镜像进 `docs/tool-catalog.zh.md`；重录 `docs/tool-catalog.i18n.yaml` |
| 快照 | `pnpm run test:snapshot:refresh`（**keyless**）刷新 `snapshots/session/pwsh-tool-turn/tool-schemas.expected.json`，随后 `pnpm run test:snapshot` 复跑 |
| 验证 | `pnpm exec vitest run packages/shell/tool-pwsh`；`tsc` 两面；`pnpm run test:docs`；`pnpm run verify-tool-catalog` |

**成本提示**：这两句会让每次请求的工具描述增加约 60 词（≈ 90 token，现有描述约 250 token，增幅约 35%）——按"不写就会做错"的判据，值得；若嫌重，可只加第 1 句（引号/重定向），把退出码那句并进系统提示段。

## 状态

**待用户批准**（模型可见契约改动 + 原生文件）。批准后按上表执行并回填结果。