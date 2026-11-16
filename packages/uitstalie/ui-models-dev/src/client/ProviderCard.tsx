/**
 * One provider row in the catalog: checkbox + summary (display name/dialect/endpoint/model count) +
 * the draft form expanded after it is checked.
 *
 * @module @deepseek-ai/dsh-client-ui-models-dev/ProviderCard
 */

import type { CatalogModelSummary, CatalogProviderSummary } from '@deepseek-ai/dsh-models-dev/types'
import type { ProviderDraft } from './draft.ts'
import { OAUTH_BY_CATALOG_ID } from './draft.ts'
import { fill, type ModelsDevKey } from './locales.ts'
import { DraftForm } from './DraftForm.tsx'
import styles from './ModelsDevSection.module.css'

/** Component inputs (pure data + callbacks). */
export interface ProviderCardProps {
  provider: CatalogProviderSummary
  /** Undefined when not checked. */
  draft: ProviderDraft | undefined
  models: readonly CatalogModelSummary[] | 'loading' | undefined
  t: (key: ModelsDevKey) => string
  onToggle: (checked: boolean) => void
  onPatch: (patch: Partial<ProviderDraft>) => void
  onModelMode: (mode: ProviderDraft['modelMode']) => void
  onToggleModel: (modelId: string, checked: boolean) => void
}

/** The catalog row for one provider. */
export function ProviderCard(props: ProviderCardProps) {
  const { provider, draft, t } = props
  return (
    <div className={styles.rowCard}>
      <label className={styles.rowHead}>
        <input
          type="checkbox"
          checked={draft !== undefined}
          onChange={(event) => { props.onToggle(event.target.checked) }}
        />
        <span className={styles.rowTitle}>{provider.name ?? provider.id}</span>
        <span className={styles.rowMeta}>{provider.id}</span>
        {provider.npm !== undefined && <span className={styles.badge}>{provider.npm}</span>}
        {OAUTH_BY_CATALOG_ID[provider.id] !== undefined && <span className={styles.badge}>{t('oauthBadge')}</span>}
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
