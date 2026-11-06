# Home-write sandbox mode — design proposal

> **2026/11/06（DH-902）：`home-write` 已禁用。** 本文是实现前的设计记录，不再代表当前可选行为；入口与使用入口的禁用点、恢复命令与回滚方式见 [home-write-disabled.md](home-write-disabled.md)。

Status: **decisions accepted; implementation follows this document.**
Audience: the person who will approve the open defaults and the implementation constraints.

## 0. 结论摘要

- 模式名：**`home-write`**（中文称“家目录可写”）。
- 可写区：当前用户的 canonical home；其他路径默认只读。
- 覆盖规则：`force-read-only（更具体） > home-write（home/显式例外） > 默认只读`。
- 强制只读清单位于 `@deepseek-ai/dsh-sandbox-policy` 的部署配置；**v1 建议只做部署级清单，不做每工作区合并**，如果必须做，再增加工作区级 map（见待拍板项）。
- 三处执行面不能在所有平台做到完全一致：
  - in-process fs fence：可以精确实现。
  - Linux bwrap / macOS Seatbelt：可以表达“home 可写 + 指定子树只读”。
  - Linux Landlock：只能加写允许，不能表达子树 deny；有强制只读清单时必须 fail closed。
  - Windows ACL：只能给一个 workspace root 加写 ACE，不能表达子树 deny 或额外根；有强制只读清单时必须 fail closed。
- 现有 `read-only` / `workspace-write` / `danger-full-access` 语义不变。

## 1. 模式语义

```text
mode: home-write

writable = canonical(current user's home)
           ∪ configured temp exceptions
           (and nothing else by default)

denied = all other paths
force-read-only = configured absolute paths inside or outside writable;
                  a match always denies, even under home.
```

- 不隐式授予 `/tmp`、`/var/tmp`、网络盘、其他用户目录、当前 workspace（如果 workspace 不在 home 下）。
- 路径优先级按最长匹配：
  1. 目标命中任一 `force-read-only` 根（含其子路径）→ 拒绝；
  2. 否则命中 home 或配置的 temp/extra 根 → 允许；
  3. 否则拒绝。
- 因为只有“home 可写 + 强制只读”两层，强制只读总是压过 home；不需要“可写子例外”，也不提供“在强制只读目录里再开一个可写子目录”的语义（否则会变成第三层规则，见待拍板项）。
- 所有比较使用 canonical realpath；子路径/父路径同时命中时取更具体的那条。实现上应保存“canonical root + 匹配长度”，而不是简单字符串前缀。

## 2. 平台矩阵

| 平台 / 后端 | home-write 无强制只读 | home-write 有强制只读 | 备注 |
|---|---|---|---|
| in-process fs fence（`fs-sandbox`） | 可精确执行 | 可精确执行 | 唯一可以完整实现优先级的一层 |
| Linux bwrap | 可执行 | 计划用 `--bind home` + `--ro-bind force` 表达 | 需要真实 bwrap e2e；重叠 bind 的行为要在实现前验证 |
| Linux Landlock | 可执行（home + temp） | **fail closed** | Landlock 是 allow-list，没有 deny/subpath 规则 |
| macOS Seatbelt | 可执行 | 计划用 allow + `(deny file-write* (subpath ...))` 表达 | 需要在 macOS 上验证 SBPL 的 deny 优先级 |
| Windows ACL | 可执行（把 home 当 workspace root 授权） | **fail closed** | ACL restricted token 不支持额外根，也没有可靠的子树 deny |
| `danger-full-access` | 不适用 | 不适用 | 不受此模式影响 |

> Windows ACL 当前连 `additionalWritableRoots` 都明确拒绝；`home-write` 不能伪装成“多根 ACL”能力。`home-write` 在 Windows 上只能是“一个 home root + private temp”，并且强制只读清单非空时拒绝启动该策略。

## 3. 路径解析、符号链接与 Windows 别名

实现前必须统一一个 canonicalization 入口：

- 目标路径：解析 deepest existing ancestor 的 realpath，再拼回不存在的叶子；不允许用未解析的显示路径做授权判断。
- home / 配置根：load 时解析；无法解析的配置根条目应使策略加载失败（或至少该条目不生效并告警；见待拍板项）。
- 符号链接/junction：解析后比较；如果 home 内的一个软链指向 `/etc`，目标 canonical 路径不在 home 下，默认拒绝。
- 大小写：Windows 比较使用 case-insensitive；Linux/macOS 按平台语义。
- 8.3 短名：不能只靠字符串比较；需要 Windows long-path 规范化（`GetLongPathNameW` 或等价）后再比较。若主机无法规范化，按 fail closed 处理，不做“看起来一样就放行”。
- UNC：`\\server\share` 不应当被当成普通本地 home；见待拍板项。

