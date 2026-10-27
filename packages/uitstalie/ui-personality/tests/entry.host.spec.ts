/**
 * The host entry beside the browser half: an empty plugin body (the row loads
 * through this package, all behavior is in `./client`), and the section
 * identity both halves share.
 */

import { expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as hostEntry from '../src/index.ts'

test('the host entry is a loadable, inert plugin body', async () => {
  const ctx = new Context()
  await ctx.plugin(hostEntry).await()
  expect(() => { hostEntry.apply() }).not.toThrow()
  await ctx.fiber.dispose()
})

test('publishes the section identity the browser half registers', () => {
  // The personality provider links to its own page by id; this section is that page.
  expect(hostEntry.PERSONALITY_SETTINGS_SECTION).toBe('personality')
  expect(hostEntry.PERSONALITY_SETTINGS_ORDER).toBe(210)
})
