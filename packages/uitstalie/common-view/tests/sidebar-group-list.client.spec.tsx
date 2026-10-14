// @vitest-environment jsdom
/**
 * The sidebar replica draws the shipped sidebar's shape from the layout units:
 * one header per group with a new-session button, one row per session, and a
 * divider only between groups. Titles are data and render verbatim; the selected
 * row is distinguished by its ink token, not by a class.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SidebarGroupList } from '../src/client/views/scaffold/SidebarGroupList.tsx'
import { SAMPLE_GROUPS } from '../src/client/views/scaffold/sample-sidebar.ts'
import type { CommonViewKey } from '../src/client/locales.ts'

// This config does not enable vitest globals, so the DOM is torn down per case.
afterEach(cleanup)

/** Copy stub: assertions read keys instead of localized sentences. */
function t(key: CommonViewKey): string {
  return key
}

/** Copy stub that keeps the parameters, so a formatted sentence stays assertable. */
function tWithParams(key: CommonViewKey, params?: Record<string, string>): string {
  return `${key} ${JSON.stringify(params ?? {})}`
}

describe('sidebar replica', () => {
  it('lists every group and every session title of an open group verbatim', () => {
    render(<SidebarGroupList t={t} groups={SAMPLE_GROUPS} />)
    for (const group of SAMPLE_GROUPS) {
      expect(screen.getByText(group.title)).toBeDefined()
      for (const row of group.expanded ? group.rows : []) expect(screen.getByText(row.title)).toBeDefined()
    }
  })

  it('separates groups, not rows, with the divider atom', () => {
    render(<SidebarGroupList t={t} groups={SAMPLE_GROUPS} />)
    expect(screen.getAllByRole('separator')).toHaveLength(SAMPLE_GROUPS.length - 1)
  })

  it('gives every group header its workspace actions and every row the action strip', () => {
    render(<SidebarGroupList t={t} groups={SAMPLE_GROUPS} />)
    const rows = SAMPLE_GROUPS.flatMap(group => group.expanded ? group.rows : [])
    const archived = rows.filter(row => row.archived === true).length
    // The workspace strip: the "…" trigger and the new-session button.
    expect(screen.getAllByRole('button', { name: 'scaffold.groupMenu' })).toHaveLength(SAMPLE_GROUPS.length)
    expect(screen.getAllByRole('button', { name: 'scaffold.newSessionIn' })).toHaveLength(SAMPLE_GROUPS.length)
    expect(screen.getAllByRole('button', { name: 'scaffold.rowMenu' })).toHaveLength(rows.length)
    // The archive button flips to unarchive on an archived row, which also loses its pin.
    expect(screen.getAllByRole('button', { name: 'scaffold.menuArchive' })).toHaveLength(rows.length - archived)
    expect(screen.getAllByRole('button', { name: 'scaffold.menuUnarchive' })).toHaveLength(archived)
    expect(screen.getAllByRole('button', { name: /scaffold\.menu(Un)?[pP]in/ })).toHaveLength(rows.length - archived)
  })

  it('opens the workspace menu with rename and the destructive delete', () => {
    render(<SidebarGroupList t={t} groups={SAMPLE_GROUPS} />)
    fireEvent.click(screen.getAllByRole('button', { name: 'scaffold.groupMenu' })[0] as HTMLElement)
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      'scaffold.menuRenameWorkspace', 'scaffold.menuDeleteWorkspace',
    ])
  })

  it('lists a session only while its group is expanded, and shows each time label', () => {
    render(<SidebarGroupList t={t} groups={SAMPLE_GROUPS} />)
    expect(screen.queryByText('task23：rebase 到上游并推送')).toBeNull()
    for (const row of SAMPLE_GROUPS[0]!.rows) expect(screen.getByText(row.time)).toBeDefined()
  })

  it('indents every session row one level, as the shipped list does', () => {
    render(<SidebarGroupList t={t} groups={SAMPLE_GROUPS} />)
    const row = screen.getByText(SAMPLE_GROUPS[0]!.rows[0]!.title).closest('span')?.parentElement
    expect(row?.style.getPropertyValue('--dsh-common-view-indent')).toBe('12px')
  })

  it('opens the workspace hover card with its directory and creation time', () => {
    vi.useFakeTimers()
    try {
      const workspace = SAMPLE_GROUPS[0]!
      render(<SidebarGroupList t={tWithParams} groups={SAMPLE_GROUPS} />)
      // The card's pointer handler sits on the wrapper the primitive owns: the
      // direct parent of the workspace row.
      const anchorRow = screen.getByText(workspace.title).closest('[class*="groupRow"]') as HTMLElement
      fireEvent.pointerEnter(anchorRow.parentElement as HTMLElement)
      // The shell opens the card only after its 800ms delay.
      expect(screen.queryByText(workspace.cwd)).toBeNull()
      act(() => { vi.advanceTimersByTime(800) })
      expect(screen.getByText(workspace.cwd)).toBeDefined()
      const created = screen.getByText(/scaffold\.createdAt/)
      // The sentence is the localized one, carrying the formatted date key and year.
      expect(created.textContent).toContain('scaffold.dateYmd')
      expect(created.textContent).toContain(String(new Date(workspace.createdAt).getFullYear()))
    } finally {
      vi.useRealTimers()
    }
  })
})
