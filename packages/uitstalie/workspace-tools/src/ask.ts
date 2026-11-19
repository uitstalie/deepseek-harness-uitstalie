/**
 * `ask_user_question_plus`: the workspace-aware wrapper around the host's
 * `ask_user_question`.
 *
 * A dispatched Session must not ask the person directly: the person talks to
 * the super agent, and the executor routes a question back to the Session that
 * sent the request. A delivery from `workspace_message` or `workspace_sessions`
 * starts with a sender header, so this tool reads the turn's input source
 * and refuses an interactive ask that came from another agent, naming the
 * Session to reply to. An ask that follows a person's own message delegates to
 * the host's `userQuestions` service unchanged.
 * @module @deepseek-ai/dsh-workspace-tools/ask
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { WorkspaceQuestionError } from './errors.ts'
import { requireCallerSession } from './tooling.ts'

/** Header prefix a `workspace_message` delivery starts with. */
export const WORKSPACE_MESSAGE_HEADER = '[workspace_message]'
/** Header prefix a `workspace_sessions` delivery starts with. */
export const WORKSPACE_SESSION_HEADER = '[workspace_session]'

/** One question this tool forwards to the host service. */
interface QuestionInput {
  readonly id: string
  readonly question: string
  readonly header?: string
  readonly options?: readonly { readonly label: string; readonly description?: string }[]
  readonly multi_select?: boolean
}

/** One answer the host service returns. */
interface QuestionAnswer {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

/** The slice of `ctx.userQuestions` this tool calls. */
interface UserQuestionsLike {
  ask(request: {
    readonly questions: readonly {
      readonly id: string
      readonly question: string
      readonly header?: string
      readonly options?: readonly { readonly label: string; readonly description?: string }[]
      readonly multiSelect?: boolean
    }[]
    readonly agent?: unknown
    readonly signal: AbortSignal
  }): Promise<{ readonly answers: readonly QuestionAnswer[] }>
}

/**
 * Build `ask_user_question_plus`.
 * @param ctx - context carrying session-query and the host user-questions service.
 * @returns the tool definition.
 */
export function askUserQuestionPlusTool(ctx: Context): ToolDefinition {
  return defineTool({
    name: 'ask_user_question_plus',
    description:
      'Ask the user a concise question when you need confirmation, a choice, or missing information before proceeding. '
      + 'When a non-super turn was started by another agent (a `[workspace_message]` or `[workspace_session]` header), '
      + 'this tool refuses: send the question to that Session with `workspace_message.send` instead, because the super '
      + 'agent is the only party that talks to the person. A super-agent turn always reaches the person.',
    parameters: {
      questions: {
        type: 'array',
        required: true,
        description: 'Questions to ask the user before continuing.',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            id: { type: 'string', required: true, description: 'Stable id for this question; echoed in the answer.' },
            question: { type: 'string', required: true, description: 'The specific question to ask the user.' },
            header: {
              type: 'string',
              description: 'Optional short heading for the question, such as "Confirm" or "Choose Mode".',
            },
            options: {
              type: 'array',
              description: 'Optional choices to show the user. If you recommend one, put it first and append "(Recommended)" to that label.',
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  label: { type: 'string', required: true, description: 'Short user-facing option label.' },
                  description: { type: 'string', description: 'One sentence explaining the tradeoff or impact.' },
                },
              },
            },
            multi_select: {
              type: 'boolean',
              description: 'Whether the user may select more than one option. Defaults to false.',
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          answers: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                selected: { type: 'array', required: true, items: { type: 'string' } },
                custom: { type: 'string' },
              },
            },
          },
          forwardedTo: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const session = requireCallerSession(exec.agent?.session, 'ask_user_question_plus')
      // The super agent is the party that relays an executor's question to the
      // person; only a dispatched non-super Session is refused and routed back.
      const dispatcher = exec.agent?.role === 'super'
        ? undefined
        : await dispatcherOf(ctx, String(session.id), exec.signal)
      if (dispatcher !== undefined) {
        throw new WorkspaceQuestionError(
          `this turn was started by a workspace request from Session ${dispatcher}; do not ask the user directly. `
          + `Send the question to ${dispatcher} with workspace_message.send and wait for the reply; the super agent `
          + 'is the only party that talks to the person.',
          'WORKSPACE_QUESTION_FORWARDED',
        )
      }
      const questions = args.questions as readonly QuestionInput[]
      const userQuestions = ctx.get('userQuestions') as UserQuestionsLike | undefined
      if (userQuestions === undefined || typeof userQuestions.ask !== 'function') {
        throw new WorkspaceQuestionError(
          'the host mounts no user-questions service, so this question cannot reach the person',
          'WORKSPACE_QUESTION_UNAVAILABLE',
        )
      }
      const result = await userQuestions.ask({
        questions: questions.map(question => ({
          id: question.id,
          question: question.question,
          ...question.header === undefined ? {} : { header: question.header },
          ...question.options === undefined ? {} : { options: question.options },
          ...question.multi_select === undefined ? {} : { multiSelect: question.multi_select },
        })),
        ...exec.agent === undefined ? {} : { agent: exec.agent },
        signal: exec.signal,
      })
      return {
        answers: result.answers.map(answer => ({
          id: answer.id,
          selected: [...answer.selected],
          ...answer.custom === undefined ? {} : { custom: answer.custom },
        })),
      }
    },
  })
}

/**
 * Find the Session that started the current turn from another agent.
 * @param ctx - context carrying session-query.
 * @param sessionId - Session whose last user message is inspected.
 * @param signal - cancellation for the observation.
 * @returns the dispatcher Session id, or undefined when the turn came from the person.
 */
async function dispatcherOf(
  ctx: Context,
  sessionId: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const observation = await ctx.sessionQuery.observeSession(SessionId(sessionId), {
    projectionMode: 'none',
    signal,
  })
  const last = observation.events.findLast(event => event.type === 'user/message')
  if (last === undefined) return undefined
  const first = last.data.content.find(block => block.type === 'text')
  if (first === undefined) return undefined
  if (!first.text.startsWith(WORKSPACE_MESSAGE_HEADER) && !first.text.startsWith(WORKSPACE_SESSION_HEADER)) {
    return undefined
  }
  const match = /^\[workspace_(?:message|session)\] from \S+ (\S+) in /u.exec(first.text)
  return match?.[1]
}
