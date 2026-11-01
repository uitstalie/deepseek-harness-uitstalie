/**
 * The ledger row form: staged text saves as one mutation, the push switch writes immediately, and
 * a deployment without the settings service stays unavailable instead of offering dead controls.
 */

import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { stubConfigForm, type StubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { describe, expect, it } from 'vitest'
import { JiraLedgerSettingsController, type JiraLedgerSettings } from '../src/client/ledger-settings.ts'

/** A form double that records each mutation and answers with a scripted acceptance. */
const formOf = (
  value: JiraLedgerSettings | undefined,
  options: { writable?: boolean; accepted?: boolean } = {},
): { form: ConfigForm<JiraLedgerSettings>; mutate: StubConfigForm<JiraLedgerSettings>['mutate'] } => {
  const stub = stubConfigForm<JiraLedgerSettings>()
  stub.publish({
    status: value === undefined ? 'unavailable' : 'ready',
    value,
    revision: 7,
    writable: options.writable ?? true,
  })
  stub.mutate.mockResolvedValue(options.accepted ?? true)
  return { form: stub.scope, mutate: stub.mutate }
}

describe('JiraLedgerSettingsController', () => {
  it('seeds the staged text from the accepted row', () => {
    const { form } = formOf({ root: '/srv/ledger', host: 'fixture-host', push: { enabled: false } })
    const controller = new JiraLedgerSettingsController(form)
    expect(controller.store.getSnapshot()).toMatchObject({
      available: true,
      writable: true,
      root: '/srv/ledger',
      host: 'fixture-host',
      dirty: false,
      pushEnabled: false,
    })
    controller.dispose()
  })

  it('writes both changed text fields in one revision-fenced mutation', async () => {
    const { form, mutate } = formOf({ root: '/srv/ledger', host: 'fixture-host', push: { enabled: false } })
    const controller = new JiraLedgerSettingsController(form)
    controller.edit('root', '/srv/other')
    controller.edit('host', 'other-host')
    expect(controller.store.getSnapshot().dirty).toBe(true)

    await controller.save()

    expect(mutate).toHaveBeenCalledTimes(1)
    expect(mutate).toHaveBeenCalledWith([
      { op: 'set', path: ['root'], value: '/srv/other' },
      { op: 'set', path: ['host'], value: 'other-host' },
    ], 7)
    controller.dispose()
  })

  it('clears an emptied text field instead of writing an empty string', async () => {
    const { form, mutate } = formOf({ root: '/srv/ledger', host: 'fixture-host', push: { enabled: false } })
    const controller = new JiraLedgerSettingsController(form)
    controller.edit('root', '')
    await controller.save()
    expect(mutate).toHaveBeenCalledWith([{ op: 'unset', path: ['root'] }], 7)
    controller.dispose()
  })

  it('writes the push switch immediately and reports a refusal', async () => {
    const { form, mutate } = formOf({ root: '/srv/ledger', push: { enabled: false } }, { accepted: false })
    const controller = new JiraLedgerSettingsController(form)
    await controller.setPush(true)
    expect(mutate).toHaveBeenCalledWith([{ op: 'set', path: ['push', 'enabled'], value: true }], 7)
    expect(controller.store.getSnapshot().pushFailed).toBe(true)
    controller.dispose()
  })

  it('stays unavailable without a settings service and refuses writes', async () => {
    const controller = new JiraLedgerSettingsController(undefined)
    expect(controller.store.getSnapshot()).toMatchObject({ available: false, writable: false })
    controller.edit('root', '/srv/ledger')
    await controller.save()
    expect(controller.store.getSnapshot().failed).toBe(false)
    controller.dispose()
  })
})
