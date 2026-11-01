// @vitest-environment jsdom
/**
 * The super-agent summary: counts by status and the review rows that need a person.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { JiraBoardView, JiraIssueRowView } from '@deepseek-ai/dsh-jira-service/types'
import { SuperagentPanel } from '../src/client/SuperagentPanel.tsx'

afterEach(cleanup)

const t = (key: string): string => key === 'superagentReviewItem'
  ? '{key}  {summary}'
  : key === 'superagentReady' || key === 'superagentInProgress' || key === 'superagentReview' || key === 'superagentBlocked'
    ? '{count}'
    : key

const row = (key: string, status: string, summary = key): JiraIssueRowView => ({
  key, project: 'DH', issueType: 'task', status, priority: 'S1', summary,
  tags: [], updatedAt: '2026-10-27T00:00:00Z', revision: 1, blocked: false,
})

const board: JiraBoardView = {
  items: [],
  groups: [
    { name: 'DH · todo', kind: 'status', project: 'DH', status: 'todo', items: [row('DH-1', 'todo')] },
    { name: 'DH · in_progress', kind: 'status', project: 'DH', status: 'in_progress', items: [row('DH-2', 'in_progress')] },
    { name: 'DH · in_review', kind: 'status', project: 'DH', status: 'in_review', items: [row('DH-3', 'in_review', 'needs a look')] },
    { name: 'blocked', kind: 'blocked', project: '*', items: [row('DH-4', 'blocked')] },
  ],
  counts: { returned: 4, matched: 4, remaining: 0, byStatus: {}, blocked: 1 },
  truncated: false,
  limit: 20,
}

it('renders counts and the review rows', () => {
  render(<SuperagentPanel board={board} t={t} />)
  expect(screen.getByText('superagentTitle')).toBeTruthy()
  expect(screen.getAllByText('1')).toHaveLength(4)
  expect(screen.getByText('superagentNeedsYou')).toBeTruthy()
  expect(screen.getByText(/DH-3/)).toBeTruthy()
})

it('opens the chosen review issue', () => {
  const onSelect = vi.fn()
  render(<SuperagentPanel board={board} t={t} onSelect={onSelect} />)
  fireEvent.click(screen.getByText(/DH-3/))
  expect(onSelect).toHaveBeenCalledWith('DH-3')
})

it('renders nothing while the board is loading', () => {
  const { container } = render(<SuperagentPanel board={null} t={t} />)
  expect(container.firstChild).toBeNull()
})
