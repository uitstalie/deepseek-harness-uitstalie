import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentRoleOf } from '@deepseek-ai/dsh-agent'

/** A minimal Agent-shaped fixture; no personality package is involved. */
function agent(header: Record<string, unknown>, role?: string): never {
  return { session: { header }, options: role === undefined ? {} : { role } } as never
}

test('the core role reader works without the personality package', () => {
  assert.equal(agentRoleOf(agent({ cwd: '/work' })), 'agent')
  assert.equal(agentRoleOf(agent({ cwd: '/work' }, 'super')), 'super')
  assert.equal(agentRoleOf(agent({ cwd: '/work', origin: 'subagent', delegationDepth: 1 }, 'super')), 'subagent')
})
