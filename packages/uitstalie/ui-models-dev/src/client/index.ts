/**
 * models.dev 目录设置页插件（浏览器半区）。
 *
 * 挂载行为：
 * - `ctx.remote.$mount(...)` 把 models-dev 的 Host-for-Client Remote
 *   contribution 挂进本 fiber（包内自挂，不需要改原生 api/remotes 装配）；
 * - 注册 settings.models-dev 文案字典（双语）；
 * - `ctx.slots.inject('settings.section', …)` 等 shell 声明后注册目录页
 *   （declaration 未到时休眠，collapse 后摘除，再现时重挂）；
 * - 页面 store 经 inject face 传给组件；controller.load() 拉一次目录。
 *
 * @module @deepseek-ai/dsh-client-ui-models-dev/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only：拉进 shell 的 SlotMap merge（'settings.section' 条目）
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only：拉进 locale 插件的 Context merge（ctx.locale）
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only：拉进 ctx.remote merge 与 ClientRemote 类型
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import modelsDevRemote from '@deepseek-ai/dsh-models-dev/remote'
import { ModelsDevSection, type ModelsDevSectionInjected } from './ModelsDevSection.tsx'
import { ModelsDevStore, type ModelsDevWire } from './store.ts'
import { en, zh, type ModelsDevKey } from './locales.ts'

export type { ModelsDevSectionInjected, ModelsDevSectionProps } from './ModelsDevSection.tsx'
export type { ModelsDevKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** models.dev 目录设置页文案。 */
    'settings.models-dev': ModelsDevKey
  }
}

/** 文案命名空间。 */
const NS = 'settings.models-dev'

/**
 * Required services（cordis fiber inject）。'remote.modelsDev' 不在此列——
 * 它由本 apply 自己的 $mount 提供，模块级声明会死锁（等一个还不存在、
 * 且只有自己能供的服务）；apply 内挂完再经 ctx.inject 等待它
 * （experimental/client-ui-agent-team 的同款两步模式）。
 */
export const inject = ['slots', 'locale', 'remote', 'remote.settings', 'remote.credentials']

/**
 * 挂载目录设置页。
 * @returns 清理函数：摘除 Remote contribution（slots 注册随 fiber 自动摘除）。
 */
export async function apply(ctx: ClientContext): Promise<() => void> {
  const disposeRemote = await ctx.remote.$mount(modelsDevRemote)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-models-dev: copy dictionaries')

  const t = ctx.locale.bind(NS) as ModelsDevSectionInjected['t']
  // $mount 之后 remote.modelsDev 才存在：内层 inject 等待它并把全部用到的
  // 服务重新声明进作用域（内层作用域不继承外层的可访问集）
  ctx.inject(['slots', 'remote.modelsDev', 'remote.settings', 'remote.credentials'], (scoped) => {
    const wire: ModelsDevWire = {
      modelsDev: scoped.remote.modelsDev,
      settings: scoped.remote.settings,
      credentials: scoped.remote.credentials,
    }
    const controller = new ModelsDevStore(wire)
    const injected = (): ModelsDevSectionInjected => ({
      controller,
      hooks: { snapshot: controller.store },
      t,
    })

    scoped.slots.inject('settings.section', () => scoped.slots.register({
      name: 'settings.section',
      id: 'models-dev',
      order: 20,
      label: () => t('nav'),
      inject: injected,
    }, ModelsDevSection))

    // 目录拉取是页面级一次性动作（失败进 error 态，页面可重试）
    void controller.load()
  })
  return disposeRemote
}
