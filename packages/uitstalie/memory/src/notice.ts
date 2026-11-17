/**
 * The memory capability's one-off failure notice.
 *
 * A notice is an appended `user/message` carrying `source.kind === 'memory'` and
 * `source.form === 'notice'`. The same source form also covers a completed-turn
 * checkpoint, whose source adds a turn window; both are one-off nodes that a
 * reader can tell apart from the static system-prompt section.
 * @module @deepseek-ai/dsh-memory/notice
 */

import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { MemoryCheckpointWindow } from './checkpoint.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    memory: MemoryNoticeSource
  }
}

/** Message source carried by a memory failure notice or a turn checkpoint. */
export interface MemoryNoticeSource {
  /** Producer identity. */
  readonly kind: 'memory'
  /** One-off node; a checkpoint carries `window`, a failure report does not. */
  readonly form: 'notice'
  /** One-line account shown by consumers that do not expand the node. */
  readonly summary: string
  /**
   * Turn window this notice replaces, present only on a tier checkpoint.
   *
   * A checkpoint shares the notice form so a reader that knows only the
   * memory source still treats it as a one-off node, while the window
   * lets the provider rebuild its turn-to-node map from the live surface.
   */
  readonly window?: MemoryCheckpointWindow
}

/**
 * Append one memory failure notice to a session's surface.
 *
 * A notice supersedes nothing: it is an ordinary appended user message that
 * reports a one-off failure.
 * @param session - session that receives the notice.
 * @param text - model-visible notice text; longer text is ellipsized to the
 *   shared 120-character notice bound.
 * @returns after the message landed on the surface.
 */
export function appendMemoryNotice(session: Session, text: string): void {
  const notice = boundContextSummary(text)
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: notice }],
    source: { kind: 'memory', form: 'notice', summary: notice },
  }), { surfaceOp: 'append' })
}
