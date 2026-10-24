/**
 * Tests for the two human surfaces (C5, decision 128).
 *
 * The design's rule is that the CLI is a **superset of the tool's verbs** and that the logic lives in
 * `core` exactly once (decision 83). The names, however, are allowed to differ — a human types
 * `jira new`, a model calls `action: "create"` — and that is exactly the kind of difference that
 * silently rots once nobody compares the two lists. So this file compares them:
 *
 *   - every `jira_issue` action has a CLI command, through an explicit mapping;
 *   - every CLI command appears in the usage text (a command a human cannot discover is not shipped);
 *   - every `jira_kb` action is reachable as `jira kb <action>`;
 *   - the read-only `/jira` command set stays read-only, except where decision 125 says otherwise.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { COMMAND_NAMES, USAGE } from './cli/main.ts'
import { type JiraToolDefinition, KB_TOOL_NAME, LIST_TOOL_NAME, READ_TIMEOUT_MS, TOOL_NAME, WRITE_TIMEOUT_MS, apply, type ToolGuard } from './plugin/index.ts'

/** The bridge between the tool's action names and the CLI's commands. */
const ISSUE_ACTION_TO_COMMAND: Readonly<Record<string, string>> = Object.freeze({
  get: 'get',
  create: 'new',
  update: 'update',
  switch_state: 'switch',
  comment: 'comment',
  assignee: 'assignee',
  link: 'link',
  // Decision 192: the tool surface gained `tag_create`, so the CLI parity map must name its command.
  tag_create: 'tag-create',
  // Decision 193: closing is one command on both surfaces.
  close: 'close',
  // Decision 196: one call for many keys, all-or-nothing.
  batch_close: 'batch',
})

/** `/jira` deliberately exposes only what a human reads, plus the writes decision 125 kept. */
const SLASH_WRITES_KEPT = ['new', 'sync']

const register = async (): Promise<Readonly<{ registrations: readonly JiraToolDefinition[]; guards: readonly ToolGuard[] }>> => {
  const registrations: JiraToolDefinition[] = []
  const guards: ToolGuard[] = []
  const ctx = {
    get: () => undefined,
    on: () => () => undefined,
    tools: {
      register: (definition: JiraToolDefinition) => { registrations.push(definition); return () => undefined },
      guard: (guard: ToolGuard) => { guards.push(guard); return () => undefined },
    },
  }
  await apply(ctx as never, {} as never, {} as never, () => 0)
  return Object.freeze({ registrations: Object.freeze(registrations), guards: Object.freeze(guards) })
}

const actionEnum = (definition: JiraToolDefinition | undefined): readonly string[] => {
  const parameters = definition?.parameters as { properties?: { action?: { enum?: readonly string[] } } } | undefined
  return parameters?.properties?.action?.enum ?? []
}

describe('surfaces: the CLI covers the tool (decision 83)', () => {
  it('has a CLI command for every issue action', async () => {
    const { registrations: definitions } = await register()
    const actions = actionEnum(definitions.find(definition => definition.name === TOOL_NAME))
    assert.deepEqual([...actions].sort(), Object.keys(ISSUE_ACTION_TO_COMMAND).sort(), 'the mapping must be exhaustive')
    for (const action of actions) {
      const command = ISSUE_ACTION_TO_COMMAND[action]
      assert.ok(command !== undefined && COMMAND_NAMES.includes(command), `${action} → ${String(command)} is not a command`)
    }
  })

  it('reaches every knowledge action as `jira kb <action>`', async () => {
    const { registrations: definitions } = await register()
    const actions = actionEnum(definitions.find(definition => definition.name === KB_TOOL_NAME))
    assert.deepEqual([...actions].sort(), ['create', 'get', 'search', 'update'])
    assert.ok(COMMAND_NAMES.includes('kb'))
  })

  it('ships the read-only listing tool without a separate command of its own', async () => {
    const { registrations: definitions } = await register()
    assert.ok(definitions.some(definition => definition.name === LIST_TOOL_NAME))
    assert.ok(COMMAND_NAMES.includes('list'), 'the tool and the command share the name')
  })

  it('names every command in the usage text', () => {
    for (const command of COMMAND_NAMES) {
      assert.match(USAGE, new RegExp(`jira ${command}\\b`), `${command} is not discoverable in the usage`)
    }
  })

  it('keeps the command list itself stable enough to be worth comparing', () => {
    // A deliberate list: adding a command is a documentation-worthy act (this is what C5 was about).
    assert.deepEqual([...COMMAND_NAMES].sort(), [
      'assignee', 'batch', 'board', 'close', 'comment', 'doctor', 'generate', 'get', 'help', 'hooks', 'init', 'kb',
      'link', 'lint', 'list', 'machines', 'new', 'project', 'switch', 'sync', 'tag-create', 'tags', 'update',
      'verify-commit-msg',
    ])
  })

  it('records which writes `/jira` keeps, so the exception stays visible', () => {
    assert.deepEqual(SLASH_WRITES_KEPT, ['new', 'sync'], 'decision 125 kept these two on purpose')
  })
})

describe('surfaces: the tool declarations and the guard (decisions 84/96)', () => {
  it('declares a read budget for the read tool, and only reads as concurrency-safe', async () => {
    const { registrations } = await register()
    const byName = new Map(registrations.map(definition => [definition.name, definition]))
    const list = byName.get(LIST_TOOL_NAME)
    assert.equal(list?.timeoutMs, READ_TIMEOUT_MS, 'a read must not be allowed to hang as long as a write')
    assert.equal(list?.isConcurrencySafe?.({}), true, 'a pure read may overlap a sibling call')

    const jira = byName.get(TOOL_NAME)
    assert.equal(jira?.timeoutMs, WRITE_TIMEOUT_MS, 'a mixed tool takes the write budget')
    assert.equal(jira?.isConcurrencySafe?.({ action: 'get' }), true, 'the read action may overlap')
    assert.equal(jira?.isConcurrencySafe?.({ action: 'update' }), false, 'a write may not')
    assert.equal(jira?.isConcurrencySafe?.({}), false, 'and neither may a call we cannot classify')
  })

  it('denies a write from a read-only session at the guard, before the handler runs', async () => {
    const { guards } = await register()
    assert.equal(guards.length, 1, 'decision 96: exactly one monotonic guard')

    const readOnly = { id: 'ro-1', session: { id: 'ro-1', header: {} }, options: { agentPreset: 'readOnly' } }
    const ordinary = { id: 'n-1', session: { id: 'n-1', header: {} }, options: { agentPreset: 'workspaceWrite' } }

    const reason = guards[0]?.({ name: TOOL_NAME, arguments: { action: 'update' }, agent: readOnly })
    assert.match(String(reason), /writes the ledger, and this session may not write \(dsh-read-only\)/)
    assert.equal(guards[0]?.({ name: TOOL_NAME, arguments: { action: 'get' }, agent: readOnly }), undefined, 'reads pass')
    assert.equal(guards[0]?.({ name: TOOL_NAME, arguments: { action: 'update' }, agent: ordinary }), undefined)
    assert.equal(guards[0]?.({ name: 'another_tool', arguments: { action: 'update' }, agent: readOnly }), undefined, 'other tools are not ours to police')
  })
})
