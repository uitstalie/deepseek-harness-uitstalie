/**
 * `.dsh/` 路径解析与拒绝矩阵：把模型给出的 `.dsh/` 相对路径规范化成安全段，
 * 绝对路径、盘符、UNC、`..` 逃逸、环境变量展开、Windows 保留名与非法字符一律拒绝。
 * 本模块是纯函数、不触碰文件系统，因此整张矩阵可以逐行钉在单测里。
 * @module @deepseek-ai/dsh-tool-dsh-store/paths
 */

import { isAbsolute, join, relative, resolve } from 'node:path'

/** 工作区内的约定根目录名（锁定，不做配置项）。 */
export const STORE_DIR_NAME = '.dsh'

/** 路径长度与深度上限。 */
export interface StorePathLimits {
  /** 相对 `.dsh/` 的展示路径最大字符数。 */
  maxPathLength: number
  /** 允许的最大目录层数。 */
  maxDepth: number
}

/** 默认上限：240 字符与 32 层。 */
export const DEFAULT_STORE_PATH_LIMITS: StorePathLimits = { maxPathLength: 240, maxDepth: 32 }

/** 拒绝原因；每一项对应拒绝矩阵里的一行。 */
export type StorePathRejection =
  | 'absolute'
  | 'escape'
  | 'expansion'
  | 'reserved-name'
  | 'illegal-character'
  | 'too-long'
  | 'too-deep'

/** 被拒绝的 `.dsh/` 相对路径。 */
export class StorePathError extends Error {
  /**
   * @param reason - 命中的拒绝原因。
   * @param input - 模型给出的原始路径，用于回报而不做二次解释。
   */
  constructor(readonly reason: StorePathRejection, readonly input: string) {
    super(`${STORE_DIR_NAME} path rejected (${reason}): ${JSON.stringify(input)}`)
    this.name = 'StorePathError'
  }
}

/** 规范化结果：安全路径段与模型可见的展示路径。 */
export interface NormalizedStorePath {
  /** 已归一、已校验的路径段；空数组表示 `.dsh/` 根本身。 */
  readonly segments: readonly string[]
  /** 以 `/` 连接的展示路径；根为空串。 */
  readonly displayPath: string
}

const WINDOWS_DRIVE = /^[A-Za-z]:/u
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu
const ILLEGAL_CHARACTER = /[<>:"|?*\u0000-\u001f]/u
const TRAILING_DOT_OR_SPACE = /[ .]$/u

/**
 * 把模型给出的 `.dsh/` 相对路径规范化并校验。
 * 空串、`.`、`./` 与重复分隔符都归一为根本身；`a/../b` 归一为 `b`，而越出根的 `..` 直接拒绝。
 * 整串首尾空白会被去掉（模型常带多余空格，且去掉后指向同一目标）；但**段内部**以空格或点
 * 结尾仍然拒绝，因为 Windows 会静默去掉它们，接受就等于让模型请求的路径与实际写入的不一致。
 * @param input - 模型给出的路径，按 `/` 或 `\` 分隔。
 * @param limits - 长度与深度上限，缺省用 {@link DEFAULT_STORE_PATH_LIMITS}。
 * @returns 安全路径段与展示路径。
 * @throws StorePathError 命中拒绝矩阵中的任一项。
 */
export function normalizeStorePath(
  input: string,
  limits: StorePathLimits = DEFAULT_STORE_PATH_LIMITS,
): NormalizedStorePath {
  const trimmed = input.trim()
  // 绝对形态在 Windows 与 POSIX 上都必须拒绝，因此不依赖 platform 相关的 isAbsolute：
  // 前导分隔符覆盖 POSIX 绝对路径与 UNC，盘符单独匹配。
  if (trimmed.startsWith('/') || trimmed.startsWith('\\') || WINDOWS_DRIVE.test(trimmed)) {
    throw new StorePathError('absolute', input)
  }
  if (trimmed.startsWith('~')) throw new StorePathError('expansion', input)
  const segments: string[] = []
  for (const raw of trimmed.split(/[\\/]+/u)) {
    if (raw === '' || raw === '.') continue
    if (raw === '..') {
      if (segments.length === 0) throw new StorePathError('escape', input)
      segments.pop()
      continue
    }
    if (raw.startsWith('$') || raw.startsWith('%')) throw new StorePathError('expansion', input)
    if (ILLEGAL_CHARACTER.test(raw) || TRAILING_DOT_OR_SPACE.test(raw)) {
      throw new StorePathError('illegal-character', input)
    }
    if (WINDOWS_RESERVED_NAME.test(raw)) throw new StorePathError('reserved-name', input)
    segments.push(raw)
  }
  const displayPath = segments.join('/')
  if (displayPath.length > limits.maxPathLength) throw new StorePathError('too-long', input)
  if (segments.length > limits.maxDepth) throw new StorePathError('too-deep', input)
  return { segments, displayPath }
}

/**
 * 把规范化后的段拼到 `.dsh/` 根上，并再次确认结果仍在根内。
 * @param root - `.dsh/` 根的绝对路径。
 * @param path - {@link normalizeStorePath} 的结果。
 * @returns 目标绝对路径。
 * @throws StorePathError 结果越出根时。
 */
export function resolveStoreTarget(root: string, path: NormalizedStorePath): string {
  const candidate = join(root, ...path.segments)
  if (!isPathInside(root, candidate)) throw new StorePathError('escape', path.displayPath)
  return candidate
}

/**
 * 判断候选路径是否等于根或位于根之内（纯路径段比较，不做 realpath）。
 * @param root - 期望的包含目录。
 * @param candidate - 待判定路径。
 * @returns 候选等于根或位于根内时为 `true`。
 */
export function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
