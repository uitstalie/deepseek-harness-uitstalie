/**
 * llm-plus 的 OAuth Remote 服务（`llmPlusAuth`）：把 authorization seam 的
 * 登录流暴露给 web 设置页。
 *
 * 为什么是这个形状：gateway 的 forwarded-event 通道是应用独占的（通知事件
 * 推不出去），所以 notice/prompt 用**轮询桥**——页面 800ms 轮一次
 * describeAttempt 拿在途 notice 与待答 prompt，submitPromptAnswer 回答。
 * 进度不回 session log（登录是配置期动作，不是模型可见输入）。
 *
 * @module @deepseek-ai/dsh-llm-plus/remote
 */

import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { AuthorizationInteraction, AuthorizationNotice, AuthorizationPrompt } from '@deepseek-ai/dsh-authorization'
import type { AuthorizationService } from '@deepseek-ai/dsh-authorization'
import { OAUTH_PROVIDERS, grantKeyFor } from './oauth/index.ts'
import type { ResolvedRoute } from './config.ts'
import type { AttemptNoticeView, AttemptPromptView, AttemptView, OAuthRouteInfo } from './remote-types.ts'

export type { AttemptNoticeView, AttemptPromptView, AttemptView, OAuthRouteInfo } from './remote-types.ts'

// ---------------------------------------------------------------------------
// 尝试登记簿（内存态；登录是进程期动作——pi-ai 的已知限制同款：重启即放弃）
// ---------------------------------------------------------------------------

/** 一次在途/已终结的尝试（服务内部状态）。 */
interface AttemptRecord {
  id: string
  routeId: string
  controller: AbortController
  notices: AttemptNoticeView[]
  pending?: { view: AttemptPromptView; answer: (value: string) => void; decline: (error: Error) => void } | undefined
  status: AttemptView['status']
  error?: string
}

/** 尝试 id 自增（进程内唯一即可）。 */
let nextAttemptId = 0
/** prompt id 自增。 */
let nextPromptId = 0

/** 终结尝试的判定：begin 的 outcome → 尝试状态。 */
function settleStatus(outcome: { status: 'authorized' | 'cancelled' }): AttemptView['status'] {
  return outcome.status
}

/**
 * `llmPlusAuth` Remote 服务：路由清单 + 登录尝试生命周期。
 * authorization 缝缺席时：清单照答（configured 仍准确），begin 报
 * 'authorization-unavailable'——组合没有缝时登录无处可去。
 */
export class PlusAuthRemote extends TypertRemoteService {
  /** 在途与最近的尝试（页面轮询的数据源；进程内存，重启即清）。 */
  private readonly attempts = new Map<string, AttemptRecord>()

  /**
   * @param ctx - 宿主 Context。
   * @param routesNow - 当前路由表读取器（llm-plus 的热更新在 apply 里换闭包）。
   */
  constructor(
    ctx: Context,
    private readonly routesNow: () => readonly ResolvedRoute[],
  ) {
    super(ctx, 'llmPlusAuth')
  }

  /**
   * 带 OAuth 能力的路由清单（含凭据在位状态）。
   * @returns 页面行（按路由 id 排序）。
   */
  @Remote
  async listOAuthRoutes(): Promise<OAuthRouteInfo[]> {
    const rows: OAuthRouteInfo[] = []
    for (const route of this.routesNow()) {
      if (route.oauth === undefined) continue
      const def = OAUTH_PROVIDERS[route.oauth]
      if (def === undefined) continue
      const info = await this.ctx.credentials.describeRecord(grantKeyFor(route.id))
      rows.push({ routeId: route.id, flow: def.id, label: def.loginLabel, configured: info.configured })
    }
    return rows.sort((left, right) => left.routeId.localeCompare(right.routeId))
  }

  /**
   * 发起一次登录尝试。
   * @param routeId - 目标路由（必须声明了 oauth 且缝在位）。
   * @returns 尝试 id（页面随后轮询 describeAttempt）。
   * @throws 路由无 oauth / 缝缺席 / 已有在途尝试（seam 的 ALREADY_IN_FLIGHT）。
   */
  @Remote
  async beginFlow(routeId: string): Promise<{ attemptId: string }> {
    const route = this.routesNow().find(candidate => candidate.id === routeId)
    if (route?.oauth === undefined) {
      throw new Error(`llm-plus: route ${JSON.stringify(routeId)} declares no oauth flow`)
    }
    const authorization = this.ctx.get('authorization', false) as AuthorizationService | undefined
    if (authorization === undefined) {
      throw new Error('llm-plus: the authorization capability is not mounted in this composition')
    }
    const attempt: AttemptRecord = {
      id: `attempt-${++nextAttemptId}`,
      routeId,
      controller: new AbortController(),
      notices: [],
      status: 'running',
    }
    this.attempts.set(attempt.id, attempt)
    const interaction: AuthorizationInteraction = {
      notify: notice => this.recordNotice(attempt, notice),
      prompt: prompt => this.askPrompt(attempt, prompt),
    }
    // begin 的结果落到尝试状态；失败消息进 error（文案回显给页面）
    void authorization.begin({
      key: grantKeyFor(routeId),
      interaction,
      signal: attempt.controller.signal,
    }).then((outcome) => {
      this.settleAttempt(attempt, settleStatus(outcome))
    }).catch((error: unknown) => {
      this.settleAttempt(attempt, 'failed', error instanceof Error ? error.message : String(error))
    })
    return { attemptId: attempt.id }
  }

