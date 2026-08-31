# task7 — 修复 web 引导：`dsh web` 报 "HTML did not preload @deepseek-ai/dsh-client-modules/client.js"

## requirement

用户报告 `dsh web` 启动后浏览器引导页失败：`Failed to load plugins — client-modules: HTML did not preload @deepseek-ai/dsh-client-modules/client.js`（create() 时队列里没有 client-modules 注册）。用户确定问题、本方负责修复。

## 根因（已实证）

1. 服务端组合出的 `__DSH_BOOT__` 为 `ENTRIES=0 BATCHES=0`——ClientModuleRegistry 的插件表为空，bootstrap 批次缺失（诊断：one-shot 服务器 + 抓取注入 HTML）。
2. 逐条 processOne 打桩显示全部 client 行 `sources=0`，即 `resolveMeta` 统一返回 null（构建产物 lib 打桩，非源码改动）。
3. 再深一层打桩定位：`locatePkgJson` 里 `internal.resolveSync(baseUrl, {specifier, attributes})`（v2 调用形）抛 `The "parentURL" argument must be of type string ... Received an instance of Object`。
4. 根源：`vendor/loader/src/internal.ts` 的 `ModuleLoader.fromInternal()` 按**大版本号**判定内部 ModuleLoader 形状（`major >= 24 → v2`）。本机 Node v24.11.0 的 cascaded loader 实测仍是 **v1 形状**（`getOrCreateModuleJob: undefined`、`getModuleJobForImport: function`、`resolveSync(specifier, parentURL, attributes)`），被误标为 v2 后，registry 的 v2 调用形全部抛错，所有 client 行解析失败且被静默归类为"非 client 行"（negative verdict）。
5. CI 未拦截的原因：keyless 浏览器 smoke 走 assembled-boot 夹具（假模块表），真机 e2e 无 DEEPSEEK_API_KEY 自跳过；该路径只在真实本地启动时触发。

## 修改范围

- 新增分支自有文件：本任务单 `goal/mission/task7.md`。

## 原生文件修改登记

- `vendor/loader/src/internal.ts`：`fromInternal()` 的 v1/v2 判定改为按**方法形状**探测（`getOrCreateModuleJob` 存在即 v2，否则 v1），带 `uitstalie-k3` 标记注释。
- `vendor/README.md`：Local modifications 追加第 19 条登记此项分歧（vendoring policy 要求；条目文本自带 uitstalie 标记）。
- 诊断副产物（已还原，不进提交）：`packages/client/modules/lib/index.js` 临时打桩日志，由 `pnpm run build` 重新生成覆盖。
