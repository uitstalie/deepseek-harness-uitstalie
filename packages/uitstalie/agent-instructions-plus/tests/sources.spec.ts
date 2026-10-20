/**
 * The source registry: registration order, disposal, and repeated disposal.
 */
import { expect, test } from 'vitest'
import { createAgentContextSources } from '../src/sources.ts'
import type { AgentContextSource } from '../src/sources.ts'

/** A source that contributes nothing. */
function silent(name: string): AgentContextSource {
  return { name, render: async () => undefined }
}

test('lists sources in registration order and removes one at a time', () => {
  const registry = createAgentContextSources()
  const first = silent('first')
  const second = silent('second')
  const disposeFirst = registry.register(first)
  registry.register(second)

  expect(registry.list().map(source => source.name)).toEqual(['first', 'second'])

  disposeFirst()
  expect(registry.list().map(source => source.name)).toEqual(['second'])

  // A second disposal is a no-op, and the surviving source stays registered.
  disposeFirst()
  expect(registry.list().map(source => source.name)).toEqual(['second'])
})

test('returns a detached list that later registrations do not mutate', () => {
  const registry = createAgentContextSources()
  const snapshot = registry.list()
  registry.register(silent('late'))

  expect(snapshot).toHaveLength(0)
  expect(registry.list()).toHaveLength(1)
})
