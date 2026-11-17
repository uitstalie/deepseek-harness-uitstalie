/**
 * One-time migration command for the global memory store.
 *
 * Dry run (the default) prints the report and writes nothing:
 *
 * ```
 * node_modules/.bin/tsx packages/uitstalie/memory/scripts/migrate-global-memory.ts \
 *   --workspace /path/to/workspace --workspace /path/to/other
 * ```
 *
 * Review the report, then repeat the same command with the printed hash:
 *
 * ```
 * ... --workspace /path/to/workspace --apply <report-hash>
 * ```
 *
 * Restore every backup of that run:
 *
 * ```
 * ... --rollback <run-id>
 * ```
 *
 * The harness home comes from `$DSH_HOME` as usual; `--home` overrides it for a
 * test or a build host. `--report <path>` also writes the dry-run report to that
 * file (the default dry run writes no file).
 */

import { writeFile } from 'node:fs/promises'
import {
  MemoryMigrationError,
  applyMemoryMigration,
  dryRunMemoryMigration,
  rollbackMemoryMigration,
} from '../src/migration.ts'

/** Parsed command line. */
interface CliOptions {
  home?: string
  workspaces: string[]
  apply?: string
  rollback?: string
  report?: string
}

/** One-line usage text. */
const USAGE = `Usage:
  migrate-global-memory.ts --workspace <dir> [--workspace <dir> ...] [--home <dir>] [--report <path>]
  migrate-global-memory.ts --workspace <dir> ... --apply <report-hash> [--home <dir>]
  migrate-global-memory.ts --rollback <run-id> [--home <dir>]`

/** Read one option's value from `--name value` or `--name=value`. */
function optionValue(args: readonly string[], index: number, name: string): { readonly value: string; readonly next: number } | undefined {
  const arg = args[index] as string
  if (arg === `--${name}`) {
    const value = args[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`)
    return { value, next: index + 2 }
  }
  if (arg.startsWith(`--${name}=`)) return { value: arg.slice(name.length + 3), next: index + 1 }
  return undefined
}

/** Parse the command line, refusing unknown flags. */
function parseArgs(args: readonly string[]): CliOptions {
  const options: CliOptions = { workspaces: [] }
  for (let index = 0; index < args.length;) {
    const arg = args[index] as string
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${USAGE}\n`)
      process.exit(0)
    }
    const workspace = optionValue(args, index, 'workspace')
    if (workspace !== undefined) {
      options.workspaces.push(workspace.value)
      index = workspace.next
      continue
    }
    const home = optionValue(args, index, 'home')
    if (home !== undefined) {
      options.home = home.value
      index = home.next
      continue
    }
    const apply = optionValue(args, index, 'apply')
    if (apply !== undefined) {
      options.apply = apply.value
      index = apply.next
      continue
    }
    const rollback = optionValue(args, index, 'rollback')
    if (rollback !== undefined) {
      options.rollback = rollback.value
      index = rollback.next
      continue
    }
    const report = optionValue(args, index, 'report')
    if (report !== undefined) {
      options.report = report.value
      index = report.next
      continue
    }
    throw new Error(`unknown argument ${JSON.stringify(arg)}\n${USAGE}`)
  }
  return options
}

/** Run the requested form and print its outcome. */
async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const home = options.home
  if (options.rollback !== undefined) {
    const result = await rollbackMemoryMigration({ ...home === undefined ? {} : { home }, runId: options.rollback })
    process.stdout.write(result.alreadyRolledBack
      ? `Run ${result.runId} was already rolled back.\n`
      : `Rolled back run ${result.runId}: restored ${String(result.restored.length)} file(s), removed ${String(result.removed.length)} created file(s).\n`
        + result.restored.map(path => `  restored: ${path}\n`).join('')
        + result.removed.map(path => `  removed: ${path}\n`).join(''))
    return
  }
  if (options.workspaces.length === 0) throw new Error(`at least one --workspace is required\n${USAGE}`)
  const workspaces = options.workspaces.map(directory => ({ directory }))
  const common = { ...home === undefined ? {} : { home }, workspaces }
  if (options.apply !== undefined) {
    const result = await applyMemoryMigration({ ...common, reportHash: options.apply })
    if (result.runId === '') {
      process.stdout.write(`Nothing to migrate or discard (${String(result.skipped)} entries already handled).\n`)
      return
    }
    process.stdout.write(
      `Applied run ${result.runId}: migrated ${String(result.migrated)}, discarded ${String(result.discarded)}, `
      + `skipped ${String(result.skipped)}. Backups: ${result.runDirectory}\n`,
    )
    process.stdout.write(result.changed.map(path => `  changed: ${path}\n`).join(''))
    return
  }
  const report = await dryRunMemoryMigration(common)
  if (options.report !== undefined) await writeFile(options.report, report.text, { encoding: 'utf8' })
  process.stdout.write(report.text)
}

main().catch((error: unknown) => {
  if (error instanceof MemoryMigrationError) {
    process.stderr.write(`${error.code}: ${error.message}\n`)
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  }
  process.exitCode = 1
})
