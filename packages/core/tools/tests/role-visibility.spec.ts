/** Tool-list snapshot: the registry, not a declaration comment, decides visibility. */
import { expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { defineTool, withMinRole, ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentRole } from '@deepseek-ai/dsh-agent'

/** Build one minimal definition with a declared minimum role. */
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

test('the registry returns a distinct tool list for subagent, agent, and super', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  for (const definition of [
    tool('personality_analyze', 'subagent'),
    tool('personality_apply', 'agent'),
    tool('write_like_human', 'agent'),
    tool('jira_issue', 'agent'),
    tool('tool-dsh-store', 'agent'),
    tool('memory_search', 'subagent'),
    tool('memory_read', 'subagent'),
    tool('memory_write', 'agent'),
    tool('send_message', 'subagent'),
    tool('schedule_create', 'agent'),
    tool('plugin_manager', 'agent'),
    tool('subagent', 'agent'),
    tool('subagent_fork', 'agent'),
    tool('workflow', 'agent'),
    tool('superagent_control', 'super'),
    tool('read', 'subagent'),
  ]) ctx.tools.register(definition)

  const names = (role: AgentRole): string[] => ctx.tools.schemas(agent(role)).map(schema => schema.name).sort()
  expect(names('subagent')).toEqual([
    'memory_read', 'memory_search', 'personality_analyze', 'read', 'send_message',
  ])
  expect(names('agent')).toEqual([
    'jira_issue', 'memory_read', 'memory_search', 'memory_write', 'personality_analyze',
    'personality_apply', 'plugin_manager', 'read', 'schedule_create', 'send_message',
    'subagent', 'subagent_fork', 'tool-dsh-store', 'workflow', 'write_like_human',
  ])
  expect(names('super')).toEqual([
    'jira_issue', 'memory_read', 'memory_search', 'memory_write', 'personality_analyze',
    'personality_apply', 'plugin_manager', 'read', 'schedule_create', 'send_message',
    'subagent', 'subagent_fork', 'superagent_control', 'tool-dsh-store', 'workflow', 'write_like_human',
  ])
})
