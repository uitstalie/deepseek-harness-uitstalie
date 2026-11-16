/**
 * The token calculator capability: a `count_tokens` tool and `/tokens` command backed by the
 * bundled DeepSeek V4 tokenizer.
 *
 * The provider is a dafeiyu capability (`enabledByDefault: true`), so the organizer gates the
 * model-facing tool per agent; `/tokens` stays a human surface outside that gate. Counting is
 * offline and pure: the tokenizer asset ships with the package and nothing is written.
 * @module @deepseek-ai/dsh-token-calculator
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CapabilityContribution } from '@deepseek-ai/dsh-dafeiyu'
import { registerTokensCommand } from './commands.ts'
import { countTokensTool } from './tool.ts'

/** Cordis plugin name. */
export const name = 'token-calculator'
/** The capability organizer that wires the tool. */
export const inject = ['dafeiyu']

/** Stable capability id; `capabilities.tokens.enabled=false` removes the tool. */
export const TOKEN_CAPABILITY_ID = 'tokens'

/** Display name in the capability list. */
export const TOKEN_CAPABILITY_LABEL = 'Token calculator'

/** One sentence the capability list renders. */
export const TOKEN_CAPABILITY_DESCRIPTION = 'Counts DeepSeek V4 tokens in a prompt or text offline'

export { TOKENS_COMMAND_NAME, TOKENS_COMMAND_USAGE, registerTokensCommand, tokensCommand } from './commands.ts'
export { TOKEN_TEXT_MAX_BYTES, TOKEN_TOOL_NAME, countTokensTool } from './tool.ts'
export { countTokens, encodeTokens, loadTokenizer } from './tokenizer.ts'
export type { CountTokensOptions, TokenCount } from './tokenizer.ts'

/**
 * Register the token-calculator capability and the `/tokens` command.
 * @param ctx - plugin context carrying the organizer (and optionally the command registry).
 */
export function apply(ctx: Context): void {
  const registration = ctx.dafeiyu.register({
    id: TOKEN_CAPABILITY_ID,
    contractVersion: 2,
    label: TOKEN_CAPABILITY_LABEL,
    description: TOKEN_CAPABILITY_DESCRIPTION,
    config: {},
    enabledByDefault: true,
    create: (): CapabilityContribution => ({
      tools: () => [countTokensTool()],
    }),
  })
  ctx.effect(() => registration, 'token-calculator.register()')

  ctx.inject(['commands'], (commandCtx) => {
    ctx.effect(() => registerTokensCommand(commandCtx), 'token-calculator.commands()')
  })
}
