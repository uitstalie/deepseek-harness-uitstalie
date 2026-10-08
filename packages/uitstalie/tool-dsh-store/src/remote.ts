/**
 * Read-only Remote surface over one workspace's `.dsh` rules.
 *
 * The Web sidebar shows a workspace's rules from the workspace row, where no
 * session need exist yet — so this namespace is addressed by workspace root
 * rather than by Session, unlike `workspaceFiles`. The root is checked against
 * the Host's workspace registry before anything is read, and every read goes
 * through `ctx.fs`, so a client can read the rules of workspaces the Host owns
 * and nothing else.
 * @module @deepseek-ai/dsh-tool-dsh-store/remote
 */

import { join, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
// Type-only: resolves the workspace-registry service declaration.
import type {} from '@deepseek-ai/dsh-workspace'
import { scanWorkspaceRules } from '@deepseek-ai/dsh-agent-instructions-plus'
import { normalizeStorePath, resolveStoreTarget, STORE_DIR_NAME } from './paths.ts'
import { isRulesPath } from './namespaces.ts'
import { queryStoreTarget } from './store-ops.ts'
import type { StoreRuleEntry, StoreRulesListing, StoreRuleText } from './types.ts'

/** Per-file cap applied when the rule set is scanned and read. */
const MAX_RULE_BYTES = 256 * 1024

/**
 * Refuse a workspace root the Host does not own.
 *
 * A Remote method receives its arguments from the browser, so the root is
 * checked against the registry of workspaces the Host itself resolved instead of
 * being trusted as given.
 * @param knownPaths - absolute workspace paths the Host owns.
 * @param workspaceRoot - the root the caller asked for.
 * @returns the canonical `.dsh` root of that workspace.
 * @throws {RemoteError} `store/unknown-workspace` when the Host does not own the root.
 */
export function storeRootOf(knownPaths: readonly string[], workspaceRoot: string): string {
  const canonical = resolve(workspaceRoot)
  if (!knownPaths.some(path => resolve(path) === canonical)) {
    throw new RemoteError('store/unknown-workspace', `"${workspaceRoot}" is not a workspace of this Host`, { workspaceRoot })
  }
  return join(canonical, STORE_DIR_NAME)
}

/** Drop the store directory prefix from a loader display path (`rules/x.md`). */
export function storeRelativePath(displayPath: string): string {
  const prefix = `${STORE_DIR_NAME}/`
  return displayPath.startsWith(prefix) ? displayPath.slice(prefix.length) : displayPath
}

/**
 * The `.dsh` store Remote namespace (`remote.dshStore`).
 *
 * Both methods only read: the mutating side stays the model-facing store tool,
 * so the sidebar cannot write a rule by accident.
 */
export default class StoreRulesRemote extends TypertRemoteService {
  static inject = ['fs', 'workspaceRegistry']

  /**
   * @param ctx - owning context carrying the filesystem and the workspace registry.
   */
  constructor(ctx: Context) {
    super(ctx, 'dshStore')
  }

  /** Absolute workspace paths this Host owns. */
  private knownPaths(): string[] {
    return this.ctx.workspaceRegistry.list().map(workspace => workspace.path)
  }

  /**
   * List the rules of one owned workspace.
   *
   * The listing is the instruction loader's own retained set — same scan, same
   * cross-file content deduplication — so the panel shows exactly what reaches
   * the model.
   * @param workspaceRoot - absolute workspace path the client already knows.
   * @param signal - gateway-supplied cancellation.
   * @returns the retained rule files in path order.
   */
  @Remote
  async listRules(workspaceRoot: string, signal: AbortSignal): Promise<StoreRulesListing> {
    const storeRoot = storeRootOf(this.knownPaths(), workspaceRoot)
    const scan = await scanWorkspaceRules(this.ctx.fs, {
      projectRoot: resolve(workspaceRoot),
      maxSourceBytes: MAX_RULE_BYTES,
      signal,
    })
    const entries: StoreRuleEntry[] = scan.files.map(file => ({
      path: storeRelativePath(file.displayPath),
      size: Buffer.byteLength(file.content, 'utf8'),
    }))
    return { root: relative(resolve(workspaceRoot), storeRoot).replaceAll('\\', '/'), entries }
  }

  /**
   * Read one rule of one owned workspace.
   * @param workspaceRoot - absolute workspace path the client already knows.
   * @param path - rule path relative to the store directory, for example `rules/api.md`.
   * @param signal - gateway-supplied cancellation.
   * @returns the rule's complete text.
   * @throws {RemoteError} when the path is not a rule path or no rule exists there.
   */
  @Remote
  async readRule(workspaceRoot: string, path: string, signal: AbortSignal): Promise<StoreRuleText> {
    const storeRoot = storeRootOf(this.knownPaths(), workspaceRoot)
    const normalized = normalizeStorePath(path)
    if (!isRulesPath(normalized.displayPath)) {
      throw new RemoteError('store/invalid-rule-path', `"${path}" is not a path below rules/`, { path })
    }
    const queried = await queryStoreTarget(
      this.ctx.fs,
      resolveStoreTarget(storeRoot, normalized),
      normalized.displayPath,
      { readText: true, signal },
    )
    if (queried.kind !== 'file' || queried.text === undefined) {
      throw new RemoteError('store/not-found', `no rule at "${path}"`, { path })
    }
    return { path: normalized.displayPath, text: queried.text }
  }
}
