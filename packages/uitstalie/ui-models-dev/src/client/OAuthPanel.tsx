/**
 * OAuth 登录面板：llm-plus 的 OAuth 路由清单 + 登录尝试的驱动区
 * （通知列表、device code 展示、待答 prompt 的回答表单）。
 * 纯 props 展示组件：数据与回调全部来自 props。
 *
 * @module @deepseek-ai/dsh-client-ui-models-dev/OAuthPanel
 */

import type { AttemptPromptView, AttemptView, OAuthRouteInfo } from '@deepseek-ai/dsh-llm-plus/types'
import type { ModelsDevKey } from './locales.ts'
import styles from './ModelsDevSection.module.css'

/** 组件入参（纯数据 + 回调）。 */
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

/** 尝试状态的中文/英文徽标文案键。 */
function statusKey(status: AttemptView['status']): ModelsDevKey {
  switch (status) {
    case 'running': return 'attemptRunning'
    case 'authorized': return 'attemptAuthorized'
    case 'failed': return 'attemptFailed'
    case 'cancelled': return 'attemptCancelled'
  }
}

/** 待答 prompt 的回答表单（text/secret = 输入框；select = 选项按钮组）。 */
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
              <button
                key={option.id}
                className={styles.submitButton}
                onClick={() => {
                  // select 的回答直接是 option id，不走文本草稿
                  props.onAnswerDraft(prompt.promptId, option.id)
                  props.onAnswer(props.routeId, prompt.promptId)
                }}
              >
                {option.label}
              </button>
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
              onChange={event => props.onAnswerDraft(prompt.promptId, event.target.value)}
            />
            <button className={styles.submitButton} onClick={() => props.onAnswer(props.routeId, prompt.promptId)}>
              {t('submitAnswer')}
            </button>
          </div>
        )}
    </div>
  )
}

/** 一次在途尝试的进展区（通知流 + 待答 prompt）。 */
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
      {attempt.notices.map((notice, index) => (
        <div key={index} className={styles.noticeRow}>
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

/** OAuth 登录面板（无 OAuth 路由时整块不渲染）。 */
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
                  ? <button className={styles.submitButton} onClick={() => props.onCancel(route.routeId)}>{t('oauthCancel')}</button>
                  : (
                    <button className={styles.submitButton} onClick={() => props.onBegin(route.routeId)}>
                      {route.configured ? t('oauthSignInAgain') : route.label}
                    </button>
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
