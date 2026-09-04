/**
 * 单个提供商的草稿编辑表单（纯 props 展示组件：数据与回调全部来自
 * props，不碰任何外部状态——字段变更经 onPatch 派发回 store）。
 *
 * @module @deepseek-ai/dsh-client-ui-models-dev/DraftForm
 */

import type { CatalogModelSummary, CatalogProviderSummary } from '@deepseek-ai/dsh-models-dev/types'
import type { OAuthFlowId, ProtocolName } from '@deepseek-ai/dsh-llm-plus'
import type { ProviderDraft } from './draft.ts'
import { JsonField, TextField } from './fields.tsx'
import { fill, type ModelsDevKey } from './locales.ts'
import { OAUTH_FLOW_CHOICES } from './route-edit.ts'
import styles from './ModelsDevSection.module.css'

/** llm-plus 的四协议选项（顺序即下拉顺序）。 */
const PROTOCOLS: readonly ProtocolName[] = ['openai-completions', 'openai-responses', 'anthropic-messages', 'gemini']

/** 组件入参（纯数据 + 回调）。 */
export interface DraftFormProps {
  provider: CatalogProviderSummary
  draft: ProviderDraft
  /** subset 模式的模型数据（'loading' = 拉取中）。 */
  models: readonly CatalogModelSummary[] | 'loading' | undefined
  t: (key: ModelsDevKey) => string
  onPatch: (patch: Partial<ProviderDraft>) => void
  onModelMode: (mode: ProviderDraft['modelMode']) => void
  onToggleModel: (modelId: string, checked: boolean) => void
}

/** 模型子集勾选区（全部跟随目录 / 选定子集两态）。 */
function ModelPicker(props: DraftFormProps) {
  const { draft, models, t } = props
  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>{t('fieldModels')}</span>
      <label className={styles.radioRow}>
        <input
          type="radio"
          checked={draft.modelMode === 'all'}
          onChange={() => props.onModelMode('all')}
        />
        <span>{t('modelsAll')}</span>
      </label>
      <label className={styles.radioRow}>
        <input
          type="radio"
          checked={draft.modelMode === 'subset'}
          onChange={() => props.onModelMode('subset')}
        />
        <span>{t('modelsSubset')}</span>
      </label>
      {draft.modelMode === 'subset' && (
        <div className={styles.modelList}>
          {models === undefined || models === 'loading'
            ? <span className={styles.notice}>{t('modelsLoading')}</span>
            : models.map(model => (
              <label key={model.id} className={styles.modelRow}>
                <input
                  type="checkbox"
                  checked={draft.modelIds.includes(model.id)}
                  onChange={event => props.onToggleModel(model.id, event.target.checked)}
                />
                <span>{model.name ?? model.id}</span>
              </label>
            ))}
        </div>
      )}
    </div>
  )
}

/** 草稿编辑表单：路由 id/展示名/协议/端点/凭据/extraParams/模型子集。 */
export function DraftForm(props: DraftFormProps) {
  const { provider, draft, t, onPatch } = props
  return (
    <div className={styles.draftForm}>
      <TextField label={t('fieldRouteId')} value={draft.routeId} onChange={routeId => onPatch({ routeId })} />
      <TextField label={t('fieldDisplayName')} value={draft.displayName} onChange={displayName => onPatch({ displayName })} />
      <label className={styles.field}>
        <span className={styles.fieldLabel}>{t('fieldProtocol')}</span>
        <select
          className={styles.input}
          value={draft.protocol}
          onChange={event => onPatch({ protocol: event.target.value as ProviderDraft['protocol'] })}
        >
          <option value="">{t('protocolChoose')}</option>
          {PROTOCOLS.map(protocol => <option key={protocol} value={protocol}>{protocol}</option>)}
        </select>
      </label>
      <TextField label={t('fieldBaseURL')} value={draft.baseURL} onChange={baseURL => onPatch({ baseURL })} />
      {provider.api?.includes('${') && (
        <span className={styles.notice}>{fill(t('interpolatedUrl'), {})}</span>
      )}
      <TextField label={t('fieldApiKeyRef')} value={draft.apiKeyRef} onChange={apiKeyRef => onPatch({ apiKeyRef })} />
      <label className={styles.field}>
        <span className={styles.fieldLabel}>{t('fieldOAuth')}</span>
        <select
          className={styles.input}
          value={draft.oauth}
          onChange={event => onPatch({ oauth: event.target.value as OAuthFlowId | '' })}
        >
          <option value="">{t('oauthNone')}</option>
          {OAUTH_FLOW_CHOICES.map(flow => <option key={flow} value={flow}>{flow}</option>)}
        </select>
      </label>
      <TextField
        label={t('fieldApiKey')}
        type="password"
        value={draft.apiKey}
        placeholder={t('apiKeyPlaceholder')}
        onChange={apiKey => onPatch({ apiKey })}
      />
      <JsonField label={t('fieldHeaders')} value={draft.headersText} onChange={headersText => onPatch({ headersText })} />
      <JsonField label={t('fieldBody')} value={draft.bodyText} onChange={bodyText => onPatch({ bodyText })} />
      <ModelPicker {...props} />
    </div>
  )
}
