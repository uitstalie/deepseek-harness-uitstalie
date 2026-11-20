/** Profile-patch rewrites must never drop rows the writer did not own. */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { droppedPatchRows, patchRowIds } from '../src/index.ts'

const fixture = readFileSync(new URL('./patch-rows.fixture.yml', import.meta.url), 'utf8')
const USER_ROWS = ['ui-settings-general', 'jira-service', 'agent-preset-registry', 'llm-plus', 'dafeiyu', 'jira-agent']

it('reads every top-level row id in file order', () => {
  expect(patchRowIds(fixture)).toEqual([
    'ui-settings-general', 'jira-service', 'agent-preset-registry', 'llm-plus', 'dafeiyu', 'jira-agent',
    'ui-settings-account', 'ui-chat', 'ui-settings', 'agent-default-model',
  ])
})

it('reports no drop when a settings write changes only its own row', () => {
  const rewritten = fixture.replace('marker: "ui-chat"', 'marker: "ui-chat"\n    transcriptView: standard')
  expect(droppedPatchRows(fixture, rewritten)).toEqual([])
  expect(patchRowIds(rewritten)).toEqual(patchRowIds(fixture))
})

it('reports every user row a composed-model rewrite would drop, in file order', () => {
  const appOnly = [
    '- id: ui-settings-account',
    '  name: "@deepseek-ai/ui-settings-account"',
    '- id: ui-chat',
    '  name: "@deepseek-ai/ui-chat"',
    '- id: ui-settings',
    '  name: "@deepseek-ai/ui-settings"',
    '- id: agent-default-model',
    '  name: "@deepseek-ai/agent-default-model"',
  ].join('\n') + '\n'
  expect(droppedPatchRows(fixture, appOnly)).toEqual(USER_ROWS)
})

it('ignores insert rows and tolerates a non-sequence document', () => {
  const withInsert = fixture + '- insert:\n    - id: extra\n      name: extra\n'
  expect(patchRowIds(withInsert)).not.toContain('extra')
  expect(patchRowIds('not: a sequence\n')).toEqual([])
})
