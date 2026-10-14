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

const sheets = new Map<string, string>()

/**
 * Declarations of one rule, whitespace-normalized.
 * @param file - workspace-relative path of the stylesheet.
 * @param selector - exact selector of the rule.
 * @returns the rule's declarations.
 */
export function cssRule(file: string, selector: string): string {
  let sheet = sheets.get(file)
  if (sheet === undefined) {
    // Specs run with the workspace root as the working directory.
    sheet = readFileSync(file, 'utf8')
    sheets.set(file, sheet)
  }
  const pattern = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\s*\\{([^}]*)\\}`)
  const body = pattern.exec(sheet)?.[1]
  if (body === undefined) throw new Error(`${file}: no ${selector} rule`)
  return body.replace(/\s+/gu, ' ')
}
