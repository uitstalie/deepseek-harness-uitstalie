/**
 * Boundary ratchet for `jira-agent`: runtime store access belongs to `jira-service`, not to the
 * model surface. The contract allows types and presentation helpers from `jira-core`; it does not
 * allow the agent to open the store, lock it, run git, or mutate files behind the service.
 *
 * Every consumer now imports the core root (DH-509), so the ratchet reads the *atoms* a file
 * imports and maps each one back to the module that owns it.
 *
 * The PENDING set is a ratchet, not an exemption: the suite fails when a listed file stops
 * violating (so the list shrinks with the migration) and when any file outside it starts.
 *
 * @module @deepseek-ai/dsh-jira/tests/agent-boundary
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as core from '@deepseek-ai/dsh-jira-core'

/** Modules whose runtime value exports count as store access. */
const FORBIDDEN = new Set([
  'batch', 'codec', 'doctor', 'generate', 'generateStore', 'git', 'inspect', 'kbstore',
  'lock', 'mutate', 'project', 'push', 'store', 'tagsLint', 'tagstore',
  'vocab', 'workspace',
])

/**
 * Presentation helpers `jira-core` re-exports from store modules; the contract allows the agent
 * to format what the service already gave it without opening the store itself.
 */
const PRESENTATION_ATOMS = new Set(['renderDoctorReport', 'renderTagsLint'])

/**
 * Runtime atom → the store-access module that owns it, derived from the core root's namespaces so
 * the map cannot drift from the surface it guards.
 */
const forbiddenAtoms = ((): ReadonlyMap<string, string> => {
  const atoms = new Map<string, string>()
  const namespaces = core as Readonly<Record<string, unknown>>
  for (const moduleName of FORBIDDEN) {
    const namespace = namespaces[moduleName]
    if (typeof namespace !== 'object' || namespace === null) continue
    for (const atom of Object.keys(namespace)) {
      if (PRESENTATION_ATOMS.has(atom)) continue
      if (!atoms.has(atom)) atoms.set(atom, moduleName)
    }
  }
  return atoms
})()

/**
 * Files that still open the store directly; shrink this set as the migration completes.
 * Empty since DH-205 moved the human `/jira` surface onto `ctx.jira`.
 */
const PENDING = new Set<string>([])

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
 * Runtime store-access atoms one file imports from the core root.
 *
 * A whole `import type` line or an all-`type` specifier list is a type-only import and allowed. A
 * namespace import could reach any atom, so it counts as the whole forbidden surface.
 * @param text - the file contents.
 * @returns the forbidden modules the file imports as values, sorted.
 */
const violationsOf = (text: string): string[] => {
  const modules = new Set<string>()
  const named = /import\s+(type\s+)?\{([^}]*)\}\s+from\s+'@deepseek-ai\/dsh-jira-core'/gu
  for (const match of text.matchAll(named)) {
    if (match[1] !== undefined) continue
    for (const raw of (match[2] ?? '').split(',')) {
      const specifier = raw.trim()
      if (specifier === '' || specifier.startsWith('type ')) continue
      const atom = /^[A-Za-z_$][\w$]*/u.exec(specifier)?.[0] ?? ''
      const moduleName = forbiddenAtoms.get(atom)
      if (moduleName !== undefined) modules.add(moduleName)
    }
  }
  if (/import\s+\*\s+as\s+[\w$]+\s+from\s+'@deepseek-ai\/dsh-jira-core'/u.test(text)) {
    for (const moduleName of FORBIDDEN) modules.add(moduleName)
  }
  return [...modules].sort()
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

  it('detects a runtime store atom and ignores a type-only one', () => {
    expect(violationsOf("import { createStore } from '@deepseek-ai/dsh-jira-core'")).toEqual(['store'])
    expect(violationsOf("import type { Store } from '@deepseek-ai/dsh-jira-core'")).toEqual([])
    expect(violationsOf("import { type Store, runGit } from '@deepseek-ai/dsh-jira-core'")).toEqual(['git'])
    expect(violationsOf("import * as core from '@deepseek-ai/dsh-jira-core'")).toEqual([...FORBIDDEN].sort())
  })

  it('reads types and the awareness line without opening the store', () => {
    expect(violationsOf(readFileSync(join(SRC, 'envelope.ts'), 'utf8'))).toEqual([])
    expect(violationsOf(readFileSync(join(SRC, 'awareness.ts'), 'utf8'))).toEqual([])
  })
})
