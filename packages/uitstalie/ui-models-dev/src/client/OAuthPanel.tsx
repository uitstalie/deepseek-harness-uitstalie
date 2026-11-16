/**
 * OAuth sign-in panel: the llm-plus OAuth route list plus the driver area for sign-in attempts
 * (notice list, device code display, answer form for pending prompts).
 * A pure props presentational component: all data and callbacks come from props.
 *
 * @module @deepseek-ai/dsh-client-ui-models-dev/OAuthPanel
 */

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AttemptPromptView, AttemptView, OAuthRouteInfo } from '@deepseek-ai/dsh-llm-plus/types'
import type { ModelsDevKey } from './locales.ts'
import styles from './ModelsDevSection.module.css'

/** Component inputs (pure data + callbacks). */
export interface OAuthPanelProps {
  routes: readonly OAuthRouteInfo[]
  attempts: Record<string, AttemptView>
  answerDrafts: Record<string, string>
  t: (key: ModelsDevKey) => string
  onBegin: (routeId: string) => void
  onCancel: (routeId: string) => void
  onAnswer: (routeId: string, promptId: string) => void
  onAnswerDraft: (promptId: string, value: string) => void
}

/** Copy keys for the attempt status badge (Chinese/English). */
function statusKey(status: AttemptView['status']): ModelsDevKey {
  switch (status) {
    case 'running': return 'attemptRunning'
    case 'authorized': return 'attemptAuthorized'
    case 'failed': return 'attemptFailed'
    case 'cancelled': return 'attemptCancelled'
  }
}

/** Answer form for a pending prompt (text/secret = input; select = option button group). */
function PromptForm(props: {
  routeId: string
  prompt: AttemptPromptView
  answerDraft: string
  t: (key: ModelsDevKey) => string
  onAnswer: (routeId: string, promptId: string) => void
  onAnswerDraft: (promptId: string, value: string) => void
}) {
  const { prompt, t } = props
  return (
    <div className={styles.promptBox}>
      <span className={styles.fieldLabel}>{prompt.message}</span>
      {prompt.kind === 'select'
        ? (
          <div className={styles.promptOptions}>
            {prompt.options?.map(option => (
              <Button
                key={option.id}
                variant="outline"
                onClick={() => {
                  // A select answer is the option id directly, not a text draft
                  props.onAnswerDraft(prompt.promptId, option.id)
                  props.onAnswer(props.routeId, prompt.promptId)
                }}
              >
                {option.label}
              </Button>
            ))}
          </div>
        )
        : (
          <div className={styles.promptRow}>
            <input
              className={styles.input}
              type={prompt.kind === 'secret' ? 'password' : 'text'}
              value={props.answerDraft}
              {...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder })}
              onChange={(event) => { props.onAnswerDraft(prompt.promptId, event.target.value) }}
            />
            <Button variant="outline" onClick={() => { props.onAnswer(props.routeId, prompt.promptId) }}>
              {t('submitAnswer')}
            </Button>
          </div>
        )}
    </div>
  )
}

/** Progress area for an in-flight attempt (notice stream + pending prompt). */
function AttemptArea(props: {
  routeId: string
  attempt: AttemptView
  answerDrafts: Record<string, string>
  t: (key: ModelsDevKey) => string
  onAnswer: (routeId: string, promptId: string) => void
  onAnswerDraft: (promptId: string, value: string) => void
}) {
  const { attempt, t } = props
  return (
    <div className={styles.attemptArea}>
      {attempt.notices.map(notice => (
        <div key={`${notice.code ?? ''}:${notice.url ?? ''}:${notice.message}`} className={styles.noticeRow}>
          <span>{notice.message}</span>
          {notice.url !== undefined && (
            <a className={styles.noticeLink} href={notice.url} target="_blank" rel="noreferrer">{notice.url}</a>
          )}
          {notice.code !== undefined && <code className={styles.deviceCode}>{notice.code}</code>}
        </div>
      ))}
      {attempt.pendingPrompt !== undefined && (
        <PromptForm
          routeId={props.routeId}
          prompt={attempt.pendingPrompt}
          answerDraft={props.answerDrafts[attempt.pendingPrompt.promptId] ?? ''}
          t={t}
          onAnswer={props.onAnswer}
          onAnswerDraft={props.onAnswerDraft}
        />
      )}
      {attempt.error !== undefined && <span className={styles.errorText}>{attempt.error}</span>}
    </div>
  )
}

/** OAuth sign-in panel (renders nothing when there are no OAuth routes). */
export function OAuthPanel(props: OAuthPanelProps) {
  const { routes, attempts, t } = props
  if (routes.length === 0) return null
  return (
    <div className={styles.oauthPanel}>
      <span className={styles.fieldLabel}>{t('oauthSection')}</span>
      {routes.map((route) => {
        const attempt = attempts[route.routeId]
        const running = attempt?.status === 'running'
        return (
          <div key={route.routeId} className={styles.rowCard}>
            <div className={styles.rowHead}>
              <span className={styles.rowTitle}>{route.routeId}</span>
              <span className={styles.badge}>{route.flow}</span>
              <span className={styles.rowMeta}>
                {route.configured ? t('oauthConfigured') : t('oauthNotConfigured')}
              </span>
              {attempt !== undefined && <span className={styles.rowMeta}>{t(statusKey(attempt.status))}</span>}
              <span className={styles.rowAction}>
                {running
                  ? <Button variant="outline" onClick={() => { props.onCancel(route.routeId) }}>{t('oauthCancel')}</Button>
                  : (
                    <Button variant="outline" onClick={() => { props.onBegin(route.routeId) }}>
                      {route.configured ? t('oauthSignInAgain') : route.label}
                    </Button>
                  )}
              </span>
            </div>
            {attempt !== undefined && attempt.status !== 'authorized' && (
              <AttemptArea
                routeId={route.routeId}
                attempt={attempt}
                answerDrafts={props.answerDrafts}
                t={t}
                onAnswer={props.onAnswer}
                onAnswerDraft={props.onAnswerDraft}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
