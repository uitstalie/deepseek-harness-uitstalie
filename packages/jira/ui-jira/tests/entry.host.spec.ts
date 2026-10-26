/**
 * The host entry beside the browser half: an empty plugin body (the row loads through this
 * package, all behavior is in `./client`), and the section identity both halves share.
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
  // `dafeiyu` links to the section by this id; both halves read it from one module.
  expect(hostEntry.JIRA_SETTINGS_SECTION).toBe('jira')
  expect(hostEntry.JIRA_SETTINGS_ORDER).toBe(200)
  expect(hostEntry.JIRA_SETTINGS_FIELDS).toEqual(['root', 'host', 'push.enabled'])
})
