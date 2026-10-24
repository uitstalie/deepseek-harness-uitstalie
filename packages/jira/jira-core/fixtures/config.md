---
type: config
schema: config/v1

# ============================================================================
# 全 store 唯一"共享且可变"的文件（DESIGN.md §4.2 接受了这个例外：低频变更 +
# git 版本化 + 冲突可见可回退）。所有词表都放这里，因为它们性质相同：
# 低频、只增不删、同一套校验。
# 字段命名：落盘一律 snake_case（DESIGN.md 决策 41）。
#
# ⚠️ 本文件的 `type` 是 OKF 的**文档种类**（值恒为 `Config`），
#    与下面 `issue_types`（task / bug）**不是一回事**——两个维度不撞键（决策 45）。
# ============================================================================

# 「这是什么活」。不是 OKF 的 type；值一律小写。
issue_types:
  - task
  - bug

# 知识条目的类型（**闭集四值**，只增不删；同时就是 OKF 的 type，决策 75）。
kb_types:
  - runbook
  - pitfall
  - howto
  - concept

# 严重程度，**S1 最高、S5 最低**。同样只增不删；新建时未指定默认 S3。
priorities:
  - S1
  - S2
  - S3
  - S4
  - S5

# statuses 只增不删；下线一个状态 = 打 deprecated: true 并**摘掉指向它的入边**
# （老数据仍合法、新流转到不了、BOARD 单独归到"已下线"分组）→ 因此零数据迁移。
statuses:
  - { name: todo,        order: 10 }
  - { name: in_progress, order: 20 }
  - { name: in_review,   order: 30 }
  - { name: closed,      order: 90 }
  - { name: cancelled,   order: 95 }

# 2026-10-19 用户裁定：**不再有 todo→closed**——关闭必须经过 in_progress，
# 否则「谁做的」在审计上说不清（试用反馈：6 条 issue 未认领就关闭）。
# 快捷路径由工具的复合动作承担（claim+开工+关闭一次提交，见 DPMJ-214）。
transitions:
  - [todo, in_progress]
  - [todo, cancelled]
  - [in_progress, in_review]
  - [in_progress, closed]
  - [in_progress, cancelled]
  - [in_review, in_progress]   # 打回
  - [in_review, closed]
  - [in_review, cancelled]
  - [closed, in_progress]      # 重开
  - [cancelled, todo]          # 重开

# 算作"关闭"的状态：jira_list 只显示不在这个集合里的；归档只作用于这个集合里的。
# 规则：**进入这个集合里的任何状态，resolution 一律必填**（DESIGN.md §4.16，已确认）。
closed:
  - closed
  - cancelled

# 完成结论，同样只增不删；**关闭集合内一律必填**。
resolutions:
  - fixed       # 真正解决了
  - invalid     # **判断过了**：不是问题 / 不需要做（重复 issue 也用这个 + duplicate link 表达）
  - limitation  # **有限地解决了**：技术债、缺依赖/权限/信息，明确遗留
  - abandoned   # **中止**：环境没了 / 不做了 / 优先级被砍（与 cancelled 配对）
---

# 词表（config.md）

本文件是数据仓的**词表中心**。改它要记住六件事。

## 1. 为什么"只增不删"

`statuses[]`、`priorities[]`、`issue_types[]`、`resolutions[]` 里一旦**删掉**某一项，
历史 issue 的对应字段立刻变成非法值、校验会红。正确做法不是删，而是：

```
- { name: old_status, order: 40, deprecated: true }   # 保留，标记下线
```
并把 `transitions` 里**指向它的入边摘掉**。于是：老数据合法、新流转到不了、
`BOARD.md` 里单独归到"已下线"分组，残留一眼可见、可手工处理。**这就是"零数据迁移"。**

## 2. 非法流转必须报错

任何不在 `transitions` 里的流转，必须**报错并列出当前状态的合法目标**，
绝不静默接受（`DESIGN.md` §4.2 三条约束之二）。

## 3. "被阻塞"不是状态，是 link

`is_blocked_by` 是 issue 之间的关系（`DESIGN.md` §4.15），**不要**再设一个 `blocked` 状态——
那会造出两套互相打架的表达，最难维护的就是这种重复语义。
拦认领的规则也挂在 link 上（对 agent 显式拦截 + 显式 override 记事件；对人类只是标记）。

**时间性等待也不加字段**（2026-10-19 裁定，试用反馈：「等今晚 22:30 构建窗口」没有可 link 的对象）：
约定是——在 issue 上写一条 comment 说明等什么、到什么时候，状态留在 `in_progress`（或 `todo`），
到点由人或 agent 继续。不为它设 `hold_until` 字段。

