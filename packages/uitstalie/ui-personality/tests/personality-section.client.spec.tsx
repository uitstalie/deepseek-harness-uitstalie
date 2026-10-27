// @vitest-environment jsdom
/**
 * The identity proposal page: the list renders pending first with evidence, an
 * accept calls the controller and swaps the row's status without a reload, and a
 * decision failure surfaces in place.
 */
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { PersonalityProposalWire } from '@deepseek-ai/dsh-personality/types'
import { PersonalitySection } from '../src/client/PersonalitySection.tsx'
import type { PersonalityProposalController } from '../src/client/PersonalitySection.tsx'
import { PersonalitySettingsController, type PersonalityRowConfig } from '../src/client/settings-form.ts'
import { en, type PersonalityKey } from '../src/client/locales.ts'

afterEach(() => { cleanup() })

/** The page's copy, bound as the locale service would bind it. */
function t(key: PersonalityKey): string {
  return en[key]
}

/** One queued proposal. */
function proposal(status: PersonalityProposalWire['status'] = 'pending'): PersonalityProposalWire {
  return {
    id: 'p-1',
    kind: 'identity',
    name: 'role',
    text: '用户是独立开发者。',
    evidence: 'seq 3',
    proposedAt: '2026-10-27T00:00:00.000Z',
    status,
  }
}

test('lists proposals and accepts one through the controller', async () => {
  const rows: readonly PersonalityProposalWire[] = [proposal()]
  const decide = vi.fn(async () => proposal('accepted'))
  const controller: PersonalityProposalController = {
    list: vi.fn(async () => rows),
    decide,
  }
  render(<PersonalitySection controller={controller} t={t} />)

  await screen.findByText('role')
  expect(screen.getByText('用户是独立开发者。')).toBeDefined()
  expect(screen.getByText('Evidence: seq 3')).toBeDefined()

  fireEvent.click(screen.getByRole('button', { name: 'Accept the identity proposal role' }))
  await waitFor(() => { expect(decide).toHaveBeenCalledWith('p-1', 'accept') })
  await waitFor(() => { expect(screen.getByText('accepted')).toBeDefined() })
  expect(screen.queryByRole('button', { name: 'Accept the identity proposal role' })).toBeNull()
})

test('a rejected decision failure is shown in place and the row stays pending', async () => {
  const controller: PersonalityProposalController = {
    list: vi.fn(async () => [proposal()]),
    decide: vi.fn(async () => { throw new Error('host refused') }),
  }
  render(<PersonalitySection controller={controller} t={t} />)

  await screen.findByText('role')
  fireEvent.click(screen.getByRole('button', { name: 'Reject the identity proposal role' }))
  await screen.findByRole('alert')
  expect(screen.getByRole('alert').textContent).toContain('host refused')
  expect(screen.getByText('pending')).toBeDefined()
})

test('an empty queue renders the empty state', async () => {
  const controller: PersonalityProposalController = {
    list: vi.fn(async () => []),
    decide: vi.fn(async () => proposal()),
  }
  render(<PersonalitySection controller={controller} t={t} />)

  await screen.findByText('No identity proposals are queued.')
})

test('saves a provider field through the shared configuration form', async () => {
  const mutate = vi.fn(async () => true)
  const row: PersonalityRowConfig = { maxBytes: 4096, autoLearn: { entries: 3, bytes: 512 } }
  const form = {
    getSnapshot: () => ({
      status: 'ready' as const,
      value: row,
      base: undefined,
      user: undefined,
      revision: 2,
      writable: true,
    }),
    subscribe: () => () => {},
    mutate,
    set: vi.fn(async () => true),
    unset: vi.fn(async () => true),
  }
  const settings = new PersonalitySettingsController(form as never)
  const controller: PersonalityProposalController = {
    list: vi.fn(async () => []),
    decide: vi.fn(async () => proposal()),
  }
  render(<PersonalitySection controller={controller} t={t} settings={settings} />)

  await screen.findByText('No identity proposals are queued.')
  fireEvent.change(screen.getByDisplayValue('4096'), { target: { value: '2048' } })
  fireEvent.click(screen.getByRole('button', { name: en.save }))
  await waitFor(() => {
    expect(mutate).toHaveBeenCalledWith([{ op: 'set', path: ['maxBytes'], value: 2048 }], 2)
  })
  settings.dispose()
})
