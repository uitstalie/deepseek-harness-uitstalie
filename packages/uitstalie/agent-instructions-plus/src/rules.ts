/**
 * Workspace-rules discovery for `<projectRoot>/.dsh/rules/**`: every Markdown
 * file is always-on context, and files whose trimmed content repeats anywhere
 * in the set collapse to the first one in path order.
 * @module @deepseek-ai/dsh-agent-instructions-plus/rules
 */

import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import { instructionContentSha1, trimmedInstructionDigest } from '@deepseek-ai/dsh-agent-instructions'
import type { LoadedInstructionFile } from '@deepseek-ai/dsh-agent-instructions'

/** Workspace-relative directory holding always-on rules. */
export const RULES_DIRECTORY = '.dsh/rules'
/** Only Markdown files are rules; anything else in the tree is ignored. */
const RULES_EXTENSION = '.md'
/** Directory nesting accepted under the rules root. */
const MAX_RULES_DEPTH = 16

/** One rules scan: the retained files plus a change-detection digest. */
export interface RulesScan {
  /** Retained rule files in path order, deduplicated by trimmed content. */
  files: LoadedInstructionFile[]
  /** Digest over the retained set's paths and contents; changes whenever the set changes. */
  digest: string
}

/** Inputs of one rules scan. */
export interface RulesScanOptions {
  /** Project root that owns the `.dsh/rules` directory. */
  projectRoot: string
  /** Per-file byte cap; a larger file is skipped rather than truncated. */
  maxSourceBytes: number
  signal?: AbortSignal
}

/** A rule file identified before its content is read. */
interface RuleCandidate {
  absolutePath: string
  displayPath: string
  target: FsTarget
}

/**
 * Scan the project's rules directory.
 * @param fileSystem - provider used for listing and reading.
 * @param options - project root, per-file cap, and cancellation.
 * @returns retained rule files and the set digest; an absent directory yields an empty scan.
 */
export async function scanWorkspaceRules(fileSystem: FileSystem, options: RulesScanOptions): Promise<RulesScan> {
  options.signal?.throwIfAborted()
  const root = await fileSystem.resolve(RULES_DIRECTORY, {
    cwd: options.projectRoot,
    ...options.signal === undefined ? {} : { signal: options.signal },
  })
  const candidates = await collectRuleFiles(fileSystem, root, options, 0)
  const files: LoadedInstructionFile[] = []
  const seenTrimmed = new Set<string>()
  for (const candidate of candidates) {
    const content = await readRule(fileSystem, candidate, options)
    if (content === undefined) continue
    const trimmed = trimmedInstructionDigest(content)
    if (seenTrimmed.has(trimmed)) continue
    seenTrimmed.add(trimmed)
    files.push({ absolutePath: candidate.absolutePath, displayPath: candidate.displayPath, content })
  }
  return { files, digest: rulesSetDigest(files) }
}

/**
 * Compare two scans by their digest.
 * @param left - previous scan, or undefined when nothing was scanned yet.
 * @param right - current scan.
 * @returns whether the retained rule set changed.
 */
export function rulesScanChanged(left: RulesScan | undefined, right: RulesScan): boolean {
  return left === undefined || left.digest !== right.digest
}

/**
 * Collect every Markdown rule below a directory, depth-bounded and path-ordered.
 * @param fileSystem - provider used for listing.
 * @param directory - directory target to walk.
 * @param options - scan options carrying the signal.
 * @param depth - current nesting depth.
 * @returns candidates in stable display-path order.
 */
async function collectRuleFiles(
  fileSystem: FileSystem,
  directory: FsTarget,
  options: RulesScanOptions,
  depth: number,
): Promise<RuleCandidate[]> {
  if (depth > MAX_RULES_DEPTH) return []
  const info = await fileSystem.stat(directory, options.signal)
  if (info === undefined || info.type !== 'directory') return []
  const entries = await fileSystem.listDir(directory, options.signal)
  const files: RuleCandidate[] = []
  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.type === 'directory') {
      files.push(...await collectRuleFiles(fileSystem, entry.target, options, depth + 1))
      continue
    }
    if (entry.type !== 'file' || !entry.name.endsWith(RULES_EXTENSION)) continue
    files.push({
      absolutePath: entry.target.targetKey,
      displayPath: displayPath(options.projectRoot, entry.target),
      target: entry.target,
    })
  }
  return files
}

/**
 * Read one rule file, skipping it when it exceeds the per-file cap or cannot be read.
 * @param fileSystem - provider used for the read.
 * @param candidate - the file to read.
 * @param options - scan options carrying the cap and signal.
 * @returns the file text, or undefined when it is skipped.
 */
async function readRule(
  fileSystem: FileSystem,
  candidate: RuleCandidate,
  options: RulesScanOptions,
): Promise<string | undefined> {
  const info = await fileSystem.stat(candidate.target, options.signal)
  if (info === undefined || info.type !== 'file') return undefined
  if (info.size !== undefined && info.size > options.maxSourceBytes) return undefined
  const content = await fileSystem.readText(candidate.target, options.signal).catch(() => undefined)
  return content === undefined || content.length === 0 ? undefined : content
}

/** Render one rule's model-facing path relative to the project root. */
function displayPath(projectRoot: string, target: FsTarget): string {
  return relative(projectRoot, target.targetKey).replaceAll('\\', '/')
}

/** Digest the retained set so any add, remove, or edit changes it. */
function rulesSetDigest(files: readonly LoadedInstructionFile[]): string {
  const hash = createHash('sha1')
  for (const file of files) {
    hash.update(file.displayPath)
    hash.update('\0')
    hash.update(instructionContentSha1(file.content))
    hash.update('\n')
  }
  return hash.digest('hex')
}