## 4. 与现有机制的关系

### `workspace-write`（保持不变）

- 可写：session 的 immutable cwd、`additionalWritableRoots`、后端 temp 区域。
- 它不以 home 为边界；如果 workspace 在 home 外，它仍写 workspace。
- 它不提供强制只读子树（除平台自身限制外）。

### `home-write` 与 `workspace-write`

- `home-write` 是另一种**显式授权模型**：以 home 为可写区，不以 session cwd 为可写区。
- 如果 workspace 在 home 外：`home-write` 默认**不能**写 workspace；需要用户显式配置一个例外（见待拍板项），或使用 `workspace-write`。
- 两种模式都保留 `workspaceRoot` 作为 session 上下文；`home-write` 的授权根是 `homeWriteRoot`，不是 `workspaceRoot`。

### `fsAdditionalWritableRoots`（DH-718，进程内 fence 专用）

- 它当前只给 in-process fs fence 用，**不进入 shell/terminal**。
- 建议：`home-write` 下**不合并** `additionalWritableRoots` / `fsAdditionalWritableRoots`；它们只属于 `workspace-write` 的授权模型。
- 否则会出现“fs 工具能写注册工作区，但 shell 不能”的第二套授权模型，正好违反本需求的“三处一致”目标。
- 如果确实需要在 home-write 下给某个路径写权限，使用 `homeWriteExtras`（本设计新增，见待拍板项），并明确它同时对三处生效（或明确只做 fs，不做 shell）。

### 与 `sandbox_permissions` 升级路径

- 建议把 `home-write` 加入 escalation target 词汇，但只允许从 `read-only` 升级到它：
  - `read-only -> workspace-write | home-write | danger-full-access`
  - `workspace-write -> danger-full-access`（`home-write` 与 workspace-write 在 workspace 位于 home 外时不可比较，不能声称“更宽”）
  - `home-write -> danger-full-access`
- 因此从 `workspace-write` 不能通过 `sandbox_permissions` 切到 home-write；要切换需改 session 模式/配置，工具必须明确说明原因。

## 5. 三处执行面

1. **in-process fs fence**
   - 增加“先查 read-only 规则，再查 writable 规则”的路径判定函数。
   - 使用 canonical target + 最长匹配；返回 deny 原因时可区分 `force-read-only` 与 `not-home`。
2. **shell / terminal 后端**
   - `sandbox-local` 的 platform profile 在 `home-write` 下使用 home 作为授权根；有强制只读清单时：
     - bwrap：按“先 bind home，再 ro-bind 每个 force 根”生成；需要验证重叠 bind。
     - Landlock：拒绝（`SANDBOX_UNSUPPORTED_POLICY`）。
     - Seatbelt：allow home + deny force 子树。
     - Windows ACL：拒绝（有 force 清单）；无 force 清单时把 home 当 workspaceRoot，private temp 仍在外部（见待拍板项）。
3. **`sandbox_permissions` 提示**
   - 更新 `ESCALATION_TARGETS`/`WIDER_MODES`，让模型看到可用目标；
   - 从 workspace-write 请求 home-write 时返回明确错误（不可比较），不要静默降级；
   - 拒绝的提示必须说明哪一层拒绝（argument / policy / backend / approval）。

**不能做到一致的地方**应显式 fail closed，而不是“尽力而为地放行”：
- Landlock + force-read-only；
- Windows ACL + force-read-only；
- 任何无法 canonicalize 的路径。

## 6. 配置入口与选择

建议的 schema（名字可在拍板后调整）：

```yaml
- id: sandbox-policy
  config:
    mode: home-write
    # default os.homedir(); only for explicit deployment override/tests
    homeWriteRoot: /home/alice
    # default [] (see open decision)
    homeWriteTempRoots:
      - /tmp
    # force read-only; absolute, canonicalized at load
    homeWriteReadOnlyRoots:
      - /home/alice/.ssh
      - /home/alice/.gnupg
      - /home/alice/.config/gh
```

