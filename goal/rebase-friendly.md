# cli-desktop 分支工作方法：不影响 rebase 的修改原则

本文是 cli-desktop 分支的总方法文档：分支目标、分支自有文件的放置位置、原生文件修改的标记规范，以及保持可随时 rebase 到 master 的具体做法与示例。强制规则见同目录 [AGENTS.md](AGENTS.md)，本文提供原理、背景与示例；后续的目标、设计、架构文档同样放入本目录。

## 分支目标

在尽可能不改变原生（master）内容的前提下，实现 CLI 与 Desktop UI 两个前端。当前阶段目标：实现 CLI。

## 文件放置：goal/

分支自有的目标、设计、架构文档全部放在仓库根部的 goal/ 目录。该位置同时满足两个条件：

- 新增路径：master 上不存在同名文件，rebase 时永远不会与上游冲突。
- 门控之外：verify-translation-pairing 的配对范围只覆盖 README 基名文件、根部 CONTRIBUTING/BRAND_GUIDELINES、`.agents/notes/`、`docs/`、`python/`（判定见 scripts/translation-pairing.ts 的 `isTranslationScopeFile`）；verify-md-links、verify-md-wrap、verify-package-paths、verify-mermaid、doc-typecheck 均使用固定 glob 列表，不含根部新目录；verify-doc-budgets 只检查其 manifest 列出的文件。因此本目录下的文件不需要双语配对、不需要登记任何 manifest，也就不会为 rebase 增加原生文件的修改面。

本目录的命名约定：

- 不使用 README.md 作为文件名——任何目录下的 README 基名文件都会进入双语配对范围。
- 除规则文件 [AGENTS.md](AGENTS.md) 外不新增其他 AGENTS.md。goal/AGENTS.md 是分支规则的家：它通过根部 opencode.json 的 `instructions` 字段注入到每个 opencode 会话，规则因此对全仓库范围的工作生效，不依赖子树 AGENTS.md 的按目录加载。

分支自有的根级文件（如 opencode.json）同样是新增路径，rebase 时不与上游冲突；若上游未来新增同名文件，add/add 冲突人工解决一次即可。

## 代码修改的三条原则

### 新增：一律走新路径

新功能以新增文件、新增包、新增 bundle 的形式落地，通过现有扩展点（cordis.yml 组合、插件注册、capability seam）挂接到原生系统，做到不修改任何原生文件即可生效。新增路径在 rebase 时不产生冲突，分支自有的新文件不需要标记注释。

### 修改：最小、局部、可枚举

确实无法避免修改原生文件时：

- 改动收敛到最小的连续区域，优先在文件末尾或稳定锚点之后追加，避免中段插入与整段重写。
- 不重排、不格式化、不顺手优化任何原生内容；触碰的行数越少，rebase 冲突面越小。
- 每一处修改必须用标记注释包围（规范见下节），并在对应任务单中登记（文件、位置、原因），使 rebase 出现冲突时可以逐条对照处理。
- 修改模式优先插入式：原行保留，新增内容放进标记注释内；只有当新内容必须插到原行中间或前面时，才用注释原行重写式。两种模式的示例见文末。

### 删除：先逻辑删除，后物理删除

- 优先通过配置、cordis.yml 的 `disabled`、新增插件覆盖、或标记注释包裹的提前返回块来实现"不启用"，把删除转化为新增，不触碰原生文件。
- 必须物理删除时，删除最小的连续块，用标记注释说明，并在任务单中登记删除点与理由。

## 标记注释与任务单

每一处对原生文件的修改或删除都要带标记注释，使全部分支改动可以被一条命令枚举：`git grep -n "uitstalie-"`。

块注释形式（注释语法按宿主文件类型调整）：

```
// BEGIN uitstalie-${llm_model_name}, ${yyyy/MM/dd}, ${mission_id}, ${修改原因简述}
……修改内容……
// END uitstalie-${llm_model_name}
```

单行注释形式：

```
int example = 0; // uitstalie-${llm_model_name}, ${yyyy/MM/dd}, ${mission_id}, ${修改原因简述}
```

字段含义：

- `llm_model_name`：执行本次修改的模型名称，便于区分不同 agent 的改动。
- `yyyy/MM/dd`：修改日期。
- `mission_id`：与用户约定的任务单文档名。任务单维护在 goal/mission/ 目录，文件名即 mission_id，内容记录需求（requirement）与本次修改范围——作用类似 Jira 单，但本质是在本地维护的系统。修改原生文件前必须先建立对应任务单。
- 修改原因简述：一句话说明为什么改。

任务单的创建规则：每个任务先判断是新 mission 还是已有 mission 的变更；两种情况都必须创建新的任务单文档，无论变更范围和变化大小。变更已有 mission 时，新文档使用新的 mission_id，并注明变更自哪个原任务单，形成溯源链。

任务单系统纯本地维护，不引入 GitHub Issues 等外部票据系统：标记注释必须在 rebase 冲突现场离线可解析，任务单同时兼任原生修改登记表，这两类数据都必须随分支存在于 git 中。

不支持注释的文件类型（如 JSON）无法内嵌标记，改为在任务单中逐处登记文件、位置与原因。

## 提交与 rebase 约定

- 分支自有文件（goal/、新包、新 bundle）与原生文件的修改分开提交；原生修改的提交保持少而集中。
- rebase 到 master 时，冲突只会出现在登记过的原生文件上；goal/ 与全部新增路径永远干净。
- 每次 rebase 后执行 `git grep -n "uitstalie-"` 盘点全部标记，逐处确认适配结果；即使出现破坏性 rebase，也能凭标记与任务单快速梳理和恢复。

## 示例

以下示例以 Java 代码书写；在 js/ts 等本仓库使用的文件类型中按宿主注释语法对应调整，本质原理一致。核心目的：对 rebase 友好——即使遇到 rebase 冲突，也能根据注释定位到具体的 commit 或修改方式。

假设需要把 `a && b` 修改为 `a && b || c`，推荐的改法有两种。

插入式（一般推荐）：

```java
if(a && b
// BEGIN uitstalie-${llm_model_name}, 2026/08/24, ${mission_id}, 条件需要额外覆盖 c 的情况
    || c){
// END uitstalie-${llm_model_name}
    fun(c)
}
```

注释原行重写式（新内容必须插到原行中间或前面时使用）：

```java
// BEGIN uitstalie-${llm_model_name}, 2026/08/24, ${mission_id}, 条件需要额外覆盖 c 的情况
// if(a && b){
if(a && b || c){
// END uitstalie-${llm_model_name}
    fun(c)
}
```

再假设需要利用函数开头的 a 和 b，但不希望后续的 c、d、f 与 finish() 执行。最好的方案不是重写函数，而是在标记内插入提前返回块：

```java
public void fun(){
    a = 1;
    b = 2;
    // BEGIN uitstalie-${llm_model_name}, 2026/08/24, ${mission_id}, 只需要 a/b 的赋值结果，跳过后续逻辑
    if(true){
        a = 4;
        b = 6;
        return;
    }
    // END uitstalie-${llm_model_name}
    c = 3;
    d = 4;
    f = 5;
    finish();
}
```

总之，标记注释的目的是方便 rebase 修改，以及方便后续的 agent 或人类更好地理解这里发生了什么；即使出现破坏性的 rebase，也可以通过这种方式快速梳理和适配。
