/**
 * llm-plus 插件入口：自有多协议 LLM 适配器。
 *
 * 函数插件形态（name/inject/Config/apply，无默认导出——混入默认导出会让
 * Loader 丢弃命名空间，见 docs/postmortem/0001）。
 *
 * 挂载行为：
 * - 解析路由表（结构性错误在此抛错，fiber 进入 FAILED）；
 * - 构造一个 PlusAdapter 并把全部路由注册进 `ctx.llm`（fiber 卸载自动摘除）；
 * - settings 动态化：经 installSettingsSection 把 cordis.yml 的 config 作为
 *   base 层注册进 `llm-plus` 命名空间，用户层变更时重新解析路由并
 *   原子替换注册（registration.replace + adapter.updateRoutes）；
 *   settings 服务缺席时该接线保持休眠，路由表就等于 cordis.yml 配置。
 *
 * 依赖：inject ['llm', 'credentials']（凭据解析是 credentials seam 唯一
 * 路径——本插件不读 process.env，环境变量兜底是 credentials provider
 * 自己的分层职责）。modelsDev / attachments 走可选 ctx.get 读取。
 *
 * @module @deepseek-ai/dsh-llm-plus
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { PlusAdapter } from './adapter.ts'
import { resolveRoutes, type PlusConfig } from './config.ts'

export type * from './config.ts'
export { PlusAdapter } from './adapter.ts'

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'llm-plus'

/** 注册路由需要 llm；凭据解析的唯一路径是 credentials seam。 */
export const inject = ['llm', 'credentials']

/** settings 命名空间（用户层覆盖 cordis.yml 的 routes 表）。 */
export const SETTINGS_NS = 'llm-plus'

/**
 * 配置 schema。routes 的嵌套形状在 resolveRoutes 里手工校验（fail loud
 * 在激活点），schema 层只保证 routes 是对象表——逐字段的手工校验能给出
 * 带路由名的精确错误，比 schema 的通用 issues 更可行动。
 */
export const Config: z<PlusConfig> = z.object({
  routes: z.dict(z.any()).required(),
})

/**
 * 挂载适配器。
 *
 * 接线说明：installSettingsSection 内部用 ctx.inject(['settings'], …)，
 * settings 服务不存在时整个接线休眠（组合里没有 settings 的 composition
 * 即纯 cordis.yml 配置）。onChange 在 attach/变更/detach 时都会触发，
 * 每次重新解析当前生效源并原子替换；非法配置由 installSettingsSection
 * 的 validate 在写入点拒绝，onChange 读到的必是合法形状。
 */
export function apply(ctx: Context, config: PlusConfig): void {
  const catalog = ctx.get('modelsDev', false)
  const attachments = ctx.get('attachments', false)
  const adapter = new PlusAdapter(resolveRoutes(config.routes), {
    ...(catalog === undefined ? {} : { catalog }),
    credentials: ctx.credentials,
    ...(attachments === undefined ? {} : { attachments }),
  })

  // 注册 handle 持有当前路由集；replace 在同一 adapter 实例上原子换路由
  const registration = ctx.llm.registerAdapter(adapter.routeIds(), adapter)
  ctx.effect(() => registration, 'llm-plus.registerAdapter')

  // 当前生效的路由表来源（settings 层或 cordis.yml 配置），由 setSource 更新
  let source: PlusConfig = config
  installSettingsSection(ctx, settingsNamespace(SETTINGS_NS), Config, config, {
    setSource: (current) => {
      // installSettingsSection 的契约是 source thunk 指向当前权威值；
      // 这里立即读出来固化（onChange 里直接用）
      source = current()
    },
    onChange: () => {
      const routes = resolveRoutes(source.routes)
      adapter.updateRoutes(routes)
      registration.replace(routes.map(route => route.id))
    },
  })
}
