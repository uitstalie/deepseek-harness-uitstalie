/** The jira bundle's declared rows: what installing it inserts, and that every row resolves. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { JIRA_BUNDLE_ROWS } from '../src/index.ts'

/** The package a plugin row names, for dependency coverage. */
function packageName(specifier: string): string {
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!
}

/** One inserted row, as the patch declares it. */
interface Row {
  id?: string
  name?: string
  disabled?: unknown
  config?: Record<string, unknown>
}

describe('dsh-jira-app bundle', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    description?: string
    files?: string[]
    dependencies?: Record<string, string>
    dsh?: { bundle?: { patch?: string } }
  }
  const patch = yaml.load(
    readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'),
    { schema: entryListSchema },
  ) as Array<{ insert?: Row[] }>

  it('declares one bundle patch file', () => {
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(patch).toHaveLength(1)
    expect(manifest.files).toContain('cordis.patch.yml')
  })

  it('inserts exactly the rows the package exports, in patch order', () => {
    const rows = patch[0]?.insert ?? []
    expect(rows.map(row => ({ id: row.id, name: row.name, enabled: row.disabled === undefined }))).toEqual(
      JIRA_BUNDLE_ROWS.map(row => ({ id: row.id, name: row.name, enabled: row.enabled })),
    )
  })

  it('enables the service and the agent, and keeps the browser row visibly off', () => {
    const rows = patch[0]?.insert ?? []
    expect(rows.find(row => row.id === 'jira-service')?.disabled).toBeUndefined()
    expect(rows.find(row => row.id === 'jira-agent')?.disabled).toBeUndefined()
    expect(rows.find(row => row.id === 'jira-ui')?.disabled).toBe(true)
  })

  it('keeps the ledger local by default: the push queue starts disabled', () => {
    const service = (patch[0]?.insert ?? []).find(row => row.id === 'jira-service')
    expect(service?.config).toEqual({ push: { enabled: false } })
  })

  it('declares every row package so the profile can resolve it', () => {
    const rows = patch[0]?.insert ?? []
    const required = [...new Set(rows.map(row => row.name).filter((name): name is string => name !== undefined).map(packageName))]
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(required.sort())
  })
})
