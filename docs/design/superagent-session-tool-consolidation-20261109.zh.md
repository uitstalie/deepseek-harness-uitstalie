# Super agent Session 工具合并评估（2026-11-09）

[English](superagent-session-tool-consolidation-20261109.md) | 中文


## 结论

**只建议评估 B：合并 workspace 登记与 Session 生命周期；不建议现在直接做 A（四组全部合并）。** 如果当前没有模型误用或 token 预算的实测问题，优先保持现状。B 的收益是同一工作区身份与 Session 生命周期可在一个入口发现，但它仍是破坏性工具面变更，不能靠一个大型 `action` 字符串参数代替既有校验。

本评估基于当前源码与测试，未改运行代码，未提交或 push。

实现状态（2026-11-14）：B 已在 `personality-rewrite-20261113` 实现；本文保留当时的评估，并以下面的现状为准。

## 1. 现状清单（B 已实现，tag `personality-rewrite-20261113`）

原来的四组工具是合并前的状态。B 已实现：三个模型入口，全部在 `packages/jira/jira-agent/src/superagent.ts` 声明，经 `createSuperagentContribution` 按角色注册，共享 `SUPERAGENT_OUTPUT_SCHEMA` 与 `ToolValue` envelope。

### `superagent_control`

- 16 个动作：`roster`、`orphans`、`ensure`、`remove_workspace`、`rename_workspace`、`start`、`append`、`prompt`、`list`、`inspect`、`stop`、`abort`、`fork`、`archive`、`compact`、`delete`。
- workspace 与 Session 生命周期共用一个入口；`runWorkspaceTool`、`runSessionTool` 仍是内部行为 owner。
- 动作级必填字段仍一次性聚合校验；`ToolValue` envelope、`READ_ONLY_SESSION`/`NOT_FOUND`/`WRITE_FAILED`/`INVALID_INPUT` 区分、业务结果与投递状态都保留。
- 报告仍与生命周期调用分离；`superagent_ledger` 管业务结果，`superagent_deliver` 管文件交接。

### `superagent_ledger`

- 5 个动作：`list`、`record`、`resolve`、`report_status`、`retry_report`。
- domain 是业务结果权威，Markdown 是投影，journal 是投递权威。

### `superagent_deliver`

- 必填绝对 `source` 与 `workspace`，可选 `destination`/`overwrite`。
- host 内复制并限制物理路径；不是 Session 状态操作。


## 2. 方案 A：全部合并成 `superagent(action, ...)`

概念 schema：

```text
{
  action: 'roster' | 'orphans' | 'ensure' | 'remove' | 'rename'
    | 'start' | 'append' | 'prompt' | 'list' | 'inspect' | 'stop' | 'abort'
    | 'fork' | 'archive' | 'compact' | 'delete'
    | 'ledger_list' | 'record' | 'resolve' | 'report_status' | 'retry_report'
    | 'deliver'
  workspace?: string
  path?: string
  title?: string
  session?: string
  task?: string
  text?: string
  id?: string
  outcome?: string
  decisions?: string[]
  artifacts?: string[]
  source?: string
  destination?: string
  overwrite?: boolean
  // 其余现有字段继续并入同一对象
}
```

这是 22 个动作、32 个参数字段的单一对象。当前参数声明文本约 8,027 字符，四段工具描述约 2,813 字符；仅按现有文本估算约 10.8K 字符（约 2.5–3.5K token，不是 tokenizer 实测），合并后还需补动作路由说明，因此不会自然变短。四个工具名和描述虽然消失，但动作说明与跨名字消歧会增加。

A 的唯一明显收益是模型只需发现一个工具名。代价是 workspace 的 `remove` 与 Session 的 `delete`、ledger 的 `list` 与 Session 的 `list`、Session 的 `record` 等必须重新命名；所有指引、报告正文、技能、README 与测试都要迁移。

## 3. 方案 B：只合并登记与生命周期

保留 `superagent_ledger` 与 `superagent_deliver`，把 workspace/session 合成例如 `superagent_control`：

```text
{
  action: 'roster' | 'orphans' | 'ensure' | 'remove_workspace' | 'rename_workspace'
    | 'start' | 'append' | 'prompt' | 'list' | 'inspect' | 'stop' | 'abort'
    | 'fork' | 'archive' | 'compact' | 'delete',
  workspace?: string,
  path?: string,
  title?: string,
  session?: string,
  task?: string,
  text?: string,
  confirm?: string,
  provider?: string,
  model?: string,
  reasoning_effort?: string,
  atSeq?: number,
  compact?: boolean,
  curate_memory?: boolean,
  delivery?: 'queue' | 'interrupt'
}
```

这是 16 个动作、16 个字段（含 action）。如果刻意不改名字，也可用 `remove`/`rename` 表达 workspace 动作；但 `remove_workspace/rename_workspace` 更容易让错误与意图明确。B 不必把 report retry 或文件复制混进生命周期状态。

实现上可以保留 `runWorkspaceTool` 与 `runSessionTool` 为纯内部 runner，新入口只负责合法 action 集合、动作级必填和分发。这样不重写 host 的 workspace/Session 服务，但仍要改变工具注册、schema 与模型可见文本。

