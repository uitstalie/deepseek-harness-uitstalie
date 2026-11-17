/**
 * Bounded paging shared by the workspace toolset's read actions.
 *
 * A cursor is the offset of the next item, so a caller that repeats an
 * unchanged query walks the same order; the default page is 20 items and no
 * page exceeds 100. Callers never see the offset rule as a contract, only as
 * an opaque cursor, so a later ordering change cannot break a saved cursor.
 * @module @deepseek-ai/dsh-workspace-tools/paging
 */

import { WorkspaceRecordError } from './errors.ts'

/** Default page size of every list action. */
export const DEFAULT_PAGE_SIZE = 20

/** Largest page a caller may request. */
export const MAX_PAGE_SIZE = 100

/** One bounded page plus the cursor of the next page. */
export interface Page<T> {
  /** Items on this page. */
  readonly items: T[]
  /** Cursor of the next page; absent when this page is the last. */
  readonly nextCursor?: string
}

/**
 * Clamp a caller-supplied page size into the contract range.
 * @param limit - requested page size.
 * @returns the effective page size.
 */
export function pageSize(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_SIZE
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_PAGE_SIZE)
}

/**
 * Cut one bounded page out of an ordered list.
 * @param items - complete ordered item list.
 * @param limit - requested page size.
 * @param cursor - opaque cursor returned by an earlier page.
 * @returns the page and the next cursor, when more items remain.
 * @throws WorkspaceRecordError when the cursor is not an offset this tool issued.
 */
export function pageOf<T>(items: readonly T[], limit: number | undefined, cursor: string | undefined): Page<T> {
  const size = pageSize(limit)
  const offset = parseCursor(cursor, items.length)
  const page = items.slice(offset, offset + size)
  const next = offset + page.length
  return {
    items: page,
    ...next < items.length ? { nextCursor: String(next) } : {},
  }
}

/**
 * Parse an opaque page cursor into an in-range offset.
 * @param cursor - cursor from an earlier page, or undefined for the first page.
 * @param length - number of items in the current result.
 * @returns the offset of the first item on this page.
 * @throws WorkspaceRecordError when the cursor is not a non-negative integer or is past the end.
 */
function parseCursor(cursor: string | undefined, length: number): number {
  if (cursor === undefined) return 0
  if (!/^\d+$/u.test(cursor)) {
    throw new WorkspaceRecordError(`invalid cursor ${JSON.stringify(cursor)}; pass the cursor a previous page returned`, 'WORKSPACE_CURSOR_INVALID')
  }
  const offset = Number(cursor)
  if (!Number.isSafeInteger(offset) || offset > length) {
    throw new WorkspaceRecordError(`invalid cursor ${JSON.stringify(cursor)}; pass the cursor a previous page returned`, 'WORKSPACE_CURSOR_INVALID')
  }
  return offset
}
