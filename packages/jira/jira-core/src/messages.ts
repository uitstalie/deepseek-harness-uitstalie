/**
 * core/messages — the command-level Chinese messages both human surfaces share (decision 184).
 *
 * The CLI (`src/cli/main.ts`) and the `/jira` slash command (`src/plugin/command.ts`) answer the
 * same situations, and when each kept its own copy of the sentence they drifted (DPMJ-207: one
 * said "config.md", the other "config.md 词表"). One home per sentence; a surface that needs it
 * imports it from here. This lives in **core**, not cli, because the plugin layer may not import
 * the CLI (decision 64's one-way layers).
 *
 * These are the human surface, so they are Chinese (decision 55). Each entry is a constant, or a
 * small function when the sentence carries a parameter. `messages.test.ts` guards the point of the
 * module: no surface may carry a second literal copy of any sentence defined here.
 */

/** The board cannot render without the store's vocabulary (config.md carries it, so name it). */
export const BOARD_NEEDS_VOCAB = '看板需要可读的 config.md 词表'

/** `new` without a summary is refused on both surfaces with the same sentence. */
export const NEW_NEEDS_SUMMARY = 'new 需要 --summary'

/**
 * A project key becomes `projects/<key>/`, so both surfaces reject a bad one with the same words
 * before the store is ever touched (decision 162).
 */
export const invalidProjectKey = (project: string): string =>
  `项目键 "${project}" 不合法（形如 DH：字母数字，至多六位）`

/** Appended to a create/update/register result when the write was also committed. */
export const committedSuffix = (committed: boolean): string => (committed ? '并已提交' : '')

/** "KB-1 已创建并已提交" — create results on both surfaces (issue and knowledge alike). */
export const createdMessage = (key: string, committed: boolean): string => `${key} 已创建${committedSuffix(committed)}`

/** "KB-1 已更新并已提交" — the knowledge update's result line. */
export const updatedMessage = (key: string, committed: boolean): string => `${key} 已更新${committedSuffix(committed)}`

/** "windows 已注册并已提交" — tag registration. */
export const registeredMessage = (name: string, committed: boolean): string => `${name} 已注册${committedSuffix(committed)}`

/** The note a filtered board appends: how many issues it is not showing, and how to see them. */
export const hiddenIssuesNote = (hidden: number): string =>
  `\n（另有 ${String(hidden)} 条 issue 被隐藏 —— 已关闭或被过滤；用 --all 显示）`

/** Both surfaces' sync report leads with the same "推送：" line. */
export const syncPushLine = (detail: string): string => `推送：${detail}`

/** `tags` takes no action but `lint`; echo what was typed when there was something to echo. */
export const unknownTagsAction = (action?: string): string =>
  action === undefined ? '未知的 tags 动作（可选 lint）' : `未知的 tags 动作 "${action}"（可选 lint）`

/** Decision 193: closing needs a resolution, on every surface. One sentence, one home. */
export const CLOSE_NEEDS_RESOLUTION = 'close 需要 --resolution'
