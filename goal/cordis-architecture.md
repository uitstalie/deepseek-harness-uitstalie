# Cordis 核心五要素详细架构：Context / Plugin / Fiber / Effect / Service

本文是对 vendor/cordis（4.0.0-rc.7）核心层的逐文件精读结果，聚焦支撑"大规模替换插件"所需的精确机制：每个要素的类结构、关键字段、方法语义、状态机与交互时序。源码锚点以 `src/xxx.ts:行号` 标注（基于 vendored 快照）。任务单：[task2](mission/task2.md)（task1 概念版见本文"深入阅读路径"）。

## 总览：五个要素的关系

```
Context (Proxy)                     RegistryService (ctx.registry)
  │ 属性读取 ──► ReflectService.handler        │ _internal: Map<callback, Runtime>
  ▼                                            │ ctx.plugin() 创建 ──┐
ReflectService (ctx.reflect)                   ▼                    │
  store: label ──► Impl { name, fiber, value, check }        Plugin.Runtime
  props: name ──► Property.Service | Accessor                { callback, Config, fibers[] }
  ▲ provide/notify                                          │ 1..n
  │                                                         ▼
Fiber (插件运行时实例) ◄── 父子级联 ── Fiber.effect() 收集 disposer
  │ 依赖满足后 _reload() 执行插件体（callback / new / apply）
  ▼
插件体内：new XxxService(ctx) ──► Service 基类构造 ──► ctx.reflect.provide()
```

一句话：**Context 是带 Proxy 的服务仓库；Plugin 是静态的"形状 + 元数据"；Fiber 是 Plugin 的一次运行（作用域 + 状态机 + disposer 集合）；Effect 是挂在 Fiber 上的可逆注册原语；Service 是"构造即 provide"的插件基类。**

---

## 1. Context（`src/context.ts`）

### 1.1 结构与构造

`class Context`（context.ts:42）构造时：

1. 初始化两张符号键控的表：`[symbols.isolate]: Dict<symbol>`（服务名 → 隔离 label）与 `[symbols.intercept]: Dict`（服务名 → intercept 配置），均为 null-prototype 对象。
2. `new Proxy(this, ReflectService.handler)` —— **Context 返回的是 Proxy**（context.ts:74），此后所有普通属性读写都经 reflect 层。
3. 安装 5 个内建对象：`fiber`（root Fiber，uid=0，直接 ACTIVE）、`reflect`、`registry`、`events`、`logger`（context.ts:77-81）。
4. `root` 指向自身 proxy；`Context.is(value)` 用 `Symbol.for('cordis.is')` 品牌判定（跨 realm、跨 cordis 副本有效）。

类型侧的 `interface Context`（context.ts:16）是**声明合并的锚点**：各模块与各插件通过 `declare module './context.ts'` 往其上挂属性（`ctx.plugin`、`ctx.on`、`ctx.llm`……），运行侧则靠 Proxy + props/store 解析。

### 1.2 Proxy 语义（`src/reflect.ts:135-206` 的 `ReflectService.handler`）

**get 陷阱的判定顺序**（替换插件时必须理解这条链）：

1. `isSpecialProperty(prop)`（reflect.ts:86）：symbol、`prototype`、`then`、数字键、`_` 前缀 → 直通 `Reflect.get`，**不经服务解析**。
2. `Reflect.has(target, prop)`：own/原型链上真实存在的属性（如 `fiber`、`events`、`extend`）→ 取真值后经 `getTraceable` 包装返回（见 §6.3 traceable）。
3. `reflect.props[prop]` 是 accessor → 调其 `get`。
4. 否则进入 `internal/get` waterfall，默认行为（reflect.ts:153-166）：
   - 取本上下文的隔离 label `key = target[symbols.isolate][prop]`；
   - **沿 fiber 父链向上走**：查 `fiber.store?.[prop]`（该 fiber 加载时快照的依赖 Impl）；命中返回；
   - 若 `prop in fiber.inject`（声明了依赖但没在 store 里）→ 抛 `cannot get required service ... in inactive context`；
   - 若父上下文的 isolation label 变了 → 抛 `cannot get property ... without inject`；
   - 走到 root（`fiber.runtime == null`）→ 从 root reflect 的 store 兜底读（strict=false）。

