// @vitest-environment jsdom
/**
 * The sidebar replica draws the shipped sidebar's shape from the layout units:
 * one header per group with a new-session button, one row per session, and a
 * divider only between groups. Titles are data and render verbatim; the selected
 * row is distinguished by its ink token, not by a class.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { SidebarGroupList } from '../src/client/views/scaffold/SidebarGroupList.tsx'
import { SAMPLE_GROUPS } from '../src/client/views/scaffold/sample-sidebar.ts'
import type { CommonViewKey } from '../src/client/locales.ts'

// This config does not enable vitest globals, so the DOM is torn down per case.
afterEach(cleanup)

/** Copy stub: assertions read keys instead of localized sentences. */
function t(key: CommonViewKey): string {
  return key
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

  it('gives every group header and every row a new-session action', () => {
    render(<SidebarGroupList t={t} groups={SAMPLE_GROUPS} />)
    const rows = SAMPLE_GROUPS.reduce((total, group) => total + (group.expanded ? group.rows.length : 0), 0)
    expect(screen.getAllByRole('button', { name: 'scaffold.newSession' })).toHaveLength(SAMPLE_GROUPS.length)
    expect(screen.getAllByRole('button', { name: 'scaffold.rowMenu' })).toHaveLength(rows)
    expect(screen.getAllByRole('button', { name: 'scaffold.rowArchive' })).toHaveLength(rows)
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
})
