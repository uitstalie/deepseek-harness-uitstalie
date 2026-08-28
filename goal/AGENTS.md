# AGENTS.md — cli-desktop 分支规则

本文件是 cli-desktop 分支的强制规则，通过根部 opencode.json 的 `instructions` 字段注入到每个 opencode 会话，对全仓库范围的工作生效；原理、背景与示例见 [rebase-friendly.md](rebase-friendly.md)，任何任务要修改原生文件前必须先读完它。总目标：在尽可能不改变原生（master）内容的前提下实现 CLI 与 Desktop UI，任何时刻都可以 rebase 到最新 master。

- 分支自有的一切只走新增路径：文档放 goal/（禁止出现 README.md 文件名的文件），新功能放新文件、新包、新 bundle，通过现有扩展点（cordis.yml 组合、插件注册、capability seam）挂接；禁止通过修改原生文件来落地新功能。
- 禁止重排、重命名、格式化或顺手优化任何原生内容；触碰原生文件的行数越少，rebase 冲突面越小。
- 每一处对原生文件的修改或删除必须用标记注释包围：块形式为 `// BEGIN uitstalie-${llm_model_name}, ${yyyy/MM/dd}, ${mission_id}, ${修改原因简述}` 开始行加 `// END uitstalie-${llm_model_name}` 结束行，单行修改用行尾单行注释 `// uitstalie-${llm_model_name}, ${yyyy/MM/dd}, ${mission_id}, ${修改原因简述}`；注释语法按宿主文件类型调整，不支持注释的文件（如 JSON）改为在任务单中逐处登记文件、位置与原因。
- 修改模式优先插入式：原行保留，新增内容放进标记注释内；只有新内容必须插到原行中间或前面时，才注释掉原行并在标记内重写。
- mission_id 对应 goal/mission/ 下的任务单文档，文件名即 mission_id，内容记录需求（requirement）与本次修改范围；修改原生文件前必须先与用户约定并建立任务单。每个任务先判断是新 mission 还是已有 mission 的变更；两种情况都必须创建新的任务单文档，无论变更范围和变化大小——变更已有 mission 时，新文档使用新的 mission_id，并注明变更自哪个原任务单。
- 删除原生代码先逻辑删除（配置、cordis.yml 的 `disabled`、插件覆盖、标记注释包裹的提前返回块）；必须物理删除时删最小连续块，并在任务单中登记删除点与理由。
- 分支自有文件与原生文件的修改分开提交；原生修改的提交保持少而集中。
- 每次 rebase 到 master 后执行 `git grep -n "uitstalie-"` 盘点全部标记，逐处确认适配结果；即使出现破坏性 rebase，也凭标记与任务单快速梳理和恢复。
- 代码风格偏好（用户明确要求，对分支自有代码强制）：函数最小化且可组合——小函数、可复用函数、函数的组合优先于大函数，让 debug 与组合更简单、逻辑更清楚；数据与逻辑分离——数据形状做成有名字的纯数据接口（data class），数据之间用组合方式构造，行为函数只读写这些数据而不把形状匿名内联。
