/**
 * Linux-only real-kernel probe for the two `sandbox-local` rungs.
 *
 * The existing `bwrap.e2e.ts` / `landlock.e2e.ts` each prove one rung; this
 * file runs the SAME matrix through both rungs so their observable differences
 * are recorded side by side: `$HOME` writes under workspace-write, `/tmp`
 * (workspace-write's private tmpfs vs Landlock's host grant vs home-write's
 * absent grant), `TMPDIR`, symlink escapes, `/proc/self/root`, `/dev`, and the
 * Landlock-only `excludePaths` refusal. It also proves the real ladder
 * fallback (a failing `bwrap` probe selects the launcher) and the
 * consumer-level `danger-full-access` bypass.
 *
 * It talks to `LocalSandboxProvider.confine()` directly: product paths refuse
 * `home-write` while it is disabled (DH-902), but the preserved Linux profile
 * implementation still needs this evidence for a future re-enable.
 *
 * Run (Linux, after `pnpm --dir native/system run build:ts && build:native`):
 *   node node_modules/vitest/vitest.mjs run --config vitest.e2e.config.ts \
 *     packages/sandbox/sandbox-local/tests/linux-probe.e2e.ts
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LAUNCHER_FAILURE_EXIT, launcherPath, probe as landlockProbeOf } from '@deepseek-ai/node-addon-system/landlock-run'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { bwrapProfileArgs } from '@deepseek-ai/dsh-sandbox-local/src/profiles.ts'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { SandboxEnforcement, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'

type Rung = 'bwrap' | 'landlock'

interface Observation {
  readonly rung: Rung
  readonly mode: string
  readonly scenario: string
  readonly status: number | null
  readonly hostEffect: boolean
  readonly detail: string
}

interface RunResult {
  readonly confined: boolean
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
  readonly argv: readonly string[]
  readonly enforcement?: SandboxEnforcement
  readonly denialSignatures: readonly string[]
  readonly error?: unknown
}

const onLinux = process.platform === 'linux'

const bwrapProbeRun = spawnSync(
  'bwrap',
  [...bwrapProfileArgs({ mode: 'read-only', workspaceRoot: '/' }), '--', 'true'],
  { timeout: 5_000, stdio: 'ignore' },
)
const bwrapUsable = onLinux && bwrapProbeRun.status === 0

function safeLauncherProbe(): { usable: boolean; report: string } {
  if (!onLinux) return { usable: false, report: 'not linux' }
  try {
    const result = spawnSync(launcherPath(), ['--probe'], { timeout: 5_000, encoding: 'utf8' })
    return { usable: result.status === 0, report: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() }
  } catch (error) {
    return { usable: false, report: String(error) }
  }
}

const landlock = safeLauncherProbe()

const rungs: readonly Rung[] = [
  ...bwrapUsable ? ['bwrap'] as const : [],
  ...landlock.usable ? ['landlock'] as const : [],
]

const observations: Observation[] = []
const dirs: string[] = []
let ctx: Context | undefined

function record(rung: Rung, mode: string, scenario: string, result: RunResult, hostEffect: boolean, detail: string): void {
  observations.push({ rung, mode, scenario, status: result.status, hostEffect, detail })
}

async function tempDir(base: string): Promise<string> {
  const dir = realpathSync.native(await mkdtemp(join(base, 'dsh-linux-probe-')))
  dirs.push(dir)
  return dir
}

async function provider(rung: Rung): Promise<LocalSandboxProvider> {
  await ctx?.fiber.dispose()
  ctx = new Context()
  await ctx.plugin(LocalSandboxProvider, {})
  const sandbox = ctx.sandbox as LocalSandboxProvider
  if (rung === 'landlock') sandbox.internals = { probeBwrap: () => false }
  return sandbox
}

function quote(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`
}

async function confineAndRun(
  sandbox: LocalSandboxProvider,
  command: string,
  policy: SandboxPolicy,
): Promise<RunResult> {
  try {
    const confined = await sandbox.confine(['bash', '-c', command], policy)
    const result = spawnSync(confined.argv[0] as string, confined.argv.slice(1), {
      timeout: 30_000,
      encoding: 'utf8',
    })
    return {
      confined: true,
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      argv: confined.argv,
      enforcement: confined.enforcement,
      denialSignatures: confined.denialSignatures,
    }
  } catch (error) {
    return {
      confined: false,
      status: null,
      stdout: '',
      stderr: String(error),
      argv: [],
      denialSignatures: [],
      error,
    }
  }
}

/** Write `content` to `target` through the sandbox; `exists` reports the host-visible result. */
async function writeFileThrough(
  sandbox: LocalSandboxProvider,
  target: string,
  policy: SandboxPolicy,
  content = 'probe',
): Promise<RunResult & { exists: boolean }> {
  const result = await confineAndRun(sandbox, `printf '${content}' > ${quote(target)}`, policy)
  return { ...result, exists: existsSync(target) }
}

function readIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return undefined
  }
}

function hostPidNamespace(): string {
  try {
    return readlinkSync('/proc/self/ns/pid')
  } catch {
    return 'unknown'
  }
}

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

describe.skipIf(!onLinux || rungs.length === 0)('linux sandbox probe (bwrap + Landlock)', () => {
  it('records the environment fingerprint', () => {
    const facts = {
      platform: process.platform,
      arch: process.arch,
      kernel: process.release.name,
      release: readIfExists('/proc/sys/kernel/osrelease') ?? 'unknown',
      bwrapUsable,
      bwrapVersion: spawnSync('bwrap', ['--version'], { encoding: 'utf8' }).stdout?.trim() ?? 'unknown',
      landlockUsable: landlock.usable,
      landlockProbe: landlock.report,
      landlockEnforcement: safeEnforcement(),
      landlockAbi: readIfExists('/sys/kernel/security/landlock/abi_version') ?? 'securityfs not mounted',
      unprivilegedUsernsClone: readIfExists('/proc/sys/kernel/unprivileged_userns_clone') ?? 'absent',
      apparmorRestrictUnprivilegedUserns: readIfExists('/proc/sys/kernel/apparmor_restrict_unprivileged_userns') ?? 'absent',
      home: homedir(),
      temp: tmpdir(),
      uid: process.getuid?.(),
      rungs,
    }
    console.log(`LINUX_SANDBOX_ENV=${JSON.stringify(facts)}`)
    expect(facts.platform).toBe('linux')
    expect(rungs.length).toBeGreaterThan(0)
  })

  it('read-only: workspace/$HOME//tmp writes are denied and /dev/null stays writable', async () => {
    for (const rung of rungs) {
      const sandbox = await provider(rung)
      const home = await tempDir(homedir())
      const workdir = await tempDir(homedir())
      const policy: SandboxPolicy = { mode: 'read-only', workspaceRoot: workdir }

      const workspaceWrite = await writeFileThrough(sandbox, join(workdir, 'denied.txt'), policy)
      const homeWrite = await writeFileThrough(sandbox, join(home, 'denied.txt'), policy)
      const tmpTarget = join(tmpdir(), `dsh-linux-probe-ro-${rung}-${process.pid}.txt`)
      const tmpWrite = await writeFileThrough(sandbox, tmpTarget, policy)
      const shmTarget = `/dev/shm/dsh-linux-probe-ro-${rung}-${process.pid}.txt`
      const shmWrite = await writeFileThrough(sandbox, shmTarget, policy)
      const devNull = await confineAndRun(sandbox, 'printf ok > /dev/null', policy)
      const devStderr = await confineAndRun(sandbox, 'printf ok > /dev/stderr', policy)

      record(rung, 'read-only', 'workspace write', workspaceWrite, workspaceWrite.exists, workspaceWrite.stderr.trim())
      record(rung, 'read-only', '$HOME write', homeWrite, homeWrite.exists, homeWrite.stderr.trim())
      record(rung, 'read-only', '/tmp write', tmpWrite, tmpWrite.exists, tmpWrite.stderr.trim())
      record(rung, 'read-only', '/dev/shm write', shmWrite, shmWrite.exists, shmWrite.stderr.trim())
      record(rung, 'read-only', '/dev/null write', devNull, false, devNull.stderr.trim())
      record(rung, 'read-only', '/dev/stderr write', devStderr, false, devStderr.stderr.trim())

      expect(workspaceWrite.status, `${rung}: ${workspaceWrite.stderr}`).not.toBe(0)
      expect(workspaceWrite.exists).toBe(false)
      expect(homeWrite.status, `${rung}: ${homeWrite.stderr}`).not.toBe(0)
      expect(homeWrite.exists).toBe(false)
      expect(tmpWrite.status, `${rung}: ${tmpWrite.stderr}`).not.toBe(0)
      expect(tmpWrite.exists).toBe(false)
      expect(shmWrite.exists).toBe(false)
      expect(devNull.status, `${rung}: ${devNull.stderr}`).toBe(0)
    }
  })

  it('workspace-write: workspace allowed, $HOME denied, /tmp and /dev/shm follow the rung', async () => {
    for (const rung of rungs) {
      const sandbox = await provider(rung)
      const home = await tempDir(homedir())
      const workdir = await tempDir(homedir())
      const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: workdir }

      const workspaceWrite = await writeFileThrough(sandbox, join(workdir, 'allowed.txt'), policy)
      const homeWrite = await writeFileThrough(sandbox, join(home, 'denied.txt'), policy)
      const tmpTarget = join(tmpdir(), `dsh-linux-probe-ww-${rung}-${process.pid}.txt`)
      const tmpWrite = await writeFileThrough(sandbox, tmpTarget, policy)
      const shmTarget = `/dev/shm/dsh-linux-probe-${rung}-${process.pid}.txt`
      const shmWrite = await writeFileThrough(sandbox, shmTarget, policy)

      record(rung, 'workspace-write', 'workspace write', workspaceWrite, workspaceWrite.exists, workspaceWrite.stderr.trim())
      record(rung, 'workspace-write', '$HOME write', homeWrite, homeWrite.exists, homeWrite.stderr.trim())
      record(rung, 'workspace-write', '/tmp write', tmpWrite, tmpWrite.exists, 'bwrap=ephemeral; landlock=host')
      record(rung, 'workspace-write', '/dev/shm write', shmWrite, shmWrite.exists, shmWrite.stderr.trim())

      expect(workspaceWrite.status, `${rung}: ${workspaceWrite.stderr}`).toBe(0)
      expect(workspaceWrite.exists).toBe(true)
      expect(homeWrite.status, `${rung}: ${homeWrite.stderr}`).not.toBe(0)
      expect(homeWrite.exists).toBe(false)
      expect(tmpWrite.status, `${rung}: ${tmpWrite.stderr}`).toBe(0)
      // bwrap swaps in a private tmpfs; Landlock grants the host /tmp. Both
      // write, but only Landlock leaves a host-visible file.
      expect(tmpWrite.exists).toBe(rung === 'landlock')
      // The host /dev/shm must never gain the file on either rung.
      expect(shmWrite.exists).toBe(false)
    }
  })

  it('workspace-write: a symlink into $HOME and /proc/self/root cannot escape', async () => {
    for (const rung of rungs) {
      const sandbox = await provider(rung)
      const home = await tempDir(homedir())
      const workdir = await tempDir(homedir())
      const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: workdir }

      const link = join(workdir, 'home-link')
      symlinkSync(home, link)
      const symlinkWrite = await writeFileThrough(sandbox, join(link, 'escaped.txt'), policy)
      const procResult = await confineAndRun(
        sandbox,
        `printf 'escaped' > /proc/self/root${quote(join(home, 'proc-escaped.txt'))}`,
        policy,
      )
      const pidNamespace = await confineAndRun(sandbox, 'readlink /proc/self/ns/pid', policy)

      record(rung, 'workspace-write', 'symlink into $HOME', symlinkWrite, symlinkWrite.exists, symlinkWrite.stderr.trim())
      record(rung, 'workspace-write', '/proc/self/root into $HOME', procResult, existsSync(join(home, 'proc-escaped.txt')), procResult.stderr.trim())
      record(rung, 'workspace-write', 'PID namespace', pidNamespace, false, pidNamespace.stdout.trim())

      expect(symlinkWrite.status, `${rung}: ${symlinkWrite.stderr}`).not.toBe(0)
      expect(symlinkWrite.exists).toBe(false)
      expect(procResult.status, `${rung}: ${procResult.stderr}`).not.toBe(0)
      expect(existsSync(join(home, 'proc-escaped.txt'))).toBe(false)
      expect(pidNamespace.status).toBe(0)
      expect(pidNamespace.stdout.trim()).not.toBe('')
      if (rung === 'bwrap') expect(pidNamespace.stdout.trim()).not.toBe(hostPidNamespace())
      else expect(pidNamespace.stdout.trim()).toBe(hostPidNamespace())
    }
  })

  it('home-write: the whole home (including credential dirs) is writable and /etc is not', async () => {
    for (const rung of rungs) {
      const sandbox = await provider(rung)
      const home = await tempDir(homedir())
      const workdir = await tempDir(homedir())
      const outside = await tempDir(homedir())
      mkdirSync(join(home, '.ssh'))
      mkdirSync(join(home, '.config'))
      const policy: SandboxPolicy = { mode: 'home-write', workspaceRoot: workdir, homeWriteRoots: [home] }

      const homeWrite = await writeFileThrough(sandbox, join(home, 'allowed.txt'), policy)
      const sshWrite = await writeFileThrough(sandbox, join(home, '.ssh', 'id_probe'), policy)
      const configWrite = await writeFileThrough(sandbox, join(home, '.config', 'dsh-probe'), policy)
      const workspaceWrite = await writeFileThrough(sandbox, join(workdir, 'allowed.txt'), policy)
      const outsideWrite = await writeFileThrough(sandbox, join(outside, 'denied.txt'), policy)
      const etcWrite = await writeFileThrough(sandbox, join('/etc', `dsh-linux-probe-${rung}-${process.pid}`), policy)
      const tmpTarget = join(tmpdir(), `dsh-linux-probe-hw-${rung}-${process.pid}.txt`)
      const tmpWrite = await writeFileThrough(sandbox, tmpTarget, policy)

      record(rung, 'home-write', '$HOME write', homeWrite, homeWrite.exists, homeWrite.stderr.trim())
      record(rung, 'home-write', '$HOME/.ssh write', sshWrite, sshWrite.exists, sshWrite.stderr.trim())
      record(rung, 'home-write', '$HOME/.config write', configWrite, configWrite.exists, configWrite.stderr.trim())
      record(rung, 'home-write', 'workspace write', workspaceWrite, workspaceWrite.exists, workspaceWrite.stderr.trim())
      record(rung, 'home-write', 'outside home write', outsideWrite, outsideWrite.exists, outsideWrite.stderr.trim())
      record(rung, 'home-write', '/etc write', etcWrite, etcWrite.exists, etcWrite.stderr.trim())
      record(rung, 'home-write', '/tmp write (default temp roots)', tmpWrite, tmpWrite.exists, tmpWrite.stderr.trim())

      expect(homeWrite.status, `${rung}: ${homeWrite.stderr}`).toBe(0)
      expect(sshWrite.status, `${rung}: ${sshWrite.stderr}`).toBe(0)
      expect(configWrite.status, `${rung}: ${configWrite.stderr}`).toBe(0)
      expect(workspaceWrite.status, `${rung}: ${workspaceWrite.stderr}`).toBe(0)
      expect(outsideWrite.status, `${rung}: ${outsideWrite.stderr}`).not.toBe(0)
      expect(outsideWrite.exists).toBe(false)
      expect(etcWrite.status, `${rung}: ${etcWrite.stderr}`).not.toBe(0)
      expect(etcWrite.exists).toBe(false)
      // homeWriteTempRoots defaults to empty: unlike workspace-write, /tmp is
      // NOT writable under home-write on either rung.
      expect(tmpWrite.status, `${rung}: ${tmpWrite.stderr}`).not.toBe(0)
      expect(tmpWrite.exists).toBe(false)
    }
  })

  it('home-write: explicit temp roots and TMPDIR decide whether mktemp works', async () => {
    for (const rung of rungs) {
      const sandbox = await provider(rung)
      const home = await tempDir(homedir())
      const workdir = await tempDir(homedir())
      const temp = await tempDir(tmpdir())
      const noTempPolicy: SandboxPolicy = { mode: 'home-write', workspaceRoot: workdir, homeWriteRoots: [home] }
      const tempPolicy: SandboxPolicy = { mode: 'home-write', workspaceRoot: workdir, homeWriteRoots: [home], homeWriteTempRoots: [temp] }

      const tempWrite = await writeFileThrough(sandbox, join(temp, 'allowed.txt'), tempPolicy)
      const defaultTmpdir = await confineAndRun(sandbox, 'TMPDIR=/tmp mktemp', noTempPolicy)
      const explicitTmpdir = await confineAndRun(sandbox, `TMPDIR=${quote(temp)} mktemp`, tempPolicy)

      record(rung, 'home-write', 'explicit homeWriteTempRoots write', tempWrite, tempWrite.exists, tempWrite.stderr.trim())
      record(rung, 'home-write', 'TMPDIR=/tmp mktemp (default temp roots)', defaultTmpdir, false, `status=${String(defaultTmpdir.status)}`)
      record(rung, 'home-write', 'TMPDIR=<temp root> mktemp', explicitTmpdir, false, `status=${String(explicitTmpdir.status)}`)

      expect(tempWrite.status, `${rung}: ${tempWrite.stderr}`).toBe(0)
      expect(tempWrite.exists).toBe(true)
      expect(defaultTmpdir.status, `${rung}: mktemp under /tmp must fail`).not.toBe(0)
      expect(explicitTmpdir.status, `${rung}: ${explicitTmpdir.stderr}`).toBe(0)
    }
  })

  it('home-write: bwrap enforces excludePaths, Landlock refuses the whole policy', async () => {
    for (const rung of rungs) {
      const sandbox = await provider(rung)
      const home = await tempDir(homedir())
      const workdir = await tempDir(homedir())
      const secret = join(home, '.ssh')
      mkdirSync(secret)
      const policy: SandboxPolicy = {
        mode: 'home-write',
        workspaceRoot: workdir,
        homeWriteRoots: [home],
        excludePaths: [secret],
      }

      const excluded = await writeFileThrough(sandbox, join(secret, 'id_probe'), policy)
      const allowed = await writeFileThrough(sandbox, join(home, 'allowed.txt'), policy)

      record(rung, 'home-write+exclude', 'excluded path write', excluded, excluded.exists, excluded.confined ? excluded.stderr.trim() : String(excluded.error))
      record(rung, 'home-write+exclude', 'non-excluded home write', allowed, allowed.exists, allowed.confined ? allowed.stderr.trim() : String(allowed.error))

      if (rung === 'bwrap') {
        expect(excluded.status, `bwrap: ${excluded.stderr}`).not.toBe(0)
        expect(excluded.exists).toBe(false)
        expect(allowed.status, `bwrap: ${allowed.stderr}`).toBe(0)
        expect(allowed.exists).toBe(true)
      } else {
        // Landlock's allow-list cannot express a deny hole inside a grant.
        expect(excluded.confined).toBe(false)
        expect(String(excluded.error)).toMatch(/cannot express excludePaths/u)
      }
    }
  })

  it('records the host TMPDIR grant difference under workspace-write (known gap)', async () => {
    // `writableRoots()` (Seatbelt + the in-process fs fence) grants
    // `os.tmpdir()`, so a host `TMPDIR` outside /tmp is writable there. bwrap
    // hardcodes an ephemeral `/tmp` mount and Landlock hardcodes `/tmp`; neither
    // grants the host temp dir, so a command that honours `TMPDIR` fails.
    for (const rung of rungs) {
      const custom = await tempDir(homedir())
      const workdir = await tempDir(homedir())
      const previous = process.env.TMPDIR
      process.env.TMPDIR = custom
      try {
        const sandbox = await provider(rung)
        const result = await confineAndRun(sandbox, 'f=$(mktemp) && printf ok > "$f"', { mode: 'workspace-write', workspaceRoot: workdir })
        record(rung, 'workspace-write', 'host TMPDIR outside /tmp (mktemp)', result, false, `TMPDIR=${custom}`)
        console.log(`TMPDIR_PROBE ${rung} status=${String(result.status)} TMPDIR=${custom}`)
      } finally {
        if (previous === undefined) delete process.env.TMPDIR
        else process.env.TMPDIR = previous
      }
    }
  })

  it('falls back to Landlock when the real bwrap probe fails', async () => {
    if (!landlock.usable) return
    const workdir = await tempDir(homedir())
    const fakeBin = await tempDir(homedir())
    const fakeBwrap = join(fakeBin, 'bwrap')
    writeFileSync(fakeBwrap, '#!/bin/sh\nexit 1\n', { mode: 0o755 })

    const previousPath = process.env.PATH
    process.env.PATH = `${fakeBin}:${previousPath ?? ''}`
    try {
      const sandbox = await provider('bwrap')
      const confined = await sandbox.confine(['true'], { mode: 'read-only', workspaceRoot: workdir })
      const expected = landlockProbeOf(launcherPath())
      record('landlock', 'read-only', 'real fallback selection', {
        confined: true, status: 0, stdout: '', stderr: '', argv: confined.argv,
        enforcement: confined.enforcement, denialSignatures: confined.denialSignatures,
      }, false, confined.argv[0] ?? '')
      expect(confined.argv[0]).toBe(launcherPath())
      expect(confined.enforcement).toBe(expected)
      expect(confined.denialSignatures).toEqual(['permission denied'])
    } finally {
      process.env.PATH = previousPath
    }
  })

  it('danger-full-access runs unconfined through the shell consumer', async () => {
    const home = await tempDir(homedir())
    const workdir = await tempDir(homedir())
    const consumerCtx = new Context()
    try {
      await consumerCtx.plugin(LocalSandboxProvider, {})
      await consumerCtx.plugin(SessionProjectionRegistry)
      await consumerCtx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: workdir })
      await consumerCtx.plugin(LocalSubprocessRuntime)
      await consumerCtx.plugin(SandboxBashExecutor, { cwd: workdir, timeoutMs: 30_000 })
      const shell = consumerCtx.shell as SandboxBashExecutor
      const target = join(home, 'danger.txt')
      const result = await (await shell.execute(shell.resolve({ command: `printf 'danger' > ${quote(target)}` }))).result()
      record('bwrap', 'danger-full-access', 'consumer bypass write', {
        confined: false, status: result.exitCode, stdout: '', stderr: '', argv: [], denialSignatures: [],
      }, existsSync(target), JSON.stringify(result.sandbox))
      expect(result.exitCode).toBe(0)
      expect(existsSync(target)).toBe(true)
      expect(result.sandbox).toMatchObject({ mode: 'danger-full-access' })
    } finally {
      await consumerCtx.fiber.dispose()
    }
  })

  it('landlock-run CLI contract: probe report and 125 usage failure', () => {
    if (!landlock.usable) return
    const probe = spawnSync(launcherPath(), ['--probe'], { encoding: 'utf8' })
    expect(probe.status).toBe(0)
    expect(probe.stdout).toMatch(/landlock: (fully|partially) enforced/u)
    const usage = spawnSync(launcherPath(), ['--probe', '--ro', '/'], { encoding: 'utf8' })
    expect(usage.status).toBe(LAUNCHER_FAILURE_EXIT)
    expect(usage.stderr).toContain('landlock-run: ')
    console.log(`LANDLOCK_PROBE=${probe.stdout.trim()} exit=${String(probe.status)}`)
    console.log(`LANDLOCK_USAGE_FAILURE=${JSON.stringify({ status: usage.status, stderr: usage.stderr.trim() })}`)
  })

  it('prints the collected observation report', () => {
    console.log(`LINUX_SANDBOX_REPORT=${JSON.stringify({ rungs, landlockEnforcement: safeEnforcement(), observations })}`)
    expect(observations.length).toBeGreaterThan(0)
  })
})

function safeEnforcement(): string {
  try {
    return landlockProbeOf(launcherPath())
  } catch {
    return 'unusable'
  }
}
