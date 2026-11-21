/**
 * Hard reply gate for dispatched turns.
 *
 * A turn whose input is a `workspace_message` delivery must reply to the
 * sender. The prompt states the rule, but a model can close the turn without
 * calling `workspace_message.send`; the reply then only survives as the
 * session's own summary. This listener enforces the rule at the
 * `agent/turn-stopping` boundary: one missing reply appends a steering message
 * that keeps the turn running, a second one ends the turn `blocked` and
 * records `pendingReply` on the dispatch relation. Once per relation, so a
 * session cannot loop; user-initiated turns are never touched.
 * @module @deepseek-ai/dsh-workspace-tools/reply-gate
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { listMessages, updateDispatchReplyState } from './store.ts'
import { resolveWorkspace } from './scope.ts'

/** Prefix every delivered inter-agent message carries. */
export const WORKSPACE_MESSAGE_MARKER = '[workspace_message]'

/** Body line a sender writes to declare that no reply is required. */
export const NO_REPLY_MARKER = 'reply-required: no'

/** First line of the task completion notice; a notice asks for no reply. */
export const TASK_NOTICE_MARKER = '[workspace-task-settled]'

/** Steering text appended when a dispatched turn closes without a reply. */
export const REPLY_REMINDER = 'Your turn was started by a workspace_message from another session, and you have not replied yet. '
  + 'Send the reply now with workspace_message.send: the complete answer (conclusion, evidence or artifact pointers, and the data the sender needs), not a one-line turn summary.'

/** How the gate behaves; `off` keeps only the prompt-level rule. */
export type ReplyGateMode = 'off' | 'enforce'

/** Options for {@link mountReplyGate}. */
export interface ReplyGateOptions {
  /** Whether a missing reply keeps the turn open and can block it. */
  readonly mode: ReplyGateMode
}

/** What the gate decided for one finishing turn. */
export type ReplyGateDecision = 'allow' | 'remind' | 'block'

/** Facts the decision needs. */
export interface ReplyGateInput {
  /** The turn's input is a `workspace_message` delivery. */
  readonly initiatedBySend: boolean
  /** The turn sent a reply to the delivering session. */
  readonly replied: boolean
  /** The delivery asked for no reply, or is a completion notice, or is system input. */
  readonly exempt: boolean
  /** This dispatch relation was already reminded once. */
  readonly reminded: boolean
}

/**
 * Decide whether a finishing turn may close.
 * @param input - trigger, reply, exemption, and prior-reminder facts.
 * @returns `allow` to close, `remind` to steer one more step, `block` to close blocked.
 */
export function decideReplyGate(input: ReplyGateInput): ReplyGateDecision {
  if (!input.initiatedBySend || input.replied || input.exempt) return 'allow'
  return input.reminded ? 'block' : 'remind'
}

/**
 * Read the delivering Session id out of one delivered message text.
 * @param text - the session's user-message text.
 * @returns the sender Session id, or undefined when the text is not a delivery.
 */
export function deliveredBy(text: string): string | undefined {
  const match = /^\[workspace_message\] from (?:subagent|agent|super) (session-[0-9a-f-]+)/m.exec(text)
  return match?.[1]
}

/**
 * Whether one delivered input is exempt from the reply requirement.
 * @param text - the session's user-message text.
 * @returns true for a completion notice, an explicit no-reply declaration, or non-delivery input.
 */
export function exemptInput(text: string): boolean {
  return text.startsWith(TASK_NOTICE_MARKER) || text.includes(NO_REPLY_MARKER) || deliveredBy(text) === undefined
}

/** One open turn and the delivery that started it. */
interface OpenTurn {
  readonly turn: number
  readonly startedAt: number
  delivery?: { readonly sourceSessionId: string; readonly exempt: boolean }
}

/**
 * Mount the reply gate when it is enforced.
 *
 * The listener never throws into the Session append path: every failure is
 * logged and the turn closes, because a missing reply is a contract problem,
 * not a durability one.
 * @param ctx - plugin context carrying the store, registry, and logger.
 * @param options - gate mode.
 */
export function mountReplyGate(ctx: Context, options: ReplyGateOptions): void {
  if (options.mode === 'off') return
  const open = new Map<string, OpenTurn>()
  const reminded = new Map<string, number>()
  ctx.on('session/event', (session: Session, event: SessionEvent): void => {
    const sessionId = String(session.id)
    if (event.type === 'turn/start') {
      open.set(sessionId, { turn: event.data.turn, startedAt: event.time })
      return
    }
    if (event.type === 'turn/end') {
      open.delete(sessionId)
      return
    }
    if (event.type !== 'user/message') return
    const text = event.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    const sourceSessionId = deliveredBy(text)
    if (sourceSessionId === undefined) return
    const turn = open.get(sessionId)
    if (turn === undefined) return
    open.set(sessionId, { ...turn, delivery: { sourceSessionId, exempt: exemptInput(text) } })
    reminded.delete(`${sourceSessionId}|${sessionId}`)
  })
  ctx.on('agent/turn-stopping', async ({ agent, turn }): Promise<{ blocked?: string } | void> => {
    const sessionId = String(agent.session.id)
    const state = open.get(sessionId)
    if (state === undefined || state.turn !== turn || state.delivery === undefined) return
    const { sourceSessionId, exempt } = state.delivery
    if (exempt) return
    const key = `${sourceSessionId}|${sessionId}`
    let replied = false
    try {
      const workspace = (await resolveWorkspace(ctx, agent.session, 'reply-gate')).workspace
      const messages = await listMessages(ctx, workspace.id)
      replied = messages.some(message =>
        message.sourceSessionId === sessionId
        && message.targetSessionId === sourceSessionId
        && message.status !== 'failed'
        && Date.parse(message.createdAt) >= state.startedAt)
      const decision = decideReplyGate({ initiatedBySend: true, replied, exempt: false, reminded: reminded.has(key) })
      if (decision === 'allow') return
      const at = new Date().toISOString()
      if (decision === 'remind') {
        reminded.set(key, turn)
        await updateDispatchReplyState(ctx, workspace.id, sourceSessionId, sessionId, { replyRemindedAt: at })
        agent.inbox.append('next-step', createUserMessage({
          content: [{ type: 'text', text: REPLY_REMINDER }],
          source: { kind: 'user' },
        }))
        return
      }
      await updateDispatchReplyState(ctx, workspace.id, sourceSessionId, sessionId, { pendingReplyAt: at, pendingReplyTurn: turn })
      return { blocked: 'the turn was started by a workspace_message and no reply was sent; workspace_message.send is required' }
    } catch (error: unknown) {
      ctx.logger.warn('workspace-tools: reply gate failed for %s: %s', sessionId, error instanceof Error ? error.message : String(error))
    }
  })
}
