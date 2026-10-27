/**
 * Run every Jira package's Node test suite, one process per package.
 *
 * `test:jira:node` used to be `pnpm -r --filter './packages/jira/*' test`. On Windows a package
 * script is executed by cmd.exe, which keeps the single quotes: pnpm received a filter no project
 * matched, printed `Scope: 0 of 406 workspace projects` and **exited 0** — a green run that tested
 * nothing (DH-308). This runner discovers the packages itself (no shell to lose the pattern), runs
 * each `test` script in its own process, reports the selected packages and their test counts, and
 * fails when the selection or the executed-test total is empty.
 *
 * The per-package split is also the isolation boundary: a suite that starts its own git fixture
 * cannot collide with the next package's fixtures, and a failure is attributed to one package.
 */

import { spawn } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The repository root, derived from this script's location. */
const REPO = fileURLToPath(new URL('..', import.meta.url))

/** The pnpm CLI entry, spawned through Node so Windows needs no `.cmd` shell quoting. */
const PNPM = join(REPO, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')

/** The group of packages whose Node suites this runner owns. */
const GROUP = join(REPO, 'packages', 'jira')

/** One discovered suite. */
interface Suite {
  readonly name: string
  readonly dir: string
}

/** The package name and test script of one directory, when it declares both. */
const suiteIn = async (dir: string): Promise<Suite | undefined> => {
  let text: string
  try {
    text = await readFile(join(dir, 'package.json'), 'utf8')
  } catch {
    return undefined
  }
  const manifest = JSON.parse(text) as { name?: unknown; scripts?: Record<string, unknown> }
  if (typeof manifest.name !== 'string') return undefined
  if (typeof manifest.scripts?.['test'] !== 'string') return undefined
  return { name: manifest.name, dir }
}

/** One test run's captured output and exit code. */
interface RunResult {
  readonly code: number
  readonly output: string
}

/** Run one command with piped output; no shell, so paths and globs reach the child verbatim. */
const run = (command: string, args: readonly string[], cwd: string): Promise<RunResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { output += chunk })
    child.stderr.on('data', (chunk: string) => { output += chunk })
    child.on('error', reject)
    child.on('close', (code) => { resolve({ code: code ?? 1, output }) })
  })

/** The number of tests Node's own reporter says it ran, or undefined when it said nothing. */
const testCount = (output: string): number | undefined => {
  const match = /^(?:ℹ|#) tests (\d+)\s*$/mu.exec(output)
  return match === null ? undefined : Number.parseInt(match[1] ?? '', 10)
}

const fail = (message: string): never => {
  console.error(`jira-node: ${message}`)
  process.exit(1)
}

/** Discover, run and report; exits non-zero on an empty selection, an empty run or a failure. */
const main = async (): Promise<void> => {
  const entries = (await readdir(GROUP, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
  const scanned = await Promise.all(entries.map(async name => ({ name, suite: await suiteIn(join(GROUP, name)) })))
  const suites = scanned.filter((entry): entry is { name: string; suite: Suite } => entry.suite !== undefined)
  const withoutTests = scanned.filter(entry => entry.suite === undefined).map(entry => entry.name)

  if (suites.length === 0) fail(`no package under packages/jira declares a "test" script (scanned ${String(entries.length)} directory(ies))`)
  console.log(`jira-node: ${String(suites.length)} package(s) selected: ${suites.map(entry => entry.suite.name).join(', ')}`)
  for (const name of withoutTests) console.log(`jira-node: ${name} has no test script (not selected)`)

  let total = 0
  for (const { suite } of suites) {
    const result = await run(process.execPath, [PNPM, '--dir', suite.dir, 'test'], suite.dir)
    const count = testCount(result.output)
    if (result.code !== 0) {
      console.error(`\njira-node: ${suite.name} failed (exit ${String(result.code)})`)
      console.error(result.output)
      process.exit(1)
    }
    if (count === undefined) {
      console.error(`\njira-node: ${suite.name} reported no test count — a green exit that proves nothing`)
      console.error(result.output)
      process.exit(1)
    }
    if (count === 0) fail(`${suite.name} ran 0 tests`)
    total += count
    console.log(`jira-node: ${suite.name}: ${String(count)} tests`)
  }

  if (total === 0) fail('the selected packages ran 0 tests in total')
  console.log(`jira-node: ${String(total)} tests passed in ${String(suites.length)} package(s)`)
}

await main()
