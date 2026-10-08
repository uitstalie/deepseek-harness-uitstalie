/**
 * `.dsh/` 存储操作：把「建目录 / 写文件 / 查询 / 删除」落到 `ctx.fs` 上。
 *
 * 本模块只接收已解析、已确认位于根内的绝对路径，因此路径拒绝矩阵与会话策略门禁都不在这里：
 * 它只描述每种操作的可观察结果，数据形状与执行逻辑分开。
 * @module @deepseek-ai/dsh-tool-dsh-store/store-ops
 */

import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'

/** 条目类型：只区分调用方需要区分的三类。 */
export type StoreEntryKind = 'file' | 'directory' | 'other'

/** 查询结果里一个条目的可观察信息。 */
export interface StoreEntry {
  /** 相对 `.dsh/` 的展示路径，以 `/` 连接。 */
  path: string
  /** 条目类型。 */
  kind: StoreEntryKind
  /** 文件字节数；目录与未知类型不报。 */
  size?: number
}

/** 一次查询的结果。 */
export interface StoreQueryResult {
  /** 被查询目标的展示路径；根为空串。 */
  path: string
  /** 目标自身的状态；`missing` 表示该位置当前不存在。 */
  kind: 'file' | 'directory' | 'missing' | 'other'
  /** 目标为目录时的直接子项，按名字排序；其他状态为空数组。 */
  entries: StoreEntry[]
  /** 目标为文件且请求了正文时的内容。 */
  text?: string
}

/** 一次创建的结果。 */
export interface StoreCreateResult {
  /** 被创建目标的展示路径。 */
  path: string
  /** 创建出的对象类型。 */
  kind: 'file' | 'directory'
}

/** 一次删除的结果。 */
export interface StoreRemoveResult {
  /** 被删除目标的展示路径。 */
  path: string
  /** 被删除的对象类型。 */
  kind: 'file' | 'directory'
}

/** 查询选项。 */
export interface StoreQueryOptions {
  /** 目标为文件时是否读回正文。 */
  readText?: boolean
  signal?: AbortSignal
}

/** 把一个 `ctx.fs` 统计结果映射成条目类型。 */
function entryKind(type: string): StoreEntryKind {
  if (type === 'file' || type === 'directory') return type
  return 'other'
}

/**
 * 确保 `.dsh/` 根存在；不存在时创建一个空目录。
 * @param fileSystem - 使用的文件系统服务。
 * @param root - 根的绝对路径。
 * @param signal - 取消信号。
 * @param sandboxPolicy - 本次调用所属的会话策略；限定型后端据此围栏。
 * @returns 本次调用是否真的创建了根目录。
 */
export async function ensureStoreRoot(
  fileSystem: FileSystem,
  root: string,
  signal?: AbortSignal,
  sandboxPolicy?: SandboxExecutionPolicy,
): Promise<boolean> {
  const target = await fileSystem.resolve(root, signal === undefined ? {} : { signal })
  const existing = await fileSystem.stat(target, signal)
  if (existing !== undefined) return false
  await fileSystem.mkdir(target, signal, sandboxPolicy)
  return true
}

/**
 * 创建一个目录（含缺失的父目录）。
 * @param fileSystem - 使用的文件系统服务。
 * @param absolutePath - 目标绝对路径，已确认位于根内。
 * @param displayPath - 目标相对 `.dsh/` 的展示路径。
 * @param signal - 取消信号。
 * @param sandboxPolicy - 本次调用所属的会话策略；限定型后端据此围栏。
 * @returns 创建结果。
 */
export async function createStoreFolder(
  fileSystem: FileSystem,
  absolutePath: string,
  displayPath: string,
  signal?: AbortSignal,
  sandboxPolicy?: SandboxExecutionPolicy,
): Promise<StoreCreateResult> {
  const target = await fileSystem.resolve(absolutePath, signal === undefined ? {} : { signal })
  await fileSystem.mkdir(target, signal, sandboxPolicy)
  return { path: displayPath, kind: 'directory' }
}

