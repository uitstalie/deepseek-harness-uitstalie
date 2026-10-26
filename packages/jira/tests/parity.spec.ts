/**
 * Cross-package parity: the model's jira verbs and the CLI's command names are one external
 * contract, but the two packages cannot depend on each other. This group-level suite is the one
 * neutral place that reads both tables and fails when a verb is added, renamed, or dropped on one
 * side only.
 *
 * The map below is intentionally hand-written: it is the contract, and a new verb should force a
 * human to decide which CLI command serves it.
 *
 * @module @deepseek-ai/dsh-jira/tests/parity
 */

import { describe, expect, it } from 'vitest'
import { COMMAND_NAMES } from '../jira-cli/src/main.ts'
import { ISSUE_PARAMETERS, LIST_TOOL_NAME, KB_PARAMETERS } from '../jira-agent/src/index.ts'
import { JIRA_SUBCOMMANDS } from '../jira-agent/src/command.ts'

/** Issue tool verbs and the CLI command each one must be reachable through. */
const ISSUE_COMMANDS: Readonly<Record<string, string>> = Object.freeze({
  get: 'get',
  create: 'new',
  update: 'update',
  switch_state: 'switch',
  comment: 'comment',
  assignee: 'assignee',
  link: 'link',
  tag_create: 'tag-create',
  close: 'close',
  batch_close: 'batch',
})

/** Knowledge tool actions; every one is a `jira kb <action>` subcommand. */
const KB_ACTIONS: readonly string[] = Object.freeze(['get', 'search', 'create', 'update'])

/**
 * Compare one tool action table with the CLI command table.
 * @param verbs - the actions the tool schema advertises.
 * @param mapping - the documented action → CLI command map.
 * @param commands - the CLI's registered top-level command names.
 * @returns one sentence per divergence; empty when the surfaces agree.
 */
const divergences = (
  verbs: readonly string[],
  mapping: Readonly<Record<string, string>>,
  commands: readonly string[],
): string[] => {
  const issues: string[] = []
  for (const verb of verbs) {
    const command = mapping[verb]
    if (command === undefined) issues.push(`tool verb "${verb}" has no CLI command mapping`)
    else if (!commands.includes(command)) issues.push(`tool verb "${verb}" maps to unknown CLI command "${command}"`)
  }
  for (const [verb, command] of Object.entries(mapping)) {
    if (!verbs.includes(verb)) issues.push(`mapping still names removed tool verb "${verb}" -> "${command}"`)
  }
  const seen = new Map<string, string>()
  for (const [verb, command] of Object.entries(mapping)) {
    const previous = seen.get(command)
    if (previous !== undefined) issues.push(`CLI command "${command}" serves two verbs: "${previous}" and "${verb}"`)
    seen.set(command, verb)
  }
  return issues
}

/** The issue verbs the shipped schema advertises, or a test failure naming the missing field. */
const issueVerbs = (): readonly string[] => {
  const action = ISSUE_PARAMETERS['action']
  if (action?.enum === undefined) throw new Error('the issue schema must declare its action enum')
  return action.enum
}

/** The knowledge actions the shipped schema advertises. */
const kbVerbs = (): readonly string[] => {
  const action = KB_PARAMETERS['action']
  if (action?.enum === undefined) throw new Error('the knowledge schema must declare its action enum')
  return action.enum
}

describe('jira CLI and tool surface parity', () => {
  it('maps every issue tool verb to one registered CLI command', () => {
    expect(divergences(issueVerbs(), ISSUE_COMMANDS, COMMAND_NAMES)).toEqual([])
  })

  it('keeps the knowledge actions aligned with the kb command', () => {
    expect([...kbVerbs()].sort()).toEqual([...KB_ACTIONS].sort())
    expect(COMMAND_NAMES).toContain('kb')
  })

  it('pins the /jira subcommands to the documented set', () => {
    expect([...JIRA_SUBCOMMANDS]).toEqual(['status', 'list', 'board', 'show', 'tags', 'new', 'doctor', 'sync'])
  })

  it('keeps the list tool and the list command on the same name', () => {
    expect(LIST_TOOL_NAME).toBe('jira_list')
    expect(COMMAND_NAMES).toContain('list')
  })

  it('detects each kind of divergence', () => {
    const verbs = issueVerbs()
    expect(divergences([...verbs, 'bogus'], ISSUE_COMMANDS, COMMAND_NAMES)).not.toEqual([])
    expect(divergences(verbs.filter(verb => verb !== 'get'), ISSUE_COMMANDS, COMMAND_NAMES)).not.toEqual([])
    expect(divergences(verbs, { ...ISSUE_COMMANDS, get: 'missing-command' }, COMMAND_NAMES)).not.toEqual([])
    expect(divergences(verbs, { ...ISSUE_COMMANDS, update: 'get' }, COMMAND_NAMES)).not.toEqual([])
  })
})
