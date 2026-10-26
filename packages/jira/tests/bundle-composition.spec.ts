/**
 * One composition for the jira rows: the web-app branch layer. The standalone bundle duplicated
 * these three inserts and nothing installed it, so it was removed (DH-203); this test keeps the
 * single list honest and would catch a bundle or a second layer putting the rows back.
 *
 * @module @deepseek-ai/dsh-jira/tests/bundle-composition
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const WEB_PATCH = join(import.meta.dirname, '..', '..', 'bundle', 'web-app', 'cordis.patch.uitstalie.yml')
const STANDALONE_BUNDLE = join(import.meta.dirname, '..', '..', 'bundle', 'jira-app')

/** Every `- id:` row the patch declares, in file order. */
const insertedIds = (): string[] =>
  [...readFileSync(WEB_PATCH, 'utf8').matchAll(/^\s+- id:\s*(\S+)\s*$/gmu)].map(match => String(match[1]))

describe('jira bundle composition', () => {
  it('mounts the three jira rows exactly once, in the branch layer', () => {
    const ids = insertedIds().filter(id => id.startsWith('jira-'))
    expect(ids).toEqual(['jira-service', 'jira-agent', 'jira-ui'])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('has no standalone jira bundle left to duplicate them', () => {
    expect(existsSync(STANDALONE_BUNDLE)).toBe(false)
  })
})
