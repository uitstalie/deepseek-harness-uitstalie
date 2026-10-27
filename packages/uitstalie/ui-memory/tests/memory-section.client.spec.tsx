// @vitest-environment jsdom
/**
 * The memory settings page renders the accepted row, shows inline validation, and saves through the
 * controller when the button is pressed.
 */

import { describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach } from 'vitest'
import { MemorySection } from '../src/client/MemorySection.tsx'
import { MemorySettingsController } from '../src/client/settings.ts'
import { en } from '../src/client/locales.ts'

/** A form double with one accepted row and a recording mutation. */
function formOf() {
  const mutate = vi.fn(async () => true)
  return {
    mutate,
    form: {
      getSnapshot: () => ({
        status: 'ready' as const,
        value: { detail: 6, brief: 16, forget: 21, sessions: 10, maxBytes: 4096 },
        base: undefined,
        user: undefined,
        revision: 3,
        writable: true,
      }),
      subscribe: () => () => {},
      mutate,
      set: vi.fn(async () => true),
      unset: vi.fn(async () => true),
    },
  }
}

afterEach(cleanup)

describe('MemorySection', () => {
  it('shows the accepted values and saves a staged change', async () => {
    const { form, mutate } = formOf()
    const controller = new MemorySettingsController(form as never)
    render(<MemorySection controller={controller} t={key => en[key]} />)

    const input = screen.getByDisplayValue('10') as HTMLInputElement
    expect(input.value).toBe('10')
    fireEvent.change(input, { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    expect(mutate).toHaveBeenCalledWith([{ op: 'set', path: ['sessions'], value: 3 }], 3)
    controller.dispose()
  })

  it('marks an invalid number and disables saving', () => {
    const { form } = formOf()
    const controller = new MemorySettingsController(form as never)
    render(<MemorySection controller={controller} t={key => en[key]} />)

    fireEvent.change(screen.getByDisplayValue('4096'), { target: { value: '0' } })

    expect(screen.getByRole('alert').textContent).toBe(en.invalidField)
    expect((screen.getByRole('button', { name: en.save }) as HTMLButtonElement).disabled).toBe(true)
    controller.dispose()
  })

  it('renders the unavailable notice without the settings service', () => {
    const controller = new MemorySettingsController(undefined)
    render(<MemorySection controller={controller} t={key => en[key]} />)
    expect(screen.getByText(en.unavailable)).toBeTruthy()
    controller.dispose()
  })
})
