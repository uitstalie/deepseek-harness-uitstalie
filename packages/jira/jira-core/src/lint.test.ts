/**
 * Tests for core/lint — structural legality, and the boundary the design drew around it.
 *
 * The most important test here is the *negative* one: an issue that is blocked but already claimed
 * is a **policy** matter, and lint must stay silent about it. A checker that reports things nobody
 * agreed are wrong stops being believed (decision 94, §11.6).
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { type Identity, type Issue, type IssueKey, type Timestamp, issueRelPath } from './entity.ts'
import { type KnowledgeEntry, knowledgePath, sourceOf } from './kb.ts'
import { lintStore, renderLintReport, type LintInput } from './lint.ts'
import { type Vocab, parseVocab } from './vocab.ts'

const vocab: Vocab = (() => {
  const parsed = parseVocab(readFileSync(new URL('../fixtures/config.md', import.meta.url), 'utf8'))
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error))
  return parsed.value
})()

const issue = (over: Readonly<{
  key: string
  status?: string
  issueType?: string
  priority?: string
  tags?: readonly string[]
  links?: readonly { type: 'is_blocked_by'; target: string }[]
  kbRefs?: readonly string[]
  assignee?: string
}>): Issue => Object.freeze({
  key: over.key as IssueKey,
  project: over.key.slice(0, over.key.lastIndexOf('-')),
  issueType: over.issueType ?? 'task',
  status: over.status ?? 'todo',
  summary: `summary of ${over.key}`,
  priority: over.priority ?? 'S3',
  tags: Object.freeze([...(over.tags ?? [])]),
  links: Object.freeze((over.links ?? []).map(link => Object.freeze({ type: link.type, target: link.target as IssueKey }))),
  ...(over.assignee === undefined ? {} : { assignee: over.assignee as Identity }),
  revision: 1,
  createdAt: '2026-10-15T12:00:00Z' as Timestamp,
  updatedAt: '2026-10-15T12:00:00Z' as Timestamp,
  reporter: 'human:me' as Identity,
  kbRefs: Object.freeze([...(over.kbRefs ?? [])].map(ref => ref as never)),
  conflicted: false,
  body: '',
})

type EntryOverrides = Readonly<{ key: string; domain?: string; kbType?: string; issues?: readonly string[] }>

const entry = (over: EntryOverrides): KnowledgeEntry => Object.freeze({
  key: over.key as KnowledgeEntry['key'],
  domain: over.domain ?? 'locking',
  kbType: over.kbType ?? 'pitfall',
  title: `title of ${over.key}`,
  tags: Object.freeze([]),
  source: sourceOf({ machineId: 'm-1', os: 'linux', tool: 'dsh', capturedAt: '2026-10-15T12:00:00Z' as never }),
  issues: Object.freeze([...(over.issues ?? [])].map(key => key as never)),
  body: '',
  bodyLine: 1,
})

const input = (over: Partial<LintInput> = {}): LintInput => Object.freeze({
  issues: Object.freeze([issue({ key: 'DH-1' })]),
  knowledge: Object.freeze([entry({ key: 'KB-1', issues: ['DH-1'] })]),
  broken: Object.freeze([]),
  vocab,
  knownTags: Object.freeze([{ name: 'windows' }]),
  ...over,
})

const codes = (result: ReturnType<typeof lintStore>): readonly string[] => result.findings.map(finding => finding.code)

describe('lint: a legal store is silent', () => {
  it('reports nothing for issues and knowledge that hang together', () => {
    const report = lintStore(input({ issues: Object.freeze([issue({ key: 'DH-1', tags: ['windows'] })]) }))
    assert.equal(report.ok, true)
    assert.deepEqual(report.findings, [])
    assert.deepEqual(report.counts, { issues: 1, knowledge: 1, references: 1 })
    assert.match(renderLintReport(report), /没有结构问题/)
  })
})

describe('lint: vocabulary membership', () => {
  it('catches a status, type or priority the vocabulary does not declare', () => {
    assert.deepEqual(codes(lintStore(input({ issues: Object.freeze([issue({ key: 'DH-1', status: 'done' })]) }))), ['status-unknown'])
    assert.deepEqual(codes(lintStore(input({ issues: Object.freeze([issue({ key: 'DH-1', issueType: 'chore' })]) }))), ['issue-type-unknown'])
    assert.deepEqual(codes(lintStore(input({ issues: Object.freeze([issue({ key: 'DH-1', priority: 'P1' })]) }))), ['priority-unknown'])
  })

  it('catches an unregistered tag and a kb_type outside kb_types', () => {
    assert.deepEqual(codes(lintStore(input({ issues: Object.freeze([issue({ key: 'DH-1', tags: ['nope'] })]) }))), ['tag-unregistered'])
    assert.deepEqual(codes(lintStore(input({ knowledge: Object.freeze([entry({ key: 'KB-1', kbType: 'note' })]) }))), ['kb-type-unknown'])
  })

  it('names the file a finding is in, using the one path rule (decision 182)', () => {
    const report = lintStore(input({ issues: Object.freeze([issue({ key: 'DH-1', status: 'done' })]) }))
    assert.equal(report.findings[0]?.path, issueRelPath('DH', 'DH-1' as never))
    const kb = lintStore(input({ knowledge: Object.freeze([entry({ key: 'KB-1', kbType: 'note' })]) }))
    assert.equal(kb.findings[0]?.path, knowledgePath('locking', 'KB-1' as never))
  })
})

describe('lint: dangling references (decision 94)', () => {
  it('catches an issue link pointing at a key that does not exist', () => {
    const report = lintStore(input({
      issues: Object.freeze([issue({ key: 'DH-1', links: [{ type: 'is_blocked_by', target: 'DH-404' }] })]),
    }))
    assert.deepEqual(codes(report), ['link-dangling'])
    assert.match(renderLintReport(report), /DH-404, which does not exist/)
  })

  it('catches a kb_ref and a knowledge→issue reference that point nowhere', () => {
    assert.deepEqual(
      codes(lintStore(input({ issues: Object.freeze([issue({ key: 'DH-1', kbRefs: ['KB-404'] })]) }))),
      ['kb-ref-dangling'],
    )
    assert.deepEqual(
      codes(lintStore(input({ knowledge: Object.freeze([entry({ key: 'KB-1', issues: ['DH-404'] })]) }))),
      ['kb-issue-dangling'],
    )
  })

  it('counts every reference it examined, so silence is not the same as not looking', () => {
    const report = lintStore(input({
      issues: Object.freeze([issue({ key: 'DH-1', links: [{ type: 'is_blocked_by', target: 'DH-1' }], kbRefs: ['KB-1'] })]),
    }))
    assert.equal(report.counts.references, 3, 'one link, one kb_ref, one knowledge→issue')
    assert.equal(report.ok, true)
  })

  it('reports a file it could not read as an error, not as silence', () => {
    const report = lintStore(input({ broken: Object.freeze([{ path: 'knowledge/odd/KB-9.md', reason: 'frontmatter does not parse' }]) }))
    assert.equal(report.ok, false)
    assert.deepEqual(codes(report), ['file-unreadable'])
  })
})

describe('lint: policy is not structure (§11.6)', () => {
  it('says nothing about a blocked issue that is already claimed', () => {
    // Both facts are individually legal; whether that combination is *sensible* is a human
    // judgement, and the design keeps it out of CI on purpose.
    const report = lintStore(input({
      issues: Object.freeze([
        issue({ key: 'DH-1' }),
        issue({ key: 'DH-2', links: [{ type: 'is_blocked_by', target: 'DH-1' }], assignee: 'human:someone' }),
      ]),
    }))
    assert.equal(report.ok, true)
    assert.deepEqual(report.findings, [])
  })

  it('says nothing about a closed issue with no resolution either', () => {
    // The write path requires one (decision 25); a file that predates the rule is a different
    // question, and lint is not where it becomes fatal.
    assert.deepEqual(lintStore(input({ issues: Object.freeze([issue({ key: 'DH-1', status: 'closed' })]) })).findings, [])
  })
})