- 部署默认：`sandbox-policy.mode`。
- 每会话：现有 `sandbox/mode` 事件；同时增加一个权限 preset（例如 `home-write`）以便 UI `/permission` 选择。
- 每工作区：**v1 建议不做**。当前 sandbox 配置没有 workspace registry 注入，强行做会产生“哪份清单优先”的额外模型；见待拍板项。
- 配置文件：profile 的 `cordis.yml` / `cordis.patch.yml` 中 `sandbox-policy` 行；不要把清单写进 workspace 文件。
- 强制只读清单不设默认值（建议空）还是给安全默认清单（如 `~/.ssh`）？见待拍板项。

## 7. 失败与兼容策略

- 现有 `read-only` / `workspace-write` / `danger-full-access` 不变。
- 任何后端不支持当前策略（尤其 force-read-only）→ **fail closed**，不降级到 workspace-write/danger。
- 策略加载时校验：
  - home 根绝对路径且可 canonicalize；
  - force 根绝对路径；无法 canonicalize 时拒绝加载或告警（见待拍板项）；
  - temp/extra 根不得在不支持的后端静默忽略。
- 模型收到的策略说明必须区分：
  - `home-write` 可写 home；
  - 哪些路径被强制只读；
  - 实际后端是“完整”还是“部分/不可用”。

## 8. 测试计划（实现后）

- pure path-priority unit tests：父/子、force 在 home 内外、大小写、符号链接、缺失路径。
- fs fence tests：允许 home、拒绝 `/etc`、拒绝 `~/.ssh`、允许 home 其他子目录。
- sandbox-local profile tests：
  - bwrap profile 字符串/参数顺序；
  - Seatbelt profile deny 顺序；
  - Landlock/Windows ACL 遇 force-read-only 抛 unsupported；
  - Windows ACL 无 force 时 home 作为 workspace root。
- config/policy tests：mode 解析、per-session mode、preset catalog、escalation targets。
- 原生/平台 e2e：
  - Linux 上真实 bwrap（若可用）和 Landlock；
  - macOS 上 Seatbelt；
  - Windows 上真实 ACL + junction/8.3/其他盘符；如果当前环境没有 Windows，只能做逻辑覆盖并明确标注“未实机验证”。

## 9. 已拍板（2026-11-06）

- Q1 = B：只认 `C:\Users\<user>`；其他盘符/UNC/home 在其他位置必须显式 `homeWriteRoot`。
- Q2 = B：Linux 默认只放行 `os.tmpdir()`。
- Q3 = B：Windows private temp 移到 `~/.dsh/tmp`。
- Q4 = 默认启用安全清单；新增审批工具增删条目，变更持久化/审计/可回滚。
- Q5 = 不支持的后端 fail closed。
- Q6 = `additionalWritableRoots` / `fsAdditionalWritableRoots` 不混入 home-write。
- Q7 = 默认拒绝符号链接；opt-in 允许但 canonical 目标必须在可写区；全局开关可封死。
- Q8 = v1 不做每工作区覆盖。
- Q9 = `workspace-write -> home-write` 允许；但 canonical workspace 在 home 外时拒绝并说明（不是静默平移）。
- Q10 = 模式字符串 `home-write`，中文「用户区可写」。

Linux 实测（2026-11-06）：`bwrap 0.12.0` 存在且可正常创建 profile / 写入；当前后端选择是 **bwrap 优先**，不是 Landlock。Landlock 仍是回退路径，遇到非空 force-read-only 清单必须 fail closed。

### 已定实现细节

- 默认强制只读清单：`~/.ssh`、`~/.gnupg`、`~/.aws`、`~/.config/gh`、`~/.kube`、`~/.docker`。
- 审批工具：`sandbox_home_readonly`，动作 `list` / `add` / `remove` / `rollback`；add/remove/rollback 都走 `ctx.approval`，remove 的提示直接说明“该路径将变为可写”。工具只能改 `homeWriteReadOnlyRoots`。
- 审计：profile patch 旁的 `sandbox-home-readonly-audit.jsonl`，记录 actor、时间、动作、路径、before/after、justification；`rollback` 恢复上一条的 before。
- 符号链接：默认拒绝；`homeWriteAllowSymlinkedRoots` 才允许，且 canonical 目标必须在 home/临时例外内；全局开关关闭时工具也无法绕过。
- `workspace-write -> home-write`：canonical workspace 不在 home 下时拒绝并说明“会丢失 workspace 写权，需显式切换 session mode”，不做静默平移。

原待拍板清单保留在下方，作为决策记录。

## 9. 需要你拍板的清单

### Q1. Windows 其他盘符 / UNC / home 不在 C:

**问题**：字面规则是 `C:\Users\<user>` 可写；但 `os.homedir()` 可能在 D:、UNC 或漫游配置中。

**选项**

