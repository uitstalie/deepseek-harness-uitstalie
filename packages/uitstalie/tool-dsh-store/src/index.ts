/**
 * `.dsh` store plugin: registers the `tool-dsh-store` tool and keeps the
 * workspace store root present for each session.
 *
 * The root is `<projectRoot>/.dsh`, discovered the same way
 * `dsh-skill-filesystem` discovers it (`cwd` upward to a `.git` marker, `cwd`
 * when no marker exists). Creating it is a write, so a `read-only` session skips
 * it and retries once the session's mode allows writes.
 * @module @deepseek-ai/dsh-tool-dsh-store
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { findProjectRoot } from '@deepseek-ai/dsh-agent-instructions'
import { STORE_DIR_NAME } from './paths.ts'
import { ensureStoreRoot } from './store-ops.ts'
import { defineStoreTool } from './tool.ts'
import StoreRulesRemote from './remote.ts'

export const name = 'tool-dsh-store'
/** The tool registry and the filesystem every store call writes through. */
export const inject = ['tools', 'fs']

/** Project-root markers; the same convention `dsh-skill-filesystem` applies. */
const PROJECT_ROOT_MARKERS = ['.git']

/** Store plugin configuration. */
export interface Config {
  /** Create `<projectRoot>/.dsh` for a session that needs the store; `false` leaves it absent. */
  ensureRoot?: boolean
}

/** Schemastery configuration for the store plugin. */
export const Config: z<Config> = z.object({
  ensureRoot: z.boolean().default(true),
})

export {
  DEFAULT_STORE_PATH_LIMITS,
  isPathInside,
  normalizeStorePath,
  resolveStoreTarget,
  STORE_DIR_NAME,
  StorePathError,
} from './paths.ts'
export type { NormalizedStorePath, StorePathLimits, StorePathRejection } from './paths.ts'
export {
  isRulesPath,
  isSkillsPath,
  RULES_NAMESPACE_PATTERN,
  SKILLS_NAMESPACE_PATTERN,
  validateNamespaceContent,
} from './namespaces.ts'
export {
  createStoreFile,
  createStoreFolder,
  ensureStoreRoot,
  queryStoreTarget,
  removeStoreTarget,
} from './store-ops.ts'
export type {
  StoreCreateResult,
  StoreEntry,
  StoreEntryKind,
  StoreQueryOptions,
  StoreQueryResult,
  StoreRemoveResult,
} from './store-ops.ts'
export { resolveStorePolicy } from './policy.ts'
export type { StorePolicy } from './policy.ts'
export { defineStoreTool } from './tool.ts'
export type { StoreToolOptions, StoreToolValue } from './tool.ts'
export { storeRelativePath, storeRootOf } from './remote.ts'
export type { StoreRuleEntry, StoreRulesListing, StoreRuleText } from './types.ts'

/**
 * Register the store tool and the per-session root preparation.
 * @param ctx - plugin context carrying the tool registry and filesystem.
 * @param config - whether a session creates the store root on demand.
 */
export function apply(ctx: Context, config: Config): void {
  const ensureRoot = config.ensureRoot ?? true
  const roots = new WeakMap<Session, string>()
  const ensured = new WeakSet<Session>()

  /** The session's `.dsh` root, resolved once per session. */
  const rootOf = async (session: Session, signal?: AbortSignal): Promise<string> => {
    const cached = roots.get(session)
    if (cached !== undefined) return cached
    const cwd = session.header.cwd ?? process.cwd()
    const projectRoot = await findProjectRoot(cwd, PROJECT_ROOT_MARKERS, ctx.fs, signal)
    const root = join(projectRoot, STORE_DIR_NAME)
    roots.set(session, root)
    return root
  }

  /** The session's `.dsh` root, created first unless the session may not write. */
  const prepare = async (session: Session, signal?: AbortSignal): Promise<string> => {
    const root = await rootOf(session, signal)
    if (ensured.has(session)) return root
    const policy: SandboxExecutionPolicy | undefined = ctx.get('sandboxPolicy')?.resolve({ session })
    // A read-only session is deliberately not marked as prepared: its mode can
    // change later in the same session, and the next call then creates the root.
    if (policy?.mode === 'read-only') return root
    await ensureStoreRoot(ctx.fs, root, signal, policy)
    ensured.add(session)
    return root
  }

  ctx.tools.register(defineStoreTool(ctx, {
    resolveRoot: async (exec: ToolExecution): Promise<string> => {
      if (exec.agent === undefined) throw new Error('tool-dsh-store requires an owning agent session')
      return prepare(exec.agent.session, exec.signal)
    },
  }))

  // The read-only Remote namespace the Web sidebar consumes. It waits for the
  // workspace registry on its own fiber, so a composition without one keeps the
  // tool and loses only the sidebar surface.
  void ctx.plugin(StoreRulesRemote)

  if (!ensureRoot) return
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    try {
      await prepare(agent.session, signal)
    } catch (error: unknown) {
      // Preparing the store root is housekeeping rather than part of the step: a
      // failure here is reported, and the tool call that needs the store reports
      // it again with the model-facing message.
      ctx.logger.warn('store root preparation failed: %o', error)
    }
    return next()
  })
}
