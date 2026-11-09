# memory / jira 修复报告

> 对应审查：[2026-11-07-memory-jira-implementation-review.md](2026-11-07-memory-jira-implementation-review.md)
> 基线与分支：`cli-desktop`，审查时 HEAD `4315198591`；本次修复提交 `71b4bdb779` … `1c348f2cbc`（未 push）。
> 工作方式：只改 memory / jira / 相关组合与文档；未回滚、未清理、未提交任何与本次无关的工作树改动。

---

## 0. 结论摘要

| 项 | 级别 | 状态 |
|---|---|---|
| M1 aborted/errored turn 启动摘要 job | P0 | ✅ 已修，测试转绿 |
| J1 `toolFailure` 缺 `me` | P0 | ✅ 已修，新增回归测试 |
| J2 交付组合没有 worker preset | P1 | ✅ 选择“接入 preset”，组合测试守护 |
| M2 `snapshotPosition` 运行期静默失效 | P1 | ✅ 改为始终注册 `memory-state`，切到 prompt 生效 |
| M3 memory 文档/依赖/配置漂移 | P1 | ✅ 已改（含中英 README、manifest、inject） |
| M4 快照累积 | P1 | ✅ 选择“修正文档承诺 + 测试钉住”，淘汰机制列为后续（理由见 §3） |
| J3 reconfigure 重复 / 文档 | P1 | ✅ 已修（含 HANDOVER/DESIGN 历史横幅） |
| J4 superagent teardown | P1 | ✅ 已加 `disposed` 闸门与注释 |
| P2 低风险项 | P2 | 部分完成；未做项与原因见 §4 |

所有相关测试在修复后重跑通过：memory + ui-memory **122 passed**、jira vitest **96 passed**、jira node **776 passed**、相关包 `tsc -b` **exit 0**。

---

## 1. 修复明细（问题 → 修复 → 证据 → 测试）

### M1（P0）memory：取消/出错的 turn 不启动摘要 job

- **问题**：组织者对所有 `turn/end` 派发（`packages/uitstalie/dafeiyu/src/index.ts:336`），memory 的 `onTurnEnd` 不检查 `reason.kind`（`packages/uitstalie/memory/src/index.ts:264`），而 `readTurnConversation` 只认 `completed` 并抛错（`summary.ts:448-455`），失败分支写失败 notice（`summary.ts:374`）。审查时 `tests/summary.spec.ts:237` 稳定红。
- **修复**：在 memory 侧过滤（`packages/uitstalie/memory/src/index.ts:269`）：
  `if (input.event.data.reason.kind !== 'completed') return`
  选择 memory 侧而不是组织者侧的理由：dafeiyu 的“所有 ending 都派发”是 2026-11-05 为 superagent 失败上报刻意改的契约（`superagent.ts` 的 turn-end 上报依赖它），在组织者侧过滤会把那条路也砍掉；provider 各自判断自己的成功条件才是契约本意。
- **文档**：`packages/uitstalie/memory/README.md`、`README.zh.md`、`packages/uitstalie/dafeiyu/README.md:95` 同步为“组织者派发所有 ending，provider 自行过滤”。
- **测试**：既有 aborted 用例转绿，并新增 blocked 用例与 notice 断言（`packages/uitstalie/memory/tests/summary.spec.ts:237`、`:255`）。

### J1（P0）jira：失败信封必须满足 output schema

- **问题**：`SUPERAGENT_OUTPUT_SCHEMA` 要求 `ok/writable/me`（`superagent.ts:928`），`toolFailure` 不返回 `me`（原 `:1729-1734`），兜底 catch 使用它（`:2451`）→ 本意可读的失败会被 `ToolOutputError` 覆盖。
- **修复**：`sessionActionFailure(message, me, details?)`（`packages/jira/jira-agent/src/superagent.ts:1733`）补齐 `me`；call site 传入 `me`；从 `index.ts` 导出供测试直接验证（`packages/jira/jira-agent/src/index.ts:368`）。JSDoc 明确“output schema 要求三个字段，registry 缺一会抛 `ToolOutputError`”。
- **测试**：`packages/jira/jira-agent/src/superagent.test.ts:2463` 断言 `ok/writable/me`、schema 的 `required` 全在、值可结构化克隆。

### J2（P1）jira：把 worker preset 接进交付组合

