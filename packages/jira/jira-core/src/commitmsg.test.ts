/**
 * Tests for core/commitmsg — the commit binding rules (decision 67).
 *
 * These are the rules a human meets at the moment they type a commit message, so the tests are
 * written as the cases that actually happen: a key, no key, several keys, the deliberate escape
 * hatch, and the messages git writes itself.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { applyBranchPrefix, branchKeyFrom, checkCommitMessage, firstLine, hasNoIssueMarker, isExempt, keysIn, renderVerdict } from './commitmsg.ts'

describe('commitmsg: finding keys', () => {
  it('finds every key, once each, wherever it appears', () => {
    assert.deepEqual(keysIn('DH-12: fix it'), ['DH-12'])
    assert.deepEqual(keysIn('DH-12 and KB-7, again DH-12'), ['DH-12', 'KB-7'])
    assert.deepEqual(keysIn('nothing here'), [])
    assert.deepEqual(keysIn('dh-12 is not a key'), [])
  })

  it('accepts shapes that only existence can reject', () => {
    // `UTF-8` and `ISO-8601` both match the key shape. That is deliberate: the regex cannot know
    // what exists, so the store does — which is why every key in a message is checked.
    assert.deepEqual(keysIn('UTF-8 and ISO-8601 are not issues'), ['UTF-8', 'ISO-8601'])
    const verdict = checkCommitMessage('UTF-8: fix the encoding', { knownKeys: new Set(['DH-12']) })
    assert.equal(verdict.ok, false)
    if (!verdict.ok) assert.deepEqual(verdict.missing, ['UTF-8'])
  })
})

describe('commitmsg: the exemptions (decision 67)', () => {
  it('exempts the messages git writes', () => {
    for (const subject of ['Merge branch main', 'Revert "DH-12: something"', 'fixup! DH-12: x', 'squash! DH-12: x']) {
      assert.equal(isExempt(`${subject}\n\nbody`), true, subject)
      assert.equal(checkCommitMessage(subject).ok, true)
    }
  })

  it('honours the source git reports, without exempting reused messages', () => {
    // `merge` / `squash` are git's own text. `commit` (i.e. `-C`/`-c`) is NOT exempt: the reused
    // message is still the one that ends up in the log.
    assert.equal(checkCommitMessage('two unrelated words', { source: 'merge' }).ok, true)
    assert.equal(checkCommitMessage('two unrelated words', { source: 'squash' }).ok, true)
    assert.equal(checkCommitMessage('two unrelated words', { source: 'commit' }).ok, false)
    assert.equal(checkCommitMessage('DH-1: reused', { source: 'commit' }).ok, true)
  })

  it('does not exempt a message that merely mentions merging', () => {
    assert.equal(isExempt('Merge the two configs'), true, 'this is exactly the text git writes')
    assert.equal(isExempt('merging the two configs'), false, 'lowercase is a normal subject')
  })
})

describe('commitmsg: [no-issue]', () => {
  it('must be on the first line', () => {
    assert.equal(hasNoIssueMarker('chore: bump [no-issue]'), true)
    assert.equal(hasNoIssueMarker('chore: bump\n\n[no-issue]'), false, 'buried in the body is invisible in git log --oneline')
    assert.equal(checkCommitMessage('chore: bump [no-issue]').ok, true)
    assert.equal(checkCommitMessage('chore: bump\n\n[no-issue]').ok, false)
  })
})

describe('commitmsg: existence', () => {
  const known = new Set(['DH-12', 'KB-7'])

  it('accepts a message whose keys all exist', () => {
    const verdict = checkCommitMessage('DH-12: fix it', { knownKeys: known })
    assert.deepEqual(verdict, { ok: true, kind: 'keyed', keys: ['DH-12'] })
  })

  it('refuses when ANY key is unknown, and names the unknown ones', () => {
    const verdict = checkCommitMessage('DH-12 and DH-404', { knownKeys: known })
    assert.equal(verdict.ok, false)
    if (!verdict.ok) {
      assert.deepEqual(verdict.keys, ['DH-12', 'DH-404'])
      assert.deepEqual(verdict.missing, ['DH-404'], 'one good key must not carry a bad one')
      assert.match(verdict.reason, /do not exist: DH-404/)
    }
  })

  it('refuses a message with no key at all, and says what to do', () => {
    const verdict = checkCommitMessage('fix something', { knownKeys: known })
    assert.equal(verdict.ok, false)
    if (!verdict.ok) {
      assert.match(verdict.reason, /no issue key/)
      const text = renderVerdict(verdict, 'fix something')
      assert.match(text, /\[no-issue\] on the first line/)
      assert.match(text, /DH-12: fix the wake lock/, 'the fix is shown, not just demanded')
      assert.match(text, /subject: fix something/)
    }
  })

  it('skips the existence check when no key set is supplied', () => {
    assert.equal(checkCommitMessage('DH-999: whatever').ok, true)
  })
})

describe('commitmsg: the branch prefix (prepare-commit-msg)', () => {
  it('reads a key off the branch name', () => {
    assert.equal(branchKeyFrom('DH-12-fix-wake-lock'), 'DH-12')
    assert.equal(branchKeyFrom('DH-12'), 'DH-12')
    assert.equal(branchKeyFrom('feature/DH-12'), undefined, 'the key must be at the start')
    assert.equal(branchKeyFrom('main'), undefined)
  })

  it('prefixes only when the message has no key of its own', () => {
    assert.equal(applyBranchPrefix('fix the wake lock\n', 'DH-12-fix'), 'DH-12: fix the wake lock\n')
    assert.equal(applyBranchPrefix('DH-13: another\n', 'DH-12-fix'), 'DH-13: another\n', 'the author wins')
    assert.equal(applyBranchPrefix('chore: bump [no-issue]\n', 'DH-12-fix'), 'chore: bump [no-issue]\n')
    assert.equal(applyBranchPrefix('fix it\n', 'main'), 'fix it\n')
  })

  it('tells the author when the branch had a key they forgot to use', () => {
    const verdict = checkCommitMessage('fix it', { branch: 'DH-12-fix' })
    assert.equal(verdict.ok, false)
    if (!verdict.ok) assert.match(verdict.reason, /the branch is DH-12/)
  })
})

describe('commitmsg: the subject is what matters', () => {
  it('reads the first line, tolerating a missing newline', () => {
    assert.equal(firstLine('one\ntwo'), 'one')
    assert.equal(firstLine('only'), 'only')
    assert.equal(firstLine(''), '')
  })
})