/**
 * 写入一个文件；缺失的父目录由文件系统写入路径自行补齐。
 * @param fileSystem - 使用的文件系统服务。
 * @param absolutePath - 目标绝对路径，已确认位于根内。
 * @param displayPath - 目标相对 `.dsh/` 的展示路径。
 * @param content - 要写入的完整正文。
 * @param signal - 取消信号。
 * @param sandboxPolicy - 本次调用所属的会话策略；限定型后端据此围栏。
 * @returns 创建结果。
 */
export async function createStoreFile(
  fileSystem: FileSystem,
  absolutePath: string,
  displayPath: string,
  content: string,
  signal?: AbortSignal,
  sandboxPolicy?: SandboxExecutionPolicy,
): Promise<StoreCreateResult> {
  const target = await fileSystem.resolve(absolutePath, signal === undefined ? {} : { signal })
  await fileSystem.writeText(target, content, undefined, signal, sandboxPolicy)
  return { path: displayPath, kind: 'file' }
}

/**
 * 查询一个目标：目录列直接子项，文件可读回正文，缺失如实上报。
 * @param fileSystem - 使用的文件系统服务。
 * @param absolutePath - 目标绝对路径，已确认位于根内。
 * @param displayPath - 目标相对 `.dsh/` 的展示路径。
 * @param options - 是否读回文件正文与取消信号。
 * @returns 查询结果。
 */
export async function queryStoreTarget(
  fileSystem: FileSystem,
  absolutePath: string,
  displayPath: string,
  options: StoreQueryOptions = {},
): Promise<StoreQueryResult> {
  const target = await fileSystem.resolve(absolutePath, options.signal === undefined ? {} : { signal: options.signal })
  const info = await fileSystem.stat(target, options.signal)
  if (info === undefined) return { path: displayPath, kind: 'missing', entries: [] }
  const kind = entryKind(info.type)
  if (kind === 'directory') {
    const entries = await fileSystem.listDir(target, options.signal)
    return {
      path: displayPath,
      kind: 'directory',
      entries: entries
        .map(entry => describeEntry(entry.name, entry.type, entry.size, displayPath))
        .sort((left, right) => left.path.localeCompare(right.path)),
    }
  }
  if (kind !== 'file') return { path: displayPath, kind: 'other', entries: [] }
  const text = options.readText === true ? await fileSystem.readText(target, options.signal) : undefined
  return {
    path: displayPath,
    kind: 'file',
    entries: [],
    ...text === undefined ? {} : { text },
  }
}

/** 组装一个子条目。 */
function describeEntry(name: string, type: string, size: number | undefined, parent: string): StoreEntry {
  return {
    path: parent.length === 0 ? name : `${parent}/${name}`,
    kind: entryKind(type),
    ...size === undefined ? {} : { size },
  }
}

/**
 * 删除一个文件或目录。
 * @param fileSystem - 使用的文件系统服务。
 * @param absolutePath - 目标绝对路径，已确认位于根内。
 * @param displayPath - 目标相对 `.dsh/` 的展示路径。
 * @param recursive - 是否递归删除目录内容；非空目录未给此开关时由文件系统拒绝。
 * @param signal - 取消信号。
 * @param sandboxPolicy - 本次调用所属的会话策略；限定型后端据此围栏。
 * @returns 删除结果。
 */
export async function removeStoreTarget(
  fileSystem: FileSystem,
  absolutePath: string,
  displayPath: string,
  recursive: boolean,
  signal?: AbortSignal,
  sandboxPolicy?: SandboxExecutionPolicy,
): Promise<StoreRemoveResult> {
  const target: FsTarget = await fileSystem.resolve(absolutePath, signal === undefined ? {} : { signal })
  const info = await fileSystem.stat(target, signal)
  const kind = info === undefined ? 'file' : entryKind(info.type)
  await fileSystem.remove(target, { recursive }, signal, sandboxPolicy)
  return { path: displayPath, kind: kind === 'directory' ? 'directory' : 'file' }
}
