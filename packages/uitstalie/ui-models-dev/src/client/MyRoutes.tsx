/**
 * "我的路由"管理区：llm-plus 命名空间里现有路由的列表 + 行内编辑/删除。
 * 纯 props 展示组件；数据与回调全部来自 props。
 *
 * @module @deepseek-ai/dsh-client-ui-models-dev/MyRoutes
 */

import type { OAuthFlowId, ProtocolName, RouteConfig } from '@deepseek-ai/dsh-llm-plus'
import { JsonField, TextField } from './fields.tsx'
import { type ModelsDevKey } from './locales.ts'
import { OAUTH_FLOW_CHOICES, type RouteDraft } from './route-edit.ts'
import styles from './ModelsDevSection.module.css'

/** 协议选项（顺序即下拉顺序）。 */
const PROTOCOLS: readonly ProtocolName[] = ['openai-completions', 'openai-responses', 'anthropic-messages', 'gemini']

/** 组件入参（纯数据 + 回调）。 */
export interface MyRoutesProps {
  /** 当前路由表（llm-plus 命名空间的生效值）。 */
  routes: Record<string, RouteConfig>
  /** 正在编辑的路由 id 与草稿。 */
  editing: { routeId: string; draft: RouteDraft } | undefined
  /** 编辑/删除失败的 host 消息。 */
  failure: string | null
  t: (key: ModelsDevKey) => string
  onStartEdit: (routeId: string) => void
  onPatchDraft: (patch: Partial<RouteDraft>) => void
  onSaveEdit: () => void
  onCancelEdit: () => void
  onDelete: (routeId: string) => void
}

/** 单条路由的编辑表单（编辑面字段：命名/协议/端点/凭据/OAuth/extraParams/默认输出）。 */
function RouteEditForm(props: {
  draft: RouteDraft
  t: (key: ModelsDevKey) => string
  onPatch: (patch: Partial<RouteDraft>) => void
}) {
  const { draft, t, onPatch } = props
  return (
    <div className={styles.draftForm}>
      <TextField label={t('fieldDisplayName')} value={draft.displayName} onChange={(displayName) => { onPatch({ displayName }) }} />
      <label className={styles.field}>
        <span className={styles.fieldLabel}>{t('fieldProtocol')}</span>
        <select
          className={styles.input}
          value={draft.protocol}
          onChange={(event) => { onPatch({ protocol: event.target.value as ProtocolName }) }}
        >
          {PROTOCOLS.map(protocol => <option key={protocol} value={protocol}>{protocol}</option>)}
        </select>
      </label>
      <TextField label={t('fieldBaseURL')} value={draft.baseURL} onChange={(baseURL) => { onPatch({ baseURL }) }} />
      <TextField label={t('fieldApiKeyRef')} value={draft.apiKeyRef} onChange={(apiKeyRef) => { onPatch({ apiKeyRef }) }} />
      <label className={styles.field}>
        <span className={styles.fieldLabel}>{t('fieldOAuth')}</span>
        <select
          className={styles.input}
          value={draft.oauth}
          onChange={(event) => { onPatch({ oauth: event.target.value as OAuthFlowId | '' }) }}
        >
          <option value="">{t('oauthNone')}</option>
          {OAUTH_FLOW_CHOICES.map(flow => <option key={flow} value={flow}>{flow}</option>)}
        </select>
      </label>
      <JsonField label={t('fieldHeaders')} value={draft.headersText} onChange={(headersText) => { onPatch({ headersText }) }} />
      <JsonField label={t('fieldBody')} value={draft.bodyText} onChange={(bodyText) => { onPatch({ bodyText }) }} />
      <TextField label={t('fieldMaxTokens')} value={draft.defaultMaxTokensText} onChange={(defaultMaxTokensText) => { onPatch({ defaultMaxTokensText }) }} />
    </div>
  )
}

/** 编辑/删除失败的文案映射（store 产出定位键，字典文案归这里）。 */
function failureText(failure: string, t: (key: ModelsDevKey) => string): string {
  if (failure === 'headers') return t('routeFailureHeaders')
  if (failure === 'body') return t('routeFailureBody')
  if (failure === 'maxTokens') return t('routeFailureMaxTokens')
  return failure
}

/** "我的路由"管理区（无路由时整块不渲染）。 */
export function MyRoutes(props: MyRoutesProps) {
  const { routes, editing, t } = props
  const ids = Object.keys(routes).sort()
  if (ids.length === 0) return null
  return (
    <div className={styles.oauthPanel}>
      <span className={styles.fieldLabel}>{t('myRoutes')}</span>
      {ids.map((routeId) => {
        const route = routes[routeId]
        if (route === undefined) return null
        const isEditing = editing?.routeId === routeId
        return (
          <div key={routeId} className={styles.rowCard}>
            <div className={styles.rowHead}>
              <span className={styles.rowTitle}>{route.displayName ?? routeId}</span>
              <span className={styles.rowMeta}>{routeId}</span>
              <span className={styles.badge}>{route.protocol}</span>
              {route.oauth !== undefined && <span className={styles.badge}>{route.oauth}</span>}
              <span className={styles.rowAction}>
                {isEditing
                  ? (
                    <>
                      <button className={styles.submitButton} onClick={() => { props.onSaveEdit() }}>{t('routeSave')}</button>
                      <button className={styles.submitButton} onClick={() => { props.onCancelEdit() }}>{t('oauthCancel')}</button>
                    </>
                  )
                  : (
                    <>
                      <button className={styles.submitButton} onClick={() => { props.onStartEdit(routeId) }}>{t('routeEdit')}</button>
                      <button className={styles.submitButton} onClick={() => { props.onDelete(routeId) }}>{t('routeDelete')}</button>
                    </>
                  )}
              </span>
            </div>
            {isEditing && editing !== undefined && (
              <RouteEditForm draft={editing.draft} t={t} onPatch={props.onPatchDraft} />
            )}
          </div>
        )
      })}
      {props.failure !== null && <span className={styles.errorText}>{failureText(props.failure, t)}</span>}
    </div>
  )
}
