/**
 * Host half of the capability list.
 *
 * Every behavior is in the browser half; the node half is an empty plugin
 * body, so the `ui-dafeiyu` row loads through the same package whose client
 * bundle the Web host serves.
 *
 * @module @deepseek-ai/dsh-client-ui-dafeiyu
 */

export { CAPABILITIES_SETTINGS_ORDER, CAPABILITIES_SETTINGS_SECTION } from './section.ts'

/** Host plugin body — all behavior lives in the browser half. */
export function apply(): void {}
