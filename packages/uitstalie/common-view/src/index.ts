/**
 * Node half of the common-view overlay plugin. It declares the row config the
 * browser half resolves and starts nothing else: every overlay lands in the
 * browser through slot registrations and custom properties.
 * @module @deepseek-ai/dsh-client-common-view
 */
import z from '@deepseek-ai/schemastery'
import { COMMON_VIEW_DEFAULTS, type CommonViewConfig } from './config.ts'

export type { CommonViewConfig } from './config.ts'
export { COMMON_VIEW_DEFAULTS, resolveCommonViewConfig } from './config.ts'

/** The row config, with the shared defaults as its schema defaults. */
export type Config = CommonViewConfig

export const name = 'common-view'

export const Config: z<Config> = z.object({
  sessionRowAction: z.boolean().default(COMMON_VIEW_DEFAULTS.sessionRowAction),
  takeoverArchive: z.boolean().default(COMMON_VIEW_DEFAULTS.takeoverArchive),
  accent: z.string().default(COMMON_VIEW_DEFAULTS.accent),
})

/** The browser half owns every registration; the node half mounts nothing. */
export function apply(): void {}
