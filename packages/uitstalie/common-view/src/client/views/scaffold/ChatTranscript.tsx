/**
 * The chat transcript, replicated from the chat view's own frame and its user
 * message: a scroll column capped at the shared content width whose rows sit
 * 6px apart — 12px around an Assistant response — and the user's bubble on the
 * trailing edge.
 *
 * Measurements come from `ui-chat`'s `ChatView.module.css` (`.frame`, `.root`,
 * `.scroll`, `.column`, `.flowItem`) and `MessageItem.module.css` (`.userRow`,
 * `.userStack`, `.bubble`).
 *
 * The Assistant's message body is its own markdown surface; here it is a plain
 * stand-in, and tool, process, and error rows are separate slices.
 * @module @deepseek-ai/dsh-client-common-view/ChatTranscript
 */
import { classes } from './classes.ts'
import css from './ChatTranscript.module.css'

/** One transcript row. */
export interface TranscriptMessage {
  /** Stable identity of the message. */
  id: string
  /** Who spoke. */
  role: 'user' | 'assistant'
  /** The message text. */
  text: string
}

/** Injected share of the transcript. */
export interface ChatTranscriptInjected {
  /** The rows to draw, oldest first. */
  messages: readonly TranscriptMessage[]
}

/** Props the transcript renders from. */
export type ChatTranscriptProps = ChatTranscriptInjected

/**
 * Render one user message.
 * @param props - the message.
 * @returns the trailing-edge stack holding the bubble.
 */
function UserMessage({ message }: { message: TranscriptMessage }) {
  return (
    <div className={css.userRow}>
      <div className={css.userStack}>
        <div className={css.bubble}>{message.text}</div>
      </div>
    </div>
  )
}

/**
 * Render the transcript.
 * @param props - the rows to draw.
 * @returns the scroll frame holding the centred column.
 */
export function ChatTranscript({ messages }: ChatTranscriptProps) {
  return (
    <div className={css.frame}>
      <div className={css.root}>
        <div className={css.scroll}>
          <div className={css.column}>
            {messages.map(message => (
              <div
                key={message.id}
                className={classes(css.flowItem, message.role === 'assistant' && css.flowItemResponse)}
                data-chat-group-part={message.role === 'assistant' ? 'response' : undefined}
              >
                {message.role === 'user'
                  ? <UserMessage message={message} />
                  : <div className={css.assistantStandIn}>{message.text}</div>}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
