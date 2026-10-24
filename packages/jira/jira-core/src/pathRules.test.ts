/**
 * Tests for decision 182 — the ledger's path rules have **one source** (`entity.ts`), and every
 * surface agrees on it.
 *
 * The audit found the issue path written out three times (`io.ts`'s absolute join, `store.ts`'s
 * `storePaths`, and two hand-built `join('projects', …)` inside `store.ts` itself), plus a
 * `projectPath` that meant "absolute" in one file and "store-relative" in another. These tests pin
 * the agreement, so a hand-built re-implementation at any call site fails here.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { commentRelPath, issueRelPath, projectRelPath, type IssueKey } from './entity.ts'
import { commentsPath, fileStore, issuePath, projectPath } from './io.ts'
import { storePaths } from './store.ts'

const KEY = 'DH-12' as IssueKey

describe('path rules: one source, every surface agrees (decision 182)', () => {
  it('the relative rules are literal and posix (they double as git pathspecs)', () => {
    assert.equal(issueRelPath('DH', KEY), 'projects/DH/issues/DH-12.md')
    assert.equal(commentRelPath('DH', KEY), 'projects/DH/comments/DH-12.md')
    assert.equal(projectRelPath('DH'), 'projects/DH/project.md')
    assert.equal(/\\/u.test(issueRelPath('DH', KEY)), false, 'no backslash may ever appear')
  })

  it('the absolute forms are the relative rule plus a root — from io and from storePaths alike', () => {
    const store = fileStore(join('the-root'))
    const absoluteIssue = join('the-root', 'projects', 'DH', 'issues', 'DH-12.md')
    const absoluteComments = join('the-root', 'projects', 'DH', 'comments', 'DH-12.md')
    const absoluteProject = join('the-root', 'projects', 'DH', 'project.md')

    assert.equal(issuePath(store, 'DH', KEY), absoluteIssue)
    assert.equal(storePaths.issue('the-root', 'DH', KEY), absoluteIssue)
    assert.equal(commentsPath(store, 'DH', KEY), absoluteComments)
    assert.equal(storePaths.comments('the-root', 'DH', KEY), absoluteComments)
    assert.equal(projectPath(store, 'DH'), absoluteProject)
  })

  it('absolute and relative agree with each other after splitting on posix separators', () => {
    const store = fileStore(join('the-root'))
    assert.equal(issuePath(store, 'DH', KEY), join('the-root', ...issueRelPath('DH', KEY).split('/')))
    assert.equal(commentsPath(store, 'DH', KEY), join('the-root', ...commentRelPath('DH', KEY).split('/')))
    assert.equal(projectPath(store, 'DH'), join('the-root', ...projectRelPath('DH').split('/')))
  })

  it('projectPath has exactly one meaning now: the absolute one (decision 182)', () => {
    // The old store-relative `projectPath` in project.ts was renamed `projectRelPath`; if the
    // ambiguous name ever grows a second meaning again, this import-shape check breaks.
    assert.equal(typeof projectRelPath, 'function', 'the relative form keeps its new name')
    assert.equal(projectRelPath('DH'), 'projects/DH/project.md')
  })
})
