/**
 * Row config of the common-view overlay, shared by both halves.
 *
 * The Loader applies the node half's schema on the Host, while the browser half
 * receives the row's raw `config` — absent for a row that declares none. The
 * browser half therefore resolves what it receives through
 * {@link resolveCommonViewConfig} instead of reading fields directly.
 * @module @deepseek-ai/dsh-client-common-view/config
 */

/** One switch per adopted view, plus the accent and unit geometry the overlay paints and lays out with. */
export interface CommonViewConfig {
  /** Session-row action list: contribute our own item. */
  sessionRowAction: boolean
  /** Session-row action list: take the `archive` item over at a lower priority. */
  takeoverArchive: boolean
  /** Accent the overlay paints with: any CSS color value, by default a theme token. */
  accent: string
  /** Gap between the layout units' children, as a CSS length. */
  unitGap: string
  /** Cross-axis placement inside the layout units. */
  unitAlign: 'start' | 'center' | 'end' | 'stretch'
  /** Along-axis distribution inside the layout units. */
  unitJustify: 'start' | 'center' | 'end' | 'between'
  /** Whether the frame scaffold is mounted in the frame-wide floating layer. */
  scaffold: boolean
  /** Width of the scaffold's left column. */
  scaffoldSidebarWidth: string
  /** Height of the scaffold's top strip. */
  scaffoldTopHeight: string
}

/** Defaults of every field; the node half's schema and the browser half's resolver both read them here. */
export const COMMON_VIEW_DEFAULTS: CommonViewConfig = {
  // Off by default: the session row's action strip is a composite row whose
  // owner owns its layout, so contributing an item into its list cell is not a
  // layout seam there. The switch stays for the mechanism sample and for cells
  // that genuinely are item lists.
  sessionRowAction: false,
  takeoverArchive: false,
  accent: 'var(--dsw-alias-state-business-primary)',
  unitGap: '4px',
  unitAlign: 'center',
  unitJustify: 'start',
  // Off by default: the scaffold is a layout sandbox for verification, never
  // shipped UI.
  scaffold: false,
  scaffoldSidebarWidth: '280px',
  scaffoldTopHeight: '44px',
}

/**
 * Resolve the config the browser half received into a complete one.
 * @param config - the row's raw config, absent when the row declares none.
 * @returns every field, defaulted per {@link COMMON_VIEW_DEFAULTS}.
 */
export function resolveCommonViewConfig(config?: Partial<CommonViewConfig>): CommonViewConfig {
  return { ...COMMON_VIEW_DEFAULTS, ...config }
}
