/**
 * A test helper that runs one body under **both** platforms' rules on whichever machine happens to be
 * free (decision 152).
 *
 * This is the practical answer to "green on Fedora, red on Windows, then the reverse": the platform
 * facts live in `core/system` (decision 151), and this helper drives them twice — once with Windows
 * rules and once with POSIX rules — so a rule that only holds on one of them fails **here**, on the
 * machine that is already open.
 *
 * It is deliberately test-only: nothing in `src/core` imports it, and the two runs share one process
 * (the platform is a *value*, not an environment).
 */

import { describe, it } from 'node:test'

import { type System, systemFor } from '../system/index.ts'

export type PlatformName = 'win32' | 'linux'

/** Run `body` once per platform, as two named cases inside one `describe`. */
export const bothPlatforms = (
  name: string,
  body: (system: System, platform: PlatformName) => Promise<void> | void,
): void => {
  describe(name, () => {
    for (const platform of ['win32', 'linux'] as const) {
      it(`${platform} rules`, async () => {
        await body(systemFor(platform), platform)
      })
    }
  })
}
