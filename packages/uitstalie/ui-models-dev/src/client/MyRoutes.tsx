/**
 * "My routes" management area: the list of existing routes in the llm-plus namespace plus inline edit/delete.
 * A pure props presentational component; all data and callbacks come from props.
 *
 * @module @deepseek-ai/dsh-client-ui-models-dev/MyRoutes
 */

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OAuthFlowId, ProtocolName, RouteConfig } from '@deepseek-ai/dsh-llm-plus'
import { JsonField, TextField } from './fields.tsx'
import { type ModelsDevKey } from './locales.ts'
import { OAUTH_FLOW_CHOICES, type RouteDraft } from './route-edit.ts'
import styles from './ModelsDevSection.module.css'

/** Protocol options (this order is the dropdown order). */
const PROTOCOLS: readonly ProtocolName[] = ['openai-completions', 'openai-responses', 'anthropic-messages', 'gemini']

/** Component inputs (pure data + callbacks). */
export interface MyRoutesProps {
  /** Current route table (the effective value of the llm-plus namespace). */
  routes: Record<string, RouteConfig>
  /** The route id being edited and its draft. */
  editing: { routeId: string; draft: RouteDraft } | undefined
  /** Host message for an edit/delete failure. */
  failure: string | null
  t: (key: ModelsDevKey) => string
  onStartEdit: (routeId: string) => void
  onPatchDraft: (patch: Partial<RouteDraft>) => void
  onSaveEdit: () => void
  onCancelEdit: () => void
  onDelete: (routeId: string) => void
}

/** Edit form for one route (edit-surface fields: name/protocol/endpoint/credential/OAuth/extraParams/default output). */
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

/** Copy mapping for edit/delete failures (the store produces location keys; dictionary copy lives here). */
function failureText(failure: string, t: (key: ModelsDevKey) => string): string {
  if (failure === 'headers') return t('routeFailureHeaders')
  if (failure === 'body') return t('routeFailureBody')
  if (failure === 'maxTokens') return t('routeFailureMaxTokens')
  return failure
}

/** "My routes" management area (renders nothing when there are no routes). */
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
                      <Button variant="outline" onClick={() => { props.onSaveEdit() }}>{t('routeSave')}</Button>
                      <Button variant="outline" onClick={() => { props.onCancelEdit() }}>{t('oauthCancel')}</Button>
                    </>
                  )
                  : (
                    <>
                      <Button variant="outline" onClick={() => { props.onStartEdit(routeId) }}>{t('routeEdit')}</Button>
                      <Button variant="outline" onClick={() => { props.onDelete(routeId) }}>{t('routeDelete')}</Button>
                    </>
                  )}
              </span>
            </div>
            {isEditing && (
              <RouteEditForm draft={editing.draft} t={t} onPatch={props.onPatchDraft} />
            )}
          </div>
        )
      })}
      {props.failure !== null && <span className={styles.errorText}>{failureText(props.failure, t)}</span>}
    </div>
  )
}
