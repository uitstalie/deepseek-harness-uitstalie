/**
 * The personality row form: staged numeric and switch fields save as one revision-fenced mutation,
 * invalid numbers never reach the Host, and an absent settings service stays unavailable.
 */

import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { stubConfigForm, type StubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { describe, expect, it } from 'vitest'
import { PersonalitySettingsController, type PersonalityRowConfig } from '../src/client/settings-form.ts'

/** A form double that records each mutation and answers with a scripted acceptance. */
const formOf = (
  value: PersonalityRowConfig | undefined,
  options: { writable?: boolean; accepted?: boolean } = {},
): { form: ConfigForm<PersonalityRowConfig>; mutate: StubConfigForm<PersonalityRowConfig>['mutate'] } => {
  const stub = stubConfigForm<PersonalityRowConfig>()
  stub.publish({
    status: value === undefined ? 'unavailable' : 'ready',
    value,
    revision: 4,
    writable: options.writable ?? true,
  })
  stub.mutate.mockResolvedValue(options.accepted ?? true)
  return { form: stub.scope, mutate: stub.mutate }
}

describe('PersonalitySettingsController', () => {
  it('seeds the staged values from the accepted row', () => {
    const { form } = formOf({
      workspaceOverlay: true,
      maxBytes: 4096,
      autoLearn: { entries: 3, bytes: 512 },
      historyLimit: 500,
    })
    const controller = new PersonalitySettingsController(form)
    expect(controller.store.getSnapshot()).toMatchObject({
      available: true,
      dirty: false,
      values: {
        workspaceOverlay: 'on',
        maxBytes: '4096',
        autoLearnEntries: '3',
        autoLearnBytes: '512',
        historyLimit: '500',
      },
    })
    controller.dispose()
  })

  it('writes the changed numeric fields and the switch in one mutation', async () => {
    const { form, mutate } = formOf({ workspaceOverlay: true, maxBytes: 4096 })
    const controller = new PersonalitySettingsController(form)
    controller.edit('workspaceOverlay', '')
    controller.edit('maxBytes', '2048')
    controller.edit('autoLearnEntries', '2')

    await controller.save()

    expect(mutate).toHaveBeenCalledWith([
      { op: 'set', path: ['workspaceOverlay'], value: false },
      { op: 'set', path: ['maxBytes'], value: 2048 },
      { op: 'set', path: ['autoLearn', 'entries'], value: 2 },
    ], 4)
    controller.dispose()
  })

  it('clears an emptied override instead of writing zero', async () => {
    const { form, mutate } = formOf({ historyLimit: 500 })
    const controller = new PersonalitySettingsController(form)
    controller.edit('historyLimit', '')
    await controller.save()
    expect(mutate).toHaveBeenCalledWith([{ op: 'unset', path: ['historyLimit'] }], 4)
    controller.dispose()
  })

  it('refuses an invalid number and does not write', () => {
    const { form, mutate } = formOf({ maxBytes: 4096 })
    const controller = new PersonalitySettingsController(form)
    controller.edit('autoLearnBytes', '0')
    expect(controller.store.getSnapshot().invalid).toEqual(['autoLearnBytes'])
    void controller.save()
    expect(mutate).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('reports a refusal and stays unavailable without the settings service', async () => {
    const refused = await (async () => {
      const { form } = formOf({ maxBytes: 4096 }, { accepted: false })
      const controller = new PersonalitySettingsController(form)
      controller.edit('maxBytes', '128')
      await controller.save()
      return controller
    })()
    expect(refused.store.getSnapshot().failed).toBe(true)
    refused.dispose()

    const unavailable = new PersonalitySettingsController(undefined)
    expect(unavailable.store.getSnapshot()).toMatchObject({ available: false, writable: false })
    unavailable.dispose()
  })
})
