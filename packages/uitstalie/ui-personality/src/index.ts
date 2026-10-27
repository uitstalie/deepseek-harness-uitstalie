/**
 * Host half of the identity proposal queue's settings page.
 *
 * Every behavior is in the browser half; the node half is an empty plugin body,
 * so the `ui-personality` row loads through the same package whose client
 * bundle the Web host serves.
 *
 * @module @deepseek-ai/dsh-client-ui-personality
 */

export { PERSONALITY_SETTINGS_ORDER, PERSONALITY_SETTINGS_SECTION } from './section.ts'

/** Host plugin body — all behavior lives in the browser half. */
export function apply(): void {}