**要点**：普通读 `ctx.foo` 命中的是 **fiber 加载时的依赖快照 `fiber.store`**，不是全局最新值——服务被替换后，只有被 notify 重新激活的 fiber 才看到新实现。`ctx.get(name, strict?)`（reflect.ts:233）绕过 inject 声明要求，直接查 root store。

**set 陷阱**：accessor 走其 `set`；否则 `internal/set` waterfall → `reflect.set()`：只有 **提供该服务的那个 fiber** 能改值（`impl.fiber !== ctx.fiber` 抛错，reflect.ts:260）。

### 1.3 子上下文三构造器（均不改父级）

| 方法 | 实现 | 效果 |
|---|---|---|
| `extend(meta)`（context.ts:99） | `Object.create(getTraceable(this, this))` + 拷贝 meta 的 own keys 为 own 属性 | 原型继承式覆盖；fiber 创建子上下文就是 `parent.extend({ fiber: this })`（fiber.ts:236） |
| `isolate(name, label?)`（context.ts:121） | shadow 化 isolate 表，`shadow[name] = label ?? Symbol(name)` | 该服务在此子树解析到独立 label；**相同 label 的两次调用共享作用域**（loader 的 entry `isolate` 选项靠它让多个 entry 共享/隔离服务实现） |
| `intercept(name, config)`（context.ts:141） | shadow 化 intercept 表 | 该服务在此子树下的实际配置 = 祖先链 intercept 合并（见 §5.4） |

---

## 2. Plugin（`src/registry.ts`）

### 2.1 三种形态与元数据

`Plugin` 联合类型（registry.ts:92）：

- `Plugin.Function`：`function (ctx, config)`；
- `Plugin.Constructor`：类，`new callback(ctx, config)` 构造（`isConstructor`，utils.ts:79：有 prototype 且非 generator/async-generator；async 函数与箭头函数无 prototype 被排除）。构造后先跑实例 `[symbols.initHooks]`（`@Inject` 方法装饰器在此挂入），再调 `instance[symbols.init]?.()`，其返回值按 Effect 形状收集（可以是 async generator 逐个 yield disposer，fiber.ts:250-261）；
- `Plugin.Object`：`{ apply(ctx, config) }` 对象。注意 `resolve()`（registry.ts:222）取 `plugin.apply` 作为身份 callback。

共享元数据 `Plugin.Base`（registry.ts:100）：

| 字段 | 消费方 | 语义 |
|---|---|---|
| `name` | registry/logger | 显示名（`apply` 名被丢弃，registry.ts:325） |
| `Config` | `resolveConfig()`（fiber.ts:50） | standard-schema 校验器，激活前同步校验；失败抛 `ValidationError`；**异步校验不支持**（fiber.ts:55 抛 TypeError） |
| `inject` | Fiber 构造 | 数组或 `name → intercept 配置` 映射，由 `Inject.resolve()`（registry.ts:71）归一化为 map；带 `symbols.checkProto` 的对象形式支持原型继承（`@Inject` 类装饰器产物） |
| `provide` | `Service` 基类、loader | 声明提供的服务名（Cordis 核心只读，`Service` 构造时用作默认名） |
| `intercept` | loader/工具 | 声明消费哪些服务的 intercept 配置 |

### 2.2 Registry：身份与实例的分离

`RegistryService._internal: Map<Function, Plugin.Runtime>`（registry.ts:197）：

