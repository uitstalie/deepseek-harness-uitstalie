/** Availability of the native update entry, which only packaged feeds can serve. */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Marker describing whether a packaged update feed exists beside the application. */
export const UPDATE_SOURCE_ARGUMENT = '--dsh-update-source='

/**
 * Report whether this installation ships an update feed.
 * @param resourcesPath - Electron's packaged resources directory.
 * @param exists - File probe, replaceable for tests.
 * @returns true when `app-update.yml` is present.
 */
export function hasPackagedUpdateSource(resourcesPath: string, exists: (path: string) => boolean = existsSync): boolean {
  return exists(join(resourcesPath, 'app-update.yml'))
}

/**
 * Gate the user-visible update entry by platform and feed availability.
 * Windows and macOS keep their existing entry semantics; Linux hides it when no feed was packaged.
 * @param platform - Current Node platform.
 * @param source - Whether a packaged feed exists.
 * @returns whether the entry belongs in menus and the preload bridge.
 */
export function updateEntryVisible(platform: NodeJS.Platform, source: boolean): boolean {
  return platform !== 'linux' || source
}

/**
 * Encode feed availability for the sandboxed product preload.
 * @param source - Whether a packaged feed exists.
 * @returns the Electron additional argument consumed by the preload.
 */
export function updateSourceArgument(source: boolean): string {
  return `${UPDATE_SOURCE_ARGUMENT}${source ? '1' : '0'}`
}

/**
 * Read the product preload's feed signal.
 * @param argv - Preload process arguments.
 * @returns true when the main process reported a packaged feed.
 */
export function updateSourceFromArguments(argv: readonly string[]): boolean {
  return argv.includes(`${UPDATE_SOURCE_ARGUMENT}1`)
}
