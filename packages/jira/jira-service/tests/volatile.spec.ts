/**
 * The writable row fields: the schema marks them volatile, and a committed update re-resolves the
 * root, host and push switch without remounting the service.
 */

import { Context } from '@deepseek-ai/cordis'
import { updateVolatile } from '@deepseek-ai/cosmokit'
import { afterEach, describe, expect, it } from 'vitest'
import { JiraService, type Config } from '../src/index.ts'

/** The shape of the schema nodes this spec inspects. */
interface SchemaNode {
  meta?: { volatile?: boolean }
  dict?: Record<string, SchemaNode>
}

/** The validated row configuration of the most recent mount, for targeted volatile updates. */
let captured: Config | undefined

/** The service under test, with its validated configuration captured for the live-update cases. */
class CapturingJiraService extends JiraService {
  static override Config = JiraService.Config

  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    captured = config
  }
}

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  captured = undefined
})

/** Mount the capturing service over one row configuration. */
const mount = async (config: { root: string; host: string; push: { enabled: boolean } }): Promise<JiraService> => {
  const ctx = context = new Context()
  await ctx.plugin(CapturingJiraService, config).await()
  const service = ctx.get('jira')
  if (service === undefined) throw new Error('the jira service did not register')
  return service
}

/** Apply one volatile commit through the event the Loader emits. */
const commit = (path: string[]): void => {
  context?.emit('loader/volatile-update', [path])
}

describe('jira-service writable row fields', () => {
  it('marks root, host and push.enabled volatile', () => {
    const dict = (JiraService.Config as unknown as SchemaNode).dict
    expect(dict?.['root']?.meta?.volatile).toBe(true)
    expect(dict?.['host']?.meta?.volatile).toBe(true)
    expect(dict?.['push']?.dict?.['enabled']?.meta?.volatile).toBe(true)
  })

  it('re-resolves the root from a committed volatile update', async () => {
    const service = await mount({ root: '/tmp/ledger-a', host: 'fixture-host', push: { enabled: false } })
    expect(service.status().root).toBe('/tmp/ledger-a')

    if (captured === undefined) throw new Error('the row configuration was not captured')
    updateVolatile(captured.root, JiraService.Config({ root: '/tmp/ledger-b' }).root)
    commit(['root'])

    expect(service.status().root).toBe('/tmp/ledger-b')
  })

  it('re-resolves the audit host and the push switch without remounting', async () => {
    const service = await mount({ root: '/tmp/ledger', host: 'host-a', push: { enabled: false } })
    expect(service.status().host).toBe('host-a')
    expect(service.status().pushEnabled).toBe(false)

    if (captured === undefined) throw new Error('the row configuration was not captured')
    updateVolatile(captured.host, JiraService.Config({ host: 'host-b' }).host)
    updateVolatile(captured.push.enabled, JiraService.Config({ push: { enabled: true } }).push.enabled)
    commit(['host'])
    commit(['push', 'enabled'])

    expect(service.status().host).toBe('host-b')
    expect(service.status().pushEnabled).toBe(true)
  })
})
