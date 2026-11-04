/**
 * Workspace groups other plugins pin above the ordinary list.
 *
 * The sidebar renders the registry's own Workspaces in one list; a plugin that owns a special
 * Workspace (the super agent's home) registers it here, and the browser pulls it into its own
 * labelled section instead of mixing it into the project checkouts. The registry is deliberately
 * generic: it knows a workspace id and a label getter, nothing about who registered it.
 *
 * @module @deepseek-ai/dsh-client-ui-workspace/workspace-groups
 */

import { type Context, Service } from '@deepseek-ai/cordis'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'

/** One special Workspace: its stable id, the label its section shows, and the Workspace it owns. */
export interface WorkspaceGroupSpec {
  /** Stable identity of the group, also its section's slot key. */
  readonly id: string
  /** Section heading copy, read at render time so a locale switch re-renders. */
  readonly label: () => string
  /** The registered Workspace the section renders. */
  readonly workspaceId: WorkspaceId
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Registry of Workspaces that render in their own sidebar section. */
    workspaceGroups: WorkspaceGroupRegistry
  }
}

/**
 * The registry itself. `list()` returns a stable snapshot so React's external-store subscription
 * only re-renders when a group is actually added or removed.
 */
export class WorkspaceGroupRegistry extends Service {
  private readonly entries = new Map<string, WorkspaceGroupSpec>()
  private snapshot: readonly WorkspaceGroupSpec[] = Object.freeze([])
  private readonly listeners = new Set<() => void>()

  /**
   * @param ctx - the client context that owns this service.
   */
  constructor(ctx: Context) {
    super(ctx, 'workspaceGroups')
  }

  /**
   * The registered groups, newest snapshot first.
   * @returns the immutable snapshot the browser renders.
   */
  list(): readonly WorkspaceGroupSpec[] {
    return this.snapshot
  }

  /**
   * Listen for additions and removals.
   * @param listener - called after each change.
   * @returns the unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Publish one group. Registering the same id again replaces the previous spec.
   * @param group - the group to render in its own section.
   * @returns the disposer that removes it again (and only removes this exact registration).
   */
  register(group: WorkspaceGroupSpec): () => void {
    this.entries.set(group.id, group)
    this.publish()
    return () => {
      if (this.entries.get(group.id) !== group) return
      this.entries.delete(group.id)
      this.publish()
    }
  }

  /** Rebuild the snapshot and wake subscribers. */
  private publish(): void {
    this.snapshot = Object.freeze([...this.entries.values()])
    for (const listener of this.listeners) listener()
  }
}
