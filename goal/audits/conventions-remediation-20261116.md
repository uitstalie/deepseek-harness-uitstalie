# 代码规范审计修复记录（2026-11-16）

依据：

- `goal/audits/code-conventions-20261116.md`
- `goal/audits/code-conventions-20261116-lint-evidence.md`
- `goal/audits/code-conventions-20261116-export-evidence.md`
- `goal/audits/code-conventions-20261116-native-markers.txt`

范围：只改本分支审计确认的规范问题；不做无关重构，不 push。

## 提交

| commit | 内容 |
| --- | --- |
| `30712953f9` | 入口导出、JSDoc、locale、unknown-cast、测试迁移与工具错误契约 |
| `520f7850cb` | 未知事件语义、模块级共享状态、OAuth/models-dev 生命周期、客户端 disposer、非标准 export key、原生标记 |
| `7fa3060f11` | 未知断言 baseline 随测试换行重新锚定 |
| `ad034f2b0a` | 17 个 uitstalie 包 files 补齐，ui-memory props 窄化 |
| `90024bc389` | persona-card/tool-policy 运行时常量移出 types.ts |

## 门禁

| 门禁 | 结果 |
| --- | --- |
| `pnpm run verify-plugin-entry-exports` | 通过；200 个 function plugin、105 个 service plugin，547 个既有导出在 baseline |
| `pnpm run verify-export-jsdoc` | 通过；每个包 API 的导出名都有 JSDoc |
| `pnpm run verify-no-unknown-casts` | 通过；无新增，1232 个既有断言保留 |
| `pnpm run verify-locale-metadata` | 通过 |
| `pnpm run verify-package-readme-summaries` | 通过；455 个英文包 README 摘要 ≤100 词 |
| 聚焦 oxlint（uitstalie/jira/superagent/tool-policy/permission-presets/subagent） | 0 errors |
| 受影响包聚焦测试 | 462 passed（session/UI/assembly/sqlite；25 files） |
| `pnpm run build:check` | **通过**：host aggregate 与 client aggregate 均 PASS（`2 passed, 0 failed`） |

## P0

- 13 处工具失败点使用 `HarnessError` / `ToolArgsError` / `ToolContextUnavailableError`；tool-policy 拒绝携带 `info: { name, code }`。
- `MemoryDocumentError`、`AnalyzeError`、`ApplyError`、`PersonalityStoreError`、`OutputStyleError`、`WritingRulesError`、`StorePathError`、`SandboxModeDisabledError`、`PersonaStateError` 均继承 `HarnessError`，错误码大写。
- 模块级共享状态清理：
  - `jira-agent` 的 report journal 改为 `createSuperagentContribution` 实例内创建并注入；
  - `super-workspace-definition` 的 per-root 队列改为 `SuperWorkspaceDefinitionSync` 实例；
  - `workspace-conventions` 删除进程级缓存，按当前 `AGENTS.md` 读取；
  - 未使用的 `jira-core` push queue 单例删除。
- 未知事件恢复仓库原规范：`validateStoredEvents` 只有 `ignorable: true` 可跳过，未标记的未知事件拒绝；`surface.ts` 与 v3→v4 当前读取同步；`critical` 不再作为跳过开关。相关 README、subsystem 文档、catalog 同步。
- `models-dev` 的 dispose 等待首次加载与在途 refresh；`llm-plus` OAuth 尝试由服务实例持有，dispose 中止并等待在途 flow；PKCE 回调服务器 `close()` 返回 Promise 并 await。
- 客户端 `ctx.effect` 清理改为可等待的异步清理；ui-models-dev 轮询 timer 由 store 实例持有并在 dispose 时取消。

## P1

- `as unknown` 新增为 0。
- 非标准 export key 清理：删除 5 个 `./*`、`./dispatch`、`./deepseek-extra-params`；`./icon` 改为既有标准 `./icon.svg`。
- 69 个 `src/*.test.ts` 迁移到 `tests/`，包脚本同步；`.oxlintrc` 的 tests override 直接适用，未全局关闭规则。
- 原生插入点补 `uitstalie-deepseek-flash, 2026/11/16, DH-311` 标记，覆盖 Agent 角色链路的类型、registry/roleOf、tool 面过滤、agent-loop getter/request-local pairing、session-controller role 解析、workspace role、system-prompt 段落顺序与 llm 的 tool-update 投影；18 个 thin Loader 入口整体标记为分支改写的入口面。**未覆盖全部 146 个候选点**，见“未完成”。

