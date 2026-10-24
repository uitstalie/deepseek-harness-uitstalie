/**
 * Tests for the doctor — the store's health checks, all against hand-built snapshots.
 *
 * The severity rule is what is being tested as much as the detection: anything that breaks
 * a *write* is an error, anything that misleads a *reader* is a warning.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { type Timestamp } from './entity.ts'

import { checkStore, errorCount, renderDoctorReport, warningCount, type Snapshot } from './doctor.ts'

const CONFIG = `---
type: config
schema: config/v1
issue_types: [task]
kb_types: [runbook]
priorities: [S1, S3]
statuses:
  - { name: todo, order: 10 }
  - { name: closed, order: 90 }
closed: [closed]
resolutions: [fixed]
transitions:
  - [todo, closed]
---
`

const issue = (_key: string, project = 'DH', extra = ''): string => `---
schema: issue/v1
type: issue
project: ${project}
issue_type: task
status: todo
summary: one
priority: S3
tags: []
links: []
revision: 1
created_at: 2026-10-15T12:00:00Z
updated_at: 2026-10-15T12:00:00Z
reporter: human:me
kb_refs: []
conflicted: false
---
${extra}
`

const snapshot = (overrides: Partial<Snapshot> = {}): Snapshot => Object.freeze({
  root: '/store',
  configText: CONFIG,
  issues: Object.freeze([Object.freeze({ path: 'projects/DH/issues/DH-1.md', project: 'DH', key: 'DH-1', text: issue('DH-1') })]),
  commentFiles: Object.freeze([]),
  counters: Object.freeze([]),
  locks: Object.freeze([]),
  git: Object.freeze({ repository: true, clean: true, attributes: true, ahead: 0 }),
  ...overrides,
})

const codes = (result: ReturnType<typeof checkStore>): readonly string[] => result.problems.map(problem => problem.code)

describe('doctor: a healthy store', () => {
  it('says nothing and counts what it saw', () => {
    const report = checkStore(snapshot())
    assert.equal(report.ok, true)
    assert.deepEqual(report.problems, [])
    assert.equal(report.summary.issues, 1)
    assert.equal(report.summary.projects, 1)
    assert.match(renderDoctorReport(report), /没有发现问题/)
  })
})

describe('doctor: errors are things that break a write', () => {
  it('an unreadable vocabulary stops everything', () => {
    // `exactOptionalPropertyTypes` means the key is absent, not present-and-undefined.
    const bare = { ...snapshot() } as Record<string, unknown>
    delete bare.configText
    const report = checkStore(bare as Snapshot)
    assert.equal(report.ok, false)
    assert.deepEqual(codes(report), ['config-missing'])

    const broken = checkStore(snapshot({ configText: CONFIG.replace('[todo, closed]', '[todo, nowhere]') }))
    assert.equal(broken.ok, false)
    assert.deepEqual(codes(broken), ['config-invalid'])
    assert.match(renderDoctorReport(broken), /unknown status "nowhere"/)
  })

  it('catches a key that does not match its file name', () => {
    const report = checkStore(snapshot({
      issues: Object.freeze([Object.freeze({ path: 'projects/DH/issues/DH-2.md', project: 'DH', key: 'DH-1', text: issue('DH-1') })]),
    }))
    assert.deepEqual(codes(report), ['key-mismatch'])
  })

  it('catches a duplicate key and a project that disagrees with the key', () => {
    const twice = checkStore(snapshot({
      issues: Object.freeze([
        Object.freeze({ path: 'projects/DH/issues/DH-1.md', project: 'DH', key: 'DH-1', text: issue('DH-1') }),
        Object.freeze({ path: 'projects/DH/issues/DH-1.md', project: 'DH', key: 'DH-1', text: issue('DH-1') }),
      ]),
    }))
    assert.ok(codes(twice).includes('key-duplicate'))

    const wrongProject = checkStore(snapshot({
      issues: Object.freeze([Object.freeze({ path: 'projects/KB/issues/DH-1.md', project: 'KB', key: 'DH-1', text: issue('DH-1') })]),
    }))
    assert.ok(codes(wrongProject).includes('project-mismatch'))
  })

  it('catches two machines that claimed the same block', () => {
    const counters = (machine: string) => Object.freeze({
      machineId: machine,
      path: `counters/${machine}.json`,
      raw: JSON.stringify({
        schema: 'counters/v1',
        machine_id: machine,
        projects: { DH: { next: 2, blocks: [[1, 100]] } },
      }),
    })
    const report = checkStore(snapshot({ counters: Object.freeze([counters('aaaa'), counters('bbbb')]) }))
    assert.equal(report.ok, false)
    assert.deepEqual(codes(report), ['counters-overlap'])
    assert.match(renderDoctorReport(report), /overlaps/)
  })

  it('accepts adjacent blocks from two machines, and refuses overlapping ones from one', () => {
    const ok = checkStore(snapshot({
      counters: Object.freeze([
        Object.freeze({ machineId: 'aaaa', path: 'counters/aaaa.json', raw: JSON.stringify({ schema: 'counters/v1', machine_id: 'aaaa', projects: { DH: { next: 2, blocks: [[1, 100]] } } }) }),
        Object.freeze({ machineId: 'bbbb', path: 'counters/bbbb.json', raw: JSON.stringify({ schema: 'counters/v1', machine_id: 'bbbb', projects: { DH: { next: 102, blocks: [[101, 200]] } } }) }),
      ]),
    }))
    assert.equal(ok.ok, true, JSON.stringify(ok.problems))

    const overlap = checkStore(snapshot({
      counters: Object.freeze([
        Object.freeze({ machineId: 'aaaa', path: 'counters/aaaa.json', raw: JSON.stringify({ schema: 'counters/v1', machine_id: 'aaaa', projects: { DH: { next: 51, blocks: [[1, 100], [50, 150]] } } }) }),
      ]),
    }))
    assert.ok(codes(overlap).includes('counters-block-overlap'))
  })

  it('refuses a counters file that does not parse', () => {
    const report = checkStore(snapshot({
      counters: Object.freeze([Object.freeze({ machineId: 'aaaa', path: 'counters/aaaa.json', raw: '{ not json' })]),
    }))
    assert.deepEqual(codes(report), ['counters-invalid'])
  })
})

describe('doctor: warnings are things that mislead a reader', () => {
  it('flags a conflicted issue, a leftover lock, and a comment file with no issue', () => {
    const report = checkStore(snapshot({
      issues: Object.freeze([Object.freeze({
        path: 'projects/DH/issues/DH-1.md',
        project: 'DH',
        key: 'DH-1',
        text: issue('DH-1').replace('conflicted: false', 'conflicted: true'),
      })]),
      commentFiles: Object.freeze([Object.freeze({
        path: 'projects/DH/comments/DH-9.md',
        key: 'DH-9',
        text: '<!-- c-a1b2-1 | author=human:me | created_at=2026-10-15T12:00:00Z | revision=1 -->\norphan\n',
      })]),
      locks: Object.freeze(['.jira/locks/DH-1.lock']),
    }))
    assert.equal(report.ok, true, 'warnings do not make the store unhealthy')
    assert.deepEqual([...codes(report)].sort(), ['comments-orphan', 'conflicted', 'lock-left'])
    assert.equal(errorCount(report), 0)
    assert.equal(warningCount(report), 3)
    assert.equal(report.summary.conflicted, 1)
  })

  it('flags a missing repository, missing attributes, dirt and unpushed work', () => {
    assert.deepEqual(codes(checkStore(snapshot({ git: { repository: false } }))), ['git-missing'])
    assert.deepEqual(
      [...codes(checkStore(snapshot({ git: { repository: true, clean: false, attributes: false, ahead: 2 } })))].sort(),
      ['git-ahead', 'git-attributes', 'git-dirty'],
    )
  })

  it('catches a duplicate comment id inside one file', () => {
    const text = '<!-- c-a1b2-1 | author=human:me | created_at=2026-10-15T12:00:00Z | revision=1 -->\na\n'
    const report = checkStore(snapshot({
      commentFiles: Object.freeze([Object.freeze({ path: 'projects/DH/comments/DH-1.md', key: 'DH-1', text: text + text })]),
    }))
    assert.deepEqual(codes(report), ['comment-id-duplicate'])
  })

  it('accepts the same comment id in two different issues', () => {
    // Numbering is per issue file (decision 68), so this is the normal case, not a clash.
    const text = '<!-- c-a1b2-1 | author=human:me | created_at=2026-10-15T12:00:00Z | revision=1 -->\na\n'
    const report = checkStore(snapshot({
      issues: Object.freeze([
        Object.freeze({ path: 'projects/DH/issues/DH-1.md', project: 'DH', key: 'DH-1', text: issue('DH-1') }),
        Object.freeze({ path: 'projects/DH/issues/DH-2.md', project: 'DH', key: 'DH-2', text: issue('DH-2') }),
      ]),
      commentFiles: Object.freeze([
        Object.freeze({ path: 'projects/DH/comments/DH-1.md', key: 'DH-1', text }),
        Object.freeze({ path: 'projects/DH/comments/DH-2.md', key: 'DH-2', text }),
      ]),
    }))
    assert.equal(report.ok, true)
    assert.deepEqual(codes(report), [])
  })
})

describe('doctor: an expired claim is reported (decision 61)', () => {
  it('warns that the issue can be reclaimed, and names the holder', () => {
    const expired = snapshot({
      issues: Object.freeze([{
        path: 'projects/DH/issues/DH-1.md',
        project: 'DH',
        key: 'DH-1',
        text: [
          '---',
          'schema: issue/v1',
          'type: issue',
          'project: DH',
          'issue_type: task',
          'status: todo',
          'summary: leased',
          'priority: S3',
          'assignee: agent:one|dsh|m-a|s-1',
          'claimed_at: 2026-10-15T12:00:00Z',
          'lease_expires_at: 2026-10-15T14:00:00Z',
          '---',
          '',
        ].join('\n'),
      }]),
    })
    const lapsed = checkStore(expired, '2026-10-15T15:00:00Z' as Timestamp)
    const found = lapsed.problems.filter(problem => problem.code === 'lease-expired')
    assert.equal(found.length, 1)
    assert.match(found[0]?.message ?? '', /claimed by agent:one\|dsh\|m-a\|s-1 but its lease expired at 2026-10-15T14:00:00Z/)

    // While the lease is live there is nothing to report, and without a clock nothing is claimed.
    assert.equal(checkStore(expired, '2026-10-15T13:00:00Z' as Timestamp).problems.some(p => p.code === 'lease-expired'), false)
    assert.equal(checkStore(expired).problems.some(p => p.code === 'lease-expired'), false, 'pure without a clock')
  })

  it('says nothing about a closed issue whose claim is history (DPMJ-401)', () => {
    // A closed issue keeps the claim it was worked under; "it can be reclaimed" is meaningless
    // there, and reporting it made the warning list grow with the ledger instead of with the work.
    const closedClaim = snapshot({
      issues: Object.freeze([{
        path: 'projects/DH/issues/DH-2.md',
        project: 'DH',
        key: 'DH-2',
        text: [
          '---',
          'schema: issue/v1',
          'type: issue',
          'project: DH',
          'issue_type: task',
          'status: closed',
          'resolution: fixed',
          'summary: done',
          'priority: S3',
          'assignee: agent:one|dsh|m-a|s-1',
          'claimed_at: 2026-10-15T12:00:00Z',
          'lease_expires_at: 2026-10-15T14:00:00Z',
          '---',
          '',
        ].join('\n'),
      }]),
    })
    const report = checkStore(closedClaim, '2026-10-15T15:00:00Z' as Timestamp)
    assert.equal(report.problems.some(problem => problem.code === 'lease-expired'), false)
  })
})

describe('doctor: the summary reports what is on disk (DPMJ-401)', () => {
  it('counts the registered tags instead of printing a hard-coded zero', () => {
    assert.equal(checkStore(snapshot({ tags: 3 })).summary.tags, 3)
    assert.equal(checkStore(snapshot()).summary.tags, 0, 'a snapshot without tags is honest about knowing none')
    assert.match(renderDoctorReport(checkStore(snapshot({ tags: 3 }))), /3/)
  })
})

/** A generated file's head, in the exact shape `generate.ts` writes (decision 79). */
const generatedText = (sourceTree: string): string =>
  '<!-- generated by dsh-jira — do not edit by hand\n'
  + '     generated_at: 2026-10-15T12:00:00Z\n'
  + `     source_tree: ${sourceTree}\n`
  + '-->\n\ncontent\n'

