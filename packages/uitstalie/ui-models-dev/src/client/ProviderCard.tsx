/**
 * 目录中的一个提供商行：勾选框 + 摘要（显示名/方言/端点/模型数）+
 * 勾选后展开的草稿表单。
 *
 * @module @deepseek-ai/dsh-client-ui-models-dev/ProviderCard
 */

import type { CatalogModelSummary, CatalogProviderSummary } from '@deepseek-ai/dsh-models-dev/types'
import type { ProviderDraft } from './draft.ts'
import { OAUTH_BY_CATALOG_ID } from './draft.ts'
import { fill, type ModelsDevKey } from './locales.ts'
import { DraftForm } from './DraftForm.tsx'
import styles from './ModelsDevSection.module.css'

/** 组件入参（纯数据 + 回调）。 */
export interface ProviderCardProps {
  provider: CatalogProviderSummary
  /** 未勾选为 undefined。 */
  draft: ProviderDraft | undefined
  models: readonly CatalogModelSummary[] | 'loading' | undefined
  t: (key: ModelsDevKey) => string
  onToggle: (checked: boolean) => void
  onPatch: (patch: Partial<ProviderDraft>) => void
  onModelMode: (mode: ProviderDraft['modelMode']) => void
  onToggleModel: (modelId: string, checked: boolean) => void
}

/** 一个提供商的目录行。 */
export function ProviderCard(props: ProviderCardProps) {
  const { provider, draft, t } = props
  return (
    <div className={styles.rowCard}>
      <label className={styles.rowHead}>
        <input
          type="checkbox"
          checked={draft !== undefined}
          onChange={event => props.onToggle(event.target.checked)}
        />
        <span className={styles.rowTitle}>{provider.name ?? provider.id}</span>
        <span className={styles.rowMeta}>{provider.id}</span>
        {provider.npm !== undefined && <span className={styles.badge}>{provider.npm}</span>}
        {OAUTH_BY_CATALOG_ID[provider.id] !== undefined && <span className={styles.badge}>OAuth</span>}
        <span className={styles.rowMeta}>{fill(t('modelsCount'), { count: String(provider.modelCount) })}</span>
      </label>
      {provider.api !== undefined && <div className={styles.rowApi}>{provider.api}</div>}
      {draft !== undefined && (
        <DraftForm
          provider={provider}
          draft={draft}
          models={props.models}
          t={t}
          onPatch={props.onPatch}
          onModelMode={props.onModelMode}
          onToggleModel={props.onToggleModel}
        />
      )}
    </div>
  )
}
