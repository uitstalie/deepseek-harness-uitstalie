/**
 * Host half of the memory settings surface.
 *
 * Every behavior is in the browser half; the node half is an empty plugin body, so the `ui-memory`
 * row loads through the same package whose client bundle the Web host serves.
 *
 * @module @deepseek-ai/dsh-client-ui-memory
 */

export { MEMORY_SETTINGS_ORDER, MEMORY_SETTINGS_SECTION } from './section.ts'

/** Host plugin body — all behavior lives in the browser half. */
export function apply(): void {}
