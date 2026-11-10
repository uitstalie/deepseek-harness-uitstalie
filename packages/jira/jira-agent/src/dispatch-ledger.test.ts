/**
 * The human-readable dispatch ledger projection.
 *
 * The report path no longer reads this file, but it is still what a person reviews: its fields
 * must therefore survive a free-text task or outcome that contains its own Markdown headings.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseLedger, renderTaskSection, type DispatchLedgerTask } from './dispatch-ledger.ts'

const workspace = { workspaceId: 'w1', workspaceTitle: 'workspace', workspacePath: '/workspace' }

const task = (overrides: Partial<DispatchLedgerTask> = {}): DispatchLedgerTask => ({
  id: 'task-multi',
  ...workspace,
  task: 'do the thing',
  dispatchedAt: '2026-11-08T00:00:00.000Z',
  status: 'pending',
  updatedAt: '2026-11-08T00:00:00.000Z',
  artifacts: [],
  decisions: [],
  ...overrides,
})

void describe('dispatch ledger: free-text fields', () => {
  void it('keeps structured fields readable after a task with its own Markdown headings', () => {
    const rendered = renderTaskSection(task({
      task: [
        'Investigate the failure.',
        '',
        '## What to answer',
        '',
        '1. The first question.',
        '- dispatched: this line is task text, not a field.',
      ].join('\n'),
      sessionId: 'child-1',
      requestId: 'req-1',
    }))
    const [parsed] = parseLedger(rendered, workspace)

    assert.equal(parsed?.id, 'task-multi')
    assert.equal(parsed?.status, 'pending')
    assert.equal(parsed?.dispatchedAt, '2026-11-08T00:00:00.000Z')
    assert.equal(parsed?.sessionId, 'child-1')
    assert.equal(parsed?.requestId, 'req-1')
    assert.match(parsed?.task ?? '', /## What to answer/u)
    assert.match(parsed?.task ?? '', /this line is task text/u)
  })

  void it('keeps a multi-line outcome attached to its field', () => {
    const rendered = renderTaskSection(task({
      status: 'returned',
      outcome: 'first line\nsecond line\n## not a section',
    }))
    const [parsed] = parseLedger(rendered, workspace)
    assert.equal(parsed?.outcome, 'first line\nsecond line\n## not a section')
  })

  void it('reads the structured fields of an older record written before continuation indenting', () => {
    const legacy = [
      '# Dispatch ledger — workspace',
      '',
      '## task-old · pending',
      '- workspace: workspace',
      '- path: `/workspace`',
      '- task: old multi-line task',
      '',
      '## 现状',
      '',
      'Some prose.',
      '- dispatched: 2026-11-08T00:00:00.000Z',
      '- updated: 2026-11-08T00:00:00.000Z',
      '- session: child-old',
      '',
    ].join('\n')
    const [parsed] = parseLedger(legacy, workspace)

    assert.equal(parsed?.id, 'task-old')
    assert.equal(parsed?.dispatchedAt, '2026-11-08T00:00:00.000Z')
    assert.equal(parsed?.sessionId, 'child-old')
    assert.equal(parsed?.task, 'old multi-line task')
  })
})