- **问题**：`superagent_dispatch` 在 `superagent_worker_preset` 未设置时直接拒绝（`superagent.ts:3700`），而交付 patch 的 `jira-agent` 行没有配置它（原 `cordis.patch.uitstalie.yml:35`）；同一 bundle 已经定义了 `jira-worker` preset，但从未接上。
- **修复（二选一里选了“接入”）**：`packages/bundle/web-app/cordis.patch.uitstalie.yml:36-43` 给 `jira-agent` 行加
  `superagent_worker_preset: jira-worker`，并在注释里说明它配的是同 bundle 的 `presets/jira-worker.patch.yml`，superagent 本身仍由 `superagent_home` opt-in。
- **为什么不是“未配置就不暴露工具”**：能力默认关 + 工具可见性还受 `superagent_home` 控制；隐藏工具会让“配置了 home 却看不到 dispatch”更难排查，而接入 preset 与 bundle 已有资产一致，改动面最小。
- **测试**：`packages/jira/tests/bundle-composition.spec.ts:168` 断言交付 patch 的 `jira-agent.config` 是 `{ superagent_worker_preset: 'jira-worker' }`，且 `jira-worker.patch.yml` 里确有 `id: jira-worker`。
- **文档**：`packages/jira/jira-agent/README.md` 的限制条目改为“派发面同时需要 worker preset 与 super home”。

### M2（P1）memory：`snapshotPosition` 运行期切换

- **问题**：section 集合在接线时按当时的 `snapshotPosition` 决定（原 `index.ts:239-245`）；切到 `prompt` 后已接线的 agent 没有 `memory-state` 段，而 `syncMemorySnapshot` 在 prompt 模式直接 return（`snapshot.ts:226`）→ 该会话从此收不到快照，且不报错。
- **修复**：`memory-state` 段**始终注册**，`text()` 只在 `prompt` 模式返回内容（`packages/uitstalie/memory/src/index.ts:243-253`）。空 section 会被 system-prompt 的 assembly 丢弃（`packages/core/system-prompt/src/index.ts:298-299`），所以 `depth-0` 模式没有额外成本；切到 `prompt` 后下一次刷新即生效。没有选“拒绝切换”，因为该字段本来就是 volatile，拒绝会在 UI 上表现为“保存了但不生效”，更难解释。
- **测试**：`packages/uitstalie/memory/tests/provider.spec.ts:126` 在 `depth-0` 下写入、切到 `prompt`、再写入，断言 `memory-state` 段出现且不再追加消息。

### M3（P1）memory：文档/依赖/配置漂移

- **README（英文）**：`snapshot` 改为 append-only（不再写 replace / `surfaceOp: replace`）、迁移改为“在 detail append 之前”、`Window:` 改为 `Archived:`、依赖从“六个服务含 `ctx.fs`”改为五个服务 + 实际 import、token effect 改为“每条 ≤16 KiB，可累积”。
- **README（中文）**：同步以上改动，并保持与英文一致。
- **manifest**：`packages/uitstalie/memory/package.json` 的 `dependencies` 增加 `@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-session`（源码里是运行时 import）；`pnpm-lock.yaml` 已用 `pnpm install --lockfile-only --offline` 更新。
- **inject**：删除从未使用的 `fs`（`packages/uitstalie/memory/src/index.ts:34`），JSDoc 同步。
- **无 UI 的配置项**：`maxEntries`、`snapshotTemplate`、`snapshotPosition` 在 `packages/uitstalie/ui-memory/README.md` 明确写为 profile-YAML 字段及用途。
- **测试**：memory 全量 122 passed（含新增的 position / accumulation 用例）。

### M4（P1）memory：快照累积

- **问题**：每个摘要边界都可能追加一条完整快照；只与“上一条快照文本”做整串相等去重，长会话会累积。
- **修复（三选一里选了“修正文档承诺 + 测试钉住”）**：在 README 的 Token effect 与 Known Limitations 写明“每条 ≤16 KiB，但 append-only 会累积；淘汰旧快照需要替换靠前节点，正是 DH-723 去掉的 KV-cache 代价”。
- **没有做硬淘汰**：淘汰规则要么在稳态每轮替换旧节点（重新引入 DH-723 的缓存问题），要么在启动/恢复时跳过完整快照（模型失去当前状态）。这两者都是产品取舍，不应在“修 bug”的提交里单方面决定；已在报告中列为后续任务。
- **测试**：`packages/uitstalie/memory/tests/summary.spec.ts:596` 让两个摘要边界各追加一条，断言两条都在、seq 递增、每条 ≤ `MEMORY_SNAPSHOT_MAX_BYTES`。

