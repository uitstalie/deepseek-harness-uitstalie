/**
 * Remote wire types of the `.dsh` store: the read-only rule surface the Web
 * sidebar consumes. Typert requires boundary types to be exported from a public
 * non-root `types` subpath, so this module holds types only and no runtime code.
 * @module @deepseek-ai/dsh-tool-dsh-store/types
 */

/** One rule file as the sidebar lists it. */
export interface StoreRuleEntry {
  /** Path relative to the workspace `.dsh` directory, for example `rules/api.md`. */
  path: string
  /** UTF-8 byte length of the file. */
  size: number
}

/** A workspace's loaded rule set. */
export interface StoreRulesListing {
  /** Display path of the store root, relative to the workspace when it is inside it. */
  root: string
  /** Retained rule files in path order; the same set the instruction loader injects. */
  entries: StoreRuleEntry[]
}

/** One rule file's text. */
export interface StoreRuleText {
  /** Path relative to the workspace `.dsh` directory. */
  path: string
  /** Complete Markdown text of the rule. */
  text: string
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The requested root is not a workspace this Host owns. */
    'store/unknown-workspace': { readonly workspaceRoot: string }
    /** The requested path is not a rule path below the store's `rules` directory. */
    'store/invalid-rule-path': { readonly path: string }
    /** No rule exists at the requested path. */
    'store/not-found': { readonly path: string }
  }
}
