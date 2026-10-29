/**
 * The `count_tokens` tool: measure one text with the bundled DeepSeek V4 tokenizer.
 *
 * A tool call is a budget decision, not a file operation: the text is measured in memory and
 * nothing is written. Very large texts are refused rather than blocking the event loop for a long
 * CPU-bound count.
 * @module @deepseek-ai/dsh-token-calculator/tool
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { countTokens } from './tokenizer.ts'

/** Model-facing tool name. */
export const TOKEN_TOOL_NAME = 'count_tokens'

/** Maximum measured text, in UTF-8 bytes. */
export const TOKEN_TEXT_MAX_BYTES = 256 * 1024

/**
 * Build the capability's one tool.
 * @returns the `count_tokens` definition to register through the organizer.
 */
export function countTokensTool(): ToolDefinition {
  return defineTool({
    name: TOKEN_TOOL_NAME,
    description:
      'Count DeepSeek V4 tokens in one text with the bundled tokenizer, before spending them. '
      + 'Use it when a prompt, system instruction, memory block, or generated document must fit a token '
      + `budget; texts above ${String(TOKEN_TEXT_MAX_BYTES / 1024)} KiB are refused. `
      + 'The count excludes chat-template framing unless `addSpecialTokens` is true, which adds the BOS token.',
    parameters: {
      text: {
        type: 'string',
        required: true,
        description: 'The exact text to measure; whitespace and markup count.',
      },
      addSpecialTokens: {
        type: 'boolean',
        description: 'Prepend the DeepSeek BOS token to the count; default false.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tokens: { type: 'integer', required: true },
          characters: { type: 'integer', required: true },
          bytes: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${String(value.tokens)} tokens (${String(value.characters)} characters, ${String(value.bytes)} bytes).`,
      }],
    },
    async execute(args) {
      const bytes = Buffer.byteLength(args.text, 'utf8')
      if (bytes > TOKEN_TEXT_MAX_BYTES) {
        throw new Error(
          `count_tokens refuses ${String(bytes)} bytes; measure at most ${String(TOKEN_TEXT_MAX_BYTES)} bytes at a time`,
        )
      }
      return countTokens(args.text, { addSpecialTokens: args.addSpecialTokens ?? false })
    },
  })
}