- A. 永远以 canonical `os.homedir()` 为可写 home（即使 home 在 D: 或 UNC）；其他盘符仍只读。
- B. 只允许系统盘上的 `C:\Users\<user>`；home 在其他位置时 `home-write` 不可用，除非显式配置 `homeWriteRoot`。
- C. 只有本地固定盘；UNC/网络盘默认强制只读，必须配置显式例外。

**倾向**：B + 显式 `homeWriteRoot` 覆盖。理由：与用户给的 Windows 语义一致；漫游/UNC 家目录的安全边界由用户明确 opt-in。
**不决定的后果**：`home-write` 在 Windows 上可能默认拒绝整个 home，或在 UNC 上错误地允许写网络共享。

### Q2. Linux `/tmp`、`/var/tmp`、`/run/user/<uid>` 是否默认放行

**问题**：严格只读会让编译/包管理器失败。

**选项**

- A. 默认全部只读；用户必须配置 `homeWriteTempRoots`。
- B. 默认只放行 `os.tmpdir()`（通常是 `/tmp`）。
- C. 默认放行 `os.tmpdir()` + `/tmp` + `/var/tmp` + `/run/user/<uid>`。
- D. 默认放行以上三项，但 bwrap 下使用 ephemeral tmp（不持久）。

**倾向**：B。只给进程实际 temp 一个默认例外，避免用户开箱即死，同时不把 `/var/tmp` 和 XDG runtime 全部放开。
**不决定的后果**：默认全只读会让 npm/cargo 等工具直接失败；默认全放行会偏离“其余一律危险区”的承诺。

### Q3. Windows temp

**问题**：Windows ACL 后端当前总是创建 private temp 目录并授权；home-write 若严格按“home 外只读”，这个 temp 是额外可写区。

**选项**

- A. 保持 private temp（作为 Windows 的隐式例外），文档说明。
- B. private temp 放到 home 内（例如 `~/.dsh/tmp/...`），home 外无例外。
- C. 没有显式 temp 例外时拒绝 home-write on Windows。

**倾向**：B（如果 ACL 能在 home 内创建带继承 ACE 的 private temp），否则 A 并在策略说明中明确例外。
**不决定的后果**：用户会看到一个未声明的 home 外可写目录，或 home-write 在 Windows 上不可用。

### Q4. 强制只读清单的配置位置与默认值

**选项**

- A. 只在部署级 `sandbox-policy` 配置；默认空；用户可自己加。
- B. 部署级 + 每工作区 map；合并为 union；更具体者优先。
- C. 每会话事件携带清单（需要扩展 `sandbox/mode` 事件/projection）。

**倾向**：A（v1），并附一份可选“安全起步清单”文档（`~/.ssh`、`~/.gnupg`、`~/.aws`、`~/.config/gh`、`~/.kube`、`~/.docker`），但不自动启用。
**不决定的后果**：如果做成三种入口，合并优先级和持久化会显著增加实现/测试面，且容易与 workspace registry 冲突。

### Q5. 三处执行面：严格 fail closed 还是尽力而为

**选项**

- A. 严格：Landlock/Windows ACL 遇到强制只读清单直接拒绝；bwrap/Seatbelt/fs fence 完整支持。
- B. 尽力而为：不支持的层忽略强制只读清单（危险）。
- C. 按后端降级到只读模式（用户会失去写权限但不会误写）。

**倾向**：A。安全语义不能被“尽力而为”悄悄放宽。
**不决定的后果**：B 会出现“fs 工具拒绝但 shell 能写”的漏洞；C 会让用户以为 home-write 生效但实际不可写。

### Q6. `additionalWritableRoots` / `fsAdditionalWritableRoots` 在 home-write 下

**选项**

- A. 不合并；它们只属于 workspace-write。
- B. 合并为 home-write 的额外可写根，但需要三处后端都支持。
- C. 仅 fs fence 合并（继承 DH-718），shell 不合并（两套模型）。

**倾向**：A。避免两套授权模型；如果确实需要额外根，新增 `homeWriteExtras` 并明确三处支持。
**不决定的后果**：C 会造成 shell 和 fs 的权限不一致；B 会让 home-write 的“其他只读”承诺变得不可解释。

### Q7. 强制只读清单的加载失败策略

**选项**

- A. 配置中有任何条目无法 canonicalize/不存在 → 策略加载失败，不允许启用 home-write。
- B. 跳过坏条目并告警；其余条生效。
- C. 只允许已存在物理路径，符号链接一律拒绝。

