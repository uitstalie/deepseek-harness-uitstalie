/** Human-facing feedback category vocabulary, safe for browser consumers. @module @deepseek-ai/dsh-command-feedback/categories */
import type { FeedbackCategory } from './types.ts'

/** Every feedback category in the order product surfaces present them. */
export const FEEDBACK_CATEGORIES = [
  'task-result',
  'instruction-following',
  'product-interaction',
  'service-stability',
  'resource-cost',
  'security-privacy-permission',
  'other',
] as const satisfies readonly FeedbackCategory[]
