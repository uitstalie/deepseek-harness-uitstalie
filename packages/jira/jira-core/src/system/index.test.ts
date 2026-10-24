/**
 * Tests for core/system — the platform adapter (decision 151).
 *
 * The point of this file is that it runs **both** platforms from one machine. That is the whole reason
 * the adapter exists: the previous failures were "green on Fedora, red on Windows, then the reverse",
 * and each one cost a round trip through a machine that happened to be free. A platform rule that can
 * be asked with `systemFor('win32')` never needs that round trip again.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { system, systemFor } from './index.ts'

const windows = systemFor('win32')
const linux = systemFor('linux')

describe('system: facts', () => {
  it('reports the platform it was built for, not the host it runs on', () => {
    assert.equal(windows.facts.platform, 'win32')
    assert.equal(windows.isWindows, true)
    assert.equal(linux.facts.platform, 'linux')
    assert.equal(linux.isWindows, false)
    // The default instance describes the machine this process is actually on.
    assert.equal(system.facts.platform, process.platform === 'win32' ? 'win32' : 'linux')
  })

  it('knows the null device, and documents what it is not for', () => {
    assert.equal(windows.facts.devNull, 'nul')
    assert.equal(linux.facts.devNull, '/dev/null')
    // `nul` is a *process output* target. Using it as "an empty file" is what broke Windows git:
    // `fatal: unable to access '//./nul': Invalid argument`. A test below pins the consequence.
    assert.match(system.facts.devNull, /^(nul|\/dev\/null)$/u)
  })
})

describe('system: paths', () => {
  it('normalises with the recording platform, not the host', () => {
    // A path recorded on the Windows machine keeps Windows spelling and case folding…
    assert.equal(windows.normalizePath('D:/Work/Repo'), 'd:\\work\\repo')
    // …even when the rules are asked for on a Linux host, and vice versa.
    assert.equal(linux.normalizePath('/home/u/Repo'), '/home/u/Repo')
    // The second argument is "where this path came from": a Windows path read on Fedora.
    assert.equal(linux.normalizePath('D:/Work/Repo', 'win32'), 'd:\\work\\repo')
  })

  it('compares the way each platform compares', () => {
    assert.equal(windows.samePath('D:/Work/Repo', 'd:\\work\\repo'), true, 'Windows is case-insensitive')
    assert.equal(linux.samePath('/home/u/Repo', '/home/u/repo'), false, 'POSIX is not')
    assert.equal(linux.samePath('/home/u/Repo', '/home/u/Repo'), true)
  })
})

describe('system: the git environment', () => {
  it('drops the variables that point git at another repository', () => {
    const cleaned = windows.gitEnv({
      PATH: '/usr/bin',
      HOME: '/home/u',
      GIT_DIR: 'C:/elsewhere/.git',
      GIT_WORK_TREE: 'C:/elsewhere',
      GIT_INDEX_FILE: 'C:/elsewhere/.git/index',
      GIT_OBJECT_DIRECTORY: 'C:/elsewhere/objects',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: 'C:/other/objects',
      GIT_COMMON_DIR: 'C:/elsewhere',
    })
    assert.equal(cleaned.PATH, '/usr/bin')
    assert.equal(cleaned.HOME, '/home/u')
    for (const dropped of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR']) {
      assert.equal(dropped in cleaned, false, `${dropped} must not reach a git child`)
    }
  })

  it('keeps configuration variables, because configuring git is a legitimate choice', () => {
    // The plugin's tests simulate a machine that cannot guess an identity through these — dropping
    // them would silently stop covering decision 146's bug.
    const cleaned = linux.gitEnv({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'user.useConfigOnly',
      GIT_CONFIG_VALUE_0: 'true',
      GIT_CONFIG_GLOBAL: '/tmp/empty-gitconfig',
    })
    assert.equal(cleaned.GIT_CONFIG_COUNT, '1')
    assert.equal(cleaned.GIT_CONFIG_KEY_0, 'user.useConfigOnly')
    assert.equal(cleaned.GIT_CONFIG_GLOBAL, '/tmp/empty-gitconfig')
  })

  it('drops unset variables instead of passing empty strings', () => {
    const cleaned = windows.gitEnv({ PATH: '/usr/bin', UNSET: undefined })
    assert.deepEqual(Object.keys(cleaned).sort(), ['PATH'])
  })
})

describe('system: cleanup policy', () => {
  it('retries a removal with a growing backoff, on both platforms', () => {
    assert.equal(windows.removeRetries, linux.removeRetries)
    assert.equal(windows.removeDelayMs(0) > 0, true)
    assert.equal(windows.removeDelayMs(3) > windows.removeDelayMs(1), true, 'the backoff grows')
    assert.equal(windows.removeDelayMs(2), linux.removeDelayMs(2), 'the same policy everywhere')
  })
})

describe('system: the git configuration this store writes', () => {
  it('is the same list on both platforms — no host-dependent branch', () => {
    assert.deepEqual(windows.facts.gitConfig, linux.facts.gitConfig)
    const keys = windows.facts.gitConfig.map(([key]) => key)
    assert.deepEqual(keys, ['core.fileMode', 'i18n.commitEncoding'], 'decision 81')
  })
})

describe('system: the directories this project keeps beside the user (decision 153)', () => {
  it('finds the home from $DSH_HOME, then the profile', () => {
    assert.equal(windows.homeDir({ DSH_HOME: 'C:/dsh' }), 'C:/dsh')
    assert.equal(windows.homeDir({ USERPROFILE: 'C:/Users/ts' }), 'C:\\Users\\ts\\.dsh', 'the profile is not the dsh home; <profile>/.dsh is')
    assert.equal(linux.homeDir({ HOME: '/home/u' }), '/home/u/.dsh')
    // $DSH_HOME wins over the profile, and a trailing separator is dropped.
    assert.equal(linux.homeDir({ DSH_HOME: '/opt/dsh/', HOME: '/home/u' }), '/opt/dsh', ' wins and its trailing separator is dropped')
    assert.equal(linux.homeDir({}), undefined)
  })

  it('puts machine-local state in <home>/dsh-jira, and falls back inside the store', () => {
    assert.equal(windows.stateDir({ DSH_HOME: 'C:/dsh' }), 'C:\\dsh\\dsh-jira')
    assert.equal(linux.stateDir({ HOME: '/home/u' }), '/home/u/.dsh/dsh-jira')
    // The store fallback exists only because `.jira/` is gitignored (decision 73).
    assert.equal(linux.stateDir({}, '/store'), '/store/.jira')
    assert.equal(windows.stateDir({}, 'D:/store'), 'D:\\store\\.jira')
    assert.equal(linux.stateDir({}), undefined)
  })

  it('defaults the store root to <home>/jira on both platforms', () => {
    assert.equal(windows.defaultStoreRoot({ DSH_HOME: 'C:/dsh' }), 'C:\\dsh\\jira')
    assert.equal(linux.defaultStoreRoot({ HOME: '/home/u' }), '/home/u/.dsh/jira')
    assert.equal(linux.defaultStoreRoot({}), undefined)
  })
})

describe('system: path helpers (decision 153)', () => {
  it('turns recorded paths into the posix spelling used inside the store', () => {
    assert.equal(windows.toPosix('projects\\DH\\issues\\DH-1.md'), 'projects/DH/issues/DH-1.md')
    assert.equal(linux.toPosix('projects/DH/issues/DH-1.md'), 'projects/DH/issues/DH-1.md')
  })

  it('resolves a local path the way the platform resolves it', () => {
    // `resolvePath` is the *local* rule: a relative `--root` becomes absolute on this platform.
    assert.equal(linux.resolvePath('store', '/work'), '/work/store')
    assert.equal(windows.resolvePath('store', 'D:\\work'), 'D:\\work\\store')
    assert.equal(linux.resolvePath('/abs/store'), '/abs/store')
  })

  it('makes one safe path segment out of an id, or falls back', () => {
    assert.equal(linux.safeFileName('sess/with:odd chars'), 'sess_with_odd_chars')
    assert.equal(linux.safeFileName('..'), 'unnamed')
    assert.equal(linux.safeFileName('', 'fallback'), 'fallback')
    assert.equal(linux.safeFileName('KB-1'), 'KB-1', 'a legal name is left alone')
  })

  it('warns at 240 characters and refuses at the platform limit (decision 60)', () => {
    const long = '/'.padEnd(240, 'a')
    assert.equal(linux.approachesPathLimit(long), true)
    assert.equal(linux.approachesPathLimit('/short'), false)
    assert.equal(linux.exceedsPathLimit('/'.padEnd(4096, 'a')), true)
    assert.equal(windows.exceedsPathLimit('C:\\'.padEnd(260, 'a')), true)
    assert.equal(windows.exceedsPathLimit('C:\\short'), false)
    assert.equal(windows.facts.pathLengthWarn, 240)
    assert.equal(linux.facts.pathLengthWarn, 240, 'the warning threshold is the same everywhere')
  })
})

describe('system: the modular split keeps one entry point', () => {
  it('exposes every concern through the same object, for any platform', () => {
    for (const platform of [windows, linux]) {
      for (const member of [
        'normalizePath', 'toPosix', 'resolvePath', 'samePath', 'safeFileName',
        'exceedsPathLimit', 'approachesPathLimit', 'homeDir', 'stateDir', 'defaultStoreRoot',
        'gitEnv', 'writeDelayMs', 'removeDelayMs',
      ] as const) {
        assert.equal(typeof platform[member], 'function', `${platform.facts.platform} is missing ${member}`)
      }
      assert.equal(typeof platform.writeAttempts, 'number')
      assert.equal(typeof platform.removeRetries, 'number')
    }
  })
})
describe('system: the sanitizers and the environment hold their contracts (decision 167)', () => {
  it('strips repo-location variables case-insensitively, and GIT_NAMESPACE', () => {
    // Windows environment names are case-insensitive: `git_dir` is `GIT_DIR` to every child process.
    const cleaned = windows.gitEnv({ git_dir: 'C:/evil', GIT_Work_Tree: 'C:/evil', GIT_NAMESPACE: 'x', PATH: 'p' })
    assert.deepEqual(cleaned, { PATH: 'p' })
    // Configuration variables stay: decision 146's test machine is simulated through them.
    const configured = windows.gitEnv({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.useConfigOnly' })
    assert.deepEqual(configured, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.useConfigOnly' })
  })

  it('produces one path segment that means the same file everywhere', () => {
    const safe = windows.safeFileName
    assert.equal(safe('session-abc_1'), 'session-abc_1', 'a safe id is left alone')
    // The contract is "one segment that cannot escape and is not a device name", not a spelling.
    assert.equal(safe('../x').includes('/'), false, 'no separators')
    assert.notEqual(safe('../x'), '..', 'and it never stays a parent reference')
    assert.equal(safe('..'), 'unnamed', 'a name of only dots is not a name')
    assert.equal(safe('a/b'), 'a_b', 'no separators')
    assert.equal(safe('CON'), '_CON', 'a Windows device name is not a file name')
    assert.equal(safe('nul.txt'), '_nul.txt', 'nor is it one with an extension')
    assert.equal(safe('name.'), 'name', 'Windows drops the trailing dot anyway')
    assert.equal(safe('name '), 'name', 'and the trailing space')
    assert.equal(safe('.hidden'), '.hidden', 'a leading dot is content: `.hidden` and `hidden` are two files')
    assert.equal(safe(''), 'unnamed')
    assert.equal(safe('', '..'), 'unnamed', 'even a bad fallback cannot become ..')
    // Everything outside `[A-Za-z0-9._-]` becomes `_`: a documented limit, and the reason session ids
    // (UUIDs) are the only ids this is used with.
    assert.equal(safe('é'), '_', 'the allowlist is ASCII on purpose')
    const long = safe('x'.repeat(200))
    assert.equal(long.length <= 64, true, 'truncated')
    assert.equal(long.startsWith('x'.repeat(20)), true, 'keeping a readable prefix')
    assert.notEqual(safe(`${'y'.repeat(200)}a`), safe(`${'y'.repeat(200)}b`), 'and two long names stay distinct')
  })

  it('makes a relative $DSH_HOME absolute, so the machine id stops following the cwd', () => {
    assert.equal(linux.homeDir({ DSH_HOME: 'rel' })?.startsWith('/'), true, 'relative becomes absolute')
    assert.equal(linux.homeDir({ DSH_HOME: '~/dsh', HOME: '/home/u' }), '/home/u/dsh', '~ is expanded')
    assert.equal(linux.homeDir({ DSH_HOME: '/opt/dsh/' }), '/opt/dsh', 'an absolute one is left as given')
  })
})
