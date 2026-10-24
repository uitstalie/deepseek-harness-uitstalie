/**
 * testing/removeTree — the suite's one `rm -rf` (DPMJ-201).
 *
 * A test that ran real git can lose the cleanup race: a clone or commit leaves a detached git
 * helper writing under `.git/objects/pack`, and a bare `rm` then fails with ENOTEMPTY while every
 * assertion passed (2026-10-17, one CI job). The retry/back-off policy lives in `core/system`
 * (decision 153) so every test file shares one answer instead of growing its own copy —
 * there used to be three identical local helpers and seven files with a bare `rm`.
 */

import { rm } from 'node:fs/promises'

import { system } from '../system/index.ts'

export const removeTree = async (path: string): Promise<void> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true })
      return
    } catch (cause) {
      if (attempt >= system.removeRetries) throw cause
      await new Promise(resolve => setTimeout(resolve, system.removeDelayMs(attempt)))
    }
  }
}
