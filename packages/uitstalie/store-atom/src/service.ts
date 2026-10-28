/**
 * The `.dsh` store service (`ctx.dshStore`): the base interface other branch
 * plugins use to read and manage a workspace's `.dsh` directory.
 *
 * The service owns project-root discovery, `.dsh` path confinement, the store
 * operations, the rules-namespace authoring checks, and the per-session
 * sandbox policy gate. The model-facing tool and the sidebar Remote are
 * consumers of this interface, so a new consumer never re-assembles a store
 * path or re-implements the refusal matrix.
 * @module @deepseek-ai/dsh-store-atom/service
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { findProjectRoot, trimmedInstructionDigest } from '@deepseek-ai/dsh-agent-instructions'
import { STORE_DIR_NAME, normalizeStorePath, resolveStoreTarget } from './paths.ts'
import { isRulesPath, validateNamespaceContent } from './namespaces.ts'
import { scanWorkspaceRules } from './rules.ts'
import {
  createStoreFile,
  createStoreFolder,
  ensureStoreRoot,
  queryStoreTarget,
  removeStoreTarget,
} from './store-ops.ts'
import type { StoreCreateResult, StoreQueryResult, StoreRemoveResult } from './store-ops.ts'
import { resolveSessionStorePolicy } from './policy.ts'

/** Which `.dsh` directory one call addresses. */
export type StoreScope = 'global' | 'workspace'

/** Project-root markers; the same convention `dsh-skill-filesystem` applies. */
const PROJECT_ROOT_MARKERS = ['.git']

/** The per-file cap applied when the rules namespace is scanned for duplicates. */
const RULE_SOURCE_MAX_BYTES = 256 * 1024

/** One store call's cancellation. */
export interface StoreCallOptions {
  /** Cancellation forwarded to every filesystem operation. */
  signal?: AbortSignal
  /**
   * Which `.dsh` root the call addresses: the user's `$DSH_HOME` (`global`) or
   * the session workspace's `.dsh` (`workspace`, the default).
   */
  scope?: StoreScope
}

/** Options of a store removal. */
export interface StoreRemoveOptions extends StoreCallOptions {
  /** Remove a populated directory and its contents. */
  recursive?: boolean
}

/** Options of a store file write. */
export interface StoreWriteOptions extends StoreCallOptions {
  /**
   * Version the file must still carry, as returned by an earlier write; omit
   * for an unconditional create-or-overwrite.
   */
  expected?: string
}

/** Result of a store file write. */
export interface StoreWriteResult {
  /** Written path relative to `.dsh`. */
  path: string
  /** Opaque version of the file after the write; pass it as the next `expected`. */
  version?: string
}

/** Result of a store file read. */
export interface StoreReadResult {
  /** Read path relative to `.dsh`. */
  path: string
  /** File text; absent unless the target is an existing regular file. */
  text?: string
  /** Opaque version of the observed file; pass it as the next write's `expected`. */
  version?: string
}

/**
 * The `.dsh` base interface. Every method addresses one of two roots — the
 * user's `$DSH_HOME` (`global`) or the session workspace's `.dsh` (`workspace`,
 * the default). The workspace root is derived from the session's project, never
 * from a caller-supplied path; the global root is `$DSH_HOME` and takes no
 * session.
 */
