/**
 * Row config of the common-view overlay, shared by both halves.
 *
 * The Loader applies the node half's schema on the Host, while the browser half
 * receives the row's raw `config` — absent for a row that declares none. The
 * browser half therefore resolves what it receives through
 * {@link resolveCommonViewConfig} instead of reading fields directly.
 * @module @deepseek-ai/dsh-client-common-view/config
 */

/** One switch per adopted view, plus the accent the overlay paints with. */
export interface CommonViewConfig {
  /** Session-row action list: contribute our own item. */
  sessionRowAction: boolean
  /** Session-row action list: take the `archive` item over at a lower priority. */
  takeoverArchive: boolean
  /** Accent the overlay paints with: any CSS color value, by default a theme token. */
  accent: string
}

/** Defaults of every field; the node half's schema and the browser half's resolver both read them here. */
export const COMMON_VIEW_DEFAULTS: CommonViewConfig = {
  sessionRowAction: true,
  takeoverArchive: false,
  accent: 'var(--dsw-alias-state-business-primary)',
}

/**
 * Resolve the config the browser half received into a complete one.
 * @param config - the row's raw config, absent when the row declares none.
 * @returns every field, defaulted per {@link COMMON_VIEW_DEFAULTS}.
 */
export function resolveCommonViewConfig(config?: Partial<CommonViewConfig>): CommonViewConfig {
  return { ...COMMON_VIEW_DEFAULTS, ...config }
}
