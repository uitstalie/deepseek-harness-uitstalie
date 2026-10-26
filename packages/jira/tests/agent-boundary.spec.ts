/**
 * Boundary ratchet for `jira-agent`: runtime store access belongs to `jira-service`, not to the
 * model surface. The contract allows types and presentation helpers from `jira-core`; it does not
 * allow the agent to open the store, lock it, run git, or mutate files behind the service.
 *
 * The PENDING set is a ratchet, not an exemption: the suite fails when a listed file stops
 * violating (so the list shrinks with the migration) and when any file outside it starts.
 *
 * @module @deepseek-ai/dsh-jira/tests/agent-boundary
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** Modules whose runtime value exports count as store access. */
const FORBIDDEN = new Set([
  'batch', 'codec', 'doctor', 'generate', 'generateStore', 'git', 'inspect', 'io', 'kbstore',
  'lock', 'machine', 'mutate', 'project', 'push', 'session', 'store', 'tagsLint', 'tagstore',
  'vocab', 'workspace',
])

/** Files that still open the store directly; shrink this set as the migration completes. */
const PENDING = new Set([
  'command.ts',
  'sessionRecord.ts',
  'toolIssue.ts',
  'toolList.ts',
])

const SRC = join(import.meta.dirname, '..', 'jira-agent', 'src')

/** Every production source file under the agent, excluding tests and the test host. */
const sourceFiles = (): string[] => {
  const files: string[] = []
  for (const entry of readdirSync(SRC, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(entry.name)
    }
  }
  return files.sort()
}

/**
 * Runtime core-store imports in one file.
 * A whole `import type` line or an all-`type` specifier list is a type-only import and allowed.
 * @param text - the file contents.
 * @returns the forbidden modules the file imports as values.
 */
const violationsOf = (text: string): string[] => {
  const modules: string[] = []
  for (const line of text.split('\n')) {
    const match = /from '@deepseek-ai\/dsh-jira-core\/([a-zA-Z]+)(?:\.ts)?'/u.exec(line)
    if (match === null) continue
    if (/^import\s+type\b/u.test(line)) continue
    const specifiers = /\{([^}]*)\}/u.exec(line)?.[1]?.split(',').map(part => part.trim()) ?? []
    if (specifiers.length > 0 && specifiers.every(specifier => specifier.startsWith('type '))) continue
    const module = match[1] ?? ''
    if (FORBIDDEN.has(module)) modules.push(module)
  }
  return [...new Set(modules)].sort()
}

describe('jira-agent store-access boundary', () => {
  const violations = sourceFiles()
    .map(file => ({ file, modules: violationsOf(readFileSync(join(SRC, file), 'utf8')) }))
    .filter(entry => entry.modules.length > 0)

  it('does not let a new file open the store behind the service', () => {
    expect(violations.filter(entry => !PENDING.has(entry.file))).toEqual([])
  })

  it('keeps the pending ratchet exact, so migrated files are removed from it', () => {
    expect(violations.map(entry => entry.file)).toEqual([...PENDING].sort())
  })

  it('reads types and the awareness line without opening the store', () => {
    expect(violationsOf(readFileSync(join(SRC, 'envelope.ts'), 'utf8'))).toEqual([])
    expect(violationsOf(readFileSync(join(SRC, 'awareness.ts'), 'utf8'))).toEqual([])
  })
})