- **身份键是可执行 callback**，不是插件对象。同一函数在多处 `ctx.plugin()` 共享一个 `Runtime`；两个内容相同的不同函数对象是两个插件。
- `Plugin.Runtime { name, callback, fibers: DisposableList<Fiber>, Config }`（registry.ts:136-145）：**一个插件的全部运行实例**挂在同一 Runtime 下。
- `registry.delete(plugin)`（registry.ts:258）：dispose 该插件全部 fiber 并删除 Runtime——这是"卸载一个插件"的原语；替换 = `delete` 旧的 + `plugin()` 新的，或由 loader/HMR 替你完成。
- `counter`（registry.ts:207）：单调分配 fiber uid。

### 2.3 `ctx.plugin()` 的完整时序（registry.ts:316 → fiber.ts:222）

1. `resolve(plugin)` 得 callback，非法形状抛错；`assertActive()` 拒绝在已 DISPOSED 的 fiber 上挂载。
2. 取/建 Runtime。
3. `new Fiber(parent, config, Inject.resolve(plugin.inject), runtime, getOuterStack)`：
   a. `ctx = parent.extend({ fiber: this })`；inject 中非空 intercept 配置并入子上下文 intercept 表（fiber.ts:238-245）；
   b. `this.dispose` 通过 **`parent.fiber.effect()` 注册**（fiber.ts:265，label `'ctx.plugin()'`）——父子级联卸载由此而来，且父 fiber 先拿到完整 disposer；
   c. emit `internal/plugin`（fiber.ts:302）——**loader 在此同步修改 fiber（如追加 inject、设置 `fiber.entry`）**；同步抛错则自清理后 rethrow；
   d. 之后才对 inject 逐个 `_checkImpl` + `_refresh()`（fiber.ts:314-318）——依赖解析被刻意推迟到发布之后。
4. 返回 `Object.create(fiber)` 的包装，`.then` 委托 `fiber.await()`（registry.ts:331-334）——**`await ctx.plugin(...)` 等生命周期稳定，启动失败会 rethrow**。

`ctx.inject(deps, callback)` = `ctx.plugin({ inject: deps, apply: callback })`（registry.ts:300）——"依赖就绪就运行、依赖变化就重跑"的临时插件。

---

## 3. Fiber（`src/fiber.ts`）

### 3.1 字段结构

```ts
class Fiber {
  uid: number | null            // 0=root；null=已 DISPOSED
  ctx: Context                  // parent.extend({ fiber: this }) 的子上下文
  config: any                   // 校验后的生效配置
  _config: any                  // 原始配置；每次激活前经 internal/config 重新解析（!!js 惰性求值的落点）
  state: FiberState
  dispose: () => Promise<void>  // 构造时通过 parent.fiber.effect() 建立
  store: Dict<Impl> | undefined // 激活期间的依赖快照；unload 后 undefined
  inertia: Promise<void> | undefined  // 在途的 _reload/_unload 转换
  _hooks: Dict<DisposableList<Function>>  // per-fiber 事件钩子（internal/update 用，events.ts:140）
  _disposables: DisposableList<Disposable> // 本 fiber 收集的全部 disposer
  inject: Dict<any>             // 归一化后的依赖 map
  runtime: Plugin.Runtime | null
}
```

### 3.2 状态机

`FiberState`（fiber.ts:147，const enum）：`PENDING → LOADING → ACTIVE`；旁支 `FAILED`、卸载路径 `UNLOADING → (重新 LOADING | DISPOSED)`。

- `_getState()`（fiber.ts:574）：`uid===null → DISPOSED`；`_error → FAILED`；`epoch !== INACTIVE → ACTIVE`；否则 PENDING。
- 状态迁移由 `_updateState()`（fiber.ts:581）执行：emit `internal/status(fiber, oldState)`；**只有 ACTIVE ↔ 非 ACTIVE 的跳变**才对本 fiber 拥有的服务调用 `reflect.notify()`（fiber.ts:589-594）——服务可用性广播由此驱动。
- epoch 机制（fiber.ts:611-639）：`_refresh()` 把 inject 依赖的实现 uid 拼成 epoch 字符串（任一缺失 → `INACTIVE`）；`_setEpoch` 在 epoch 变化时启动 `_reload()`（INACTIVE→有效）或 `_unload()`（有效→INACTIVE）。**epoch 同时是异步失效栅栏**：`_execute`/`_reload` 中比对 `runner.epoch !== oldEpoch` 即放弃过期工作（fiber.ts:390、654）——替换插件时旧 fiber 的慢启动不会复活。

