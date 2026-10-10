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
  'scaffold.sidebar': 'Sidebar',
  'scaffold.top': 'Top',
  'scaffold.content': 'Content',
  'scaffold.buttonSidebar': 'Toggle sidebar width',
  'scaffold.buttonTop': 'Toggle top height',
  'scaffold.newSession': 'New session',
  'scaffold.rowMenu': 'Session actions',
  'scaffold.rowArchive': 'Archive session',
  'scaffold.brand': 'Local build',
  'scaffold.settings': 'Settings',
  'scaffold.toggleSidebar': 'Collapse sidebar',
}

/** Keys of the dictionary; the Chinese side must carry the same set. */
export type CommonViewKey = keyof typeof en

/** Chinese strings, same keys. */
export const zh: typeof en = {
  'marker.tooltip': '通用视图',
  'marker.aria': '{name} 的通用视图 overlay',
  'takeover.tooltip': '归档（通用视图）',
  'takeover.aria': '通过通用视图 overlay 归档 {name}',
  'scaffold.sidebar': '侧边栏',
  'scaffold.top': '顶部',
  'scaffold.content': '内容区',
  'scaffold.buttonSidebar': '切换侧栏宽度',
  'scaffold.buttonTop': '切换顶栏高度',
  'scaffold.newSession': '新会话',
  'scaffold.rowMenu': '会话操作',
  'scaffold.rowArchive': '归档会话',
  'scaffold.brand': '本地构建',
  'scaffold.settings': '设置',
  'scaffold.toggleSidebar': '收起侧边栏',
}
