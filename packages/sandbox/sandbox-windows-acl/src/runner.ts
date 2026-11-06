/**
 * The windows-acl confinement runner: the argv-prefix wrapper the sandbox
 * seam spawns in place of the caller's command. It creates the
 * WRITE_RESTRICTED token with the workspace write-SID allowlist, spawns the
 * wrapped argv under it with the CALLER'S stdio inherited (bytes flow
 * straight through), mirrors the child's exit code, and revokes its temp
 * grant on exit (workspace ACEs stay standing as the reuse cache).
 *
 * Stable argv contract (the seam builds it; a native-exe replacement would
 * keep the same contract):
 *   [node, runner.js, '--workspace', <dir>, '--temp', <dir>,
 *    '--mode', <read-only|workspace-write>,
 *    ['--writable-root', <dir>..., '--exclude', <dir>...,
 *     '--temp-inside-writable'],
 *    ['--write-sid', <S-1-4-…>,
 *     '--temp-write-sid', <S-1-4-…>], '--', <argv...>]
 *
 * Modes:
 *  - workspace-write: the workspace and temp directories carry distinct
 *    capability-SID Write grants; other ACL-addressable writes are denied
 *    except for the documented Everyone and hard-link boundaries.
 *  - home-write (the seam's `workspace-write` plus `--writable-root`s):
 *    `--writable-root` adds the home and non-system drives to the writable
 *    set, and `--temp-inside-writable` declares that the private temp sits
 *    inside one of them (the home), where the enclosing grant already covers
 *    it. That declaration replaces the temp/workspace disjointness rule —
 *    which would otherwise reject the mode's own temp layout with "private
 *    temp directory must be disjoint from writable directories" on every
 *    command. Without it the disjointness rule stands unchanged.
 *  - read-only: no capability-SID grants; the restricting list carries no
 *    capability SID, so a standing grant ACE from an earlier
 *    workspace-write period stays inert. BOTH modes drop Authenticated Users
 *    (CIM unavailable — documented in README) and INTERACTIVE/LOCAL (the
 *    Public tree writes are denied); the two lists share the keep-alive group
 *    (logon SID, EVERYONE) and differ only by the capabilities.
 *
 * `--write-sid` + `--temp-write-sid`: the seam's grant contract — the
 * CALLER has already materialized distinct workspace and private-temp ACEs
 * and owns their revocation, so the runner neither grants nor revokes
 * (`manageDacls: false`). Both values are checked against their owning paths.
 * Without the pair (standalone/agentless use), workspace-write treats
 * `--temp` as a ROOT, creates a random private child directory, derives its
 * own temp SID, and removes that directory after the child exits. In both
 * flows the runner rewrites TMP/TEMP in its OWN environment to the private
 * directory before spawning; the child inherits that block (`lpEnvironment`
 * NULL; an explicit block through koffi trips ERROR_INVALID_PARAMETER in
 * CreateProcessAsUserW, verified empirically). Read-only leaves the ambient
 * temp entries untouched (writes there are denied anyway).
 *
 * Failure contract: every runner-side failure (bad args, missing
 * directories, token/grant/spawn errors) prints `windows-acl-run: <detail>`
 * to stderr and exits 127 — the seam's RUNNER_FAILURE_RULES matches that
 * signature. The child is NEVER spawned unrestricted.
 * @module @deepseek-ai/dsh-sandbox-windows-acl/runner
 */

