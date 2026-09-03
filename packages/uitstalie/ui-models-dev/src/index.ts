/**
 * Host loader entry for the browser implementation exported from `./client`.
 * 本包的全部行为都在浏览器半区（settings.section 页面），Node 半区无行为。
 *
 * @module @deepseek-ai/dsh-client-ui-models-dev
 */

/** Host plugin body — no host-side behavior for the models.dev section plugin. */
export function apply(): void {}
