/**
 * 函数插件：把 models-dev 配置的额外 body 参数接进 DeepSeek 请求。
 *
 * 为什么不走 `llm/stream` waterfall（初版设想）：loop 组装的请求到达
 * waterfall 时是深冻结的（mutation 直接抛错），且 waterfall 的 next() 链
 * 转发固定参数，监听器没有改写 GenerateOptions 的机制；而 GenerateOptions
 * 本身也没有携带额外 headers/body 的字段。请求体的组装归 adapter 所有，
 * 所以 DeepSeek 路由的**设计写入位置**是 `deepseekLlmApiExtensions` 缝：
 * 每个配置的 body 键注册一个顶层字段，prepare() 在请求序列化后、发送前
 * 被调用，能从 body.model 读到模型 id 并贡献字段值。与基础请求字段冲突时
 * adapter 会 fail loud（REQUEST_EXTENSION）。
 *
 * 额外 **headers** 目前只有数据没有注入：DeepSeek adapter 的 header 表是
 * 自有的、没有缝。这个缺口记录在 goal/models-dev-plugin.md。
 *
 * 挂载前提：组合里同时有 modelsDev 与 deepseekLlmApiExtensions 两个服务
 * （dsh-base bundle 默认带后者；没有的 composition 不要挂本插件，
 * 只挂包根的服务即可）。
 *
 * @module @deepseek-ai/dsh-models-dev/deepseek-extra-params
 */

import type { Context } from '@deepseek-ai/cordis'
import type { DeepSeekLlmApiExtensionProvider, DeepSeekLlmApiJson } from '@deepseek-ai/dsh-deepseek-llm-api-extensions'

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'models-dev-deepseek-extra-params'

/** 本插件要写的两个服务：目录 + DeepSeek 请求扩展注册表。 */
export const inject = ['modelsDev', 'deepseekLlmApiExtensions']

/** 接收注入的 harness 路由。DeepSeek 官方 adapter 只服务这一个路由。 */
export const TARGET_ROUTE = 'deepseek-official'

/**
 * 为每个配置的 body 键注册一个扩展字段。
 *
 * 工作机制：注册是"每顶层字段一个 provider"（Registry.register 的契约，
 * 同名字段重复注册会抛错）；provider.prepare 在**每个请求**序列化后被调用，
 * 从 body.model 读模型 id，查目录的 resolveExtraParams，只在该模型确实
 * 配置了该键时贡献值（返回 undefined = 本请求不贡献）。
 * 注册经 ctx 的 effect 作用域管理，fiber 卸载时自动摘除。
 */
export function apply(ctx: Context): void {
  for (const field of ctx.modelsDev.configuredBodyKeys(TARGET_ROUTE)) {
    const provider: DeepSeekLlmApiExtensionProvider<DeepSeekLlmApiJson> = {
      prepare(request) {
        // body.model 是 OpenAI 兼容请求体的固定字段；非字符串说明请求异常，
        // 此时不贡献（让 adapter 自己的校验去报错）
        const model = request.body['model']
        if (typeof model !== 'string') return undefined
        const params = ctx.modelsDev.resolveExtraParams(TARGET_ROUTE, model)
        const value = params.body?.[field]
        // 该模型没配置此键 → 不贡献；返回 undefined 与"值为 undefined"必须区分开
        return value === undefined ? undefined : { value }
      },
    }
    // 用户配置的字段名是运行时数据，无法写进静态声明合并的
    // DeepSeekLlmApiExtensionMap，这里做一次性收窄；运行时的重名防护
    // （register 对同名字段抛错）不受影响。
    ctx.deepseekLlmApiExtensions.register(field as never, provider as never)
  }
}
