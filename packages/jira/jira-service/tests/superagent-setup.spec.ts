/**
 * The super workspace placement rules and the config read/write around them (DH-718).
 *
 * The rules are the browser-facing half of the capability's mount-time check: a person chooses
 * the directory, and the harness refuses one that a writing agent must not own.
 */

import { join, parse, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  type ConfigEditorEntryLike,
  type ConfigEditorLike,
  dshHomeOf,
  readSuperagentHome,
  superagentHomeProblem,
  writeSuperagentHome,
} from '../src/superagent-setup.ts'

/** One in-memory config editor over a single jira-agent row. */
const editorWith = (config: Record<string, unknown> | undefined): ConfigEditorLike & { writes: Record<string, unknown>[] } => {
  const writes: Record<string, unknown>[] = []
  const entry: ConfigEditorEntryLike = { options: { id: 'jira-agent', name: '@deepseek-ai/dsh-jira-agent', ...(config === undefined ? {} : { config }) } }
  return {
    writes,
    entries: () => [entry],
    edit: async (target, change) => {
      writes.push(change({ ...(target.options.config ?? {}) }, {}))
    },
  }
}

describe('the super workspace placement rules', () => {
  const dshHome = resolve('tmp', 'dsh-home')
  const good = resolve('tmp', 'superagent')

  it('accepts an absolute directory outside the harness home', () => {
    expect(superagentHomeProblem(good, dshHome)).toBeUndefined()
  })

  it('refuses empty, relative and filesystem-root paths', () => {
    expect(superagentHomeProblem('', dshHome)).toMatch(/absolute/u)
    expect(superagentHomeProblem('superagent', dshHome)).toMatch(/absolute/u)
    expect(superagentHomeProblem(parse(dshHome).root, dshHome)).toMatch(/root/u)
  })

  it('refuses anything under the harness home, including the home itself', () => {
    expect(superagentHomeProblem(join(dshHome, 'superagent'), dshHome)).toMatch(/harness home/u)
    expect(superagentHomeProblem(dshHome, dshHome)).toMatch(/harness home/u)
  })

  it('resolves $DSH_HOME, expanding a leading ~', () => {
    expect(dshHomeOf({ DSH_HOME: resolve('tmp', 'home') })).toBe(resolve('tmp', 'home'))
    expect(dshHomeOf({ DSH_HOME: '' })).toMatch(/\.dsh$/u)
  })
})

describe('the super workspace config', () => {
  it('reads the trimmed home and ignores a blank value', () => {
    expect(readSuperagentHome(editorWith({ superagent_home: '  D:\\dqc\\superagent  ' }))).toBe('D:\\dqc\\superagent')
    expect(readSuperagentHome(editorWith({ superagent_home: '   ' }))).toBeUndefined()
    expect(readSuperagentHome(editorWith(undefined))).toBeUndefined()
    expect(readSuperagentHome(undefined)).toBeUndefined()
  })

  it('writes the chosen home without dropping the row\'s other fields', async () => {
    const editor = editorWith({ superagent_worker_preset: 'jira-worker' })
    await writeSuperagentHome(editor, 'D:\\dqc\\superagent')
    expect(editor.writes).toEqual([{ superagent_worker_preset: 'jira-worker', superagent_home: 'D:\\dqc\\superagent' }])
  })
})
