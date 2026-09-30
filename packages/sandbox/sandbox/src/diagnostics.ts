/** Classify observed sandbox runner failures and file-effect denials. */
import { accessSync, constants, statSync } from 'node:fs'
import type { RunnerFailureRule } from './index.ts'

/** Node-local spawn codes proven to identify executable resolution or permission failure. */
const EXECUTABLE_SPAWN_CODES = new Set(['EACCES', 'ENOENT'])

/** Whether the caller-owned spawn cwd can be entered. */
function isUsableWorkdir(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Attribute only Node ENOENT/EACCES failures whose error path equals argv[0]
 * after independently ruling out the caller-owned cwd. A supplied error path
 * must exactly identify the runner; without one, the syscall must. With a
 * usable cwd, these codes describe resolution or execute permission for that
 * argv[0] or its shebang interpreter.
 * The workdir is checked at classification time, not atomically with spawn;
 * concurrent path replacement may change attribution but cannot permit an
 * unconfined execution.
 * @param error - the original spawn rejection.
 * @param runnerProgram - provider argv[0], the executable that establishes confinement.
 * @param workdir - the caller-owned spawn cwd, checked independently for usability.
 * @returns whether the rejection has executable-specific runner evidence.
 */
export function isRunnerSpawnFailure(
  error: unknown,
  runnerProgram: string | undefined,
  workdir: string,
): boolean {
  if (runnerProgram === undefined || !isUsableWorkdir(workdir)) return false
  if (typeof error !== 'object' || error === null) return false
  const { code, path, syscall } = error as { code?: unknown; path?: unknown; syscall?: unknown }
  if (typeof code !== 'string' || !EXECUTABLE_SPAWN_CODES.has(code)) return false
  if (typeof syscall !== 'string') return false
  const exactSyscall = `spawn ${runnerProgram}`
  if (path === undefined) return syscall === exactSyscall
  if (typeof path !== 'string' || path.length === 0 || path !== runnerProgram) return false
  return syscall === 'spawn' || syscall === exactSyscall
}

/** Fatal runner evidence retained for infrastructure-error detail. */
interface RunnerFailureMatch {
  /** The original stderr line that matched a fatal signature. */
  detail: string
}

/**
 * Classify one settled process against the selected backend's structured
 * runner-failure rules. Each rule requires a nonzero exit, its optional
 * exit-code gate, and a fatal signature on one stderr line after exact
 * informational lines are excluded.
 * @param exitCode - process exit code; null means signal termination.
 * @param stderr - collected stderr text, left unchanged.
 * @param rules - structured runner-failure rules from the active wrap.
 * @returns the first matching fatal line, or undefined when evidence is insufficient.
 */
export function classifyRunnerFailure(
  exitCode: number | null,
  stderr: string,
  rules: readonly RunnerFailureRule[],
): RunnerFailureMatch | undefined {
  if (exitCode === null || exitCode === 0) return undefined
  const lines = stderr.split(/\r?\n/)
  for (const rule of rules) {
    if (rule.allowedExitCodes !== undefined && !rule.allowedExitCodes.includes(exitCode)) continue
    const informationalLines = new Set((rule.informationalLines ?? []).map(line => line.toLowerCase()))
    // An empty or whitespace-only substring is not meaningful runner evidence.
    // Ignore it while keeping any valid signatures beside it active.
    const fatalSignatures = rule.fatalSignatures
      .filter(signature => signature.trim().length > 0)
      .map(signature => signature.toLowerCase())
    for (const line of lines) {
      const lowered = line.toLowerCase()
      if (informationalLines.has(lowered)) continue
      if (fatalSignatures.some(signature => lowered.includes(signature))) return { detail: line }
    }
  }
  return undefined
}

/**
 * Match a non-zero exit against case-insensitive stderr signatures.
 * @param exitCode - process exit code; null means signal termination.
 * @param stderr - collected stderr text.
 * @param signatures - substrings identifying the selected backend's dialect.
 * @returns whether this is a non-zero exit whose stderr matches a signature.
 */
export function matchesSignature(exitCode: number | null, stderr: string, signatures: readonly string[]): boolean {
  if (exitCode === null || exitCode === 0) return false
  const lowered = stderr.toLowerCase()
  return signatures.some(signature => lowered.includes(signature.toLowerCase()))
}

// BEGIN uitstalie-k3, 2026/09/28, task12, 拒绝分类加入路径证据：仅凭短语会把与
// 沙盒无关的失败（ssh 的 Permission denied、工作区内文件自身权限导致的拒绝）
// 误报成沙盒拒绝，再经升级提示诱导模型升权。以下新增块全部为分支自有逻辑。
/**
 * Absolute-path spellings a denial message can name — a drive-letter path, a
 * UNC share, or a POSIX path. Extraction prefers a quoted span, because these
 * dialects quote the offending path (`Access to the path 'D:\my dir\x' is
 * denied.`) and a path may contain spaces; the unquoted form is the fallback for
 * messages that do not quote, ending at the delimiters that surround a path in
 * them (`sh: /x: Permission denied`).
 */
const QUOTED_PATH = /'([^']*)'|"([^"]*)"/g
const UNQUOTED_ABSOLUTE_PATH = /(?:[A-Za-z]:[\\/]|\\\\|\/)[^\s'",;:)\]]*/g
const IS_ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/

/** The absolute paths a denial message names, preferring its quoted spans. */
function namedAbsolutePaths(line: string): string[] {
  const quoted = [...line.matchAll(QUOTED_PATH)]
    .flatMap(match => [match[1], match[2]])
    .filter((candidate): candidate is string => candidate !== undefined && IS_ABSOLUTE_PATH.test(candidate))
  if (quoted.length > 0) return quoted
  return line.match(UNQUOTED_ABSOLUTE_PATH) ?? []
}

/** Collapse a path to the comparison spelling: unified separators, no trailing separator. */
function comparisonPath(path: string): string {
  return path.replaceAll('/', '\\').toLowerCase().replace(/\\+$/, '')
}

/** Whether `path` is one of `roots` or sits under one, on a segment boundary. */
function isUnderAnyRoot(path: string, roots: readonly string[]): boolean {
  const candidate = comparisonPath(path)
  return roots.some((root) => {
    const normalized = comparisonPath(root)
    return candidate === normalized || candidate.startsWith(`${normalized}\\`)
  })
}

/**
 * Whether one phrase-matching stderr line evidences a POLICY denial: it must
 * name an absolute path outside every granted root. `workspace-write` cannot
 * refuse a path inside a granted root, so a denial phrase beside an in-root path
 * — or beside no path at all — describes some other failure: an in-root file's
 * own permissions, or an unrelated tool's message. Classifying that as a sandbox
 * denial would tell the model the sandbox refused a call it never inspected.
 * @param line - the stderr line that matched a denial signature.
 * @param writableRoots - the call's granted write roots.
 * @returns whether the line names a path the granted roots do not cover.
 */
function namesPathOutsideRoots(line: string, writableRoots: readonly string[]): boolean {
  return namedAbsolutePaths(line).some(path => !isUnderAnyRoot(path, writableRoots))
}

/**
 * Classify a failed run as a policy denial: a non-zero exit whose stderr carries
 * one of the selected backend's denial phrases with path evidence that the
 * granted roots cannot explain. Under `read-only` (no granted root) no named
 * path can contradict a phrase, so the phrase alone decides.
 * @param exitCode - process exit code; null means signal termination.
 * @param stderr - collected stderr text, left unchanged.
 * @param signatures - case-insensitive denial substrings from the active wrap.
 * @param writableRoots - the calling session's granted write roots.
 * @returns whether this run is a sandbox denial rather than an unrelated failure.
 */
export function classifyDenial(
  exitCode: number | null,
  stderr: string,
  signatures: readonly string[],
  writableRoots: readonly string[],
): boolean {
  if (exitCode === null || exitCode === 0) return false
  const lowered = signatures.map(signature => signature.toLowerCase())
  return stderr.split(/\r?\n/).some((line) => {
    const candidate = line.toLowerCase()
    if (!lowered.some(signature => candidate.includes(signature))) return false
    return writableRoots.length === 0 || namesPathOutsideRoots(line, writableRoots)
  })
}
// END uitstalie-k3
