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

import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
// Type-only: resolves the workspace-registry service declaration.
import { WorkspaceId, type Workspace } from '@deepseek-ai/dsh-workspace'
import { scanWorkspaceRules } from '@deepseek-ai/dsh-agent-instructions-plus'
import { normalizeStorePath, resolveStoreTarget, STORE_DIR_NAME } from './paths.ts'
import { isRulesPath } from './namespaces.ts'
import { queryStoreTarget } from './store-ops.ts'
import type { StoreRuleEntry, StoreRulesListing, StoreRuleText } from './types.ts'

/** Per-file cap applied when the rule set is scanned and read. */
const MAX_RULE_BYTES = 256 * 1024

/**
 * The workspace root of one workspace the Host resolved.
 *
 * A Remote method receives its arguments from the browser, so the workspace is
 * looked up by identity in the Host's own registry; the caller never supplies a
 * path and cannot name a directory the Host does not own.
 * @param workspace - the resolved workspace, or undefined when the id is unknown.
 * @param workspaceId - the id the caller asked for, echoed in the refusal.
 * @returns the canonical absolute workspace root.
 * @throws {RemoteError} `store/unknown-workspace` when the Host has no such workspace.
 */
export function workspaceRootOf(workspace: Pick<Workspace, 'path'> | undefined, workspaceId: string): string {
  if (workspace === undefined) {
    throw new RemoteError('store/unknown-workspace', `"${workspaceId}" is not a workspace of this Host`, { workspaceId })
  }
  return resolve(workspace.path)
}

/**
 * The `.dsh` store root of one resolved workspace.
 * @param workspace - the resolved workspace, or undefined when the id is unknown.
 * @param workspaceId - the id the caller asked for, echoed in the refusal.
 * @returns the canonical `.dsh` root.
 * @throws {RemoteError} `store/unknown-workspace` when the Host has no such workspace.
 */
export function storeRootOfWorkspace(workspace: Pick<Workspace, 'path'> | undefined, workspaceId: string): string {
  return join(workspaceRootOf(workspace, workspaceId), STORE_DIR_NAME)
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

  /** The workspace this Host resolved for one wire identity. */
  private workspaceOf(workspaceId: string): Workspace | undefined {
    return this.ctx.workspaceRegistry.get(WorkspaceId(workspaceId))
  }

  /**
   * List the rules of one workspace.
   *
   * The listing is the instruction loader's own retained set — same scan, same
   * cross-file content deduplication — so the panel shows exactly what reaches
   * the model.
   * @param workspaceId - identity of the workspace whose rules the client shows.
   * @param signal - gateway-supplied cancellation.
   * @returns the retained rule files in path order.
   * @throws {RemoteError} when this Host has no such workspace.
   */
  @Remote
  async listRules(workspaceId: string, signal: AbortSignal): Promise<StoreRulesListing> {
    const workspaceRoot = workspaceRootOf(this.workspaceOf(workspaceId), workspaceId)
    const scan = await scanWorkspaceRules(this.ctx.fs, {
      projectRoot: workspaceRoot,
      maxSourceBytes: MAX_RULE_BYTES,
      signal,
    })
    const entries: StoreRuleEntry[] = scan.files.map(file => ({
      path: storeRelativePath(file.displayPath),
      size: Buffer.byteLength(file.content, 'utf8'),
    }))
    return { root: STORE_DIR_NAME, entries }
  }

  /**
   * Read one rule of one workspace.
   * @param workspaceId - identity of the workspace whose rules the client shows.
   * @param path - rule path relative to the store directory, for example `rules/api.md`.
   * @param signal - gateway-supplied cancellation.
   * @returns the rule's complete text.
   * @throws {RemoteError} when the workspace is unknown, the path is not a rule path, or no rule exists there.
   */
  @Remote
  async readRule(workspaceId: string, path: string, signal: AbortSignal): Promise<StoreRuleText> {
    const storeRoot = storeRootOfWorkspace(this.workspaceOf(workspaceId), workspaceId)
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