describe('doctor: generated files are checked against their own head (decisions 39/79/120)', () => {
  it('flags a file that was never generated, one without a head, and a stale one', () => {
    const report = checkStore(snapshot({
      sourceTree: 'tree-1',
      generated: Object.freeze([
        Object.freeze({ path: 'BOARD.md' }),
        Object.freeze({ path: 'index.md', text: '# hand-written, no head\n' }),
        Object.freeze({ path: 'tags/index.md', text: generatedText('tree-0') }),
      ]),
    }))
    assert.deepEqual(codes(report), ['generated-missing', 'generated-unmarked', 'generated-stale'])
    assert.equal(report.ok, true, 'all three are warnings: reads mislead, writes still work')
    assert.equal(report.summary.generatedStale, 3)
    assert.match(renderDoctorReport(report), /jira sync/, 'the fix is the command that regenerates and pushes (decision 179)')
  })

  it('stays quiet when the head carries the current tree hash', () => {
    const report = checkStore(snapshot({
      sourceTree: 'tree-1',
      generated: Object.freeze([
        Object.freeze({ path: 'BOARD.md', text: generatedText('tree-1') }),
        Object.freeze({ path: 'index.md', text: generatedText('tree-1') }),
      ]),
    }))
    assert.deepEqual(codes(report), [])
    assert.equal(report.summary.generatedStale, 0)
  })

  it('never calls log.md stale from its head — its input is the commit history, not the tree', () => {
    // The one exception (doctor.ts): `log.md`'s hash cannot prove freshness, so a mismatched head
    // is *not* reported; `jira generate --check` is the real test. Missing/unmarked still count.
    const report = checkStore(snapshot({
      sourceTree: 'tree-1',
      generated: Object.freeze([
        Object.freeze({ path: 'log.md', text: generatedText('tree-0') }),
        Object.freeze({ path: 'BOARD.md', text: generatedText('tree-0') }),
      ]),
    }))
    assert.deepEqual(codes(report), ['generated-stale'], 'only BOARD.md is flagged')
    assert.equal(report.problems[0]?.path, 'BOARD.md')
  })

  it('skips the check entirely without a source tree to compare against', () => {
    const report = checkStore(snapshot({
      generated: Object.freeze([Object.freeze({ path: 'BOARD.md', text: generatedText('tree-0') })]),
    }))
    assert.deepEqual(codes(report), [])
    assert.equal(report.summary.generatedStale, 0)
  })
})

