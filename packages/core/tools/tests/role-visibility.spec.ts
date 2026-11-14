/** Full approved role matrix snapshot: registration output, not declarations, is asserted. */
import { expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { defineTool, roleAllows, withMinRole, toolMinRole, ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { agentRoleOf } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentRole } from '@deepseek-ai/dsh-agent'

/** Every model-facing tool in the approved matrix and its declared minimum. */
const MATRIX: Readonly<Record<string, AgentRole>> = {
  personality_analyze: 'subagent',
  personality_apply: 'agent',
  write_like_human: 'agent',
  jira_issue: 'agent',
  jira_list: 'agent',
  jira_kb: 'agent',
  issue_work: 'agent',
  'tool-dsh-store': 'agent',
  memory_search: 'subagent',
  memory_read: 'subagent',
  memory_write: 'agent',
  memory_forget: 'agent',
  memory_resolve: 'agent',
  send_message: 'subagent',
  list_agents: 'subagent',
  wait_agent: 'subagent',
  schedule_create: 'agent',
  schedule_edit: 'agent',
  schedule_list: 'agent',
  schedule_view: 'agent',
  plugin_manager: 'agent',
  subagent: 'agent',
  subagent_fork: 'agent',
  workflow: 'agent',
  superagent_control: 'super',
  superagent_ledger: 'super',
  superagent_deliver: 'super',
  superagent_permission: 'super',
  read: 'subagent',
  write: 'subagent',
  edit: 'subagent',
  apply_patch: 'subagent',
  read_image: 'subagent',
  glob: 'subagent',
  grep: 'subagent',
  pwsh: 'subagent',
}

/** Build one minimal definition with the matrix's declared role. */
function tool(name: string, minimum: AgentRole): ToolDefinition {
  return withMinRole(defineTool({
    name,
    description: name,
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false }, render: () => [] },
    execute: async () => ({}),
  }), minimum)
}

/** A minimal Agent-shaped fixture read by the role resolver. */
function agent(role: AgentRole): Agent {
  const header = role === 'subagent' ? { origin: 'subagent', delegationDepth: 1 } : {}
  return { id: `role-${role}`, session: { header }, options: { role } } as unknown as Agent
}

test('the registry exposes the approved full matrix for subagent, agent, and super', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  for (const [name, minimum] of Object.entries(MATRIX)) ctx.tools.register(tool(name, minimum))

  const names = (role: AgentRole): string[] => ctx.tools.schemas(agent(role)).map(schema => schema.name).sort()
  const expected = (role: AgentRole): string[] => Object.entries(MATRIX)
    .filter(([, minimum]) => roleAllows(role, minimum))
    .map(([name]) => name)
    .sort()

  expect(names('subagent')).toEqual(expected('subagent'))
  expect(names('agent')).toEqual(expected('agent'))
  expect(names('super')).toEqual(expected('super'))
  // This spec snapshots the approved matrix, not any one capability's wiring: `superagent_control`
  // is already declared `super` here, so the jira ordinary-branch fix does not change 32/36.
  // The real contribution is covered by packages/jira/jira-agent/src/superagent.test.ts.
  expect(names('subagent')).toHaveLength(14)
  expect(names('agent')).toHaveLength(32)
  expect(names('super')).toHaveLength(36)
  expect(names('agent')).not.toContain('superagent_control')
  expect(names('super')).toContain('superagent_control')
  expect(names('agent').filter(name => !names('subagent').includes(name))).toEqual([
    'issue_work', 'jira_issue', 'jira_kb', 'jira_list', 'memory_forget', 'memory_resolve',
    'memory_write', 'personality_apply', 'plugin_manager', 'schedule_create', 'schedule_edit',
    'schedule_list', 'schedule_view', 'subagent', 'subagent_fork', 'tool-dsh-store',
    'workflow', 'write_like_human',
  ])
  expect(names('super').filter(name => !names('agent').includes(name))).toEqual([
    'superagent_control', 'superagent_deliver', 'superagent_ledger', 'superagent_permission',
  ])
  for (const name of Object.keys(MATRIX)) expect(toolMinRole(ctx.tools.get(name)!)).toBe(MATRIX[name])
  expect(agentRoleOf(agent('subagent'))).toBe('subagent')
  expect(agentRoleOf(agent('agent'))).toBe('agent')
  expect(agentRoleOf(agent('super'))).toBe('super')

  const plain = defineTool({
    name: 'plain_unscoped',
    description: 'no minRole',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false }, render: () => [] },
    execute: async () => ({}),
  })
  ctx.tools.register(plain)
  expect(names('subagent')).toContain('plain_unscoped')
})
