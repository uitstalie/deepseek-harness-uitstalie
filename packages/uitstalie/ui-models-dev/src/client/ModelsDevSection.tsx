/**
 * The models.dev catalog settings page (the component registered for settings.section).
 * Structure: filter box → provider list (ProviderCard) → submit bar (selected count + submit + receipt).
 * The component is purely presentational: all data arrives via the inject face (controller/useSnapshot/t),
 * and all changes are dispatched through controller actions.
 *
 * @module @deepseek-ai/dsh-client-ui-models-dev/ModelsDevSection
 */

import { useEffect } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { fill, type ModelsDevKey } from './locales.ts'
import { MyRoutes } from './MyRoutes.tsx'
import { OAuthPanel } from './OAuthPanel.tsx'
import { ProviderCard } from './ProviderCard.tsx'
import type { ModelsDevState, ModelsDevStore, SubmitFailure } from './store.ts'
import styles from './ModelsDevSection.module.css'

/** The dependency face injected into this page via slots inject. */
export interface ModelsDevSectionInjected {
  /** Page actions (load/select/draft/submit), bound to the store. */
  actions: ModelsDevActions
  /** Start fetching when this page is first opened; under an assembly state nobody opens the page, so the Host is not read. */
  activate: () => void
  hooks: {
    /** Page snapshot (the renderer binds it as useSnapshot). */
    snapshot: SnapshotStore<ModelsDevState>
  }
  /** Copy for this page (the settings.models-dev namespace). */
  t: (key: ModelsDevKey) => string
}

/** The subset of store methods the page may call. */
export type ModelsDevActions = Pick<ModelsDevStore,
  | 'load'
  | 'beginLogin'
  | 'cancelLogin'
  | 'answerPrompt'
  | 'setAnswerDraft'
  | 'startEditRoute'
  | 'patchEditDraft'
  | 'saveEditRoute'
  | 'cancelEditRoute'
  | 'deleteRoute'
  | 'setFilter'
  | 'toggleProvider'
  | 'updateDraft'
  | 'setModelMode'
  | 'toggleModel'
  | 'submit'
>

/** Component props: the inject face flattened (tests may provide only some values). */
export type ModelsDevSectionProps = Partial<InjectFace<ModelsDevSectionInjected>>

/** Copy mapping for submit failures (the store's structured failure → dictionary copy). */
function failureText(failure: SubmitFailure, t: (key: ModelsDevKey) => string): string {
  switch (failure.kind) {
    case 'protocol': return fill(t('protocolRequired'), { provider: failure.provider })
    case 'invalidJson': return fill(t('invalidJson'), { field: failure.field, provider: failure.provider })
    case 'conflict': return t('conflict')
    case 'message': return fill(t('addFailed'), { message: failure.message })
  }
}

/** Page root component. */
export function ModelsDevSection(props: ModelsDevSectionProps) {
  const { actions, useSnapshot, t, activate } = props
  useEffect(() => { activate?.() }, [activate])
  // All three are guaranteed under the assembly; Partial is the no-magic path for tests that pass props directly
  if (actions === undefined || useSnapshot === undefined || t === undefined) return null
  const state = useSnapshot(snapshot => snapshot)

  if (state.status === 'loading' || state.status === 'idle') {
    return <div className={styles.section}><span className={styles.notice}>{t('loading')}</span></div>
  }
  if (state.status === 'error') {
    return (
      <div className={styles.section}>
        <span className={styles.errorText}>{fill(t('loadFailed'), { message: state.error ?? '' })}</span>
        <div className={styles.submitBar}>
          <Button variant="outline" onClick={() => void actions.load()}>{t('retry')}</Button>
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
      <h2 className={styles.title}>{t('title')}</h2>
      <p className={styles.intro}>{t('intro')}</p>
      <OAuthPanel
        routes={state.oauth.routes}
        attempts={state.oauth.attempts}
        answerDrafts={state.oauth.answerDrafts}
        t={t}
        onBegin={routeId => void actions.beginLogin(routeId)}
        onCancel={routeId => void actions.cancelLogin(routeId)}
        onAnswer={(routeId, promptId) => void actions.answerPrompt(routeId, promptId)}
        onAnswerDraft={(promptId, value) => { actions.setAnswerDraft(promptId, value) }}
      />
      <MyRoutes
        routes={state.myRoutes.routes}
        editing={state.myRoutes.editing}
        failure={state.myRoutes.failure}
        t={t}
        onStartEdit={(routeId) => { actions.startEditRoute(routeId) }}
        onPatchDraft={(patch) => { actions.patchEditDraft(patch) }}
        onSaveEdit={() => void actions.saveEditRoute()}
        onCancelEdit={() => { actions.cancelEditRoute() }}
        onDelete={routeId => void actions.deleteRoute(routeId)}
      />
      <input
        className={styles.input}
        value={state.filter}
        placeholder={t('filterPlaceholder')}
        onChange={(event) => { actions.setFilter(event.target.value) }}
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
            onToggle={(checked) => { actions.toggleProvider(provider, checked) }}
            onPatch={(patch) => { actions.updateDraft(provider.id, patch) }}
            onModelMode={(mode) => { actions.setModelMode(provider.id, mode) }}
            onToggleModel={(modelId, checked) => { actions.toggleModel(provider.id, modelId, checked) }}
          />
        ))}
      </div>
      {selectedCount > 0 && (
        <div className={styles.submitBar}>
          <Button
            variant="primary"
            disabled={state.submitting}
            onClick={() => void actions.submit()}
          >
            {state.submitting ? t('adding') : fill(t('addSelected'), { count: String(selectedCount) })}
          </Button>
        </div>
      )}
      {state.submitError !== null && <span className={styles.errorText}>{failureText(state.submitError, t)}</span>}
      {state.addedRoutes.length > 0 && (
        <span className={styles.okText}>{fill(t('addedRoutes'), { routes: state.addedRoutes.join(', ') })}</span>
      )}
    </div>
  )
}
