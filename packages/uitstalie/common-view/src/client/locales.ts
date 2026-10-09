/**
 * Copy of the `common-view` namespace. Every product-visible string the overlay
 * shows lives here, so the copy gate sees one dictionary per language.
 * @module @deepseek-ai/dsh-client-common-view/locales
 */

/** English strings. */
export const en = {
  'marker.tooltip': 'Common view',
  'marker.aria': 'Common-view overlay for {name}',
  'takeover.tooltip': 'Archive (common view)',
  'takeover.aria': 'Archive {name} through the common-view overlay',
}

/** Keys of the dictionary; the Chinese side must carry the same set. */
export type CommonViewKey = keyof typeof en

/** Chinese strings, same keys. */
export const zh: typeof en = {
  'marker.tooltip': '通用视图',
  'marker.aria': '{name} 的通用视图 overlay',
  'takeover.tooltip': '归档（通用视图）',
  'takeover.aria': '通过通用视图 overlay 归档 {name}',
}