### 3.3 激活与卸载

`_reload()`（fiber.ts:646）：

1. `store = { ..._store }` 冻结依赖快照；
2. 过 `internal/config` waterfall 解析 `_config`（loader 在此做 `!!js` 求值，**时机在 inject 激活后**），再 `resolveConfig()` 做 schema 校验；
3. `_execute(this._runner)` 运行插件体，其返回的 disposer 收集进 `_disposables`；
4. 失败：`logger.error` + `_error = reason` + epoch 置 INACTIVE → 状态变 FAILED。

`_unload()`（fiber.ts:675）：`_disposables.clear()`（**逆序**返回）逐个 await 执行，单个失败只记日志不中断；`store = undefined`；若 epoch 仍有效则接 `_reload()`（restart 语义）。

公开操作：

- `fiber.dispose()`：永久销毁。uid 置 null → emit `internal/plugin`（观察者隔离失败，fiber.ts:120-137）→ 从 runtime.fibers 摘除（空则删 Runtime）→ epoch 置 INACTIVE → 等 `inertia` 排空。**PENDING 期间被观察者注册的 effect 也会被显式排空**（fiber.ts:277-286 的加固）。
- `fiber.restart()`：`_setEpoch(INACTIVE)` + `_refresh()` → 即 unload+reload（fiber.ts:718）。
- `fiber.update(config, noSave?)`（fiber.ts:736）：非 ACTIVE 时只记 `_config` 等激活；ACTIVE 时先校验再过 `internal/update` waterfall（**可否决**——loader 在此做事务回滚与写回），默认行为是赋 config + restart，返回 waterfall 结果。
- `fiber.await()`：排空 inertia 并 rethrow 启动错误。

### 3.4 依赖检查与通知回路

- `_checkImpl(name)`（fiber.ts:597）：从 root reflect store 查 Impl，存在且 `impl.check()` 通过才记入 `_store`；check 抛错只记日志、视为不可用。
- `reflect.notify(names)`（reflect.ts:314）：遍历**全部 runtime × fiber**，对 inject 了这些服务且 isolation scope 匹配的 fiber 重跑 `_checkImpl` + `_refresh()`，然后按名 emit `internal/service(name, value)`（带 filter 上下文）。
- **这就是替换插件的传导机制**：旧服务摘除/新服务注册 → notify → 依赖方 fiber epoch 变化 → `_unload`/`_reload` 级联重启。替换一个被广泛依赖的服务，会引发整棵依赖子树的重启。

### 3.5 vendored 加固要点（`vendor/README.md` 第 6 条）

- effect 的 owner 列表 wrapper 在 setup **之前**注册（fiber.ts:520），setup 内重入 unload 会等 setup 完成后接清理；
- 同步 setup 失败：摘除 wrapper + 回滚已收集清理（fiber.ts:523-537）；
- `UNLOADING` 状态拒绝新建 effect（fiber.ts:420-422），`PENDING`/`LOADING` 仍允许；
- 子 fiber 先完成父级 disposer 注册再发布 `internal/plugin`；
- 异步清理在完成前保持 owner 可见（`effectInertia` WeakMap，fiber.ts:112），结构性 owner 可加入他人已启动的清理，公开 disposer 保持单次幂等。

---

## 4. Effect（`src/fiber.ts` 的 `effect()` + `src/utils.ts`）

### 4.1 接受的形状与收集

`ctx.effect(execute, label?)`（fiber.ts:418）：`execute` 立即执行，返回值按形状处理（`_execute`，fiber.ts:356-400）：