## 4. `cancelled` 与 `closed` 的区别在 `resolution` 上，不在"要不要填"上

**两者都必填 `resolution`**（关闭集合内一律必填，已确认）。区别是**填什么**：

| 状态 + resolution | 语义 |
|---|---|
| `closed` + `fixed` | 真正做完了 |
| `closed` + `limitation` | 打折完成，带着遗留关掉 |
| `closed` + `invalid` | **判断过了**：不是问题 / 不需要做 —— 这是**结论** |
| `cancelled` + `abandoned` | **没走到判断**：环境没了、不做了、优先级被砍 —— 这是**中止** |

⚠️ **别把 `cancelled` 配上 `invalid`**：那正是我们要区分开的两件事。`abandoned` 就是为
这种"不是判断、而是中止"的情形新增的取值（`DESIGN.md` §4.16 修正记录）。

## 5. `priority` 是 `S1`–`S5`（严重程度，不是待办顺序）

- **`S1` 最高、`S5` 最低**；取值封闭，同样**只增不删**（要加 `S6` 就往后追加，**不要重排语义**）。
- 它是**标量字段**：多机离线各改同一条时，按 `DESIGN.md` §5 的规则取**较新的 commit**，
  并在 issue 上打 `conflicted: true` 高亮，**绝不静默择一**。
- **它不是排期**：本插件不做 sprint 排期（`DESIGN.md` §1）。`priority` 只回答"这条有多严重"，
  不回答"先做哪条"——看板分组仍按 `statuses[].order`。
- 新建时未指定 → 默认 **`S3`**（**已确认**）。
- 字段名目前叫 `priority`，值的语义偏"严重程度"；**若你觉得该叫 `severity`，现在改名还免费**。

## 6. 两个 "type" 不是一回事（`DESIGN.md` 决策 45）

| 键 | 是什么 | 取值 | 谁校验 |
|---|---|---|---|
| `type` | **OKF 的文档种类** | 本文件恒为 `Config`；issue 文件是 `Issue`；tag 是 `Tag`；知识条目另有其值 | 写入侧**强制小写**；找不到对应 schema 一律**判不合格**（绝不当"跳过=通过"） |
| `issue_type` | **这是什么活** | `task` / `bug` | 同样强制小写，且必须在本文件 `issue_types` 里 |

⚠️ **必须小写**：`DESIGN.md` §11.1 记的实证教训——上游因 `type: Architecture` 大写，
导致找不到 schema、**整个结构校验被静默跳过**。

---

## 当前状态机（**已确认**）

| 当前状态 | 允许流转到 |
|---|---|
| `todo` | `in_progress` · `cancelled`（**2026-10-19 起不再有 todo→closed**：关闭必须经过 in_progress） |
| `in_progress` | `in_review` · `closed` · `cancelled` |
| `in_review` | `in_progress`（打回）· `closed` · `cancelled` |
| `closed` | `in_progress`（重开） |
| `cancelled` | `todo`（重开） |

- `in_review` 的语义是"**等人确认**"：agent 认为做完了，但结论要人点头。
- `closed` / `cancelled` 时**必填** `resolution`，`limitation` 还必须带文字说明。

## resolution 必填的范围（**已确认：关闭集合内一律必填**）

`DESIGN.md` §4.16 原话是"进入 `closed` 状态时 `resolution` 必填"，而 "`closed`" 有两种读法：
① §4.2 `closed[]` 那个**关闭集合**；② 名叫 `closed` 的那**一个状态**。
只有一个关闭状态时两者等价，加入 `cancelled` 之后才分开。

**用户裁定读法 ①（关闭集合内一律必填）**，理由：让**每一条关闭记录都统一带一个结论字段**，
查询与审计口径一致——"为什么关的"永远在一个固定字段里，不用先看状态再决定去哪找。

- 配套：`resolutions[]` **新增 `abandoned`**，给"中止"一个不与 `invalid` 重叠的取值。
- 被否掉的读法 ②：新增字段 `resolution_required_in: [closed]`，把必填绑到具体状态。

## TODO（只剩这些）

- [x] ~~`issue_types` 是否补 seed，例如 `chore` / `doc` / `spike`？~~ → **2026-10-19 用户裁定：不加**。
  `task` 涵盖功能增项（task 比 feature 更普遍），`bug` 是问题；两类足够。
- [ ] 字段名 `priority` 还是 `severity`？（值是 S1–S5，语义偏"严重程度"；现在改免费）
- [ ] 以后要不要把"哪个状态只能配哪些 resolution"做成**强制**（现在是惯例 + 体检报告）