**倾向**：A + C 的组合：配置根必须是绝对、物理、可解析；加载时失败，避免“本该只读却没生效”。
**不决定的后果**：跳过坏条目会让用户以为凭证目录被保护，实际没有。

### Q8. 每工作区覆盖

**问题**：用户提到“某个特定 checkout 不想让它被改”，这听起来像每工作区规则。

**选项**

- A. 不做；用全局清单 + 绝对路径指定 checkout。
- B. 部署配置增加 `workspaces: { <path>: [roots] }`，按 canonical workspace path 合并 union。
- C. 每个 workspace 配置文件（需要 registry/存储支持）。

**倾向**：A（v1）。路径清单本身已经可以点名 checkout；B 会引入“workspace 路径变化/重名”和 registry 依赖。
**不决定的后果**：如果用户明确要 per-workspace 自动继承，后续需要新增配置模型和测试。

### Q9. Escalation

**选项**

- A. `home-write` 只作为配置/session 模式，不进入 `sandbox_permissions` target。
- B. 进入 target，只允许 `read-only -> home-write`；`workspace-write` 不能升级到它。
- C. 把 home-write 当成比 workspace-write 更宽（会错误地放宽 workspace 外的情况）。

**倾向**：B。它给 read-only 会话一个可审批的出口，同时不声称与 workspace-write 可比。
**不决定的后果**：用户从 workspace-write 请求 home-write 时可能得到模糊错误，或模型把 home-write 当成通用升级。

### Q10. 名字

- 建议：`home-write`（短、与 `workspace-write` 同构）。
- 备选：`user-home-write`、`home-writable`。
- 不决定的后果：模式字符串进入 session 日志/preset/config，改名要迁移。

## 10. 非目标

- 不改变 `read-only` / `workspace-write` / `danger-full-access`。
- 不做网络/进程可见性限制。
- 不自动把 `/tmp` 或其他系统目录纳入可写区。
- 不把 home-write 变成“home + 任意 workspace”的混合授权；workspace 在 home 外需要显式例外或使用 workspace-write。
- 本轮不写代码、不跑实现构建/测试；只提交设计供拍板。

## 11. 下一步

1. 用户逐条确认 Q1–Q10（尤其 Q2/Q4/Q5/Q6）。
2. 确认后按以下顺序实现：
   - policy/schema + path priority；
   - fs fence；
   - 后端（先 Linux bwrap/Landlock，再 Seatbelt，Windows ACL 逻辑/实机分开）；
   - escalation/settings；
   - 测试与平台标注。
3. 若 Q4 选择多入口或 Q8 选择 per-workspace，需要另写迁移/配置合并设计，不作为 v1 隐含行为。

## 12. 实现状态（2026-11-06）

已实现：

- `SandboxMode` / policy config / session mode / permission preset 增加 `home-write`；
- policy 解析 home、默认安全清单、`os.tmpdir()`（Linux）和 Windows 空 private-temp 默认；
- fs fence 的“force-read-only > home/temp > deny”优先级；
- bwrap profile：home/temp bind + force-read-only ro-bind；
- Landlock：force-read-only 非空时 fail closed；
- Seatbelt：allow home/temp + deny force 子树的 profile（未在 macOS 实机验证）；
- Windows ACL：home 作为 workspace root，private temp 在 `~/.dsh/tmp`；force-read-only 非空时 fail closed（未在 Windows 实机验证）；
- `sandbox_permissions`：read-only/workspace-write → home-write 的升级表；workspace 在 home 外时明确拒绝；
- `sandbox_home_readonly` 审批工具：add/remove/rollback + approval + configEditor 持久化 + JSONL 审计；
- 默认清单与 symlink opt-in 的 policy/tool 测试。

验证：

- sandbox/sandbox-policy/sandbox-local/fs-sandbox/permission-presets/ui-permission-presets：**268 pass**；
- home-write tool tests：**3 pass**；
- typecheck 5/5；build 10/10；
- Linux 真实 bwrap 手工 probe：home 写入成功、force-read-only 子目录 EROFS、`/etc` EROFS；当前机器 `bwrap 0.12.0` 可用，后端选择为 bwrap，不是 Landlock。

仍为逻辑覆盖、未实机验证：

- macOS Seatbelt 的 deny 优先级与真实内核行为；
- Windows ACL 的 home 授权、junction/8.3/其他盘符/UNC 行为、private temp DACL；
- Windows ACL 无法表达 force-read-only：默认清单非空时 home-write 在 Windows 上会 fail closed；要使用必须由部署显式清空清单（不建议）或等待 ACL deny 实现。