export interface DshStore {
  /**
   * Resolve the project root that owns the session's `.dsh` directory.
   * @param session - session whose cwd anchors discovery.
   * @param signal - cancellation for the filesystem probes.
   * @returns the absolute project root.
   */
  projectRootFor(session: Session, signal?: AbortSignal): Promise<string>
  /**
   * Resolve one absolute `.dsh` root without creating it.
   * @param scope - `global` for `$DSH_HOME`, `workspace` for the project's `.dsh`.
   * @param session - session whose project owns the workspace root; required for `workspace`.
   * @param signal - cancellation for the filesystem probes.
   * @returns the absolute store root.
   */
  rootFor(scope: StoreScope, session?: Session, signal?: AbortSignal): Promise<string>
  /**
   * Resolve and, when writing is allowed, create one store root.
   * @param scope - `global` for `$DSH_HOME`, `workspace` for the project's `.dsh`.
   * @param session - session whose policy gates a workspace root; required for `workspace`.
   * @param signal - cancellation for the filesystem probes.
   * @returns the absolute store root.
   */
  prepare(scope: StoreScope, session?: Session, signal?: AbortSignal): Promise<string>
  /**
   * Create a file below the store root.
   * @param session - session whose policy gates a workspace write; omit for global.
   * @param path - store-relative target path.
   * @param content - complete file text.
   * @param options - scope and cancellation.
   * @returns the created target record.
   */
  createFile(session: Session | undefined, path: string, content: string, options?: StoreCallOptions): Promise<StoreCreateResult>
  /**
   * Write one file below the store root with an optional version guard.
   *
   * This is the provider-facing write: it skips the `rules` and `skills`
   * authoring checks, because a plugin that owns a namespace persists its own
   * content there and no model-authoring rule applies to it. A global write has
   * no sandbox-policy gate, because the session policy covers the workspace.
   * @param session - session whose policy gates a workspace write; omit for global.
   * @param path - store-relative target path; the root itself is refused.
   * @param content - complete file text.
   * @param options - scope, cancellation, and the version the file must still carry.
   * @returns the written path and the version a later guarded write can expect.
   * @throws Error when the path is empty, or when `workspace` is requested without a session.
   * @throws StorePathError when the path leaves the store root.
   * @throws FsError `FS_SANDBOX_DENIED` for a read-only workspace, or
   *   `FS_STALE_VERSION` when `expected` no longer matches the file.
   */
  writeFile(session: Session | undefined, path: string, content: string, options?: StoreWriteOptions): Promise<StoreWriteResult>
  /**
   * Read one store file without the session policy gate, because reading is
   * allowed in every mode.
   *
   * The returned version is the value a later guarded `writeFile` passes as
   * `expected`. A provider reads the file, composes the next text, and writes
   * it back with that version, so a concurrent writer surfaces as
   * `FS_STALE_VERSION` instead of a silent overwrite.
   * @param session - session whose project owns a workspace store; omit for global.
   * @param path - store-relative target path.
   * @param options - scope and cancellation.
   * @returns the target path plus the text and version when it is a regular file.
   * @throws StorePathError when the path leaves the store root.
   */
  readFile(session: Session | undefined, path: string, options?: StoreCallOptions): Promise<StoreReadResult>
  /**
   * Create a folder below the store root.
   * @param session - session whose policy gates a workspace write; omit for global.
   * @param path - store-relative target path.
   * @param options - scope and cancellation.
   * @returns the created target record.
   */
  createFolder(session: Session | undefined, path: string, options?: StoreCallOptions): Promise<StoreCreateResult>
  /**
   * Inspect one store target.
   * @param session - session whose project owns a workspace store; omit for global.
   * @param path - store-relative target path.
   * @param options - scope and cancellation.
   * @returns the target kind, direct children, and (for a file) its text.
   */
  query(session: Session | undefined, path: string, options?: StoreCallOptions): Promise<StoreQueryResult>
  /**
   * Remove one store target.
   * @param session - session whose policy gates a workspace write; omit for global.
   * @param path - store-relative target path.
   * @param options - scope, recursive removal, and cancellation.
   * @returns the removed target record.
   */
  remove(session: Session | undefined, path: string, options?: StoreRemoveOptions): Promise<StoreRemoveResult>
}

declare module '@deepseek-ai/cordis' {
  /** The `.dsh` store base interface provided by `dsh-tool-dsh-store`. */
  interface Context {
    dshStore: DshStore
  }
}

/**
 * Build the `.dsh` store service.
 * @param ctx - plugin context carrying the filesystem and optional sandbox-policy services.
 * @param ensureRoot - whether a writable session gets its store root created on demand.
 * @returns the service value registered as `ctx.dshStore`.
 */
