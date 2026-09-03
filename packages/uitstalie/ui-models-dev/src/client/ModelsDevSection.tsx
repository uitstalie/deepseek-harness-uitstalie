/**
 * models.dev 目录设置页（settings.section 的注册组件）。
 * 结构：筛选框 → 提供商列表（ProviderCard）→ 提交栏（选中数 + 提交 + 回执）。
 * 组件是纯展示的：一切数据经 inject face（controller/useSnapshot/t）到达，
 * 一切变更经 controller 的动作派发出��。
 *
 * @module @deepseek-ai/dsh-client-ui-models-dev/ModelsDevSection
 */

import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { fill, type ModelsDevKey } from './locales.ts'
import { ProviderCard } from './ProviderCard.tsx'
import type { ModelsDevState, ModelsDevStore, SubmitFailure } from './store.ts'
import styles from './ModelsDevSection.module.css'

/** 本页经 slots inject 注入的依赖面。 */
export interface ModelsDevSectionInjected {
  /** 页面控制器（加载/勾选/草稿/提交动作）。 */
  controller: ModelsDevStore
  hooks: {
    /** 页面快照（renderer 绑为 useSnapshot）。 */
    snapshot: SnapshotStore<ModelsDevState>
  }
  /** 本页文案（settings.models-dev 命名空间）。 */
  t: (key: ModelsDevKey) => string
}

/** 组件 props：inject face 摊平（测试可部分给值）。 */
export type ModelsDevSectionProps = Partial<InjectFace<ModelsDevSectionInjected>>

/** 提交失败的文案映射（store 的结构化失败 → 字典文案）。 */
function failureText(failure: SubmitFailure, t: (key: ModelsDevKey) => string): string {
  switch (failure.kind) {
    case 'protocol': return fill(t('protocolRequired'), { provider: failure.provider })
    case 'invalidJson': return fill(t('invalidJson'), { field: failure.field, provider: failure.provider })
    case 'conflict': return t('conflict')
    case 'message': return fill(t('addFailed'), { message: failure.message })
  }
}

/** 页面根组件。 */
export function ModelsDevSection(props: ModelsDevSectionProps) {
  const { controller, useSnapshot, t } = props
  // 装配保障下三者必在；Partial 是测试直给 props 的零机关路径
  if (controller === undefined || useSnapshot === undefined || t === undefined) return null
  const state = useSnapshot(snapshot => snapshot)

  if (state.status === 'loading' || state.status === 'idle') {
    return <div className={styles.section}><span className={styles.notice}>{t('loading')}</span></div>
  }
  if (state.status === 'error') {
    return (
      <div className={styles.section}>
        <span className={styles.errorText}>{fill(t('loadFailed'), { message: state.error ?? '' })}</span>
        <div className={styles.submitBar}>
          <button className={styles.submitButton} onClick={() => void controller.load()}>{t('retry')}</button>
        </div>
      </div>
    )
  }

  const filter = state.filter.trim().toLowerCase()
  const visible = state.providers.filter(provider => filter === ''
    || provider.id.toLowerCase().includes(filter)
    || (provider.name ?? '').toLowerCase().includes(filter)
    || (provider.npm ?? '').toLowerCase().includes(filter))
  const selectedCount = Object.keys(state.drafts).length

  return (
    <div className={styles.section}>
      <p className={styles.subtitle}>{t('subtitle')}</p>
      <input
        className={styles.input}
        value={state.filter}
        placeholder={t('filterPlaceholder')}
        onChange={event => controller.setFilter(event.target.value)}
      />
      {visible.length === 0 && (
        <span className={styles.notice}>{state.providers.length === 0 ? t('empty') : t('emptyFilter')}</span>
      )}
      <div className={styles.list}>
        {visible.map(provider => (
          <ProviderCard
            key={provider.id}
            provider={provider}
            draft={state.drafts[provider.id]}
            models={state.models[provider.id]}
            t={t}
            onToggle={checked => controller.toggleProvider(provider, checked)}
            onPatch={patch => controller.updateDraft(provider.id, patch)}
            onModelMode={mode => controller.setModelMode(provider.id, mode)}
            onToggleModel={(modelId, checked) => controller.toggleModel(provider.id, modelId, checked)}
          />
        ))}
      </div>
      {selectedCount > 0 && (
        <div className={styles.submitBar}>
          <button
            className={styles.submitButton}
            disabled={state.submitting}
            onClick={() => void controller.submit()}
          >
            {state.submitting ? t('adding') : fill(t('addSelected'), { count: String(selectedCount) })}
          </button>
        </div>
      )}
      {state.submitError !== null && <span className={styles.errorText}>{failureText(state.submitError, t)}</span>}
      {state.addedRoutes.length > 0 && (
        <span className={styles.okText}>{fill(t('addedRoutes'), { routes: state.addedRoutes.join(', ') })}</span>
      )}
    </div>
  )
}
