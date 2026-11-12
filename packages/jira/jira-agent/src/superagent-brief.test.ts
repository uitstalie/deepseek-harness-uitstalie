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