### J3（P1）jira：重复赋值与文档

- **代码**：`reconfigure()` 的 6 行重复赋值删除（`packages/jira/jira-service/src/index.ts:248-259`）。
- **回归测试**：`packages/jira/jira-service/tests/volatile.spec.ts:83` 断言一次 volatile commit 同时应用 root/host/push 三个字段。
- **jira-service README**：`superagentConfirm` 不再是“唯一写”；补上 `superagentSetup`（建目录、注册 workspace、写 `superagent_home`，`remote.ts:230-259`），并补齐服务方法枚举与 remote 表。
- **HANDOVER.md**：页首加历史横幅，说明它是迁移前单包状态（`src/core`、`dist/`、702 测试），不要按它执行命令。
- **DESIGN.md**：页首加历史说明——82 条是当时计数（§8 已有 223 条）、单包树与“零宿主依赖/离线拷贝”前提已被 `MIGRATION.md` 取代；历史正文与修正记录保留。
- **jira/README.md**：DESIGN/HANDOVER 链接标注为历史；jira-agent 摘要补 `issue_work` 与 superagent。
- **jira-agent README**：`enabledByDefault` 改为实际规则；工具数改为“普通 root 6 个 / super agent 5 个”；删除已不存在的“深路径 import / `ctx.jira.store()`”限制。

### J4（P1）jira：superagent teardown

- **修复**：`createSuperagentContribution` 增加 `disposed`（`superagent.ts:4073`），`poll()` 在入口和 daemon pass 之后检查（`:4114`、`:4128`），`onTurnEnd` 入口检查（`:4532`），`dispose()` 先置位再释放（`:4546` 起）。
- **注释**：明确 `dispose()` 契约是同步的，`dispatchStore.close()` **故意不 await**，只记日志（`:4557-4562`）。
- **测试**：`superagent.test.ts:2480` 对最小 host 连续 dispose 两次，并断言 dispose 后的 `onTurnEnd` 不 reject。

### P2（已完成）

- **memory 文本工具**：新增 `packages/uitstalie/memory/src/text.ts`（`byteLength`/`truncateToBytes`/`errorMessage`），删除 `read/snapshot/summary/checkpoint/memory-file` 里的 3×3×4 份复制。
- **UI 条件 hook**：`MemorySection.tsx` 拆成外层 prop guard + `MemorySectionBody`（`:60`），`JiraSection.tsx` 拆成外层 + `JiraSectionBody`（`:77`），hook 不再位于 early return 之后；`JiraSection` 的可选 settings hook 用稳定 no-op 兜底（`:50`、`:64`）。
- **小文档/注释**：`ledger-settings.ts` 的悬空 JSDoc 归位；`snapshot.spec.ts` 的 “replaces it once” 标题改为 “appends a fresh one”。

---

## 2. 提交清单

| 提交 | 内容 | 文件范围 |
|---|---|---|
| `71b4bdb779` | memory M1 + M2 + M3 + M4 + text helpers | `packages/uitstalie/memory/**`、`ui-memory/README*`、`dafeiyu/README.md`、`pnpm-lock.yaml` |
| `ffcb28bb58` | jira J1 + J4 | `packages/jira/jira-agent/src/{index,superagent,superagent.test}.ts` |
| `71a97c4a83` | J2 交付组合 | `packages/bundle/web-app/cordis.patch.uitstalie.yml`、`packages/jira/tests/bundle-composition.spec.ts` |
| `0238d48e14` | J3 服务层 | `packages/jira/jira-service/**` |
| `2e57f14788` | J3 文档历史化 | `packages/jira/{README*,DESIGN,HANDOVER}`、`jira-agent/README*` |
| `1c348f2cbc` | P2 UI hook | `packages/jira/ui-jira/src/client/{JiraSection,ledger-settings}.tsx/ts`、`ui-memory/src/client/MemorySection.tsx` |

说明：`memory/src/index.ts` 同时承载 M1/M2/M3，`superagent.ts` 同时承载 J1/J4；按文件不可再拆，因此以子系统为单位提交，未混入任何无关路径。

---

## 3. P2 未做项与原因

