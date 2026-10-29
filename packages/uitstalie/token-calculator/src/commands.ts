/**
 * The `/tokens` human command: measure a prompt or text with the bundled DeepSeek V4 tokenizer
 * without asking the model.
 * @module @deepseek-ai/dsh-token-calculator/commands
 */

import type { Context } from '@deepseek-ai/cordis'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { TOKEN_TEXT_MAX_BYTES } from './tool.ts'
import { countTokens } from './tokenizer.ts'

/** Name of the registered command. */
export const TOKENS_COMMAND_NAME = 'tokens'

/** One-line grammar shown by every failure. */
export const TOKENS_COMMAND_USAGE = 'Usage: /tokens [--bos] <text>'

/**
 * Build the one `/tokens` command definition.
 * @returns the definition to register with the command registry.
 */
export function tokensCommand(): CommandDefinition {
  return {
    definitionId: CommandDefinitionId('@deepseek-ai/dsh-token-calculator'),
    name: TOKENS_COMMAND_NAME,
    description: 'Count DeepSeek V4 tokens in the given text with the bundled tokenizer',
    input: { hint: '[--bos] <text>' },
    handler: invocation => execute(invocation),
  }
}

/**
 * Register `/tokens` on a context that carries the command registry.
 * @param ctx - context carrying `commands`.
 * @returns the registration disposer.
 */
export function registerTokensCommand(ctx: Context): () => void {
  return ctx.commands.register(tokensCommand())
}

/** Measure the raw input, optionally with BOS. */
function execute(invocation: CommandInvocation): CommandResult {
  const input = invocation.rawInput.trim()
  if (input === '') return { kind: 'success', text: TOKENS_COMMAND_USAGE }
  const addSpecialTokens = /^--bos(?=\s|$)/u.test(input)
  const text = addSpecialTokens ? input.slice('--bos'.length).trim() : input
  if (text === '') return { kind: 'error', text: `${TOKENS_COMMAND_USAGE}: no text after --bos` }
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > TOKEN_TEXT_MAX_BYTES) {
    return {
      kind: 'error',
      text: `That text is ${String(bytes)} bytes; measure at most ${String(TOKEN_TEXT_MAX_BYTES)} bytes at a time.`,
    }
  }
  const count = countTokens(text, { addSpecialTokens })
  return {
    kind: 'success',
    text: `${String(count.tokens)} tokens (${String(count.characters)} characters, ${String(count.bytes)} bytes${addSpecialTokens ? ', with BOS' : ''}).`,
  }
}
