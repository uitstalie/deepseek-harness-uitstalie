/**
 * The memory row form: staged fields save as one revision-fenced mutation, invalid numbers never
 * reach the Host, an emptied field clears its override, and a deployment without the settings
 * service stays unavailable instead of offering dead controls.
 */

import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { describe, expect, it, vi } from 'vitest'
import { MemorySettingsController, type MemoryRowConfig } from '../src/client/settings.ts'

/** Build one accepted row snapshot. */
const snapshotOf = (value: MemoryRowConfig | undefined, writable = true): ConfigFormSnapshot<MemoryRowConfig> => ({
  status: value === undefined ? 'unavailable' : 'ready',
  value,
  base: undefined,
  user: undefined,
  revision: 7,
  writable,
})

/** A form double that records each mutation and answers with a scripted acceptance. */
const formOf = (
  value: MemoryRowConfig | undefined,
  options: { writable?: boolean; accepted?: boolean } = {},
): { form: ConfigForm<MemoryRowConfig>; mutate: ReturnType<typeof vi.fn> } => {
  const mutate = vi.fn(async () => options.accepted ?? true)
  const form = {
    getSnapshot: () => snapshotOf(value, options.writable ?? true),
    subscribe: () => () => {},
    mutate,
    set: vi.fn(async () => true),
    unset: vi.fn(async () => true),
  } as unknown as ConfigForm<MemoryRowConfig>
  return { form, mutate }
}

describe('MemorySettingsController', () => {
  it('seeds the staged fields from the accepted row', () => {
    const { form } = formOf({
      detail: 6, brief: 16, forget: 21, sessions: 10, maxBytes: 4096,
      summarizationProvider: 'deepseek', summarizationModel: 'deepseek-chat',
    })
    const controller = new MemorySettingsController(form)
    expect(controller.store.getSnapshot()).toMatchObject({
      available: true,
      writable: true,
      dirty: false,
      values: {
        detail: '6', brief: '16', forget: '21', sessions: '10', maxBytes: '4096',
        summarizationProvider: 'deepseek', summarizationModel: 'deepseek-chat',
      },
    })
    controller.dispose()
  })

  it('writes every changed field in one revision-fenced mutation', async () => {
    const { form, mutate } = formOf({ detail: 6, brief: 16, forget: 21, sessions: 10, maxBytes: 4096 })
    const controller = new MemorySettingsController(form)
    controller.edit('sessions', '3')
    controller.edit('maxBytes', '2048')
    expect(controller.store.getSnapshot().dirty).toBe(true)

    await controller.save()

    expect(mutate).toHaveBeenCalledTimes(1)
    expect(mutate).toHaveBeenCalledWith([
      { op: 'set', path: ['sessions'], value: 3 },
      { op: 'set', path: ['maxBytes'], value: 2048 },
    ], 7)
    controller.dispose()
  })

  it('clears an emptied field instead of writing an empty string', async () => {
    const { form, mutate } = formOf({ summarizationProvider: 'deepseek', summarizationModel: 'deepseek-chat' })
    const controller = new MemorySettingsController(form)
    controller.edit('summarizationProvider', '')
    await controller.save()
    expect(mutate).toHaveBeenCalledWith([{ op: 'unset', path: ['summarizationProvider'] }], 7)
    controller.dispose()
  })

  it('refuses to save an invalid number and marks the field', () => {
    const { form, mutate } = formOf({ detail: 6, brief: 16, forget: 21, sessions: 10, maxBytes: 4096 })
    const controller = new MemorySettingsController(form)
    controller.edit('maxBytes', '0')
    expect(controller.store.getSnapshot().invalid).toEqual(['maxBytes'])
    expect(controller.store.getSnapshot().dirty).toBe(true)
    void controller.save()
    expect(mutate).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('reports a refusal as a failed save and keeps the staged values', async () => {
    const { form, mutate } = formOf({ sessions: 10 }, { accepted: false })
    const controller = new MemorySettingsController(form)
    controller.edit('sessions', '2')
    await controller.save()
    expect(mutate).toHaveBeenCalledWith([{ op: 'set', path: ['sessions'], value: 2 }], 7)
    expect(controller.store.getSnapshot().failed).toBe(true)
    expect(controller.store.getSnapshot().values.sessions).toBe('2')
    controller.dispose()
  })

  it('stays unavailable without a settings service and refuses writes', async () => {
    const controller = new MemorySettingsController(undefined)
    expect(controller.store.getSnapshot()).toMatchObject({ available: false, writable: false })
    controller.edit('sessions', '2')
    await controller.save()
    expect(controller.store.getSnapshot().saving).toBe(false)
    controller.dispose()
  })
})