import { SUBPROCESS_CONTROL_ENV, SUBPROCESS_CONTROL_FD } from '@deepseek-ai/dsh-subprocess/control'
import { closeSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { win32 } from './ffi.ts'
import { AclSandbox, assertTempRootOutsideWorkspace } from './index.ts'
import { tempWriteSid, workspaceWriteSid } from './workspace-sid.ts'

const RUNNER_SIGNATURE = 'windows-acl-run'
const RUNNER_FAILURE_EXIT = 127

class RunnerFailure extends Error {}

/** Print the runner-failure signature line and unwind. */
function fail(detail: string): never {
  process.stderr.write(`${RUNNER_SIGNATURE}: ${detail}\n`)
  throw new RunnerFailure(detail)
}

interface ParsedArgs {
  workspace: string
  temp: string
  mode: 'read-only' | 'workspace-write'
  writableRoots: string[]
  exclude: string[]
  tempInsideWritable: boolean
  writeSid: string | undefined
  tempWriteSid: string | undefined
  command: string
  args: string[]
}

function parseArgs(raw: string[]): ParsedArgs {
  let workspace: string | undefined
  let temp: string | undefined
  let mode: string | undefined
  const writableRoots: string[] = []
  const exclude: string[] = []
  let tempInsideWritable = false
  let writeSid: string | undefined
  let parsedTempWriteSid: string | undefined
  let index = 0
  for (; index < raw.length; index++) {
    const token = raw[index]
    if (token === '--') {
      index++
      break
    }
    if (token === '--temp-inside-writable') {
      tempInsideWritable = true
      continue
    }
    index++
    const value = raw[index]
    if (value === undefined) fail(`missing value after ${token}`)
    switch (token) {
      case '--workspace': workspace = value; break
      case '--temp': temp = value; break
      case '--mode': mode = value; break
      case '--write-sid': writeSid = value; break
      case '--writable-root': writableRoots.push(value); break
      case '--exclude': exclude.push(value); break
      case '--temp-write-sid': parsedTempWriteSid = value; break
      default: fail(`unknown argument: ${token}`)
    }
  }
  if (workspace === undefined) fail('missing --workspace')
  if (temp === undefined) fail('missing --temp')
  if (mode !== 'read-only' && mode !== 'workspace-write') fail(`unknown mode: ${String(mode)}`)
  const argv = raw.slice(index)
  const command = argv[0]
  if (command === undefined) fail('missing command after --')
  return {
    workspace, temp, mode, writableRoots, exclude, tempInsideWritable,
    writeSid, tempWriteSid: parsedTempWriteSid, command, args: argv.slice(1),
  }
}

function requireDirectory(label: string, path: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    fail(`${label} is not an existing directory: ${path}`)
  }
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2))
  // Both directories are validated in both modes: a provider bug that passes
  // a bogus root must fail loudly at the runner boundary, never mid-child.
  requireDirectory('--workspace', parsed.workspace)
  requireDirectory('--temp', parsed.temp)

  const writeRestricted = parsed.mode === 'workspace-write'
  const seamManaged = parsed.writeSid !== undefined || parsed.tempWriteSid !== undefined
  if (parsed.mode === 'read-only' && seamManaged) {
    fail('read-only does not accept --write-sid or --temp-write-sid')
  }
  if (writeRestricted && (parsed.writeSid === undefined) !== (parsed.tempWriteSid === undefined)) {
    fail(`${parsed.mode} requires --write-sid and --temp-write-sid together`)
  }
  if (writeRestricted) {
    // home-write nests its temp inside the granted home; the enclosing grant
    // already covers it, so the workspace-disjointness rule is the wrong one
    // there (the seam sets --temp-inside-writable). Elsewhere the invariant
    // stays: a temp under the workspace would inherit its capability.
    if (!parsed.tempInsideWritable) assertTempRootOutsideWorkspace(parsed.workspace, parsed.temp)
  }
  if (!writeRestricted && (parsed.writableRoots.length > 0 || parsed.exclude.length > 0 || parsed.tempInsideWritable)) {
    fail('--writable-root, --exclude and --temp-inside-writable require --mode workspace-write')
  }
  if (parsed.tempInsideWritable && parsed.writableRoots.length === 0) {
    fail('--temp-inside-writable requires at least one --writable-root to sit inside')
  }
  for (const root of parsed.writableRoots) requireDirectory('--writable-root', root)
  for (const path of parsed.exclude) requireDirectory('--exclude', path)

  const api = await win32()
  // Ignore this process's own CTRL+C: the confined child (same console) keeps
  // handling its own; the runner must survive to revoke grants and mirror the
  // child's exit code.
  if (api.setConsoleCtrlHandler(null, 1) === 0) {
    fail(`SetConsoleCtrlHandler failed (Win32 ${api.getLastError()})`)
  }

  let ownedTempDir: string | undefined
  let sandbox: AclSandbox | undefined
  let initialized = false
  try {
    let privateTempDir: string | null = null
    let writeSid: string | undefined
    let privateTempSid: string | undefined
    if (writeRestricted) {
      writeSid = workspaceWriteSid(parsed.workspace)
      if (seamManaged) {
        if (parsed.writeSid !== writeSid) fail('--write-sid does not match --workspace')
        privateTempDir = parsed.temp
        privateTempSid = tempWriteSid(privateTempDir)
        if (parsed.tempWriteSid !== privateTempSid) fail('--temp-write-sid does not match --temp')
      } else {
        ownedTempDir = mkdtempSync(join(parsed.temp, 'dsh-'))
        privateTempDir = ownedTempDir
        privateTempSid = tempWriteSid(privateTempDir)
      }
    }
    sandbox = new AclSandbox({
      writableDirs: writeRestricted ? [parsed.workspace, ...parsed.writableRoots] : [],
      ...parsed.exclude.length === 0 ? {} : { excludedDirs: parsed.exclude },
      tempDir: privateTempDir,
      mode: parsed.mode,
      ...parsed.tempInsideWritable ? { allowTempInsideWritable: true } : {},
      ...writeSid === undefined ? {} : { writeSid },
      ...privateTempSid === undefined ? {} : { tempWriteSid: privateTempSid },
      manageDacls: !seamManaged,
    })
    await sandbox.init()
    initialized = true

    if (privateTempDir !== null) {
      if (api.setEnvironmentVariableW('TMP', privateTempDir) === 0) {
        fail(`SetEnvironmentVariableW TMP failed (Win32 ${api.getLastError()})`)
      }
      if (api.setEnvironmentVariableW('TEMP', privateTempDir) === 0) {
        fail(`SetEnvironmentVariableW TEMP failed (Win32 ${api.getLastError()})`)
      }
    }

    const child = sandbox.spawn({
      command: parsed.command,
      args: parsed.args,
      stdio: 'inherit',
      ...process.env[SUBPROCESS_CONTROL_ENV] === 'pipe' ? { controlFileDescriptor: SUBPROCESS_CONTROL_FD } : {},
    })
    if (process.env[SUBPROCESS_CONTROL_ENV] === 'pipe') closeSync(SUBPROCESS_CONTROL_FD)
    const result = await child.wait()
    return result.exitCode
  } finally {
    // Cleanup failures must not mask the child's exit code: report and keep going.
    if (initialized) {
      try {
        sandbox?.dispose()
      } catch (error) {
        process.stderr.write(`${RUNNER_SIGNATURE}: cleanup: ${error instanceof Error ? error.message : String(error)}\n`)
      }
    }
    if (ownedTempDir !== undefined) {
      try {
        rmSync(ownedTempDir, { recursive: true, force: true })
      } catch (error) {
        process.stderr.write(`${RUNNER_SIGNATURE}: cleanup: ${error instanceof Error ? error.message : String(error)}\n`)
      }
    }
  }
}

main().then(
  (exitCode) => {
    // Exit-code mirroring is full-width on Windows, verified empirically on
    // this machine (Windows 11 build 26200, Node 24): a child that exits
    // with the NTSTATUS 0xC0000005 (STATUS_ACCESS_VIOLATION) is read back
    // by GetExitCodeProcess as the uint32 3221225477, and after
    // process.exitCode = 3221225477 the parent observes exactly
    // 3221225477 (spawnSync status). PowerShell's $LASTEXITCODE and cmd
    // print the signed view (-1073741819), but no truncation or masking
    // happens anywhere in the chain — the mirror contract holds for the
    // full 32-bit range, so no re-mapping is needed.
    process.exitCode = exitCode
  },
  (error: unknown) => {
    if (!(error instanceof RunnerFailure)) {
      process.stderr.write(`${RUNNER_SIGNATURE}: ${error instanceof Error ? error.message : String(error)}\n`)
    }
    process.exitCode = RUNNER_FAILURE_EXIT
  },
)