  /**
   * 轮询桥：读一次尝试的完整视图。
   * @param attemptId - beginFlow 的返回值。
   * @returns 视图；未知 id 抛错。
   */
  @Remote
  describeAttempt(attemptId: string): AttemptView {
    return this.attemptView(this.requireAttempt(attemptId))
  }

  /**
   * 回答一个待答 prompt。
   * @param attemptId - 尝试 id。
   * @param promptId - describeAttempt 给出的 pendingPrompt.promptId。
   * @param value - 文本答案或选中的 option id。
   */
  @Remote
  submitPromptAnswer(attemptId: string, promptId: string, value: string): void {
    const attempt = this.requireAttempt(attemptId)
    if (attempt.pending === undefined || attempt.pending.view.promptId !== promptId) {
      throw new Error(`llm-plus: attempt ${attemptId} has no pending prompt ${promptId}`)
    }
    const pending = attempt.pending
    attempt.pending = undefined
    pending.answer(value)
  }

  /**
   * 取消一次尝试（中止 flow 的 signal；进行中的 prompt 一并拒绝）。
   * @param attemptId - 尝试 id。
   */
  @Remote
  cancelAttempt(attemptId: string): void {
    const attempt = this.requireAttempt(attemptId)
    if (attempt.status !== 'running') return
    attempt.pending?.decline(new Error('Login cancelled'))
    attempt.controller.abort(new Error('Login cancelled'))
  }

  // -------------------------------------------------------------------------
  // 内部小函数（组合出上面的 Remote 面）
  // -------------------------------------------------------------------------

  /** 取尝试记录；未知 id 抛错。 */
  private requireAttempt(attemptId: string): AttemptRecord {
    const attempt = this.attempts.get(attemptId)
    if (attempt === undefined) throw new Error(`llm-plus: unknown attempt ${JSON.stringify(attemptId)}`)
    return attempt
  }

  /** flow 的 notify 落进尝试的通知表。 */
  private recordNotice(attempt: AttemptRecord, notice: AuthorizationNotice): void {
    attempt.notices.push({
      message: notice.message,
      ...(notice.url === undefined ? {} : { url: notice.url }),
      ...(notice.code === undefined ? {} : { code: notice.code }),
    })
  }

  /** flow 的 prompt 挂起为待答视图，回答经 submitPromptAnswer 到达。 */
  private askPrompt(attempt: AttemptRecord, prompt: AuthorizationPrompt): Promise<string> {
    return new Promise((resolve, reject) => {
      const view: AttemptPromptView = {
        promptId: `prompt-${++nextPromptId}`,
        kind: prompt.kind,
        message: prompt.message,
        ...(prompt.kind === 'select'
          ? { options: prompt.options.map(option => ({ id: option.id, label: option.label })) }
          : { ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }) }),
      }
      attempt.pending = {
        view,
        answer: resolve,
        decline: reject,
      }
      // prompt 自带 signal（flow 用它撤回落选问题——PKCE 的浏览器回调赢了
      // 就撤回手贴）：中止时拒绝挂起的回答
      prompt.signal?.addEventListener('abort', () => {
        if (attempt.pending?.view.promptId === view.promptId) attempt.pending = undefined
        reject(new Error('prompt withdrawn'))
      }, { once: true })
    })
  }

  /** 终结尝试（通知调用方的 outcome 映射 + 清待答）。 */
  private settleAttempt(attempt: AttemptRecord, status: AttemptView['status'], error?: string): void {
    attempt.pending?.decline(new Error(error ?? 'attempt settled'))
    attempt.pending = undefined
    attempt.status = status
    if (error !== undefined) attempt.error = error
  }

  /** 记录 → 页面视图。 */
  private attemptView(attempt: AttemptRecord): AttemptView {
    return {
      id: attempt.id,
      routeId: attempt.routeId,
      status: attempt.status,
      notices: [...attempt.notices],
      ...(attempt.pending === undefined ? {} : { pendingPrompt: attempt.pending.view }),
      ...(attempt.error === undefined ? {} : { error: attempt.error }),
    }
  }
}