## P2

- 修正 4 处 JSDoc/README 语义：permission-presets 的 `permissions` 投影、agent-loop 的 tool-pair repair 记录、workspace 的 BEL、ui-jira 写路径说明。
- `Home Backup` casing、jira skill 硬换行与决策残留、`jira-board.md` 末尾换行、`web-app/package.json` 重复依赖键、`types.ts` BEL 已修。
- personality 与 tool-policy 补齐 8 语言 locale，包 exports/files 同步。
- 17 个 `packages/uitstalie/*/package.json` 的 `files` 补齐 `lib/types/**/*.d.ts.map` 与 `src`；包特定的 icon/locale/typert/client/asset 保留。
- `verify-package-meta` 通过（plugin locale、SVG、resource exports、publication files）。
- `persona-card` 的 `PERSONA_SCHEMA`/`DEFAULT_PERSONA_MAX_BYTES` 与 `tool-policy` 的 `FILE_ACCESS_OPERATIONS` 移入 `constants.ts`，`types.ts` 只保留类型。
- 6.14 生成文本与实现已一致：`known-event-types.ts` 与 `storage-contract.ts` 都要求 unknown 事件必须 `ignorable: true`。
- 部署可变配置：memory 的 `summaryMaxAttempts`/`summaryRetryDelayMs`、ui-models-dev 的 `pollIntervalMs`/`promptPollDelayMs`、tool-dsh-store Remote 的 `maxRuleBytes` 进入 Config 并校验。OAuth 的 5s 设备流窗口、poll/retry 与 30s 请求超时按协议/网络不变量保留，未配置化。
- UI 术语统一为“能力”“能力组织者”“摘要提供商”“轮次/派生产物”“优先级”；OAuth notice 使用业务身份而非索引 key；Jira 页面字重降到 500，动作 hover 包进 `(hover: hover)`。
- 后台 turn-end/timer pass 的静默 catch 改为 `logger.warn`，失败仍不打断会话但可观察。
- `ui-memory` 改用 renderer 绑定的 `useSnapshot`，不再由业务组件自订阅；页面 CSS 改用已定义的 `--dsw-alias-*` token，焦点/错误/边框/字重符合共享样式规则。
- 四个自研 client 包的中文代码注释翻为英文，保留 `zh` 用户字典；无 U+FFFD。
- 其余 client hover 规则包进 `(hover: hover)`，Jira 中性分隔边框改 0.5px；`MemorySection` 使用已定义 alias token。

## 未完成 / 待决策

1. **OAuth 协议时序仍未配置化**：GitHub 设备流的 5s、Kimi 的 poll/retry、OAuth HTTP 30s 是按外部协议/网络不变量保留；memory、UI 轮询、rule byte limit 已进 Config。
2. **原生标记未覆盖 146 个候选**：本次只补了角色链路实际插入块；剩余块需要按实际 hunk 判断，不能机械全刷。
3. **UI props 仍偏宽**：四个页面的快照订阅已改由 renderer `useSnapshot` 绑定；`ui-memory` 已改为只注入 `actions.edit/save/discard`，`ui-dafeiyu` 已改为只注入 `actions.load/setEnabled`，不再传整只 controller。`ui-models-dev` 已改为只注入 `ModelsDevActions`（load/select/draft/submit），不再传整只 store。仅 `ui-jira` 仍保留 `Partial<InjectFace<...>>` 与整只 controller 作为测试/装配路径，完全窄化 `ui-jira` 需要同时改 renderer 注入面。
4. **6.13 真实组合测试缺口未补**：tool-policy 仍只有手工 `ctx.plugin` 单测，缺经 Loader/tool executor 拒绝的 REAL-composition。
5. **已发布错误码大小写变化**（如 `budget-exceeded` → `BUDGET_EXCEEDED`）可能影响外部消费者；若这些错误类属于已发布面，需要兼容层或版本说明。