| 项 | 原因 |
|---|---|
| 用 `packages/util/atomic-write` / `withFileLock` 替换 jira-core 的原子写与锁 | 跨模块结构改造，涉及 jira-core 的“零运行时依赖/离线拷贝”前提（决策 65）与 Windows 重试语义；单独提交、单独验证更安全，不适合与本次 bugfix 混在一起 |
| 用 `zod` 替换 `jira-core/src/schema.ts` 的手写校验 | 同上，属于适配层重构；且 `schema.ts` 同时服务 CLI 与工具面，改动面大于收益 |
| 合并两份 home/path 规则（`superagent-setup.ts` 词法 vs `superagent.ts` realpath） | 两者语义不同（一个是“配置路径相等”，一个是“物理目录相等”），统一前需要先定产品语义；已在审查报告里列出，先不动 |
| `store.ts:114` 改用 `tagstore.decodeTag` | `loadTags` 是**容错读**（缺 description/aliases 也返回），`decodeTag` 是**严格解码**（返回 `Result`）；直接替换会改变读行为，需要先加“容错解码”中间层，属于后续任务 |
| 拆分 `superagent.ts`（4350 行） | 用户明确要求本轮不做高风险结构改造；报告已给出拆分边界建议 |
| 删除 `result.ts` 的无调用组合子 | 是公开导出面，删除可能影响本仓外的调用；建议单独评估，不与 bugfix 混提交 |

---

## 4. 验证证据

在本机（Windows）串行执行，均通过：

| 命令 | 结果 |
|---|---|
| `node node_modules/vitest/vitest.mjs run packages/uitstalie/memory packages/uitstalie/ui-memory` | **122 passed / 11 files**（修复前为 1 failed / 118 passed） |
| `node node_modules/vitest/vitest.mjs run packages/jira` | **96 passed / 18 files**（含此前 60s 超时的 `superagent-real-loop`，本次 25s 通过） |
| `pnpm run test:jira:node` | **776 passed**（jira-agent 173、jira-cli 38、jira-core 565；修复前 774） |
| `node node_modules/typescript/bin/tsc -b packages/uitstalie/memory/tsconfig.json packages/uitstalie/ui-memory/tsconfig.client.json packages/uitstalie/dafeiyu/tsconfig.json packages/jira/jira-agent/tsconfig.json packages/jira/jira-service/tsconfig.json packages/jira/ui-jira/tsconfig.client.json` | **exit 0** |
| `pnpm install --lockfile-only --offline` | 更新 `pnpm-lock.yaml`，只移动 memory 的 `dsh-llm`/`dsh-session` 到 dependencies 区 |

### 关于修复期间的两次非正常重启（必须记录）

修复过程中，机器在 18:42:57 与 18:51:41 各发生一次非正常断电/硬复位（System 日志 `Kernel-Power 41` + `6008`；`BugcheckCode=0`、`PowerButtonTimestamp=0`、无 1074、无 dump/minidump）。两次都落在 jira 测试负载期间。仓库源码中没有任何 `shutdown`/`Stop-Computer`，我新增的测试也不启动子进程；事件特征更像供电/散热/硬件保护被重负载触发（该机 10-17、10-19、11-06 也有同样的 41 记录）。

因此本轮验证改为**串行**执行（先 node 套件、再 vitest、再 memory），全部通过；但这不构成“硬件没问题”的结论。若这台机器还要继续跑全量测试，建议先排查电源/散热/内存，并用 `--maxWorkers=1` 降低峰值负载。

---

## 5. 剩余风险

1. **M4 是文档化的已知成本，不是硬上限**：长会话仍可能累积多条快照（每条 ≤16 KiB）；淘汰策略需要单独的产品决策。
2. **`jira-agent` 把 `jira-service` 放在 devDependencies**，而 `lib/types` 会引用它的类型；包是 private，对仓外消费者仍是类型解析风险（审查报告已列，未在本次改）。
3. **superagent 的 `dispose` 仍无法等待 `dispatchStore.close()`**：这是 dafeiyu `CapabilityContribution.dispose(): void` 契约的限制；本次只保证“停止接新工作 + 记录失败”，彻底收口需要契约升级。
4. **本轮未跑全仓 `pnpm test`**：工作树仍有与本任务无关的未提交改动（session/sandbox 等），跑全仓无法归因；已按子系统分别跑相关套件。
5. **未在 GUI 真机上验证 J2 的派发链**：组合测试证明了 preset 已配对、能力默认关闭；实际点开 superagent 仍需设置 `superagent_home`，属于部署步骤而不是代码路径。

---

> 本次修复未 push；未创建与 memory/jira 无关的提交；未删除或回滚任何用户未提交的工作。
