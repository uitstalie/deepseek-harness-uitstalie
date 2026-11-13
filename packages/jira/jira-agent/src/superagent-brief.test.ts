/**
 * Regression guard for the brief-writing rules: each case in `COUNTEREXAMPLES` is a real
 * correction from the 2026-11-12 dispatches, mapped to the static rule that must prevent a repeat.
 * The prompt is the contract here; these assertions fail if a later edit drops a rule.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SUPERAGENT_SECTION } from './superagent.ts'

/** One corrected dispatch, mapped to the rule that must survive in the static section. */
const COUNTEREXAMPLES = [
  {
    correction: 'invented a reporting scope: "counts only, no names" removed the usable identity column',
    rule: /Never invent a standard, scope, policy, evidence rule or stage classification/u,
  },
  {
    correction: 'wrote organization stage/commitment judgment into a skill',
    rule: /Never write acceptance criteria, skill red lines or stage rules into skills/u,
  },
  {
    correction: 'invented an intermediate "clue" state instead of "source unverifiable, do not adopt"',
    rule: /When a standard you need is missing, ask the person before dispatching/u,
  },
  {
    correction: 'guessed the accepted evidence-source range (TOPAZX) and presented it as a rule',
    rule: /never present a guess as a rule/u,
  },
  {
    correction: 'used `ensure` to check whether a workspace exists and registered it twice',
    rule: /`ensure`, `rename_workspace` and `remove_workspace` are writes/u,
  },
] as const

void describe('superagent: brief-writing rules', () => {
  void it('keeps one rule for every corrected failure mode', () => {
    const text = String(SUPERAGENT_SECTION.text)
    for (const example of COUNTEREXAMPLES) assert.match(text, example.rule, example.correction)
  })

  void it('makes every dispatched brief fill the four slots and the result contract', () => {
    const text = String(SUPERAGENT_SECTION.text)
    assert.match(text, /Brief slots \(fill every slot; no slot has a default\)/u)
    for (const slot of ['目标:', '验收:', '边界:', '证据来源:']) assert.ok(text.includes(slot), slot)
    assert.match(text, /status: done \| blocked \| failed \| unverified/u)
    assert.match(text, /task_id: <only when supplied>/u)
    assert.match(text, /artifacts: <workspace-relative paths> · checks: <commands actually run>/u)
    assert.match(text, /No report or no artifact means not done/u)
    assert.match(text, /Do not use interactive ask_user_question/u)
    assert.match(text, /Do not require memory_search/u)
    assert.match(text, /do not modify ACLs, admin permissions, or system directories/u)
    assert.doesNotMatch(text, /Windows/u)
  })

  void it('adds no second section for the template', () => {
    assert.equal(SUPERAGENT_SECTION.name, 'superagent:dispatcher')
    assert.equal(SUPERAGENT_SECTION.order, 702)
    assert.doesNotMatch(String(SUPERAGENT_SECTION.text), /brief-template/u)
  })

  void it('states composition, one objective, citation and person-owned policy', () => {
    const text = String(SUPERAGENT_SECTION.text)
    assert.match(text, /A workspace brief has exactly two sources/u)
    assert.match(text, /what the person explicitly asked for/u)
    assert.match(text, /the destination workspace's own conventions/u)
    assert.match(text, /One brief carries one objective and its acceptance check/u)
    assert.match(text, /cite each convention you rely on by workspace id and file/u)
    assert.match(text, /Policies and organization judgment belong to the person/u)
    assert.match(text, /only the person may change them/u)
    assert.match(text, /a memory line is not the fix/u)
  })
})