| 返回 | 处理 |
|---|---|
| disposer 函数 | 收集 |
| `null`/`undefined` | 无清理 |
| `Promise<disposer>` | await 后收集 |
| 同步可迭代（generator） | 逐个 yield 边产出边收集 |
| 异步可迭代 | 同上，且每个 `await` 后检查 epoch 栅栏 |
| 其他 | `TypeError('Invalid effect')` |

清理语义：disposer **逆序**执行；异步的被 await；公开 wrapper 幂等（重复调用返回同一 task）。

### 4.2 返回的 wrapper

- 本身是 disposer：调用即逆序清理；
- 又是 thenable：`await wrapper` 等 setup 完成后返回内部 disposer（fiber.ts:555-559）；
- 携带 `[symbols.effect]: EffectMeta { label, children }` 诊断树，`fiber.getEffects()`（fiber.ts:568）可枚举当前存活 effect——排查"谁注册了什么"时用。

### 4.3 建立在 effect 之上的一切

`on`/`once`（events.ts:254-302）、`provide`（reflect.ts:277-304）、`accessor`、`mixin`（reflect.ts:345-390）、`Service` 注册（service.ts:57）、timer 的 timeout/interval、`logger.exporter`——**全部**是带 label 的 effect。因此 fiber unload 一键回收所有注册；这也是"注册即 effect"约定的原因：替换插件时只要 fiber 被 dispose，它的一切贡献（服务、监听、accessor）自动消失。

### 4.4 `DisposableList`（utils.ts:5-40）

`push` 返回 O(1) 删除器；`clear()` 返回**逆序**数组并清空——`_unload` 与 wrapper 清理都靠它保证逆序。

---

## 5. Service（`src/service.ts` + `src/reflect.ts`）

### 5.1 基类契约

```ts
abstract class Service<T = never> {
  constructor(protected ctx: Context, name: string)
  // 静态符号槽：init / check / config / invoke / extend / tracker / resolveConfig
}
```

构造器（service.ts:42-59）做的事：

1. `name ??= constructor['provide']`（静态 provide 字段兜底）；
2. 若实例有 `[symbols.invoke]` → 用 `createCallable` 包成**可调用服务**（`ctx.logger(name)` 的原理：LoggerService 的 invoke 即"按名取 logger"，logger.ts:251）；
3. `ctx.reflect.provide(name, self, this[symbols.check])` —— **构造即注册**，且注册是 fiber 的 effect，fiber unload 自动摘除；
4. 挂 `[symbols.tracker] = { associate: name, property: 'ctx' }` 供 traceable 机制识别。

### 5.2 提供侧：`reflect.provide` 的语义（reflect.ts:277）

- `props[name]` 记为 `{ type: 'service' }`；accessor 同名冲突抛错；
- root 的 isolate 表为服务名**惰性分配 label**（`Symbol(name)`，reflect.ts:286）；同 scope 重复注册抛 `service "x" has been registered at <fiber名>`；
- Impl 记入 root store（按 label 键）与 `fiber.store[name]`；fiber 已 ACTIVE 则立即 `notify`；
- 摘除时（disposer）：删 store → `notify` 唤醒依赖方 → **等所有受影响 fiber settle**（`Promise.allSettled(fiber.await())`，reflect.ts:297-302）→ 再从自己 store 删除。服务下线会等依赖方完成重启，这是替换时序里"先摘旧、等稳定、再上新"能成立的原因。

### 5.3 消费侧：inject + `_checkImpl`

- fiber 的 `inject` map 声明依赖；`_checkImpl` 要求 Impl 存在**且 `check()` 通过**；`Service[symbols.check]` 静态槽即此谓词（如 Loader 用它等任务排空）。
- 未声明 inject 直接读 `ctx.foo`：沿 fiber 链走到 root 也找不到快照条目 → 抛 `cannot get property "foo" without inject`（reflect.ts:144）。声明了但服务缺席：fiber 停在 PENDING，读取抛 `in inactive context`。

