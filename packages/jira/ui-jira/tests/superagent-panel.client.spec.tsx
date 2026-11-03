// @vitest-environment jsdom
/**
 * The super-agent summary: counts by status and the review rows that need a person.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { JiraBoardView, JiraIssueRowView, SuperagentStatusView } from '@deepseek-ai/dsh-jira-service/types'
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
  expect(screen.getAllByText(/DH-3/).length).toBeGreaterThan(0)
})

it('opens the chosen review issue', () => {
  const onSelect = vi.fn()
  render(<SuperagentPanel board={board} t={t} onSelect={onSelect} />)
  fireEvent.click(screen.getByText(/DH-3/))
  expect(onSelect).toHaveBeenCalledWith('DH-3')
})

it('renders recent activity when the Host provides it', () => {
  render(<SuperagentPanel board={board} t={t} history={{ entries: [{ sha: 'a'.repeat(40), at: '2026-10-27T00:00:00Z', author: 'human:fixture', subject: 'claim DH-3' }], hasMore: false }} />)
  expect(screen.getByText('superagentHistoryTitle')).toBeTruthy()
  expect(screen.getByText(/claim DH-3/)).toBeTruthy()
})

it('renders proposal triggers and opens the issue', () => {
  const onSelect = vi.fn()
  render(<SuperagentPanel board={board} t={t} onSelect={onSelect} triggers={{ entries: [{ key: 'DH-3', summary: 'needs a look', author: 'human:fixture', at: '2026-10-27T00:00:00Z', body: '[claim-proposal] take it', active: true }], hasMore: false }} />)
  expect(screen.getByText('superagentTriggersTitle')).toBeTruthy()
  expect(screen.getByText('2026-10-27')).toBeTruthy()
  fireEvent.click(screen.getByText(/DH-3 · human:fixture/))
  expect(onSelect).toHaveBeenCalledWith('DH-3')
})

it('filters proposals by text and active state', () => {
  render(<SuperagentPanel board={board} t={t} triggers={{ entries: [
    { key: 'DH-3', summary: 'needs a look', author: 'human:fixture', at: '2026-10-27T00:00:00Z', body: '[claim-proposal] active', active: true },
    { key: 'DH-9', summary: 'old proposal', author: 'human:other', at: '2026-10-26T00:00:00Z', body: '[claim-proposal] stale', active: false },
  ], hasMore: false }} />)
  expect(screen.getByText(/DH-9/)).toBeTruthy()
  expect(screen.getByText('2026-10-26')).toBeTruthy()
  fireEvent.change(screen.getByPlaceholderText('superagentFilterPlaceholder'), { target: { value: 'DH-3' } })
  expect(screen.queryByText(/DH-9/)).toBeNull()
  fireEvent.change(screen.getByPlaceholderText('superagentFilterPlaceholder'), { target: { value: '' } })
  fireEvent.click(screen.getByRole('checkbox'))
  expect(screen.queryByText(/DH-9/)).toBeNull()
})

it('asks for the next proposal page only when more exist', () => {
  const onLoadMore = vi.fn()
  render(<SuperagentPanel board={board} t={t} onLoadMore={onLoadMore} triggers={{ entries: [
    { key: 'DH-3', summary: 's', author: 'human:fixture', at: '2026-10-27T00:00:00Z', body: '[claim-proposal] x', active: true },
  ], hasMore: true }} />)
  fireEvent.click(screen.getByText('superagentLoadMore'))
  expect(onLoadMore).toHaveBeenCalledTimes(1)
})

it('filters proposals by a UTC date range', () => {
  const { container } = render(<SuperagentPanel board={board} t={t} triggers={{ entries: [
    { key: 'DH-3', summary: 'new', author: 'a', at: '2026-10-27T10:00:00Z', body: '[claim-proposal] new', active: true },
    { key: 'DH-9', summary: 'old', author: 'b', at: '2026-10-26T10:00:00Z', body: '[claim-proposal] old', active: false },
  ], hasMore: false }} />)
  const dates = container.querySelectorAll('input[type="date"]')
  fireEvent.change(dates[0] as Element, { target: { value: '2026-10-27' } })
  expect(screen.queryByText(/DH-9/)).toBeNull()
  expect(screen.getAllByText(/DH-3/).length).toBeGreaterThan(0)
})

it('asks for older activity only when more exists', () => {
  const onLoadMoreHistory = vi.fn()
  render(<SuperagentPanel board={board} t={t} onLoadMoreHistory={onLoadMoreHistory} history={{ entries: [
    { sha: 'a'.repeat(40), at: '2026-10-27T00:00:00Z', author: 'human:fixture', subject: 'claim DH-3' },
  ], hasMore: true }} />)
  fireEvent.click(screen.getByText('superagentLoadMoreHistory'))
  expect(onLoadMoreHistory).toHaveBeenCalledTimes(1)
})

it('renders nothing while the board is loading', () => {
  const { container } = render(<SuperagentPanel board={null} t={t} />)
  expect(container.firstChild).toBeNull()
})

/** One status view with a proposal and a delivery that needs a person. */
const statusView = (): SuperagentStatusView => {
  const proposed = { key: 'DH-5', priority: 'S1', summary: 'needs a decision', reason: 'confirm the proposal' }
  const review = { key: 'DH-3', priority: 'S1', summary: 'needs a look', reason: 'review the delivery' }
  return {
    counts: { ready: 1, proposed: 1, inProgress: 0, inReview: 1, blocked: 0 },
    ready: [],
    proposed: [proposed],
    inProgress: [],
    inReview: [review],
    blocked: [],
    needsPerson: [proposed, review],
  }
}

it('offers the confirmation only on a proposal, not on a delivery waiting for review', () => {
  const onConfirm = vi.fn()
  render(<SuperagentPanel board={board} status={statusView()} t={t} onConfirm={onConfirm} />)
  const buttons = screen.getAllByText('superagentConfirm')
  expect(buttons).toHaveLength(1)
  fireEvent.click(buttons[0] as Element)
  expect(onConfirm).toHaveBeenCalledWith('DH-5')
})

it('does not offer the confirmation without the Host status', () => {
  render(<SuperagentPanel board={board} t={t} onConfirm={vi.fn()} />)
  expect(screen.queryByText('superagentConfirm')).toBeNull()
})

it('disables the confirmation while it is being written', () => {
  render(<SuperagentPanel
    board={board}
    status={statusView()}
    t={t}
    onConfirm={vi.fn()}
    confirmState={{ key: 'DH-5', status: 'loading', error: null }}
  />)
  const button = screen.getByText('superagentConfirming') as HTMLButtonElement
  expect(button.disabled).toBe(true)
})

it('shows the failure in place and the success notice after a confirmation', () => {
  const { rerender } = render(<SuperagentPanel
    board={board}
    status={statusView()}
    t={t}
    onConfirm={vi.fn()}
    confirmState={{ key: 'DH-5', status: 'error', error: 'no proposal' }}
  />)
  expect(screen.getByText('superagentConfirmFailed')).toBeTruthy()
  rerender(<SuperagentPanel
    board={board}
    status={statusView()}
    t={t}
    onConfirm={vi.fn()}
    confirmState={{ key: 'DH-5', status: 'ready', error: null }}
  />)
  expect(screen.getByText('superagentConfirmed')).toBeTruthy()
})