export function createDshStore(ctx: Context, ensureRoot: boolean): DshStore {
  const projectRoots = new WeakMap<Session, string>()
  const roots = new WeakMap<Session, string>()
  const prepared = new WeakSet<Session>()
  let globalRoot: string | undefined
  let globalPrepared = false

  const projectRootFor = async (session: Session, signal?: AbortSignal): Promise<string> => {
    const cached = projectRoots.get(session)
    if (cached !== undefined) return cached
    const cwd = session.header.cwd ?? process.cwd()
    const projectRoot = await findProjectRoot(cwd, PROJECT_ROOT_MARKERS, ctx.fs, signal)
    projectRoots.set(session, projectRoot)
    return projectRoot
  }

  const rootFor = async (
    scope: StoreScope,
    session?: Session,
    signal?: AbortSignal,
  ): Promise<string> => {
    if (scope === 'global') return globalRoot ??= resolveDshHome()
    if (session === undefined) {
      throw new Error('the workspace scope requires a session; pass scope: global to address the user store')
    }
    const cached = roots.get(session)
    if (cached !== undefined) return cached
    const root = join(await projectRootFor(session, signal), STORE_DIR_NAME)
    roots.set(session, root)
    return root
  }

  /** Which root one call addresses; every method defaults to the workspace. */
  const scopeOf = (options: StoreCallOptions = {}): StoreScope => options.scope ?? 'workspace'

  /** The policy gate belongs to the workspace; a global write has no session gate. */
  const policyFor = (
    scope: StoreScope,
    session: Session | undefined,
  ): SandboxExecutionPolicy | undefined =>
    scope === 'workspace' && session !== undefined ? resolveSessionStorePolicy(ctx, session) : undefined

  /** Refuse a duplicate rule before the write; the load-time set dedups by content. */
  const refuseDuplicateRule = async (
    projectRoot: string,
    content: string,
    signal?: AbortSignal,
  ): Promise<void> => {
    const scan = await scanWorkspaceRules(ctx.fs, {
      projectRoot,
      maxSourceBytes: RULE_SOURCE_MAX_BYTES,
      ...signal === undefined ? {} : { signal },
    })
    const digest = trimmedInstructionDigest(content)
    const duplicate = scan.files.find(file => trimmedInstructionDigest(file.content) === digest)
    if (duplicate !== undefined) {
      throw new Error(`duplicate rule: ${duplicate.displayPath} already carries this text; edit that file instead of adding a copy`)
    }
  }

  /**
   * Resolve one root and, for a writable target, create it.
   * @param scope - `global` or `workspace`.
   * @param session - the session whose policy and project own a workspace root.
   * @param signal - cancellation for the filesystem probes and creation.
   * @returns the absolute root.
   */
  const prepare = async (scope: StoreScope, session?: Session, signal?: AbortSignal): Promise<string> => {
    const root = await rootFor(scope, session, signal)
    if (!ensureRoot) return root
    if (scope === 'global') {
      if (globalPrepared) return root
      await ensureStoreRoot(ctx.fs, root, signal)
      globalPrepared = true
      return root
    }
    if (session === undefined) return root
    if (prepared.has(session)) return root
    const policy = ctx.get('sandboxPolicy')?.resolve({ session })
    // A read-only session is deliberately not marked as prepared: its mode can
    // change later in the same session, and the next call then creates the root.
    if (policy?.mode === 'read-only') return root
    await ensureStoreRoot(ctx.fs, root, signal, policy)
    prepared.add(session)
    return root
  }

  return {
    projectRootFor,
    rootFor,
    prepare,
    async createFile(
      session: Session | undefined,
      path: string,
      content: string,
      options: StoreCallOptions = {},
    ): Promise<StoreCreateResult> {
      const scope = scopeOf(options)
      const root = await prepare(scope, session, options.signal)
      const normalized = normalizeStorePath(path)
      const target = resolveStoreTarget(root, normalized)
      if (scope === 'workspace' && session !== undefined && isRulesPath(normalized.displayPath)) {
        await refuseDuplicateRule(await projectRootFor(session, options.signal), content, options.signal)
      }
      validateNamespaceContent(normalized.displayPath, content)
      return await createStoreFile(
        ctx.fs,
        target,
        normalized.displayPath,
        content,
        options.signal,
        policyFor(scope, session),
      )
    },
    async writeFile(
      session: Session | undefined,
      path: string,
      content: string,
      options: StoreWriteOptions = {},
    ): Promise<StoreWriteResult> {
      const scope = scopeOf(options)
      const root = await prepare(scope, session, options.signal)
      const normalized = normalizeStorePath(path)
      if (normalized.displayPath.length === 0) {
        throw new Error(`refusing to write the ${STORE_DIR_NAME} root: a file path is required`)
      }
      const resolveOptions = options.signal === undefined ? {} : { signal: options.signal }
      const target = await ctx.fs.resolve(resolveStoreTarget(root, normalized), resolveOptions)
      const expected = options.expected === undefined
        ? undefined
        : { kind: 'replaceIfVersion' as const, version: FsVersion(options.expected) }
      const outcome = await ctx.fs.writeText(target, content, expected, options.signal, policyFor(scope, session))
      return { path: normalized.displayPath, version: outcome.version }
    },
    async readFile(
      session: Session | undefined,
      path: string,
      options: StoreCallOptions = {},
    ): Promise<StoreReadResult> {
      const scope = scopeOf(options)
      const root = await rootFor(scope, session, options.signal)
      const normalized = normalizeStorePath(path)
      const resolveOptions = options.signal === undefined ? {} : { signal: options.signal }
      const target = await ctx.fs.resolve(resolveStoreTarget(root, normalized), resolveOptions)
      const info = await ctx.fs.stat(target, options.signal)
      if (info === undefined || info.type !== 'file') return { path: normalized.displayPath }
      const text = await ctx.fs.readText(target, options.signal)
      return { path: normalized.displayPath, text, version: info.version }
    },
    async createFolder(
      session: Session | undefined,
      path: string,
      options: StoreCallOptions = {},
    ): Promise<StoreCreateResult> {
      const scope = scopeOf(options)
      const root = await prepare(scope, session, options.signal)
      const normalized = normalizeStorePath(path)
      const target = resolveStoreTarget(root, normalized)
      return await createStoreFolder(
        ctx.fs,
        target,
        normalized.displayPath,
        options.signal,
        policyFor(scope, session),
      )
    },
    async query(session: Session | undefined, path: string, options: StoreCallOptions = {}): Promise<StoreQueryResult> {
      const scope = scopeOf(options)
      const root = await rootFor(scope, session, options.signal)
      const normalized = normalizeStorePath(path)
      const target = resolveStoreTarget(root, normalized)
      return await queryStoreTarget(ctx.fs, target, normalized.displayPath, {
        readText: true,
        ...options.signal === undefined ? {} : { signal: options.signal },
      })
    },
    async remove(session: Session | undefined, path: string, options: StoreRemoveOptions = {}): Promise<StoreRemoveResult> {
      const scope = scopeOf(options)
      const root = await rootFor(scope, session, options.signal)
      const normalized = normalizeStorePath(path)
      if (normalized.displayPath.length === 0) throw new Error(`refusing to delete the ${STORE_DIR_NAME} root`)
      const target = resolveStoreTarget(root, normalized)
      const resolveOptions = options.signal === undefined ? {} : { signal: options.signal }
      const existing = await ctx.fs.stat(await ctx.fs.resolve(target, resolveOptions), options.signal)
      if (existing === undefined) throw new Error(`not found: ${STORE_DIR_NAME}/${normalized.displayPath}`)
      return await removeStoreTarget(
        ctx.fs,
        target,
        normalized.displayPath,
        options.recursive === true,
        options.signal,
        policyFor(scope, session),
      )
    },
  }
}
