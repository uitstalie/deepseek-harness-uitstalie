/** Full approved role matrix snapshot: registration output, not declarations, is asserted. */
import { expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { defineTool, ToolRuntime } from '@deepseek-ai/dsh-tools'
import { roleAllows, withMinRole, toolMinRole } from '../src/role.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { AgentRole } from '@deepseek-ai/dsh-agent'

/** Every model-facing tool in the approved matrix and its declared minimum. */
const MATRIX: Readonly<Record<string, AgentRole>> = {
  personality_analyze: 'subagent',
  personality_apply: 'agent',
  'tool-dsh-store': 'agent',
  memory_search: 'subagent',
  memory_write: 'agent',
  memory_forget: 'agent',
  workspace_sessions: 'subagent',
  workspace_intents: 'subagent',
  workspace_tasks: 'subagent',
  workspace_message: 'subagent',
  workspace_artifacts: 'subagent',
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

/** A minimal Agent face: the public role plus the session gate the registry reads. */
function agent(role: AgentRole) {
  const header = role === 'subagent' ? { origin: 'subagent', delegationDepth: 1 } : {}
  return { id: SessionId(`role-${role}`), role, session: { header } }
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
  // This spec snapshots the approved matrix, not any one capability's wiring. The JIRA product
  // and the super-agent-only tools are retired; every remaining tool is visible at `agent` or
  // below.
  expect(names('subagent')).toHaveLength(18)
  expect(names('agent')).toHaveLength(30)
  expect(names('super')).toHaveLength(30)
  expect(names('agent').filter(name => !names('subagent').includes(name))).toEqual([
    'memory_forget',
    'memory_write', 'personality_apply', 'plugin_manager', 'schedule_create', 'schedule_edit',
    'schedule_list', 'schedule_view', 'subagent', 'subagent_fork', 'tool-dsh-store',
    'workflow',
  ])
  expect(names('super').filter(name => !names('agent').includes(name))).toEqual([])
  for (const name of Object.keys(MATRIX)) expect(toolMinRole(ctx.tools.get(name)!)).toBe(MATRIX[name])

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