## 4. 硬约束与代价

### 参数和描述预算

- 当前四组分别约 1.1K、4.5K、1.8K、0.6K 字符的参数声明；描述约 0.55K、0.77K、1.05K、0.43K。
- B 不会删除多少字段，只能减少重复 workspace/action 解释；真正减少的是工具数量，不是参数复杂度。
- 当前 `SESSION_PARAMETERS` 已是 13 字段、11 动作，增加 workspace 动作后更容易让模型把 `task`、`text`、`path`、`session` 混用。

### 必填与跨字段关系

`start` 与 `append` 不能靠“字段都可缺省”表达完整语义。当前已有动作级预检，一次列出缺失字段；合并必须保留并扩展它，同时检查：

- start: workspace + task，不允许用 session/text 代替；
- append: workspace + session + text；
- prompt/abort: session + text；
- ensure: path；remove_workspace: workspace + confirm；
- provider/model/reasoning_effort 的组合、delivery 与 compact 的互斥、read-only/write 动作限制。

仅把 action 标为 required 不够。若 host schema 使用 oneOf，必须为每个动作保留独立对象与 required 字段；不能用运行时递归校验被绕过来解释“schema 已严格”。

### 错误与返回语义

所有错误应继续带动作、workspace、session/task id 和可执行下一步；`READ_ONLY_SESSION`、`NOT_FOUND`、`WRITE_FAILED` 与 INVALID_INPUT 不能统一掉。返回也应保留现有 envelope 字段，不应为了合并把所有结果压成一段 `message`。特别是业务 returned/failed 与报告 delivered/failed 必须继续独立。

### 破坏面

- host 注册：需要改 `createSuperagentContribution` 的 Spec 名称、参数、render 和 run 接线；不是宿主 SessionController API 改造。
- agent preset：如果 preset 以工具名过滤/授权，就要改相应清单；如果只是加载 superagent capability，能力本体无需改，但工具列表断言仍需改。
- 测试：`superagent.test.ts` 大量直接 runner 调用可保留；真实工具名/roster/schema/渲染测试要改，组合与报告链要重跑。
- 文档与指引：`super-workspace-definition.ts`、README 中英、技能、错误中工具名、报告模板、历史调用指引都需处理；历史审查文档应保留原貌，不做全局改写。

## 5. 建议与工作量

### 建议

1. **现在不做 A。** 它把任务结果、投递恢复和文件权限混入生命周期，增加错误路由风险，收益不足以抵消迁移。
2. **只有在实测证明工具发现/误用是问题时才做 B。** 实现是在没有这类实测的情况下推进的；见下面的决策记录。做 B 时保留两个内部 runner、现有 envelope、动作级聚合校验与精确错误；不要新建一个巨大的业务函数。
3. 若目标是降低超管心智负担，优先改善现有 `list` 输出、下一步指引和动作错误聚合，而不是先改工具名。

B 的粗略工作量：生产/测试/提示与文档约 8–12 个文件，外加组合测试与模型可见快照（由拥有者按仓库规则执行）。需改 host 的工具注册，但不需要改 SessionController；agent preset 是否改取决于它是否枚举具体工具名。A 的迁移面更大，且需要为 22 动作设计新的无歧义命名，不建议用同一工作量承诺。


### 实现决策记录（2026-11-14）

仓库里没有找到关于这次合并的 benchmark、token 统计、误用报告、PR 描述或 commit message 测量；因此本记录不编造收益数字。

B 已在 `personality-rewrite-20261113` 实现，当前代码保留三个入口。记录的依据是结构性的、不是实测：A 会重写 22 个动作并破坏所有现有 `superagent_workspace`/`superagent_session` 调用方；B 保留两个内部 runner、现有 envelope 和动作级校验。本记录把 B 接受为当前基线，避免设计与代码继续分叉。

回退触发条件：如果真实 benchmark、现场报告或回归证明发现/误用、token 成本或调用方契约变差，回退 `personality-rewrite-20261113`，恢复 `superagent_workspace`/`superagent_session`，保留同一 envelope 与聚合校验，并重跑 superagent 行为/组合测试。在拿到证据前不做任何数字声明。
## 6. 反向证据：何时合并更糟

- action 分派只查顶层字段，嵌套/动作条件不校验，导致错误输入被当缺省或部分写入；
- `task` 与 `text`、`path` 与 `workspace`、`session` 与 ledger `id` 混用，模型更容易对错误对象执行 stop/remove；
- 返回只剩泛化文本，丢失业务结果、投递状态、交付路径和剩余计数；
- 每次请求都携带全部 22 动作说明，增加 token 与选择干扰；
- 旧调用方、技能、预设 allowlist 和测试仍引用旧名字，形成“工具看似存在但不可调用”的部署断裂；
- 为减少这些风险而引入复杂 oneOf/兼容别名后，维护成本高于保留现状。

因此，合并不是天然简化；B 只有在保留现有精确语义并有实测收益时才值得做，A 不建议实施。
