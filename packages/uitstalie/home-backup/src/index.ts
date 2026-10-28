/**
 * Scheduled snapshots of the harness home.
 *
 * The plugin copies the directories the ledger of user work lives in — by
 * default `sessions` and `storages` — plus each profile's configuration files
 * to a destination outside `$DSH_HOME`, on a fixed interval, and keeps the
 * newest snapshots. It is host-only: it contributes no tools, no prompt
 * sections, and no Session events.
 *
 * @module @deepseek-ai/dsh-home-backup
 */

import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { runBackup, type BackupSelection } from './backup.ts'

/** Plugin name the Loader and patch rows address. */
export const name = 'home-backup'

/** Default interval between snapshots: 30 minutes. */
export const DEFAULT_INTERVAL_MS = 30 * 60 * 1000

/** Default delay before the first snapshot after boot: 30 seconds. */
export const DEFAULT_INITIAL_DELAY_MS = 30 * 1000

/** Default number of snapshots kept in the destination. */
export const DEFAULT_RETAIN = 24

/** Default home entries copied whole. */
export const DEFAULT_HOME_PATHS = Object.freeze(['sessions', 'storages'])

/** Plugin configuration; every field is optional and the schema supplies the default. */
export interface Config {
  /** Snapshot directory; absent means {@link defaultDestination}. */
  destination?: string
  /** Interval between snapshots in milliseconds. */
  intervalMs?: number
  /** Delay before the first snapshot in milliseconds; `0` snapshots at mount. */
  initialDelayMs?: number
  /** Snapshots kept, including the newest. */
  retain?: number
  /** Home-relative paths copied whole. */
  paths?: string[]
  /** Copy each profile's configuration files; default `true`. */
  profileConfig?: boolean
  /** Copy the credentials file; default `false`, so a snapshot holds no secrets. */
  credentials?: boolean
}

/** Validated schema; bounds keep a typo from turning into a snapshot storm or an empty window. */
export const Config: z<Config> = z.object({
  destination: z.string().min(1).default(defaultDestination()),
  intervalMs: z.number().step(1).min(60_000).default(DEFAULT_INTERVAL_MS),
  initialDelayMs: z.number().step(1).min(0).default(DEFAULT_INITIAL_DELAY_MS),
  retain: z.number().step(1).min(1).default(DEFAULT_RETAIN),
  paths: z.array(z.string().min(1)).min(1).default([...DEFAULT_HOME_PATHS]),
  profileConfig: z.boolean().default(true),
  credentials: z.boolean().default(false),
})

/**
 * The default snapshot destination: `dsh-backups` beside the harness home, so
 * losing `$DSH_HOME` does not lose the snapshots with it.
 * @returns the absolute default destination.
 */
export function defaultDestination(): string {
  return resolve(homedir(), 'dsh-backups')
}

/** Materialized settings; the schema path fills the same values at load. */
interface Settings {
  home: string
  destination: string
  intervalMs: number
  initialDelayMs: number
  retain: number
  selection: BackupSelection
}

/** Fail loud on a programmatic mount that bypassed schema validation. */
function positiveInteger(label: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`home-backup: ${label} must be a positive integer`)
}

/** Fail loud on a programmatic mount that bypassed schema validation. */
function nonNegativeInteger(label: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`home-backup: ${label} must be a non-negative integer`)
}

/** Materialize the defaults a Loader mount would already have applied. */
function settingsOf(config: Config): Settings {
  const intervalMs = config.intervalMs ?? DEFAULT_INTERVAL_MS
  const initialDelayMs = config.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS
  const retain = config.retain ?? DEFAULT_RETAIN
  positiveInteger('intervalMs', intervalMs)
  nonNegativeInteger('initialDelayMs', initialDelayMs)
  positiveInteger('retain', retain)
  const paths = config.paths ?? [...DEFAULT_HOME_PATHS]
  if (paths.length === 0) throw new Error('home-backup: paths must name at least one home entry')
  return {
    home: resolveDshHome(),
    destination: resolve(config.destination ?? defaultDestination()),
    intervalMs,
    initialDelayMs,
    retain,
    selection: {
      paths,
      profileConfig: config.profileConfig ?? true,
      credentials: config.credentials ?? false,
    },
  }
}

/**
 * Schedule snapshots for one harness home.
 *
 * The first snapshot runs after `initialDelayMs` and later ones every
 * `intervalMs`; both timers are unref'd so a snapshot never holds the process
 * open. A failed run is reported and the schedule continues. Disposal clears
 * both timers and waits for a run already in flight.
 *
 * @param ctx - plugin context that owns the timers.
 * @param config - {@link Config}; absent fields take their defaults.
 */
export function apply(ctx: Context, config: Config): void {
  const settings = settingsOf(config)
  const logger = ctx.logger
  let inFlight: Promise<void> | undefined

  const execute = async (): Promise<void> => {
    try {
      const result = await runBackup({
        home: settings.home,
        destination: settings.destination,
        retain: settings.retain,
        selection: settings.selection,
        now: () => new Date(),
      })
      const pruned = result.pruned.length === 0 ? '' : `; pruned ${String(result.pruned.length)} older snapshot(s)`
      logger.info(`home-backup: wrote ${result.snapshot.directory} (${String(result.snapshot.files)} files, ${String(result.snapshot.bytes)} bytes)${pruned}`)
    } catch (error) {
      logger.warn('home-backup: snapshot failed', error)
    }
  }

  const run = (): void => {
    // A slow snapshot must not overlap the next tick: both would write the same
    // staging directory and the later run would remove what the earlier is
    // filling (ENOTEMPTY on Windows, a lost staging state elsewhere).
    if (inFlight !== undefined) return
    inFlight = execute().finally(() => { inFlight = undefined })
  }

  ctx.effect(() => {
    const initial = setTimeout(run, settings.initialDelayMs)
    initial.unref()
    const periodic = setInterval(run, settings.intervalMs)
    periodic.unref()
    return async () => {
      clearTimeout(initial)
      clearInterval(periodic)
      await inFlight
    }
  }, 'home-backup: scheduled snapshots')
}
