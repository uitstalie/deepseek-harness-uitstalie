/** Patch rows that target no composed entry must be reportable, not silently skipped. */
import { expect, it } from 'vitest'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { missingPatchTargets } from '../src/profile.ts'

const entries: EntryOptions[] = [
  { id: 'ui-settings-general', name: 'ui-settings-general' },
  { id: 'group', name: 'cordis:group', group: true, config: [{ id: 'nested', name: 'nested-plugin' }] },
]

it('reports a patch row whose target entry does not exist, with its declared name', () => {
  const patches: PatchOptions[] = [
    { id: 'ui-settings-general', config: { welcomeNoticeVersion: '1' } },
    { id: 'jira-agent', name: '@deepseek-ai/dsh-jira-agent', config: {} },
  ]
  expect(missingPatchTargets(patches, entries)).toEqual([
    { id: 'jira-agent', name: '@deepseek-ai/dsh-jira-agent' },
  ])
})

it('counts a target inside a nested group and ignores insert rows', () => {
  const patches: PatchOptions[] = [
    { id: 'nested', config: { enabled: false } },
    { insert: [{ id: 'added', name: 'added-plugin' }] },
  ]
  expect(missingPatchTargets(patches, entries)).toEqual([])
})

it('reports every missing row in patch order and tolerates a row without a name', () => {
  const patches: PatchOptions[] = [
    { id: 'retired-a', name: 'a' },
    { id: 'ui-settings-general', config: {} },
    { id: 'retired-b' },
  ]
  expect(missingPatchTargets(patches, entries)).toEqual([
    { id: 'retired-a', name: 'a' },
    { id: 'retired-b' },
  ])
})
