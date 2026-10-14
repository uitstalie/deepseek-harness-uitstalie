/**
 * Stylesheet probing for the scaffold's replicas.
 *
 * jsdom does not apply CSS modules, so a measurement copied from the shell's own
 * stylesheet cannot be asserted through the rendered DOM; these helpers read the
 * rule from source instead, which keeps the copied numbers honest.
 * @module @deepseek-ai/dsh-client-common-view/tests/css-rule
 */
import { readFileSync } from 'node:fs'

/** Workspace-relative path of the frame scaffold's stylesheet. */
export const SCAFFOLD_CSS = 'packages/uitstalie/common-view/src/client/views/scaffold/AppScaffold.module.css'

/** Workspace-relative path of the sidebar replica's stylesheet. */
export const SIDEBAR_CSS = 'packages/uitstalie/common-view/src/client/views/scaffold/SidebarGroupList.module.css'

/** Workspace-relative path of the middle region's header stylesheet. */
export const CONTENT_HEADER_CSS = 'packages/uitstalie/common-view/src/client/views/scaffold/ContentHeader.module.css'

/** Workspace-relative path of the middle region's body stylesheet. */
export const CONTENT_BODY_CSS = 'packages/uitstalie/common-view/src/client/views/scaffold/ContentBody.module.css'

/** Workspace-relative path of the blank Session's hero stylesheet. */
export const HERO_CSS = 'packages/uitstalie/common-view/src/client/views/scaffold/HeroShell.module.css'

/** Workspace-relative path of the context meter's stylesheet. */
export const METER_CSS = 'packages/uitstalie/common-view/src/client/views/scaffold/ContextMeter.module.css'

/** Workspace-relative path of the chat transcript's stylesheet. */
export const CHAT_CSS = 'packages/uitstalie/common-view/src/client/views/scaffold/ChatTranscript.module.css'

/** Workspace-relative path of the queue dock's stylesheet. */
export const QUEUE_CSS = 'packages/uitstalie/common-view/src/client/views/scaffold/QueueDock.module.css'

/** Workspace-relative path of the generic tool card's stylesheet. */
export const TOOL_CSS = 'packages/uitstalie/common-view/src/client/views/scaffold/ToolCard.module.css'

const sheets = new Map<string, string>()

/**
 * Every rule that names a selector, whitespace-normalized, in source order.
 * @param file - workspace-relative path of the stylesheet.
 * @param selector - exact selector of the rule.
 * @returns the declarations of each matching rule.
 */
function cssRules(file: string, selector: string): string[] {
  let sheet = sheets.get(file)
  if (sheet === undefined) {
    // Specs run with the workspace root as the working directory.
    sheet = readFileSync(file, 'utf8')
    sheets.set(file, sheet)
  }
  const item = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const pattern = new RegExp(`(?:^|,)\\s*${item}\\s*(?:,[^{}]*)?\\{([^}]*)\\}`, 'gmu')
  const bodies = [...sheet.matchAll(pattern)].map(match => (match[1] ?? '').replace(/\s+/gu, ' '))
  if (bodies.length === 0) throw new Error(`${file}: no ${selector} rule`)
  return bodies
}

/**
 * Declarations of every rule naming one selector, joined for assertion.
 *
 * The selector may be one item of a shared rule's selector list: a rule written
 * as `.a, .b { … }` answers for both `.a` and `.b`, and a selector carrying two
 * rules (a layout block and a gap block) answers with both.
 * @param file - workspace-relative path of the stylesheet.
 * @param selector - exact selector of the rule.
 * @returns every matching rule's declarations, space-separated.
 */
export function cssRule(file: string, selector: string): string {
  return cssRules(file, selector).join(' ')
}
