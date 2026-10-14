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
  'scaffold.newSessionIn': 'New session in {name}',
  // Workspace-row menu copy, again split like the shell's: the trigger names the
  // workspace, the rows carry the verb.
  'scaffold.groupMenu': 'Workspace actions for {name}',
  'scaffold.menuRenameWorkspace': 'Rename',
  'scaffold.menuDeleteWorkspace': 'Delete workspace',
  // Session-row action copy mirrors the shell's own keys: the tooltip takes the
  // short `actions.*` form, the accessible name the `menu.*` sentence.
  'scaffold.rowMenu': 'Session actions for {name}',
  'scaffold.rowArchive': 'Archive',
  'scaffold.rowUnarchive': 'Unarchive',
  'scaffold.rowPin': 'Pin',
  'scaffold.rowUnpin': 'Unpin',
  'scaffold.menuPin': 'Pin session',
  'scaffold.menuUnpin': 'Unpin session',
  'scaffold.menuRename': 'Rename session',
  'scaffold.menuFork': 'Fork session',
  'scaffold.menuArchive': 'Archive session',
  'scaffold.menuUnarchive': 'Unarchive session',
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
  'scaffold.newSessionIn': '在“{name}”中新建会话',
  'scaffold.groupMenu': '工作区“{name}”的操作',
  'scaffold.menuRenameWorkspace': '重命名',
  'scaffold.menuDeleteWorkspace': '删除工作区',
  'scaffold.rowMenu': '会话“{name}”的操作',
  'scaffold.rowArchive': '归档会话',
  'scaffold.rowUnarchive': '取消归档',
  'scaffold.rowPin': '置顶会话',
  'scaffold.rowUnpin': '取消置顶',
  'scaffold.menuPin': '置顶会话',
  'scaffold.menuUnpin': '取消置顶',
  'scaffold.menuRename': '重命名会话',
  'scaffold.menuFork': '分叉会话',
  'scaffold.menuArchive': '归档会话',
  'scaffold.menuUnarchive': '取消归档',
  'scaffold.brand': '本地构建',
  'scaffold.settings': '设置',
  'scaffold.toggleSidebar': '收起侧边栏',
}