describe('doctor: the remaining error codes', () => {
  it('rejects a key that is not a project key at all', () => {
    const report = checkStore(snapshot({
      issues: Object.freeze([Object.freeze({ path: 'projects/DH/issues/dh-1.md', project: 'DH', key: 'dh-1', text: issue('DH-1') })]),
    }))
    assert.deepEqual(codes(report), ['key-shape'])
  })

  it('catches a counter whose next fell behind its own first block', () => {
    const report = checkStore(snapshot({
      counters: Object.freeze([Object.freeze({
        machineId: 'aaaa',
        path: 'counters/aaaa.json',
        raw: JSON.stringify({ schema: 'counters/v1', machine_id: 'aaaa', projects: { DH: { next: 2, blocks: [[5, 100]] } } }),
      })]),
    }))
    assert.deepEqual(codes(report), ['counters-next-behind'])
    assert.equal(report.ok, false, 'a broken counter breaks writes')
  })

  it('rejects a comment file that does not parse', () => {
    const report = checkStore(snapshot({
      commentFiles: Object.freeze([Object.freeze({
        path: 'projects/DH/comments/DH-1.md',
        key: 'DH-1',
        text: '<!-- c-a1b2-1 author=no-pipes revision=1 -->\nbody\n',
      })]),
    }))
    assert.deepEqual(codes(report), ['comments-invalid'])
    assert.equal(report.ok, false)
  })
})
