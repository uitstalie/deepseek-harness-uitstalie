/**
 * core/hooks — installing the commit binding into a repository (decision 67).
 *
 * The hook is a **thin Node shim**: it works on Windows and Linux without a shell, it cannot drift
 * from the validator because it calls the same CLI the human would, and the store root is resolved
 * by that CLI (config / `JIRA_ROOT`), never hard-coded here.
 *
 * Two rules make it safe to install into a repository somebody already uses:
 *   - an existing hook is **renamed `*.jira-backup` and chained**, not overwritten;
 *   - the backup runs **first**, so a hook that rewrites the message does so before we validate it.
 *
 * **Why this file keeps its own `node:fs` calls** (decision 180): it operates on `.git/hooks/*`,
 * which is the git domain, not the store's document tree — the writes are hook shims (with `chmod`
 * and `copyFile`, which the io boundary does not own), so it sits next to `git.ts` as part of the
 * git boundary rather than pretending to be pure.
 */

import { chmod, copyFile, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { type GitRunner, runGit } from './git.ts'

import { type JiraError, ioFailed } from './errors.ts'
import { type Result, err, ok } from './result.ts'
import { system } from './system/index.ts'

/**
 * The two git hooks that bind a commit to an issue: `commit-msg` validates the message,
 * `prepare-commit-msg` prefixes the branch's key.
 */
export const HOOK_KINDS = ['commit-msg', 'prepare-commit-msg'] as const
/** One of the hook kinds this package installs. */
export type HookKind = (typeof HOOK_KINDS)[number]

/**
 * The name an existing hook is preserved under before our shim replaces it.
 * @param kind - the hook being preserved.
 * @returns the `.jira-backup` name in the hooks directory.
 */
export const backupNameOf = (kind: HookKind): string => `${kind}.jira-backup`

/**
 * The hooks directory of a repository.
 * @param repoRoot - the repository root.
 * @returns the absolute path of `.git/hooks`.
 */
export const hooksDirectory = (repoRoot: string): string => join(repoRoot, '.git', 'hooks')

/** What `jira hooks status` reports for one hook. */
export type HookState = Readonly<{
  kind: HookKind
  installed: boolean
  /** Somebody else's hook, preserved. */
  backup: boolean
}>

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Report what each hook currently is: our shim, somebody else's preserved hook, or absent.
 * @param repoRoot - the repository root.
 * @returns one state per hook kind.
 */
export const hookStatus = async (repoRoot: string): Promise<readonly HookState[]> => {
  const directory = hooksDirectory(repoRoot)
  const states: HookState[] = []
  for (const kind of HOOK_KINDS) {
    const ours = await exists(join(directory, kind))
    const backup = await exists(join(directory, backupNameOf(kind)))
    // "Installed" means our shim is there; a repository with no hook at all reports false.
    const current = ours ? await readFile(join(directory, kind), 'utf8') : ''
    states.push(Object.freeze({
      kind,
      installed: current.includes(SHIM_MARKER),
      backup,
    }))
  }
  return Object.freeze(states)
}

/**
 * The line every generated shim carries, which is how status and re-installation recognize our
 * own hook rather than somebody else's.
 */
export const SHIM_MARKER = 'dsh-jira hook shim'

/**
 * The POSIX shell git itself would use to run a hook.
 *
 * Git for Windows keeps `sh.exe` beside itself and does **not** put it on the PATH; the `bash.exe`
 * that *is* on the PATH there is usually WSL, which cannot run a Windows-path script. So the shell is
 * resolved once, at install time, and embedded in the shim — a preserved `#!/bin/sh` hook then runs
 * even on a machine whose PATH says nothing about shells.
 * @param root - the repository root.
 * @param run - the git runner to use, injectable for tests.
 * @returns the shell to embed in a shim, or undefined when none can be found on Windows.
 */
export const resolveGitShell = async (root: string, run: GitRunner = runGit): Promise<string | undefined> => {
  if (!system.isWindows) return 'sh'
  const execPath = await run(root, ['--exec-path'])
  if (execPath.code === 0) {
    let directory = execPath.stdout.trim()
    // `mingw64/libexec/git-core` → the Git root is three levels up; `bin/sh.exe` sits there.
    for (let up = 1; up <= 4; up += 1) {
      directory = dirname(directory)
      for (const candidate of [join(directory, 'bin', 'sh.exe'), join(directory, 'usr', 'bin', 'sh.exe')]) {
        if (await exists(candidate)) return candidate
      }
    }
  }
  return undefined
}

/**
 * The shim's source.
 *
 * `require` (not `import`) because git runs the hook file with no extension, so Node loads it as
 * CommonJS. The CLI path is embedded at install time and can be overridden with `JIRA_CLI`, which is
 * what a developer with two checkouts wants.
 * @param kind - which hook the shim installs.
 * @param cliPath - the CLI entry the shim runs.
 * @param shell - the shell a preserved POSIX hook is run with, when one was resolved.
 * @returns the shim source, newline-terminated.
 */
export const hookShim = (kind: HookKind, cliPath: string, shell?: string): string => [
  '#!/usr/bin/env node',
  '// ' + SHIM_MARKER + ' (generated by `jira hooks install`; edit that, not this file).',
  `// kind: ${kind} — see DESIGN.md decision 67.`,
  "'use strict'",
  "const { spawnSync } = require('node:child_process')",
  "const { existsSync, readFileSync } = require('node:fs')",
  "const path = require('node:path')",
  '',
  `const cli = process.env.JIRA_CLI || ${JSON.stringify(cliPath)}`,
  `const shell = ${JSON.stringify(shell ?? '')}`,
  'const args = process.argv.slice(2)',
  '',
  '// A hook this installation replaced runs first: it may rewrite the message we validate.',
  '// Whether one exists is decided NOW, not at install time — a backup can appear later, and',
  '// baking the decision in would silently stop chaining it.',
  `const backup = path.join(__dirname, ${JSON.stringify(backupNameOf(kind))})`,
  'if (existsSync(backup)) {',
  '  // Reading the shebang is not decoration: on Windows a preserved hook is usually a',
  '  // #!/bin/sh script, and handing that to node fails with EFTYPE — which would block every',
  '  // commit in a repository that merely had a hook before us.',
  '  let first = ""',
  '  try { first = readFileSync(backup, "utf8").split("\\n")[0] || "" } catch {}',
  '  let command = backup',
  '  let prefix = []',
  '  if (first.startsWith("#!")) {',
  '    const line = first.slice(2).trim()',
  '    const interpreter = line.split(/\\s+/).pop() || ""',
  '    const base = path.basename(interpreter)',
  '    if (/node/.test(line)) { command = process.execPath; prefix = [backup] }',
  '    else if (["sh", "bash", "dash", "zsh", "ksh"].includes(base)) {',
  '      // On Windows the resolved git shell is embedded (the PATH rarely has one, and the',
  '      // bash.exe that is on it there is usually WSL, which cannot run a Windows path).',
  // NOTE (the TypeScript side): this `process.platform` check lives inside the *generated shim*,
  // which runs in git's own node process — the system adapter is out of reach there, so the
  // platform test is deliberately a string, not a leak (DPMJ-211).
  '      command = process.platform === "win32" ? (shell || "sh") : interpreter',
  '      prefix = [backup]',
  '    }',
  '  }',
  '  const previous = spawnSync(command, [...prefix, ...args], { stdio: "inherit" })',
  '  if (previous.error || previous.status === null) {',
  '    // A preserved hook we cannot run is a reason to say so — not a reason to block the author.',
  '    console.error("dsh-jira: warning: could not run the previous hook", backup, "-", previous.error ? previous.error.message : "no exit status")',
  '  } else if (previous.status !== 0) {',
  '    process.exit(previous.status)',
  '  }',
  '}',
  '',
  `const steps = ${kind === 'commit-msg' ? "['verify-commit-msg', ...args]" : "['hooks', 'prepare-commit-msg', ...args]"}`,
  'const result = spawnSync(process.execPath, [cli, ...steps], { stdio: "inherit" })',
  'if (result.error) { console.error("dsh-jira: cannot run", cli, "-", result.error.message); process.exit(1) }',
  'process.exit(result.status === null ? 1 : result.status)',
  '',
].join('\n')
/** What an install did: the hooks written, the hooks it had to back up, and where they live. */
export type InstallReport = Readonly<{
  installed: readonly HookKind[]
  backedUp: readonly HookKind[]
  directory: string
}>

/**
 * Install both hooks. Idempotent: re-running replaces our own shim and never re-backs-up a backup.
 * @param repoRoot - the repository to install into.
 * @param cliPath - the CLI entry the shims run.
 * @returns the install report, or the failure that left the hooks untouched.
 */
export const installHooks = async (
  repoRoot: string,
  cliPath: string,
): Promise<Result<InstallReport, JiraError>> => {
  const directory = hooksDirectory(repoRoot)
  const installed: HookKind[] = []
  const backedUp: HookKind[] = []
  const shell = await resolveGitShell(repoRoot)

  for (const kind of HOOK_KINDS) {
    const target = join(directory, kind)
    const backup = join(directory, backupNameOf(kind))
    if (await exists(target)) {
      const current = await readFile(target, 'utf8')
      if (!current.includes(SHIM_MARKER)) {
        try {
          await copyFile(target, backup)
          backedUp.push(kind)
        } catch (cause) {
          return err(ioFailed(`cannot back up the existing ${kind} hook`, { path: target, cause: String(cause) }))
        }
      }
    }
    try {
      await writeFile(target, hookShim(kind, cliPath, shell), 'utf8')
      // Git refuses to run a hook that is not executable on POSIX; Windows ignores the bit.
      await chmod(target, 0o755).catch(() => undefined)
      installed.push(kind)
    } catch (cause) {
      return err(ioFailed(`cannot write the ${kind} hook`, { path: target, cause: String(cause) }))
    }
  }

  return ok(Object.freeze({ installed: Object.freeze(installed), backedUp: Object.freeze(backedUp), directory }))
}

/**
 * Put the original hooks back, and remove ours.
 * @param repoRoot - the repository to uninstall from.
 * @returns the hooks restored or removed; a hook that is not ours is left alone.
 */
export const uninstallHooks = async (repoRoot: string): Promise<Result<readonly HookKind[], JiraError>> => {
  const directory = hooksDirectory(repoRoot)
  const restored: HookKind[] = []
  for (const kind of HOOK_KINDS) {
    const target = join(directory, kind)
    const backup = join(directory, backupNameOf(kind))
    if (!(await exists(target))) continue
    const current = await readFile(target, 'utf8')
    if (!current.includes(SHIM_MARKER)) continue
    try {
      if (await exists(backup)) {
        await rename(backup, target)
        await chmod(target, 0o755).catch(() => undefined)
      } else {
        await rename(target, `${target}.removed`)
      }
      restored.push(kind)
    } catch (cause) {
      return err(ioFailed(`cannot restore the ${kind} hook`, { path: target, cause: String(cause) }))
    }
  }
  return ok(Object.freeze(restored))
}

/**
 * Render the hook states for the human surface, one line per hook.
 * @param states - the states to render.
 * @returns the rendered lines, newline-separated.
 */
export const renderHookStatus = (states: readonly HookState[]): string =>
  states.map(state =>
    `${state.installed ? '✓' : '·'} ${state.kind}${state.backup ? '  （原有的钩子已保留并串联）' : ''}`).join('\n')