### 5.4 配置：intercept 合并（service.ts:86-102）

`service[Service.resolveConfig](base?, head?)`：沿 `ctx[Context.intercept]` 原型链从根到叶收集该服务的 intercept 配置，`Config.merge ? Config.merge(...configs) : Object.assign({}, ...configs)`。inject 的对象形式（`{ llm: { ... } }`）会在 fiber 创建时把该值并入子上下文 intercept 表（fiber.ts:240-244）——**消费方可以就地微调所依赖服务的配置**。

### 5.5 过滤与 traceable

- `Service[symbols.filter]`（service.ts:61）：事件 thisArg 过滤——只接收与本服务同 isolation scope 的事件（`dispatch()` 里 `filter.call(thisArg, hook.ctx)`，events.ts:171-174）。
- traceable（utils.ts:117-233）：从 `ctx.foo` 取到的服务经 `createTraceable` 代理，`tracker.property === 'ctx'` 的读取返回**调用方的上下文**，使服务方法内的 `this.ctx` 指向调用方 fiber 的上下文（副作用归属调用方）。`noShadow` 服务（如 logger）保留原始 fiber 身份。`associate` 使 `ctx.foo.bar` 形式可路由到名为 `foo.bar` 的独立服务。**替换插件后，旧服务对象的残留引用不会自动失效**——但通过 `ctx.` 正常取用的路径总是拿到新实现。

---

## 6. 替换插件时必读的行为清单

1. **身份是 callback**：`registry.delete(plugin)` 按 callback 摘全部 fiber；同函数多次挂载共享 Runtime。换实现要用新函数/新类，不能原地改。
2. **级联重启由 notify 驱动**：摘除一个服务会重启所有 inject 它的 fiber（unload→reload）。替换底层服务 = 其依赖子树整体重启，启动失败的 fiber 进入 FAILED 但不影响兄弟。
3. **时序保证**：`provide` 的摘除 disposer 等受影响 fiber settle 后才返回；`await ctx.plugin()` 等启动稳定并 rethrow 启动错误——替换流程可以全程 await。
4. **config 两道关**：`internal/config` waterfall（`!!js` 惰性求值，注入激活后）→ schema 校验（同步，失败 FAILED）。替换插件若改了 Config schema，cordis.yml 里的旧配置会在校验处抛 `ValidationError`，fiber 变 FAILED。
5. **`internal/update` 可否决**：`fiber.update()` 的默认 restart 可被 waterfall 监听器替换（loader 的事务回滚就挂在这里）；`internal/listener` bail 可改写注册（per-fiber `internal/update` 钩子就是这么接的，events.ts:140-146）。
6. **isolation scope**：同 label 共享服务实现；loader entry 的 `isolate`/`intercept` 选项经 `loader/patch-context` 改 scope 映射。替换服务时确认目标 scope，否则新实现注册在别的 label 下，消费方永远 PENDING。
7. **快照语义**：fiber 看到的是激活瞬间的依赖快照；只有 notify 触发的重启才刷新快照。绕过 inject 用 `ctx.get()` 拿到的引用不会随替换更新。
8. **cordis 4 无 `fork`/`ready`/`dispose` 事件**：对应语义是"新建 fiber"、`fiber.await()`、disposer + `internal/plugin`/`internal/status` 观察。

## 深入阅读路径

- loader/HMR 体系（事务式 Entry 更新、include patch、`!!js` 求值、hmr 重载策略）：见 [vendor/README.md](../vendor/README.md) 本地修改第 8/11/12/15 条与 `vendor/loader/src/`、`vendor/include/src/` 源码。
- 防御性模式（并发/拆毁前必读）：[docs/defensive-patterns.md](../docs/defensive-patterns.md)。
- 事件与瀑布语义入门：[docs/cordis-primer.md](../docs/cordis-primer.md)。
