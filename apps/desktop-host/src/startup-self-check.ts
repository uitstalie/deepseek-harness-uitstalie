/** Non-blocking Desktop Host startup checks for the bundled Node and native modules. */

import { mkdir, appendFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Health of one startup check. */
export type StartupSelfCheckItemStatus = 'ok' | 'skipped' | 'failed'

/** One bounded startup check observation. */
export interface StartupSelfCheckItem {
  readonly name: 'bundled-node' | 'koffi' | 'sharp'
  readonly status: StartupSelfCheckItemStatus
  readonly detail?: string
}

/** Aggregate result retained by the shell and appended to the Host log. */
export interface StartupSelfCheckResult {
  readonly status: 'ok' | 'degraded'
  readonly items: readonly StartupSelfCheckItem[]
  readonly logPath?: string
  readonly logError?: string
}

/** Inputs required to run the checks without blocking profile startup. */
export interface StartupSelfCheckOptions {
  /** Harness home whose logs directory receives one JSON line. */
  readonly home?: string
  readonly platform?: NodeJS.Platform
  /** Running executable, checked against the bundled standalone Node on Linux. */
  readonly execPath?: string
  /** Bundled standalone Node executable, when the caller can resolve it. */
  readonly expectedNode?: string
  /** Runtime-scoped module loader; the Desktop Host passes its own node_modules resolver. */
  readonly loadModule: (name: string) => unknown
  /** Decodes a tiny PNG through sharp; defaults to the bundled sharp module. */
  readonly decodeSharp?: () => Promise<void>
  readonly now?: Date
}

/** A 1x1 RGB sample; decoding it exercises the native sharp/libvips path without a fixture file. */
const TINY_RAW = Buffer.from([0, 0, 0])

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function defaultDecodeSharp(loadModule: (name: string) => unknown): Promise<void> {
  const sharp = loadModule('sharp') as {
    (input: Buffer, options: { raw: { width: number; height: number; channels: number } }): {
      raw(): { toBuffer(): Promise<Buffer> }
    }
  }
  await sharp(TINY_RAW, { raw: { width: 1, height: 1, channels: 3 } }).raw().toBuffer()
}

/**
 * Run the startup checks without throwing and append one bounded result line.
 *
 * The bundled-node observation is Linux-only because macOS and Windows run the
 * Host on Electron's Node runtime. A failed native probe degrades optional
 * features but never prevents the Host from serving the application.
 * @param options - platform facts, module loader, and log destination.
 * @returns the aggregate result, including a log failure when appending failed.
 */
export async function runStartupSelfCheck(options: StartupSelfCheckOptions): Promise<StartupSelfCheckResult> {
  const platform = options.platform ?? process.platform
  const items: StartupSelfCheckItem[] = []
  if (platform === 'linux') {
    if (options.expectedNode === undefined || options.expectedNode === '') {
      items.push({ name: 'bundled-node', status: 'failed', detail: 'bundled standalone Node path is unavailable' })
    } else if (options.execPath !== options.expectedNode) {
      items.push({ name: 'bundled-node', status: 'failed',
        detail: `Host runs ${String(options.execPath)} instead of the bundled ${options.expectedNode}` })
    } else {
      items.push({ name: 'bundled-node', status: 'ok' })
    }
  } else {
    items.push({ name: 'bundled-node', status: 'skipped', detail: 'Host uses Electron Node on this platform' })
  }
  try {
    const koffi = options.loadModule('koffi') as { load?: unknown }
    if (typeof koffi.load !== 'function') throw new Error('koffi.load is not callable')
    items.push({ name: 'koffi', status: 'ok' })
  } catch (error) {
    items.push({ name: 'koffi', status: 'failed', detail: message(error) })
  }
  try {
    await (options.decodeSharp === undefined
      ? defaultDecodeSharp(options.loadModule)
      : options.decodeSharp())
    items.push({ name: 'sharp', status: 'ok' })
  } catch (error) {
    items.push({ name: 'sharp', status: 'failed', detail: message(error) })
  }
  const status = items.some(item => item.status === 'failed') ? 'degraded' : 'ok'
  const logPath = join(options.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'logs', 'desktop-self-check.log')
  let logError: string | undefined
  try {
    await mkdir(join(options.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'logs'), { recursive: true, mode: 0o700 })
    await appendFile(logPath, `${JSON.stringify({
      time: (options.now ?? new Date()).toISOString(), status, items,
    })}\n`, { mode: 0o600 })
  } catch (error) {
    logError = message(error)
  }
  return { status, items, logPath, ...(logError === undefined ? {} : { logError }) }
}
