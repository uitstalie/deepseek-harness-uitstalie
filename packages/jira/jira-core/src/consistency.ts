/**
 * core/consistency — the checks that need two entities at once (C9).
 *
 * `lint` (decision 126) verifies that a reference **resolves**. This module verifies that a
 * reference is **mutual**, which is a different question and cannot be answered from one side:
 * decision 75 says `issues[].kb_refs[]` and `knowledge[].issues[]` are two faces of one fact, so an
 * issue that points at a knowledge entry nobody links back is an incomplete record — not an error
 * (either side may legitimately be written first) but exactly the kind of drift a doctor exists to
 * surface.
 *
 * It also answers "who is this machine?" for every machine the store mentions: a `machine_id` with
 * no `machines/<id>.md` has no label and no first-seen date, so a reader cannot tell which machine
 * wrote what (decision 91).
 */

import { type Issue } from './entity.ts'
import { type KnowledgeEntry } from './kb.ts'
import { machineIdOf } from './kb.ts'

export type ConsistencyFinding = Readonly<{
  severity: 'warning'
  code: string
  message: string
}>

export type ConsistencyInput = Readonly<{
  issues: readonly Issue[]
  knowledge: readonly KnowledgeEntry[]
  /** Machine ids that have a `machines/<id>.md` entry. */
  registeredMachines: readonly string[]
}>

export const checkConsistency = (input: ConsistencyInput): readonly ConsistencyFinding[] => {
  const findings: ConsistencyFinding[] = []
  const byKey = new Map(input.knowledge.map(entry => [String(entry.key), entry]))
  const issueByKey = new Map(input.issues.map(issue => [String(issue.key), issue]))
  const registered = new Set(input.registeredMachines)

  for (const issue of input.issues) {
    for (const reference of issue.kbRefs) {
      const entry = byKey.get(String(reference))
      if (entry === undefined) continue // dangling: `jira lint` reports that, with a citation.
      if (!entry.issues.some(key => String(key) === String(issue.key))) {
        findings.push(Object.freeze({
          severity: 'warning',
          code: 'kb-ref-one-sided',
          message: `${String(issue.key)} references ${String(entry.key)}, but ${String(entry.key)} does not list ${String(issue.key)}`,
        }))
      }
    }
  }

  for (const entry of input.knowledge) {
    for (const reference of entry.issues) {
      const issue = issueByKey.get(String(reference))
      if (issue === undefined) continue // dangling: reported by lint.
      if (!issue.kbRefs.some(key => String(key) === String(entry.key))) {
        findings.push(Object.freeze({
          severity: 'warning',
          code: 'kb-issue-one-sided',
          message: `${String(entry.key)} came from ${String(issue.key)}, but ${String(issue.key)} does not reference ${String(entry.key)}`,
        }))
      }
    }
  }

  // Every machine this store mentions should have a registry entry, or its name is unknowable.
  const mentioned = new Set<string>()
  for (const issue of input.issues) {
    const machine = machineIdOf(String(issue.reporter))
    if (machine !== undefined) mentioned.add(machine)
    if (issue.assignee !== undefined) {
      const assigned = machineIdOf(String(issue.assignee))
      if (assigned !== undefined) mentioned.add(assigned)
    }
  }
  for (const entry of input.knowledge) {
    if (entry.source.machineId !== '') mentioned.add(entry.source.machineId)
  }
  for (const machine of [...mentioned].sort()) {
    if (!registered.has(machine)) {
      findings.push(Object.freeze({
        severity: 'warning',
        code: 'machine-unregistered',
        message: `${machine} is referenced but has no machines/${machine}.md (run on that machine: jira machines label --name <label>)`,
      }))
    }
  }

  return Object.freeze(findings)
}

export const renderConsistency = (findings: readonly ConsistencyFinding[]): string =>
  findings.length === 0 ? '' : `${findings.map(finding => `! ${finding.code}: ${finding.message}`).join('\n')}\n`
