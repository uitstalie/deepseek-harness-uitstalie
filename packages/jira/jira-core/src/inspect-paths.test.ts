/**
 * The two-platform rule (`decision 152`) applied to the places that were only tested on one of them.
 *
 * `bothPlatforms` runs one body twice — Windows rules, then POSIX rules — so a rule that holds on only
 * one of them fails here, on whichever machine is free. Before this file it was used by `paths.test.ts`
 * alone.
 */
import assert from 'node:assert/strict'

import { systemFor } from './system/index.ts'
import { bothPlatforms } from './testing/bothPlatforms.ts'

bothPlatforms('system: samePath follows that platform’s separator and case rules', (system, platform) => {
  // Windows folds case and both separators; POSIX does neither. A rule that only holds on one of them
  // fails here (the `bothPlatforms` point), and this is a case `paths.test.ts` did not cover.
  const caseInsensitive = system.samePath('/work/Repo', '/work/repo')
  assert.equal(caseInsensitive, platform === 'win32', platform)
  const separatorInsensitive = system.samePath('D:/Work/Repo', 'D:\\Work\\Repo')
  assert.equal(separatorInsensitive, platform === 'win32', 'only Windows treats / and \\ as the same')
  assert.equal(system.facts.separator, platform === 'win32' ? '\\' : '/')
})

bothPlatforms('system: a safe file name is the same name on both platforms', (system) => {
  // The contract is "one segment that means the same file everywhere", so the two platform rule sets
  // must agree character for character — a divergence here is a store that cannot be shared.
  const other = systemFor(system.facts.isWindows ? 'linux' : 'win32')
  for (const value of ['s-1', '../x', 'CON', 'name.', '会话-1', 'x'.repeat(100)]) {
    assert.equal(system.safeFileName(value), other.safeFileName(value), value)
  }
})
