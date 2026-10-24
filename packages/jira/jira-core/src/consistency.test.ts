/**
 * Tests for core/consistency — the checks that need two entities at once (C9).
 *
 * Decision 75's cross reference has two faces; a record where only one face was written is legal but
 * incomplete, and the doctor is the place that says so.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { checkConsistency, renderConsistency } from './consistency.ts'
import { type Identity, type Issue, type IssueKey, type Timestamp } from './entity.ts'
import { type KnowledgeEntry, sourceOf } from './kb.ts'

const issue = (over: Readonly<{ key: string; kbRefs?: readonly string[]; reporter?: string; assignee?: string }>): Issue => Object.freeze({
  key: over.key as IssueKey,
  project: over.key.slice(0, over.key.lastIndexOf('-')),
  issueType: 'task',
  status: 'todo',
  summary: `summary ${over.key}`,
  priority: 'S3',
  tags: Object.freeze([]),
  links: Object.freeze([]),
  kbRefs: Object.freeze([...(over.kbRefs ?? [])].map(ref => ref as never)),
  reporter: (over.reporter ?? 'human:me') as Identity,
  ...(over.assignee === undefined ? {} : { assignee: over.assignee as Identity }),
  revision: 1,
  createdAt: '2026-10-15T12:00:00Z' as Timestamp,
  updatedAt: '2026-10-15T12:00:00Z' as Timestamp,
  conflicted: false,
  body: '',
})

const entry = (over: Readonly<{ key: string; issues?: readonly string[]; machineId?: string }>): KnowledgeEntry => Object.freeze({
  key: over.key as KnowledgeEntry['key'],
  domain: 'locking',
  kbType: 'pitfall',
  title: `title ${over.key}`,
  tags: Object.freeze([]),
  source: sourceOf({
    machineId: over.machineId ?? 'm-known',
    os: 'linux',
    tool: 'dsh',
    capturedAt: '2026-10-15T12:00:00Z' as never,
  }),
  issues: Object.freeze([...(over.issues ?? [])].map(key => key as never)),
  body: '',
  bodyLine: 1,
})

const codes = (findings: readonly { code: string }[]): readonly string[] => findings.map(finding => finding.code)

describe('consistency: a reference has two faces', () => {
  it('is silent when both sides agree', () => {
    const findings = checkConsistency({
      issues: [issue({ key: 'DH-1', kbRefs: ['KB-1'], reporter: 'agent:x|dsh|m-known|s' })],
      knowledge: [entry({ key: 'KB-1', issues: ['DH-1'] })],
      registeredMachines: ['m-known'],
    })
    assert.deepEqual(findings, [])
  })

  it('names the missing side, in the direction it is missing', () => {
    const fromIssue = checkConsistency({
      issues: [issue({ key: 'DH-1', kbRefs: ['KB-1'], reporter: 'agent:x|dsh|m-known|s' })],
      knowledge: [entry({ key: 'KB-1', issues: [] })],
      registeredMachines: ['m-known'],
    })
    assert.deepEqual(codes(fromIssue), ['kb-ref-one-sided'])
    assert.match(fromIssue[0]?.message ?? '', /DH-1 references KB-1, but KB-1 does not list DH-1/)

    const fromEntry = checkConsistency({
      issues: [issue({ key: 'DH-1', reporter: 'agent:x|dsh|m-known|s' })],
      knowledge: [entry({ key: 'KB-1', issues: ['DH-1'] })],
      registeredMachines: ['m-known'],
    })
    assert.deepEqual(codes(fromEntry), ['kb-issue-one-sided'])
    assert.match(fromEntry[0]?.message ?? '', /KB-1 came from DH-1/)
  })

  it('stays quiet about a dangling reference, which is lint\'s job', () => {
    const findings = checkConsistency({
      issues: [issue({ key: 'DH-1', kbRefs: ['KB-404'], reporter: 'agent:x|dsh|m-known|s' })],
      knowledge: [],
      registeredMachines: ['m-known'],
    })
    assert.deepEqual(findings, [], 'lint reports dangling with a citation to the file; repeating it here would be noise')
  })
})

describe('consistency: machines the store mentions', () => {
  it('asks for a registry entry for every machine it can name', () => {
    const findings = checkConsistency({
      issues: [
        issue({ key: 'DH-1', reporter: 'agent:x|dsh|m-a|s' }),
        issue({ key: 'DH-2', reporter: 'agent:x|dsh|m-b|s', assignee: 'agent:y|dsh|m-c|s2' }),
      ],
      knowledge: [entry({ key: 'KB-1', machineId: 'm-d' })],
      registeredMachines: ['m-a'],
    })
    assert.deepEqual(codes(findings), ['machine-unregistered', 'machine-unregistered', 'machine-unregistered'])
    assert.deepEqual(findings.map(finding => finding.message.slice(0, 4)), ['m-b ', 'm-c ', 'm-d '])
  })

  it('ignores a human identity, which carries no machine', () => {
    const findings = checkConsistency({
      issues: [issue({ key: 'DH-1', reporter: 'human:daiqc' })],
      knowledge: [],
      registeredMachines: [],
    })
    assert.deepEqual(findings, [])
  })
})

describe('consistency: rendering', () => {
  it('prints nothing for a clean store, and one line per finding otherwise', () => {
    assert.equal(renderConsistency([]), '')
    const text = renderConsistency([{ severity: 'warning', code: 'x', message: 'y' }])
    assert.equal(text, '! x: y\n')
  })
})
